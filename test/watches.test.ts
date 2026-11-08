import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted } from "../src/core/agents.ts";
import { Connected } from "../src/core/connections.ts";
import { pause as pauseAll, resume as resumeAll } from "../src/core/control.ts";
import { context } from "../src/core/store.ts";
import { endWatches, parseWatch, Watches, watchPath, watchText } from "../src/core/watches.ts";
import { pause } from "../src/server/watches.ts";
import { Faults } from "./fault/faults.ts";
import {
	NOW,
	SCENARIOS,
	type Scene,
	type World,
	watchInvariants,
	watchProblems,
	watchScenario,
	world,
} from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Reads = {
	get_comments: unknown[];
	get_check_runs: { check_runs: { [field: string]: unknown }[] };
};

/** The world at step `step` of the pull request's life, changed by `change`. */
const changed = (step: number, change: (at: Reads) => void): World => {
	const at = structuredClone(world(step)) as unknown as Reads;
	change(at);
	return at as unknown as World;
};

/** Pause watch banda-142, or resume it, as the owner. */
const hold = (scene: Scene, paused: boolean) =>
	pause(scene.harness, (harness, ctx) => scene.core.reconcile(harness, ctx), "banda-142", paused, scene.now);

describe("a watch file", () => {
	it("says what it follows, as whom and until what, and what matters below; each problem says what to write", () => {
		const text = watchText({
			object: "https://github.com/acme/banda/pull/142",
			account: "bandarra",
			until: "merged",
			ask: "Tell me when it is approved.",
		});
		expect(text).toBe(
			"---\nobject: https://github.com/acme/banda/pull/142\naccount: bandarra\nuntil: merged\n---\nTell me when it is approved.\n",
		);
		const parsed = parseWatch("banda-142", text);
		expect("watch" in parsed ? parsed.watch : parsed).toEqual({
			name: "banda-142",
			object: "https://github.com/acme/banda/pull/142",
			account: "bandarra",
			until: "merged",
			ask: "Tell me when it is approved.",
		});
		const errors = (name: string, text: string) => {
			const found = parseWatch(name, text);
			return "errors" in found ? found.errors : [];
		};
		expect(errors("Bad Name", text)).toContainEqual(expect.stringContaining("not a watch name"));
		expect(errors("x", "no frontmatter")).toContainEqual(expect.stringContaining("frontmatter"));
		expect(errors("x", "---\nuntil: merged\n---\nwords\n")).toContainEqual(expect.stringContaining("object:"));
		expect(errors("x", "---\nobject: a\nuntil: Soon!\n---\nwords\n")).toContainEqual(expect.stringContaining("until"));
		expect(errors("x", "---\nobject: a\n---\n")).toContainEqual(expect.stringContaining("what matters"));
	});
});

describe("a watch on a pull request", () => {
	it.each(Object.keys(SCENARIOS))(
		"the fault worker's scenario %s holds what it must, with no fault",
		async (name) => {
			const scenario = SCENARIOS[name] as (typeof SCENARIOS)[string];
			expect(scenario.problems(await watchScenario(await tempHome(), new Faults(), scenario.options))).toEqual([]);
		},
		60_000,
	);

	it("looks once for its baseline, wakes its agent once per change in the kind's words, ignores its own and the same again, and ends when merged", async () => {
		const summary = await watchScenario(await tempHome(), new Faults());
		expect(watchProblems(summary)).toEqual([]);
		expect(summary.wakes[0]?.object).toMatchObject({
			name: "acme/banda #142",
			connection: "github",
			service: "GitHub",
			account: "bandarra",
		});
		expect(summary.record.saw).toEqual(["merged", "closed"]);
		expect(summary.record.looked).toBeDefined();
	}, 60_000);

	it("two watches on one object, as one account, each see every change: one reading, a cursor per watch", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), { second: true });
		expect(watchProblems(summary)).toEqual([]);
	}, 60_000);

	it("a change that happens again later wakes again: lint fails, goes green, then fails on the next push", async () => {
		// lint fails at step 1, passes at 2, fails again at 3 (a new push: new ids, the same words), merged at 4
		const recurring = (step: number): World => {
			const at = structuredClone(world(0)) as {
				get: { [key: string]: unknown };
				get_check_runs: { check_runs: { [key: string]: unknown }[] };
			};
			const lint = at.get_check_runs.check_runs[1] as { [key: string]: unknown };
			if (step >= 1) Object.assign(lint, { status: "completed", conclusion: step === 2 ? "success" : "failure" });
			if (step >= 3) lint.id = 100 + step;
			if (step >= 4) Object.assign(at.get, { merged: true, state: "closed" });
			return at as unknown as World;
		};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: recurring,
			clicks: ["k1", "k2", "k3", "k4"],
		});
		expect(summary.wakes.map((wake) => wake.changes.filter((c) => c !== "checks finished").join(", "))).toEqual([
			"lint failed",
			"all checks green",
			"lint failed",
			expect.stringContaining("merged"),
		]);
	}, 60_000);

	it("a done watch never wakes again, even when the owner checks it after it ended", async () => {
		// merged at step 3, as the pull request's life goes; at step 4 bob reviews the merged pull request
		const after = (step: number): World => {
			const at = structuredClone(world(Math.min(step, 3))) as { get_reviews: unknown[] };
			if (step >= 4) at.get_reviews.push({ id: 2, user: { login: "bob" }, state: "COMMENTED" });
			return at as unknown as World;
		};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: after,
			clicks: ["k1", "k2", "k3", "k4"],
		});
		expect(summary.record.done?.why).toBe("merged");
		expect(summary.wakes).toHaveLength(2);
		expect(summary.wakes.flatMap((wake) => wake.changes).some((change) => change.includes("bob"))).toBe(false);
	}, 60_000);

	it("an account switched off ends the watch in that commit, saying why; it never wakes after", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			act: async (step, { harness, now }) => {
				if (step !== 2) return;
				await harness.commit(async (tx) => {
					const { on } = await tx.doc(Connected);
					if (on.mara?.github === undefined) return;
					delete on.mara.github;
					await endWatches(
						tx,
						{ connection: "github", account: "bandarra", agent: "mara" },
						"GitHub as @bandarra was switched off for Mara",
						now,
					);
				}, context);
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.ended)).toEqual([undefined]);
		expect(summary.record.done).toMatchObject({
			why: "GitHub as @bandarra was switched off for Mara",
			authority: true,
		});
		expect(summary.record.failed).toBeUndefined();
		// the baseline's look and the first click's: none after it ended, neither the task's nor the owner's
		expect(summary.looks).toBe(2);
	}, 60_000);

	it("days offline: the world moves many steps without a look, then one look is one wake with all of it", async () => {
		const offline = (step: number): World =>
			step >= 6
				? world(3)
				: changed(Math.min(step, 1), (at) => {
						at.get_comments.push(...Array.from({ length: step }, (_, n) => ({ id: 50 + n, user: { login: "bob" } })));
					});
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: offline,
			clicks: [undefined, undefined, undefined, undefined, undefined, "k6"],
			at: (step) => (step < 6 ? NOW : NOW + 3 * DAY),
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]).toMatchObject({ ended: "merged" });
		expect(summary.wakes[0]?.changes).toEqual(expect.arrayContaining(["ana approved", "lint failed", "merged"]));
	}, 60_000);

	it("paused while the world changes, resumed: exactly one wake, which says it comes from the pause", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => world(step === 2 ? 1 : step),
			clicks: [undefined, undefined, "k3"],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, scene) => {
				if (step === 1) await hold(scene, true);
				if (step === 3) await hold(scene, false);
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]).toMatchObject({ resumed: true, ended: "merged" });
		expect(summary.wakes[0]?.changes).toEqual(expect.arrayContaining(["ana approved", "lint failed", "merged"]));
		expect(summary.record.resumed).toBeUndefined();
	}, 60_000);

	it("Pause all while the world changes, then resume: one wake, which says it comes from the pause", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => world(step === 2 ? 1 : step),
			clicks: [undefined, undefined, "k3"],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, { harness, core, now }) => {
				const reconcile = (h: Harness, ctx?: Context) => core.reconcile(h, ctx);
				if (step === 1) await pauseAll(harness, reconcile, now);
				if (step === 3) await resumeAll(harness, reconcile, now);
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.held).toEqual([{ watch: "banda-142", from: NOW + 10 * MINUTE, to: NOW + 30 * MINUTE }]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]).toMatchObject({ resumed: true, ended: "merged" });
		expect(summary.record.resumed).toBeUndefined();
	}, 60_000);

	it("resumed with nothing changed: no wake, and nothing left marked for the next one", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => world(step < 3 ? 0 : 1),
			clicks: [undefined, "k2", "k3"],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, scene) => {
				if (step === 1) await hold(scene, true);
				if (step === 2) await hold(scene, false);
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]?.resumed).toBeUndefined();
	}, 60_000);

	it("stopped while its wake is pending: no further wake", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			act: async (step, { harness, core }) => {
				if (step !== 2) return;
				await harness.commit(async (tx) => {
					delete (await tx.doc(Accepted)).files[watchPath("banda-142")];
				}, context);
				await core.reconcile(harness);
			},
			only: (_name, step) => step < 2,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.live).toEqual([]);
	}, 60_000);

	it("duplicate and out-of-order readings: at most one wake per transition", async () => {
		const order = [0, 1, 1, 0, 1, 1];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => world(order[step] ?? 1),
			clicks: ["k1", "k2", "k3", "k4", "k4", "k5"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.length).toBeLessThanOrEqual(3);
		expect(summary.wakes[0]?.changes).toEqual(expect.arrayContaining(["ana approved", "lint failed"]));
	}, 60_000);

	it("an hour unable to look draws one error line; a good look clears it, and the next hour draws one again", async () => {
		const down = new Set([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => (down.has(step) ? {} : world(0)),
			clicks: Array.from({ length: 12 }, (_, n) => `k${n + 1}`),
			at: (step) => NOW + step * 20 * MINUTE,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.troubles.map((each) => each.since)).toEqual([NOW + 20 * MINUTE, NOW + 140 * MINUTE]);
		expect(summary.unread).toBe(2);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes).toHaveLength(0);
	}, 60_000);

	it("a cursor that fell off the kept readings wakes once, saying changes may be missing; it is behind until a wake without a gap", async () => {
		// Otto looks at every step; Mara only at the last two, when her cursor fell off the readings kept, then once more
		const lint = (conclusion: string, id: number) => (at: Reads) => {
			Object.assign(at.get_check_runs.check_runs[1] ?? {}, { status: "completed", conclusion, id });
		};
		const steps: World[] = [
			world(0),
			world(1),
			changed(1, lint("success", 100)),
			changed(1, lint("failure", 101)),
			changed(1, lint("success", 102)),
			changed(1, lint("failure", 103)),
			changed(1, lint("failure", 103)),
			changed(1, lint("success", 104)),
		];
		let behind: number | undefined;
		const summary = await watchScenario(await tempHome(), new Faults(), {
			second: true,
			world: (step) => steps[step] ?? world(1),
			clicks: ["k1", "k2", "k3", "k4", "k5", "k6", "k7"],
			only: (name, step) => name === "banda-142-otto" || step >= 6,
			act: async (step, { harness }) => {
				if (step === 7) behind = (await harness.snapshot(Watches, context))?.watches["banda-142"]?.behind;
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		const mara = summary.wakes.filter((wake) => wake.watch === "banda-142");
		expect(mara.map((wake) => wake.gap)).toEqual([true, undefined]);
		expect(behind).toBe(NOW);
		expect(summary.record.behind).toBeUndefined();
		const otto = summary.wakes.filter((wake) => wake.watch === "banda-142-otto");
		expect(otto.every((wake) => wake.gap === undefined)).toBe(true);
	}, 60_000);
});
