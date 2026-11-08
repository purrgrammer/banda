import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import { addressOf, GMAIL_TOOLS, gmailAttachment, gmailCall, gmailWriteCall } from "../src/core/gmail-rest.ts";
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

	it("draws a conversation and a search as lists of emails, the newest first, titled by subject and query", () => {
		const text = readFileSync(new URL("../shipped/connections/gmail.md", import.meta.url), "utf8");
		const parsed = parseConnection("gmail", text);
		if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
		const objects = parsed.connection.objects ?? {};
		const line = (id: string, date: string) => ({
			id,
			from: `Bob\u0007 <bob@example.test>`,
			subject: `About ${id}`,
			date,
		});
		const thread = cardOf(
			objects.thread!,
			{ connection: "gmail", kind: "thread", values: { id: "t1" } },
			{
				thread: {
					id: "t1",
					subject: "Lunch?",
					total: 7,
					labels: ["INBOX"],
					messages: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((id, n) =>
						line(id, `Mon, ${n + 2} Nov 2026 09:00:00 +0100`),
					),
				},
			},
		);
		expect(thread).toMatchObject({ card: "messages", title: "Lunch?", search: false, total: 7 });
		expect(thread.card === "messages" && thread.messages.map((each) => each.id)).toEqual([
			"m7",
			"m6",
			"m5",
			"m4",
			"m3",
		]);
		expect(thread.card === "messages" && thread.messages[0]?.from).toBe("Bob <bob@example.test>");
		const search = cardOf(
			objects.search!,
			{ connection: "gmail", kind: "search", values: { query: "from:bob is:unread" } },
			{ search: { resultSizeEstimate: 40, messages: [line("m9", "Tue, 3 Nov 2026"), line("m8", "")] } },
		);
		expect(search).toMatchObject({
			card: "messages",
			title: "mail matching from:bob is:unread",
			search: true,
			total: 40,
		});
		expect(search.card === "messages" && search.messages.map((each) => each.id)).toEqual(["m9", "m8"]);
		expect(() =>
			cardOf(objects.search!, { connection: "gmail", kind: "search", values: { query: "x" } }, { search: {} }),
		).toThrow();
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
					fromAddress: "ana@example.test",
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

	it("says whose a message is by its address alone, as the account is named", () => {
		expect(addressOf("Ana García <Ana@Example.test>")).toBe("ana@example.test");
		expect(addressOf('"Bob, the builder" <bob@example.test>')).toBe("bob@example.test");
		expect(addressOf("carol@example.test")).toBe("carol@example.test");
		expect(addressOf("Mailer Daemon")).toBe("");
	});

	it("a thread says its labels, any of its messages', and how many messages it has beyond the newest 25", async () => {
		const message = (n: number, labels: string[], from = "Bob <bob@example.test>") => ({
			id: `m_${n}`,
			threadId: "t_1",
			labelIds: labels,
			payload: {
				headers: [
					{ name: "From", value: from },
					{ name: "Subject", value: n === 0 ? "Lunch?" : "Re: Lunch?" },
				],
			},
		});
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				id: "t_1",
				messages: [
					...Array.from({ length: 28 }, (_, n) => message(n, ["INBOX"])),
					message(28, ["SENT"], "Ana <ana@example.test>"),
					message(29, ["INBOX", "UNREAD", "STARRED"]),
				],
			}),
		);
		const thread = JSON.parse((await gmailCall("t", "get_thread", { thread_id: "t_1" }, undefined, fetcher)).text);
		expect(thread.total).toBe(30);
		expect(thread.subject).toBe("Lunch?");
		expect(thread.messages).toHaveLength(25);
		expect(thread.labels).toEqual(["INBOX", "SENT", "UNREAD", "STARRED"]);
		expect(thread.messages.at(-2)).toMatchObject({ id: "m_28", fromAddress: "ana@example.test" });
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
