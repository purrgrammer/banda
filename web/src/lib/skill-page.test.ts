/** The Skills page model: what the filter matches, what the form refuses and in which words, which offers remain. */
import { describe, expect, it } from "vitest";
import { parseSkill } from "../../../src/core/skill-file.ts";
import { filterSkills, NAME_RULE, offersLeft, skillFormState } from "./skill-page.ts";

const file = (name: string, description = "Fill tables fast", body = "Read the sheet first.") =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

describe("filtering the list", () => {
	const skills = [
		{ name: "pdf", description: "Read and fill PDF forms" },
		{ name: "xlsx", description: "Spreadsheets without surprises" },
		{ name: "deploy-staging", description: "Déployer sur l'environnement de test" },
	];
	it("matches name and description, case aside", () => {
		expect(filterSkills(skills, "PDF").map(({ name }) => name)).toEqual(["pdf"]);
		expect(filterSkills(skills, "surprises").map(({ name }) => name)).toEqual(["xlsx"]);
		expect(filterSkills(skills, "  Forms ").map(({ name }) => name)).toEqual(["pdf"]);
	});
	it("matches accents aside, both ways", () => {
		expect(filterSkills(skills, "deployer").map(({ name }) => name)).toEqual(["deploy-staging"]);
		expect(filterSkills(skills, "Déploy").map(({ name }) => name)).toEqual(["deploy-staging"]);
	});
	it("an empty query keeps every row; no match keeps none", () => {
		expect(filterSkills(skills, "")).toEqual(skills);
		expect(filterSkills(skills, "nothing-like-this")).toEqual([]);
	});
});

describe("the form's verdicts", () => {
	it("refuses the names the daemon refuses, in the hint's words", () => {
		for (const name of ["my skill", "Skill_1", "-pdf", "pdf-", "a--b", "é", "a".repeat(65)]) {
			const state = skillFormState({ name, text: file(name) });
			expect(state.badName, name).toBe(true);
			expect(state.problems).toContain(NAME_RULE);
			expect(state.valid).toBe(false);
			expect(() => parseSkill(name, file(name))).toThrow();
		}
	});
	it("an empty name is unfinished, not an error", () => {
		const state = skillFormState({ name: "", text: "" });
		expect(state.badName).toBe(false);
		expect(state.valid).toBe(false);
	});
	it("says when the name is taken", () => {
		const state = skillFormState({ name: "pdf", text: file("pdf"), existing: ["pdf", "xlsx"] });
		expect(state.taken).toBe(true);
		expect(state.problems).toContain("A skill called /pdf already exists.");
		expect(state.valid).toBe(false);
	});
	it("a valid name and file pass, and would pass the daemon", () => {
		const state = skillFormState({ name: "deploy-staging", text: file("deploy-staging"), existing: ["pdf"] });
		expect(state).toMatchObject({ badName: false, taken: false, problems: [], valid: true });
		expect(parseSkill("deploy-staging", file("deploy-staging")).name).toBe("deploy-staging");
	});
	it("wants the file's name line to match", () => {
		const state = skillFormState({ name: "pdf", text: file("xlsx") });
		expect(state.problems).toEqual(["The file's name line must say pdf."]);
		expect(state.valid).toBe(false);
	});
	it("wants a description of 1 to 1,024 characters, and shows it as typed", () => {
		const missing = skillFormState({ name: "pdf", text: "---\nname: pdf\n---\n\nBody." });
		expect(missing.problems).toEqual(["The description needs 1 to 1,024 characters."]);
		expect(missing.description).toBe("");
		const long = skillFormState({ name: "pdf", text: file("pdf", "d".repeat(1025)) });
		expect(long.problems).toEqual(["The description needs 1 to 1,024 characters."]);
		expect(long.description.length).toBe(1025);
		const fine = skillFormState({ name: "pdf", text: file("pdf", "Read and fill PDF forms") });
		expect(fine.description).toBe("Read and fill PDF forms");
		expect(fine.valid).toBe(true);
	});
	it("wants --- frontmatter", () => {
		const state = skillFormState({ name: "pdf", text: "Just a body." });
		expect(state.problems).toEqual(["Start the file with --- lines giving the skill's name and description."]);
	});
	it("shows the size only near the limit, and refuses past it", () => {
		const small = skillFormState({ name: "pdf", text: file("pdf") });
		expect(small.size).toBeUndefined();
		expect(small.overSize).toBe(false);
		const near = skillFormState({ name: "pdf", text: file("pdf", "Fill tables", "x".repeat(50_000)) });
		expect(near.size).toBe("49 KB of 64 KB");
		expect(near.overSize).toBe(false);
		expect(near.valid).toBe(true);
		const over = skillFormState({ name: "pdf", text: file("pdf", "Fill tables", "x".repeat(66_000)) });
		expect(over.size).toBe("65 KB of 64 KB");
		expect(over.overSize).toBe(true);
		expect(over.problems).toEqual(["The file is over 64 KB. Shorten it to save."]);
		expect(over.valid).toBe(false);
		expect(() => parseSkill("pdf", file("pdf", "Fill tables", "x".repeat(66_000)))).toThrow("at most 64 KB");
	});
	it("size counts bytes, not characters", () => {
		const state = skillFormState({ name: "pdf", text: file("pdf", "Fill tables", "é".repeat(33_000)) });
		expect(state.overSize).toBe(true);
	});
});

describe("the From banda rows", () => {
	it("keeps only what is not in the workspace, and none hides the section", () => {
		const offers = [
			{ name: "pdf", added: true },
			{ name: "xlsx", added: false },
			{ name: "deploy-staging", added: false },
		];
		expect(offersLeft(offers).map(({ name }) => name)).toEqual(["xlsx", "deploy-staging"]);
		expect(offersLeft(offers.map((offer) => ({ ...offer, added: true })))).toEqual([]);
	});
});
