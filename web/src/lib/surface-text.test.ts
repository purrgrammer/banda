/**
 * shadcn's surface tokens (accent, muted, secondary, card, popover, background) are backgrounds in banda's palette
 * (globals.css maps --accent to --paper-3): as a text colour they draw paper on paper. Banda's own components colour
 * text with its ink tokens; the vendored ui/ and ai-elements/ pair them with their -foreground as shipped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const SURFACE_AS_TEXT = /\btext-(accent|muted|secondary|card|popover|background|sidebar|input)\b(?!-foreground)/g;
const root = new URL("..", import.meta.url).pathname;
const vendored = new Set(["ui", "ai-elements"]);

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return vendored.has(name) ? [] : sources(path);
		return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
	});
}

it("banda's components never colour text with a surface token", () => {
	const found = sources(root).flatMap((path) =>
		[...readFileSync(path, "utf8").matchAll(SURFACE_AS_TEXT)].map((match) => `${path.slice(root.length)}: ${match[0]}`),
	);
	expect(found).toEqual([]);
});
