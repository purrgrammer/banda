/** The built-in daemon REST adapters: first-party APIs that do not speak MCP, each signed in to as Google. */
import {
	CALENDAR_TOOLS,
	CALENDAR_WRITES,
	calendarCall,
	calendarDraft,
	calendarEditable,
	calendarExpand,
	calendarWriteCall,
} from "./calendar-rest.ts";
import {
	CONTACTS_IDEMPOTENT,
	CONTACTS_TOOLS,
	contactsCall,
	contactsDraft,
	contactsEditable,
	contactsExpand,
	contactsWriteCall,
} from "./contacts-rest.ts";
import {
	DRIVE_IDEMPOTENT,
	DRIVE_TOOLS,
	driveCall,
	driveDraft,
	driveEditable,
	driveExpand,
	driveWriteCall,
} from "./drive-rest.ts";
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
	/**
	 * The scopes every sign-in asks for, whatever the owner picks: what reads, and what names the account (Contacts
	 * reads its address under its own scope). The others in `scopes` are added by choice.
	 */
	readonly required: readonly string[];
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
	/**
	 * Run an approved change. `key` is the approved effect's own, the same when a crash cut its run short and it runs
	 * again: what an idempotent write uses to make a repeat change nothing.
	 */
	readonly write: (
		token: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		fetcher?: typeof fetch,
		files?: readonly ApprovedFile[],
		key?: string,
	) => Promise<McpResult>;
	/** The writes that are the same change when run again with the same key, so a crash's repeat runs unasked. */
	readonly idempotent?: readonly string[];
	/** A write's draft in the owner's words: what it does, its button, what they may edit, and the draft they see. */
	readonly drafts?: {
		readonly words: (tool: string, args: Record<string, unknown>) => { what: string; verb: string } | undefined;
		readonly editable: (tool: string) => readonly string[];
		readonly expand: (tool: string, args: Record<string, unknown>) => Record<string, unknown>;
	};
};

export const REST_APIS = {
	gmail: {
		service: "Gmail",
		url: "https://gmail.googleapis.com/gmail/v1/users/me",
		required: ["https://www.googleapis.com/auth/gmail.readonly"],
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
		required: ["https://www.googleapis.com/auth/calendar.readonly"],
		scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
		tools: CALENDAR_TOOLS,
		account: { tool: "get_profile", field: "email" },
		read: (token, tool, args, signal, fetcher) => calendarCall(token, tool, args, signal, fetcher),
		write: (token, tool, args, signal, fetcher, _files, key) =>
			calendarWriteCall(token, tool, args, signal, fetcher, key),
		idempotent: CALENDAR_WRITES,
		drafts: { words: calendarDraft, editable: calendarEditable, expand: calendarExpand },
	},
	contacts: {
		service: "Google Contacts",
		url: "https://people.googleapis.com/v1",
		required: ["https://www.googleapis.com/auth/contacts.readonly", "https://www.googleapis.com/auth/userinfo.email"],
		scopes: [
			"https://www.googleapis.com/auth/contacts.readonly",
			"https://www.googleapis.com/auth/contacts.other.readonly",
			"https://www.googleapis.com/auth/contacts",
			"https://www.googleapis.com/auth/userinfo.email",
		],
		tools: CONTACTS_TOOLS,
		account: { tool: "get_profile", field: "email" },
		read: (token, tool, args, signal, fetcher) => contactsCall(token, tool, args, signal, fetcher),
		write: (token, tool, args, signal, fetcher) => contactsWriteCall(token, tool, args, signal, fetcher),
		idempotent: CONTACTS_IDEMPOTENT,
		drafts: { words: contactsDraft, editable: contactsEditable, expand: contactsExpand },
	},
	drive: {
		service: "Google Drive",
		url: "https://www.googleapis.com/drive/v3",
		required: ["https://www.googleapis.com/auth/drive.readonly"],
		scopes: [
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/drive.file",
			"https://www.googleapis.com/auth/spreadsheets",
			"https://www.googleapis.com/auth/documents",
			"https://www.googleapis.com/auth/drive",
		],
		tools: DRIVE_TOOLS,
		account: { tool: "get_profile", field: "email" },
		read: driveCall,
		write: (token, tool, args, signal, fetcher, _files, key) => driveWriteCall(token, tool, args, signal, fetcher, key),
		idempotent: DRIVE_IDEMPOTENT,
		drafts: { words: driveDraft, editable: driveEditable, expand: driveExpand },
	},
} as const satisfies Record<string, RestApi>;

export type RestApiName = keyof typeof REST_APIS;

export function restApiNamed(name: string): RestApiName | undefined {
	return Object.hasOwn(REST_APIS, name) ? (name as RestApiName) : undefined;
}
