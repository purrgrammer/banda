/**
 * The daemon's side of the egress proxy without Docker: every config it pushes carries its own port, even one a
 * watcher pushes before the daemon listens (DESIGN.md "The box", Network: the daemon's port is never reached).
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { BoxEgress, EgressConfig } from "../src/box/box.ts";
import type { HeldRequest } from "../src/core/egress.ts";
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

it("bring-up recovers a retained request in an existing chat without another command", async () => {
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
		expect(await (await call(first, "/say", { text: "seed an idle chat" })).text()).toContain("re: seed an idle chat");
		const status = await readStatus(first);
		assert.ok(status.chats[0] !== undefined);
		chat = status.chats[0].chat;
		expect(status.chats[0].state).toBe("idle");
	} finally {
		await first.close();
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
		const wait = await until(async () =>
			(await readStatus(second)).waits.find((one) => one.ask.args._ticket === held.ticket),
		);
		expect(wait.chat).toBe(chat);
		expect(wait.ask.args.body).toBe("retained bytes");
		expect(wait.ask).not.toHaveProperty("permission");
		expect(wait.ask).not.toHaveProperty("host");
		expect(wait.ask).not.toHaveProperty("errand");
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
});
