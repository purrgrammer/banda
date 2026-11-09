/**
 * A page as text a model reads: HTML reduced to plain markdown (headings, paragraphs, lists, links, code, tables),
 * with what is never content left out (scripts, styles, frames) and, in the full pass, a site's chrome too (navigation,
 * asides, forms, a page-level header and footer, what is hidden or labelled as navigation). A page the full pass
 * leaves empty is read again with only what is never content left out, so a shell or a page of links still says what
 * it has. Pure.
 *
 * Every byte here is foreign, so the reading is one pass over the markup with no recursion and no backtracking: a
 * scan for the next `<`, regular expressions whose quantifiers are bounded or whose arms are disjoint, and a stack of
 * open elements that is bounded. Markup nested past any depth, or never closed, costs no more than markup that is
 * not; what is unbalanced reads as well as it can, never throws.
 */

/** What a page said: its text, as markdown, and its title when it named one. */
export type PageText = { readonly title?: string; readonly text: string };

/** The elements whose content is never markup: read raw up to their end tag. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** The elements that never have content. */
const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
/** Never content, in every pass: what a page runs or draws, not what it says. */
const NEVER = new Set([
	"script",
	"style",
	"noscript",
	"iframe",
	"template",
	"svg",
	"math",
	"canvas",
	"object",
	"select",
	"textarea",
	"noembed",
	"noframes",
	"xmp",
	"dialog",
]);
/** A site's chrome, left out by the full pass. `header` and `footer` are, only outside an article, main or section. */
const CHROME = new Set(["nav", "aside", "form", "button"]);
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "menu", "menubar", "dialog"]);
/** Where a header or footer is the content's own (a title, a byline, footnotes), not the site's. */
const CONTENT = new Set(["article", "main", "section"]);
/** The elements that start and end a block of their own. */
const BLOCK = new Set([
	"address",
	"article",
	"aside",
	"body",
	"center",
	"details",
	"dialog",
	"dd",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"header",
	"hgroup",
	"html",
	"legend",
	"main",
	"menu",
	"nav",
	"ol",
	"p",
	"section",
	"summary",
	"table",
	"tbody",
	"thead",
	"tfoot",
	"ul",
	"caption",
]);
const HEADING = /^h([1-6])$/;
/** The elements whose end tag a page may leave out: never left out by an attribute, or the rest of the page would be. */
const OPTIONAL_END = new Set([
	"body",
	"caption",
	"colgroup",
	"dd",
	"dt",
	"head",
	"html",
	"li",
	"optgroup",
	"option",
	"p",
	"rb",
	"rp",
	"rt",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
]);
/** How many elements the reading keeps open at once; past that, what opens is read as text without its marks. */
const MAX_OPEN = 256;

/** Named character references a page uses in its text; any other is left as written. */
const ENTITIES: { readonly [name: string]: string } = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	zwnj: "",
	zwj: "",
	shy: "",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	sbquo: "‚",
	ldquo: "“",
	rdquo: "”",
	bdquo: "„",
	laquo: "«",
	raquo: "»",
	lsaquo: "‹",
	rsaquo: "›",
	bull: "•",
	middot: "·",
	prime: "′",
	Prime: "″",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	plusmn: "±",
	times: "×",
	divide: "÷",
	minus: "−",
	frac12: "½",
	frac14: "¼",
	frac34: "¾",
	sup2: "²",
	sup3: "³",
	micro: "µ",
	para: "¶",
	sect: "§",
	dagger: "†",
	Dagger: "‡",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	curren: "¤",
	larr: "←",
	rarr: "→",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	rArr: "⇒",
	lArr: "⇐",
	le: "≤",
	ge: "≥",
	ne: "≠",
	asymp: "≈",
	infin: "∞",
	hearts: "♥",
	check: "✓",
	iexcl: "¡",
	iquest: "¿",
	ordf: "ª",
	ordm: "º",
	szlig: "ß",
	aacute: "á",
	eacute: "é",
	iacute: "í",
	oacute: "ó",
	uacute: "ú",
	Aacute: "Á",
	Eacute: "É",
	Iacute: "Í",
	Oacute: "Ó",
	Uacute: "Ú",
	agrave: "à",
	egrave: "è",
	ograve: "ò",
	Agrave: "À",
	Egrave: "È",
	acirc: "â",
	ecirc: "ê",
	ocirc: "ô",
	atilde: "ã",
	otilde: "õ",
	Atilde: "Ã",
	Otilde: "Õ",
	ntilde: "ñ",
	Ntilde: "Ñ",
	ccedil: "ç",
	Ccedil: "Ç",
	auml: "ä",
	euml: "ë",
	iuml: "ï",
	ouml: "ö",
	uuml: "ü",
	Auml: "Ä",
	Ouml: "Ö",
	Uuml: "Ü",
	aring: "å",
	Aring: "Å",
	aelig: "æ",
	oslash: "ø",
	Oslash: "Ø",
};

/** A character reference: bounded digits or name, so the scan stays linear. */
const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

/** `text` with its character references decoded; a name not known is left as written. */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(REFERENCE, (whole, decimal?: string, hex?: string, name?: string) => {
		if (name !== undefined) return Object.hasOwn(ENTITIES, name) ? (ENTITIES[name] as string) : whole;
		const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex as string, 16);
		if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
		return String.fromCodePoint(code);
	});
}

type Tag = {
	readonly name: string;
	readonly attrs: Map<string, string>;
	readonly end: number;
	readonly closing: boolean;
};

/** The tag that starts at `at` (its `<`); "text" when none starts there, "unclosed" when it runs off the end. */
function readTag(html: string, at: number): Tag | "text" | "unclosed" {
	let i = at + 1;
	const closing = html[i] === "/";
	if (closing) i += 1;
	const first = html.charCodeAt(i);
	// a tag's name starts with a letter; anything else is text
	if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return "text";
	const nameStart = i;
	while (i < html.length && !/[\s/>]/.test(html[i] as string)) i += 1;
	const name = html.slice(nameStart, i).toLowerCase();
	const attrs = new Map<string, string>();
	while (i < html.length) {
		const c = html[i] as string;
		if (c === ">") return { name, attrs, end: i + 1, closing };
		if (/[\s/]/.test(c)) {
			i += 1;
			continue;
		}
		const attrStart = i;
		while (i < html.length && !/[\s/>=]/.test(html[i] as string)) i += 1;
		// an attribute name is at least one character: a lone `=` is one
		if (i === attrStart) i += 1;
		const attr = html.slice(attrStart, i).toLowerCase();
		while (i < html.length && /\s/.test(html[i] as string)) i += 1;
		let value = "";
		if (html[i] === "=") {
			i += 1;
			while (i < html.length && /\s/.test(html[i] as string)) i += 1;
			const quote = html[i];
			if (quote === '"' || quote === "'") {
				const close = html.indexOf(quote, i + 1);
				const stop = close < 0 ? html.length : close;
				value = html.slice(i + 1, stop);
				i = stop + 1;
			} else {
				const valueStart = i;
				while (i < html.length && !/[\s>]/.test(html[i] as string)) i += 1;
				value = html.slice(valueStart, i);
			}
		}
		if (!attrs.has(attr)) attrs.set(attr, decodeEntities(value));
	}
	return "unclosed";
}

/** Where the raw content of a `name` element that starts at `from` ends: its end tag's `<`, or the end. */
const rawEnds = new Map<string, RegExp>();
function rawEnd(html: string, name: string, from: number): number {
	let pattern = rawEnds.get(name);
	if (pattern === undefined) {
		pattern = new RegExp(`</${name}[\\s/>]`, "gi");
		rawEnds.set(name, pattern);
	}
	pattern.lastIndex = from;
	const found = pattern.exec(html);
	return found === null ? html.length : found.index;
}

/** An address as the page means it, made whole against its base; undefined for one that is not a place to go. */
function address(value: string | undefined, base: URL | undefined): string | undefined {
	const raw = value?.trim();
	if (raw === undefined || raw === "" || raw.startsWith("#")) return undefined;
	try {
		const url = base === undefined ? new URL(raw) : new URL(raw, base);
		if (url.protocol === "javascript:" || url.protocol === "data:" || url.protocol === "vbscript:") return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

/** An open element whose marks wrap what it holds: where its text starts in the output, and how to wrap it. */
type Open = {
	readonly name: string;
	/** The output's chunk count when it opened: what it holds is every chunk after. */
	readonly at: number;
	readonly wrap?: (inner: string) => string;
};

/** One pass over `html`, `strip` saying how much of a site's chrome to leave out. */
function read(html: string, base: URL | undefined, strip: "full" | "minimal"): PageText {
	const out: string[] = [];
	/** For each chunk of `out`, whether it only separates (newlines, a quote's or a list's marks, a space). */
	const sep: boolean[] = [];
	const push = (chunk: string, separates: boolean) => {
		out.push(chunk);
		sep.push(separates);
	};
	let title: string | undefined;
	let ogTitle: string | undefined;
	/** Newlines owed before the next text, and whether a space is. */
	let breaks = 0;
	let space = false;
	let started = false;
	let quote = 0;
	let pre = 0;
	let cells = 0;
	/** Each open list: whether it is numbered, and its next number. */
	const lists: { ordered: boolean; n: number }[] = [];
	/** A list item's marker, written before its first text. */
	let marker: string | undefined;
	/** Whether the current table row has a cell yet. */
	let rowCells = 0;
	/** Content elements open (article, main, section): a header or footer inside one is content. */
	let content = 0;
	const open: Open[] = [];
	/** How many of each name are open, so an end tag of one that is not costs nothing. */
	const counts = new Map<string, number>();
	/** The element being left out, and how many of its name are open inside it. */
	let skipping: { name: string; depth: number } | undefined;

	const block = (n: 1 | 2) => {
		if (cells > 0) {
			space = true;
			return;
		}
		if (started) breaks = Math.max(breaks, n);
	};
	const prefix = () =>
		"> ".repeat(quote) + "  ".repeat(Math.max(0, lists.length - 1)) + (marker ?? (lists.length > 0 ? "  " : ""));
	/** Write `text` as it is (no whitespace folded), after what is owed. */
	const write = (text: string) => {
		if (text === "") return;
		if (!started) {
			push(prefix(), true);
			started = true;
		} else if (breaks > 0) {
			// a blank line inside a quote is the quote's too
			push(`${breaks === 2 ? `\n${"> ".repeat(quote).trimEnd()}` : ""}\n${prefix()}`, true);
		} else if (space) {
			push(" ", true);
		}
		marker = undefined;
		breaks = 0;
		space = false;
		push(text, false);
	};
	/** Text from the page: whitespace folded, unless preformatted. */
	const text = (raw: string) => {
		const decoded = decodeEntities(raw);
		if (pre > 0) {
			if (decoded !== "") {
				if (!started) started = true;
				else if (breaks > 0) push("\n".repeat(breaks), true);
				breaks = 0;
				space = false;
				push(decoded, false);
			}
			return;
		}
		const folded = decoded.replace(/[\t\n\f\r ]+/g, " ");
		if (folded === "") return;
		if (folded === " ") {
			space = true;
			return;
		}
		if (folded.startsWith(" ")) space = true;
		write(folded.trim());
		if (folded.endsWith(" ")) space = true;
	};
	/** Close every open element from `index` on, the last first, each wrapping what it holds. */
	const closeFrom = (index: number) => {
		while (open.length > index) {
			const one = open.pop() as Open;
			counts.set(one.name, (counts.get(one.name) ?? 1) - 1);
			if (one.wrap === undefined) continue;
			// what separates it from what came before stays outside its marks
			let first = one.at;
			while (first < out.length && sep[first] === true) first += 1;
			const lead = out.slice(one.at, first).join("");
			const body = out.slice(first).join("");
			out.length = one.at;
			sep.length = one.at;
			if (lead !== "") push(lead, true);
			if (body.trim() !== "") push(one.wrap(body), false);
		}
	};
	/** Close the open element `name` and every one opened after it; false when it is not open. */
	const close = (name: string) => {
		if ((counts.get(name) ?? 0) === 0) return false;
		for (let i = open.length - 1; i >= 0; i -= 1)
			if (open[i]?.name === name) {
				closeFrom(i);
				return true;
			}
		return false;
	};
	const opens = (name: string, wrap?: (inner: string) => string) => {
		if (open.length >= MAX_OPEN) return;
		open.push(wrap === undefined ? { name, at: out.length } : { name, at: out.length, wrap });
		counts.set(name, (counts.get(name) ?? 0) + 1);
	};
	const oneLine = (inner: string) =>
		inner
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.join(" ");

	const chrome = (tag: Tag) => {
		if (NEVER.has(tag.name)) return true;
		if (strip === "minimal") return false;
		if (CHROME.has(tag.name)) return true;
		if ((tag.name === "header" || tag.name === "footer") && content === 0) return true;
		// hidden or labelled as chrome, unless its end tag may be left out: then where it ends is not known
		if (OPTIONAL_END.has(tag.name)) return false;
		if (tag.attrs.get("aria-hidden")?.trim().toLowerCase() === "true") return true;
		if (tag.attrs.has("hidden")) return true;
		const roles = tag.attrs.get("role")?.toLowerCase().trim().split(/\s+/) ?? [];
		return roles.some((role) => CHROME_ROLES.has(role));
	};

	const start = (tag: Tag) => {
		const { name, attrs } = tag;
		if (name === "base") {
			const href = address(attrs.get("href"), base);
			if (href !== undefined) base = new URL(href);
			return;
		}
		if (name === "meta") {
			const property = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
			if (property === "og:title" && ogTitle === undefined) ogTitle = attrs.get("content")?.trim();
			return;
		}
		if (CONTENT.has(name)) content += 1;
		const heading = HEADING.exec(name);
		if (heading !== null) {
			block(2);
			const level = Number(heading[1]);
			opens(name, (inner) => (cells > 0 ? inner : `${"#".repeat(level)} ${oneLine(inner)}`));
			return;
		}
		switch (name) {
			case "br":
				if (pre > 0) text("\n");
				else if (cells > 0) space = true;
				else breaks = Math.max(breaks, 1);
				return;
			case "hr":
				block(2);
				write("---");
				block(2);
				return;
			case "img": {
				const alt = attrs.get("alt")?.trim().replace(/\s+/g, " ");
				const src = address(attrs.get("src"), base);
				if (alt !== undefined && alt !== "" && src !== undefined) write(`![${alt}](${src})`);
				return;
			}
			case "pre":
				block(2);
				pre += 1;
				opens(name, (inner) => (pre > 0 ? inner : `\`\`\`\n${inner.replace(/^\n/, "").trimEnd()}\n\`\`\``));
				return;
			case "code":
				if (pre === 0) opens(name, (inner) => (inner.includes("`") ? `\`\` ${inner} \`\`` : `\`${inner}\``));
				return;
			case "a": {
				const href = address(attrs.get("href"), base);
				if (pre === 0 && href !== undefined) opens(name, (inner) => `[${oneLine(inner)}](${href})`);
				return;
			}
			case "strong":
			case "b":
				if (pre === 0) opens(name, (inner) => (inner.includes("\n") ? inner : `**${inner}**`));
				return;
			case "em":
			case "i":
				if (pre === 0) opens(name, (inner) => (inner.includes("\n") ? inner : `_${inner}_`));
				return;
			case "blockquote":
				block(2);
				quote += 1;
				opens(name);
				return;
			case "ul":
			case "ol":
				block(lists.length > 0 ? 1 : 2);
				lists.push({ ordered: name === "ol", n: Number(attrs.get("start") ?? 1) || 1 });
				opens(name);
				return;
			case "li": {
				block(1);
				const list = lists.at(-1);
				marker = list?.ordered === true ? `${list.n++}. ` : "- ";
				return;
			}
			case "tr":
				block(1);
				rowCells = 0;
				return;
			case "td":
			case "th":
				if (rowCells > 0) {
					write("|");
					space = true;
				}
				rowCells += 1;
				cells += 1;
				opens(name);
				return;
		}
		if (BLOCK.has(name)) block(2);
	};

	const end = (name: string) => {
		if (CONTENT.has(name) && content > 0) content -= 1;
		switch (name) {
			case "pre":
				if (pre > 0) pre -= 1;
				close(name);
				block(2);
				return;
			case "blockquote":
				if (close(name) && quote > 0) quote -= 1;
				block(2);
				return;
			case "ul":
			case "ol":
				if (close(name)) lists.pop();
				block(lists.length > 0 ? 1 : 2);
				return;
			case "li":
				marker = undefined;
				block(1);
				return;
			case "td":
			case "th":
				if (close(name) && cells > 0) cells -= 1;
				space = true;
				return;
			case "tr":
				block(1);
				return;
		}
		if (HEADING.test(name)) {
			close(name);
			block(2);
			return;
		}
		close(name);
		if (BLOCK.has(name)) block(2);
	};

	let at = 0;
	while (at < html.length) {
		const lt = html.indexOf("<", at);
		const stop = lt < 0 ? html.length : lt;
		if (stop > at && skipping === undefined) text(html.slice(at, stop));
		if (lt < 0) break;
		at = lt;
		if (html.startsWith("<!--", at)) {
			const closeAt = html.indexOf("-->", at + 4);
			at = closeAt < 0 ? html.length : closeAt + 3;
			continue;
		}
		const next = html[at + 1];
		if (next === "!" || next === "?") {
			const closeAt = html.indexOf(">", at + 2);
			at = closeAt < 0 ? html.length : closeAt + 1;
			continue;
		}
		const tag = readTag(html, at);
		// a tag never closed ends the page; a `<` that starts no tag is text
		if (tag === "unclosed") break;
		if (tag === "text") {
			if (skipping === undefined) text("<");
			at += 1;
			continue;
		}
		at = tag.end;
		if (!tag.closing && RAW.has(tag.name)) {
			// raw content: up to its end tag, never markup; a title is the page's, anything else is left out
			const rawStop = rawEnd(html, tag.name, at);
			if (tag.name === "title" && title === undefined && skipping === undefined)
				title = decodeEntities(html.slice(at, rawStop)).replace(/\s+/g, " ").trim();
			const endTag = rawStop < html.length ? html.indexOf(">", rawStop) : -1;
			at = endTag < 0 ? html.length : endTag + 1;
			continue;
		}
		if (skipping !== undefined) {
			if (tag.name === skipping.name && !VOID.has(tag.name)) {
				skipping.depth += tag.closing ? -1 : 1;
				if (skipping.depth === 0) skipping = undefined;
			}
			continue;
		}
		if (tag.closing) {
			end(tag.name);
			continue;
		}
		if (chrome(tag)) {
			if (!VOID.has(tag.name)) skipping = { name: tag.name, depth: 1 };
			continue;
		}
		start(tag);
	}
	closeFrom(0);
	return {
		...(title !== undefined && title !== "" ? { title } : ogTitle ? { title: ogTitle } : {}),
		text: tidy(out.join("")),
	};
}

/** A line of separators and nothing else: what is left of a row of icon links. */
const SEPARATORS = /^[\s|•·+\-*/]*$/;

/** The text, its lines' trailing spaces and lines of separators gone, and no more than one blank line in a row. */
function tidy(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line === "" || line === "---" || !SEPARATORS.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * `html` as markdown a model reads, links made whole against `base` (the page's address): the full pass first, and
 * a page it leaves empty read again leaving out only what is never content.
 */
export function htmlToText(html: string, base?: string): PageText {
	let url: URL | undefined;
	try {
		url = base === undefined ? undefined : new URL(base);
	} catch {
		url = undefined;
	}
	const full = read(html, url, "full");
	if (full.text !== "") return full;
	const minimal = read(html, url, "minimal");
	return { ...(full.title === undefined ? {} : { title: full.title }), text: minimal.text };
}
