/** Previews are drawn from a file's bytes by bounded parsing that never throws (src/core/preview.ts). */
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FULL, GLIMPSE, type Preview, preview } from "../src/core/preview.ts";
import { pbtRuns } from "./pbt.ts";

const bin = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const text = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const flate = (s: string) => deflateSync(Buffer.from(s, "latin1")).toString("latin1");
const stream = (dict: string, data: string, filtered = true) =>
	`<< ${dict} ${filtered ? "/Filter /FlateDecode " : ""}/Length ${filtered ? flate(data).length : data.length} >>\nstream\n${filtered ? flate(data) : data}\nendstream`;

/** A PDF of numbered objects (1, 2, ...) and a classic trailer, its xref table left out: the reader scans. */
function pdf(objects: string[], trailer?: string): Uint8Array {
	const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("");
	return bin(`%PDF-1.7\n%\xe2\xe3\xcf\xd3\n${body}${trailer ? `trailer\n${trailer}\n` : ""}startxref\n0\n%%EOF\n`);
}

const simple = pdf(
	[
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		stream(
			"",
			"BT /F1 12 Tf 72 720 Td (Hello, world) Tj 0 -14 Td [(Sec) 20 (ond) -300 (line)] TJ T* (Third \\(paren\\) \\101\\\nB) Tj ET",
		),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Title (Quarterly \\(Q3\\) report) /Producer (test) >>",
	],
	"<< /Size 7 /Root 1 0 R /Info 6 0 R >>",
);

const CMAP = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <0048> <0002> <0069> endbfchar
2 beginbfrange <0010> <0012> <00E9> <0020> <0021> [<D83DDE00> <0021>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;

const unicode = pdf(
	[
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>",
		"<< /Type /Page /Parent 2 0 R /Contents [4 0 R 8 0 R] >>",
		stream("", "BT /F1 12 Tf 1 0 0 1 72 700 Tm <00010002> Tj 1 0 0 1 72 680 Tm <001000110012> Tj"),
		"<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Noto /Encoding /Identity-H /ToUnicode 6 0 R >>",
		stream("", CMAP),
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
		stream("", "<0020> Tj <0021> Tj ET"),
		"<< /Title <FEFF00C9007400E9> >>",
	],
	"<< /Root 1 0 R /Info 9 0 R >>",
);

/** Objects 1, 2, 3, 5 and 6 in an object stream (8), the trailer an /XRef stream (9). */
function compressed(): Uint8Array {
	const inner: [number, string][] = [
		[1, "<< /Type /Catalog /Pages 2 0 R >>"],
		[2, "<< /Type /Pages /Kids [3 0 R] /Count 3 >>"],
		[3, "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"],
		[5, "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>"],
		[6, "<< /Title (From an object stream) >>"],
	];
	let offset = 0;
	const header: string[] = [];
	const bodies: string[] = [];
	for (const [n, body] of inner) {
		header.push(`${n} ${offset}`);
		bodies.push(body);
		offset += body.length + 1;
	}
	const head = `${header.join(" ")}\n`;
	const objstm = stream(`/Type /ObjStm /N ${inner.length} /First ${head.length}`, head + bodies.join("\n"));
	const content = stream("", "BT /F1 10 Tf 50 750 Td (Compressed) Tj 0 -12 Td (objects) Tj ET");
	const xref = stream("/Type /XRef /Size 10 /W [1 2 1] /Root 1 0 R /Info 6 0 R", "\x01\x00\x00\x00", true);
	return bin(
		`%PDF-1.5\n4 0 obj\n${content}\nendobj\n8 0 obj\n${objstm}\nendobj\n9 0 obj\n${xref}\nendobj\nstartxref\n0\n%%EOF\n`,
	);
}

const encrypted = pdf(
	[
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
		stream("", "\x8a\x11\x93garbage"),
		"<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>",
		"<< /Title (\x93\x02\xfe) >>",
	],
	"<< /Root 1 0 R /Info 6 0 R /Encrypt 5 0 R >>",
);

/** A zip of deflated entries, with the central directory a reader starts from. */
function zip(files: Record<string, string>): Uint8Array {
	const le16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
	const le32 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const raw = Buffer.from(content, "utf8");
		const data = deflateRawSync(raw);
		const fileName = Buffer.from(name, "utf8");
		const sizes = [le32(crc32(raw)), le32(data.length), le32(raw.length), le16(fileName.length)];
		const local = Buffer.concat([
			le32(0x04034b50),
			le16(20),
			le16(0),
			le16(8),
			le32(0),
			...sizes,
			le16(0),
			fileName,
			data,
		]);
		centrals.push(
			Buffer.concat([
				le32(0x02014b50),
				le16(20),
				le16(20),
				le16(0),
				le16(8),
				le32(0),
				...sizes,
				le16(0),
				le16(0),
				le16(0),
				le16(0),
				le32(0),
				le32(offset),
				fileName,
			]),
		);
		locals.push(local);
		offset += local.length;
	}
	const central = Buffer.concat(centrals);
	const n = centrals.length;
	const end = Buffer.concat([
		le32(0x06054b50),
		le16(0),
		le16(0),
		le16(n),
		le16(n),
		le32(central.length),
		le32(offset),
		le16(0),
	]);
	return new Uint8Array(Buffer.concat([...locals, central, end]));
}

const xlsx = zip({
	"[Content_Types].xml": "<Types/>",
	"xl/workbook.xml":
		'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId3"/></sheets></workbook>',
	"xl/_rels/workbook.xml.rels":
		'<Relationships><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId3" Target="worksheets/data.xml"/></Relationships>',
	"xl/sharedStrings.xml":
		'<sst count="3"><si><t>Name</t></si><si><r><t>Amo</t></r><r><t>unt</t></r><rPh><t>x</t></rPh></si><si><t xml:space="preserve">Ana &amp; Bo</t></si></sst>',
	"xl/worksheets/data.xml": `<worksheet><dimension ref="A1:D3"/><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Note &lt;1&gt;</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>3.5</v></c><c r="D2" t="b"><v>1</v></c></row>
<row r="3"><c r="A3" t="str"><v>x&amp;y</v></c></row>
</sheetData></worksheet>`,
});

const docx = zip({
	"word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; co</w:t></w:r></w:p>
<w:p/><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p>
<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p>
</w:body></w:document>`,
});

describe("preview", () => {
	it("reads a PDF's page count, title and first page through FlateDecode", () => {
		expect(preview("report.pdf", "application/pdf", simple)).toEqual({
			kind: "pdf",
			pages: 1,
			title: "Quarterly (Q3) report",
			lines: ["Hello, world", "Second line", "Third (paren) AB"],
		});
		expect(preview("report.pdf", "application/pdf", simple, { lines: 1, rows: 1 })).toMatchObject({
			lines: ["Hello, world"],
		});
	});

	it("decodes text through a ToUnicode CMap, inherited resources, contents in parts and a UTF-16 title", () => {
		expect(preview("u.pdf", "", unicode)).toEqual({ kind: "pdf", pages: 2, title: "Été", lines: ["Hi", "éêë😀!"] });
	});

	it("finds objects in an object stream and the trailer in an XRef stream", () => {
		expect(preview("c.pdf", "application/pdf", compressed())).toEqual({
			kind: "pdf",
			pages: 3,
			title: "From an object stream",
			lines: ["Compressed", "objects"],
		});
	});

	it("gives an encrypted PDF its page count only", () => {
		expect(preview("e.pdf", "application/pdf", encrypted)).toEqual({ kind: "pdf", pages: 1, lines: [] });
	});

	it("counts pages without a page tree, and reads nothing it cannot decode", () => {
		const loose = pdf(["<< /Type /Page >>", "<< /Type /Page >>", "<< /Type /Pages /Kids [] >>"]);
		expect(preview("l.pdf", "", loose)).toEqual({ kind: "pdf", pages: 2, lines: [] });
		const lzw = pdf(
			[
				"<< /Type /Catalog /Pages 2 0 R >>",
				"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
				"<< /Type /Page /Contents 4 0 R >>",
				"<< /Filter /LZWDecode /Length 3 >>\nstream\nabc\nendstream",
			],
			"<< /Root 1 0 R >>",
		);
		expect(preview("z.pdf", "", lzw)).toEqual({ kind: "pdf", pages: 1, lines: [] });
	});

	it("survives nesting past any depth and an object that never closes", () => {
		const deep = bin(`%PDF-1.4\n1 0 obj\n${"[".repeat(100_000)}\nendobj\n2 0 obj << /Type /Page`);
		expect(preview("d.pdf", "", deep)).toEqual({ kind: "pdf", pages: 1, lines: [] });
	});

	it("reads an xlsx's first sheet by the workbook's order, cells placed by column", () => {
		expect(preview("book.xlsx", "", xlsx)).toEqual({
			kind: "sheet",
			rows: [["Name", "Amount", "Note <1>"], ["Ana & Bo", "", "3.5", "TRUE"], ["x&y"]],
			total: 3,
		});
		expect(preview("book.xlsx", "", xlsx, { lines: 1, rows: 1 })).toEqual({
			kind: "sheet",
			rows: [["Name", "Amount", "Note <1>"]],
			total: 3,
		});
	});

	it("reads a docx's non-empty paragraphs", () => {
		expect(preview("memo.docx", "", docx)).toEqual({ kind: "document", lines: ["Hello world & co", "A\tB"] });
		expect(preview("other.zip", "application/zip", zip({ "a.txt": "a" }))).toEqual({ kind: "file" });
	});

	it("reads CSV with quotes, separators inside them and newlines; TSV by extension; semicolons sniffed", () => {
		const csv = '\ufeffname,note\r\n"Ana","said ""hi"", then\nleft"\r\nBo,\n\n';
		expect(preview("a.csv", "text/csv", text(csv))).toEqual({
			kind: "sheet",
			rows: [
				["name", "note"],
				["Ana", 'said "hi", then\nleft'],
				["Bo", ""],
			],
			total: 3,
		});
		expect(preview("a.tsv", "", text("a,b\tc\n1\t2\n"))).toEqual({
			kind: "sheet",
			rows: [
				["a,b", "c"],
				["1", "2"],
			],
			total: 2,
		});
		expect(preview("a.csv", "", text("a;b;c\n1;2,5;3"))).toMatchObject({
			rows: [
				["a", "b", "c"],
				["1", "2,5", "3"],
			],
		});
		const many = Array.from({ length: 20 }, (_, i) => `${i},${"x".repeat(300)},${Array(20).fill("c").join(",")}`).join(
			"\n",
		);
		const got = preview("m.csv", "", text(many)) as Extract<Preview, { kind: "sheet" }>;
		expect(got.total).toBe(20);
		expect(got.rows).toHaveLength(GLIMPSE.rows);
		expect(got.rows[0]).toHaveLength(12);
		expect(got.rows[0]?.[1]).toHaveLength(200);
	});

	it("reads text and code by extension and well-known name, its controls dropped and lines bounded", () => {
		const ts = `\ufeffconst a = 1;\r\n\tlet b\x07 = 2;\r\n${"x".repeat(500)}`;
		expect(preview("src/a.ts", "", text(ts))).toEqual({
			kind: "text",
			lines: ["const a = 1;", "\tlet b = 2;", "x".repeat(400)],
			total: 3,
			language: "ts",
		});
		expect(preview("Dockerfile", "", text("FROM node\n"))).toEqual({
			kind: "text",
			lines: ["FROM node"],
			total: 1,
			language: "dockerfile",
		});
		expect(preview("notes.txt", "text/plain", text("one\ntwo\n"))).toEqual({
			kind: "text",
			lines: ["one", "two"],
			total: 2,
		});
		expect(preview("data", "application/json", text('{"a":1}'))).toMatchObject({ language: "json" });
		expect(preview("empty.md", "", text(""))).toEqual({ kind: "text", lines: [], total: 0, language: "markdown" });
		const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
		expect(preview("l.py", "", text(long), FULL)).toMatchObject({ total: 3000, language: "python" });
		expect((preview("l.py", "", text(long), FULL) as Extract<Preview, { kind: "text" }>).lines).toHaveLength(2000);
	});

	it("shows an SVG as its markup, never as an image", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
		expect(preview("logo.svg", "image/svg+xml", text(svg))).toEqual({
			kind: "text",
			lines: [svg],
			total: 1,
			language: "xml",
		});
	});

	it("tells images by their magic numbers, media by type or extension, and binary as a file", () => {
		expect(preview("x.bin", "", bin("\x89PNG\r\n\x1a\n\0\0"))).toEqual({ kind: "image" });
		expect(preview("x", "", bin("\xff\xd8\xff\xe0"))).toEqual({ kind: "image" });
		expect(preview("x", "", bin("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ kind: "image" });
		expect(preview("x.heic", "image/heic", bin("\0\0\0\x18ftypheic"))).toEqual({ kind: "file" });
		expect(preview("song", "audio/mpeg", bin("ID3"))).toEqual({ kind: "audio" });
		expect(preview("clip.mov", "", bin("\0\0\0\x14ftypqt"))).toEqual({ kind: "video" });
		expect(preview("a.ts", "", bin("abc\0def"))).toEqual({ kind: "file" });
		expect(preview("a.txt", "", bin("\xff\xfe\xfd\xfc".repeat(100)))).toEqual({ kind: "file" });
		expect(preview("a.exe", "application/octet-stream", text("MZ hello"))).toEqual({ kind: "file" });
	});
});

const KINDS = new Set(["image", "audio", "video", "pdf", "sheet", "document", "text", "file"]);
const FIXTURES: [string, Uint8Array][] = [
	["s.pdf", simple],
	["u.pdf", unicode],
	["c.pdf", compressed()],
	["e.pdf", encrypted],
	["b.xlsx", xlsx],
	["d.docx", docx],
	["a.csv", text('a,"b\nc",d\n1,2,3\n')],
	["a.ts", text("export const a = 1;\n")],
];

describe("preview, on hostile bytes", () => {
	it("never throws and always names a kind, whatever bytes are changed, cut or added", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...FIXTURES),
				fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }),
				fc.option(fc.nat(), { nil: undefined }),
				fc.uint8Array({ maxLength: 64 }),
				([name, original], flips, cut, tail) => {
					const bytes = Uint8Array.from(original);
					for (const [at, byte] of flips) bytes[at % bytes.length] = byte;
					const mutated = new Uint8Array([
						...bytes.subarray(0, cut === undefined ? bytes.length : cut % (bytes.length + 1)),
						...tail,
					]);
					for (const limits of [GLIMPSE, FULL]) {
						const got = preview(name, "", mutated, limits);
						expect(KINDS.has(got.kind)).toBe(true);
						if ("lines" in got) expect(got.lines.length).toBeLessThanOrEqual(limits.lines);
						if ("rows" in got) expect(got.rows.length).toBeLessThanOrEqual(limits.rows);
					}
				},
			),
			{ numRuns: pbtRuns(300) },
		);
	});

	it("reads back a generated CSV table, within its limits", () => {
		const cell = fc.string({ unit: fc.constantFrom("a", "b", " ", ",", ";", '"', "\n", "\t", "é"), maxLength: 220 });
		fc.assert(
			fc.property(
				fc
					.integer({ min: 1, max: 14 })
					.chain((width) =>
						fc.array(fc.array(cell, { minLength: width, maxLength: width }), { minLength: 1, maxLength: 12 }),
					),
				(table) => {
					const csv = table.map((row) => row.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\r\n");
					const got = preview("t.csv", "text/csv", text(csv));
					expect(got).toEqual({
						kind: "sheet",
						rows: table.slice(0, GLIMPSE.rows).map((row) => row.slice(0, 12).map((c) => c.slice(0, 200))),
						total: table.length,
					});
				},
			),
			{ numRuns: pbtRuns(200) },
		);
	});
});
