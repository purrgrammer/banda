import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { acceptedSkills } from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import type { Workspace } from "../src/server/agents.ts";
import { acceptSkill, acceptSkills, saveSkill, skills } from "../src/server/skills.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome } from "./helpers.ts";

const draft = (body: string) => `---\nname: research\ndescription: Research with citations\n---\n\n${body}`;

describe("skill acceptance boundary", () => {
	it("owner files take effect, box drafts do not, and accept binds to the bytes reviewed", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		try {
			await saveSkill(harness, workspace, "research", draft("Cite sources."), null);
			const original = (await skills(harness, workspace))[0]!;
			expect(original.accepted?.body).toContain("Cite sources.");
			expect(original.change).toBeUndefined();
			await writeFile(join(box.workspace, "skills/research/notes.md"), "Unreviewed data");
			expect((await skills(harness, workspace))[0]?.accepted?.files).toEqual(["skills/research/notes.md"]);
			expect(acceptedSkills((await harness.snapshot(Accepted, context))!.files)[0]?.files).toEqual([]);
			await writeFile(join(box.workspace, "skills/research/SKILL.md"), draft("Delete the sources."));
			const pending = (await skills(harness, workspace))[0]!;
			expect(pending.change).toMatchObject({ kind: "changed", sha: shaOf(draft("Delete the sources.")) });
			expect(acceptedSkills((await harness.snapshot(Accepted, context))!.files)[0]?.body).toContain("Cite sources.");
			await writeFile(join(box.workspace, "skills/research/SKILL.md"), draft("A different edit."));
			await expect(acceptSkill(harness, workspace, "research", pending.change?.sha ?? "")).rejects.toThrow(
				"changed since",
			);
			expect(acceptedSkills((await harness.snapshot(Accepted, context))!.files)[0]?.body).toContain("Cite sources.");
			const reviewed = (await skills(harness, workspace))[0]!.change?.sha ?? "";
			await acceptSkill(harness, workspace, "research", reviewed);
			expect(acceptedSkills((await harness.snapshot(Accepted, context))!.files)[0]?.body).toContain(
				"A different edit.",
			);
			await mkdir(join(box.workspace, "skills/bad"));
			await writeFile(join(box.workspace, "skills/bad/SKILL.md"), "not a skill");
			expect((await skills(harness, workspace)).find((skill) => skill.name === "bad")?.change?.errors).toBeDefined();
		} finally {
			await harness.close(context);
			await box.close();
		}
	});

	it("a pack is accepted as the list reviewed: all of it, or none when one changed since", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		const file = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} help\n---\n\n${body}`;
		const place = async (name: string, body: string) => {
			await mkdir(join(box.workspace, "skills", name), { recursive: true });
			await writeFile(join(box.workspace, "skills", name, "SKILL.md"), file(name, body));
		};
		const catalogue = async () => acceptedSkills((await harness.snapshot(Accepted, context))?.files ?? {});
		try {
			for (const name of ["architect", "bro", "recall"]) await place(name, `Do ${name}.`);
			const shown = (await skills(harness, workspace)).map(({ name, change }) => ({ name, sha: change?.sha ?? "" }));
			expect(shown.map(({ name }) => name)).toEqual(["architect", "bro", "recall"]);
			// one edited after the owner looked: nothing is accepted, and the refusal names it
			await place("bro", "Do something else.");
			await expect(acceptSkills(harness, workspace, shown)).rejects.toThrow("/bro changed since");
			expect(await catalogue()).toEqual([]);
			const again = (await skills(harness, workspace)).map(({ name, change }) => ({ name, sha: change?.sha ?? "" }));
			await acceptSkills(harness, workspace, again);
			expect((await catalogue()).map(({ name }) => name)).toEqual(["architect", "bro", "recall"]);
			expect((await catalogue()).find(({ name }) => name === "bro")?.body).toContain("Do something else.");
			await expect(acceptSkills(harness, workspace, [])).rejects.toThrow("between 1 and");
		} finally {
			await harness.close(context);
			await box.close();
		}
	});
});
