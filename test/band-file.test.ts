/**
 * The band's own file, `band.json` at the workspace root: typed by its schema, its pins written in the owner's order,
 * never through a link nor over a file that does not fit.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { AGENT_NAME } from "../src/core/agents.ts";
import { BAND_FILE, bandFile, DEFAULT_PINS, isPin, MAX_PINS, pinned, readBandFile } from "../src/core/band.ts";
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

describe("band.json", () => {
	it("pins Sancho with no file, nothing with an empty list", () => {
		expect(readBandFile(undefined)).toEqual({ pinned: DEFAULT_PINS });
		expect(readBandFile(bandFile([]))).toEqual({ pinned: [] });
	});

	it("reads only what fits its schema, so nothing else is ever written over", () => {
		for (const text of [
			"pinned: [sancho]",
			"{}",
			'{"pinned": "sancho"}',
			'{"pinned": ["Sancho"]}',
			'{"pinned": ["mara", "mara"]}',
			'{"pinned": [], "more": true}',
			JSON.stringify({ pinned: Array.from({ length: MAX_PINS + 1 }, (_, i) => `group:${i + 1}`) }),
		])
			expect(readBandFile(text)).toHaveProperty("unreadable");
		expect(readBandFile('{ "pinned": ["mara", "group:3"] }')).toEqual({ pinned: ["mara", "group:3"] });
	});

	it("reads back any pins it writes, in order", () => {
		fc.assert(
			fc.property(fc.uniqueArray(pinArb, { maxLength: MAX_PINS }), (pins) => {
				expect(readBandFile(bandFile(pins))).toEqual({ pinned: pins });
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

	it("takes agents' ids, as an agent file names them, and groups' rooms as pins, nothing else", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 12 }), (text) => {
				expect(isPin(text)).toBe(AGENT_NAME.test(text) || /^group:[1-9][0-9]{0,9}$/.test(text));
			}),
			{ numRuns: pbtRuns(200) },
		);
		expect(["sancho", "mara-2", "group:3"].every(isPin)).toBe(true);
		expect(["", "Sancho", "group:0", "group:x", "../x", "a b"].some(isPin)).toBe(false);
	});
});

describe("pinning in the box", () => {
	it("writes band.json at the workspace root and reads it back", async () => {
		const at = await workspace();
		expect(await bandView(at)).toEqual({ pinned: ["sancho"] });
		expect(await pin(at, "mara", true)).toEqual({ pinned: ["sancho", "mara"] });
		expect(await pin(at, "group:4", true)).toEqual({ pinned: ["sancho", "mara", "group:4"] });
		expect(await pin(at, "sancho", false)).toEqual({ pinned: ["mara", "group:4"] });
		expect(await bandView(at)).toEqual({ pinned: ["mara", "group:4"] });
		expect(JSON.parse(readFileSync(join(at.root, BAND_FILE), "utf8"))).toEqual({ pinned: ["mara", "group:4"] });
	});

	it("never writes over a file that does not fit, and shows Sancho's pins while it is there", async () => {
		const at = await workspace();
		mkdirSync(at.root, { recursive: true });
		writeFileSync(join(at.root, BAND_FILE), "pinned:\n  - mara\n");
		expect(await bandView(at)).toEqual({ pinned: ["sancho"], unavailable: true });
		await expect(pin(at, "octo", true)).rejects.toBeInstanceOf(BadRequest);
		expect(readFileSync(join(at.root, BAND_FILE), "utf8")).toBe("pinned:\n  - mara\n");
	});

	it("never writes through a link", async () => {
		const at = await workspace();
		mkdirSync(at.root, { recursive: true });
		const outside = join(at.root, "..", "outside.json");
		writeFileSync(outside, bandFile(["mara"]));
		symlinkSync(outside, join(at.root, BAND_FILE));
		expect(await bandView(at)).toEqual({ pinned: ["sancho"], unavailable: true });
		await expect(pin(at, "octo", true)).rejects.toBeInstanceOf(BadRequest);
		expect(readFileSync(outside, "utf8")).toBe(bandFile(["mara"]));
	});
});
