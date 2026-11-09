import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import { DRIVE_TOOLS, driveCall, fileOfRef, fullText, kindOf } from "../src/core/drive-rest.ts";
import { discover } from "../src/core/oauth.ts";
import { cardOf, readArgs, recognise } from "../src/core/objects.ts";
import { REST_APIS, type RestApi } from "../src/core/rest.ts";

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const textResponse = (body: string, type = "text/plain") =>
	new Response(body, { status: 200, headers: { "content-type": type } });
const call = (fetcher: typeof fetch, name: string, args: Record<string, unknown> = {}, token = "t") =>
	driveCall(token, name, args, undefined, fetcher);
const read = async (fetcher: typeof fetch, args: Record<string, unknown>) => {
	const result = await call(fetcher, "read_file", args);
	expect(result.isError).toBe(false);
	return JSON.parse(result.text);
};
const source = () => readFileSync(new URL("../shipped/connections/drive.md", import.meta.url), "utf8");
const shipped = () => {
	const parsed = parseConnection("drive", source());
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	return parsed.connection;
};
const urlOf = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) =>
	new URL(String(fetcher.mock.calls[index]?.[0]));
const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";

describe("Google Drive REST connection", () => {
	it("declares four reads and, apart from them, only the changes that ask the owner", () => {
		expect(DRIVE_TOOLS.map((tool) => tool.name)).toEqual([
			"get_profile",
			"search_files",
			"get_file",
			"read_file",
			"list_comments",
			"create_doc",
			"create_sheet",
			"replace_doc_text",
			"rename_file",
			"trash_file",
			"append_rows",
			"update_range",
			"add_sheet",
			"append_doc_text",
			"reply_comment",
		]);
		expect(DRIVE_TOOLS.filter((tool) => tool.readOnlyHint === true).map((tool) => tool.name)).toEqual([
			"get_profile",
			"search_files",
			"get_file",
			"read_file",
			"list_comments",
		]);
		expect(REST_APIS.drive.tools).toBe(DRIVE_TOOLS);
	});

	it("ships a file the registry accepts, with the reads it names, and refuses other scopes", () => {
		const connection = shipped();
		expect(connection).toMatchObject({
			api: "drive",
			service: "Google Drive",
			scopes: ["https://www.googleapis.com/auth/drive.readonly"],
		});
		expect(connection.reads).toEqual(["get_profile", "search_files", "get_file", "read_file", "list_comments"]);
		expect(connection.objects?.file?.card).toBe("file");
		const errors = (from: string, to: string) => {
			const parsed = parseConnection("drive", source().replace(from, to));
			return "errors" in parsed ? parsed.errors.join() : "";
		};
		const scope = "https://www.googleapis.com/auth/drive.readonly";
		for (const other of [
			`${scope}, https://www.googleapis.com/auth/drive.metadata`,
			"https://www.googleapis.com/auth/drive.appdata",
			"https://www.googleapis.com/auth/drive.metadata.readonly",
		])
			expect(errors(`scopes: [${scope}]`, `scopes: [${other}]`)).toContain("Google Drive uses OAuth client");
		expect(errors("url: https://www.googleapis.com/drive/v3", "url: https://www.googleapis.com/drive/v2")).toContain(
			"built-in API",
		);
	});

	it("signs in at Google's fixed endpoints", async () => {
		const fetcher = vi.fn();
		await expect(discover("https://www.googleapis.com/drive/v3", fetcher)).resolves.toMatchObject({
			issuer: "https://accounts.google.com",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("names the account by the signed-in user's address", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ user: { emailAddress: "me@example.test", displayName: "Me" } }));
		expect(JSON.parse((await call(fetcher, "get_profile")).text)).toEqual({ email: "me@example.test" });
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)");
		expect(REST_APIS.drive.account).toEqual({ tool: "get_profile", field: "email" });
	});

	it("lists the newest files across drives, leaving out the trash", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				files: [
					{
						id: "1aBc_d-E",
						name: "Plan",
						mimeType: DOC,
						modifiedTime: "2026-11-05T16:42:10.000Z",
						owners: [{ displayName: "Ana" }],
						webViewLink: "https://docs.google.com/document/d/1aBc_d-E/edit",
					},
					{ id: "-leading", name: "Odd id", mimeType: "application/pdf" },
					{ id: "bad/id", mimeType: "image/png" },
				],
				nextPageToken: "p2",
			}),
		);
		const result = JSON.parse((await call(fetcher, "search_files", { page_token: "p1", max_results: 5 })).text);
		expect(result).toEqual({
			files: [
				{ ref: "drive/1aBc_d-E", name: "Plan", kind: "doc", modified: "2026-11-05T16:42:10.000Z", owner: "Ana" },
				{ name: "Odd id", kind: "pdf", modified: "", owner: "" },
				{ name: "(Untitled)", kind: "image", modified: "", owner: "" },
			],
			nextPageToken: "p2",
		});
		const url = urlOf(fetcher, 0);
		expect(url.pathname).toBe("/drive/v3/files");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: "trashed = false",
			pageSize: "5",
			fields: "nextPageToken,files(id,name,mimeType,modifiedTime,owners(displayName),webViewLink,size)",
			supportsAllDrives: "true",
			includeItemsFromAllDrives: "true",
			orderBy: "modifiedTime desc",
			pageToken: "p1",
		});
	});

	it("keeps a Drive search inside its parentheses, so trashed files stay out", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ files: [] }));
		for (const query of ["x') or (trashed = true", "name = 'a') or (name = 'b'", "trashed = true", "name = 'open"])
			expect((await call(fetcher, "search_files", { query })).isError).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
		expect((await call(fetcher, "search_files", { query: "name contains 'Q1 (draft)'" })).isError).toBe(false);
	});

	it("escapes words into one fullText term, ranked by relevance, beside a Drive query", async () => {
		expect(fullText("it's a \\ test")).toBe("fullText contains 'it\\'s a \\\\ test'");
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ files: [] }));
		await call(fetcher, "search_files", {
			text: "Ana's plan' or name contains 'x",
			query: "mimeType = 'application/pdf'",
		});
		const url = urlOf(fetcher, 0);
		expect(url.searchParams.get("q")).toBe(
			"trashed = false and (mimeType = 'application/pdf') and fullText contains 'Ana\\'s plan\\' or name contains \\'x'",
		);
		expect(url.searchParams.has("orderBy")).toBe(false);
		expect(url.searchParams.get("pageSize")).toBe("20");
		// a folder's newest files by when they were made: an old file edited never reads as new
		await call(fetcher, "search_files", { query: "'0Fold' in parents", order: "created" });
		expect(urlOf(fetcher, 1).searchParams.get("orderBy")).toBe("createdTime desc");
		expect(urlOf(fetcher, 1).searchParams.get("q")).toBe("trashed = false and ('0Fold' in parents)");
		const refused = vi.fn<typeof fetch>();
		for (const args of [
			{ query: "x".repeat(501) },
			{ text: "x".repeat(201) },
			{ text: 4 },
			{ page_token: "" },
			{ order: "name" },
		])
			expect((await call(refused, "search_files", args)).isError).toBe(true);
		expect(refused).not.toHaveBeenCalled();
	});

	it("reads one file's details for its card, keeping only Google's own pages", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				id: "1pDf",
				name: "Contract.pdf",
				mimeType: "application/pdf",
				modifiedTime: "2025-03-14T12:00:00.000Z",
				owners: [{ emailAddress: "mira@example.test" }],
				webViewLink: "https://drive.google.com/file/d/1pDf/view",
				iconLink: "https://drive-thirdparty.googleusercontent.com/icon.png",
				size: "2457600",
				description: "Signed",
				lastModifyingUser: { displayName: "Ana", emailAddress: "ana@example.test" },
				parents: ["0Fold", "bad/parent"],
				trashed: false,
				permissions: [
					{ id: "p1", type: "user", role: "owner", emailAddress: "mira@example.test", displayName: "Mira" },
					{ id: "p2", type: "user", role: "writer", emailAddress: "bo@example.test" },
					{ id: "p3", type: "domain", role: "reader", domain: "example.test" },
					{ id: "anyoneWithLink", type: "anyone", role: "reader" },
					{ type: "user", role: "reader", emailAddress: "noid@example.test" },
				],
			}),
		);
		const file = JSON.parse((await call(fetcher, "get_file", { file_id: "drive/1pDf" })).text);
		expect(file).toEqual({
			ref: "drive/1pDf",
			name: "Contract.pdf",
			kind: "pdf",
			mimeType: "application/pdf",
			owner: "mira@example.test",
			modified: "2025-03-14T12:00:00.000Z",
			size: 2457600,
			description: "Signed",
			url: "https://drive.google.com/file/d/1pDf/view",
			modifier: { name: "Ana", email: "ana@example.test" },
			parents: ["0Fold"],
			trashed: false,
			shared: [
				{ id: "p1", who: "Mira", role: "owner" },
				{ id: "p2", who: "bo@example.test", role: "writer" },
				{ id: "p3", who: "example.test", role: "reader" },
				{ id: "anyoneWithLink", who: "anyone with the link", role: "reader" },
			],
		});
		expect(urlOf(fetcher, 0).pathname).toBe("/drive/v3/files/1pDf");
		expect(urlOf(fetcher, 0).searchParams.get("fields")).toContain(
			"lastModifyingUser(displayName,emailAddress),parents,trashed,permissions(",
		);
		const elsewhere = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ id: "x", name: "x", mimeType: DOC, webViewLink: "https://evil.example/x" }));
		const odd = JSON.parse((await call(elsewhere, "get_file", { file_id: "x" })).text);
		expect(odd.url).toBeUndefined();
		expect(odd.size).toBeNull();
		// a file the account may not share lists nobody, rather than saying it is shared with nobody
		expect(odd).toMatchObject({ parents: [], trashed: false });
		expect(odd.shared).toBeUndefined();
		expect(odd.modifier).toBeUndefined();
	});

	it("names kinds by mime type", () => {
		expect(
			[
				DOC,
				"application/vnd.google-apps.spreadsheet",
				"application/vnd.google-apps.presentation",
				"application/vnd.google-apps.folder",
				"application/pdf",
				"image/jpeg",
				"application/zip",
				"",
			].map(kindOf),
		).toEqual(["doc", "sheet", "slides", "folder", "pdf", "image", "file", "file"]);
	});

	it("reads every tab of a Sheet through the Sheets API, as CSV under the tab's name", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "s1", name: "Economía", mimeType: SHEET }))
			.mockResolvedValueOnce(
				response({
					sheets: [
						{ properties: { title: "🏠", sheetType: "GRID" } },
						{ properties: { title: "chart", sheetType: "OBJECT" } },
						{ properties: { title: "Ana's", sheetType: "GRID" } },
						{ properties: { title: "vacía", sheetType: "GRID" } },
					],
				}),
			)
			.mockResolvedValueOnce(
				response({
					valueRanges: [
						{
							range: "'🏠'!A1:C2",
							values: [
								["ingresos", "", "a, b"],
								["€6,385.00", 'say "hi"'],
							],
						},
						{ range: "'Ana''s'!A1:A1", values: [["1"]] },
						{ range: "'vacía'!A1:Z1000" },
					],
				}),
			);
		const result = await read(fetcher, { file_id: "s1" });
		expect(result).toMatchObject({
			ref: "drive/s1",
			kind: "sheet",
			format: "text/csv",
			sheets: ["🏠", "chart", "Ana's", "vacía"],
			truncated: false,
		});
		expect(result.note).toBeUndefined();
		expect(result.text).toBe(
			[
				'## 🏠\ningresos,,"a, b"\n"€6,385.00","say ""hi"""',
				"## chart\n(a chart, no cells)",
				"## Ana's\n1",
				"## vacía\n(empty)",
			].join("\n\n"),
		);
		const book = urlOf(fetcher, 1);
		expect(book.origin).toBe("https://sheets.googleapis.com");
		expect(book.pathname).toBe("/v4/spreadsheets/s1");
		const values = urlOf(fetcher, 2);
		expect(values.pathname).toBe("/v4/spreadsheets/s1/values:batchGet");
		expect(values.searchParams.getAll("ranges")).toEqual(["'🏠'", "'Ana''s'", "'vacía'"]);
		expect(values.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
		expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer t" });
	});

	it("falls back to Drive's export of the first tab, and says so, when the Sheets API refuses; other refusals stand", async () => {
		const disabled = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "s1", name: "Economía", mimeType: SHEET }))
			.mockResolvedValueOnce(
				response({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, 403),
			)
			.mockResolvedValueOnce(textResponse("a,b\n1,2", "text/csv"));
		const result = await read(disabled, { file_id: "s1" });
		expect(result).toMatchObject({ format: "text/csv", text: "a,b\n1,2", truncated: false });
		expect(result.sheets).toBeUndefined();
		expect(result.note).toBe(
			"Only the first tab could be read, as Google Sheets answered 403 (SERVICE_DISABLED): the Google Sheets API is not enabled for banda's Google Cloud project. The other tabs, if any, are not shown.",
		);
		expect(urlOf(disabled, 2).pathname).toBe("/drive/v3/files/s1/export");
		expect(urlOf(disabled, 2).searchParams.get("mimeType")).toBe("text/csv");
		const gone = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "s1", name: "Economía", mimeType: SHEET }))
			.mockResolvedValueOnce(response({ error: { code: 404, status: "NOT_FOUND" } }, 404));
		expect(await call(gone, "read_file", { file_id: "s1" })).toEqual({
			text: "Google Sheets answered 404 (NOT_FOUND)",
			isError: true,
		});
		expect(gone).toHaveBeenCalledTimes(2);
	});

	it("exports each other Google kind in its text format", async () => {
		for (const [mimeType, format, body] of [
			[DOC, "text/markdown", "# Plan\n\n- dates"],
			["application/vnd.google-apps.presentation", "text/plain", "Slide one"],
		] as const) {
			const fetcher = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response({ id: "f1", name: "F", mimeType }))
				.mockResolvedValueOnce(textResponse(body, format));
			const result = await read(fetcher, { file_id: "f1" });
			expect(result).toMatchObject({ ref: "drive/f1", format, text: body, truncated: false });
			expect(result.note).toBeUndefined();
			const url = urlOf(fetcher, 1);
			expect(url.pathname).toBe("/drive/v3/files/f1/export");
			expect(url.searchParams.get("mimeType")).toBe(format);
		}
	});

	it("falls back to plain text when Google refuses a Doc as Markdown, and not for other refusals", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "d1", name: "Doc", mimeType: DOC }))
			.mockResolvedValueOnce(response({ error: { errors: [{ reason: "badRequest" }] } }, 400))
			.mockResolvedValueOnce(textResponse("Plain words"));
		expect(await read(fetcher, { file_id: "d1" })).toMatchObject({ format: "text/plain", text: "Plain words" });
		expect(urlOf(fetcher, 2).searchParams.get("mimeType")).toBe("text/plain");
		const denied = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "d1", name: "Doc", mimeType: DOC }))
			.mockResolvedValueOnce(response({ error: { errors: [{ reason: "exportSizeLimitExceeded" }] } }, 403));
		const result = await call(denied, "read_file", { file_id: "d1" });
		expect(result).toEqual({ text: "Google Drive answered 403 (exportSizeLimitExceeded)", isError: true });
		expect(denied).toHaveBeenCalledTimes(2);
	});

	it("downloads text, JSON and XML files as they are", async () => {
		for (const mimeType of ["text/plain", "text/markdown", "application/json", "application/xml"]) {
			const fetcher = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response({ id: "t1", name: "notes", mimeType }))
				.mockResolvedValueOnce(textResponse("hello\u0000 there\tnow\nnext", mimeType));
			const result = await read(fetcher, { file_id: "t1" });
			expect(result).toMatchObject({ format: mimeType, text: "hello there\tnow\nnext", truncated: false });
			const url = urlOf(fetcher, 1);
			expect(url.pathname).toBe("/drive/v3/files/t1");
			expect(url.searchParams.get("alt")).toBe("media");
		}
	});

	it("refuses a PDF, an image, a binary, a folder or another Google kind in words, without downloading", async () => {
		for (const [mimeType, words] of [
			["application/pdf", "This is a PDF (application/pdf); it cannot be read as text."],
			["image/png", "This is an image (image/png); it cannot be read as text."],
			["application/zip", "This is a binary file (application/zip); it cannot be read as text."],
			["application/vnd.google-apps.form", "This kind of Google file cannot be read as text."],
			["application/vnd.google-apps.folder", "search_files with query \"'f1' in parents\""],
		] as const) {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ id: "f1", name: "x", mimeType }));
			const result = await read(fetcher, { file_id: "f1" });
			expect(result).toMatchObject({ text: "", truncated: false });
			expect(result.note).toContain(words);
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
		const shortcut = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				id: "s1",
				name: "x",
				mimeType: "application/vnd.google-apps.shortcut",
				shortcutDetails: { targetId: "t9" },
			}),
		);
		expect((await read(shortcut, { file_id: "s1" })).note).toContain("drive/t9");
	});

	it("bounds the characters returned and the bytes read, and says when it cut", async () => {
		const short = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "t1", name: "n", mimeType: "text/plain" }))
			.mockResolvedValueOnce(textResponse("ééééé"));
		expect(await read(short, { file_id: "t1", max_chars: 3 })).toMatchObject({
			text: "ééé",
			truncated: true,
			note: "Cut short: this is the first 3 characters.",
		});
		const pulled = { bytes: 0 };
		const chunk = new TextEncoder().encode("é".repeat(512 * 1024));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled.bytes += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});
		const huge = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "t1", name: "n", mimeType: "text/csv" }))
			.mockResolvedValueOnce(new Response(stream, { status: 200 }));
		const result = await read(huge, { file_id: "t1", max_chars: 50_000 });
		expect(result.truncated).toBe(true);
		expect(result.text).toBe("é".repeat(50_000));
		expect(result.note).toBe("Cut short: this is the first 50000 characters (the file is over 4 MB).");
		expect(pulled.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
		const odd = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "t1", name: "n", mimeType: "text/plain" }))
			.mockResolvedValueOnce(new Response(new Uint8Array([0x61, 0xc3]), { status: 200 }));
		expect((await read(odd, { file_id: "t1" })).text).toBe("a�");
		const defaults = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ id: "t1", name: "n", mimeType: "text/plain" }))
			.mockResolvedValueOnce(textResponse("x".repeat(25_000)));
		expect((await read(defaults, { file_id: "t1" })).text).toHaveLength(20_000);
		const refused = vi.fn<typeof fetch>();
		for (const max_chars of [0, 50_001, 1.5, "10"])
			expect((await call(refused, "read_file", { file_id: "t1", max_chars })).isError).toBe(true);
		expect(refused).not.toHaveBeenCalled();
	});

	it("round-trips refs through the shipped object, and refuses malformed ids without a request", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ id: "1aBc_d-E", name: "Plan", mimeType: DOC, modifiedTime: "2026-11-05" }));
		const [found] = recognise("drive/1aBc_d-E", [{ name: "drive", objects: shipped().objects }]);
		expect(found).toMatchObject({ connection: "drive", kind: "file" });
		const args = readArgs(shipped().objects?.file?.reads.file ?? { tool: "", args: {} }, found!, undefined);
		const file = JSON.parse((await call(fetcher, "get_file", args)).text);
		expect(file.ref).toBe("drive/1aBc_d-E");
		expect(urlOf(fetcher, 0).pathname).toBe("/drive/v3/files/1aBc_d-E");
		expect(fileOfRef("drive/abc")).toBe("abc");
		const refused = vi.fn<typeof fetch>();
		for (const bad of ["", "drive/", "a/b", "../x", "a b", "a%2Fb", "x".repeat(201), "gmail/abc", "a?alt=media", 42]) {
			expect(fileOfRef(bad)).toBeUndefined();
			expect((await call(refused, "get_file", { file_id: bad })).isError).toBe(true);
			expect((await call(refused, "read_file", { file_id: bad })).isError).toBe(true);
		}
		expect(refused).not.toHaveBeenCalled();
	});

	it("lets the shared OAuth path refresh a rejected token, and never puts the URL or token in an error", async () => {
		await expect(
			call(vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 })), "get_profile"),
		).rejects.toThrow("Google Drive did not take the credentials");
		await expect(
			call(
				vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(response({ id: "d1", name: "Doc", mimeType: DOC }))
					.mockResolvedValueOnce(new Response("", { status: 401 })),
				"read_file",
				{ file_id: "d1" },
			),
		).rejects.toThrow("Google Drive did not take the credentials");
		const failing = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("secret-body https://www.googleapis.com/x", { status: 404 }));
		const result = await call(failing, "get_file", { file_id: "f1" }, "private-token");
		expect(result).toEqual({ text: "Google Drive answered 404", isError: true });
		expect(new Headers(failing.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer private-token");
		const disabled = vi.fn<typeof fetch>().mockResolvedValue(
			response(
				{
					error: {
						code: 403,
						message: "Google Drive API has not been used in project 1 https://console.developers.google.com/x",
						errors: [{ reason: "accessNotConfigured" }],
						details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
					},
				},
				403,
			),
		);
		const words = (await call(disabled, "get_profile")).text;
		expect(words).toBe(
			"Google Drive answered 403 (SERVICE_DISABLED): the Google Drive API is not enabled for banda's Google Cloud project",
		);
		expect(words).not.toContain("https://");
		expect((await call(failing, "create_file")).isError).toBe(true);
		expect((await (REST_APIS.drive as RestApi).write("t", "create_file", {})).isError).toBe(true);
	});

	it("draws a file card from bounded fields", () => {
		const kind = shipped().objects?.file;
		if (kind === undefined) throw new Error("no file kind");
		const ref = { connection: "drive", kind: "file", values: { id: "abc" } };
		const card = (file: Record<string, unknown>) => cardOf(kind, ref, { file });
		expect(
			card({
				name: "Plan‮\ncopy",
				kind: "doc",
				mimeType: DOC,
				owner: "Ana",
				modified: "2026-11-05T16:42:10.000Z",
				size: null,
				description: "Dates",
				url: "https://docs.google.com/document/d/abc/edit",
			}),
		).toEqual({
			card: "file",
			name: "Plan copy",
			kind: "doc",
			mimeType: DOC,
			owner: "Ana",
			modified: "2026-11-05T16:42:10.000Z",
			size: null,
			description: "Dates",
			url: "https://docs.google.com/document/d/abc/edit",
		});
		expect(
			card({
				name: "x",
				kind: "spreadsheet-ish",
				size: 12,
				url: "https://evil.example/file",
				description: "y".repeat(900),
			}),
		).toEqual({
			card: "file",
			name: "x",
			kind: "file",
			mimeType: "",
			owner: "",
			modified: "",
			size: 12,
			description: "y".repeat(500),
		});
		for (const url of ["http://drive.google.com/x", "https://drive.google.com:8443/x", "javascript:alert(1)"])
			expect(card({ name: "x", url })).not.toHaveProperty("url");
		expect(card({ name: "x", size: -1 })).toMatchObject({ size: null });
		expect(() => card({ name: "" })).toThrow("Incomplete object");
	});
});

describe("A file's comments", () => {
	it("lists open comments with their anchor and replies, resolved ones on request, without the authors' addresses", async () => {
		const page = {
			comments: [
				{
					id: "c1",
					content: "Dates?",
					resolved: false,
					createdTime: "2026-11-05T10:00:00.000Z",
					modifiedTime: "2026-11-05T11:00:00.000Z",
					author: { displayName: "Ana García", emailAddress: "ana@example.test" },
					quotedFileContent: { value: "Platform moves first" },
					replies: [
						{
							id: "r1",
							content: "Adding them",
							createdTime: "2026-11-05T11:00:00.000Z",
							author: { displayName: "Alice", me: true },
						},
					],
				},
				{ id: "c2", content: "Old", resolved: true, author: { displayName: "Teo" }, replies: [] },
			],
			nextPageToken: "more",
		};
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(page));
		const result = JSON.parse((await call(fetcher, "list_comments", { file_id: "drive/f1" })).text);
		expect(result).toEqual({
			ref: "drive/f1",
			comments: [
				{
					id: "c1",
					author: "Ana García",
					text: "Dates?",
					resolved: false,
					created: "2026-11-05T10:00:00.000Z",
					modified: "2026-11-05T11:00:00.000Z",
					anchor: "Platform moves first",
					replies: [{ id: "r1", author: "Alice", me: true, text: "Adding them", created: "2026-11-05T11:00:00.000Z" }],
				},
			],
			nextPageToken: "more",
		});
		expect(JSON.stringify(result)).not.toContain("ana@example.test");
		const url = urlOf(fetcher, 0);
		expect(url.pathname).toBe("/drive/v3/files/f1/comments");
		expect(url.searchParams.get("includeDeleted")).toBe("false");
		const all = JSON.parse(
			(await call(fetcher, "list_comments", { file_id: "f1", include_resolved: true, page_token: "more" })).text,
		);
		expect(all.comments.map((comment: { id: string }) => comment.id)).toEqual(["c1", "c2"]);
		expect(urlOf(fetcher, 1).searchParams.get("pageToken")).toBe("more");
	});
});
