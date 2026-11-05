import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

const run = promisify(execFile);

async function start(home: string, models = echoModels().models): Promise<Daemon> {
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	return startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
}

describe("daemon", () => {
	it("say and status from the CLI, against a throwaway home", async () => {
		const home = await tempHome();
		const daemon = await start(home);
		try {
			const cli = (...args: string[]) => run(process.execPath, ["src/cli/index.ts", ...args, "--home", home]);
			expect((await cli("say", "hello", "there")).stdout).toBe("re: hello there\n");
			expect((await cli("say", "--thread", "work", "again")).stdout).toBe("re: again\n");
			expect((await cli("status")).stdout).toMatch(
				/^web: http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+\ncli\/owner {2}#\d+ {2}idle\ncli\/owner\/work {2}#\d+ {2}idle\n$/,
			);
		} finally {
			await daemon.close();
		}
		expect(await readDaemonFile(home)).toBeUndefined();
	});

	it("say prints an ask as it comes; status lists it, and answer fills it from another terminal", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"message_user",
						{ question: "Which port?", fields: [{ name: "port", type: "number", hint: "above 1024" }] },
						{ id: "c1" },
					),
				],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxToolCall("message_user", { text: "Port 8080, then." }, { id: "c2" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Told them."),
		]);
		const home = await tempHome();
		const daemon = await start(home, models);
		try {
			const cli = (...args: string[]) => run(process.execPath, ["src/cli/index.ts", ...args, "--home", home]);
			const said = cli("say", "serve it");
			const listed = await until(async () => {
				const { stdout } = await cli("status");
				return stdout.includes("ask ") && stdout;
			});
			expect(listed).toMatch(/^cli\/owner {2}#\d+ {2}waiting, 1 unanswered$/m);
			const key = /^ask (\w+) in #\d+, until .+:$/m.exec(listed)?.[1];
			expect(listed).toContain(`  Which port?\n    - port: a number (above 1024)\n  banda answer ${key} port=…\n`);
			await expect(cli("answer", key!, "port=eighty")).rejects.toMatchObject({
				stderr: "banda: port is a number\n",
			});
			await expect(cli("approve", key!)).rejects.toMatchObject({ stderr: "banda: this ask is a question\n" });
			expect((await cli("answer", key!, "port=8080")).stdout).toBe("answered\n");
			const { stdout, stderr } = await said;
			expect(stdout).toBe("Port 8080, then.\n");
			expect(stderr).toContain(`ask ${key}:\n  Which port?`);
			await expect(cli("answer", key!, "port=1")).rejects.toMatchObject({
				stderr: "banda: no open ask has this id\n",
			});
		} finally {
			await daemon.close();
		}
	}, 30_000);

	it("a second daemon on the same home refuses to start, also from another process", async () => {
		const home = await tempHome();
		const daemon = await start(home);
		await expect(start(home)).rejects.toThrow(/already runs/);
		const other = await run(process.execPath, ["src/cli/index.ts", "serve", "--port", "0", "--home", home]).catch(
			(e) => e,
		);
		expect(other.stderr).toContain("already runs");
		await daemon.close();
		const again = await start(home);
		await again.close();
	});

	it("checks Host and Origin, and wants the token on every API request", async () => {
		const home = await tempHome();
		const daemon = await start(home);
		try {
			const url = `http://127.0.0.1:${daemon.port}`;
			const { token } = (await readDaemonFile(home))!;
			const say = { method: "POST", body: JSON.stringify({ text: "hi" }) };
			const auth = { authorization: `Bearer ${token}` };
			expect((await fetch(`${url}/api/status`, { headers: auth })).status).toBe(200);
			expect((await fetch(`${url}/api/status`)).status).toBe(401);
			// fetch cannot set Host; a rebinding page's request arrives with the attacker's name in it.
			const rebound = await new Promise<number>((resolve, reject) =>
				request(
					{ port: daemon.port, host: "127.0.0.1", path: "/api/status", headers: { ...auth, host: "evil.example" } },
					(res) => {
						res.resume();
						resolve(res.statusCode!);
					},
				)
					.on("error", reject)
					.end(),
			);
			expect(rebound).toBe(403);
			expect((await fetch(`${url}/api/status`, { headers: { ...auth, origin: "http://evil.example" } })).status).toBe(
				403,
			);
			expect((await fetch(`${url}/api/say`, say)).status).toBe(401);
			expect((await fetch(`${url}/api/say`, { ...say, headers: { authorization: "Bearer nope" } })).status).toBe(401);
			const ok = await fetch(`${url}/api/say`, { ...say, headers: auth });
			expect(
				(await ok.text())
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual([{ message: "re: hi" }, { ended: "" }]);
		} finally {
			await daemon.close();
		}
	});

	it("stops promptly while a say waits on a model that never answers", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// Like a real provider, the hung request ends when its signal aborts.
		let asked = false;
		faux.setResponses([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					asked = true;
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		]);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
		const { token } = (await readDaemonFile(home))!;
		const say = fetch(`http://127.0.0.1:${daemon.port}/api/say`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ text: "hi" }),
		}).then(
			(r) => r.status,
			() => "dropped",
		);
		// the say reached the model, which never answers
		await until(() => asked);
		const started = Date.now();
		await daemon.close();
		// it does not wait for the model, nor for the sends' drain window (10 s): well under it, however loaded
		expect(Date.now() - started).toBeLessThan(8000);
		expect(await say).not.toBe(200);
		expect(await readDaemonFile(home)).toBeUndefined();
	});
});
