/** Avatar data crosses the existing owner-save / box-accept boundary, never a renderer or an evaluator. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, acceptedAgent, agentPath, shaOf } from "../src/core/agents.ts";
import { writeAvatarFace } from "../src/core/avatar-face.ts";
import { DEFAULT_FACE } from "../src/core/choices.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { accept, agents, save, seed, type Workspace } from "../src/server/agents.ts";
import { acceptedIconFace } from "../src/server/avatar-icon-face.ts";
import { change, companion } from "../src/server/companion.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const file = (color: string) =>
	`---\nname: Mira\nface: ${writeAvatarFace({ ...DEFAULT_FACE, color })}\ndescription: Plans trips\n---\nBe practical.\n`;

describe("accepted agent avatars", () => {
	it("uses the first agent's accepted file for its displayed face and icon, never the pending box file", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models: echoModels().models, registry });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		try {
			await seed(harness, workspace);
			const face = { ...DEFAULT_FACE, color: "#123456" };
			await change(harness, workspace, { face }, async () => {});
			expect((await companion(harness)).face).toEqual(face);
			expect(await acceptedIconFace(harness)).toEqual(face);
			const accepted = (await harness.snapshot(Accepted, context))?.files[agentPath("sancho")];
			expect(accepted?.text).toContain(writeAvatarFace(face));
			if (!accepted) throw new Error("missing lead");
			const next = { ...face, color: "#abcdef" };
			await writeFile(
				join(box.workspace, agentPath("sancho")),
				accepted.text.replace(writeAvatarFace(face), writeAvatarFace(next)),
			);
			expect((await companion(harness)).face).toEqual(face);
			expect(await acceptedIconFace(harness)).toEqual(face);
			await expect(change(harness, workspace, { face: next }, async () => {})).rejects.toThrow(/change waiting/);
			await accept(
				harness,
				workspace,
				"sancho",
				shaOf(accepted.text.replace(writeAvatarFace(face), writeAvatarFace(next))),
				async () => {},
			);
			expect((await companion(harness)).face).toEqual(next);
			expect(await acceptedIconFace(harness)).toEqual(next);
		} finally {
			await harness.close(context);
			box.close();
		}
	});
	it("accepts owner edits immediately, but keeps box edits out of effect until their exact bytes are accepted", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models: echoModels().models, registry });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		const changed = async () => {};
		const effective = () => harness.commit((tx) => acceptedAgent(tx, "mira"), context);
		try {
			await seed(harness, workspace);
			const original = file("#123456");
			await save(harness, workspace, "mira", original, null, changed);
			expect((await effective())?.face).toEqual({ ...DEFAULT_FACE, color: "#123456" });
			expect((await harness.snapshot(Accepted, context))?.files[agentPath("mira")]?.text).toBe(original);

			const proposal = file("#abcdef");
			await writeFile(join(box.workspace, agentPath("mira")), proposal);
			const row = (await agents(harness, workspace)).find((row) => row.name === "mira");
			expect(row?.accepted?.agent?.face.color).toBe("#123456");
			expect(row?.change).toMatchObject({
				kind: "changed",
				sha: shaOf(proposal),
				agent: { face: { color: "#abcdef" } },
			});
			expect((await effective())?.face.color).toBe("#123456");
			await expect(save(harness, workspace, "mira", file("#654321"), shaOf(original), changed)).rejects.toThrow(
				/changed since/,
			);

			await writeFile(join(box.workspace, agentPath("mira")), file("#fedcba"));
			await expect(accept(harness, workspace, "mira", shaOf(proposal), changed)).rejects.toThrow(/changed since/);
			await writeFile(join(box.workspace, agentPath("mira")), proposal);
			await accept(harness, workspace, "mira", shaOf(proposal), changed);
			expect((await effective())?.face.color).toBe("#abcdef");

			const bad = proposal.replace(writeAvatarFace({ ...DEFAULT_FACE, color: "#abcdef" }), '<svg onload="alert(1)"/>');
			await writeFile(join(box.workspace, agentPath("mira")), bad);
			expect((await agents(harness, workspace)).find((row) => row.name === "mira")?.change).toHaveProperty("errors");
			await expect(accept(harness, workspace, "mira", shaOf(bad), changed)).rejects.toThrow(/face/);
			await expect(save(harness, workspace, "bad", bad, null, changed)).rejects.toThrow(/face/);
			expect((await effective())?.face.color).toBe("#abcdef");
		} finally {
			await harness.close(context);
			box.close();
		}
	});
});
