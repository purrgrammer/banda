/**
 * A small MCP bridge (DESIGN.md "Connections") for a server the agent built in its box over stdio. Remote MCP
 * uses pi-mcp in mcp-remote.ts; the box uses pi-env and cannot run an agent-written server in the daemon.
 *
 * Each box exchange initializes a new server. What a server answers is data: shapes are checked, sizes cut, and
 * nothing in it is run by the daemon.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export const PROTOCOL_VERSION = "2025-06-18";

/** A tool as a server lists it: its name, its words for the model, and the JSON schema of its arguments. */
export type McpTool = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: { readonly [key: string]: unknown };
	/** The server's own hints, which banda shows but never trusts for what asks the owner. */
	readonly readOnlyHint?: boolean;
};

/** What a call answered: its text (images and resources said in words), and whether the server called it an error. */
export type McpResult = { readonly text: string; readonly isError: boolean };

/** The server refused the credentials (401): sign in again, or give another key. */
export class Unauthorized extends Error {}

/** What of a server's own notes (its `instructions`) is kept: its words about its tools, bounded. */
export const MAX_NOTES = 4000;

/**
 * A server's notes as kept: what a person reading them would see, and nothing else. Invisible characters (format and
 * private-use characters, which hide text from the owner but not from a model: bidi overrides, zero-width joiners, tag
 * characters) and control characters but line breaks and tabs are dropped, the text normalized (NFKC), `scrub` applied
 * before it is bounded (so no credential is cut in two), then cut to `MAX_NOTES` characters, never inside one.
 * Undefined when nothing is left.
 */
export function notesOf(value: unknown, scrub: (text: string) => string = (text) => text): string | undefined {
	if (typeof value !== "string") return undefined;
	const visible = scrub(value.normalize("NFKC"))
		.replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, "")
		.replace(/[^\P{Cc}\t\n]/gu, "")
		.trim();
	if (visible === "") return undefined;
	const characters = [...visible];
	return characters.length <= MAX_NOTES ? visible : `${characters.slice(0, MAX_NOTES).join("")}…`;
}

/** The server took the credentials, but they lack scopes this call needs (an `insufficient_scope` challenge). */
export class InsufficientScope extends Error {
	readonly scopes: readonly string[];
	constructor(scopes: readonly string[]) {
		super(`it needs ${scopes.length === 0 ? "more access" : scopes.join(", ")}, which the owner has not given banda`);
		this.scopes = scopes;
	}
}

/** The scopes a 403's `WWW-Authenticate` says are missing (RFC 6750), or undefined when it is no scope challenge. */
export function challengedScopes(status: number, header: string | null): readonly string[] | undefined {
	if (status !== 403 || header === null || !/error="insufficient_scope"/.test(header)) return undefined;
	const scope = /(?:^|[\s,])scope="([^"]*)"/.exec(header)?.[1] ?? "";
	return scope
		.split(" ")
		.filter((each) => /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(each))
		.slice(0, 50);
}

/** A tool's name as a server may give it. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** What one answer may weigh, and one result's text. */
const MAX_BODY = 4 * 1024 * 1024;
export const MAX_RESULT_CHARS = 50_000;

/** How the daemon reaches a server: one JSON-RPC request in, its response out. */
export type Transport = (message: JsonRpcRequest, ctx: Context) => Promise<unknown>;

type JsonRpcRequest = {
	readonly jsonrpc: "2.0";
	readonly id?: number;
	readonly method: string;
	readonly params?: { readonly [key: string]: unknown };
};

const initialize = (id: number): JsonRpcRequest => ({
	jsonrpc: "2.0",
	id,
	method: "initialize",
	params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "banda", version: "0.1.0" } },
});

/** The result of a JSON-RPC response, or why there is none. */
function resultOf(response: unknown, id: number): { readonly [key: string]: unknown } {
	const { id: got, result, error } = (response ?? {}) as { id?: unknown; result?: unknown; error?: unknown };
	if (got !== id) throw new Error("the server answered another request");
	if (error !== undefined) {
		const { message } = (error ?? {}) as { message?: unknown };
		throw new Error(typeof message === "string" ? message.slice(0, 300) : "the server refused the request");
	}
	if (typeof result !== "object" || result === null) throw new Error("the server answered nothing");
	return result as { readonly [key: string]: unknown };
}

/** Run one request on a fresh session: initialize, say so, then `method`. Its result. */
async function exchange(
	transport: Transport,
	method: string,
	params: { readonly [key: string]: unknown },
	ctx: Context,
): Promise<{ readonly [key: string]: unknown }> {
	resultOf(await transport(initialize(1), ctx), 1);
	await transport({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx);
	return resultOf(await transport({ jsonrpc: "2.0", id: 2, method, params }, ctx), 2);
}

/** The tools a server lists, every page, those that are malformed left out. */
export async function listTools(transport: Transport, ctx: Context): Promise<McpTool[]> {
	const tools: McpTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const result = await exchange(transport, "tools/list", cursor === undefined ? {} : { cursor }, ctx);
		for (const raw of Array.isArray(result.tools) ? result.tools : []) {
			const tool = toolOf(raw);
			if (tool !== undefined && !tools.some((known) => known.name === tool.name)) tools.push(tool);
		}
		cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
		if (cursor === undefined) break;
	}
	return tools.slice(0, 200);
}

export function toolOf(raw: unknown): McpTool | undefined {
	const { name, description, inputSchema, annotations } = (raw ?? {}) as {
		name?: unknown;
		description?: unknown;
		inputSchema?: unknown;
		annotations?: { readOnlyHint?: unknown };
	};
	if (typeof name !== "string" || !TOOL_NAME.test(name)) return undefined;
	const schema =
		typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)
			? (inputSchema as { [key: string]: unknown })
			: { type: "object", properties: {} };
	if (schema.type !== "object") return undefined;
	return {
		name,
		description: typeof description === "string" ? description.slice(0, 2000) : "",
		inputSchema: schema,
		...(typeof annotations?.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
	};
}

/** Call tool `name` with `args`: its content as text. */
export async function callTool(
	transport: Transport,
	name: string,
	args: { readonly [key: string]: unknown },
	ctx: Context,
): Promise<McpResult> {
	const result = await exchange(transport, "tools/call", { name, arguments: args }, ctx);
	return resultText(result);
}

/** Bounded foreign tool output, also used by the pi-mcp remote client. */
export function resultText(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): McpResult {
	const parts: string[] = [];
	for (const block of Array.isArray(result.content) ? result.content : []) {
		const { type, text, mimeType, resource } = (block ?? {}) as {
			type?: unknown;
			text?: unknown;
			mimeType?: unknown;
			resource?: { uri?: unknown; text?: unknown };
		};
		if (type === "text" && typeof text === "string") parts.push(text);
		else if (type === "resource" && typeof resource?.text === "string") parts.push(resource.text);
		else if (type === "resource_link" || type === "resource")
			parts.push(`(a resource${typeof resource?.uri === "string" ? `: ${resource.uri}` : ""})`);
		else if (type === "image" || type === "audio")
			parts.push(`(${type === "image" ? "an image" : "audio"}${typeof mimeType === "string" ? `, ${mimeType}` : ""})`);
	}
	if (parts.length === 0 && result.structuredContent !== undefined)
		parts.push(JSON.stringify(result.structuredContent));
	const text = parts.join("\n");
	return {
		text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (cut)` : text,
		isError: result.isError === true,
	};
}

/** The line the bridge prints its answer on, so whatever else the server printed is not taken for it. */
const ANSWER = "banda-mcp:";

/**
 * The bridge, run by node in the box: it starts the server's command, speaks stdio JSON-RPC with it (initialize, then
 * each request in `BANDA_MCP`), prints each response on a line of its own, and stops the server.
 */
const BRIDGE = `
const { spawn } = require("node:child_process");
const requests = JSON.parse(process.env.BANDA_MCP);
const server = spawn("/bin/sh", ["-c", process.env.BANDA_MCP_COMMAND], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let next = 0;
const send = (message) => server.stdin.write(JSON.stringify(message) + "\\n");
const end = (code) => { try { server.kill("SIGKILL"); } catch {} process.exit(code); };
server.on("exit", () => end(3));
server.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
		const line = buffer.slice(0, at).trim();
		buffer = buffer.slice(at + 1);
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		if (message.id !== requests[next]?.id) continue;
		process.stdout.write("${ANSWER}" + JSON.stringify(message) + "\\n");
		if (next === 0) send({ jsonrpc: "2.0", method: "notifications/initialized" });
		next += 1;
		if (next === requests.length) end(0);
		send(requests[next]);
	}
});
send(requests[0]);
`;

/** How long a server in the box may take for one exchange, in seconds. */
const BOX_SECONDS = 60;

/**
 * One exchange with a server the agent built, run in the box (`command`, at the workspace) through `env`, whose
 * commands reach outside only through the egress proxy: initialize, then `method`, in one bridge run; its result.
 */
export async function boxExchange(
	env: ExecutionEnv,
	command: string,
	method: string,
	params: { readonly [key: string]: unknown },
	ctx: Context,
): Promise<{ readonly [key: string]: unknown }> {
	const requests = [initialize(1), { jsonrpc: "2.0", id: 2, method, params }];
	let output = "";
	const ran = await env.exec(
		["node", "-e", BRIDGE],
		{
			timeout: BOX_SECONDS,
			env: { BANDA_MCP: JSON.stringify(requests), BANDA_MCP_COMMAND: command },
			onOutput: (text, _ctx, info) => {
				if (info.stream === "stdout" && output.length < MAX_BODY) output += text;
			},
		},
		ctx,
	);
	if (!ran.ok) throw new Error(`the server in the box did not run: ${ran.error.message}`);
	const answers = output
		.split("\n")
		.filter((line) => line.startsWith(ANSWER))
		.map((line) => {
			try {
				return JSON.parse(line.slice(ANSWER.length)) as unknown;
			} catch {
				return undefined;
			}
		});
	if (answers.length < 2)
		throw new Error(
			ran.value.exitCode === 3
				? "the server in the box stopped before it answered"
				: "the server in the box did not answer",
		);
	resultOf(answers[0], 1);
	return resultOf(answers[1], 2);
}

/** A transport over one box exchange per request: what `listTools` and `callTool` take for a server in the box. */
export function boxSession(env: () => ExecutionEnv, command: string): Transport {
	// the initialize and its notice are the bridge's; each request is a whole exchange of its own
	return async (message, ctx) => {
		if (message.method === "initialize")
			return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: PROTOCOL_VERSION } };
		if (message.id === undefined) return undefined;
		const result = await boxExchange(env(), command, message.method, message.params ?? {}, ctx);
		return { jsonrpc: "2.0", id: message.id, result };
	};
}
