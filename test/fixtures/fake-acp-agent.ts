/**
 * A scripted ACP agent standing in for claude-agent-acp: `node test/fixtures/fake-acp-agent.ts`. A prompt is a script,
 * one step a line:
 *   read <path>            a read, completed at once
 *   edit <path> <+a> <-r>  an edit of a lines added, r removed
 *   ask <command>          a permission request; allowed it runs, else it fails
 *   sleep <ms>             wait, cancellable
 *   say <text>             words, the turn's last message
 *   crash                  the process exits
 *   background <mark>      start a long command that outlives this process unless its group is killed
 * Prompts run one at a time, in order: one sent mid-turn waits (as claude-agent-acp queues it). Every prompt received,
 * permission answered and turn ended is appended to $FAKE_ACP_LOG (jsonl), so it survives a kill.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_ACP_LOG;
const record = (entry: object) => {
	if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId: string, value: object) =>
	send({ method: "session/update", params: { sessionId, update: value } });

let nextRequest = 1_000_000;
const asked = new Map<number, (result: { outcome: { outcome: string; optionId?: string } }) => void>();
const sessions = new Set<string>();
let mode = "default";
let queue: Promise<void> = Promise.resolve();
const cancelled = new Set<string>();
let wake: (() => void) | undefined;

const sleep = (ms: number, sessionId: string) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		wake = () => {
			clearTimeout(timer);
			resolve();
		};
		if (cancelled.has(sessionId)) wake();
	});

let call = 0;
async function run(sessionId: string, script: string): Promise<string> {
	for (const line of script.split("\n").map((each) => each.trim())) {
		if (cancelled.has(sessionId)) return "cancelled";
		const [verb = "", ...rest] = line.split(" ");
		const id = `call-${++call}`;
		if (verb === "read") {
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: id,
				title: `Read ${rest[0]}`,
				kind: "read",
				status: "completed",
				locations: [{ path: rest[0] }],
			});
		} else if (verb === "edit") {
			const [path = "", added = "+1", removed = "-0"] = rest;
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: id,
				title: `Edit ${path}`,
				kind: "edit",
				status: "completed",
				locations: [{ path }],
				_meta: { banda: { added: Number(added.slice(1)), removed: Number(removed.slice(1)) } },
			});
		} else if (verb === "ask") {
			const command = rest.join(" ");
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: id,
				title: command,
				kind: "execute",
				status: "pending",
				rawInput: { command },
			});
			const request = nextRequest++;
			const answer = await new Promise<{ outcome: { outcome: string; optionId?: string } }>((resolve) => {
				asked.set(request, resolve);
				send({
					id: request,
					method: "session/request_permission",
					params: {
						sessionId,
						toolCall: { toolCallId: id, title: command, kind: "execute", rawInput: { command } },
						options: [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "always", name: "Always allow", kind: "allow_always" },
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
						],
					},
				});
			});
			const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "reject";
			record({ permission: command, answer: answer.outcome });
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: id,
				status: allowed ? "completed" : "failed",
				rawOutput: allowed ? `ran ${command}` : "refused",
			});
			if (answer.outcome.outcome === "cancelled") return "cancelled";
		} else if (verb === "sleep") {
			await sleep(Number(rest[0] ?? 0), sessionId);
		} else if (verb === "say") {
			update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: rest.join(" ") } });
		} else if (verb === "background") {
			// in this process's group, as a harness's shell is; it does not die with this process
			spawn("sh", ["-c", `: ${rest[0]}; sleep 600`], { stdio: "ignore" }).unref();
		} else if (verb === "crash") {
			process.exit(1);
		} else if (line !== "") {
			update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } });
		}
	}
	return cancelled.has(sessionId) ? "cancelled" : "end_turn";
}

const input = createInterface({ input: process.stdin });
// as claude-agent-acp: its client gone, it exits (what it started may not)
input.on("close", () => process.exit(0));
input.on("line", (line) => {
	const message = JSON.parse(line) as {
		id?: number;
		method?: string;
		params?: { [key: string]: unknown };
		result?: unknown;
	};
	if (message.method === undefined) {
		const resolve = typeof message.id === "number" ? asked.get(message.id) : undefined;
		asked.delete(message.id as number);
		resolve?.(message.result as never);
		return;
	}
	const params = message.params ?? {};
	switch (message.method) {
		case "initialize":
			return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
		case "session/new": {
			const sessionId = `fake-${process.pid}-${sessions.size + 1}`;
			sessions.add(sessionId);
			return send({ id: message.id, result: { sessionId, modes: { currentModeId: "auto", availableModes: [] } } });
		}
		case "session/load":
			sessions.add(String(params.sessionId));
			record({ loaded: params.sessionId });
			return send({ id: message.id, result: {} });
		case "session/set_mode":
			mode = String(params.modeId);
			record({ mode });
			return send({ id: message.id, result: {} });
		case "session/prompt": {
			const sessionId = String(params.sessionId);
			const text = ((params.prompt as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("\n");
			record({ prompt: text, sessionId });
			const id = message.id;
			queue = queue.then(async () => {
				cancelled.delete(sessionId);
				const stopReason = await run(sessionId, text);
				record({ ended: stopReason, sessionId });
				send({ id, result: { stopReason } });
			});
			return;
		}
		case "session/cancel": {
			const sessionId = String(params.sessionId);
			cancelled.add(sessionId);
			wake?.();
			for (const [request, resolve] of asked) {
				asked.delete(request);
				resolve({ outcome: { outcome: "cancelled" } });
			}
			return;
		}
		default:
			if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "not offered" } });
	}
});
