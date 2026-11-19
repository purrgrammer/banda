/**
 * A SKILL.md that reached the workspace while no tool told the daemon (another harness's copy, a file the owner
 * dropped in) is in effect at the next start: `reconcileSkills` puts every parseable, visible one in effect and leaves
 * the rest for the Skills page to explain. The owner's accept route is then only for what cannot be put in effect.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted } from "../src/core/agents.ts";
import { acceptedSkills } from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import type { Workspace } from "../src/server/agents.ts";
import { reconcileSkills, skills } from "../src/server/skills.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";

it("puts the workspace's parseable skills in effect at start and shows the owner what cannot be", async () => {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
	const dir = (name: string) => join(box.workspace, "skills", name);
	for (const name of ["brought", "broken", "sneaky"]) await mkdir(dir(name), { recursive: true });
	// as another harness would leave it: SKILL.md and a file beside it
	await writeFile(
		join(dir("brought"), "SKILL.md"),
		"---\nname: brought\ndescription: Brought from elsewhere.\n---\nDo it this way.\n",
	);
	await writeFile(join(dir("brought"), "notes.md"), "beside it");
	await writeFile(join(dir("broken"), "SKILL.md"), "no frontmatter");
	await writeFile(join(dir("sneaky"), "SKILL.md"), "---\nname: sneaky\ndescription: Hidden\u200b words.\n---\nBody.\n");
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const harness = await openStore(home, { models, registry: createRegistry() });
	try {
		expect(await reconcileSkills(harness, workspace)).toEqual(["brought"]);
		// again: nothing new
		expect(await reconcileSkills(harness, workspace)).toEqual([]);
		const accepted = (await harness.snapshot(Accepted, context))?.files ?? {};
		expect(acceptedSkills(accepted).map(({ name, body }) => [name, body])).toEqual([["brought", "Do it this way.\n"]]);
		const page = await skills(harness, workspace);
		expect(page.find((view) => view.name === "brought")).toMatchObject({
			accepted: { files: ["skills/brought/notes.md"] },
		});
		expect(page.find((view) => view.name === "brought")?.change).toBeUndefined();
		expect(page.find((view) => view.name === "broken")?.change).toMatchObject({
			kind: "added",
			errors: [expect.stringContaining("frontmatter")],
		});
		// a hidden character parses, so the page shows the file as a change; it is not in effect
		expect(page.find((view) => view.name === "sneaky")?.change).toMatchObject({ kind: "added" });
		expect(accepted["skills/sneaky/SKILL.md"]).toBeUndefined();
	} finally {
		await harness.close(context);
		await box.close();
	}
});
