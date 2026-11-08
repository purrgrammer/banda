import { describe, expect, it } from "vitest";
import type { ObjectShown } from "../../../src/server/objects.ts";
import { sharedReads } from "./object-reads.ts";

const LINK: ObjectShown = { shown: "link" };

describe("one read of an object for every line that names it", () => {
	it("asks once for the same object, chat and agent while the watches stand; again as another agent", async () => {
		const asked: string[] = [];
		const read = sharedReads(async (chat, reference, agent) => {
			asked.push(`${chat} ${reference} ${agent ?? "-"}`);
			return LINK;
		});
		const [a, b] = await Promise.all([read(1, "github:pr:1", "mara", "m1"), read(1, "github:pr:1", "mara", "m1")]);
		expect(a).toBe(LINK);
		expect(b).toBe(LINK);
		await read(1, "github:pr:1", "mara", "m1");
		await read(1, "github:pr:1", "otto", "m1");
		await read(2, "github:pr:1", "mara", "m1");
		expect(asked).toEqual(["1 github:pr:1 mara", "1 github:pr:1 otto", "2 github:pr:1 mara"]);
	});

	it("reads again once the watches moved: a followed object changed", async () => {
		let asked = 0;
		const read = sharedReads(async () => {
			asked++;
			return LINK;
		});
		await read(1, "github:pr:1", undefined, "m1");
		await read(1, "github:pr:1", undefined, "m1");
		expect(asked).toBe(1);
		await read(1, "github:pr:1", undefined, "m2");
		expect(asked).toBe(2);
	});

	it("keeps no read that failed: the next line that asks tries again", async () => {
		let asked = 0;
		const read = sharedReads(async () => {
			asked++;
			if (asked === 1) throw new Error("the daemon did not answer");
			return LINK;
		});
		await expect(read(1, "github:pr:1", undefined, "m1")).rejects.toThrow("did not answer");
		expect(await read(1, "github:pr:1", undefined, "m1")).toBe(LINK);
		expect(asked).toBe(2);
	});
});
