/**
 * A scripted ACP agent standing in for claude-agent-acp: `node test/fixtures/fake-acp-agent.ts`. A prompt is a script,
 * one step a line:
 *   read <path>            a read, completed at once
 *   edit <path> <+a> <-r>  an edit of a lines added, r removed
 *   ask <command>          a permission request; allowed it runs, else it fails
 *   asks2 <a> <b>          two permission requests at once, as parallel subagents send them
 *   sleep <ms>             wait, cancellable
 *   say <text>             words, the turn's last message
 *   usage <used> <size>    a usage_update
 *   title <text>           a session_info_update
 *   plan <text>            a plan update with one entry
 *   commands <a> <b> …     an available_commands_update
 *   crash                  the process exits
 *   background <mark>      start a long command, detached in a group of its own, that outlives this process
 * A line it does not know is said as words (a recap of earlier work, sent before the script). `session/load` replays
 * history first, as real harnesses do; FAKE_ACP_NO_LOAD=1 makes it one that cannot reopen a session. FAKE_ACP_RESUME,
 * FAKE_ACP_CLOSE and FAKE_ACP_SYSTEM (=1) announce the matching sessionCapabilities: session/resume reopens with no
 * replay, session/close forgets the session (-32002 for one it does not have), and a systemPrompt given on
 * new/load/resume goes into the log beside the session it opened. FAKE_ACP_REFUSE_REOPEN=1 answers session/resume and
 * session/load with -32002, a session it no longer has; FAKE_ACP_WEDGE=1 ignores session/cancel.
 * Prompts run one at a time, in order: one sent mid-turn waits (as claude-agent-acp queues it). Every prompt received,
 * permission answered and turn ended is appended to $FAKE_ACP_LOG (jsonl), so it survives a kill.
 *
 * FAKE_ACP_V2=1 answers an `initialize` that asks for v2 in v2, in the order claude-agent-acp 0.100.0's v2 surface
 * sends (read in its `dist/v2/`): a prompt is answered `{ messageId }` once taken in, right after its `user_message` and
 * before its turn's `running`; every `state_update` carries the full `background` list, and a list change repeats the
 * state without a stop reason; an item's final status comes before the list that drops it; `session/cancel` stops the
 * foreground only, `terminal/cancel` and `tool_call/cancel` one item, `session/close` all of them; a prompt a cancel
 * withdrew before it was taken in is refused with -32800. The mode is the `mode` config option (FAKE_ACP_NO_MODE=1
 * offers none). FAKE_ACP_V2=unreported is the same with no list on any state, as codex-acp 2.5.0 sends. v2-only lines:
 *   bg <ms>                a background command (a timer, no process) that ends after ms
 *   monitor <ms>           a background tool call that ends after ms
 *   bgask <ms> <command>   a background command that, after ms, asks to run <command>, then ends
 *   withdraw <ms> <command> asks to run <command>, and withdraws the ask after ms ($/cancel_request), unanswered
 *   task <ms>              background work of a kind with no cancel of its own (`_claude/task`): only close ends it
 *   bgfollow <ms> <text>   a background command that ends after ms, after which Claude Code's own follow-up run (on
 *                          its task notification) says <text>. By default in claude-agent-acp 0.100.0's order: the
 *                          command's exit, then `idle` with the list that drops it (first at the terminal
 *                          `task_updated`, acp-agent.js:4790-4799, else `task_notification` :4765 or
 *                          `background_tasks_changed` :4968-4975, each followed by the per-message sync at :3933), and
 *                          only FAKE_ACP_FOLLOW_MS later (the model's first output, :7709-7723) `running`, the words and
 *                          `idle`. FAKE_ACP_FOLLOWUP=atomic sends a fixed order instead: `running` before the item
 *                          leaves the list, so no `idle` with an empty list comes between the command and its follow-up
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { jsonLines } from "../../src/core/acp.ts";

const LOG = process.env.FAKE_ACP_LOG;
const record = (entry: object) => {
	if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId: string, value: object) =>
	send({ method: "session/update", params: { sessionId, update: value } });

const V2 = process.env.FAKE_ACP_V2;
/** Whether this connection negotiated v2. */
let v2 = false;
let foreground: "idle" | "running" = "idle";
type Item = { type: "terminal" | "tool_call" | "_claude/task"; id: string; end: () => void };
const items: Item[] = [];
const listed = () =>
	items.map((item) =>
		item.type === "terminal"
			? { type: "terminal", terminalId: item.id }
			: item.type === "tool_call"
				? { type: "tool_call", toolCallId: item.id }
				: { type: item.type, taskId: item.id, description: "a task" },
	);
const state = (sessionId: string, value: "idle" | "running", stopReason?: string) => {
	foreground = value;
	update(sessionId, {
		sessionUpdate: "state_update",
		state: value,
		...(stopReason === undefined ? {} : { stopReason }),
		...(V2 === "unreported" ? {} : { background: listed() }),
	});
};
let said = 0;
/** A tool call: v1's `tool_call` first, v2's one upserting `tool_call_update`. */
const toolCall = (sessionId: string, fields: object) =>
	update(sessionId, { sessionUpdate: v2 ? "tool_call_update" : "tool_call", ...fields });
/** Background work: listed now, its final status then the list without it when it ends (or is cancelled). */
function background(sessionId: string, type: Item["type"], ms: number, then?: () => Promise<void>) {
	const id = `${type === "terminal" ? "term" : type === "tool_call" ? "tool" : "task"}-${++call}`;
	let timer: NodeJS.Timeout | undefined;
	const end = (status = "completed") => {
		clearTimeout(timer);
		const at = items.findIndex((item) => item.id === id);
		if (at < 0) return;
		if (type === "terminal")
			update(sessionId, {
				sessionUpdate: "terminal_update",
				terminalId: id,
				exitStatus: status === "cancelled" ? { signal: "SIGTERM" } : { exitCode: 0 },
			});
		if (type !== "_claude/task") update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status });
		items.splice(at, 1);
		record({ backgroundEnded: id, status });
		state(sessionId, foreground);
	};
	if (type === "terminal") update(sessionId, { sessionUpdate: "terminal_update", terminalId: id, command: `bg ${ms}` });
	if (type !== "_claude/task")
		update(sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: id,
			title: type === "terminal" ? `bg ${ms}` : "Monitor",
			kind: type === "terminal" ? "execute" : "other",
			status: "in_progress",
			rawInput: type === "terminal" ? { command: `bg ${ms}` } : {},
			...(type === "terminal" ? { content: [{ type: "terminal", terminalId: id }] } : {}),
		});
	items.push({ type, id, end: () => end("cancelled") });
	record({ backgroundStarted: id });
	state(sessionId, foreground);
	timer = setTimeout(() => {
		void (then?.() ?? Promise.resolve()).then(() => end());
	}, ms);
}

let nextRequest = 1_000_000;
const asked = new Map<number, (result: { outcome: { outcome: string; optionId?: string } }) => void>();
const sessions = new Set<string>();
let mode = "default";
let queue: Promise<void> = Promise.resolve();
const cancelled = new Set<string>();
let wake: (() => void) | undefined;
let cancels = 0;

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
/** A permission request, in v1's shape or v2's (`title`, the tool call as its `subject`). */
function permission(
	sessionId: string,
	toolCallId: string,
	command: string,
	options: { optionId: string; name: string; kind: string }[],
): Promise<{ outcome: { outcome: string; optionId?: string } }> {
	const toolCall = { toolCallId, title: command, kind: "execute", rawInput: { command } };
	return new Promise((resolve) => {
		const request = nextRequest++;
		asked.set(request, resolve);
		send({
			id: request,
			method: "session/request_permission",
			params: v2
				? { sessionId, title: command, subject: { type: "tool_call", toolCall }, options }
				: { sessionId, toolCall, options },
		});
	});
}
async function run(sessionId: string, script: string): Promise<string> {
	for (const line of script.split("\n").map((each) => each.trim())) {
		if (cancelled.has(sessionId)) return "cancelled";
		const [verb = "", ...rest] = line.split(" ");
		const id = `call-${++call}`;
		if (verb === "read") {
			toolCall(sessionId, {
				toolCallId: id,
				title: `Read ${rest[0]}`,
				kind: "read",
				status: "completed",
				locations: [{ path: rest[0] }],
			});
		} else if (verb === "edit") {
			const [path = "", added = "+1", removed = "-0"] = rest;
			toolCall(sessionId, {
				toolCallId: id,
				title: `Edit ${path}`,
				kind: "edit",
				status: "completed",
				locations: [{ path }],
				_meta: { banda: { added: Number(added.slice(1)), removed: Number(removed.slice(1)) } },
			});
		} else if (verb === "ask") {
			const command = rest.join(" ");
			toolCall(sessionId, {
				toolCallId: id,
				title: command,
				kind: "execute",
				status: "pending",
				rawInput: { command },
			});
			const answer = await permission(sessionId, id, command, [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "always", name: "Always allow", kind: "allow_always" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			]);
			const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "reject";
			record({ permission: command, answer: answer.outcome });
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: id,
				status: allowed ? "completed" : "failed",
				rawOutput: allowed ? `ran ${command}` : "refused",
			});
			if (answer.outcome.outcome === "cancelled") return "cancelled";
		} else if (verb === "asks2") {
			const both = rest.slice(0, 2).map(
				(command) =>
					new Promise<{ outcome: { outcome: string; optionId?: string } }>((resolve) => {
						const request = nextRequest++;
						asked.set(request, resolve);
						send({
							id: request,
							method: "session/request_permission",
							params: {
								sessionId,
								toolCall: { toolCallId: `call-${++call}`, title: command, kind: "execute", rawInput: { command } },
								options: [
									{ optionId: "allow", name: "Allow", kind: "allow_once" },
									{ optionId: "reject", name: "Reject", kind: "reject_once" },
								],
							},
						});
					}),
			);
			for (const answer of await Promise.all(both)) record({ permission: "parallel", answer: answer.outcome });
		} else if (verb === "sleep") {
			await sleep(Number(rest[0] ?? 0), sessionId);
		} else if (verb === "say") {
			update(sessionId, {
				sessionUpdate: "agent_message_chunk",
				...(v2 ? { messageId: `said-${++said}` } : {}),
				content: { type: "text", text: rest.join(" ") },
			});
		} else if (verb === "usage") {
			update(sessionId, { sessionUpdate: "usage_update", used: Number(rest[0] ?? 0), size: Number(rest[1] ?? 0) });
		} else if (verb === "title") {
			update(sessionId, { sessionUpdate: "session_info_update", title: rest.join(" ") });
		} else if (verb === "plan") {
			update(sessionId, {
				sessionUpdate: "plan",
				entries: [{ content: rest.join(" "), priority: "medium", status: "pending" }],
			});
		} else if (verb === "commands") {
			update(sessionId, {
				sessionUpdate: "available_commands_update",
				availableCommands: rest.map((name) => ({ name, description: name })),
			});
		} else if (verb === "background") {
			// detached, in a group of its own, as Claude Code runs each command: killing the harness's group misses it
			spawn("sh", ["-c", `: ${rest[0]}; sleep 600`], { stdio: "ignore", detached: true }).unref();
		} else if (verb === "crash") {
			process.exit(1);
		} else if (v2 && verb === "bg") {
			background(sessionId, "terminal", Number(rest[0] ?? 0));
		} else if (v2 && verb === "monitor") {
			background(sessionId, "tool_call", Number(rest[0] ?? 0));
		} else if (v2 && verb === "bgfollow") {
			const ms = Number(rest[0] ?? 0);
			const text = rest.slice(1).join(" ");
			const id = `term-${++call}`;
			update(sessionId, { sessionUpdate: "terminal_update", terminalId: id, command: `bg ${ms}` });
			update(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: id,
				title: `bg ${ms}`,
				kind: "execute",
				status: "in_progress",
				rawInput: { command: `bg ${ms}` },
				content: [{ type: "terminal", terminalId: id }],
			});
			const drop = () => {
				const at = items.findIndex((item) => item.id === id);
				if (at < 0) return false;
				// as the adapter: Claude Code reports no exit code for a background command (background-work.js:206)
				update(sessionId, { sessionUpdate: "terminal_update", terminalId: id, exitStatus: {} });
				update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
				items.splice(at, 1);
				record({ backgroundEnded: id, status: "completed" });
				return true;
			};
			items.push({
				type: "terminal",
				id,
				end: () => {
					if (drop()) state(sessionId, foreground);
				},
			});
			state(sessionId, foreground);
			setTimeout(() => {
				if (!items.some((item) => item.id === id)) return;
				const atomic = process.env.FAKE_ACP_FOLLOWUP === "atomic";
				// proposed: the follow-up's foreground opens at the task notification, before the item leaves the list
				if (atomic) state(sessionId, "running");
				drop();
				state(sessionId, foreground);
				setTimeout(
					() => {
						if (!atomic) state(sessionId, "running");
						update(sessionId, {
							sessionUpdate: "agent_message_chunk",
							messageId: `said-${++said}`,
							content: { type: "text", text },
						});
						record({ followedUp: text });
						state(sessionId, "idle", "end_turn");
					},
					Number(process.env.FAKE_ACP_FOLLOW_MS ?? 1500),
				);
			}, ms);
		} else if (v2 && verb === "task") {
			background(sessionId, "_claude/task", Number(rest[0] ?? 0));
		} else if (v2 && verb === "withdraw") {
			const command = rest.slice(1).join(" ");
			const request = nextRequest++;
			asked.set(request, () => {});
			send({
				id: request,
				method: "session/request_permission",
				params: {
					sessionId,
					title: command,
					subject: {
						type: "tool_call",
						toolCall: { toolCallId: `call-${++call}`, kind: "execute", rawInput: { command } },
					},
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "reject", name: "Reject", kind: "reject_once" },
					],
				},
			});
			await sleep(Number(rest[0] ?? 0), sessionId);
			asked.delete(request);
			send({ method: "$/cancel_request", params: { requestId: request } });
			record({ withdrew: command });
		} else if (v2 && verb === "bgask") {
			const command = rest.slice(1).join(" ");
			background(sessionId, "terminal", Number(rest[0] ?? 0), async () => {
				// asked by background work, while the turn may be long over
				const answer = await permission(sessionId, `call-${++call}`, command, [
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
					{ optionId: "reject", name: "Reject", kind: "reject_once" },
				]);
				record({ permission: command, answer: answer.outcome, background: true });
			});
		} else if (line !== "") {
			update(sessionId, {
				sessionUpdate: "agent_message_chunk",
				...(v2 ? { messageId: `said-${++said}` } : {}),
				content: { type: "text", text: line },
			});
		}
	}
	return cancelled.has(sessionId) ? "cancelled" : "end_turn";
}

// as claude-agent-acp: its client gone, it exits (what it started may not)
process.stdin.on("end", () => process.exit(0));
jsonLines(process.stdin, (line) => {
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
			if (V2 !== undefined && Number(params.protocolVersion) >= 2) {
				v2 = true;
				return send({
					id: message.id,
					result: {
						protocolVersion: 2,
						info: { name: "fake", version: "0" },
						capabilities: { session: process.env.FAKE_ACP_SYSTEM === "1" ? { systemPrompt: {} } : {} },
					},
				});
			}
			// FAKE_ACP_NO_LOAD=1: a harness that cannot reopen a session (as banda's pi adapter). FAKE_ACP_RESUME,
			// FAKE_ACP_CLOSE and FAKE_ACP_SYSTEM (=1) announce the matching sessionCapabilities.
			return send({
				id: message.id,
				result: {
					protocolVersion: 1,
					agentCapabilities: {
						loadSession: process.env.FAKE_ACP_NO_LOAD !== "1",
						sessionCapabilities: {
							...(process.env.FAKE_ACP_RESUME === "1" ? { resume: {} } : {}),
							...(process.env.FAKE_ACP_CLOSE === "1" ? { close: {} } : {}),
							...(process.env.FAKE_ACP_SYSTEM === "1" ? { systemPrompt: {} } : {}),
						},
					},
				},
			});
		case "session/new": {
			// a harness that never opens a session (not signed in, waiting on a prompt of its own)
			if (process.env.FAKE_ACP_HANG === "1") return;
			const sessionId = `fake-${process.pid}-${sessions.size + 1}`;
			sessions.add(sessionId);
			record({ made: sessionId, ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }) });
			if (v2)
				return send({
					id: message.id,
					result: {
						sessionId,
						...(process.env.FAKE_ACP_NO_MODE === "1"
							? {}
							: {
									configOptions: [
										{
											configId: "mode",
											name: "Mode",
											category: "mode",
											type: "select",
											currentValue: "default",
											options: [
												{ value: "default", name: "Default" },
												{ value: "acceptEdits", name: "Accept edits" },
											],
										},
									],
								}),
					},
				});
			return send({ id: message.id, result: { sessionId, modes: { currentModeId: "auto", availableModes: [] } } });
		}
		case "session/resume": {
			if (process.env.FAKE_ACP_REFUSE_REOPEN === "1")
				return send({ id: message.id, error: { code: -32002, message: "no such session" } });
			// the session again, nothing replayed (unlike session/load)
			const sessionId = String(params.sessionId);
			sessions.add(sessionId);
			record({
				resumed: sessionId,
				...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
			});
			return send({ id: message.id, result: {} });
		}
		case "session/close": {
			const sessionId = String(params.sessionId);
			if (!sessions.has(sessionId))
				return send({ id: message.id, error: { code: -32002, message: "no such session" } });
			sessions.delete(sessionId);
			for (const item of [...items]) item.end();
			record({ closed: sessionId });
			return send({ id: message.id, result: {} });
		}
		case "session/load": {
			if (process.env.FAKE_ACP_REFUSE_REOPEN === "1")
				return send({ id: message.id, error: { code: -32002, message: "no such session" } });
			const sessionId = String(params.sessionId);
			sessions.add(sessionId);
			record({
				loaded: sessionId,
				...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
			});
			// as claude-agent-acp and codex-acp do: the session's history replayed as updates before the answer
			update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "words from before" } });
			update(sessionId, {
				sessionUpdate: "tool_call",
				toolCallId: "before-1",
				title: "Read old.txt",
				kind: "read",
				status: "completed",
				locations: [{ path: "old.txt" }],
			});
			return send({ id: message.id, result: {} });
		}
		case "session/set_config_option":
			mode = String(params.value);
			record({ mode });
			return send({ id: message.id, result: {} });
		case "terminal/cancel":
		case "tool_call/cancel": {
			const target = String(params.terminalId ?? params.toolCallId);
			const item = items.find((one) => one.id === target);
			record({ cancelItem: target, listed: item !== undefined });
			// one that ended meanwhile: invalid params, as the adapter answers the race
			if (item === undefined) return send({ id: message.id, error: { code: -32602, message: "not running" } });
			item.end();
			return send({ id: message.id, result: {} });
		}
		case "session/set_mode":
			mode = String(params.modeId);
			record({ mode });
			return send({ id: message.id, result: {} });
		case "session/prompt": {
			const sessionId = String(params.sessionId);
			const text = ((params.prompt as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("\n");
			record({ prompt: text, sessionId });
			const id = message.id;
			if (v2) {
				const withdrawn = cancels;
				queue = queue.then(async () => {
					// a cancel while it waited withdrew it before it was taken in
					if (cancels !== withdrawn) {
						record({ refused: text });
						send({ id, error: { code: -32800, message: "cancelled before it was taken in" } });
						return;
					}
					cancelled.delete(sessionId);
					const messageId = `user-${id}`;
					update(sessionId, { sessionUpdate: "user_message", messageId, content: params.prompt });
					send({ id, result: { messageId } });
					state(sessionId, "running");
					const stopReason = await run(sessionId, text);
					record({ ended: stopReason, sessionId });
					state(sessionId, "idle", stopReason);
				});
				return;
			}
			queue = queue.then(async () => {
				cancelled.delete(sessionId);
				const stopReason = await run(sessionId, text);
				record({ ended: stopReason, sessionId });
				send({ id, result: { stopReason } });
			});
			return;
		}
		case "session/cancel": {
			if (process.env.FAKE_ACP_WEDGE === "1") return;
			const sessionId = String(params.sessionId);
			cancels++;
			record({ cancel: sessionId });
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
