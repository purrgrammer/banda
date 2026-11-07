/** The band's own file, `band.md` at the workspace root: its pins read, written in the owner's order, never through a link. */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { BAND_FILE, bandFile, DEFAULT_PINS, isPin, MAX_PINS, pinned, pinsOf } from "../src/core/band.ts";
import type { Workspace } from "../src/server/agents.ts";
import { BadRequest } from "../src/server/http.ts";
import { bandView, pin } from "../src/server/routes/band.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const boxes: Box[] = [];
afterAll(() => {
	for (const box of boxes) box.close();
});

async function workspace(): Promise<Workspace> {
	const box = openBox(hostBox(await tempHome()), () => {});
	boxes.push(box);
	return { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
}

const pinArb = fc.oneof(
	fc.stringMatching(/^[a-z][a-z0-9]{0,8}(?:-[a-z0-9]{1,4})?$/),
	fc.integer({ min: 1, max: 99_999 }).map((room) => `group:${room}`),
);

describe("band.md", () => {
	it("pins Sancho with no file, nothing with an empty list", () => {
		expect(pinsOf(undefined)).toEqual(DEFAULT_PINS);
		expect(pinsOf(bandFile([]))).toEqual([]);
		expect(pinsOf("no front matter")).toEqual([]);
	});

	it("reads what the owner wrote by hand, skipping what is not a pin and repeats", () => {
		const text = '---\ntitle: mine\npinned:\n  - mara\n  - "group:3"\n  - Not A Pin\n  - mara\nother:\n  - octo\n---\n';
		expect(pinsOf(text)).toEqual(["mara", "group:3"]);
	});

	it("reads back any pins it writes, in order, each once", () => {
		fc.assert(
			fc.property(fc.array(pinArb, { maxLength: 60 }), (pins) => {
				const once = [...new Set(pins)].slice(0, MAX_PINS);
				expect(pinsOf(bandFile(once))).toEqual(once);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("pins to the end of the row and unpins, never twice", () => {
		fc.assert(
			fc.property(fc.uniqueArray(pinArb, { maxLength: 10 }), pinArb, fc.boolean(), (pins, one, on) => {
				const next = pinned(pins, one, on);
				expect(next.filter((each) => each === one)).toHaveLength(on ? 1 : 0);
				if (on) expect(next.at(-1)).toBe(one);
				expect(next.filter((each) => each !== one)).toEqual(pins.filter((each) => each !== one));
			}),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("takes agents' ids and groups' rooms as pins, nothing else", () => {
		expect(["sancho", "mara-2", "group:3"].every(isPin)).toBe(true);
		expect(["", "Sancho", "group:0", "group:x", "../x", "a b"].some(isPin)).toBe(false);
	});
});

describe("pinning in the box", () => {
	it("writes band.md at the workspace root and reads it back", async () => {
		const at = await workspace();
		expect(await bandView(at)).toEqual({ pinned: ["sancho"] });
		expect(await pin(at, "mara", true)).toEqual({ pinned: ["sancho", "mara"] });
		expect(await pin(at, "group:4", true)).toEqual({ pinned: ["sancho", "mara", "group:4"] });
		expect(await pin(at, "sancho", false)).toEqual({ pinned: ["mara", "group:4"] });
		expect(await bandView(at)).toEqual({ pinned: ["mara", "group:4"] });
		expect(readFileSync(join(at.root, BAND_FILE), "utf8")).toBe(bandFile(["mara", "group:4"]));
	});

	it("never writes through a link, and shows Sancho's pins while one is there", async () => {
		const at = await workspace();
		mkdirSync(at.root, { recursive: true });
		const outside = join(at.root, "..", "outside.md");
		writeFileSync(outside, bandFile(["mara"]));
		symlinkSync(outside, join(at.root, BAND_FILE));
		expect(await bandView(at)).toEqual({ pinned: ["sancho"], unavailable: true });
		await expect(pin(at, "octo", true)).rejects.toBeInstanceOf(BadRequest);
		expect(readFileSync(outside, "utf8")).toBe(bandFile(["mara"]));
	});
});
