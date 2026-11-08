import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type Credentials, givenFor, parseConnection } from "../src/core/connections.ts";
import {
	appendRequests,
	DRIVE_TOOLS,
	DRIVE_WRITES,
	driveDraft,
	driveExpand,
	driveWriteCall,
	keyHash,
	paragraphsOf,
	rangeArg,
	rowsOf,
} from "../src/core/drive-rest.ts";
import { REST_APIS, type RestApi } from "../src/core/rest.ts";
import { fakeDrive } from "./fixtures/google-drive.ts";

const FILE = "https://www.googleapis.com/auth/drive.file";
const ALL = "https://www.googleapis.com/auth/drive";
const CELLS = "https://www.googleapis.com/auth/spreadsheets";
const TEXT = "https://www.googleapis.com/auth/documents";
const SHEET_WRITES = ["append_rows", "update_range", "add_sheet"];
/** What each write needs, any one: the Drive write scopes, plus the narrow scope of a Sheet's or a Doc's own API. */
const needsOf = (tool: string) =>
	SHEET_WRITES.includes(tool) ? [CELLS, FILE, ALL] : tool === "append_doc_text" ? [TEXT, FILE, ALL] : [FILE, ALL];
const KEY = "8a7f0c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const write = (fetcher: typeof fetch, name: string, args: Record<string, unknown>, key: string | undefined = KEY) =>
	driveWriteCall("t", name, args, undefined, fetcher, key);
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const shipped = () => {
	const parsed = parseConnection(
		"drive",
		readFileSync(new URL("../shipped/connections/drive.md", import.meta.url), "utf8"),
	);
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	return parsed.connection;
};
const called = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, n: number) => {
	const [url, init] = fetcher.mock.calls[n] ?? [];
	const at = new URL(String(url));
	return {
		method: init?.method ?? "GET",
		path: at.pathname,
		params: Object.fromEntries(at.searchParams),
		type: (init?.headers as Record<string, string> | undefined)?.["content-type"],
		body: init?.body === undefined ? undefined : String(init.body),
	};
};

describe("Drive changes: what the registry and the shipped file say", () => {
	it("each write needs drive.file or drive (any one); a Sheet's cells also take spreadsheets, a Doc's text documents; reads stay on drive.readonly", () => {
		const connection = shipped();
		expect(connection.scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
		expect(Object.keys(connection.needs ?? {}).sort()).toEqual([...DRIVE_WRITES].sort());
		for (const [tool, anyOf] of Object.entries(connection.needs ?? {})) expect(anyOf, tool).toEqual(needsOf(tool));
		expect(REST_APIS.drive.scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly", FILE, CELLS, TEXT, ALL]);
		expect(REST_APIS.drive.required).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
		for (const tool of DRIVE_WRITES) expect(DRIVE_TOOLS.find((each) => each.name === tool)?.readOnlyHint).toBe(false);
		expect(connection.ask).toBeUndefined();
		// the owner approves exactly what was drafted: no field is edited, so no change is on a floor
		for (const tool of DRIVE_WRITES) {
			expect(REST_APIS.drive.drafts.editable(tool)).toEqual([]);
			expect(connection.floors[tool]).toBeUndefined();
		}
		expect(REST_APIS.drive.idempotent).toEqual([
			"create_doc",
			"create_sheet",
			"rename_file",
			"trash_file",
			"update_range",
			"add_sheet",
			"append_doc_text",
			"reply_comment",
		]);
		expect(connection.objects?.file?.writes?.map((write) => write.tool)).toEqual([
			"replace_doc_text",
			"rename_file",
			"trash_file",
			"append_rows",
			"update_range",
			"add_sheet",
			"append_doc_text",
			"reply_comment",
		]);
	});

	it("a sign-in may call a write with any one of the scopes it needs, and not with reads alone", () => {
		const granted = (scopes: string[]) => ({ oauth: { tokens: { scopes }, server: {} } }) as unknown as Credentials;
		const READ = "https://www.googleapis.com/auth/drive.readonly";
		for (const tool of DRIVE_WRITES) {
			expect(givenFor(granted([READ]), shipped(), tool)).toBe(false);
			expect(givenFor(granted([READ, FILE]), shipped(), tool)).toBe(true);
			expect(givenFor(granted([READ, ALL]), shipped(), tool)).toBe(true);
			// Change your spreadsheets alone reaches a Sheet's cells and tabs, Change your documents a Doc's text, and no other change
			expect(givenFor(granted([READ, CELLS]), shipped(), tool), tool).toBe(SHEET_WRITES.includes(tool));
			expect(givenFor(granted([READ, TEXT]), shipped(), tool), tool).toBe(tool === "append_doc_text");
		}
		expect(givenFor(granted([READ]), shipped(), "list_comments")).toBe(true);
		expect(givenFor(granted([READ]), shipped(), "read_file")).toBe(true);
	});

	it("words each draft for the owner, and takes a file's id out of its reference", () => {
		expect(driveDraft("create_doc", { title: "Q1 plan" })).toEqual({
			what: "Create the Doc “Q1 plan”",
			verb: "Create",
		});
		expect(driveDraft("create_sheet", { title: "Budget" })).toEqual({
			what: "Create the Sheet “Budget”",
			verb: "Create",
		});
		expect(driveDraft("replace_doc_text", {})?.what).toBe("Replace the text of this Doc");
		expect(driveDraft("rename_file", { name: "Plan v2" })?.what).toBe("Rename this file to “Plan v2”");
		expect(driveDraft("trash_file", {})?.what).toBe("Move this file to the trash");
		expect(driveDraft("append_rows", { sheet: "ops", rows: "a,b\n1,2\n" })?.what).toBe(
			"Add 2 rows to the tab “ops” of this Sheet",
		);
		expect(driveDraft("append_rows", { rows: "a,b" })).toEqual({ what: "Add a row to this Sheet", verb: "Add" });
		expect(driveDraft("update_range", { range: "'Budget 2027'!G4", rows: "95" })).toEqual({
			what: "Write “'Budget 2027'!G4” of this Sheet",
			verb: "Write",
		});
		expect(driveDraft("add_sheet", { title: "2028" })).toEqual({
			what: "Add the tab “2028” to this Sheet",
			verb: "Add",
		});
		expect(driveDraft("append_doc_text", { markdown: "x" })).toEqual({
			what: "Add text at the end of this Doc",
			verb: "Add",
		});
		expect(driveDraft("reply_comment", { text: "ok" })?.what).toBe("Reply to a comment on this file");
		expect(driveDraft("reply_comment", { text: "ok", resolve: true })?.what).toBe(
			"Reply to a comment on this file and resolve it",
		);
		expect(driveDraft("share_file", {})).toBeUndefined();
		expect(driveExpand("rename_file", { file_id: "drive/abc", name: "x" })).toEqual({ file_id: "abc", name: "x" });
	});
});

describe("Drive changes", () => {
	it("creates a Doc as one multipart upload of Markdown that Drive converts, after looking for it by its key", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ files: [] }))
			.mockResolvedValueOnce(json({ id: "newDoc1" }));
		const result = await write(fetcher, "create_doc", {
			title: "  Q1 plan ",
			markdown: "# Plan\n\n- one",
			folder_id: "drive/folder1",
		});
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: "drive/newDoc1" });
		const lookup = called(fetcher, 0);
		expect(lookup).toMatchObject({ method: "GET", path: "/drive/v3/files" });
		expect(lookup.params.q).toBe(
			`appProperties has { key='bandaKey' and value='${keyHash(KEY)}' } and trashed = false`,
		);
		const made = called(fetcher, 1);
		expect(made).toMatchObject({ method: "POST", path: "/upload/drive/v3/files" });
		expect(made.params).toMatchObject({ uploadType: "multipart", supportsAllDrives: "true" });
		const boundary = /^multipart\/related; boundary=(banda[0-9a-f]+)$/.exec(made.type ?? "")?.[1] as string;
		const parts = (made.body ?? "").split(`--${boundary}`);
		expect(parts[0]).toBe("");
		expect(parts[3]).toBe("--");
		expect(parts[1]).toContain("content-type: application/json");
		expect(JSON.parse(parts[1]?.split("\r\n\r\n")[1] ?? "")).toEqual({
			name: "Q1 plan",
			mimeType: "application/vnd.google-apps.document",
			appProperties: { bandaKey: keyHash(KEY) },
			parents: ["folder1"],
		});
		expect(parts[2]).toContain("content-type: text/markdown");
		expect(parts[2]?.split("\r\n\r\n")[1]).toBe("# Plan\n\n- one\r\n");
	});

	it("creates a Sheet from CSV, converted to a spreadsheet, in My Drive", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({}))
			.mockResolvedValueOnce(json({ id: "sheet1" }));
		const result = await write(fetcher, "create_sheet", { title: "Budget", csv: "a,b\n1,2" });
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: "drive/sheet1" });
		const body = called(fetcher, 1).body ?? "";
		expect(body).toContain('"mimeType":"application/vnd.google-apps.spreadsheet"');
		expect(body).not.toContain("parents");
		expect(body).toContain("content-type: text/csv");
		expect(body).toContain("a,b\n1,2");
	});

	it("a boundary never appears in the content it frames", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ files: [] }))
			.mockResolvedValueOnce(json({ id: "x1" }));
		await write(fetcher, "create_doc", { title: "T", markdown: "--banda0000\r\n--banda1111--" });
		const made = called(fetcher, 1);
		const boundary = /boundary=(\S+)/.exec(made.type ?? "")?.[1] as string;
		expect((made.body ?? "").split(`--${boundary}`)).toHaveLength(4);
	});

	it("a create run again with the same key finds the file and makes no second; another key makes one", async () => {
		const drive = fakeDrive();
		const args = { title: "Q1 plan", markdown: "# Plan" };
		const first = JSON.parse((await write(drive.fetch, "create_doc", args)).text);
		const again = JSON.parse((await write(drive.fetch, "create_doc", args)).text);
		expect(again).toEqual(first);
		expect(Object.keys(drive.files())).toHaveLength(1);
		expect(drive.writes).toHaveLength(1);
		const other = JSON.parse((await write(drive.fetch, "create_doc", args, "another key")).text);
		expect(other.ref).not.toBe(first.ref);
		expect(Object.keys(drive.files())).toHaveLength(2);
	});

	it("refuses before any request: no key, no title, text over the bound, a bad folder", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const ok = { title: "T", markdown: "m" };
		expect((await write(fetcher, "create_doc", ok, "")).text).toBe(
			"A Drive change runs only as the owner approved it.",
		);
		expect((await write(fetcher, "create_doc", { ...ok, title: "  " })).text).toBe("Give a title.");
		expect((await write(fetcher, "create_doc", { ...ok, title: "x".repeat(501) })).text).toContain("at most 500");
		expect((await write(fetcher, "create_doc", { ...ok, markdown: "x".repeat(200_001) })).text).toContain(
			"at most 200000",
		);
		expect((await write(fetcher, "create_doc", { ok: 1, title: "T" })).text).toBe("Give the Doc's Markdown.");
		expect((await write(fetcher, "create_sheet", { title: "T", csv: 3 })).text).toBe("Give the Sheet's CSV.");
		expect((await write(fetcher, "create_doc", { ...ok, folder_id: "a/../b" })).text).toContain("drive/<id>");
		expect((await write(fetcher, "replace_doc_text", { file_id: "a b", markdown: "m" })).text).toContain("drive/<id>");
		expect(
			(await write(fetcher, "replace_doc_text", { file_id: "abc", markdown: "x".repeat(200_001) })).text,
		).toContain("at most");
		expect((await write(fetcher, "rename_file", { file_id: "abc", name: " " })).text).toBe("Give a name.");
		expect((await write(fetcher, "trash_file", {})).isError).toBe(true);
		expect((await write(fetcher, "share_file", { file_id: "abc" })).text).toBe("That Drive change is not available.");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("replaces a Doc's text by a media upload, after reading that it is a live Doc", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				json({
					id: "d1",
					mimeType: "application/vnd.google-apps.document",
					modifiedTime: "2026-11-05T16:42:10.000Z",
					trashed: false,
				}),
			)
			.mockResolvedValueOnce(json({ id: "d1" }));
		const result = await write(fetcher, "replace_doc_text", {
			file_id: "drive/d1",
			markdown: "# New",
			modified: "2026-11-05T16:42:10Z",
		});
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: "drive/d1" });
		expect(called(fetcher, 0).params.fields).toBe("id,mimeType,modifiedTime,trashed");
		expect(called(fetcher, 1)).toMatchObject({
			method: "PATCH",
			path: "/upload/drive/v3/files/d1",
			params: { uploadType: "media" },
			type: "text/markdown; charset=UTF-8",
			body: "# New",
		});
	});

	it("refuses a replace of something that is not a live Doc, or that changed since it was read", async () => {
		const doc = {
			id: "d1",
			mimeType: "application/vnd.google-apps.document",
			modifiedTime: "2026-11-06T10:00:00.000Z",
		};
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(doc));
		const changed = await write(fetcher, "replace_doc_text", {
			file_id: "d1",
			markdown: "m",
			modified: "2026-11-05T16:42:10.000Z",
		});
		expect(changed).toEqual({
			text: "The Doc changed since you read it: read it again, then draft the change anew.",
			isError: true,
		});
		fetcher.mockImplementation(async () => json({ ...doc, mimeType: "application/pdf" }));
		expect((await write(fetcher, "replace_doc_text", { file_id: "d1", markdown: "m" })).text).toBe(
			"Only a Google Doc's text can be replaced.",
		);
		fetcher.mockImplementation(async () => json({ ...doc, trashed: true }));
		expect((await write(fetcher, "replace_doc_text", { file_id: "d1", markdown: "m" })).text).toBe(
			"That file is in the trash.",
		);
		expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
		expect(
			(await write(fetcher, "replace_doc_text", { file_id: "d1", markdown: "m", modified: "soon" })).text,
		).toContain("Give modified");
	});

	it("renames and trashes as metadata updates, and does nothing when the file already is so", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ id: "f1", name: "Old" }))
			.mockResolvedValueOnce(json({ id: "f1" }));
		expect(JSON.parse((await write(fetcher, "rename_file", { file_id: "f1", name: " New " })).text)).toEqual({
			ok: true,
			ref: "drive/f1",
		});
		expect(called(fetcher, 1)).toMatchObject({ method: "PATCH", path: "/drive/v3/files/f1", body: '{"name":"New"}' });
		fetcher.mockReset();
		fetcher.mockResolvedValueOnce(json({ id: "f1", name: "New" }));
		expect((await write(fetcher, "rename_file", { file_id: "f1", name: "New" })).isError).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(1);

		fetcher.mockReset();
		fetcher.mockResolvedValueOnce(json({ id: "f1", trashed: false })).mockResolvedValueOnce(json({ id: "f1" }));
		await write(fetcher, "trash_file", { file_id: "f1" });
		expect(called(fetcher, 1)).toMatchObject({ method: "PATCH", body: '{"trashed":true}' });
		fetcher.mockReset();
		fetcher.mockResolvedValueOnce(json({ id: "f1", trashed: true }));
		expect(JSON.parse((await write(fetcher, "trash_file", { file_id: "f1" })).text)).toEqual({
			ok: true,
			ref: "drive/f1",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("says in words when Drive cannot find the file, and keeps URLs, bodies and tokens out of errors", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () =>
				json({ error: { code: 404, message: "https://secret/x", status: "NOT_FOUND" } }, 404),
			);
		const gone = await write(fetcher, "trash_file", { file_id: "f1" });
		expect(gone.isError).toBe(true);
		expect(gone.text).toContain("could not find that file");
		const refused = vi.fn<typeof fetch>().mockImplementation(async () =>
			json(
				{
					error: { code: 403, message: "https://secret/x Bearer t", errors: [{ reason: "insufficientPermissions" }] },
				},
				403,
			),
		);
		const text = (await write(refused, "rename_file", { file_id: "f1", name: "n" })).text;
		expect(text).toBe("Google Drive answered 403 (insufficientPermissions)");
		expect(text).not.toMatch(/secret|Bearer|https/);
		const broken = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response("<html>token t</html>", { status: 200 }));
		expect((await write(broken, "rename_file", { file_id: "f1", name: "n" })).text).toBe(
			"Google Drive answered something that is not JSON",
		);
	});

	it("is not retried when Drive is busy: it may have applied the change", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ files: [] }, 503));
		await write(fetcher, "create_doc", { title: "T", markdown: "m" });
		// the lookup is a read and retries; the upload is never reached
		const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
		expect(posts).toHaveLength(0);
		const busy = vi
			.fn<typeof fetch>()
			.mockImplementation(async (_url, init) => (init?.method === "POST" ? json({}, 503) : json({ files: [] })));
		const result = await write(busy, "create_doc", { title: "T", markdown: "m" });
		expect(result.isError).toBe(true);
		expect(busy.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
	});

	it("registry write runs through REST_APIS with the effect's key", async () => {
		const drive = fakeDrive();
		const api = REST_APIS.drive as RestApi;
		const result = await api.write("t", "create_doc", { title: "T", markdown: "m" }, undefined, drive.fetch, [], KEY);
		expect(JSON.parse(result.text).ref).toMatch(/^drive\//);
	});
});

describe("A Sheet's cells", () => {
	it("reads rows from CSV as Sheets takes them: quotes, commas and line breaks inside, formulas as text", () => {
		expect(rowsOf('a,b\n"x, y","say ""hi"""\n=SUM(A1:A2),\n')).toEqual([
			["a", "b"],
			["x, y", 'say "hi"'],
			["=SUM(A1:A2)", ""],
		]);
		expect(rowsOf("one\r\ntwo")).toEqual([["one"], ["two"]]);
		expect(rowsOf('"multi\nline",2')).toEqual([["multi\nline", "2"]]);
		expect(rowsOf("")).toEqual([]);
		expect(() => rowsOf('"open')).toThrow(/quotes close/);
	});

	it("takes a range in A1 notation with its tab quoted as Sheets wants, and refuses a whole tab or nonsense", () => {
		expect(rangeArg({ range: "G4" })).toBe("G4");
		expect(rangeArg({ range: "ops!A2:H2" })).toBe("'ops'!A2:H2");
		expect(rangeArg({ range: "'Budget 2027'!G4" })).toBe("'Budget 2027'!G4");
		expect(rangeArg({ range: "'Ana''s'!B:B" })).toBe("'Ana''s'!B:B");
		expect(rangeArg({ range: "🏠!G4" })).toBe("'🏠'!G4");
		for (const bad of ["ops", "ops!", "!A1", "ops!A", "ops!1", "a".repeat(301), 3])
			expect(() => rangeArg({ range: bad }), String(bad)).toThrow(/A1 notation|tab's name/);
	});

	const sheetMeta = {
		id: "s1",
		mimeType: "application/vnd.google-apps.spreadsheet",
		modifiedTime: "2026-11-01T09:47:37.699Z",
	};

	it("appends rows to the named tab, or the first, after checking the Sheet and its modified time", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(sheetMeta))
			.mockResolvedValueOnce(json({ updates: { updatedRange: "'ops'!A175:H175", updatedRows: 1 } }));
		const result = await write(fetcher, "append_rows", {
			file_id: "drive/s1",
			sheet: "ops",
			rows: '2026-11-08,MSFT,BUY - MARKET,2,$530.61,"$1,061.22",USD,1.1552',
			modified: "2026-11-01T09:47:37.699Z",
		});
		expect(JSON.parse(result.text)).toEqual({
			ok: true,
			ref: "drive/s1",
			sheet: "ops",
			rows: 1,
			range: "'ops'!A175:H175",
		});
		const appended = called(fetcher, 1);
		expect(appended).toMatchObject({ method: "POST", path: "/v4/spreadsheets/s1/values/'ops':append" });
		expect(appended.params).toMatchObject({ valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" });
		expect(JSON.parse(appended.body ?? "")).toEqual({
			majorDimension: "ROWS",
			values: [["2026-11-08", "MSFT", "BUY - MARKET", "2", "$530.61", "$1,061.22", "USD", "1.1552"]],
		});
		expect(new URL(String(fetcher.mock.calls[1]?.[0])).origin).toBe("https://sheets.googleapis.com");

		const first = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(sheetMeta))
			.mockResolvedValueOnce(json({ sheets: [{ properties: { title: "🏠" } }, { properties: { title: "2027" } }] }))
			.mockResolvedValueOnce(json({ updates: {} }));
		expect(JSON.parse((await write(first, "append_rows", { file_id: "s1", rows: "a" })).text)).toEqual({
			ok: true,
			ref: "drive/s1",
			sheet: "🏠",
			rows: 1,
		});
		expect(called(first, 2).path).toBe(`/v4/spreadsheets/s1/values/${encodeURIComponent("'🏠'")}:append`);

		const changed = vi.fn<typeof fetch>().mockResolvedValueOnce(json(sheetMeta));
		expect(
			await write(changed, "append_rows", { file_id: "s1", rows: "a", modified: "2026-11-02T00:00:00.000Z" }),
		).toEqual({
			text: "The Sheet changed since you read it: read it again, then draft the change anew.",
			isError: true,
		});
		expect(changed).toHaveBeenCalledTimes(1);
		const doc = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ ...sheetMeta, mimeType: "application/vnd.google-apps.document" }));
		expect((await write(doc, "append_rows", { file_id: "s1", rows: "a" })).text).toBe("Only a Google Sheet has cells.");
	});

	it("writes cells of a range with one PUT, the same when run again", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(sheetMeta))
			.mockResolvedValueOnce(json({ updatedRange: "'🏠'!G4", updatedCells: 1 }));
		const result = await write(fetcher, "update_range", { file_id: "s1", range: "🏠!G4", rows: "95" });
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: "drive/s1", range: "'🏠'!G4", cells: 1 });
		const put = called(fetcher, 1);
		expect(put).toMatchObject({ method: "PUT", path: `/v4/spreadsheets/s1/values/${encodeURIComponent("'🏠'!G4")}` });
		expect(put.params).toMatchObject({ valueInputOption: "USER_ENTERED" });
		expect(JSON.parse(put.body ?? "")).toEqual({ majorDimension: "ROWS", values: [["95"]] });
		expect(
			(await write(vi.fn<typeof fetch>(), "update_range", { file_id: "s1", range: "ops", rows: "1" })).isError,
		).toBe(true);
	});

	it("adds a tab once: a tab of that name already there is left as it is", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(sheetMeta))
			.mockResolvedValueOnce(json({ sheets: [{ properties: { title: "🏠" } }] }))
			.mockResolvedValueOnce(json({ spreadsheetId: "s1" }));
		expect(JSON.parse((await write(fetcher, "add_sheet", { file_id: "s1", title: " 2028 " })).text)).toEqual({
			ok: true,
			ref: "drive/s1",
			sheet: "2028",
		});
		const added = called(fetcher, 2);
		expect(added).toMatchObject({ method: "POST", path: "/v4/spreadsheets/s1:batchUpdate" });
		expect(JSON.parse(added.body ?? "")).toEqual({ requests: [{ addSheet: { properties: { title: "2028" } } }] });
		const there = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(sheetMeta))
			.mockResolvedValueOnce(json({ sheets: [{ properties: { title: "2028" } }] }));
		expect(JSON.parse((await write(there, "add_sheet", { file_id: "s1", title: "2028" })).text)).toEqual({
			ok: true,
			ref: "drive/s1",
			sheet: "2028",
		});
		expect(there).toHaveBeenCalledTimes(2);
	});

	it("a Sheet Google does not find, or the sign-in may not change, is said so without its URL", async () => {
		const gone = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { code: 404, status: "NOT_FOUND" } }, 404));
		const result = await write(gone, "update_range", { file_id: "s9", range: "A1", rows: "1" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Change your spreadsheets");
		expect(result.text).not.toContain("http");
	});
});

describe("A Doc's text and a file's comments", () => {
	const docMeta = {
		id: "d1",
		mimeType: "application/vnd.google-apps.document",
		modifiedTime: "2026-11-05T16:42:10.000Z",
	};
	const body = (...paragraphs: string[]) => {
		let index = 1;
		return {
			body: {
				content: paragraphs.map((paragraph) => {
					const startIndex = index;
					index += paragraph.length + 1;
					return { startIndex, endIndex: index, paragraph: { elements: [{ textRun: { content: `${paragraph}\n` } }] } };
				}),
			},
		};
	};

	it("reads Markdown-lite as paragraphs: headings, bullets, text as written, blank lines dropped", () => {
		expect(paragraphsOf("## Decisions\r\n\r\n- one\n* two\n\nPlain **bold** text\n#### not a heading\n")).toEqual([
			{ text: "Decisions", heading: 2 },
			{ text: "one", bullet: true },
			{ text: "two", bullet: true },
			{ text: "Plain **bold** text" },
			{ text: "#### not a heading" },
		]);
	});

	it("builds the Docs requests: one insertion starting a new paragraph after words, then heading styles and one list per run of bullets", () => {
		const paragraphs = paragraphsOf("## Decisions\n- one\n- two\nAfter\n- three");
		const requests = appendRequests(paragraphs, 20, "last words");
		expect(requests[0]).toEqual({
			insertText: { location: { index: 20 }, text: "\nDecisions\none\ntwo\nAfter\nthree" },
		});
		// "Decisions" starts after the lead's line break, at 21, and ends with its own line break, at 31
		expect(requests[1]).toEqual({
			updateParagraphStyle: {
				range: { startIndex: 21, endIndex: 31 },
				paragraphStyle: { namedStyleType: "HEADING_2" },
				fields: "namedStyleType",
			},
		});
		expect(requests.slice(2)).toEqual([
			{
				createParagraphBullets: { range: { startIndex: 31, endIndex: 39 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
			},
			{
				createParagraphBullets: { range: { startIndex: 45, endIndex: 51 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
			},
		]);
		// an empty last paragraph takes the text without a lead
		expect(appendRequests([{ text: "a" }], 5, "")[0]).toEqual({ insertText: { location: { index: 5 }, text: "a" } });
	});

	it("adds text at the end of a Doc once: a Doc that already ends in it is left as it is", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(docMeta))
			.mockResolvedValueOnce(json(body("Title", "last words")))
			.mockResolvedValueOnce(json({ documentId: "d1" }));
		const result = await write(fetcher, "append_doc_text", {
			file_id: "drive/d1",
			markdown: "## Decisions\n- one",
			modified: "2026-11-05T16:42:10.000Z",
		});
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: "drive/d1", paragraphs: 2 });
		expect(called(fetcher, 1)).toMatchObject({ method: "GET", path: "/v1/documents/d1" });
		expect(new URL(String(fetcher.mock.calls[1]?.[0])).origin).toBe("https://docs.googleapis.com");
		const update = called(fetcher, 2);
		expect(update).toMatchObject({ method: "POST", path: "/v1/documents/d1:batchUpdate" });
		// "Title\n" is 1..7, "last words\n" 7..18: the text goes before the final line break, at 17
		expect(JSON.parse(update.body ?? "")).toEqual({
			requests: appendRequests(paragraphsOf("## Decisions\n- one"), 17, "last words"),
		});
		const there = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(docMeta))
			.mockResolvedValueOnce(json(body("Title", "last words", "Decisions", "one")));
		expect(
			JSON.parse((await write(there, "append_doc_text", { file_id: "d1", markdown: "## Decisions\n- one" })).text),
		).toEqual({ ok: true, ref: "drive/d1", paragraphs: 2 });
		expect(there).toHaveBeenCalledTimes(2);
		const changed = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json(docMeta))
			.mockResolvedValueOnce(json(body("Title")));
		expect(
			(await write(changed, "append_doc_text", { file_id: "d1", markdown: "x", modified: "2026-11-06T00:00:00.000Z" }))
				.text,
		).toBe("The Doc changed since you read it: read it again, then draft the change anew.");
		const sheet = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ ...docMeta, mimeType: "application/vnd.google-apps.spreadsheet" }));
		expect((await write(sheet, "append_doc_text", { file_id: "d1", markdown: "x" })).text).toBe(
			"Only a Google Doc takes text.",
		);
	});

	it("replies to a comment once, resolving it when asked; a reply of the owner's with the same words is not posted again", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				json({ id: "c1", resolved: false, replies: [{ content: "Other", author: { me: false } }] }),
			)
			.mockResolvedValueOnce(json({ id: "r2" }));
		const result = await write(fetcher, "reply_comment", {
			file_id: "drive/f1",
			comment_id: "c1",
			text: " Done: dates added. ",
			resolve: true,
		});
		expect(JSON.parse(result.text)).toEqual({ ok: true, ref: "drive/f1", comment: "c1", resolved: true });
		expect(called(fetcher, 0)).toMatchObject({ method: "GET", path: "/drive/v3/files/f1/comments/c1" });
		const posted = called(fetcher, 1);
		expect(posted).toMatchObject({ method: "POST", path: "/drive/v3/files/f1/comments/c1/replies" });
		expect(JSON.parse(posted.body ?? "")).toEqual({ content: "Done: dates added.", action: "resolve" });
		const there = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ id: "c1", replies: [{ content: "Done: dates added.", author: { me: true } }] }));
		expect(
			JSON.parse(
				(await write(there, "reply_comment", { file_id: "f1", comment_id: "c1", text: "Done: dates added." })).text,
			),
		).toEqual({ ok: true, ref: "drive/f1", comment: "c1" });
		expect(there).toHaveBeenCalledTimes(1);
		expect(
			(await write(vi.fn<typeof fetch>(), "reply_comment", { file_id: "f1", comment_id: "../x", text: "a" })).text,
		).toBe("Give the comment's id, as list_comments gave it.");
	});
});
