/**
 * A fake Google Drive for the write tests, as a `fetch`: the sign-in's token endpoint, the account's profile, and files
 * made by a multipart upload (converted to a Google file), read, listed by `appProperties`, renamed, trashed and given
 * new text by a media upload. With `file`, its files are kept there, written whole before it answers, so a process
 * killed after Drive applied a change and before banda recorded it leaves the change applied, as the real one would.
 * A spreadsheet's tabs and cells answer the Sheets API: listed, read, appended to, written and added, under
 * `tabs` (names in order) and `cells` (rows by tab) of the file.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type FakeFile = { [key: string]: unknown };
export type FakeDrive = {
	readonly fetch: typeof fetch;
	/** Files by id. */
	files(): { [id: string]: FakeFile };
	/** Each request a change made: its method and path (with the upload prefix when it was one). */
	readonly writes: { method: string; path: string; body?: unknown }[];
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GOOGLE = "https://www.googleapis.com/auth/";

export function fakeDrive({
	file,
	email = "alice@example.test",
	seed = {},
}: {
	file?: string;
	email?: string;
	seed?: { [id: string]: FakeFile };
} = {}): FakeDrive {
	let memory: { [id: string]: FakeFile } = structuredClone(seed);
	const load = () =>
		file === undefined
			? memory
			: existsSync(file)
				? (JSON.parse(readFileSync(file, "utf8")) as { [id: string]: FakeFile })
				: structuredClone(seed);
	const save = (files: { [id: string]: FakeFile }) => {
		if (file === undefined) memory = files;
		else {
			writeFileSync(`${file}.tmp`, JSON.stringify(files));
			renameSync(`${file}.tmp`, file);
		}
	};
	const writes: FakeDrive["writes"] = [];
	/** A tab's name from an A1 range: quoted (with doubled quotes) or bare before `!`; the first tab when none. */
	const tabOf = (range: string, tabs: string[]) => {
		const at = range.lastIndexOf("!");
		const named = at === -1 && !/^[A-Z$]/.test(range) ? range : at === -1 ? undefined : range.slice(0, at);
		if (named === undefined) return { tab: tabs[0], cells: range };
		const bare = /^'(.*)'$/s.exec(named)?.[1]?.replaceAll("''", "'") ?? named;
		return { tab: tabs.includes(bare) ? bare : undefined, cells: at === -1 ? "" : range.slice(at + 1) };
	};
	const column = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
	const sheetsApi = (url: URL, method: string, raw: string | undefined) => {
		const files = load();
		const path = url.pathname.replace(/^\/v4\//, "");
		const id = /^spreadsheets\/([^/:]+)/.exec(path)?.[1];
		const found = id === undefined ? undefined : files[decodeURIComponent(id)];
		if (found === undefined || found.mimeType !== "application/vnd.google-apps.spreadsheet" || found.trashed === true)
			return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
		const tabs = (found.tabs as string[] | undefined) ?? ["Sheet1"];
		const cells = (found.cells as { [tab: string]: string[][] } | undefined) ?? {};
		const rest = path.slice(`spreadsheets/${id}`.length);
		const body = raw === undefined ? {} : (JSON.parse(raw) as { values?: string[][]; requests?: unknown[] });
		const touched = () => {
			found.tabs = tabs;
			found.cells = cells;
			found.modifiedTime = new Date().toISOString();
			save(files);
		};
		if (rest === "" && method === "GET")
			return json({ sheets: tabs.map((title) => ({ properties: { title, sheetType: "GRID" } })) });
		if (rest === "/values:batchGet" && method === "GET")
			return json({
				valueRanges: url.searchParams.getAll("ranges").map((range) => {
					const { tab } = tabOf(range, tabs);
					const rows = tab === undefined ? [] : (cells[tab] ?? []);
					return { range, majorDimension: "ROWS", ...(rows.length === 0 ? {} : { values: rows }) };
				}),
			});
		const valuesAt = /^\/values\/([^:]+)(:append)?$/.exec(rest);
		if (valuesAt !== null) {
			const { tab, cells: at } = tabOf(decodeURIComponent(valuesAt[1] ?? ""), tabs);
			if (tab === undefined) return json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400);
			const values = body.values ?? [];
			if (cells[tab] === undefined) cells[tab] = [];
			const rows = cells[tab];
			if (valuesAt[2] === ":append" && method === "POST") {
				writes.push({ method, path: `sheets/${id}/values/${tab}:append`, body: values });
				const from = rows.length;
				rows.push(...values);
				touched();
				return json({ updates: { updatedRange: `'${tab}'!A${from + 1}`, updatedRows: values.length } });
			}
			if (valuesAt[2] === undefined && method === "PUT") {
				const start = /^\$?([A-Z]+)\$?(\d+)/i.exec(at);
				if (start === null) return json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400);
				const [row0, col0] = [Number(start[2]) - 1, column(start[1] ?? "A")];
				let count = 0;
				values.forEach((row, r) => {
					if (rows[row0 + r] === undefined) rows[row0 + r] = [];
					const target = rows[row0 + r] as string[];
					row.forEach((value, c) => {
						target[col0 + c] = value;
						count++;
					});
				});
				writes.push({ method, path: `sheets/${id}/values/${tab}!${at}`, body: values });
				touched();
				return json({ updatedRange: `'${tab}'!${at}`, updatedCells: count });
			}
		}
		if (rest === ":batchUpdate" && method === "POST") {
			for (const request of body.requests ?? []) {
				const title = (request as { addSheet?: { properties?: { title?: string } } }).addSheet?.properties?.title;
				if (title === undefined) return json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400);
				if (tabs.includes(title))
					return json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "already exists" } }, 400);
				writes.push({ method, path: `sheets/${id}:batchUpdate`, body: { addSheet: title } });
				tabs.push(title);
			}
			touched();
			return json({ spreadsheetId: id });
		}
		return json({ error: { code: 405 } }, 405);
	};
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const method = init?.method ?? "GET";
		const raw = typeof init?.body === "string" ? init.body : undefined;
		const type = (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "";
		if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token")
			return json({
				access_token: "fake-drive-access-token",
				refresh_token: "fake-drive-refresh-token",
				expires_in: 3600,
				scope: `${GOOGLE}drive.readonly ${GOOGLE}drive.file ${GOOGLE}drive`,
			});
		if (url.origin === "https://sheets.googleapis.com") return sheetsApi(url, method, raw);
		if (url.origin !== "https://www.googleapis.com") return json({ error: { code: 404 } }, 404);
		const upload = url.pathname.startsWith("/upload/drive/v3/");
		if (!upload && !url.pathname.startsWith("/drive/v3/")) return json({ error: { code: 404 } }, 404);
		const path = url.pathname.slice(upload ? "/upload/drive/v3/".length : "/drive/v3/".length);
		if (path === "about") return json({ user: { emailAddress: email } });
		const files = load();
		const note = (body?: unknown) => {
			if (method !== "GET")
				writes.push({ method, path: `${upload ? "upload/" : ""}${path}`, ...(body === undefined ? {} : { body }) });
		};
		if (path === "files" && method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			const wanted = /appProperties has \{ key='bandaKey' and value='([0-9a-f]+)' \}/.exec(q)?.[1];
			const found = Object.values(files).filter(
				(each) =>
					(wanted === undefined || (each.appProperties as { bandaKey?: string } | undefined)?.bandaKey === wanted) &&
					each.trashed !== true,
			);
			return json({ files: found.map((each) => ({ id: each.id })) });
		}
		if (path === "files" && method === "POST" && upload) {
			const boundary = /boundary=(\S+)/.exec(type)?.[1] ?? "";
			const parts = (raw ?? "").split(`--${boundary}`).slice(1, -1);
			const split = (part: string) => {
				const at = part.indexOf("\r\n\r\n");
				return { headers: part.slice(0, at).toLowerCase(), content: part.slice(at + 4, -2) };
			};
			const [metadata, media] = parts.map(split);
			const given = JSON.parse(metadata?.content ?? "{}") as FakeFile;
			note({
				metadata: given,
				mediaType: /content-type: ([^;\r\n]+)/.exec(media?.headers ?? "")?.[1],
				media: media?.content,
			});
			const id = `drv${Object.keys(files).length + 1}x${Math.abs([...(media?.content ?? "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
			files[id] = { ...given, id, trashed: false, text: media?.content ?? "", modifiedTime: new Date().toISOString() };
			save(files);
			return json({ id });
		}
		const id = /^files\/([^/]+)$/.exec(path)?.[1];
		const found = id === undefined ? undefined : files[decodeURIComponent(id)];
		if (found === undefined) return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
		if (method === "GET") return json(found);
		if (method === "PATCH" && upload) {
			note({ mediaType: type, media: raw });
			found.text = raw ?? "";
			found.version = Number(found.version ?? 1) + 1;
			found.modifiedTime = new Date().toISOString();
			save(files);
			return json({ id: found.id });
		}
		if (method === "PATCH") {
			const body = raw === undefined ? undefined : (JSON.parse(raw) as FakeFile);
			note(body);
			Object.assign(found, body);
			save(files);
			return json({ id: found.id });
		}
		return json({ error: { code: 405 } }, 405);
	}) as typeof fetch;
	return { fetch: fetcher, files: load, writes };
}
