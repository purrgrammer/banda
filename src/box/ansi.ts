/**
 * Terminal escape sequences out of a command's output stream. pi-durable keeps a tool's output through chord's
 * sanitizer, which removes the ESC byte of a sequence and leaves the rest, so `ESC[32m` would reach the model and the
 * transcript as `[32m`. Whole sequences go here, before the output reaches pi-durable: control sequences (CSI),
 * strings (OSC, DCS, SOS, PM, APC, to BEL or ST) and the short escapes (charset, keypad and cursor saves).
 */

const ESC = 0x1b;
/** An unended sequence held back for the next chunk, at most this long; past it the ESC alone goes. */
const MAX_HELD = 4096;

/** A stripper for one stream: each chunk in, its text out; a sequence split across chunks is held until it ends. */
export function ansiStripper(): (chunk: string) => string {
	let held = "";
	return (chunk) => {
		const text = held + chunk;
		held = "";
		let out = "";
		let from = 0;
		for (let at = text.indexOf("\u001b"); at !== -1; at = text.indexOf("\u001b", from)) {
			out += text.slice(from, at);
			const end = sequenceEnd(text, at);
			if (end !== undefined) from = end;
			else if (text.length - at <= MAX_HELD) {
				held = text.slice(at);
				return out;
			} else from = at + 1;
		}
		return out + text.slice(from);
	};
}

/** Where the sequence at `at` (an ESC) ends, exclusive; `undefined` when `text` ends before it does. */
function sequenceEnd(text: string, at: number): number | undefined {
	let i = at + 1;
	if (i >= text.length) return undefined;
	const kind = text.charCodeAt(i);
	if (kind === 0x5b) {
		// CSI: parameters 0x30–0x3f, intermediates 0x20–0x2f, a final 0x40–0x7e; anything else breaks it off
		for (i++; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) return i + 1;
			if (c < 0x20 || c > 0x3f) return i;
		}
		return undefined;
	}
	if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
		// a string: ends at BEL or ST (ESC \); another ESC cancels it and starts its own sequence
		for (i++; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c === 0x07) return i + 1;
			if (c === ESC) {
				if (i + 1 >= text.length) return undefined;
				return text.charCodeAt(i + 1) === 0x5c ? i + 2 : i;
			}
		}
		return undefined;
	}
	// intermediates 0x20–0x2f, then a final 0x30–0x7e (ESC ( B, ESC 7, ESC =, ESC c); anything else breaks it off
	for (; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0x30 && c <= 0x7e) return i + 1;
		if (c < 0x20 || c > 0x2f) return i;
	}
	return undefined;
}
