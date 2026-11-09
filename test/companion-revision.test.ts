/** A candidate applies only to the accepted identity shown with its preview, including its colour. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentPath, parseAgent } from "../src/core/agents.ts";
import { DEFAULT_FACE } from "../src/core/choices.ts";
import { context } from "../src/core/store.ts";
import { change, companion, validPicks } from "../src/server/companion.ts";
import { agentSaveScenario } from "./fault/agent-save-scenario.ts";
import { tempHome } from "./helpers.ts";

const candidate = { ...DEFAULT_FACE, definition: { ...DEFAULT_FACE.definition, name: "Candidate" } };

describe("companion candidate revision", () => {
	it("refuses an older tab's candidate without restoring its stale colour", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		try {
			const observed = await accepted();
			const current = { ...DEFAULT_FACE, color: "#112233" };
			await change(harness, workspace, { face: current }, async () => {});
			const before = await accepted();
			await expect(
				change(harness, workspace, validPicks({ face: candidate, base: observed.sha }), async () => {}),
			).rejects.toMatchObject({ status: 409 });
			expect(await accepted()).toEqual(before);
			expect((await companion(harness)).face).toEqual(current);
			expect(await readFile(join(workspace.root, agentPath("sancho")), "utf8")).toBe(before.text);

			// Looking again binds the candidate and its colour to the same accepted revision.
			const parsed = parseAgent("sancho", before.text);
			if (!("agent" in parsed)) throw new Error("invalid accepted agent");
			const refreshed = { ...candidate, color: parsed.agent.face.color };
			await change(harness, workspace, validPicks({ face: refreshed, base: before.sha }), async () => {});
			expect((await companion(harness)).face).toEqual(refreshed);
		} finally {
			await harness.close(context);
		}
	});

	it("checks the observed revision even when the submitted face is already current", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		try {
			const before = await accepted();
			await change(harness, workspace, { personality: "Changed elsewhere." }, async () => {});
			await expect(
				change(harness, workspace, validPicks({ face: DEFAULT_FACE, base: before.sha }), async () => {}),
			).rejects.toMatchObject({ status: 409 });
		} finally {
			await harness.close(context);
		}
	});

	it("validates the revision instead of silently ignoring it", () => {
		for (const base of [null, 0, "", "not-a-hash", "a".repeat(63)])
			expect(() => validPicks({ face: candidate, base })).toThrow(/base/);
		expect(validPicks({ face: candidate, base: "a".repeat(64) }).base).toBe("a".repeat(64));
	});
});
