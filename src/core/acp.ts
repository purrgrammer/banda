/**
 * An ACP client (agentclientprotocol.com): newline-delimited JSON-RPC 2.0 over a harness's stdio, both ways. The daemon
 * is the client; the harness (claude-agent-acp) is the agent. It runs in its own process group, killed whole on close,
 * so nothing it started outlives the session. Requests the harness makes of the client (a permission to ask the owner)
 * are answered by the handlers; any other is refused, since the client offers no files or terminals of its own.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { permissionOf } from "./acp-v2.ts";

/** What one message may weigh: a larger one is a broken harness, and the connection ends. */
export const ACP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** How long a closing harness gets to exit after SIGTERM before its group is killed. */
const GRACE_MS = 2_000;

export type AcpUpdate = { readonly sessionUpdate: string; readonly [field: string]: unknown };
export type AcpPermissionOption = { readonly optionId: string; readonly name: string; readonly kind: string };
export type AcpPermissionRequest = {
	readonly sessionId: string;
	readonly toolCall: {
		readonly toolCallId: string;
		readonly title?: string;
		readonly rawInput?: unknown;
		readonly kind?: string;
	};
	readonly options: readonly AcpPermissionOption[];
};
/** The owner's answer: one of the request's options, or none (Stop, or the session ended). */
export type AcpPermissionOutcome =
	| { readonly outcome: "selected"; readonly optionId: string }
	| { readonly outcome: "cancelled" };

export type AcpHandlers = {
	/** A `session/update` notification. */
	readonly update: (sessionId: string, update: AcpUpdate) => void;
	/**
	 * A `session/request_permission` request; the harness waits for the answer, however long, unless it withdraws it
	 * (`$/cancel_request`: its tool stopped on its own), when `withdrawn` aborts and the ask is answered as cancelled.
	 */
	readonly permission: (request: AcpPermissionRequest, withdrawn: AbortSignal) => Promise<AcpPermissionOutcome>;
};

export type AcpStart = {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly handlers: AcpHandlers;
	/** What it says on stderr, a line at a time, for the daemon's log. */
	readonly log?: (line: string) => void;
};

export class AcpError extends Error {
	readonly code: number | undefined;
	readonly data: unknown;
	constructor(message: string, code?: number, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export type AcpConnection = {
	/** The harness's process id, its group's too. */
	readonly pid: number | undefined;
	/**
	 * A request, answered as a promise. `answered`, when given, is called with the answer as the line that carries it is
	 * read, in the stream's own order: a promise settles a microtask later, after the lines read with it, so what must
	 * hold in the order the agent sent it (v2: a prompt taken in, then its turn's states) goes through it.
	 */
	readonly request: <T = unknown>(
		method: string,
		params: unknown,
		answered?: (answer: { readonly result: unknown } | { readonly error: AcpError }) => void,
	) => Promise<T>;
	readonly notify: (method: string, params: unknown) => void;
	/** End it: SIGTERM to its group, SIGKILL after a grace. Resolves once it exited. */
	readonly close: () => Promise<void>;
	/** Settles when the harness exits, by itself or closed; every request still waiting is refused then. */
	readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
};

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	answered?: ((answer: { readonly result: unknown } | { readonly error: AcpError }) => void) | undefined;
};

/** Start a harness and speak ACP with it. The caller sends `initialize` first. */
export function startAcp(start: AcpStart): AcpConnection {
	const child: ChildProcess = spawn(start.command, [...(start.args ?? [])], {
		cwd: start.cwd,
		env: start.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const pending = new Map<number, Pending>();
	// the requests the harness made of this side and waits on, by its id: what `$/cancel_request` withdraws
	const inbound = new Map<number | string, AbortController>();
	let next = 1;
	let ended = false;
	const write = (message: object) => {
		if (ended || child.stdin === null || child.stdin.destroyed) return;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};
	const killGroup = (signal: NodeJS.Signals) => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			// already gone
		}
	};
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (ended) return;
			ended = true;
			// whatever it started dies with it
			killGroup("SIGKILL");
			for (const [, waiting] of pending) {
				const error = new AcpError("the coding agent ended");
				waiting.answered?.({ error });
				waiting.reject(error);
			}
			pending.clear();
			resolve({ code, signal });
		};
		child.on("exit", finish);
		child.on("error", (error) => {
			start.log?.(`acp: ${error.message}`);
			finish(null, null);
		});
	});
	child.stdin?.on("error", () => {});
	// a harness is another program: nothing it sends, and nothing a handler makes of it, may reach the stream's event,
	// where a throw is uncaught and takes the daemon with it. What could not be taken is dropped and said.
	const guarded = (take: (line: string) => void) => (line: string) => {
		try {
			take(line);
		} catch (error) {
			try {
				start.log?.(`acp: a line it could not take: ${(error as Error).message}`);
			} catch {
				// the log itself failed: nothing is left to tell
			}
		}
	};
	if (child.stderr !== null)
		jsonLines(
			child.stderr,
			guarded((line) => start.log?.(line)),
		);
	if (child.stdout !== null)
		jsonLines(
			child.stdout,
			guarded((line) => {
				let message: {
					id?: number | string;
					method?: string;
					params?: unknown;
					result?: unknown;
					error?: { code?: number; message?: string; data?: unknown };
				};
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					start.log?.(`acp: not JSON: ${line.slice(0, 200)}`);
					return;
				}
				if (message.method === undefined) {
					const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
					if (waiting === undefined) return;
					pending.delete(message.id as number);
					// `"error": null` beside a result is how some JSON-RPC peers say there was none
					if (message.error !== undefined && message.error !== null) {
						const error = new AcpError(
							message.error.message ?? "the coding agent refused",
							message.error.code,
							message.error.data,
						);
						waiting.answered?.({ error });
						waiting.reject(error);
					} else {
						waiting.answered?.({ result: message.result });
						waiting.resolve(message.result);
					}
					return;
				}
				if (message.method === "session/update") {
					const params = message.params as { sessionId?: string; update?: AcpUpdate } | undefined;
					if (typeof params?.sessionId === "string" && typeof params.update?.sessionUpdate === "string")
						start.handlers.update(params.sessionId, params.update);
					return;
				}
				if (message.method === "$/cancel_request") {
					const withdrawn = (message.params as { requestId?: unknown } | undefined)?.requestId;
					if (typeof withdrawn === "number" || typeof withdrawn === "string") inbound.get(withdrawn)?.abort();
					return;
				}
				if (message.id === undefined) return; // a notification the client has no use for
				const id = message.id;
				if (message.method === "session/request_permission") {
					// in a promise, so a handler that throws at once is answered as one that rejects: the harness never waits on it.
					// A v2 request names its tool call as its subject: read as v1's shape, the same either way
					const withdrawn = new AbortController();
					inbound.set(id, withdrawn);
					new Promise<AcpPermissionOutcome>((resolve) =>
						resolve(
							start.handlers.permission(permissionOf(message.params, `permission-${String(id)}`), withdrawn.signal),
						),
					)
						.then(
							(outcome) => write({ id, result: { outcome } }),
							() => write({ id, result: { outcome: { outcome: "cancelled" } } }),
						)
						.finally(() => inbound.delete(id));
					return;
				}
				write({ id, error: { code: -32601, message: `${message.method} is not offered` } });
			}),
			{
				over: () => {
					start.log?.("acp: a message over the limit; ending the harness");
					killGroup("SIGKILL");
				},
			},
		);
	return {
		pid: child.pid,
		request: <T>(
			method: string,
			params: unknown,
			answered?: (answer: { readonly result: unknown } | { readonly error: AcpError }) => void,
		) =>
			new Promise<T>((resolve, reject) => {
				if (ended) {
					const error = new AcpError("the coding agent ended");
					answered?.({ error });
					return reject(error);
				}
				const id = next++;
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject, answered });
				write({ id, method, params });
			}),
		notify: (method, params) => write({ method, params }),
		close: async () => {
			if (ended) return;
			child.stdin?.end();
			killGroup("SIGTERM");
			const timer = setTimeout(() => killGroup("SIGKILL"), GRACE_MS);
			await exited;
			clearTimeout(timer);
		},
		exited,
	};
}

/**
 * Each line of `stream`, split on LF alone (a trailing CR dropped): JSON strings may hold U+2028 and U+2029, which
 * Node's readline would split on. A line over `max` bytes is passed to `over` and dropped.
 */
export function jsonLines(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
	{ max = ACP_MAX_MESSAGE_BYTES, over }: { max?: number; over?: () => void } = {},
): void {
	let buffer = "";
	let dropping = false;
	stream.setEncoding?.("utf8");
	stream.on("data", (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at).replace(/\r$/, "");
			buffer = buffer.slice(at + 1);
			if (dropping) dropping = false;
			else if (Buffer.byteLength(line) > max) over?.();
			else if (line !== "") onLine(line);
		}
		if (Buffer.byteLength(buffer) > max) {
			buffer = "";
			dropping = true;
			over?.();
		}
	});
}

/**
 * The protocol versions this client speaks: it asks for the newest, and speaks v1 to an agent that answers 1. Only v2
 * reports work that goes on after a turn (`state_update`'s `background`), so a v2 agent is spoken to in v2.
 */
export const ACP_PROTOCOL_VERSION = 2;
export const ACP_PROTOCOL_VERSIONS: readonly number[] = [1, 2];

/** A capability an agent announces by an object (ACP: `{}` means offered; omitted or `null` means not). */
const offered = (capability: unknown): boolean => typeof capability === "object" && capability !== null;

/** ACP's "resource not found": a session already gone is as closed as one the agent just let go. */
const NOT_FOUND = -32002;
/** JSON-RPC "request cancelled": v2's answer to a prompt that a cancel withdrew before the agent took it in. */
export const REQUEST_CANCELLED = -32800;

export type OpenedSession = {
	readonly sessionId: string;
	/** The protocol the agent answered with: 2 reports foreground and background state, 1 only ends turns. */
	readonly protocol: 1 | 2;
	/** The harness reopened its own session (`session/resume` or `session/load`), so it remembers. */
	readonly loaded: boolean;
	/** The agent takes `session/close` when the session ends: announced in v1, the baseline in v2. */
	readonly canClose: boolean;
};

type ConfigOption = {
	configId?: unknown;
	id?: unknown;
	category?: unknown;
	type?: unknown;
	options?: unknown;
};

/** The values a select option offers, flat (v2 may group them). */
const valuesOf = (options: unknown): string[] =>
	Array.isArray(options)
		? (options as { value?: unknown; options?: unknown }[]).flatMap((one) =>
				typeof one.value === "string" ? [one.value] : valuesOf(one.options),
			)
		: [];

/**
 * Initialize, then open a session in `cwd` (reopening `resume` with no history replayed when the agent can, else by
 * `session/load`; a new session when it refuses), then set its mode. `system` is banda's own instructions, appended to
 * the agent's (never replacing them: mode `override` is never used) when it announces a `systemPrompt` capability; an
 * agent that does not is opened exactly as before, the instructions left unsent.
 *
 * The `initialize` asks for v2 and carries v1's fields beside v2's, so an agent that only speaks v1 reads it as its
 * own and answers 1. In v2, `session/resume` and `session/close` are the baseline (no capability announces them),
 * `session/resume` without `replayFrom` replays nothing, and the mode is the session's `mode` config option, which
 * must offer `mode`: one that does not stops the session before anything is sent.
 */
export async function openSession(
	connection: AcpConnection,
	{
		cwd,
		mode,
		resume,
		system,
	}: { cwd: string; mode?: string | undefined; resume?: string | undefined; system?: string | undefined },
): Promise<OpenedSession> {
	const info = { name: "banda", version: "0" };
	const init = await connection.request<{
		protocolVersion?: number;
		agentCapabilities?: {
			loadSession?: boolean;
			sessionCapabilities?: { resume?: unknown; close?: unknown; systemPrompt?: unknown };
		};
		capabilities?: { session?: { systemPrompt?: unknown } | null } | null;
	}>("initialize", {
		protocolVersion: ACP_PROTOCOL_VERSION,
		// v2's fields: no client file system or terminals exist in v2
		info,
		capabilities: {},
		// v1's fields, for an agent that answers 1
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: info,
	});
	if (init.protocolVersion !== 1 && init.protocolVersion !== 2)
		throw new AcpError("The coding agent does not support the required ACP protocol version.");
	const protocol = init.protocolVersion;
	const v1 = init.agentCapabilities?.sessionCapabilities ?? {};
	const systemOffered = protocol === 2 ? offered(init.capabilities?.session?.systemPrompt) : offered(v1.systemPrompt);
	const instructed =
		system === undefined || !systemOffered
			? {}
			: { systemPrompt: { mode: "append", content: [{ type: "text", text: system }] } };
	// the same session again: by session/resume, nothing replayed since what it did before is already this side's
	// record, else by session/load
	const reopen =
		resume === undefined
			? undefined
			: protocol === 2 || offered(v1.resume)
				? "session/resume"
				: init.agentCapabilities?.loadSession === true
					? "session/load"
					: undefined;
	let loaded = false;
	let options: unknown;
	if (reopen !== undefined) {
		try {
			const reopened = await connection.request<{ configOptions?: unknown } | null>(reopen, {
				sessionId: resume,
				cwd,
				mcpServers: [],
				...instructed,
			});
			options = reopened?.configOptions;
			loaded = true;
		} catch (error) {
			// it answered that it will not (the session is gone, or not its to reopen): a new one, told what the old did.
			// One that never answered, because it died, has no new session to give
			if (!(error instanceof AcpError) || error.code === undefined) throw error;
		}
	}
	let sessionId = loaded ? resume : undefined;
	if (!loaded) {
		const made = await connection.request<{ sessionId: string; configOptions?: unknown }>("session/new", {
			cwd,
			mcpServers: [],
			...instructed,
		});
		sessionId = made?.sessionId;
		options = made?.configOptions;
	}
	// everything after this names the session: a harness that named none has none to prompt, or to stop
	if (typeof sessionId !== "string" || sessionId === "")
		throw new AcpError("The coding agent did not name its session.");
	// the harness starts in the owner's own default (which may ask nothing): the connection's mode is set, always
	if (mode !== undefined) {
		if (protocol === 1) await connection.request("session/set_mode", { sessionId, modeId: mode });
		else {
			const option = (Array.isArray(options) ? (options as ConfigOption[]) : []).find(
				(one) => one.category === "mode" || one.configId === "mode",
			);
			if (option === undefined || typeof option.configId !== "string" || !valuesOf(option.options).includes(mode))
				throw new AcpError(`The coding agent does not offer the ${mode} mode banda sets, so nothing was sent.`);
			await connection.request("session/set_config_option", {
				sessionId,
				configId: option.configId,
				type: "id",
				value: mode,
			});
		}
	}
	return { sessionId, protocol, loaded, canClose: protocol === 2 || offered(v1.close) };
}

/**
 * Tell the agent its session is over (`session/close`, for one that announced it); a session it no longer has
 * (-32002) is as closed. The process is still ended and its group killed after, whatever this says.
 */
export async function closeSession(connection: AcpConnection, sessionId: string): Promise<void> {
	try {
		await connection.request("session/close", { sessionId });
	} catch (error) {
		if (error instanceof AcpError && error.code === NOT_FOUND) return;
		throw error;
	}
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;

/**
 * Send one prompt. In v1 it resolves when the harness ends that turn, with its stop reason; in v2 once the harness took
 * it in, with the message it became, the turn reported apart (`state_update`). A prompt sent mid-turn is queued by the
 * harness, or taken into the turn.
 */
export function prompt(
	connection: AcpConnection,
	sessionId: string,
	text: string,
	answered?: (answer: { readonly stopReason?: AcpStopReason; readonly messageId?: string } | AcpError) => void,
): Promise<{ stopReason?: AcpStopReason; messageId?: string }> {
	const read = (answer: unknown) => {
		const { stopReason, messageId } = (answer ?? {}) as { stopReason?: unknown; messageId?: unknown };
		return {
			...(typeof stopReason === "string" ? { stopReason } : {}),
			...(typeof messageId === "string" ? { messageId } : {}),
		};
	};
	// `answered` takes the answer as it is read, before the lines after it: v2's states for the turn it starts follow it
	return connection
		.request(
			"session/prompt",
			{ sessionId, prompt: [{ type: "text", text }] },
			answered === undefined ? undefined : (answer) => answered("error" in answer ? answer.error : read(answer.result)),
		)
		.then(read);
}

/** Ask the harness to stop its turn (v1), or a session's foreground work (v2: a subagent's when it is its session). */
export function cancel(connection: AcpConnection, sessionId: string): void {
	connection.notify("session/cancel", { sessionId });
}

/**
 * Stop one piece of work a v2 list names: a terminal by `terminal/cancel`, a tool call by `tool_call/cancel`, a subagent
 * by `session/cancel` on its own session. Another kind has no method of its own: `session/close` ends it. An item that
 * ended meanwhile is refused (invalid params): that refusal is the race, and resolves as well.
 */
export async function cancelItem(
	connection: AcpConnection,
	item: { readonly type: string; readonly id: string; readonly session: string },
): Promise<void> {
	if (item.type === "subagent") return cancel(connection, item.id);
	const method =
		item.type === "terminal" ? "terminal/cancel" : item.type === "tool_call" ? "tool_call/cancel" : undefined;
	if (method === undefined) return;
	const target = item.type === "terminal" ? { terminalId: item.id } : { toolCallId: item.id };
	await connection.request(method, { sessionId: item.session, ...target }).catch(() => {});
}
