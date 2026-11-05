/**
 * A request as a person reads it, on an approval card and in the activity (DESIGN.md "Safe by consequence"): its body
 * in words and its readable fields, its headers and address with every credential masked. What an approval binds is
 * the request's exact bytes, by their hash or ticket, never these words; so a credential is never written into a draft
 * in full, and no view of the store can show one.
 */

/** A header or field whose name says it holds a credential. */
const SECRET_NAME = /auth|cookie|token|secret|key|session|passw|signature|credential/i;

/** How a value that holds a credential is shown: its first characters when it is long enough to spare them, and its length. */
export function masked(value: string): string {
	const length = [...value].length;
	return length >= 16 ? `${value.slice(0, 4)}… (${length} characters)` : `hidden (${length} characters)`;
}

/** Bits per character of a value's spread of characters. */
function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
	return bits;
}

/**
 * Whether a value looks like a key: one long run of token characters (no spaces, not an address) mixing letters and
 * digits, spread wide. A shape, not a proof: a key of another shape passes, and the name rule catches most of those.
 */
export function secretLooking(value: string): boolean {
	const v = value.trim();
	if (v.length < 16 || !/^[A-Za-z0-9+/=_\-.~]+$/.test(v)) return false;
	if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
	return entropy(v) >= 3;
}

/** Whether a named value (a header, a query parameter, a field) is a credential by its name or its shape. */
export function isSecret(name: string, value: string): boolean {
	return SECRET_NAME.test(name) || secretLooking(value);
}

/** A header line as shown: a session cookie named only, any other credential masked. */
export function headerWords(name: string, value: string): string {
	if (name.trim().toLowerCase() === "cookie") return `${name}: (the browser's session, hidden)`;
	return `${name}: ${isSecret(name, value) ? masked(value) : value}`;
}

/** Headers as shown, one a line. */
export const headersWords = (headers: readonly (readonly [string, string])[]): string =>
	headers.map(([name, value]) => headerWords(name, value)).join("\n");

/** An address as shown: each query parameter that is a credential masked, the rest as it is. */
export function addressWords(address: string): string {
	const at = address.indexOf("?");
	if (at < 0) return address;
	const hash = address.indexOf("#", at);
	const query = address.slice(at + 1, hash < 0 ? undefined : hash);
	const shown = query
		.split("&")
		.map((pair) => {
			const eq = pair.indexOf("=");
			if (eq < 0) return pair;
			const name = pair.slice(0, eq);
			let value = pair.slice(eq + 1);
			try {
				value = decodeURIComponent(value.replace(/\+/g, " "));
			} catch {
				// as it is
			}
			return isSecret(name, value) ? `${name}=${encodeURIComponent(masked(value))}` : pair;
		})
		.join("&");
	return `${address.slice(0, at + 1)}${shown}${hash < 0 ? "" : address.slice(hash)}`;
}

/** A body (base64) as a person reads it, or what it is when it is not text; cut. */
export function bodyWords(body: string): string {
	const text = bodyText(body);
	if (typeof text !== "string") return text.what;
	const bytes = Buffer.from(body, "base64").length;
	return text.length > 4000 ? `${text.slice(0, 4000)}\n… (${bytes} bytes in all)` : text;
}

function bodyText(body: string): string | { readonly what: string } {
	const bytes = Buffer.from(body, "base64");
	if (bytes.length === 0) return { what: "(empty)" };
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what marks a body as binary
	if (text.includes("�") || /[\x00-\x08\x0e-\x1f]/.test(text))
		return { what: `(${bytes.length} bytes of binary data)` };
	return text;
}

const MAX_FIELDS = 12;
const MAX_VALUE = 120;

/** A field's value in a few words: a scalar as it is (cut), a nested one by its size. */
function fieldWords(name: string, value: unknown): string {
	if (value === null) return "—";
	if (Array.isArray(value)) return value.length === 1 ? "(1 item)" : `(${value.length} items)`;
	if (typeof value === "object") {
		const n = Object.keys(value).length;
		return n === 1 ? "(1 field)" : `(${n} fields)`;
	}
	const text = typeof value === "string" ? value : String(value);
	if (isSecret(name, text)) return masked(text);
	return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/**
 * A body's readable fields, by name, as a person reads them: a JSON object's or a form's top-level fields (nested
 * values by their size, credentials masked), at most a dozen; undefined when the body is none of those.
 */
export function bodyFields(body: string, contentType = ""): Record<string, string> | undefined {
	const text = bodyText(body);
	if (typeof text !== "string") return undefined;
	let entries: [string, unknown][] | undefined;
	if (/json/i.test(contentType) || /^\s*\{/.test(text)) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) entries = Object.entries(parsed);
		} catch {
			// not JSON after all
		}
	}
	if (entries === undefined && (/x-www-form-urlencoded/i.test(contentType) || /^[^\s=&]+=[^\s]*$/.test(text)))
		entries = [...new URLSearchParams(text).entries()];
	if (entries === undefined || entries.length === 0) return undefined;
	// own keys whatever the page named them (`__proto__` included)
	return Object.fromEntries([
		...entries.slice(0, MAX_FIELDS).map(([name, value]) => [name, fieldWords(name, value)]),
		...(entries.length > MAX_FIELDS ? [["and more", `${entries.length - MAX_FIELDS} more fields`]] : []),
	]);
}
