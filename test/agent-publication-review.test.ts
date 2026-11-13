import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { context } from "../src/core/store.ts";
import { publicationHistory } from "../src/server/agent-publication.ts";
import { accept, agents, retryPublication, save, seed } from "../src/server/agents.ts";
import { agentSaveScenario } from "./fault/agent-save-scenario.ts";
import { tempHome } from "./helpers.ts";

it.each([
	{ state: "conflict", choice: "workspace" },
	{ state: "published", choice: "workspace" },
	{ state: "conflict", choice: "saved" },
])("invalidates a $state resolution when the $choice version is accepted", async ({ state, choice }) => {
	const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
	const original = await accepted();
	const owner = `${original.text}\nOwner revision.\n`;
	const box = `${original.text}\nWorkspace revision.\n`;
	const target = join(workspace.root, agentPath("sancho"));
	try {
		const rows = await save(
			harness,
			{
				...workspace,
				publicationPoint: async (point) => {
					if (state === "conflict" && point === "agent:insert:before") await writeFile(target, box);
				},
			},
			"sancho",
			owner,
			original.sha,
			async () => {},
		);
		const id = rows[0]?.publication?.id;
		if (id === undefined) throw new Error("missing publication");
		const chosen = choice === "saved" ? owner : box;
		await writeFile(target, chosen);
		await accept(harness, workspace, "sancho", shaOf(chosen), async () => {});
		await expect(retryPublication(harness, workspace, "sancho", id, shaOf(chosen))).rejects.toMatchObject({
			status: 409,
		});
		expect((await accepted()).text).toBe(chosen);
		expect(await readFile(target, "utf8")).toBe(chosen);
		expect((await agents(harness, workspace))[0]?.publication?.state).toBe("retained");
		expect(
			(await publicationHistory(harness, workspace, "sancho")).items.some((item) => item.saved?.text === owner),
		).toBe(true);
	} finally {
		await harness.close(context);
	}
});

it("binds a resolution to its accepted identity inside the commit", async () => {
	const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
	const original = await accepted();
	const owner = `${original.text}\nOwner revision.\n`;
	const newer = `${original.text}\nIndependent acceptance.\n`;
	try {
		const rows = await save(harness, workspace, "sancho", owner, original.sha, async () => {});
		const id = rows[0]?.publication?.id;
		if (id === undefined) throw new Error("missing publication");
		await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files[agentPath("sancho")] = { text: newer, sha: shaOf(newer), at: Date.now() };
		}, context);
		await expect(retryPublication(harness, workspace, "sancho", id, shaOf(owner))).rejects.toMatchObject({
			status: 409,
		});
		expect((await accepted()).text).toBe(newer);
	} finally {
		await harness.close(context);
	}
});

it("leaves an unexpected canonical directory recoverable at its original name", async () => {
	const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
	const original = await accepted();
	const target = join(workspace.root, agentPath("sancho"));
	try {
		const rows = await save(
			harness,
			{
				...workspace,
				publicationPoint: async (point) => {
					if (point !== "agent:retain:before") return;
					await rename(target, `${target}.writer-kept`);
					await mkdir(target);
					await writeFile(join(target, "work.txt"), "work created by concurrent writer");
				},
			},
			"sancho",
			`${original.text}\nOwner revision.\n`,
			original.sha,
			async () => {},
		);
		expect(rows[0]?.publication?.state).toBe("conflict");
		await seed(harness, workspace);
		expect((await agents(harness, workspace))[0]?.publication?.state).toBe("conflict");
		expect(await readFile(join(target, "work.txt"), "utf8")).toBe("work created by concurrent writer");
	} finally {
		await harness.close(context);
	}
});

it("continues to expose old retained history after removal and recreation", async () => {
	const { harness, workspace } = await agentSaveScenario(await tempHome());
	try {
		await save(harness, workspace, "mira", "---\ndescription: Mira\n---\nFirst.\n", null, async () => {});
		let row = (await agents(harness, workspace)).find((row) => row.name === "mira");
		if (!row?.accepted) throw new Error("missing Mira");
		await save(harness, workspace, "mira", "---\ndescription: Mira\n---\nSecond.\n", row.accepted.sha, async () => {});
		await rm(join(workspace.root, agentPath("mira")));
		await accept(harness, workspace, "mira", null, async () => {});
		await save(harness, workspace, "mira", "---\ndescription: Mira\n---\nThird.\n", null, async () => {});
		row = (await agents(harness, workspace)).find((row) => row.name === "mira");
		expect(row?.publication).toBeDefined();
	} finally {
		await harness.close(context);
	}
});

it("exposes the exact owner version after an in-place box edit is accepted", async () => {
	const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
	const original = await accepted();
	const owner = `${original.text}\nOWNER_VERSION_THAT_MUST_STAY_RECOVERABLE.\n`;
	const box = `${original.text}\nAgent's replacement.\n`;
	try {
		await save(harness, workspace, "sancho", owner, original.sha, async () => {});
		await writeFile(join(workspace.root, agentPath("sancho")), box);
		await accept(harness, workspace, "sancho", shaOf(box), async () => {});
		const history = await publicationHistory(harness, workspace, "sancho");
		expect(history.items.some((item) => item.saved?.text === owner)).toBe(true);
	} finally {
		await harness.close(context);
	}
});

it("keeps history reachable after an agent's first owner version is changed in place", async () => {
	const { harness, workspace } = await agentSaveScenario(await tempHome());
	const owner = "---\ndescription: Mira\n---\nOwner first version.\n";
	const box = owner.replace("Owner first version.", "Box second version.");
	try {
		await save(harness, workspace, "mira", owner, null, async () => {});
		await writeFile(join(workspace.root, agentPath("mira")), box);
		await accept(harness, workspace, "mira", shaOf(box), async () => {});
		expect(
			(await publicationHistory(harness, workspace, "mira")).items.some((item) => item.saved?.text === owner),
		).toBe(true);
		expect((await agents(harness, workspace)).find((row) => row.name === "mira")?.publication).toBeDefined();
	} finally {
		await harness.close(context);
	}
});
