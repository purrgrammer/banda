/**
 * The daemon's side of the egress proxy without Docker: every config it pushes carries its own port, even one a
 * watcher pushes before the daemon listens (DESIGN.md "The box", Network: the daemon's port is never reached).
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { BoxEgress, EgressConfig } from "../src/box/box.ts";
import { AgentChats, LEAD } from "../src/core/agents.ts";
import type { HeldRequest } from "../src/core/egress.ts";
import { RoutineRuns } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { ownerToken } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

describe("the daemon's config pushes", () => {
	it("never push a config without the daemon's port: the first waits for it to listen", async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const pushed: Omit<EgressConfig, "key">[] = [];
		let source: (() => Promise<Omit<EgressConfig, "key">>) | undefined;
		let calls = 0;
		const egress: BoxEgress = {
			env: () => ({}),
			source: (from) => {
				source = from;
			},
			configure: async () => {
				calls += 1;
				if (source === undefined) return "not running";
				pushed.push(await source());
				return "told";
			},
			receiptChats: async () => [],
			pass: async () => {},
			take: async () => ({ held: [], reads: [], readBytes: 0 }),
			ack: async () => {},
			replay: async () => ({ refused: "not in this test" }),
		};
		const box = hostBox(home);
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			// as the container box does: its bring-up (which the daemon starts before it listens) pushes the config
			box: {
				...box,
				egress,
				ensure: async () => {
					await box.ensure();
					await egress.configure();
				},
			},
		});
		try {
			// the bring-up's push and the one at listen, at least
			await until(() => pushed.length >= 2);
			expect(calls).toBeGreaterThanOrEqual(2);
			expect(pushed.map((config) => config.daemonPort)).toEqual(pushed.map(() => daemon.port));
		} finally {
			await daemon.close();
		}
	});
});

it.each(["direct", "finished routine"])(
	"bring-up recovers a retained request in a %s without another command",
	async (kind) => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const token = await ownerToken(home);
		const call = async (daemon: Daemon, path: string, body?: object) => {
			const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(5_000),
			});
			expect(response.ok).toBe(true);
			return response;
		};
		const Status = Type.Object({
			chats: Type.Array(Type.Object({ chat: Type.Number(), state: Type.String() })),
			waits: Type.Array(
				Type.Object({
					key: Type.String(),
					chat: Type.Number(),
					ask: Type.Object({ type: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }),
				}),
			),
		});
		const readStatus = async (daemon: Daemon) => {
			const value: unknown = await (await call(daemon, "/status")).json();
			assert.ok(Value.Check(Status, value));
			return value;
		};
		const first = await startDaemon({ home, port: 0, models: echoModels().models, log: () => {}, box: hostBox(home) });
		let chat: number;
		try {
			expect(await (await call(first, "/say", { text: "seed an idle chat" })).text()).toContain(
				"re: seed an idle chat",
			);
			const status = await readStatus(first);
			assert.ok(status.chats[0] !== undefined);
			chat = status.chats[0].chat;
			expect(status.chats[0].state).toBe("idle");
			if (kind === "finished routine") {
				await call(first, "/routines", {
					agent: LEAD,
					description: "Retained request",
					when: "every 24h",
					ask: "Check the receipt.",
				});
				await call(first, `/routines/${LEAD}/retained-request/run`, { key: "run-once" });
				const Runs = Type.Object({ runs: Type.Array(Type.Object({ state: Type.String() })) });
				await until(async () => {
					const value: unknown = await (await call(first, `/routines/${LEAD}/retained-request/runs`)).json();
					assert.ok(Value.Check(Runs, value));
					return value.runs.some((run) => run.state === "said");
				});
			}
		} finally {
			await first.close();
		}
		let parent = chat;
		if (kind === "finished routine") {
			const stored = await openStore(home, { models: echoModels().models, registry: createRegistry() });
			try {
				const runs = Object.entries((await stored.snapshot(RoutineRuns, context))?.runs ?? {});
				expect(runs).toHaveLength(1);
				const [run] = runs;
				assert.ok(run);
				chat = Number(run[0]);
				parent = run[1].chat;
				expect(run[1]).toMatchObject({ agent: LEAD, routine: `${LEAD}/retained-request` });
				expect((await stored.snapshot(AgentChats, context))?.chats[chat]).toBeUndefined();
			} finally {
				await stored.close(context);
			}
		}
		const held: HeldRequest = {
			ticket: "t0000000001",
			chat,
			at: Date.now(),
			method: "POST",
			scheme: "https",
			host: "example.com",
			port: 443,
			path: "/retained",
			headers: [["content-type", "text/plain"]],
			body: Buffer.from("retained bytes").toString("base64"),
		};
		let pending = [held];
		const sent: HeldRequest[] = [];
		const acked: string[] = [];
		const egress: BoxEgress = {
			env: () => ({}),
			source: () => {},
			configure: async () => "told",
			pass: async () => {},
			receiptChats: async () => (pending.length === 0 ? [] : [chat]),
			take: async () => ({ held: [...pending], reads: [], readBytes: 0 }),
			ack: async (_chat, readBytes, ids) => {
				expect(readBytes).toBe(0);
				acked.push(...ids);
				pending = pending.filter((one) => !ids.includes(one.ticket));
			},
			replay: async (request) => {
				sent.push(request);
				return { status: 200, reason: "OK", headers: [], body: Buffer.from("accepted").toString("base64") };
			},
		};
		const second = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: { ...hostBox(home), egress },
		});
		try {
			await until(() => acked.includes(held.ticket));
			const waits = (await readStatus(second)).waits.filter((one) => one.ask.args._ticket === held.ticket);
			expect(waits).toHaveLength(1);
			const [wait] = waits;
			assert.ok(wait);
			expect(wait.chat).toBe(chat);
			expect(wait.ask.args.body).toBe("retained bytes");
			expect(wait.ask).not.toHaveProperty("permission");
			expect(wait.ask).not.toHaveProperty("host");
			expect(wait.ask).not.toHaveProperty("errand");
			if (kind === "finished routine") expect(wait.chat).not.toBe(parent);
			const Rows = Type.Array(Type.Object({ chat: Type.Number(), ask: Type.Optional(Type.String()) }));
			const rows: unknown = await (await call(second, "/chats")).json();
			assert.ok(Value.Check(Rows, rows));
			expect(rows.find((row) => row.chat === parent)?.ask).toContain("send POST");
			const stream = await call(second, `/chats/${parent}/events`);
			const reader = stream.body?.getReader();
			assert.ok(reader);
			try {
				const Event = Type.Object({ type: Type.Literal("waits"), waits: Status.properties.waits });
				const decoder = new TextDecoder();
				let buffered = "";
				let shown: unknown;
				while (shown === undefined) {
					const chunk = await reader.read();
					assert.ok(!chunk.done);
					buffered += decoder.decode(chunk.value, { stream: true });
					for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
						const event: unknown = JSON.parse(buffered.slice(0, end).replace(/^data: /, ""));
						buffered = buffered.slice(end + 2);
						if (Value.Check(Event, event)) shown = event;
					}
				}
				assert.ok(Value.Check(Event, shown));
				expect(shown.waits).toHaveLength(1);
				expect(shown.waits[0]).toMatchObject(wait);
			} finally {
				await reader.cancel();
			}
			await until(() => acked.includes(held.ticket));
			expect(pending).toEqual([]);
			expect(sent).toEqual([]);
			await call(second, `/waits/${wait.key}`, { answer: "approve", type: "approval", via: "web" });
			await until(() => sent.length === 1);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject(held);
			await until(async () => (await readStatus(second)).waits.length === 0);
		} finally {
			await second.close();
		}
		expect(sent).toHaveLength(1);
	},
);
