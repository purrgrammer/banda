import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted } from "../src/core/agents.ts";
import { Companion } from "../src/core/companion.ts";
import { acceptedSkills, MAX_SKILL_BYTES, parseSkill } from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import type { Workspace } from "../src/server/agents.ts";
import { chooseShippedSkills, OFFERED_SKILLS, SHIPPED_SKILLS, saveSkill, shippedSkills } from "../src/server/skills.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome } from "./helpers.ts";

describe("the skills banda ships", () => {
	it("each parses under its folder's name, within the size limit, with its license, and is offered", async () => {
		const folders = (await readdir(SHIPPED_SKILLS, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map(({ name }) => name)
			.sort();
		expect(folders).toEqual(OFFERED_SKILLS.map(({ name }) => name).sort());
		for (const name of folders) {
			const text = await readFile(join(SHIPPED_SKILLS, name, "SKILL.md"), "utf8");
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_SKILL_BYTES);
			expect(parseSkill(name, text).name).toBe(name);
			const files = await readdir(join(SHIPPED_SKILLS, name));
			expect(
				files.some((file) => /^LICENSE/.test(file)),
				`${name} carries its license`,
			).toBe(true);
		}
		expect(OFFERED_SKILLS.filter(({ byDefault }) => !byDefault).map(({ name }) => name)).toEqual(["diagram-design"]);
		expect(
			parseSkill("catch-me-up", await readFile(join(SHIPPED_SKILLS, "catch-me-up/SKILL.md"), "utf8")).ownerOnly,
		).toBe(true);
	});
});

async function setup() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
	const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
	return {
		box,
		harness,
		workspace,
		accepted: async () =>
			acceptedSkills((await harness.snapshot(Accepted, context))?.files ?? {}).map(({ name, body }) => ({
				name,
				body,
			})),
		close: async () => {
			await harness.close(context);
			await box.close();
		},
	};
}

describe("choosing the shipped skills at first run", () => {
	it("writes and accepts exactly the ones picked, as shipped, files and all; then they are not offered again", async () => {
		const { box, harness, workspace, accepted, close } = await setup();
		try {
			expect((await shippedSkills(harness, workspace)).chosen).toBe(false);
			const view = await chooseShippedSkills(harness, workspace, ["bro", "diagram-design"]);
			expect(view.chosen).toBe(true);
			expect(view.skills.filter(({ added }) => added).map(({ name }) => name)).toEqual(["bro", "diagram-design"]);
			expect((await accepted()).map(({ name }) => name)).toEqual(["bro", "diagram-design"]);
			for (const name of ["bro", "diagram-design"])
				expect(await readFile(join(box.workspace, "skills", name, "SKILL.md"), "utf8")).toBe(
					await readFile(join(SHIPPED_SKILLS, name, "SKILL.md"), "utf8"),
				);
			// the files beside it are box data, written as shipped
			expect((await stat(join(box.workspace, "skills/diagram-design/references/style-guide.md"))).isFile()).toBe(true);
			await expect(stat(join(box.workspace, "skills/unslop"))).rejects.toThrow();
			expect((await harness.snapshot(Companion, context))?.skillsChosen).toBe(true);
		} finally {
			await close();
		}
	});

	it("skipping writes and accepts none, and is remembered", async () => {
		const { box, harness, workspace, accepted, close } = await setup();
		try {
			expect((await chooseShippedSkills(harness, workspace, [])).chosen).toBe(true);
			expect(await accepted()).toEqual([]);
			await expect(readdir(join(box.workspace, "skills"))).rejects.toThrow();
			expect((await shippedSkills(harness, workspace)).chosen).toBe(true);
		} finally {
			await close();
		}
	});

	it("never replaces a skill of that name already in the workspace, accepted or waiting in the box", async () => {
		const { box, harness, workspace, accepted, close } = await setup();
		try {
			const own = "---\nname: bro\ndescription: The owner's own bro\n---\n\nMine.";
			await saveSkill(harness, workspace, "bro", own, null);
			const draft = "---\nname: unslop\ndescription: The box's unslop\n---\n\nA draft.";
			await mkdir(join(box.workspace, "skills/unslop"), { recursive: true });
			await writeFile(join(box.workspace, "skills/unslop/SKILL.md"), draft);
			const view = await shippedSkills(harness, workspace);
			expect(view.skills.filter(({ added }) => added).map(({ name }) => name)).toEqual(["bro", "unslop"]);
			await chooseShippedSkills(harness, workspace, ["bro", "unslop", "catch-me-up"]);
			expect(await readFile(join(box.workspace, "skills/bro/SKILL.md"), "utf8")).toBe(own);
			expect(await readFile(join(box.workspace, "skills/unslop/SKILL.md"), "utf8")).toBe(draft);
			// the box's draft is still the owner's to accept: choosing never accepts it
			expect((await accepted()).map(({ name }) => name)).toEqual(["bro", "catch-me-up"]);
			expect((await accepted()).find(({ name }) => name === "bro")?.body).toContain("Mine.");
		} finally {
			await close();
		}
	});

	it("refuses a name banda does not ship, or one listed twice, and changes nothing", async () => {
		const { harness, workspace, accepted, close } = await setup();
		try {
			await expect(chooseShippedSkills(harness, workspace, ["nope"])).rejects.toThrow("ships no skill");
			await expect(chooseShippedSkills(harness, workspace, ["bro", "bro"])).rejects.toThrow("twice");
			expect(await accepted()).toEqual([]);
			expect((await shippedSkills(harness, workspace)).chosen).toBe(false);
		} finally {
			await close();
		}
	});
});
