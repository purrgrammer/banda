/** The search index's groups and artifacts: caught up from cursors, found by kind, gone when their source goes. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Search, terms } from "../src/core/search.ts";
import { tempHome } from "./helpers.ts";

describe("search index", () => {
	it("indexes a group's lines once, from its cursor", async () => {
		const index = new Search(join(await tempHome(), "search.db"));
		try {
			const lines = [
				{ entry: 3, who: "owner", text: "Plan Lisbon", at: 1 },
				{ entry: 5, who: "mara", text: "Lisbon flights found", at: 2 },
			];
			index.groupLines(7, lines);
			index.groupLines(7, lines);
			index.groupLines(7, [...lines, { entry: 9, who: "sancho", text: "Lisbon is blocked in your calendar", at: 3 }]);
			const hits = index.find("lisbon", 10, ["group"]);
			expect(hits).toHaveLength(3);
			expect(hits).toContainEqual(expect.objectContaining({ kind: "group", room: 7, entry: 5, who: "mara" }));
			// recall's kinds never see a group's lines
			expect(index.find("lisbon", 10)).toEqual([]);
		} finally {
			index.close();
		}
	});

	it("indexes an artifact's title and words again when its newest version changes, and drops it when it goes", async () => {
		const index = new Search(join(await tempHome(), "search.db"));
		try {
			index.artifacts([{ id: "a1", title: "Itinerary", sha: "s1", text: "Friday: the 9:15 to Lisbon" }]);
			expect(index.find("itinerary", 10, ["artifact"])).toEqual([
				expect.objectContaining({ kind: "artifact", id: "a1", title: "Itinerary" }),
			]);
			index.artifacts([{ id: "a1", title: "Itinerary", sha: "s2", text: "Saturday: Belém" }]);
			expect(index.find("lisbon", 10, ["artifact"])).toEqual([]);
			expect(index.find("belém", 10, ["artifact"])).toHaveLength(1);
			index.artifacts([]);
			expect(index.find("itinerary", 10, ["artifact"])).toEqual([]);
		} finally {
			index.close();
		}
	});
});

describe("search terms", () => {
	it("finds a word being typed by its start", async () => {
		const index = new Search(join(await tempHome(), "search.db"));
		try {
			index.groupLines(1, [{ entry: 2, who: "mara", text: "Lisbon flights found", at: 1 }]);
			expect(index.find("lisb", 10, ["group"])).toHaveLength(1);
			expect(index.find("fli lisbon", 10, ["group"])).toHaveLength(1);
			expect(terms("Lisbon, lisbon flights")).toBe('"lisbon" OR "flights"*');
		} finally {
			index.close();
		}
	});
});
