import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import { GMAIL_TOOLS, gmailAttachment, gmailCall, gmailWriteCall } from "../src/core/gmail-rest.ts";
import {
	begin,
	DEFAULT_GOOGLE_CLIENT_ID,
	DEFAULT_GOOGLE_CLIENT_SECRET,
	discover,
	exchange,
	googleOAuthClient,
} from "../src/core/oauth.ts";
import { cardOf } from "../src/core/objects.ts";

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Gmail REST connection", () => {
	it("declares bounded reads and distinct write tools", () => {
		expect(GMAIL_TOOLS.map((tool) => tool.name)).toEqual([
			"get_profile",
			"get_labels",
			"search_messages",
			"get_message",
			"get_thread",
			"send_message",
			"mailbox_archive",
			"mailbox_trash",
			"mailbox_mark_read",
			"mailbox_mark_unread",
			"mailbox_add_label",
			"mailbox_remove_label",
		]);
		expect(GMAIL_TOOLS.filter((tool) => tool.readOnlyHint === true).map((tool) => tool.name)).toEqual([
			"get_profile",
			"get_labels",
			"search_messages",
			"get_message",
			"get_thread",
		]);
		const definition = parseConnection(
			"gmail",
			"---\nservice: Gmail\nurl: https://gmail.googleapis.com/gmail/v1/users/me\napi: gmail\nauth: oauth\nclient: google\nscopes: [https://www.googleapis.com/auth/gmail.readonly]\naccount: get_profile.emailAddress\nreads: [get_profile, search_messages, get_message, get_thread]\n---\nRead mail.",
		);
		expect("connection" in definition && definition.connection.api).toBe("gmail");
	});

	it("accepts a built-in API only at its own address, as Google, with scopes it allows", () => {
		const file = (lines: Record<string, string>) =>
			`---\n${Object.entries({
				service: "Gmail",
				url: "https://gmail.googleapis.com/gmail/v1/users/me",
				api: "gmail",
				auth: "oauth",
				client: "google",
				scopes: "[https://www.googleapis.com/auth/gmail.readonly]",
				...lines,
			})
				.filter(([, value]) => value !== "")
				.map(([key, value]) => `${key}: ${value}`)
				.join("\n")}\n---\nRead mail.`;
		const errors = (lines: Record<string, string>) => {
			const parsed = parseConnection("gmail", file(lines));
			return "errors" in parsed ? parsed.errors : [];
		};
		expect(errors({})).toEqual([]);
		expect(
			errors({
				scopes:
					"[https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.send, https://www.googleapis.com/auth/gmail.modify]",
			}),
		).toEqual([]);
		expect(errors({ api: "drive" }).join()).toContain("built-in API");
		expect(errors({ url: "https://gmail.googleapis.com/gmail/v1/users/other" }).join()).toContain("built-in API");
		expect(errors({ client: "someone-else" }).join()).toContain("Gmail uses OAuth client");
		expect(errors({ scopes: "[https://www.googleapis.com/auth/gmail.send]" }).join()).toContain(
			"Gmail uses OAuth client",
		);
		expect(
			errors({
				scopes: "[https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/drive]",
			}).join(),
		).toContain("Gmail uses OAuth client");
		expect(
			errors({
				scopes: "[https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.readonly]",
			}).join(),
		).toContain("Gmail uses OAuth client");
		// what a tool needs is what an account may ask for: only scopes the API allows
		const needing = (needs: Record<string, string[]>) => {
			const parsed = parseConnection("gmail", `${file({})}\n\`\`\`json\n${JSON.stringify({ needs })}\n\`\`\`\n`);
			return "errors" in parsed ? parsed.errors : [];
		};
		expect(needing({ send_message: ["https://www.googleapis.com/auth/gmail.send"] })).toEqual([]);
		expect(needing({ send_message: ["https://www.googleapis.com/auth/drive"] })).toEqual([
			"Gmail's tools may need only https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/gmail.send, https://www.googleapis.com/auth/gmail.modify: drop https://www.googleapis.com/auth/drive",
		]);
	});

	it("sends the approved recipient, subject and body as a Gmail MIME message", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "sent_1", threadId: "thread_1" }));
		const result = await gmailWriteCall(
			"token",
			"send_message",
			{ to: "ana@example.test", subject: "Hello ñ", body: "A private note" },
			undefined,
			fetcher,
		);
		expect(result.isError).toBe(false);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
		expect(init?.method).toBe("POST");
		const requestBody = JSON.parse(String(init?.body)) as { raw: string };
		const mime = Buffer.from(requestBody.raw, "base64url").toString("utf8");
		expect(mime).toContain("To: ana@example.test");
		expect(mime).toContain(`=?UTF-8?B?${Buffer.from("Hello ñ").toString("base64")}?=`);
		expect(mime).toContain(Buffer.from("A private note").toString("base64"));
		expect(result.text).not.toContain("token");
	});

	it("folds long Unicode subjects into RFC 2047 encoded-words of at most 75 characters", async () => {
		const subject = "Launch 🚀 café 世界 ".repeat(18);
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "sent_long" }));
		await gmailWriteCall("token", "send_message", { to: "a@example.test", subject, body: "Hi" }, undefined, fetcher);
		const raw = (JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { raw: string }).raw;
		const mime = Buffer.from(raw, "base64url").toString("utf8");
		const encodedHeader = mime.match(/^Subject: ([^\r]*(?:\r\n [^\r]*)*)/m)?.[1]?.replaceAll("\r\n ", " ");
		const words = encodedHeader?.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g) ?? [];
		expect(words.length).toBeGreaterThan(1);
		expect(words.every((word) => word.length <= 75)).toBe(true);
		expect(words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("")).toBe(subject);
	});

	it("puts approved attachment bytes in a bounded MIME part without returning them", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "sent_2" }));
		const bytes = Buffer.from("attachment bytes");
		const result = await gmailWriteCall(
			"token",
			"send_message",
			{
				to: "ana@example.test",
				subject: "Files",
				body: "See attached",
				attachments: [{ sha: "a".repeat(64), name: "report.txt" }],
			},
			undefined,
			fetcher,
			[{ sha: "a".repeat(64), name: "report.txt", mimeType: "text/plain", bytes }],
		);
		const init = fetcher.mock.calls[0]?.[1];
		const requestBody = JSON.parse(String(init?.body)) as { raw: string };
		const mime = Buffer.from(requestBody.raw, "base64url").toString("utf8");
		expect(mime).toContain('filename="report.txt"');
		expect(mime).toContain(bytes.toString("base64"));
		expect(result.text).not.toContain(bytes.toString("utf8"));
	});

	it("blocks header injection and applies mailbox changes with exact label IDs", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "m_1" }));
		const injected = await gmailWriteCall(
			"t",
			"send_message",
			{ to: "ana@example.test\r\nBcc: thief@example.test", subject: "Hi", body: "x" },
			undefined,
			fetcher,
		);
		expect(injected.isError).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
		await gmailWriteCall("t", "mailbox_add_label", { message_id: "m_1", label_id: "Label_7" }, undefined, fetcher);
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m_1/modify");
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
			addLabelIds: ["Label_7"],
			removeLabelIds: [],
		});
	});

	it("uses Google's fixed OAuth endpoints only for the Gmail API host", async () => {
		const fetcher = vi.fn();
		await expect(discover("https://gmail.googleapis.com/gmail/v1/users/me", fetcher)).resolves.toMatchObject({
			issuer: "https://accounts.google.com",
			authorize: "https://accounts.google.com/o/oauth2/v2/auth",
			token: "https://oauth2.googleapis.com/token",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("retries bounded transient reads but never replays a write response", async () => {
		const reading = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
			.mockResolvedValueOnce(response({ emailAddress: "me@example.test" }));
		await expect(gmailCall("t", "get_profile", {}, undefined, reading)).resolves.toMatchObject({ isError: false });
		expect(reading).toHaveBeenCalledTimes(2);
		const writing = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
		await gmailWriteCall("t", "mailbox_trash", { message_id: "m1" }, undefined, writing);
		expect(writing).toHaveBeenCalledTimes(1);
	});

	it("uses Banda's bundled public installed-app credentials by default", () => {
		expect(googleOAuthClient("desktop-client", undefined)).toEqual({
			id: "desktop-client",
			secret: DEFAULT_GOOGLE_CLIENT_SECRET,
		});
		expect(googleOAuthClient(undefined, undefined)).toEqual({
			id: DEFAULT_GOOGLE_CLIENT_ID,
			secret: DEFAULT_GOOGLE_CLIENT_SECRET,
		});
		expect(googleOAuthClient("web-client", "configured-secret")).toEqual({
			id: "web-client",
			secret: "configured-secret",
		});
	});

	it("ships an email object and draws it from bounded Gmail fields", () => {
		const text = readFileSync(new URL("../shipped/connections/gmail.md", import.meta.url), "utf8");
		const parsed = parseConnection("gmail", text);
		if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
		const kind = parsed.connection.objects?.email;
		expect(kind?.card).toBe("email");
		const card = cardOf(
			kind!,
			{ connection: "gmail", kind: "email", values: { id: "abc_123" } },
			{
				message: {
					from: "Ana <ana@example.test>",
					to: "me@example.test",
					subject: "Launch checklist",
					date: "Mon, 2 Nov",
					snippet: "First paragraph",
					body: "First paragraph\n\nSecond paragraph",
					unread: true,
				},
			},
		);
		expect(card).toMatchObject({
			card: "email",
			subject: "Launch checklist",
			unread: true,
			body: "First paragraph\n\nSecond paragraph",
		});
	});

	it("requests offline Google access without persisting a client secret in pending sign-in", async () => {
		const server = {
			issuer: "https://accounts.google.com",
			authorize: "https://accounts.google.com/o/oauth2/v2/auth",
			token: "https://oauth2.googleapis.com/token",
			resourceParameter: false,
		} as const;
		const started = begin(
			"gmail",
			"https://gmail.googleapis.com/gmail/v1/users/me",
			server,
			{ id: "client-id" },
			"http://127.0.0.1:4567/callback",
			1,
		);
		const url = new URL(started.url);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.has("resource")).toBe(false);
		expect(JSON.stringify(started.pending)).not.toContain("client_secret");
	});

	it("exchanges a public Desktop client code with PKCE and the bundled client secret", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ access_token: "access", refresh_token: "refresh" }));
		const started = begin(
			"gmail",
			"https://gmail.googleapis.com/gmail/v1/users/me",
			{
				issuer: "https://accounts.google.com",
				authorize: "https://accounts.google.com/o/oauth2/v2/auth",
				token: "https://oauth2.googleapis.com/token",
				resourceParameter: false,
			},
			googleOAuthClient("desktop-client", undefined),
			"http://127.0.0.1:4567/callback",
			1,
		);
		await exchange(started.pending, "one-use-code", 2, fetcher);
		const body = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code_verifier")).toBe(started.pending.verifier);
		expect(body.get("client_secret")).toBe(DEFAULT_GOOGLE_CLIENT_SECRET);
	});

	it("searches the account with the daemon bearer and returns bounded headers", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				response({ messages: [{ id: "m_1", threadId: "t_1" }], resultSizeEstimate: 1, nextPageToken: "next-2" }),
			)
			.mockResolvedValueOnce(
				response({
					id: "m_1",
					threadId: "t_1",
					snippet: "Hello",
					payload: {
						headers: [
							{ name: "From", value: "Ana <ana@example.test>" },
							{ name: "Subject", value: "Hi" },
						],
					},
				}),
			);
		const result = await gmailCall(
			"private-token",
			"search_messages",
			{ query: "from:ana", max_results: 1, page_token: "previous-1" },
			undefined,
			fetcher,
		);
		expect(JSON.parse(result.text)).toMatchObject({
			nextPageToken: "next-2",
			messages: [
				{
					id: "m_1",
					threadId: "t_1",
					from: "Ana <ana@example.test>",
					subject: "Hi",
				},
			],
		});
		const searchUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
		expect(searchUrl.searchParams.get("q")).toBe("from:ana");
		expect(searchUrl.searchParams.get("pageToken")).toBe("previous-1");
		expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer private-token");
		expect(result.text).not.toContain("private-token");
	});

	it("reads plain text and excludes text attachments from the message body", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				id: "m1",
				payload: {
					headers: [{ name: "Subject", value: "Private" }],
					mimeType: "multipart/mixed",
					parts: [
						{
							mimeType: "multipart/alternative",
							parts: [
								{ mimeType: "text/html", body: { data: Buffer.from("<script>bad()</script>").toString("base64url") } },
								{ mimeType: "text/plain", body: { data: Buffer.from("Safe body").toString("base64url") } },
							],
						},
						{
							mimeType: "text/plain",
							filename: "private.txt",
							headers: [{ name: "Content-Disposition", value: "attachment; filename=private.txt" }],
							body: {
								attachmentId: "att_private",
								data: Buffer.from("Do not expose this attachment").toString("base64url"),
							},
						},
					],
				},
			}),
		);
		const result = await gmailCall("t", "get_message", { message_id: "m1" }, undefined, fetcher);
		expect(JSON.parse(result.text).body).toBe("Safe body");
		expect(JSON.parse(result.text).body).not.toContain("Do not expose");
		expect(JSON.parse(result.text).attachments).toMatchObject([{ name: "private.txt", id: "att_private" }]);
		const invalid = await gmailCall("t", "get_message", { message_id: "../settings" }, undefined, fetcher);
		expect(invalid.isError).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("reads a bounded thread with canonical message ids and no account-assuming links", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ id: "t_1", messages: [{ id: "m_1", threadId: "t_1", payload: { headers: [] } }] }));
		const result = await gmailCall("t", "get_thread", { thread_id: "t_1" }, undefined, fetcher);
		expect(JSON.parse(result.text)).toMatchObject({
			id: "t_1",
			messages: [{ id: "m_1" }],
		});
		expect(JSON.parse(result.text)).not.toHaveProperty("messages.0.url");
	});

	it("fetches external and inline attachment bytes only from their Gmail message", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ data: Buffer.from("notes").toString("base64url"), size: 5 }))
			.mockResolvedValueOnce(
				response({
					id: "m_1",
					payload: {
						parts: [{ partId: "0.1", body: { data: Buffer.from("inline").toString("base64url") } }],
					},
				}),
			);
		await expect(gmailAttachment("secret", "m_1", "att_1", undefined, fetcher)).resolves.toEqual(Buffer.from("notes"));
		await expect(gmailAttachment("secret", "m_1", "part:0.1", undefined, fetcher)).resolves.toEqual(
			Buffer.from("inline"),
		);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/m_1/attachments/att_1",
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/m_1?format=full",
		]);
		expect(
			fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer secret"),
		).toBe(true);
	});

	it("rejects malformed attachment identifiers and data", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: "%%%" }));
		await expect(gmailAttachment("t", "m_1", "../other", undefined, fetcher)).rejects.toThrow("valid Gmail attachment");
		expect(fetcher).not.toHaveBeenCalled();
		await expect(gmailAttachment("t", "m_1", "att_1", undefined, fetcher)).rejects.toThrow("invalid attachment data");
	});

	it("refuses oversized page tokens before contacting Google", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const result = await gmailCall("t", "search_messages", { page_token: "x".repeat(2049) }, undefined, fetcher);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Give a valid Gmail page token");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("lets the shared OAuth retry path refresh a rejected token", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
		await expect(gmailCall("old", "get_profile", {}, undefined, fetcher)).rejects.toThrow(
			"Gmail did not take the credentials",
		);
	});
});
