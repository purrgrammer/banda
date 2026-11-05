/**
 * Host mode (DESIGN.md "The box"): asked for by name, the daemon's commands run on its own machine in `<home>/workspace`,
 * with an allow-listed environment, and the app is told; not asked for, no Docker means an offline box, never host mode.
 */
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { boxKind } from "../src/box/box.ts";
import { type Daemon, type DaemonOptions, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ComputerView } from "../src/server/api.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

const daemons: Daemon[] = [];
afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close();
});

async function start(options: Omit<DaemonOptions, "home" | "port" | "log">, logged: string[] = []) {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const daemon = await startDaemon({ home, port: 0, log: (line) => logged.push(line), web, ...options });
	daemons.push(daemon);
	const token = (await readDaemonFile(home))!.token!;
	const url = `http://127.0.0.1:${daemon.port}/api`;
	const headers = { authorization: `Bearer ${token}` };
	/** The computer as the shell stream says it, once `ready` holds. */
	const computer = async (ready: (view: ComputerView) => boolean): Promise<ComputerView> => {
		const abort = new AbortController();
		const response = await fetch(`${url}/events`, { headers, signal: abort.signal });
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) throw new Error("the stream ended");
				buffer += value;
				for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (!frame.startsWith("data: ")) continue;
					const event = JSON.parse(frame.slice("data: ".length)) as { type: string; computer?: ComputerView };
					if (event.type === "computer" && event.computer !== undefined && ready(event.computer)) return event.computer;
				}
			}
		} finally {
			abort.abort();
		}
	};
	const post = (text: string) =>
		fetch(`${url}/messages`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ id: crypto.randomUUID(), thread: crypto.randomUUID(), text }),
		});
	return { home, computer, post };
}

describe("host mode", () => {
	it("is asked for by name: unset is the container, and an unknown kind is refused", () => {
		expect(boxKind(undefined)).toBe("container");
		expect(boxKind("")).toBe("container");
		expect(boxKind("container")).toBe("container");
		expect(boxKind("host")).toBe("host");
		expect(() => boxKind("hots")).toThrow("--box is container or host, not hots");
	});

	it("runs a chat's bash in <home>/workspace, with none of the daemon's own variables, and says it has no box", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: 'pwd > where.txt; echo "secret=$BANDA_HOST_TEST_SECRET" > env.txt' },
						{ id: "c1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done."),
		]);
		process.env.BANDA_HOST_TEST_SECRET = "leaked";
		const logged: string[] = [];
		try {
			const { home, computer, post } = await start({ models, boxKind: "host" }, logged);
			expect(logged).toContainEqual(expect.stringMatching(/^box: no box: commands run on this computer/));
			const view = await computer((v) => v.state === "up");
			expect(view).toMatchObject({ box: "host", network: "none", state: "up" });
			const posted = await post("where are you?");
			expect(posted.ok).toBe(true);
			const workspace = join(home, "workspace");
			const where = await until(() => readFile(join(workspace, "where.txt"), "utf8").catch(() => undefined));
			// macOS's temp folder is reached through a link: compare what each resolves to
			expect(await realpath(where.trim())).toBe(await realpath(workspace));
			expect(await readFile(join(workspace, "env.txt"), "utf8")).toBe("secret=\n");
		} finally {
			delete process.env.BANDA_HOST_TEST_SECRET;
		}
	});

	it("without it and with no Docker, the box is offline, never on the host", async () => {
		const path = process.env.PATH;
		// no docker on the path: the container box cannot come up
		process.env.PATH = await mkdtemp(join(tmpdir(), "banda-no-docker-"));
		const logged: string[] = [];
		try {
			const { computer } = await start({ models: echoModels().models }, logged);
			const view = await computer((v) => v.state === "offline");
			expect(view).toMatchObject({ box: "container", network: "guarded", state: "offline" });
			// the app says why, in plain words
			expect(view.why).toMatch(/^Docker isn't installed/);
			expect(logged.some((line) => line.startsWith("box: banda needs Docker: Docker isn't installed"))).toBe(true);
			expect(logged.some((line) => line.includes("no box"))).toBe(false);
		} finally {
			process.env.PATH = path;
		}
	});
});
