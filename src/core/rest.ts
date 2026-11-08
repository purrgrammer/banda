/** The built-in daemon REST adapters: first-party APIs that do not speak MCP, each signed in to as its shipped client. */
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
import type { ClientName } from "./oauth.ts";
import {
	SLACK_IDEMPOTENT,
	SLACK_TOOLS,
	slackBinds,
	slackCall,
	slackDraft,
	slackEditable,
	slackExpand,
	slackResolve,
	slackWriteCall,
} from "./slack-rest.ts";

/** A file the owner approved to send, held by the chat; its bytes were checked against `sha` before they leave. */
export type ApprovedFile = {
	readonly sha: string;
	readonly name: string;
	readonly mimeType: string;
	readonly bytes: Uint8Array;
};

export type RestApi = {
	readonly service: string;
	/** The shipped OAuth client its connection file names, and the server that signs in to it. */
	readonly client: ClientName;
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
		/** `permit`: what a permission from the draft covers, when it binds fewer arguments than the call (`binds`). */
		readonly words: (
			tool: string,
			args: Record<string, unknown>,
		) => { what: string; verb: string; permit?: string } | undefined;
		readonly editable: (tool: string) => readonly string[];
		/** The arguments a permission from a write's draft binds, when not every one: a reaction's channel. */
		readonly binds?: (tool: string) => readonly string[] | undefined;
		readonly expand: (tool: string, args: Record<string, unknown>) => Record<string, unknown>;
		/**
		 * What the draft shows that the call does not say, read from the service once, as the account it acts as, when it
		 * is drafted (a channel's name for its id): added to the draft under `_` names, which the write never reads. A
		 * refusal refuses the draft.
		 */
		readonly resolve?: (
			token: string,
			tool: string,
			args: Record<string, unknown>,
			signal?: AbortSignal,
			fetcher?: typeof fetch,
		) => Promise<Record<string, unknown>>;
	};
};

export const REST_APIS = {
	gmail: {
		service: "Gmail",
		client: "google",
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
		client: "google",
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
		client: "google",
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
		client: "google",
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
	slack: {
		service: "Slack",
		client: "slack",
		url: "https://slack.com/api",
		required: ["channels:read", "groups:read", "channels:history", "groups:history", "users:read"],
		scopes: [
			"channels:read",
			"groups:read",
			"channels:history",
			"groups:history",
			"users:read",
			"im:read",
			"mpim:read",
			"im:history",
			"mpim:history",
			"search:read",
			"chat:write",
			"reactions:write",
			"files:read",
		],
		tools: SLACK_TOOLS,
		account: { tool: "whoami", field: "handle" },
		read: (token, tool, args, signal, fetcher) => slackCall(token, tool, args, signal, fetcher),
		write: (token, tool, args, signal, fetcher) => slackWriteCall(token, tool, args, signal, fetcher),
		idempotent: SLACK_IDEMPOTENT,
		drafts: {
			words: slackDraft,
			editable: slackEditable,
			binds: slackBinds,
			expand: slackExpand,
			resolve: (token, tool, args, signal, fetcher) => slackResolve(token, tool, args, signal, fetcher),
		},
	},
} as const satisfies Record<string, RestApi>;

export type RestApiName = keyof typeof REST_APIS;

export function restApiNamed(name: string): RestApiName | undefined {
	return Object.hasOwn(REST_APIS, name) ? (name as RestApiName) : undefined;
}
