import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { CompanionView, ControlView } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome, until, whenAsked } from "./helpers.ts";

/** A daemon whose model, asked anything, writes a routine with `schedule`, then says it waits for the owner. */
async function start() {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const told = whenAsked(fauxAssistantMessage("Asked them to allow it."));
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("tool_search", { query: "schedule", limit: 1 })], { stopReason: "toolUse" }),
		fauxAssistantMessage(
			[
				fauxToolCall(
					"schedule",
					{ name: "tea", description: "Tea time", every: "1d", ask: "Remind the owner to drink tea." },
					{ id: "c1" },
				),
			],
			{ stopReason: "toolUse" },
		),
		told.response,
	]);
	const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const url = `http://127.0.0.1:${daemon.port}`;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`${url}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	/** Once `schedule` returned: the routine's file is whole. */
	return { home, daemon, api, scheduled: told.asked };
}

describe("the control room", () => {
	it("a routine the agent writes waits to be allowed, then is scheduled; Pause and resume; the owner removes it", async () => {
		const { home, daemon, api, scheduled } = await start();
		try {
			await api("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), thread: randomUUID(), text: "remind me about tea daily" }),
			});
			const file = join(home, "workspace", "routines", "tea.md");
			await scheduled;
			expect(await readFile(file, "utf8")).toBe(
				"---\ndescription: Tea time\nevery: 1d\n---\nRemind the owner to drink tea.\n",
			);
			const waiting = await until(async () => {
				const room = await api<ControlView>("/control");
				return room.routines.find((routine) => routine.name === "tea" && routine.change !== undefined);
			});
			expect(waiting.accepted).toBeUndefined();
			expect(waiting.change).toMatchObject({
				kind: "added",
				routine: { description: "Tea time", when: "Every day", runsADay: 24 },
			});
			expect(waiting.next).toBeUndefined();
			// a stale hash is refused
			await expect(
				api(`/routines/tea/accept`, { method: "POST", body: JSON.stringify({ sha: "0".repeat(64) }) }),
			).rejects.toThrow(/409/);
			const sha = (waiting.change as { sha: string }).sha;
			const allowed = await api<ControlView>("/routines/tea/accept", { method: "POST", body: JSON.stringify({ sha }) });
			const tea = allowed.routines.find((routine) => routine.name === "tea");
			expect(tea?.change).toBeUndefined();
			expect(tea?.accepted?.routine?.description).toBe("Tea time");
			expect(tea?.next).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
			expect(allowed.activity[0]).toMatchObject({ routine: "tea", what: "You allowed it" });

			const paused = await api<ControlView>("/control/pause", { method: "POST" });
			expect(paused.paused).toBeDefined();
			expect(paused.routines.find((routine) => routine.name === "tea")?.next).toBeUndefined();
			expect((await api<CompanionView>("/companion")).paused).toBeDefined();
			const resumed = await api<ControlView>("/control/resume", { method: "POST" });
			expect(resumed.paused).toBeUndefined();
			expect(resumed.routines.find((routine) => routine.name === "tea")?.next).toBeDefined();

			const held = await api<ControlView>("/routines/tea/pause", { method: "POST" });
			expect(held.routines.find((routine) => routine.name === "tea")).toMatchObject({ paused: "owner" });
			const removed = await api<ControlView>("/routines/tea/remove", { method: "POST" });
			expect(removed.routines.find((routine) => routine.name === "tea")).toBeUndefined();
			expect(existsSync(file)).toBe(false);
		} finally {
			await daemon.close();
		}
	}, 30_000);
});
