/**
 * An ACP client (agentclientprotocol.com): newline-delimited JSON-RPC 2.0 over a harness's stdio, both ways. The daemon
 * is the client; the harness (claude-agent-acp) is the agent. It runs in its own process group, killed whole on close,
 * so nothing it started outlives the session. Requests the harness makes of the client (a permission to ask the owner)
 * are answered by the handlers; any other is refused, since the client offers no files or terminals of its own.
 */
import { type ChildProcess, spawn } from "node:child_process";

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
	/** A `session/request_permission` request; the harness waits for the answer, however long. */
	readonly permission: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
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
	readonly request: <T = unknown>(method: string, params: unknown) => Promise<T>;
	readonly notify: (method: string, params: unknown) => void;
	/** End it: SIGTERM to its group, SIGKILL after a grace. Resolves once it exited. */
	readonly close: () => Promise<void>;
	/** Settles when the harness exits, by itself or closed; every request still waiting is refused then. */
	readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Start a harness and speak ACP with it. The caller sends `initialize` first. */
export function startAcp(start: AcpStart): AcpConnection {
	const child: ChildProcess = spawn(start.command, [...(start.args ?? [])], {
		cwd: start.cwd,
		env: start.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const pending = new Map<number, Pending>();
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
			for (const [, waiting] of pending) waiting.reject(new AcpError("the harness ended"));
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
	if (child.stderr !== null) jsonLines(child.stderr, (line) => start.log?.(line));
	if (child.stdout !== null)
		jsonLines(
			child.stdout,
			(line) => {
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
					if (message.error !== undefined)
						waiting.reject(
							new AcpError(message.error.message ?? "the harness refused", message.error.code, message.error.data),
						);
					else waiting.resolve(message.result);
					return;
				}
				if (message.method === "session/update") {
					const params = message.params as { sessionId?: string; update?: AcpUpdate } | undefined;
					if (typeof params?.sessionId === "string" && typeof params.update?.sessionUpdate === "string")
						start.handlers.update(params.sessionId, params.update);
					return;
				}
				if (message.id === undefined) return; // a notification the client has no use for
				const id = message.id;
				if (message.method === "session/request_permission") {
					start.handlers.permission(message.params as AcpPermissionRequest).then(
						(outcome) => write({ id, result: { outcome } }),
						() => write({ id, result: { outcome: { outcome: "cancelled" } } }),
					);
					return;
				}
				write({ id, error: { code: -32601, message: `${message.method} is not offered` } });
			},
			{
				over: () => {
					start.log?.("acp: a message over the limit; ending the harness");
					killGroup("SIGKILL");
				},
			},
		);
	return {
		pid: child.pid,
		request: <T>(method: string, params: unknown) =>
			new Promise<T>((resolve, reject) => {
				if (ended) return reject(new AcpError("the harness ended"));
				const id = next++;
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
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

/** The protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** Initialize, then open a session in `cwd` (or load `resume`), then set its mode. Returns the session's id. */
export async function openSession(
	connection: AcpConnection,
	{ cwd, mode, resume }: { cwd: string; mode?: string | undefined; resume?: string | undefined },
): Promise<{ readonly sessionId: string; readonly loaded: boolean }> {
	const init = await connection.request<{ protocolVersion?: number; agentCapabilities?: { loadSession?: boolean } }>(
		"initialize",
		{
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "banda", version: "0" },
		},
	);
	if (init.protocolVersion !== ACP_PROTOCOL_VERSION)
		throw new AcpError("The harness does not support the required ACP protocol version.");
	let sessionId: string;
	let loaded = false;
	if (resume !== undefined && init.agentCapabilities?.loadSession === true) {
		await connection.request("session/load", { sessionId: resume, cwd, mcpServers: [] });
		sessionId = resume;
		loaded = true;
	} else {
		const made = await connection.request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] });
		sessionId = made.sessionId;
	}
	// the harness starts in the owner's own default (which may ask nothing): the connection's mode is set, always
	if (mode !== undefined) await connection.request("session/set_mode", { sessionId, modeId: mode });
	return { sessionId, loaded };
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;

/** Send one prompt; resolves when the harness ends that turn. A prompt sent mid-turn is queued by the harness. */
export function prompt(
	connection: AcpConnection,
	sessionId: string,
	text: string,
): Promise<{ stopReason: AcpStopReason }> {
	return connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}

/** Ask the harness to stop its turn; the pending prompt then ends with `cancelled`. */
export function cancel(connection: AcpConnection, sessionId: string): void {
	connection.notify("session/cancel", { sessionId });
}
