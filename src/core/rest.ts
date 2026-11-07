/** The built-in daemon REST adapters: first-party APIs that do not speak MCP, each signed in to as Google. */
import { CALENDAR_TOOLS, calendarCall, calendarWriteCall } from "./calendar-rest.ts";
import { GMAIL_TOOLS, gmailCall, gmailWriteCall } from "./gmail-rest.ts";
import type { McpResult, McpTool } from "./mcp.ts";

/** A file the owner approved to send, held by the chat; its bytes were checked against `sha` before they leave. */
export type ApprovedFile = {
	readonly sha: string;
	readonly name: string;
	readonly mimeType: string;
	readonly bytes: Uint8Array;
};

export type RestApi = {
	readonly service: string;
	/** The one address a connection file naming this API must give. */
	readonly url: string;
	/** The scope every sign-in asks for; the others in `scopes` are added by choice. */
	readonly base: string;
	readonly scopes: readonly string[];
	readonly tools: readonly McpTool[];
	/** The read and the field of its answer that name the account, when the file's `account:` does not. */
	readonly account: { readonly tool: string; readonly field: string };
	readonly read: (
		token: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		fetcher?: typeof fetch,
	) => Promise<McpResult>;
	readonly write: (
		token: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		fetcher?: typeof fetch,
		files?: readonly ApprovedFile[],
	) => Promise<McpResult>;
};

export const REST_APIS = {
	gmail: {
		service: "Gmail",
		url: "https://gmail.googleapis.com/gmail/v1/users/me",
		base: "https://www.googleapis.com/auth/gmail.readonly",
		scopes: [
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.send",
			"https://www.googleapis.com/auth/gmail.modify",
		],
		tools: GMAIL_TOOLS,
		account: { tool: "get_profile", field: "emailAddress" },
		read: gmailCall,
		write: gmailWriteCall,
	},
	calendar: {
		service: "Google Calendar",
		url: "https://www.googleapis.com/calendar/v3",
		base: "https://www.googleapis.com/auth/calendar.readonly",
		scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		tools: CALENDAR_TOOLS,
		account: { tool: "get_profile", field: "email" },
		read: (token, tool, args, signal, fetcher) => calendarCall(token, tool, args, signal, fetcher),
		write: calendarWriteCall,
	},
} as const satisfies Record<string, RestApi>;

export type RestApiName = keyof typeof REST_APIS;

export function restApiNamed(name: string): RestApiName | undefined {
	return Object.hasOwn(REST_APIS, name) ? (name as RestApiName) : undefined;
}
