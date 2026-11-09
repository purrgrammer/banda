/**
 * What a file shows before it is opened, drawn by the daemon from its bytes (DESIGN.md "Files are rich wherever they
 * appear"): a PDF's page count, title and first page's text, a sheet's first rows, a document's first paragraphs, a
 * text or code file's first lines. Pure.
 *
 * Every byte here may be the box's, so nothing is executed and every reading is bounded: a capped share of the file
 * is read, every inflate has a ceiling and the whole a budget, parsers nest to a fixed depth and count what they visit,
 * and scans look for the next marker with indexOf, never a backtracking pattern. What cannot be read falls back to the
 * plainest answer (the kind without its content, or `file`), never an exception.
 */
import { constants, inflateRawSync, inflateSync } from "node:zlib";

export type Preview =
	| { readonly kind: "image" }
	| { readonly kind: "audio" }
	| { readonly kind: "video" }
	/** pages: the page count (0 when unknown); title: /Info /Title; lines: the first page's text (may be empty: fonts that cannot be decoded, encrypted, scanned). */
	| { readonly kind: "pdf"; readonly pages: number; readonly title?: string; readonly lines: readonly string[] }
	/** rows: the first rows (the first is the header as written), each at most 12 cells of at most 200 chars; total: the sheet's rows, header included. */
	| { readonly kind: "sheet"; readonly rows: readonly (readonly string[])[]; readonly total: number }
	/** A word-processor document (.docx): its first non-empty paragraphs. */
	| { readonly kind: "document"; readonly lines: readonly string[] }
	/** Text or code: its first lines verbatim (tabs kept, other control characters removed, 400 chars each), the Shiki language id when it is code, and its line count. */
	| { readonly kind: "text"; readonly lines: readonly string[]; readonly total: number; readonly language?: string }
	| { readonly kind: "file" };

export type PreviewLimits = { readonly lines: number; readonly rows: number };
/** The card's glimpse; the viewer asks for more (FULL). */
export const GLIMPSE: PreviewLimits = { lines: 12, rows: 6 };
export const FULL: PreviewLimits = { lines: 2000, rows: 500 };

const MB = 1024 * 1024;
/** Text and CSV are read from this much of a file at most; a longer one is counted as far as that. */
const TEXT_BYTES = 32 * MB;
const PDF_BYTES = 64 * MB;
const STREAM_BYTES = 4 * MB;
const INFLATE_BUDGET = 16 * MB;
const ZIP_ENTRY_BYTES = 16 * MB;
const MAX_OBJECTS = 500_000;
const MAX_RECORDS = 1_000_000;
const LINE_CHARS = 400;
const CELL_CHARS = 200;
const CELLS = 12;

export function preview(name: string, mimeType: string, bytes: Uint8Array, limits: PreviewLimits = GLIMPSE): Preview {
	const bounded = { lines: clamp(limits.lines), rows: clamp(limits.rows) };
	try {
		return sniff(name, mimeType.toLowerCase(), bytes, bounded);
	} catch {
		// every reader below is written not to throw; this is the floor beneath them
		return { kind: "file" };
	}
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100_000, Math.floor(n))) : 0);

// ---------------------------------------------------------------------------------------------------------------------
// The kind: the bytes first, then the name and the type

function sniff(name: string, mime: string, bytes: Uint8Array, limits: PreviewLimits): Preview {
	const head = latin1(bytes.subarray(0, 1024));
	if (head.includes("%PDF-")) return pdfPreview(bytes, limits);
	if (head.startsWith("PK\x03\x04")) return officePreview(bytes, limits);
	if (
		head.startsWith("\x89PNG\r\n\x1a\n") ||
		head.startsWith("\xff\xd8\xff") ||
		head.startsWith("GIF8") ||
		(head.startsWith("RIFF") && head.slice(8, 12) === "WEBP")
	)
		return { kind: "image" };
	const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot + 1) : "";
	if (ext === "csv" || ext === "tsv" || mime === "text/csv" || mime === "text/tab-separated-values") {
		if (!textual(bytes)) return { kind: "file" };
		const tab = ext === "tsv" || mime === "text/tab-separated-values";
		return csvPreview(readText(bytes), tab ? "\t" : undefined, limits);
	}
	if (mime.startsWith("audio/") || AUDIO.has(ext)) return { kind: "audio" };
	if (mime.startsWith("video/") || VIDEO.has(ext)) return { kind: "video" };
	// SVG can carry script, so it is shown as the markup it is, never drawn
	const language =
		ext === "svg" || mime === "image/svg+xml"
			? "xml"
			: (NAMES.get(base) ?? LANGUAGES.get(ext) ?? MIME_LANGUAGES.get(mime));
	const isText =
		language !== undefined ||
		PLAIN.has(ext) ||
		PLAIN.has(base) ||
		mime.startsWith("text/") ||
		mime.endsWith("+json") ||
		mime.endsWith("+xml");
	if (!isText || !textual(bytes)) return { kind: "file" };
	return textPreview(readText(bytes), limits, language);
}

const AUDIO = new Set(["mp3", "m4a", "wav", "ogg", "opus", "flac", "aac", "oga"]);
const VIDEO = new Set(["mp4", "mov", "webm", "m4v", "mkv"]);
const PLAIN = new Set(["txt", "text", "log", "rst", "adoc", "readme", "license", "changelog", "authors", "notice"]);
const NAMES = new Map([
	["dockerfile", "dockerfile"],
	["containerfile", "dockerfile"],
	["makefile", "makefile"],
	["gnumakefile", "makefile"],
	["cmakelists.txt", "cmake"],
	[".gitignore", "ignore"],
	[".dockerignore", "ignore"],
	[".env", "dotenv"],
	[".bashrc", "shellscript"],
	[".zshrc", "shellscript"],
]);
const LANGUAGES = new Map(
	Object.entries({
		ts: "ts mts cts",
		tsx: "tsx",
		js: "js mjs cjs",
		jsx: "jsx",
		json: "json",
		jsonc: "jsonc json5",
		python: "py pyi",
		go: "go",
		rust: "rs",
		java: "java",
		c: "c h",
		cpp: "cpp cc cxx hpp hh hxx",
		csharp: "cs",
		ruby: "rb",
		php: "php",
		swift: "swift",
		kotlin: "kt kts",
		scala: "scala",
		dart: "dart",
		shellscript: "sh bash zsh",
		powershell: "ps1",
		sql: "sql",
		yaml: "yaml yml",
		toml: "toml",
		ini: "ini cfg conf",
		html: "html htm",
		css: "css",
		scss: "scss",
		less: "less",
		vue: "vue",
		svelte: "svelte",
		markdown: "md markdown",
		xml: "xml xsd xsl plist",
		diff: "diff patch",
		lua: "lua",
		r: "r",
		perl: "pl pm",
		haskell: "hs",
		elixir: "ex exs",
		erlang: "erl",
		clojure: "clj cljs",
		ocaml: "ml mli",
		zig: "zig",
		graphql: "graphql gql",
		proto: "proto",
		terraform: "tf",
		properties: "properties",
		latex: "tex",
	}).flatMap(([id, exts]) => exts.split(" ").map((e) => [e, id] as const)),
);
const MIME_LANGUAGES = new Map([
	["application/json", "json"],
	["text/html", "html"],
	["text/css", "css"],
	["text/javascript", "js"],
	["application/javascript", "js"],
	["application/xml", "xml"],
	["text/xml", "xml"],
	["text/markdown", "markdown"],
	["application/x-sh", "shellscript"],
	["application/sql", "sql"],
	["application/yaml", "yaml"],
	["text/x-python", "python"],
]);

// ---------------------------------------------------------------------------------------------------------------------
// Text

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** Text when its first 8 KB hold no NUL and decode as UTF-8 with hardly a replacement character. */
function textual(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8192);
	if (sample.includes(0)) return false;
	// streaming, so a character the sample cuts in two is not counted against it
	const text = new TextDecoder().decode(sample, { stream: true });
	let bad = 0;
	for (const c of text) if (c === "�") bad++;
	return bad <= text.length / 50;
}

/** The text, BOM dropped (TextDecoder's default) and line ends as \n. */
const readText = (bytes: Uint8Array) => utf8(bytes.subarray(0, TEXT_BYTES)).replace(/\r\n?/g, "\n");

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what it removes
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;
const clean = (s: string) => s.replace(CONTROL, "");

function textPreview(text: string, limits: PreviewLimits, language: string | undefined): Preview {
	const lines: string[] = [];
	let total = 0;
	let at = 0;
	for (;;) {
		const nl = text.indexOf("\n", at);
		const end = nl < 0 ? text.length : nl;
		if (nl < 0 && end === at) break;
		total++;
		if (lines.length < limits.lines)
			lines.push(clean(text.slice(at, Math.min(end, at + 4 * LINE_CHARS))).slice(0, LINE_CHARS));
		if (nl < 0) break;
		at = nl + 1;
	}
	return language === undefined ? { kind: "text", lines, total } : { kind: "text", lines, total, language };
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV and TSV (RFC 4180)

function csvPreview(text: string, separator: string | undefined, limits: PreviewLimits): Preview {
	const sep = separator ?? sniffSeparator(text);
	const rows: string[][] = [];
	let total = 0;
	let row: string[] = [];
	let field = "";
	let touched = false;
	let quoted = false;
	let fieldStart = true;
	const keep = () => rows.length < limits.rows && row.length < CELLS;
	const endField = () => {
		if (keep()) row.push(field);
		field = "";
		fieldStart = true;
	};
	const endRecord = () => {
		endField();
		if (touched) {
			total++;
			if (rows.length < limits.rows) rows.push(row);
		}
		row = [];
		touched = false;
	};
	const add = (c: string) => {
		if (field.length < CELL_CHARS && keep()) field += c === "\n" || c === "\t" ? c : clean(c);
	};
	for (let i = 0; i < text.length && total < MAX_RECORDS; i++) {
		const c = text[i] as string;
		if (quoted) {
			if (c !== '"') add(c);
			else if (text[i + 1] === '"') {
				add(c);
				i++;
			} else quoted = false;
			continue;
		}
		touched = true;
		if (c === '"' && fieldStart) {
			quoted = true;
			fieldStart = false;
		} else if (c === sep) endField();
		else if (c === "\n") {
			touched = row.length > 0 || field !== "" || !fieldStart;
			endRecord();
		} else {
			add(c);
			fieldStart = false;
		}
	}
	if (touched || field !== "") endRecord();
	return { kind: "sheet", rows, total };
}

/** The separator the first line uses most, outside quotes: comma, semicolon or tab. */
function sniffSeparator(text: string): string {
	const counts = new Map([
		[",", 0],
		[";", 0],
		["\t", 0],
	]);
	let quoted = false;
	for (let i = 0; i < Math.min(text.length, 65_536) && (quoted || text[i] !== "\n"); i++) {
		const c = text[i] as string;
		if (c === '"') quoted = !quoted;
		else if (!quoted && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	let best = ",";
	for (const [c, n] of counts) if (n > (counts.get(best) ?? 0)) best = c;
	return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Zip (central directory; stored and deflated entries; no zip64)

type ZipEntry = {
	readonly method: number;
	readonly flags: number;
	readonly size: number;
	readonly length: number;
	readonly offset: number;
};

function openZip(b: Uint8Array): Map<string, ZipEntry> | undefined {
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let eocd = -1;
	for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return undefined;
	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	if (count === 0xffff || at === 0xffffffff) return undefined;
	const entries = new Map<string, ZipEntry>();
	for (let n = 0; n < Math.min(count, 10_000) && at + 46 <= b.length; n++) {
		if (view.getUint32(at, true) !== 0x02014b50) break;
		const nameLength = view.getUint16(at + 28, true);
		const name = utf8(b.subarray(at + 46, at + 46 + nameLength));
		entries.set(name, {
			flags: view.getUint16(at + 8, true),
			method: view.getUint16(at + 10, true),
			length: view.getUint32(at + 20, true),
			size: view.getUint32(at + 24, true),
			offset: view.getUint32(at + 42, true),
		});
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
	}
	return entries;
}

/**
 * An entry's bytes. `partial` reads the start of an entry too big to read whole (a sheet's first rows); the result
 * then says it is cut.
 */
function readEntry(b: Uint8Array, zip: Map<string, ZipEntry>, name: string, partial = false) {
	const e = zip.get(name);
	if (!e || e.flags & 1 || e.offset + 30 > b.length) return undefined;
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (view.getUint32(e.offset, true) !== 0x04034b50) return undefined;
	const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
	const data = b.subarray(start, Math.min(b.length, start + e.length));
	const cut = e.size > ZIP_ENTRY_BYTES;
	if (cut && !partial) return undefined;
	if (e.method === 0) return { text: utf8(data.subarray(0, ZIP_ENTRY_BYTES)), cut };
	if (e.method !== 8) return undefined;
	try {
		const input = cut ? data.subarray(0, 2 * MB) : data;
		const out = inflateRawSync(input, { maxOutputLength: ZIP_ENTRY_BYTES, finishFlush: constants.Z_SYNC_FLUSH });
		return { text: out.toString("utf8"), cut };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// XML, as office files write it: tags found by indexOf, names without their prefix, entities decoded

type Tag = {
	readonly name: string;
	readonly close: boolean;
	readonly self: boolean;
	readonly attrs: string;
	readonly start: number;
	readonly end: number;
};

function* tags(xml: string): Generator<Tag> {
	let i = 0;
	for (;;) {
		const lt = xml.indexOf("<", i);
		if (lt < 0) return;
		const skip = xml.startsWith("<!--", lt) ? "-->" : xml.startsWith("<![CDATA[", lt) ? "]]>" : undefined;
		const gt = xml.indexOf(skip ?? ">", lt + 1);
		if (gt < 0) return;
		i = gt + (skip?.length ?? 1);
		if (skip || xml[lt + 1] === "?" || xml[lt + 1] === "!") continue;
		let body = xml.slice(lt + 1, gt);
		const close = body.startsWith("/");
		if (close) body = body.slice(1);
		const self = body.endsWith("/");
		if (self) body = body.slice(0, -1);
		const qname = /^[^\s/]*/.exec(body)?.[0] ?? "";
		yield {
			name: qname.slice(qname.indexOf(":") + 1),
			close,
			self,
			attrs: body.slice(qname.length),
			start: lt,
			end: i,
		};
	}
}

const attrPatterns = new Map<string, RegExp>();
function attr(attrs: string, name: string): string | undefined {
	let re = attrPatterns.get(name);
	if (!re) {
		re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
		attrPatterns.set(name, re);
	}
	const m = re.exec(attrs);
	return m ? decodeEntities(m[1] ?? m[2] ?? "") : undefined;
}

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_, e: string) => {
		if (!e.startsWith("#"))
			return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e] ?? "";
		const code = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
		return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// XLSX and DOCX

function officePreview(bytes: Uint8Array, limits: PreviewLimits): Preview {
	const zip = openZip(bytes);
	if (zip?.has("xl/workbook.xml")) return xlsxPreview(bytes, zip, limits);
	if (zip?.has("word/document.xml")) return docxPreview(readEntry(bytes, zip, "word/document.xml")?.text ?? "", limits);
	return { kind: "file" };
}

function xlsxPreview(bytes: Uint8Array, zip: Map<string, ZipEntry>, limits: PreviewLimits): Preview {
	const shared: string[] = [];
	let text: string | undefined;
	let phonetic = false;
	let start = 0;
	const xml = readEntry(bytes, zip, "xl/sharedStrings.xml")?.text ?? "";
	for (const t of tags(xml)) {
		if (shared.length >= 2_000_000) break;
		if (t.name === "si" && !t.close) text = "";
		else if (t.name === "si" && t.close && text !== undefined) shared.push(text.slice(0, CELL_CHARS));
		else if (t.name === "rPh") phonetic = !t.close && !t.self;
		else if (t.name === "t" && !t.close) start = t.end;
		else if (t.name === "t" && t.close && text !== undefined && !phonetic && text.length < CELL_CHARS)
			text += decodeEntities(xml.slice(start, Math.min(t.start, start + 4 * CELL_CHARS)));
	}
	return sheetRows(bytes, zip, shared, limits);
}

/** The first worksheet, as the workbook orders them. */
function firstSheet(bytes: Uint8Array, zip: Map<string, ZipEntry>): string {
	const fallback = "xl/worksheets/sheet1.xml";
	let id: string | undefined;
	for (const t of tags(readEntry(bytes, zip, "xl/workbook.xml")?.text ?? ""))
		if (t.name === "sheet" && !t.close) {
			id = /(?:^|\s)[\w.-]*:id\s*=\s*"([^"]*)"/.exec(t.attrs)?.[1];
			break;
		}
	if (id === undefined) return fallback;
	for (const t of tags(readEntry(bytes, zip, "xl/_rels/workbook.xml.rels")?.text ?? ""))
		if (t.name === "Relationship" && attr(t.attrs, "Id") === id) {
			const target = attr(t.attrs, "Target") ?? "";
			const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
			return zip.has(path) ? path : fallback;
		}
	return fallback;
}

function sheetRows(
	bytes: Uint8Array,
	zip: Map<string, ZipEntry>,
	shared: readonly string[],
	limits: PreviewLimits,
): Preview {
	const sheet = readEntry(bytes, zip, firstSheet(bytes, zip), true);
	if (!sheet) return { kind: "sheet", rows: [], total: 0 };
	const xml = sheet.text;
	const rows: string[][] = [];
	let total = 0;
	let last = 0;
	let row: string[] | undefined;
	let col = 0;
	let type = "";
	let value = "";
	let start = -1;
	for (const t of tags(xml)) {
		if (t.name === "dimension") last = rowOf(attr(t.attrs, "ref")?.split(":").pop() ?? "");
		else if (t.name === "row") {
			if (!t.close) {
				total++;
				col = 0;
				row = rows.length < limits.rows ? [] : undefined;
			}
			if ((t.close || t.self) && row) {
				while (row.length > 0 && row[row.length - 1] === "") row.pop();
				rows.push(row);
				row = undefined;
			}
		} else if (!row) continue;
		else if (t.name === "c" && !t.close) {
			const r = attr(t.attrs, "r");
			col = r ? columnOf(r) : col;
			type = attr(t.attrs, "t") ?? "";
			value = "";
			if (t.self) col++;
		} else if (t.name === "c") {
			const cell =
				type === "s"
					? (shared[Number(value)] ?? "")
					: type === "b"
						? value === "1"
							? "TRUE"
							: "FALSE"
						: decodeEntities(value);
			if (col < CELLS) {
				while (row.length < col) row.push("");
				row[col] = clean(cell).slice(0, CELL_CHARS);
			}
			col++;
		} else if ((t.name === "v" || t.name === "t") && !t.close && !t.self) start = t.end;
		else if ((t.name === "v" || t.name === "t") && t.close && start >= 0) {
			if (value.length < CELL_CHARS) value += xml.slice(start, Math.min(t.start, start + 4 * CELL_CHARS));
			start = -1;
		}
	}
	return { kind: "sheet", rows, total: sheet.cut ? Math.max(total, last) : total };
}

const columnOf = (ref: string) => {
	const letters = /^[A-Za-z]{1,3}/.exec(ref)?.[0] ?? "";
	let n = 0;
	for (const c of letters.toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64;
	return Math.max(0, n - 1);
};
const rowOf = (ref: string) => Number(/\d{1,7}$/.exec(ref)?.[0] ?? 0);

function docxPreview(xml: string, limits: PreviewLimits): Preview {
	const lines: string[] = [];
	let text = "";
	let start = -1;
	for (const t of tags(xml)) {
		if (lines.length >= limits.lines) break;
		if (t.name === "t" && !t.close && !t.self) start = t.end;
		else if (t.name === "t" && t.close && start >= 0) {
			if (text.length < LINE_CHARS) text += decodeEntities(xml.slice(start, Math.min(t.start, start + 4 * LINE_CHARS)));
			start = -1;
		} else if (t.name === "tab" && !t.close) text += "\t";
		else if ((t.name === "br" || t.name === "cr") && !t.close) text += " ";
		else if (t.name === "p" && (t.close || t.self)) {
			const line = clean(text).slice(0, LINE_CHARS);
			if (line.trim() !== "") lines.push(line);
			text = "";
		}
	}
	return { kind: "document", lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// PDF: objects found by scanning (classic and in object streams), never by trusting the xref's offsets

type Name = { readonly k: "name"; readonly v: string };
/** A string's bytes, one char each. */
type Str = { readonly k: "str"; readonly v: string };
type Ref = { readonly k: "ref"; readonly n: number };
type Dict = { readonly k: "dict"; readonly v: Map<string, Value> };
/** An operator, or a keyword the grammar has no value for. */
type Op = { readonly k: "op"; readonly v: string };
type Value = null | boolean | number | Name | Str | Ref | Dict | Value[];
type PdfObject = { readonly value: Value; readonly stream?: readonly [start: number, end: number] };
type Pdf = { readonly s: string; readonly objects: Map<number, PdfObject>; readonly budget: { left: number } };

const MAX_DEPTH = 64;
const isWhite = (c: string | undefined) =>
	c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
const isDelimiter = (c: string | undefined) => c !== undefined && c !== "" && "()<>[]{}/%".includes(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const tagged = <K extends string>(v: unknown, k: K): v is { k: K } =>
	typeof v === "object" && v !== null && !Array.isArray(v) && (v as { k: string }).k === k;
const isOp = (v: Value | Op | undefined, op?: string): v is Op => tagged(v, "op") && (op === undefined || v.v === op);
const isName = (v: Value | undefined, name: string) => tagged(v, "name") && (v as Name).v === name;
const asDict = (v: Value | Op | undefined) => (tagged(v, "dict") ? (v as Dict) : undefined);
const asStr = (v: Value | Op | undefined) => (tagged(v, "str") ? (v as Str).v : undefined);

/** One pass over PDF syntax: every token consumes at least one character, and nesting stops at MAX_DEPTH. */
class Lexer {
	s: string;
	i: number;
	constructor(s: string, i: number) {
		this.s = s;
		this.i = i;
	}

	skip(): void {
		const s = this.s;
		while (this.i < s.length) {
			if (isWhite(s[this.i])) this.i++;
			else if (s[this.i] === "%") while (this.i < s.length && s[this.i] !== "\n" && s[this.i] !== "\r") this.i++;
			else return;
		}
	}

	token(): Value | Op | undefined {
		this.skip();
		const s = this.s;
		const c = s[this.i];
		if (c === undefined) return undefined;
		if (c === "(") return this.literal();
		if ((c === "<" || c === ">") && s[this.i + 1] === c) {
			this.i += 2;
			return { k: "op", v: c + c };
		}
		if (c === "<") {
			const end = s.indexOf(">", this.i);
			const hex = s.slice(this.i + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, "");
			this.i = end < 0 ? s.length : end + 1;
			let v = "";
			for (let j = 0; j < hex.length; j += 2)
				v += String.fromCharCode(Number.parseInt(hex.slice(j, j + 2).padEnd(2, "0"), 16));
			return { k: "str", v };
		}
		let j = this.i + 1;
		if (c !== "/" && isDelimiter(c)) {
			this.i = j;
			return { k: "op", v: c };
		}
		while (j < s.length && !isWhite(s[j]) && !isDelimiter(s[j])) j++;
		const word = s.slice(this.i, j);
		this.i = j;
		if (c === "/")
			return {
				k: "name",
				v: word.slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
			};
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
		return word === "true" ? true : word === "false" ? false : word === "null" ? null : { k: "op", v: word };
	}

	literal(): Str {
		const s = this.s;
		let depth = 0;
		let v = "";
		for (this.i++; this.i < s.length; this.i++) {
			const c = s[this.i] as string;
			if (c === "(") depth++;
			else if (c === ")" && depth-- === 0) break;
			if (c !== "\\") {
				v += c;
				continue;
			}
			const e = s[++this.i];
			if (e === undefined) break;
			const escaped = ESCAPES[e];
			if (escaped !== undefined) v += escaped;
			else if (e >= "0" && e <= "7") {
				const oct = /^[0-7]{1,3}/.exec(s.slice(this.i, this.i + 3))?.[0] ?? e;
				v += String.fromCharCode(Number.parseInt(oct, 8) & 255);
				this.i += oct.length - 1;
			} else if (e === "\r") {
				if (s[this.i + 1] === "\n") this.i++;
			} else if (e !== "\n") v += e;
		}
		this.i++;
		return { k: "str", v };
	}

	value(depth = 0): Value | Op | undefined {
		const t = this.token();
		if (isOp(t, "[") && depth < MAX_DEPTH) {
			const items: Value[] = [];
			for (;;) {
				const v = this.value(depth + 1);
				if (v === undefined || isOp(v, "]")) return items;
				if (!isOp(v)) items.push(v);
			}
		}
		if (isOp(t, "<<") && depth < MAX_DEPTH) {
			const map = new Map<string, Value>();
			for (;;) {
				const key = this.token();
				if (key === undefined || isOp(key, ">>")) return { k: "dict", v: map };
				if (!tagged(key, "name")) continue;
				const v = this.value(depth + 1);
				if (v === undefined || isOp(v, ">>")) return { k: "dict", v: map };
				if (!isOp(v)) map.set((key as Name).v, v);
			}
		}
		if (typeof t === "number" && Number.isInteger(t) && t >= 0) {
			const at = this.i;
			const gen = this.token();
			if (typeof gen === "number" && Number.isInteger(gen) && isOp(this.token(), "R")) return { k: "ref", n: t };
			this.i = at;
		}
		return t;
	}
}
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

function resolve(pdf: Pdf, v: Value | undefined): Value | undefined {
	for (let hops = 0; hops < 32 && tagged(v, "ref"); hops++) v = pdf.objects.get((v as Ref).n)?.value;
	return tagged(v, "ref") ? undefined : v;
}
const get = (pdf: Pdf, d: Dict | undefined, key: string) => resolve(pdf, d?.v.get(key));
const objectOf = (pdf: Pdf, v: Value | undefined) => (tagged(v, "ref") ? pdf.objects.get((v as Ref).n) : undefined);

/** A stream's bytes, unfiltered or through /FlateDecode alone (no predictor); undefined for anything else. */
function streamData(pdf: Pdf, obj: PdfObject | undefined): string | undefined {
	const dict = asDict(obj?.value);
	if (!obj?.stream || !dict) return undefined;
	const raw = pdf.s.slice(obj.stream[0], obj.stream[1]);
	const filter = get(pdf, dict, "Filter");
	const filters = Array.isArray(filter) ? filter : filter === undefined || filter === null ? [] : [filter];
	const cap = Math.min(STREAM_BYTES, pdf.budget.left);
	if (cap <= 0) return undefined;
	// what is read spends the budget whether or not it inflates, so no file of streams buys unbounded work
	pdf.budget.left -= Math.min(raw.length, cap);
	if (filters.length === 0) return raw.slice(0, cap);
	if (filters.length > 1 || !isName(resolve(pdf, filters[0]), "FlateDecode")) return undefined;
	const parms = get(pdf, dict, "DecodeParms");
	const predictor = get(pdf, asDict(Array.isArray(parms) ? resolve(pdf, parms[0]) : parms), "Predictor");
	if (typeof predictor === "number" && predictor > 1) return undefined;
	try {
		const out = inflateSync(Buffer.from(raw, "latin1"), { maxOutputLength: cap, finishFlush: constants.Z_SYNC_FLUSH });
		pdf.budget.left -= out.length;
		return out.toString("latin1");
	} catch {
		return undefined;
	}
}

/** Every `N G obj` in file order (a later definition replaces an earlier one), object streams expanded where they sit. */
function scanObjects(pdf: Pdf, trailers: { at: number; dict: Dict }[]): void {
	const s = pdf.s;
	let from = 0;
	let nextEnd = 0;
	while (pdf.objects.size < MAX_OBJECTS) {
		const at = s.indexOf("obj", from);
		if (at < 0) return;
		from = at + 3;
		if (!(at + 3 === s.length || isWhite(s[at + 3]) || isDelimiter(s[at + 3]))) continue;
		// back over "N G ", each run bounded
		let j = at - 1;
		const back = (test: (c: string | undefined) => boolean) => {
			const end = j;
			while (j >= 0 && end - j < 16 && test(s[j])) j--;
			return end - j;
		};
		if (!back(isWhite) || !back(isDigit) || !back(isWhite)) continue;
		const end = j;
		if (!back(isDigit) || (j >= 0 && !isWhite(s[j]) && !isDelimiter(s[j]))) continue;
		const num = Number(s.slice(j + 1, end + 1));
		// an object reads no further than the next endobj, so one that never closes cannot swallow the rest, and the
		// search for it runs again only once passed, so the scan stays linear
		if (nextEnd >= 0 && nextEnd < at) nextEnd = s.indexOf("endobj", at);
		const lexer = new Lexer(nextEnd < 0 ? s : s.slice(0, nextEnd), at + 3);
		const value = lexer.value();
		if (value === undefined || isOp(value)) continue;
		lexer.skip();
		let stream: [number, number] | undefined;
		if (s.startsWith("stream", lexer.i)) {
			let start = lexer.i + 6;
			if (s[start] === "\r") start++;
			if (s[start] === "\n") start++;
			const length = asDict(value)?.v.get("Length");
			let stop = -1;
			if (typeof length === "number" && length >= 0 && start + length <= s.length) {
				const probe = new Lexer(s, start + length);
				probe.skip();
				if (s.startsWith("endstream", probe.i)) stop = start + length;
			}
			if (stop < 0) {
				const found = s.indexOf("endstream", start);
				stop = found < 0 ? s.length : found;
				if (s[stop - 1] === "\n") stop--;
				if (s[stop - 1] === "\r") stop--;
			}
			stream = [start, Math.max(start, stop)];
		}
		from = Math.max(from, stream ? stream[1] : lexer.i);
		const obj: PdfObject = stream ? { value, stream } : { value };
		pdf.objects.set(num, obj);
		const type = asDict(value)?.v.get("Type");
		if (isName(type, "XRef")) trailers.push({ at, dict: value as Dict });
		if (isName(type, "ObjStm")) expandObjectStream(pdf, obj);
	}
}

function expandObjectStream(pdf: Pdf, obj: PdfObject): void {
	const dict = asDict(obj.value);
	const n = get(pdf, dict, "N");
	const first = get(pdf, dict, "First");
	if (typeof n !== "number" || typeof first !== "number" || first < 0) return;
	const data = streamData(pdf, obj);
	if (data === undefined) return;
	const header = new Lexer(data, 0);
	const pairs: [number, number][] = [];
	for (let k = 0; k < Math.min(n, MAX_OBJECTS); k++) {
		const num = header.token();
		const offset = header.token();
		if (typeof num !== "number" || typeof offset !== "number") break;
		pairs.push([num, offset]);
	}
	// each object reads no further than the next one's offset, and each offset is read once
	const offsets = [...new Set(pairs.map(([, offset]) => offset))].sort((a, b) => a - b);
	const values = new Map<number, Value | Op | undefined>();
	offsets.forEach((offset, k) => {
		const end = first + (offsets[k + 1] ?? data.length);
		values.set(offset, new Lexer(data.slice(0, end), first + offset).value());
	});
	for (const [num, offset] of pairs) {
		const value = values.get(offset);
		if (pdf.objects.size >= MAX_OBJECTS) return;
		if (value !== undefined && !isOp(value)) pdf.objects.set(num, { value });
	}
}

/** A PDF text string: UTF-16BE or UTF-8 behind their BOM, else PDFDocEncoding (read as Latin-1). */
function textString(raw: string): string {
	if (raw.startsWith("\xfe\xff")) return utf16(raw.slice(2));
	if (raw.startsWith("\xef\xbb\xbf")) return utf8(Buffer.from(raw.slice(3), "latin1"));
	return raw;
}
function utf16(raw: string): string {
	let out = "";
	for (let i = 0; i + 1 < raw.length; i += 2)
		out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
	return out;
}

function pdfPreview(bytes: Uint8Array, limits: PreviewLimits): Preview {
	const pdf: Pdf = { s: latin1(bytes.subarray(0, PDF_BYTES)), objects: new Map(), budget: { left: INFLATE_BUDGET } };
	const trailers: { at: number; dict: Dict }[] = [];
	for (let at = pdf.s.indexOf("trailer"), n = 0; at >= 0 && n < 1000; at = pdf.s.indexOf("trailer", at + 7), n++) {
		// a trailer is small: read from a window, so a thousand broken ones cost no more than a thousand windows
		const dict = asDict(new Lexer(pdf.s.slice(at, at + 65_536), 7).value());
		if (dict) trailers.push({ at, dict });
	}
	scanObjects(pdf, trailers);
	// the latest trailer naming each entry wins, as incremental updates mean
	const trailer = new Map<string, Value>();
	for (const { dict } of trailers.sort((a, b) => a.at - b.at))
		for (const [key, v] of dict.v) if (key === "Root" || key === "Info" || key === "Encrypt") trailer.set(key, v);
	let root = asDict(resolve(pdf, trailer.get("Root")));
	for (const o of root ? [] : pdf.objects.values())
		if (isName(asDict(o.value)?.v.get("Type"), "Catalog")) root = asDict(o.value);
	const tree = asDict(get(pdf, root, "Pages"));
	const count = get(pdf, tree, "Count");
	let pages = typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 1_000_000 ? count : -1;
	if (pages < 0) {
		pages = 0;
		for (const o of pdf.objects.values()) if (isName(asDict(o.value)?.v.get("Type"), "Page")) pages++;
	}
	// strings and streams are ciphertext under /Encrypt: the page tree is all that reads
	if (trailer.has("Encrypt")) return { kind: "pdf", pages, lines: [] };
	const raw = asStr(get(pdf, asDict(resolve(pdf, trailer.get("Info"))), "Title"));
	const title = raw === undefined ? "" : clean(textString(raw)).trim().slice(0, LINE_CHARS);
	const lines = tree && limits.lines > 0 ? firstPageText(pdf, tree, limits.lines) : [];
	return title ? { kind: "pdf", pages, title, lines } : { kind: "pdf", pages, lines };
}

// ---------------------------------------------------------------------------------------------------------------------
// PDF text: the first page's content streams, shown through each font's ToUnicode CMap

/** A shown string's codes as text, or undefined when the font's codes mean nothing readable. */
type Decode = (codes: string) => string | undefined;

/** The first page down the tree (Kids in order, Resources inherited), its content as lines. */
function firstPageText(pdf: Pdf, tree: Dict, limit: number): string[] {
	const stack: [Dict, Dict | undefined][] = [[tree, undefined]];
	const seen = new Set<Dict>();
	for (let steps = 0; stack.length > 0 && steps < 1000; steps++) {
		const [node, inherited] = stack.pop() as [Dict, Dict | undefined];
		if (seen.has(node)) continue;
		seen.add(node);
		const resources = asDict(get(pdf, node, "Resources")) ?? inherited;
		const kids = get(pdf, node, "Kids");
		if (isName(get(pdf, node, "Type"), "Page") || !Array.isArray(kids)) {
			const contents = node.v.get("Contents");
			if (contents === undefined) continue;
			const resolved = resolve(pdf, contents);
			const parts: string[] = [];
			for (const ref of Array.isArray(resolved) ? resolved.slice(0, 256) : [contents]) {
				const data = streamData(pdf, objectOf(pdf, ref));
				if (data === undefined) return [];
				parts.push(data);
			}
			return showText(parts.join("\n"), fonts(pdf, asDict(get(pdf, resources, "Font"))), limit);
		}
		for (let k = Math.min(kids.length, 32) - 1; k >= 0; k--) {
			const kid = asDict(resolve(pdf, kids[k]));
			if (kid) stack.push([kid, resources]);
		}
	}
	return [];
}

function fonts(pdf: Pdf, dict: Dict | undefined): (name: string) => Decode {
	const cache = new Map<string, Decode>();
	return (name) => {
		let decode = cache.get(name);
		if (!decode) {
			decode = fontDecoder(pdf, asDict(get(pdf, dict, name)));
			cache.set(name, decode);
		}
		return decode;
	};
}

const plain: Decode = (codes) => codes;

/** The font's ToUnicode when it has one; a simple font's bytes as Latin-1; a composite font's codes unreadable. */
function fontDecoder(pdf: Pdf, font: Dict | undefined): Decode {
	const composite = isName(get(pdf, font, "Subtype"), "Type0");
	const cmap = streamData(pdf, objectOf(pdf, font?.v.get("ToUnicode")));
	if (cmap === undefined) return composite ? () => undefined : plain;
	return cmapDecoder(cmap, composite ? 2 : 1);
}

/** Code bytes as a number, read from `at` for `width` bytes (1 or 2). */
const codeAt = (s: string, at: number, width: number) =>
	width === 1 ? s.charCodeAt(at) : s.charCodeAt(at) * 256 + s.charCodeAt(at + 1);

/**
 * A ToUnicode CMap's bfchar and bfrange mappings, codes 1 or 2 bytes wide as its codespace says. Ranges are expanded
 * into one map (codes of at most two bytes keep it small, and the expansion is counted), so each code costs a lookup.
 */
function cmapDecoder(cmap: string, width: number): Decode {
	const spaces: { width: number; lo: number; hi: number }[] = [];
	const map = new Map<number, string>();
	let expanded = 0;
	const lexer = new Lexer(cmap, 0);
	let section = "";
	const operands: (Value | Op)[] = [];
	for (let n = 0; n < 200_000; n++) {
		const t = lexer.value();
		if (t === undefined) break;
		if (isOp(t) && /^(begin|end)(codespacerange|bfchar|bfrange)$/.test(t.v)) {
			section = t.v.startsWith("begin") ? t.v.slice(5) : "";
			operands.length = 0;
			continue;
		}
		if (section === "") continue;
		operands.push(t);
		const [a, b] = [asStr(operands[0]), asStr(operands[1])];
		if (section === "codespacerange" && operands.length === 2) {
			if (
				a !== undefined &&
				b !== undefined &&
				a.length === b.length &&
				(a.length === 1 || a.length === 2) &&
				spaces.length < 8
			)
				spaces.push({ width: a.length, lo: codeAt(a, 0, a.length), hi: codeAt(b, 0, a.length) });
		} else if (section === "bfchar" && operands.length === 2) {
			if (a !== undefined && b !== undefined && (a.length === 1 || a.length === 2))
				map.set(a.length * 0x10000 + codeAt(a, 0, a.length), utf16(b));
		} else if (section === "bfrange" && operands.length === 3) {
			const to = operands[2];
			if (a === undefined || b === undefined || !(a.length === 1 || a.length === 2) || a.length !== b.length) continue;
			const lo = codeAt(a, 0, a.length);
			const hi = codeAt(b, 0, a.length);
			const units = utf16(asStr(to) ?? "");
			for (let code = lo; code <= hi && expanded < 1_000_000; code++, expanded++) {
				const key = a.length * 0x10000 + code;
				if (map.has(key)) continue;
				// an array names each code's text; a string's last UTF-16 unit counts up across the range
				if (Array.isArray(to)) map.set(key, utf16(asStr(to[code - lo]) ?? ""));
				else if (units !== "")
					map.set(
						key,
						units.slice(0, -1) + String.fromCharCode((units.charCodeAt(units.length - 1) + code - lo) & 0xffff),
					);
			}
		} else continue;
		operands.length = 0;
	}
	const widthAt = (codes: string, i: number) => {
		for (const r of spaces) {
			if (i + r.width > codes.length) continue;
			const code = codeAt(codes, i, r.width);
			if (code >= r.lo && code <= r.hi) return r.width;
		}
		return spaces[0]?.width ?? width;
	};
	return (codes) => {
		let out = "";
		for (let i = 0; i < codes.length; ) {
			const w = Math.min(widthAt(codes, i), codes.length - i);
			out += map.get(w * 0x10000 + codeAt(codes, i, w)) ?? "";
			i += w;
		}
		return out;
	};
}

/** At least three quarters of a line is printable, or it is noise from a font that could not be decoded. */
function printable(line: string): boolean {
	let good = 0;
	let all = 0;
	for (const c of line) {
		all++;
		if (c >= " " && !(c >= "\x7f" && c <= "\x9f") && c !== "�") good++;
	}
	return good >= all * 0.75;
}

/** The text operators of a content stream, a new line wherever the baseline moves. */
function showText(content: string, font: (name: string) => Decode, limit: number): string[] {
	const lines: string[] = [];
	let line = "";
	let y = 0;
	let leading = 0;
	let decode: Decode = plain;
	const flush = () => {
		const text = line.trim();
		if (text !== "" && printable(text)) lines.push(clean(text).slice(0, LINE_CHARS));
		line = "";
	};
	const show = (v: Value | undefined) => {
		const codes = asStr(v);
		if (codes !== undefined && line.length < 4 * LINE_CHARS) line += decode(codes.slice(0, 8 * LINE_CHARS)) ?? "";
	};
	const moveTo = (ny: number) => {
		if (Math.abs(ny - y) > 0.01) flush();
		y = ny;
	};
	const num = (v: Value | undefined) => (typeof v === "number" ? v : 0);
	const lexer = new Lexer(content, 0);
	const operands: Value[] = [];
	for (let n = 0; n < 2_000_000 && lines.length < limit; n++) {
		const t = lexer.value();
		if (t === undefined) break;
		if (!isOp(t)) {
			if (operands.length < 32) operands.push(t);
			continue;
		}
		const [a, b] = operands;
		switch (t.v) {
			case "BT":
				y = 0;
				break;
			case "Tf":
				decode = tagged(a, "name") ? font((a as Name).v) : plain;
				break;
			case "TL":
				leading = num(a);
				break;
			case "TD":
				leading = -num(b);
				moveTo(y + num(b));
				break;
			case "Td":
				moveTo(y + num(b));
				break;
			case "Tm":
				moveTo(num(operands[5]));
				break;
			case "T*":
			case "'":
			case '"':
				flush();
				y -= leading;
				show(t.v === "'" ? a : t.v === '"' ? operands[2] : undefined);
				break;
			case "Tj":
				show(a);
				break;
			case "TJ":
				for (const part of Array.isArray(a) ? a : []) {
					if (typeof part !== "number") show(part);
					else if (part < -200 && !line.endsWith(" ")) line += " ";
				}
				break;
			case "ID": {
				// an inline image's bytes run to the first EI that stands alone
				let at = lexer.i;
				for (;;) {
					at = content.indexOf("EI", at);
					if (at < 0 || (isWhite(content[at - 1]) && (at + 2 >= content.length || isWhite(content[at + 2])))) break;
					at += 2;
				}
				lexer.i = at < 0 ? content.length : at + 2;
				break;
			}
		}
		operands.length = 0;
	}
	flush();
	return lines.slice(0, limit);
}
