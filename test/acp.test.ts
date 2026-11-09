import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	type AcpConnection,
	AcpError,
	type AcpHandlers,
	type AcpPermissionOutcome,
	type AcpUpdate,
	cancel,
	closeSession,
	jsonLines,
	openSession,
	prompt,
	startAcp,
} from "../src/core/acp.ts";

const FAKE = join(import.meta.dirname, "fixtures/fake-acp-agent.ts");

function fake(
	answer: (command: string) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>,
	env: NodeJS.ProcessEnv = {},
) {
	const home = mkdtempSync(join(tmpdir(), "banda-acp-"));
	const log = join(home, "fake.jsonl");
	const updates: AcpUpdate[] = [];
	const connection = startAcp({
		command: process.execPath,
		args: [FAKE],
		cwd: home,
		env: { ...process.env, FAKE_ACP_LOG: log, ...env },
		handlers: {
			update: (_session, update) => updates.push(update),
			permission: async (request) => answer(String((request.toolCall.rawInput as { command?: string }).command)),
		},
	});
	const entries = () =>
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as { [key: string]: unknown });
	return { connection, updates, entries, home };
}

const alive = (pid: number | undefined) => {
	try {
		process.kill(pid ?? 0, 0);
		return true;
	} catch {
		return false;
	}
};

describe("acp", () => {
	it("opens a session in the connection's mode, prompts, streams updates and answers a permission", async () => {
		const { connection, updates, entries } = fake(() => ({ outcome: "selected", optionId: "allow" }));
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir(), mode: "acceptEdits" });
			const ended = await prompt(connection, sessionId, "read src/a.ts\nedit src/a.ts +2 -1\nask npm test\nsay done");
			expect(ended.stopReason).toBe("end_turn");
			expect(updates.map((update) => update.sessionUpdate)).toEqual([
				"tool_call",
				"tool_call",
				"tool_call",
				"tool_call_update",
				"agent_message_chunk",
			]);
			expect(entries()).toContainEqual(expect.objectContaining({ mode: "acceptEdits" }));
			expect(entries()).toContainEqual(
				expect.objectContaining({ permission: "npm test", answer: { outcome: "selected", optionId: "allow" } }),
			);
		} finally {
			await connection.close();
		}
	});

	it("queues a prompt sent mid-turn, as steering", async () => {
		const { connection, entries } = fake(() => ({ outcome: "selected", optionId: "allow" }));
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir() });
			const first = prompt(connection, sessionId, "sleep 200\nsay first");
			const second = prompt(connection, sessionId, "say steered");
			expect((await first).stopReason).toBe("end_turn");
			expect((await second).stopReason).toBe("end_turn");
			expect(entries().filter((entry) => "ended" in entry)).toHaveLength(2);
		} finally {
			await connection.close();
		}
	});

	it("cancels a turn waiting on the owner, and the waiting answer goes as cancelled", async () => {
		let release: ((outcome: AcpPermissionOutcome) => void) | undefined;
		const { connection, entries } = fake(() => new Promise((resolve) => (release = resolve)));
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir() });
			const turn = prompt(connection, sessionId, "ask rm -rf build");
			await new Promise((resolve) => setTimeout(resolve, 150));
			cancel(connection, sessionId);
			release?.({ outcome: "cancelled" });
			expect((await turn).stopReason).toBe("cancelled");
			expect(entries()).toContainEqual(expect.objectContaining({ permission: "rm -rf build" }));
		} finally {
			await connection.close();
		}
	});

	it("refuses waiting requests when the harness dies, and close kills its whole group", async () => {
		const { connection } = fake(() => ({ outcome: "cancelled" }));
		const { sessionId } = await openSession(connection, { cwd: tmpdir() });
		await expect(prompt(connection, sessionId, "crash")).rejects.toThrow("the harness ended");
		const other: AcpConnection = fake(() => ({ outcome: "cancelled" })).connection;
		const { sessionId: second } = await openSession(other, { cwd: tmpdir() });
		void prompt(other, second, "sleep 60000").catch(() => {});
		await other.close();
		expect(alive(other.pid)).toBe(false);
	});
});

describe("acp session capabilities", () => {
	const deny = () => ({ outcome: "cancelled" }) as const;

	it("resumes by session/resume, with no history replayed, when the agent announces resume", async () => {
		const { connection, updates, entries } = fake(deny, { FAKE_ACP_RESUME: "1", FAKE_ACP_NO_LOAD: "1" });
		try {
			const opened = await openSession(connection, { cwd: tmpdir(), resume: "earlier-7" });
			expect(opened).toMatchObject({ sessionId: "earlier-7", loaded: true });
			expect(entries()).toContainEqual(expect.objectContaining({ resumed: "earlier-7" }));
			// unlike session/load, nothing from before is replayed
			expect(updates).toEqual([]);
			expect((await prompt(connection, "earlier-7", "say back")).stopReason).toBe("end_turn");
		} finally {
			await connection.close();
		}
	});

	it("falls back to session/load (history replayed) when resume is not announced", async () => {
		const { connection, updates, entries } = fake(deny);
		try {
			const opened = await openSession(connection, { cwd: tmpdir(), resume: "earlier-8" });
			expect(opened).toMatchObject({ sessionId: "earlier-8", loaded: true, canClose: false });
			expect(entries()).toContainEqual(expect.objectContaining({ loaded: "earlier-8" }));
			expect(updates.length).toBeGreaterThan(0);
		} finally {
			await connection.close();
		}
	});

	it.each([
		["session/resume", { FAKE_ACP_RESUME: "1", FAKE_ACP_NO_LOAD: "1" }],
		["session/load", {}],
	])("starts a new session when the harness refuses %s, and says it does not remember", async (_method, env) => {
		const { connection, entries } = fake(() => ({ outcome: "cancelled" }), { ...env, FAKE_ACP_REFUSE_REOPEN: "1" });
		try {
			const opened = await openSession(connection, { cwd: tmpdir(), resume: "gone-1" });
			expect(opened.loaded).toBe(false);
			expect(opened.sessionId).not.toBe("gone-1");
			expect(entries()).toContainEqual(expect.objectContaining({ made: opened.sessionId }));
		} finally {
			await connection.close();
		}
	});

	it("refuses a harness that opens a session without naming it", async () => {
		const connection = startAcp({
			command: process.execPath,
			args: [
				"-e",
				`process.stdin.once("data", () => {
					process.stdout.write(JSON.stringify({ id: 1, result: { protocolVersion: 1 } }) + "\\n");
					process.stdin.once("data", () => process.stdout.write(JSON.stringify({ id: 2, result: {} }) + "\\n"));
				});`,
			],
			cwd: tmpdir(),
			handlers: { update: () => {}, permission: async () => ({ outcome: "cancelled" }) },
		});
		await expect(openSession(connection, { cwd: tmpdir() })).rejects.toThrow("did not name its session");
		await connection.close();
	});

	it("does not start anew when the harness died while reopening: that is no refusal", async () => {
		const connection = startAcp({
			command: process.execPath,
			args: [
				"-e",
				`process.stdin.once("data", () => {
					process.stdout.write(JSON.stringify({ id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + "\\n");
					process.stdin.once("data", () => process.exit(3));
				});`,
			],
			cwd: tmpdir(),
			handlers: { update: () => {}, permission: async () => ({ outcome: "cancelled" }) },
		});
		await expect(openSession(connection, { cwd: tmpdir(), resume: "gone-2" })).rejects.toThrow("the harness ended");
		await connection.close();
	});

	it("closes a session when the agent announces close, and one already gone (-32002) counts as closed", async () => {
		const { connection, entries } = fake(deny, { FAKE_ACP_CLOSE: "1" });
		try {
			const { sessionId, canClose } = await openSession(connection, { cwd: tmpdir() });
			expect(canClose).toBe(true);
			await closeSession(connection, sessionId);
			expect(entries()).toContainEqual(expect.objectContaining({ closed: sessionId }));
			// the agent no longer has it: -32002, as closed
			await expect(closeSession(connection, sessionId)).resolves.toBeUndefined();
		} finally {
			await connection.close();
		}
	});

	it("treats only -32002 as success on close; any other refusal still throws", async () => {
		const refuse = (code: number) =>
			({
				request: async () => {
					throw new AcpError("refused", code);
				},
			}) as unknown as AcpConnection;
		await expect(closeSession(refuse(-32002), "s")).resolves.toBeUndefined();
		await expect(closeSession(refuse(-32601), "s")).rejects.toThrow("refused");
	});

	it("appends banda's instructions as a system prompt only when the agent announces systemPrompt", async () => {
		const offered = fake(deny, { FAKE_ACP_SYSTEM: "1" });
		try {
			const { sessionId } = await openSession(offered.connection, { cwd: tmpdir(), system: "banda's rules" });
			expect(offered.entries()).toContainEqual(
				expect.objectContaining({
					made: sessionId,
					systemPrompt: { mode: "append", content: [{ type: "text", text: "banda's rules" }] },
				}),
			);
		} finally {
			await offered.connection.close();
		}
		const plain = fake(deny);
		try {
			const { sessionId } = await openSession(plain.connection, { cwd: tmpdir(), system: "banda's rules" });
			const made = plain.entries().find((entry) => entry.made === sessionId);
			expect(made).toBeDefined();
			expect(made).not.toHaveProperty("systemPrompt");
		} finally {
			await plain.connection.close();
		}
	});

	it("sends the same system prompt again on resume", async () => {
		const { connection, entries } = fake(deny, { FAKE_ACP_RESUME: "1", FAKE_ACP_SYSTEM: "1" });
		try {
			await openSession(connection, { cwd: tmpdir(), resume: "earlier-9", system: "banda's rules" });
			expect(entries()).toContainEqual(
				expect.objectContaining({
					resumed: "earlier-9",
					systemPrompt: { mode: "append", content: [{ type: "text", text: "banda's rules" }] },
				}),
			);
		} finally {
			await connection.close();
		}
	});
});

describe("acp, when a harness misbehaves", () => {
	/** A harness that, asked `go`, sends `lines` and then answers: as a script, so the lines are exactly these. */
	const scripted = (lines: readonly string[], handlers: Partial<AcpHandlers> = {}) => {
		const said: string[] = [];
		const script = `
			let buffer = "";
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", (chunk) => {
				buffer += chunk;
				for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
					const message = JSON.parse(buffer.slice(0, at));
					buffer = buffer.slice(at + 1);
					if (message.method !== "go") continue;
					for (const each of ${JSON.stringify(lines)}) process.stdout.write(each + "\\n");
					process.stdout.write(JSON.stringify({ id: message.id, result: { went: true } }) + "\\n");
				}
			});
		`;
		const connection = startAcp({
			command: process.execPath,
			args: ["-e", script],
			cwd: tmpdir(),
			handlers: {
				update: handlers.update ?? (() => {}),
				permission: handlers.permission ?? (async () => ({ outcome: "cancelled" })),
			},
			log: (line) => said.push(line),
		});
		return { connection, said };
	};
	const update = JSON.stringify({
		method: "session/update",
		params: { sessionId: "s", update: { sessionUpdate: "x" } },
	});

	it.each(["null", "[]", "5", '"words"', "true"])(
		"takes the line %s as nothing, and goes on answering",
		async (line) => {
			const { connection } = scripted([line]);
			try {
				await expect(connection.request("go", {})).resolves.toEqual({ went: true });
			} finally {
				await connection.close();
			}
		},
	);

	it('takes "error": null beside a result as no error', async () => {
		const { connection } = scripted(['{"id":1,"result":{"early":true},"error":null}']);
		try {
			await expect(connection.request("go", {})).resolves.toEqual({ early: true });
		} finally {
			await connection.close();
		}
	});

	it("drops an update whose handler throws, says so, and goes on", async () => {
		const seen: string[] = [];
		const { connection, said } = scripted([update, update], {
			update: (_session, each) => {
				seen.push(each.sessionUpdate);
				throw new TypeError("content.filter is not a function");
			},
		});
		try {
			await expect(connection.request("go", {})).resolves.toEqual({ went: true });
			expect(seen).toEqual(["x", "x"]);
			expect(said.join("\n")).toContain("content.filter is not a function");
		} finally {
			await connection.close();
		}
	});

	it("survives a permission handler that throws at once", async () => {
		const asked = JSON.stringify({ id: 77, method: "session/request_permission", params: {} });
		const { connection } = scripted([asked], {
			permission: () => {
				throw new TypeError("no options");
			},
		});
		try {
			await expect(connection.request("go", {})).resolves.toEqual({ went: true });
		} finally {
			await connection.close();
		}
	});
});

describe("acp framing", () => {
	it("keeps a line whole when its JSON holds U+2028 or U+2029, which readline would split", async () => {
		const { connection, updates } = fake(() => ({ outcome: "cancelled" }));
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir() });
			await prompt(connection, sessionId, "say a b c");
			const said = updates
				.filter((u) => u.sessionUpdate === "agent_message_chunk")
				.map((u) => (u.content as { text: string }).text);
			expect(said).toEqual(["a b c"]);
		} finally {
			await connection.close();
		}
	});
});

for (const chunks of [["0123456789\n"], ["01234", "56789\n"], ["界界界\n"]]) {
	it(`rejects oversized complete frames regardless of chunking: ${JSON.stringify(chunks)}`, () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		let rejected = 0;
		jsonLines(stream, (line) => lines.push(line), { max: 8, over: () => rejected++ });
		for (const chunk of chunks) stream.write(chunk);
		stream.write("ok\n");
		expect(lines).toEqual(["ok"]);
		expect(rejected).toBe(1);
	});
}

it("does not proceed when the promised permission mode is unsupported", async () => {
	const calls: string[] = [];
	const connection = {
		request: async (method: string) => {
			calls.push(method);
			if (method === "initialize") return { protocolVersion: 1 };
			if (method === "session/new") return { sessionId: "s1" };
			throw new Error("mode unavailable");
		},
	} as unknown as AcpConnection;
	await expect(openSession(connection, { cwd: tmpdir(), mode: "acceptEdits" })).rejects.toThrow("mode unavailable");
	expect(calls).toEqual(["initialize", "session/new", "session/set_mode"]);
});
