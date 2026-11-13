import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { context } from "../src/core/store.ts";
import { accept, save, type Workspace } from "../src/server/agents.ts";
import { agentSaveScenario } from "./fault/agent-save-scenario.ts";
import { tempHome } from "./helpers.ts";

const changed = async () => {};
const latch = () => {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

/** Pause after acceptance, before staged filesystem publication. */
function pausedWrite(workspace: Workspace) {
	const entered = latch();
	const release = latch();
	const paused: Workspace = {
		...workspace,
		publicationPoint: async (point) => {
			if (point === "agent:stage:before") {
				entered.resolve();
				await release.promise;
			}
		},
	};
	return { workspace: paused, entered: entered.promise, release: release.resolve };
}

describe("agent publication concurrency", () => {
	it("two tabs saving the same base: only one succeeds and its bytes stay accepted and published", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const original = await accepted();
		const first = `${original.text}\nFirst tab's personality.\n`;
		const second = `${original.text}\nSecond tab's personality.\n`;
		const pause = pausedWrite(workspace);
		let saving: Promise<unknown> | undefined;
		try {
			// Settled immediately to avoid an unhandled rejection if the corrected implementation rejects this save.
			saving = Promise.allSettled([save(harness, pause.workspace, "sancho", first, original.sha, changed)]);
			await pause.entered;
			const other = await Promise.allSettled([save(harness, workspace, "sancho", second, original.sha, changed)]);
			pause.release();
			const [one] = (await saving) as PromiseSettledResult<unknown>[];
			const fulfilled = [one, other[0]].filter((result) => result?.status === "fulfilled");
			const file = await accepted();
			const box = await readFile(join(workspace.root, agentPath("sancho")), "utf8");
			expect({ successes: fulfilled.length, published: box }).toEqual({ successes: 1, published: file.text });
		} finally {
			pause.release();
			await saving;
			await harness.close(context);
		}
	});

	it("a box proposal accepted during owner publication cannot be overwritten by the stale owner save", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const original = await accepted();
		const owner = `${original.text}\nOwner edit.\n`;
		const proposal = `${original.text}\nAccepted box edit.\n`;
		const pause = pausedWrite(workspace);
		let saving: Promise<unknown> | undefined;
		try {
			saving = Promise.allSettled([save(harness, pause.workspace, "sancho", owner, original.sha, changed)]);
			await pause.entered;
			await writeFile(join(workspace.root, agentPath("sancho")), proposal);
			await accept(harness, workspace, "sancho", shaOf(proposal), changed);
			pause.release();
			await saving;
			expect({
				accepted: (await accepted()).text,
				published: await readFile(join(workspace.root, agentPath("sancho")), "utf8"),
			}).toEqual({ accepted: proposal, published: proposal });
		} finally {
			pause.release();
			await saving;
			await harness.close(context);
		}
	});

	it("an independent accepted-file writer cannot be undone after the owner's snapshot checks", async () => {
		const { harness, workspace, accepted } = await agentSaveScenario(await tempHome());
		const original = await accepted();
		const owner = `${original.text}\nOwner edit.\n`;
		const concurrent = `${original.text}\nIndependent acceptance.\n`;
		const pause = pausedWrite(workspace);
		let saving: Promise<unknown> | undefined;
		try {
			saving = Promise.allSettled([save(harness, pause.workspace, "sancho", owner, original.sha, changed)]);
			await pause.entered;
			// Like switchAccount: another path changes Accepted without entering agents.save/accept.
			await harness.commit(async (tx) => {
				(await tx.doc(Accepted)).files[agentPath("sancho")] = { sha: shaOf(concurrent), text: concurrent, at: 1 };
			}, context);
			await writeFile(join(workspace.root, agentPath("sancho")), concurrent);
			pause.release();
			await saving;
			expect({
				accepted: (await accepted()).text,
				published: await readFile(join(workspace.root, agentPath("sancho")), "utf8"),
			}).toEqual({ accepted: concurrent, published: concurrent });
		} finally {
			pause.release();
			await saving;
			await harness.close(context);
		}
	});
});
