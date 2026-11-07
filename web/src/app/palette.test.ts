import { describe, expect, it } from "vitest";
import { firstLiveValue, matchAgents, matches, matchPages, matchSkills } from "./palette.ts";

describe("matches", () => {
	it("matches a word prefix, whatever the case", () => {
		expect(matches("mar", "Mara")).toBe(true);
		expect(matches("MARA", "mara")).toBe(true);
		expect(matches("san", "Sancho")).toBe(true);
	});

	it("never matches inside a word", () => {
		expect(matches("ara", "Mara")).toBe(false);
		expect(matches("cho", "Sancho")).toBe(false);
	});

	it("ignores accents on both sides", () => {
		expect(matches("jose", "José")).toBe(true);
		expect(matches("josé", "Jose")).toBe(true);
		expect(matches("provenc", "Provençal notes")).toBe(true);
	});

	it("asks every word of the query to begin some word of the text", () => {
		expect(matches("read pdf", "Read any PDF aloud")).toBe(true);
		expect(matches("read xlsx", "Read any PDF aloud")).toBe(false);
		expect(matches("pdf read", "Read any PDF aloud")).toBe(true);
	});

	it("matches nothing on an empty or blank query", () => {
		expect(matches("", "Mara")).toBe(false);
		expect(matches("   ", "Mara")).toBe(false);
	});
});

describe("local sections", () => {
	const agents = [{ name: "Mara" }, { name: "Sancho" }, { name: "José" }];
	const skills = [
		{ name: "pdf", description: "Read any PDF aloud" },
		{ name: "xlsx", description: "Spreadsheets, summed up" },
	];

	it("finds agents by name", () => {
		expect(matchAgents(agents, "ma")).toEqual([{ name: "Mara" }]);
		expect(matchAgents(agents, "jose")).toEqual([{ name: "José" }]);
		expect(matchAgents(agents, "")).toEqual([]);
	});

	it("finds skills by name or description", () => {
		expect(matchSkills(skills, "pdf").map((skill) => skill.name)).toEqual(["pdf"]);
		expect(matchSkills(skills, "spread").map((skill) => skill.name)).toEqual(["xlsx"]);
		expect(matchSkills(skills, "")).toEqual([]);
	});

	it("finds pages by label", () => {
		expect(matchPages("sett").map((page) => page.id)).toEqual(["settings"]);
		expect(matchPages("s").map((page) => page.id)).toEqual(["skills", "settings"]);
		expect(matchPages("")).toEqual([]);
	});
});

describe("firstLiveValue", () => {
	const agents = [{ id: "mara" }, { id: "sancho" }];
	const skills = [{ name: "pdf" }, { name: "xlsx" }];
	const pages = [{ id: "settings" }];

	it("moves the active row to the first live section, in the list's order", () => {
		expect(firstLiveValue(agents, skills, pages)).toBe("agent:mara");
		expect(firstLiveValue([], skills, pages)).toBe("skill:pdf");
		expect(firstLiveValue([], [], pages)).toBe("page:settings");
	});

	it("moves it to none when no local row is live", () => {
		expect(firstLiveValue([], [], [])).toBe("");
	});
});
