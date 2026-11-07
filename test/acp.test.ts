import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	type AcpConnection,
	AcpError,
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
