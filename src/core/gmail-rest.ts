/** A bounded Gmail REST surface. Tokens are supplied per call by the daemon and never enter a box. */
import { randomUUID } from "node:crypto";
import { googleRequest, MAX_RESPONSE_BYTES } from "./google-rest.ts";
import { type McpResult, type McpTool, Unauthorized } from "./mcp.ts";
import { retryOf } from "./retry-after.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIMIT = 1_000_000;
export const MAX_GMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_GMAIL_SEND_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export type GmailAttachment = {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
};

const tool = (
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[] = [],
): McpTool => ({
	name,
	description,
	inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
	readOnlyHint: !name.startsWith("send_") && !name.startsWith("mailbox_"),
});

export const GMAIL_TOOLS: McpTool[] = [
	tool("get_profile", "Read the signed-in Gmail address.", {}),
	tool("get_labels", "List Gmail labels and their names and identifiers.", {}),
	tool(
		"search_messages",
		"Search Gmail using Gmail search syntax. Defaults to the inbox. Returns matching message ids and a nextPageToken when more results exist. Use that token as page_token to continue. Name each message in your answer as a link, [its name](gmail/<id>); to show cards, give them in the message's objects. New mail matching a search is gmail/search/<query> (gmail/search/from:boss is:unread), which can be followed, as an email can.",
		{
			query: { type: "string", description: "Gmail search query; defaults to in:inbox", maxLength: 500 },
			max_results: { type: "integer", minimum: 1, maximum: 25 },
			page_token: { type: "string", minLength: 1, maxLength: 2048 },
		},
	),
	tool(
		"get_message",
		"Read one Gmail message, including plain text and headers.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id"],
	),
	tool(
		"get_thread",
		"Read a Gmail conversation and its messages. Name a message in your answer as a link, [its name](gmail/<id>); to show cards, give them in the message's objects. The conversation itself is gmail/thread/<threadId>, which can be followed, as an email can.",
		{
			thread_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["thread_id"],
	),
	tool(
		"send_message",
		"Send an email. This always requires owner approval.",
		{
			to: { type: "string", minLength: 3, maxLength: 1000 },
			subject: { type: "string", maxLength: 998 },
			body: { type: "string", maxLength: 100000 },
			attachments: {
				type: "array",
				maxItems: 10,
				items: {
					type: "object",
					properties: {
						sha: { type: "string", pattern: "^[a-f0-9]{64}$" },
						name: { type: "string", maxLength: 120 },
					},
					required: ["sha", "name"],
				},
			},
		},
		["to", "subject", "body"],
	),
	tool(
		"mailbox_archive",
		"Archive a message by removing it from the inbox. This always requires owner approval.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id"],
	),
	tool(
		"mailbox_trash",
		"Move a message to Trash. This always requires owner approval.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id"],
	),
	tool(
		"mailbox_mark_read",
		"Mark a message as read. This always requires owner approval.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id"],
	),
	tool(
		"mailbox_mark_unread",
		"Mark a message as unread. This always requires owner approval.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id"],
	),
	tool(
		"mailbox_add_label",
		"Add a Gmail label to a message. This always requires owner approval.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
			label_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id", "label_id"],
	),
	tool(
		"mailbox_remove_label",
		"Remove a Gmail label from a message. This always requires owner approval.",
		{
			message_id: { type: "string", minLength: 1, maxLength: 200 },
			label_id: { type: "string", minLength: 1, maxLength: 200 },
		},
		["message_id", "label_id"],
	),
];

type Json = Record<string, unknown>;
const object = (value: unknown): Json => (typeof value === "object" && value !== null ? (value as Json) : {});
const hasControl = (value: string) =>
	[...value].some((char) => {
		const point = char.codePointAt(0) ?? 0;
		return point < 0x20 || point === 0x7f;
	});
const safeHeader = (value: string) =>
	[...value]
		.map((char) => {
			const point = char.codePointAt(0) ?? 0;
			return char === "\\" || char === '"' || point < 0x20 || point > 0x7e ? "_" : char;
		})
		.join("")
		.slice(0, 120);

function decodePart(payload: unknown): string {
	const part = object(payload);
	const mime = typeof part.mimeType === "string" ? part.mimeType : "";
	const body = object(part.body);
	const headers = Array.isArray(part.headers) ? part.headers.map(object) : [];
	const disposition = headers.find((header) => String(header.name ?? "").toLowerCase() === "content-disposition");
	if (
		(typeof part.filename === "string" && part.filename !== "") ||
		typeof body.attachmentId === "string" ||
		(typeof disposition?.value === "string" && /^\s*attachment\b/i.test(disposition.value))
	)
		return "";
	if (mime === "text/plain" && typeof body.data === "string") {
		const decoded = Buffer.from(body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		return decoded.slice(0, 40_000);
	}
	return (Array.isArray(part.parts) ? part.parts : []).map(decodePart).filter(Boolean).join("\n").slice(0, 40_000);
}

function attachmentsOf(payload: unknown): GmailAttachment[] {
	const found: GmailAttachment[] = [];
	const visit = (value: unknown) => {
		const part = object(value);
		const name = typeof part.filename === "string" ? part.filename : "";
		const body = object(part.body);
		const external = typeof body.attachmentId === "string" ? body.attachmentId : "";
		const partId = typeof part.partId === "string" ? part.partId : "";
		const id =
			external || (typeof body.data === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(partId) ? `part:${partId}` : "");
		if (name !== "" && id !== "" && id.length <= 500 && found.length < 20) {
			const size = typeof body.size === "number" && Number.isSafeInteger(body.size) && body.size >= 0 ? body.size : 0;
			found.push({
				id,
				name: name.slice(0, 500),
				mimeType: typeof part.mimeType === "string" ? part.mimeType.slice(0, 200) : "application/octet-stream",
				size,
			});
		}
		if (Array.isArray(part.parts)) for (const child of part.parts) visit(child);
	};
	visit(payload);
	return found;
}

/** The address alone of a From header (`Ana <ana@example.com>`), lowercase: whose a message is, as the account says it. */
export function addressOf(from: string): string {
	const address = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from)?.[1] ?? /^\s*([^<>\s"]+@[^<>\s"]+)\s*$/.exec(from)?.[1] ?? "";
	return address.toLowerCase().slice(0, 320);
}

function messageOf(raw: unknown) {
	const msg = object(raw);
	const payload = object(msg.payload);
	const headers = Array.isArray(payload.headers) ? payload.headers : [];
	const header = (name: string) => {
		const found = headers.map(object).find((h) => String(h.name ?? "").toLowerCase() === name.toLowerCase());
		return typeof found?.value === "string" ? found.value.slice(0, 1000) : "";
	};
	return {
		id: typeof msg.id === "string" ? msg.id : "",
		threadId: typeof msg.threadId === "string" ? msg.threadId : "",
		from: header("From"),
		fromAddress: addressOf(header("From")),
		to: header("To"),
		cc: header("Cc"),
		subject: header("Subject"),
		date: header("Date"),
		snippet: typeof msg.snippet === "string" ? msg.snippet.slice(0, 2000) : "",
		body: decodePart(payload),
		attachments: attachmentsOf(payload),
		labels: Array.isArray(msg.labelIds)
			? msg.labelIds.filter((x): x is string => typeof x === "string").slice(0, 30)
			: [],
		unread: Array.isArray(msg.labelIds) && msg.labelIds.includes("UNREAD"),
	};
}

/** RFC 2047 encoded-words are limited to 75 characters; keep UTF-8 chunks whole and fold between words. */
function encodeSubject(subject: string): string {
	const words: string[] = [];
	let chunk = "";
	let bytes = 0;
	for (const char of subject) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > 42 && chunk !== "") {
			words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
			chunk = "";
			bytes = 0;
		}
		chunk += char;
		bytes += size;
	}
	if (chunk !== "" || words.length === 0) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
	return words.join("\r\n ");
}

/** Fetch bytes for a message attachment. Bearer and base64 stay inside the daemon. */
export async function gmailAttachment(
	token: string,
	messageId: string,
	attachmentId: string,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<Buffer> {
	if (
		!/^[A-Za-z0-9_-]{1,200}$/.test(messageId) ||
		!/^(?:[A-Za-z0-9_=-]{1,500}|part:[A-Za-z0-9_.-]{1,200})$/.test(attachmentId)
	)
		throw new Error("Give a valid Gmail attachment.");
	let raw: Json;
	if (attachmentId.startsWith("part:")) {
		const message = object(
			await request(
				fetcher,
				token,
				`messages/${encodeURIComponent(messageId)}?format=full`,
				signal,
				Math.ceil(MAX_GMAIL_ATTACHMENT_BYTES * 1.5),
			),
		);
		const find = (value: unknown): Json | undefined => {
			const part = object(value);
			if (part.partId === attachmentId.slice(5)) return object(part.body);
			for (const child of Array.isArray(part.parts) ? part.parts : []) {
				const matched = find(child);
				if (matched !== undefined) return matched;
			}
			return undefined;
		};
		raw = find(object(message.payload)) ?? {};
	} else {
		raw = object(
			await request(
				fetcher,
				token,
				`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
				signal,
				Math.ceil(MAX_GMAIL_ATTACHMENT_BYTES * 1.5),
			),
		);
	}
	if (typeof raw.data !== "string") throw new Error("Gmail returned no attachment data.");
	if (
		(raw.data !== "" && !/^[A-Za-z0-9_-]+={0,2}$/.test(raw.data)) ||
		raw.data.length > Math.ceil((MAX_GMAIL_ATTACHMENT_BYTES * 4) / 3) + 8
	)
		throw new Error("Gmail returned invalid attachment data.");
	const bytes = Buffer.from(raw.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
	if (bytes.length > MAX_GMAIL_ATTACHMENT_BYTES) throw new Error("That attachment is larger than 10 MB.");
	return bytes;
}

const GMAIL = { service: "Gmail", base: API };
const request = (
	fetcher: typeof fetch,
	token: string,
	path: string,
	signal?: AbortSignal,
	limit = MAX_RESPONSE_BYTES,
	method: "GET" | "POST" = "GET",
	body?: unknown,
) => googleRequest(GMAIL, fetcher, token, path, signal, limit, method, body);

/** Execute a Gmail write already approved by the owner. */
export async function gmailWriteCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
	files: readonly {
		readonly sha: string;
		readonly name: string;
		readonly mimeType: string;
		readonly bytes: Uint8Array;
	}[] = [],
): Promise<McpResult> {
	try {
		let answer: unknown;
		if (name === "send_message") {
			const to = typeof args.to === "string" ? args.to.trim() : "";
			const subject = typeof args.subject === "string" ? args.subject : "";
			const body = typeof args.body === "string" ? args.body : "";
			if (
				!to ||
				to.length > 1000 ||
				subject.length > 998 ||
				Buffer.byteLength(body, "utf8") > 100_000 ||
				files.length > 10 ||
				files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_GMAIL_SEND_ATTACHMENT_BYTES ||
				hasControl(to) ||
				hasControl(subject)
			)
				throw new Error("Give a valid recipient, subject and message body within the size limits.");
			const safeSubject = encodeSubject(subject);
			const boundary = `banda_${randomUUID().replaceAll("-", "")}`;
			const headers = [`To: ${to}`, `Subject: ${safeSubject}`, "MIME-Version: 1.0"];
			const encodedBody = Buffer.from(body, "utf8")
				.toString("base64")
				.replace(/.{1,76}/g, "$&\r\n");
			const bodyPart =
				files.length > 0
					? [
							`--${boundary}`,
							'Content-Type: text/plain; charset="UTF-8"',
							"Content-Transfer-Encoding: base64",
							"",
							encodedBody,
						].join("\r\n")
					: encodedBody;
			const attachmentParts = files.map((file) => {
				if (hasControl(file.name) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.mimeType))
					throw new Error("An attachment has invalid metadata.");
				return [
					`--${boundary}`,
					`Content-Type: ${file.mimeType}; name="${safeHeader(file.name)}"`,
					"Content-Transfer-Encoding: base64",
					`Content-Disposition: attachment; filename="${safeHeader(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
					"",
					Buffer.from(file.bytes)
						.toString("base64")
						.replace(/.{1,76}/g, "$&\r\n"),
				].join("\r\n");
			});
			const raw = [
				...headers,
				...(files.length > 0
					? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
					: ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"]),
				"",
				files.length > 0 ? [bodyPart, ...attachmentParts, `--${boundary}--`].join("\r\n") : bodyPart,
			].join("\r\n");
			answer = await request(fetcher, token, "messages/send", signal, MAX_RESPONSE_BYTES, "POST", {
				raw: Buffer.from(raw, "utf8").toString("base64url"),
			});
		} else if (
			[
				"mailbox_archive",
				"mailbox_trash",
				"mailbox_mark_read",
				"mailbox_mark_unread",
				"mailbox_add_label",
				"mailbox_remove_label",
			].includes(name)
		) {
			const id = args.message_id;
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Give a valid message id.");
			if (name === "mailbox_trash")
				answer = await request(
					fetcher,
					token,
					`messages/${encodeURIComponent(id)}/trash`,
					signal,
					MAX_RESPONSE_BYTES,
					"POST",
					{},
				);
			else {
				const labelId = args.label_id;
				if (name.endsWith("_label") && (typeof labelId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(labelId)))
					throw new Error("Give a valid Gmail label id.");
				const addLabelIds =
					name === "mailbox_mark_unread" ? ["UNREAD"] : name === "mailbox_add_label" ? [labelId as string] : [];
				const removeLabelIds =
					name === "mailbox_archive"
						? ["INBOX"]
						: name === "mailbox_mark_read"
							? ["UNREAD"]
							: name === "mailbox_remove_label"
								? [labelId as string]
								: [];
				answer = await request(
					fetcher,
					token,
					`messages/${encodeURIComponent(id)}/modify`,
					signal,
					MAX_RESPONSE_BYTES,
					"POST",
					{ addLabelIds, removeLabelIds },
				);
			}
		} else throw new Error("That Gmail change is not available.");
		return { text: JSON.stringify({ ok: true, id: object(answer).id ?? null }), isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) throw error;
		return { text: error instanceof Error ? error.message : "Gmail could not apply the change.", isError: true };
	}
}

/** Execute one declared Gmail read. Error text never contains a URL, response body, or token. */
export async function gmailCall(
	token: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<McpResult> {
	try {
		let answer: unknown;
		switch (name) {
			case "get_profile": {
				const profile = object(await request(fetcher, token, "profile", signal));
				answer = { emailAddress: typeof profile.emailAddress === "string" ? profile.emailAddress : "" };
				break;
			}
			case "get_labels": {
				const response = object(await request(fetcher, token, "labels", signal));
				answer = {
					labels: (Array.isArray(response.labels) ? response.labels : []).slice(0, 100).flatMap((entry) => {
						const label = object(entry);
						return typeof label.id === "string" && typeof label.name === "string"
							? [{ id: label.id.slice(0, 200), name: label.name.slice(0, 500) }]
							: [];
					}),
				};
				break;
			}
			case "search_messages": {
				const query =
					typeof args.query === "string" && args.query.trim() !== "" ? args.query.slice(0, 500) : "in:inbox";
				const max = typeof args.max_results === "number" ? Math.max(1, Math.min(25, Math.floor(args.max_results))) : 10;
				const params = new URLSearchParams({ q: query, maxResults: String(max) });
				if (args.page_token !== undefined) {
					if (typeof args.page_token !== "string" || args.page_token.length === 0 || args.page_token.length > 2048)
						throw new Error("Give a valid Gmail page token.");
					params.set("pageToken", args.page_token);
				}
				const list = object(await request(fetcher, token, `messages?${params}`, signal));
				const ids = Array.isArray(list.messages) ? list.messages : [];
				const messages = await Promise.all(
					ids.slice(0, max).map(async (item) => {
						const id = object(item).id;
						if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return undefined;
						const params = new URLSearchParams({ format: "metadata" });
						for (const header of ["From", "Subject", "Date"]) params.append("metadataHeaders", header);
						const msg = object(await request(fetcher, token, `messages/${encodeURIComponent(id)}?${params}`, signal));
						const payload = object(msg.payload);
						const headers = Array.isArray(payload.headers) ? payload.headers : [];
						const get = (n: string) =>
							String(
								headers.map(object).find((h) => String(h.name).toLowerCase() === n.toLowerCase())?.value ?? "",
							).slice(0, 500);
						return {
							id,
							...(typeof msg.threadId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(msg.threadId)
								? { threadId: msg.threadId }
								: {}),
							from: get("From"),
							fromAddress: addressOf(get("From")),
							subject: get("Subject"),
							date: get("Date"),
							snippet: typeof msg.snippet === "string" ? msg.snippet.slice(0, 2000) : "",
						};
					}),
				);
				const next = typeof list.nextPageToken === "string" ? list.nextPageToken : undefined;
				if (next !== undefined && (next.length === 0 || next.length > 2048))
					throw new Error("Gmail returned an invalid page token.");
				answer = {
					resultSizeEstimate: list.resultSizeEstimate ?? ids.length,
					messages: messages.filter(Boolean),
					...(next === undefined ? {} : { nextPageToken: next }),
				};
				break;
			}
			case "get_message": {
				const id = args.message_id;
				if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Give a valid message id.");
				answer = messageOf(await request(fetcher, token, `messages/${encodeURIComponent(id)}?format=full`, signal));
				break;
			}
			case "get_thread": {
				const id = args.thread_id;
				if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
					throw new Error("Give a valid conversation id.");
				const thread = object(await request(fetcher, token, `threads/${encodeURIComponent(id)}?format=full`, signal));
				const all = Array.isArray(thread.messages) ? thread.messages : [];
				const messages = all.slice(-25).map(messageOf);
				answer = {
					id: thread.id,
					// the conversation's subject: its first message's, which may be older than the newest 25
					subject: all.length === 0 ? "" : messageOf(all[0]).subject,
					// how many it has, though only the newest 25 are given: an older one gone from them is not gone
					total: all.length,
					// the conversation's labels, as Gmail shows them on it: any of its messages'
					labels: [...new Set(messages.flatMap((message) => message.labels))].slice(0, 50),
					messages,
				};
				break;
			}
			default:
				throw new Error("That Gmail read is not available.");
		}
		const text = JSON.stringify(answer);
		return text.length > LIMIT
			? { text: JSON.stringify({ error: "Gmail result too large; read one message at a time." }), isError: true }
			: { text, isError: false };
	} catch (error) {
		if (error instanceof Unauthorized) throw error;
		return {
			text: error instanceof Error ? error.message : "Gmail could not be read.",
			isError: true,
			...retryOf(error),
		};
	}
}
