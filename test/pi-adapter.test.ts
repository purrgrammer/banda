import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AcpPermissionOutcome, type AcpUpdate, cancel, openSession, prompt, startAcp } from "../src/core/acp.ts";

const ADAPTER = join(import.meta.dirname, "../src/adapters/pi.ts");
const FAKE_PI = join(import.meta.dirname, "fixtures/fake-pi.ts");

function adapter(answer: AcpPermissionOutcome) {
	const updates: AcpUpdate[] = [];
	const asked: string[] = [];
	const connection = startAcp({
		command: process.execPath,
		// the adapter runs `<command> <args> --mode rpc`: node, the fake pi
		args: [ADAPTER, process.execPath, FAKE_PI],
		cwd: tmpdir(),
		handlers: {
			update: (_session, update) => updates.push(update),
			permission: async (request) => {
				asked.push(String(request.toolCall.title));
				return answer;
			},
		},
	});
	return { connection, updates, asked };
}

describe("banda's pi adapter", () => {
	it("turns pi's tool runs into tool calls, its words into chunks, and its extension dialogs into asks", async () => {
		const { connection, updates, asked } = adapter({ outcome: "selected", optionId: "allow" });
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir() });
			expect((await prompt(connection, sessionId, "run npm test")).stopReason).toBe("end_turn");
			expect(updates.map((u) => u.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
			expect(updates[0]).toMatchObject({ kind: "execute", rawInput: { command: "npm test" } });
			expect((await prompt(connection, sessionId, "confirm Push to main?")).stopReason).toBe("end_turn");
			expect(asked).toEqual(["Push to main?"]);
			expect(updates.at(-1)).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "confirmed" } });
		} finally {
			await connection.close();
		}
	});

	it("takes a prompt sent while pi works as its steer: both end with that one run", async () => {
		const { connection } = adapter({ outcome: "cancelled" });
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir() });
			const first = prompt(connection, sessionId, "slow");
			await new Promise((resolve) => setTimeout(resolve, 100));
			const second = prompt(connection, sessionId, "also this");
			expect([(await first).stopReason, (await second).stopReason]).toEqual(["end_turn", "end_turn"]);
		} finally {
			await connection.close();
		}
	});

	it("ends a run cancelled when it is aborted", async () => {
		const { connection } = adapter({ outcome: "cancelled" });
		try {
			const { sessionId } = await openSession(connection, { cwd: tmpdir() });
			const run = prompt(connection, sessionId, "slow");
			await new Promise((resolve) => setTimeout(resolve, 100));
			cancel(connection, sessionId);
			expect((await run).stopReason).toBe("cancelled");
		} finally {
			await connection.close();
		}
	});
});
