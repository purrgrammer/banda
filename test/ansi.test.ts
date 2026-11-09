/**
 * A command's escape sequences out of its output stream (src/box/ansi.ts): whole sequences go, however the stream is
 * cut into chunks, and the text around them stays as it was.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ansiStripper } from "../src/box/ansi.ts";
import { pbtRuns } from "./pbt.ts";

const strip = (...chunks: string[]) => {
	const stripper = ansiStripper();
	return chunks.map(stripper).join("");
};

/** What colourful tools print: SGR, cursor and erase controls, titles and links, charset and keypad escapes. */
const SEQUENCES = [
	"\u001b[0m",
	"\u001b[1m",
	"\u001b[22m",
	"\u001b[38;5;208m",
	"\u001b[38;2;10;20;30m",
	"\u001b[2K",
	"\u001b[?25l",
	"\u001b[1G",
	"\u001b]0;title\u0007",
	"\u001b]8;;https://example.com\u001b\\",
	"\u001b(B",
	"\u001b7",
	"\u001b=",
	"\u001bc",
];

/** Text with no ESC in it, as printable as a command's output, newlines and tabs included. */
const plain = fc.string({ unit: fc.constantFrom("a", "Z", "1", " ", "[", "m", ";", "\n", "\t", "é", "→", "\\", "]") });

describe("the escape sequences of a command's output", () => {
	it("go whole, leaving what vitest prints as text", () => {
		const vitest =
			"\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m\n";
		expect(strip(vitest)).toBe(" Test Files  1 passed (1)\n");
		expect(strip("\u001b(B\u001b[mplain")).toBe("plain");
	});

	it("go however the stream is cut, and the text between them stays", () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(plain, fc.constantFrom(...SEQUENCES))),
				plain,
				fc.array(fc.nat()),
				(pairs, last, cuts) => {
					const text = pairs.map(([before]) => before).join("") + last;
					const stream = pairs.map(([before, sequence]) => before + sequence).join("") + last;
					const at = [...new Set(cuts.map((cut) => cut % (stream.length + 1)))].sort((a, b) => a - b);
					const chunks = [0, ...at].map((from, i) => stream.slice(from, at[i] ?? stream.length));
					expect(strip(...chunks)).toBe(text);
				},
			),
			{ numRuns: pbtRuns(300) },
		);
	});

	it("a lone or broken escape loses only its ESC and what began a sequence; the text after it stays", () => {
		expect(strip("a\u001b\nb")).toBe("a\nb");
		expect(strip("a\u001b\u001b[1mb")).toBe("ab");
		expect(strip("a\u001b[12\nb")).toBe("a\nb");
		expect(strip("a\u001b]0;title\u001b[1mb")).toBe("ab");
	});

	it("an unended sequence is held for the next chunk, but not forever", () => {
		const stripper = ansiStripper();
		expect(stripper("ok\u001b[3")).toBe("ok");
		expect(stripper("2mgreen")).toBe("green");
		const title = `\u001b]0;${"x".repeat(5000)}`;
		expect(stripper(title)).toBe(`]0;${"x".repeat(5000)}`);
	});
});
