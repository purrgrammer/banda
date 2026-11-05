/**
 * banda's ACP adapter for pi (`pi --mode rpc`): run as a harness, it speaks ACP to banda on stdio and pi's RPC to one pi
 * per session, started in the session's folder. pi's text and thinking stream as message and thought chunks, its tool
 * runs as tool calls; a prompt sent while pi works is pi's own steer, taken after its current tool calls, and every
 * prompt of a run ends with it. Cancel is pi's abort. pi asks nothing of its own: its extensions' dialogs (confirm,
 * select) become permission requests, the only asks that reach the owner. pi's output is split on LF alone (its JSON
 * may hold U+2028), as its RPC docs require.
 *
 * argv: the pi command and its arguments, `--mode rpc` added; default `pi`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { jsonLines } from "../core/acp.ts";

const [command = "pi", ...args] = process.argv.slice(2);

type Rpc = { type: string; id?: string; [field: string]: unknown };
type Pending = { id: number | string; cancelled: boolean };
type Session = { pi: ChildProcess; running: boolean; prompts: Pending[]; cancelled: boolean; requests: number };

const sessions = new Map<string, Session>();
let next = 1;
const waiting = new Map<number, (result: unknown) => void>();

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId: string, value: object) =>
	send({ method: "session/update", params: { sessionId, update: value } });
const request = (method: string, params: unknown) =>
	new Promise<unknown>((resolve) => {
		const id = next++;
		waiting.set(id, resolve);
		send({ id, method, params });
	});

/** What kind of call a pi tool is, as ACP names them. */
const kindOf = (tool: string) =>
	tool === "bash"
		? "execute"
		: tool === "edit" || tool === "write"
			? "edit"
			: tool === "read" || tool === "ls" || tool === "grep" || tool === "find"
				? "read"
				: "other";

/** A pi tool's arguments as ACP's raw input: a command, or the file it touches. */
function inputOf(tool: string, given: unknown): { [key: string]: unknown } {
	const raw = (given ?? {}) as { command?: unknown; path?: unknown; file_path?: unknown };
	const path = typeof raw.path === "string" ? raw.path : typeof raw.file_path === "string" ? raw.file_path : undefined;
	return tool === "bash" ? { command: raw.command } : path === undefined ? { ...raw } : { ...raw, file_path: path };
}

const textOf = (result: unknown) =>
	(
		((result as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? []) as {
			type?: string;
			text?: string;
		}[]
	)
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");

/** Every prompt of the run that ended answers now: they went into it as one. */
function settle(session: Session) {
	session.running = false;
	for (const pending of session.prompts.splice(0))
		send({ id: pending.id, result: { stopReason: session.cancelled || pending.cancelled ? "cancelled" : "end_turn" } });
	session.cancelled = false;
}

function start(sessionId: string, cwd: string): Session {
	const pi = spawn(command, [...args, "--mode", "rpc"], { cwd, stdio: ["pipe", "pipe", "inherit"] });
	const session: Session = { pi, running: false, prompts: [], cancelled: false, requests: 0 };
	const toPi = (message: Rpc) => pi.stdin?.write(`${JSON.stringify(message)}\n`);
	pi.on("exit", () => {
		for (const pending of session.prompts.splice(0))
			send({ id: pending.id, error: { code: -32000, message: "pi ended" } });
		sessions.delete(sessionId);
	});
	if (pi.stdout !== null)
		jsonLines(pi.stdout, (line) => {
			let event: Rpc;
			try {
				event = JSON.parse(line) as Rpc;
			} catch {
				return;
			}
			if (event.type === "response") {
				if (event.success === false && event.command === "prompt") {
					process.stderr.write(`pi refused a prompt: ${String(event.error ?? "")}\n`);
					settle(session);
				}
				return;
			}
			if (event.type === "message_end") {
				// a run pi could not make (its provider refused, a limit) says why, rather than ending empty
				const ended = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
				if (ended?.role === "assistant" && ended.stopReason === "error")
					update(sessionId, {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `pi stopped: ${ended.errorMessage ?? "its model answered with an error"}` },
					});
			}
			if (event.type === "agent_start") session.running = true;
			else if (event.type === "agent_end") settle(session);
			else if (event.type === "message_update") {
				const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (delta?.type === "text_delta" && delta.delta)
					update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.delta } });
				else if (delta?.type === "thinking_delta" && delta.delta)
					update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.delta } });
			} else if (event.type === "tool_execution_start") {
				const tool = String(event.toolName ?? "tool");
				const input = inputOf(tool, event.args);
				update(sessionId, {
					sessionUpdate: "tool_call",
					toolCallId: String(event.toolCallId),
					title:
						typeof input.command === "string"
							? input.command
							: typeof input.file_path === "string"
								? `${tool} ${input.file_path}`
								: tool,
					kind: kindOf(tool),
					status: "in_progress",
					rawInput: input,
					...(typeof input.file_path === "string" ? { locations: [{ path: input.file_path }] } : {}),
				});
			} else if (event.type === "tool_execution_end") {
				const text = textOf(event.result);
				update(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: String(event.toolCallId),
					status: event.isError === true ? "failed" : "completed",
					...(text === "" ? {} : { content: [{ type: "content", content: { type: "text", text } }] }),
				});
			} else if (event.type === "extension_ui_request") {
				const method = String(event.method);
				const id = String(event.id);
				if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor") return;
				if (method === "input" || method === "editor") {
					toPi({ type: "extension_ui_response", id, cancelled: true });
					return;
				}
				// a dialog of pi's extensions: the owner's to answer, as the harness's own ask
				const options = (event.options as string[] | undefined) ?? [];
				const title = [event.title, event.message].filter((part) => typeof part === "string" && part !== "").join(": ");
				void request("session/request_permission", {
					sessionId,
					toolCall: {
						toolCallId: `pi-ui-${id}`,
						title: title || "pi asks",
						kind: "other",
						rawInput: { command: title || "pi asks" },
					},
					options: [
						{ optionId: "allow", name: method === "select" ? (options[0] ?? "Allow") : "Allow", kind: "allow_once" },
						{ optionId: "reject", name: "Don't", kind: "reject_once" },
					],
				}).then((answer) => {
					const chosen = (answer as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
					const allow = chosen?.outcome === "selected" && chosen.optionId === "allow";
					if (method === "confirm") toPi({ type: "extension_ui_response", id, confirmed: allow });
					else if (allow && options[0] !== undefined) toPi({ type: "extension_ui_response", id, value: options[0] });
					else toPi({ type: "extension_ui_response", id, cancelled: true });
				});
			}
		});
	sessions.set(sessionId, session);
	return session;
}

process.stdin.on("end", () => {
	for (const session of sessions.values()) session.pi.kill("SIGTERM");
	process.exit(0);
});

jsonLines(process.stdin, (line) => {
	const message = JSON.parse(line) as {
		id?: number | string;
		method?: string;
		params?: { [key: string]: unknown };
		result?: unknown;
	};
	if (message.method === undefined) {
		if (typeof message.id === "number") {
			waiting.get(message.id)?.(message.result);
			waiting.delete(message.id);
		}
		return;
	}
	const params = message.params ?? {};
	const reply = (result: unknown) => send({ id: message.id, result });
	switch (message.method) {
		case "initialize":
			return reply({
				protocolVersion: 1,
				agentCapabilities: { loadSession: false },
				agentInfo: { name: "pi (banda)" },
			});
		case "session/new": {
			const sessionId = randomUUID();
			start(sessionId, String(params.cwd ?? process.cwd()));
			return reply({ sessionId });
		}
		case "session/set_mode":
			return reply({});
		case "session/prompt": {
			const session = sessions.get(String(params.sessionId));
			if (session === undefined) return send({ id: message.id, error: { code: -32602, message: "no such session" } });
			const text = ((params.prompt as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("\n");
			const toPi = (rpc: Rpc) => session.pi.stdin?.write(`${JSON.stringify(rpc)}\n`);
			session.prompts.push({ id: message.id ?? 0, cancelled: false });
			// while pi works, a prompt is its steer: after its current tool calls, in the same run
			toPi(
				session.running
					? { type: "prompt", id: `p${session.requests++}`, message: text, streamingBehavior: "steer" }
					: { type: "prompt", id: `p${session.requests++}`, message: text },
			);
			session.running = true;
			return;
		}
		case "session/cancel": {
			const session = sessions.get(String(params.sessionId));
			if (session === undefined) return;
			session.cancelled = true;
			session.pi.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
			return;
		}
		default:
			if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "not offered" } });
	}
});
