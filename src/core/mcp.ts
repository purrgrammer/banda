/**
 * What banda keeps of a remote MCP server's answers (mcp-remote.ts speaks the protocol through pi-mcp): what a server
 * answers is data, so shapes are checked, sizes cut, and nothing in it is run by the daemon.
 */

/** A tool as a server lists it: its name, its words for the model, and the JSON schema of its arguments. */
export type McpTool = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: { readonly [key: string]: unknown };
	/** The server's own hints, which banda shows but never trusts for what asks the owner. */
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
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
export const MAX_RESULT_CHARS = 50_000;

export function toolOf(raw: unknown): McpTool | undefined {
	const { name, description, inputSchema, annotations } = (raw ?? {}) as {
		name?: unknown;
		description?: unknown;
		inputSchema?: unknown;
		annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
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
		...(typeof annotations?.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
	};
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
