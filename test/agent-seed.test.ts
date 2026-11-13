/** The accepted agent files reach a new box: nothing the daemon never wrote there is offered as the box's removal. */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, agentPath, LEAD_TEXT } from "../src/core/agents.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { AgentPublications } from "../src/server/agent-publication.ts";
import { accept, agents, save, seed, type Workspace } from "../src/server/agents.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

async function fresh() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(core.extension);
	const harness = await openStore(home, { models: echoModels().models, registry });
	const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
	const close = async () => {
		await harness.close(context);
		await box.close();
	};
	return { box, harness, workspace, close };
}

const read = async (workspace: Workspace, path: string) => {
	const got = await workspace.env().readTextFile(`${workspace.root}/${path}`, context);
	return got.ok ? got.value : undefined;
};

describe("seeding a new box with the accepted agents", () => {
	it("writes the lead into a fresh box whose agents folder something else made first, and offers no removal", async () => {
		const { harness, workspace, close } = await fresh();
		try {
			// a first seed that failed while the box came up, then another writer made the folder
			await mkdir(join(workspace.root, "agents"), { recursive: true });
			await harness.commit(async (tx) => {
				await tx.doc(Accepted);
			}, context);
			expect((await agents(harness, workspace))[0]?.change).toBeUndefined();
			await seed(harness, workspace);
			expect(await read(workspace, agentPath("sancho"))).toBe(LEAD_TEXT);
			expect((await agents(harness, workspace))[0]?.change).toBeUndefined();
		} finally {
			await close();
		}
	});

	it("is not undone by an owner's save that reached the box first, and is idempotent", async () => {
		const { harness, workspace, close } = await fresh();
		try {
			await save(
				harness,
				workspace,
				"mira",
				"---\ndescription: Plans trips\n---\nBe practical.\n",
				null,
				async () => {},
			);
			await seed(harness, workspace);
			await seed(harness, workspace);
			expect(await read(workspace, agentPath("sancho"))).toBe(LEAD_TEXT);
			expect((await agents(harness, workspace)).map((row) => [row.name, row.change])).toEqual([
				["sancho", undefined],
				["mira", undefined],
			]);
		} finally {
			await close();
		}
	});

	it("once seeded, a file the box removes is the box's change; a box made anew is seeded again", async () => {
		const { harness, workspace, close } = await fresh();
		try {
			await save(
				harness,
				workspace,
				"mira",
				"---\ndescription: Plans trips\n---\nBe practical.\n",
				null,
				async () => {},
			);
			await seed(harness, workspace);
			await rm(join(workspace.root, agentPath("mira")));
			await seed(harness, workspace);
			expect((await agents(harness, workspace)).find((row) => row.name === "mira")?.change).toEqual({
				kind: "removed",
			});
			await rm(join(workspace.root, "agents"), { recursive: true });
			await seed(harness, workspace);
			expect(await read(workspace, agentPath("sancho"))).toBe(LEAD_TEXT);
			expect((await agents(harness, workspace)).every((row) => row.change === undefined)).toBe(true);
		} finally {
			await close();
		}
	});

	it("an agent not yet written is never removed; a failed seed resumes on the next explicit attempt", async () => {
		const { harness, workspace, close } = await fresh();
		try {
			await save(
				harness,
				workspace,
				"mira",
				"---\ndescription: Plans trips\n---\nBe practical.\n",
				null,
				async () => {},
			);
			await rm(join(workspace.root, agentPath("mira")));
			await expect(accept(harness, workspace, "mira", null, async () => {})).rejects.toThrow(/not in the box yet/);
			let down = 2;
			const flaky: Workspace = {
				...workspace,
				env: () => {
					if (down-- > 0) throw new Error("the box is not up");
					return workspace.env();
				},
			};
			await expect(seed(harness, flaky)).rejects.toThrow("the box is not up");
			await expect(seed(harness, flaky)).rejects.toThrow("the box is not up");
			await seed(harness, flaky);
			expect(await read(workspace, agentPath("sancho"))).toBe(LEAD_TEXT);
			expect(await read(workspace, agentPath("mira"))).toContain("Be practical.");
		} finally {
			await close();
		}
	});

	it.each(["before", "partial"] as const)("resumes restoration after a %s write failure", async (point) => {
		const { harness, workspace, close } = await fresh();
		try {
			await save(
				harness,
				workspace,
				"mira",
				"---\ndescription: Plans trips\n---\nBe practical.\n",
				null,
				async () => {},
			);
			await seed(harness, workspace);
			await rm(join(workspace.root, "agents"), { recursive: true });
			let failed = false;
			const interrupted: Workspace = {
				...workspace,
				publicationPoint: async (boundary) => {
					if (boundary === (point === "partial" ? "agent:stage:after" : "agent:stage:before") && !failed) {
						failed = true;
						if (point === "partial") {
							const doc = await harness.snapshot(AgentPublications, context);
							const latest = Math.max(...Object.values(doc?.current ?? {}));
							const folder = join(workspace.root, "agents/.banda-publications", String(latest));
							const attempt = (await readdir(folder)).find((name) => name.startsWith("attempt-"));
							if (attempt === undefined) throw new Error("missing stage");
							await writeFile(join(folder, attempt, "owner"), "---\n");
						}
						throw new Error("restoration interrupted");
					}
				},
			};
			await expect(seed(harness, interrupted)).rejects.toThrow("restoration interrupted");
			expect((await agents(harness, workspace)).every((row) => row.change === undefined)).toBe(true);
			await seed(harness, interrupted);
			expect(await read(workspace, agentPath("mira"))).toContain("Be practical.");
			expect((await agents(harness, workspace)).every((row) => row.change === undefined)).toBe(true);
		} finally {
			await close();
		}
	});
});
