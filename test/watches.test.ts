import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted } from "../src/core/agents.ts";
import { Connected } from "../src/core/connections.ts";
import { pause as pauseAll, resume as resumeAll } from "../src/core/control.ts";
import { BUSY_EVERY, type Json } from "../src/core/follow.ts";
import { objectAccess } from "../src/core/object-access.ts";
import { context } from "../src/core/store.ts";
import { Routes } from "../src/core/turn.ts";
import { endWatches, parseWatch, Watches, type WatchRecord, watchPath, watchText } from "../src/core/watches.ts";
import { pause } from "../src/server/watches.ts";
import { Faults } from "./fault/faults.ts";
import {
	GITHUB,
	NOW,
	SCENARIOS,
	type Scene,
	WATCH,
	type World,
	watchInvariants,
	watchProblems,
	watchScenario,
	world,
} from "./fault/watch-scenario.ts";
import { definition, shipping } from "./fixtures/shipped.ts";
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
		expect(errors("x", "---\nobject: a\nwakes_a_day: 0\n---\nwords\n")).toContainEqual(
			expect.stringContaining("wakes_a_day"),
		);
		const limited = watchText({ object: "a", wakesADay: 6, ask: "words" });
		expect(limited).toBe("---\nobject: a\nwakes_a_day: 6\n---\nwords\n");
		expect(parseWatch("x", limited)).toEqual({ watch: { name: "x", object: "a", wakesADay: 6, ask: "words" } });
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

	it("a look within another watch's reading of the object diffs that reading and asks the service nothing", async () => {
		// no tasks: the act looks for both, ten minutes a step, Mara first (her own newest reading is never shared, so
		// she reads), then Otto, whose look takes the reading Mara's just kept and reads nothing. At step 5 Otto looks
		// first, so he reads and Mara shares. The world runs a step behind, so step 1 is the baseline.
		const home = await tempHome();
		const reads = () =>
			readFileSync(join(home, "reads.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).length;
		// a look while its last wake's run still goes holds what it sees for that run: wait for the runs first
		const settled = async (harness: Harness) => {
			for (;;) {
				const graph = await harness.taskGraph(context);
				const busy = Object.values(graph.value.tasks).some(
					(task) => task.kind !== "banda.watch" && task.kind !== "banda.routine",
				);
				graph.dispose();
				if (!busy) return;
				await new Promise((r) => setTimeout(r, 5));
			}
		};
		const made: { mara: number; otto: number }[] = [];
		const summary = await watchScenario(home, new Faults(), {
			second: true,
			tasks: false,
			world: (step) => world(Math.max(0, step - 1)),
			clicks: [undefined, undefined, undefined, undefined, undefined],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, { harness, core }) => {
				await settled(harness);
				const counts: { [name: string]: number } = {};
				for (const name of step <= 4 ? ["banda-142", "banda-142-otto"] : ["banda-142-otto", "banda-142"]) {
					const before = reads();
					await core.lookWatch(harness, name);
					counts[name] = reads() - before;
				}
				made.push({ mara: counts["banda-142"] ?? -1, otto: counts["banda-142-otto"] ?? -1 });
			},
		});
		// step 1 is each watch's baseline, which says how the object stands now, so Otto reads too; at step 5 Otto's
		// hold from step 4 wants a reading from after the settling time, and Mara's step-4 reading is from before it
		expect(made).toEqual([
			{ mara: 4, otto: 4 },
			{ mara: 4, otto: 0 },
			{ mara: 4, otto: 0 },
			{ mara: 4, otto: 0 },
			{ mara: 0, otto: 4 },
		]);
		expect(watchInvariants(summary)).toEqual([]);
		for (const name of ["banda-142", "banda-142-otto"]) {
			const wakes = summary.wakes.filter((wake) => wake.watch === name);
			expect(wakes.map((wake) => wake.ended)).toEqual([undefined, "merged"]);
			expect([...(wakes[0]?.changes ?? [])].sort()).toEqual(["ana approved", "checks finished", "lint failed"]);
		}
		expect(summary.second?.done?.why).toBe("merged");
		// the readings differed three times (steps 2 and 4), and both cursors reached the last
		expect(summary.record.seen).toBe(3);
		expect(summary.second?.seen).toBe(3);
		// the card is the newest look's that read it: Otto's at step 5; both watches are done, so the reading is gone
		expect(summary.card?.at).toBe(NOW + 50 * MINUTE);
		expect(summary.followed).toBeUndefined();
	}, 60_000);

	it("the first look after its connection's definition changed keeps the watch live, reads again and wakes on nothing", async () => {
		// the pull request stands still; Mara reads it at step 3, then the connection's definition changes (the daemon
		// started on a new build), and Otto's look takes no reading made under the version before: it reads for itself
		const home = await tempHome();
		const reads = () =>
			readFileSync(join(home, "reads.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).length;
		const made: { mara: number; otto: number }[] = [];
		const summary = await watchScenario(home, new Faults(), {
			second: true,
			tasks: false,
			world: () => world(0),
			clicks: [undefined, undefined, undefined, undefined],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, { harness, core }) => {
				const before = reads();
				await core.lookWatch(harness, "banda-142");
				const mara = reads() - before;
				if (step === 3) {
					// the daemon started on a build whose definition differs: the version moves, and its start lists it again
					const newer = definition("github", `${GITHUB.file}\n`);
					shipping(newer);
					await harness.commit(async (tx) => {
						const listed = (await tx.doc(Connected)).connections.github;
						if (listed !== undefined) listed.version = newer.version;
					}, context);
				}
				const after = reads();
				await core.lookWatch(harness, "banda-142-otto");
				made.push({ mara, otto: reads() - after });
			},
		});
		expect(made).toEqual([
			{ mara: 4, otto: 4 },
			{ mara: 4, otto: 0 },
			{ mara: 4, otto: 4 },
			{ mara: 4, otto: 0 },
		]);
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells).toEqual([]);
		expect(summary.troubles).toEqual([]);
		expect(summary.live).toEqual(["banda-142", "banda-142-otto"]);
		for (const record of Object.values(summary.records)) {
			expect(record.failed).toBeUndefined();
			expect(record.done).toBeUndefined();
			expect(record.looked).toBe(NOW + 40 * MINUTE);
		}
	}, 60_000);

	it("the first look after a resume reads the object itself, and its wake says it comes from the pause", async () => {
		// Otto is paused after the baseline; the pull request changes and Mara reads it; Otto is resumed in the same
		// minute: his look takes no reading from before his resume, reads, and wakes with what changed while paused
		const home = await tempHome();
		const reads = () =>
			readFileSync(join(home, "reads.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).length;
		const still = async () => {};
		const ottos: number[] = [];
		const summary = await watchScenario(home, new Faults(), {
			second: true,
			tasks: false,
			world: (step) => world(Math.max(0, step - 1)),
			clicks: [undefined, undefined, undefined],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, { harness, core, now }) => {
				await core.lookWatch(harness, "banda-142");
				if (step === 1) {
					await core.lookWatch(harness, "banda-142-otto");
					await pause(harness, still, "banda-142-otto", true, now);
					return;
				}
				if (step === 2) await pause(harness, still, "banda-142-otto", false, now);
				const before = reads();
				await core.lookWatch(harness, "banda-142-otto");
				ottos.push(reads() - before);
			},
		});
		expect(ottos).toEqual([4, 4]);
		expect(watchInvariants(summary)).toEqual([]);
		const otto = summary.wakes.filter((wake) => wake.watch === "banda-142-otto");
		expect(otto.map((wake) => wake.resumed)).toEqual([true]);
		expect([...(otto[0]?.changes ?? [])].sort()).toEqual(["ana approved", "checks finished", "lint failed"]);
		expect(summary.wakes.filter((wake) => wake.watch === "banda-142").every((wake) => wake.resumed === undefined)).toBe(
			true,
		);
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

	it("renaming an account does not change what a look was allowed to read", async () => {
		let stamps: (string | undefined)[] = [];
		await watchScenario(await tempHome(), new Faults(), {
			act: async (step, { harness }) => {
				if (step !== 2) return;
				const routes = (await harness.snapshot(Routes, context))?.routes ?? {};
				const chat = Object.values(routes)[0]?.chat as number;
				const ref = {
					connection: "github",
					kind: "pull_request",
					values: { owner: "acme", repo: "banda", number: "142" },
				};
				const stamp = () =>
					harness.commit(async (tx) => (await objectAccess(tx, chat, ref, "bandarra"))?.stamp, context);
				const before = await stamp();
				await harness.commit(async (tx) => {
					const account = (await tx.doc(Connected)).accounts.github?.bandarra;
					if (account !== undefined) account.label = "Work";
				}, context);
				stamps = [before, await stamp()];
			},
		});
		expect(stamps[0]).toBeDefined();
		expect(stamps[1]).toBe(stamps[0]);
	});

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

	it("a read that may fail and did keeps its last answer: green, a failed read, green again wakes no one", async () => {
		const green = (): World =>
			changed(0, (at) => {
				for (const run of at.get_check_runs.check_runs)
					Object.assign(run, { status: "completed", conclusion: "success" });
			});
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => {
				if (step !== 1) return green();
				const { get_check_runs: _failed, ...rest } = green();
				return rest;
			},
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toEqual([]);
		expect(summary.record.failed).toBeUndefined();
	}, 60_000);

	it.each([
		["success", 1],
		["failure", 0],
	])(
		"a push straddled by failed reads judges its own checks, %s, never the last commit's",
		async (conclusion, wakes) => {
			const checked = (head: string, result: string): World => {
				const at = changed(0, (each) => {
					for (const run of each.get_check_runs.check_runs)
						Object.assign(run, { status: "completed", conclusion: result });
				});
				return { ...at, get: { ...(at.get as { [key: string]: Json }), head: { ref: "objects", sha: head } } };
			};
			const { get_check_runs: _failed, ...unread } = checked("b1", "success");
			const summary = await watchScenario(await tempHome(), new Faults(), {
				world: (step) => [checked("a1", "success"), unread, unread, checked("b1", conclusion)][step] as World,
				clicks: ["k1", "k2", "k3"],
			});
			expect(watchInvariants(summary)).toEqual([]);
			expect(summary.wakes.flatMap((wake) => wake.changes).filter((each) => each === "all checks green")).toHaveLength(
				wakes,
			);
		},
		60_000,
	);

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

	it("made under Pause all, it still takes its baseline, so the resume wakes with what changed since it was made", async () => {
		// no tasks: the act looks itself, so the first look, under the pause, is the baseline, as when the owner follows
		const none = async () => {};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			tasks: false,
			world: (step) => world(step < 3 ? 0 : 1),
			// the look after the resume holds what it finds for the settling time; the one after it wakes
			clicks: [undefined, undefined, undefined, undefined],
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, { harness, core, now }) => {
				if (step === 1) await pauseAll(harness, none, now);
				if (step === 3) await resumeAll(harness, none, now);
				await core.lookWatch(harness, "banda-142");
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.held).toEqual([{ watch: "banda-142", from: NOW + 10 * MINUTE, to: NOW + 30 * MINUTE }]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]).toMatchObject({ resumed: true });
		expect(summary.wakes[0]?.changes).toEqual(expect.arrayContaining(["ana approved", "lint failed"]));
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

	it("busy cadence: it looks on its own every two minutes while checks run, and every five once they finish", async () => {
		let busy: { looked?: number; next?: number } = {};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) =>
				step < 2
					? world(0)
					: changed(0, (at) => {
							Object.assign(at.get_check_runs.check_runs[1] ?? {}, { status: "completed", conclusion: "success" });
						}),
			clicks: [undefined, "k2"],
			at: (step) => (step === 0 ? NOW : NOW + BUSY_EVERY),
			act: async (step, { harness }) => {
				if (step !== 1) return;
				// the baseline saw checks running: the task's own next look is two minutes on, and the one after it too
				const record = async () => (await harness.snapshot(Watches, context))?.watches["banda-142"];
				while ((await record())?.looked !== NOW + BUSY_EVERY) await new Promise((resolve) => setTimeout(resolve, 5));
				busy = (await record()) ?? {};
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(busy).toMatchObject({ looked: NOW + BUSY_EVERY, next: NOW + 2 * BUSY_EVERY });
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["all checks green", "checks finished"]]);
		expect(summary.record.next).toBe(NOW + BUSY_EVERY + 5 * 60_000);
	}, 60_000);

	it("a burst is one wake: what comes within the kind's settling time joins the first change's wake", async () => {
		// no clicks: the watch looks on its own (here, the act's look); the pull request settles in a minute
		const steps: World[] = [
			world(0),
			world(1),
			changed(1, (at) => {
				at.get_comments.push({ id: 6, user: { login: "bob" } });
			}),
		];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => steps[Math.min(step, 2)] as World,
			clicks: [undefined, undefined, undefined],
			at: (step) => NOW + [0, 3 * MINUTE, 3.5 * MINUTE, 5 * MINUTE][step]!,
			act: async (_step, { harness, core }) => {
				await core.lookWatch(harness, "banda-142");
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]?.changes).toEqual(expect.arrayContaining(["ana approved", "lint failed", "bob commented"]));
		expect(summary.wakes[0]?.burst).toBe(NOW + 3 * MINUTE);
		expect(summary.record.burst).toBeUndefined();
	}, 60_000);

	it("a burst is one wake: what comes while the last wake's run still goes wakes once, after it", async () => {
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const bob = (at: Reads) => {
			at.get_comments.push({ id: 6, user: { login: "bob" } });
		};
		const steps: World[] = [world(0), world(1), world(1), changed(1, bob), changed(1, bob), changed(3, bob)];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => steps[Math.min(step, 5)] as World,
			clicks: [undefined, undefined, undefined, undefined, undefined, undefined],
			at: (step) => NOW + step * 10 * MINUTE,
			gate: () => gate,
			act: async (step, { harness, core }) => {
				if (step === 6) {
					open();
					const turn = (await harness.snapshot(Watches, context))?.watches["banda-142"]?.turn;
					while ((await harness.getTask(turn as never, context))?.state.status !== "terminal")
						await new Promise((resolve) => setTimeout(resolve, 5));
				}
				await core.lookWatch(harness, "banda-142");
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		// settled at step 2; bob's comment at step 3 and the merge at 5 came while its run went, and wake once after it
		expect(summary.wakes.map((wake) => [...wake.changes].sort())).toEqual([
			["ana approved", "checks finished", "lint failed"],
			["bob commented", "closed", "merged"],
		]);
		expect(summary.wakes.map((wake) => wake.burst)).toEqual([NOW + 10 * MINUTE, NOW + 30 * MINUTE]);
		expect(summary.wakes[1]?.ended).toBe("merged");
	}, 60_000);

	it("a burst is one wake: a failure a held look saw wakes, though the newest reading no longer shows it", async () => {
		const scenario = SCENARIOS["held-failure"] as (typeof SCENARIOS)[string];
		const summary = await watchScenario(await tempHome(), new Faults(), scenario.options);
		expect(scenario.problems(summary)).toEqual([]);
		expect([...(summary.wakes[0]?.changes ?? [])].sort()).toEqual(["check failed", "new commits"]);
		expect(summary.wakes[0]?.burst).toBe(NOW + 30_000);
		expect(summary.tells).toEqual([]);
	}, 60_000);

	it("past its wakes a day it pauses alone and says so once; resumed, what came meanwhile is one wake", async () => {
		// bob's comments, one more each step; the watch looks on its own (here, the act's look), its run ended first
		const comments = (step: number): World =>
			changed(0, (at) => {
				at.get_comments.push(...Array.from({ length: step }, (_, n) => ({ id: 50 + n, user: { login: `bob${n}` } })));
			});
		let limited: WatchRecord | undefined;
		const summary = await watchScenario(await tempHome(), new Faults(), {
			watch: WATCH.replace("account: bandarra\n", "account: bandarra\nwakes_a_day: 2\n"),
			world: comments,
			clicks: Array.from({ length: 7 }, () => undefined),
			at: (step) => NOW + step * 10 * MINUTE,
			act: async (step, scene) => {
				const record = async () => (await scene.harness.snapshot(Watches, context))?.watches["banda-142"];
				const turn = (await record())?.turn;
				while (turn !== undefined && (await scene.harness.getTask(turn as never, context))?.state.status !== "terminal")
					await new Promise((resolve) => setTimeout(resolve, 5));
				if (step === 7) {
					limited = await record();
					await hold(scene, false);
				}
				await scene.core.lookWatch(scene.harness, "banda-142");
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		// settling holds each change one look: woken at steps 2 and 4, paused at 6, resumed at 7
		expect(limited?.paused).toBe("limit");
		expect(summary.troubles).toEqual([expect.objectContaining({ watch: "banda-142", wakesADay: 2 })]);
		expect(summary.wakes.map((wake) => wake.resumed ?? false)).toEqual([false, false, true]);
		expect(summary.wakes[2]?.changes).toEqual(["bob4 commented", "bob5 commented", "bob6 commented"]);
		expect(summary.record.paused).toBeUndefined();
		// its line counts as unread, as each reply does
		expect(summary.unread).toBe(summary.wakes.length + 1);
	}, 60_000);

	it("changes that only tell draw their line and the card, run no model and are not unread", async () => {
		const pushed = (step: number): World => {
			const at = structuredClone(world(0)) as { get: { [key: string]: Json } };
			if (step >= 1)
				Object.assign(at.get, { head: { ref: "objects", sha: "b2" }, title: "Keep objects as data, typed" });
			return at as unknown as World;
		};
		const summary = await watchScenario(await tempHome(), new Faults(), { world: pushed, clicks: ["k1", "k2"] });
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => [...tell.changes].sort())).toEqual([
			["new commits", "retitled: Keep objects as data, typed"],
		]);
		expect(summary.turns).toEqual([]);
		expect(summary.models).toBe(0);
		expect(summary.unread).toBe(0);
		expect(summary.card?.at).toBe(summary.followed?.at);
	}, 60_000);

	it("a watch on an issue: others' comments wake with the labels and assignees told beside, and it ends when closed", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), { issue: true, clicks: ["k1", "k2"] });
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => [...wake.changes].sort())).toEqual([
			["assigned to bandarra", "bob commented", "labelled bug", "unassigned ana"],
			["closed"],
		]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "acme/banda #41", service: "GitHub" });
		expect(summary.wakes[1]?.ended).toBe("closed");
		expect(summary.record.done?.why).toBe("closed");
		// the card is the newest reading: closed as completed
		expect(summary.card?.state).toBe("completed");
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);

	it("a thousand changes in one look are one wake, its words bounded, in bounded time", async () => {
		const flood = (step: number): World =>
			changed(Math.min(step, 1), (at) => {
				if (step < 1) return;
				at.get_comments.push(
					...Array.from({ length: 1000 }, (_, n) => ({ id: 1000 + n, user: { login: `bob${n}` }, body: "+1" })),
				);
				// as GitHub counts them on the pull request: a look reads the newest pages of them, by that count
				(at as unknown as { get: { comments: number } }).get.comments = at.get_comments.length;
			});
		let took = 0;
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: flood,
			clicks: [undefined],
			act: async (_step, { harness, core }) => {
				const start = performance.now();
				await core.checkWatch(harness, "banda-142", "k1");
				took = performance.now() - start;
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		const changes = summary.wakes[0]?.changes ?? [];
		// ana's approval, lint failing and the checks finishing, and the newest comments a look reads of a thousand (its
		// pages from the one before the last): twenty named, the rest counted, and the ones between said to be missing
		expect(changes).toHaveLength(21);
		expect(changes.at(-1)).toBe("and 84 more");
		expect(summary.wakes[0]?.gap).toBe(true);
		expect(changes.join(", ").length).toBeLessThan(2000);
		expect(summary.sent.every((text) => text.length < 4000)).toBe(true);
		expect(took).toBeLessThan(5000);
	}, 60_000);

	it("a push's first look claims no green: all checks green only once the new head's runs have all come", async () => {
		const run = (name: string, status: string, conclusion: string | null) => ({ id: name, name, status, conclusion });
		const pushed =
			(runs: Json[]) =>
			(step: number): World => {
				const at = structuredClone(world(0)) as {
					get: { [key: string]: Json };
					get_check_runs: { [key: string]: Json };
				};
				if (step >= 1) at.get.head = { ref: "objects", sha: "b2" };
				if (step >= 1) at.get_check_runs = { total_count: runs.length, check_runs: runs };
				return at as unknown as World;
			};
		const steps = [
			pushed([]),
			// seconds after the push only Vercel has reported; CI's runs are not listed yet
			pushed([run("vercel", "completed", "success")]),
			pushed([run("vercel", "completed", "success"), run("unit", "in_progress", null), run("lint", "queued", null)]),
			pushed([
				run("vercel", "completed", "success"),
				run("unit", "completed", "success"),
				run("lint", "completed", "success"),
			]),
		];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => (steps[step] as (step: number) => World)(step),
			clicks: ["k1", "k2", "k3"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["new commits"]]);
		expect(summary.wakes.map((wake) => [...wake.changes].sort())).toEqual([["all checks green", "checks finished"]]);
		expect(summary.wakes[0]?.version).toBe(summary.followed?.version);
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

	it("Check now moves the task's next look too: the task keeps its sleep, wakes, and sleeps on until the new time", async () => {
		// checks run throughout, so the watch is busy; the owner checks a minute after the baseline, which moves the next
		// look from +2m to +3m; the task still sleeps until +2m, wakes then (the clock at +2.5m), reads nothing and
		// sleeps until +3m: the same task throughout
		const ids: (number | undefined)[] = [];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: () => world(0),
			at: (step) => NOW + [0, 60_000, 150_000][step]!,
			clicks: ["k1", undefined],
			act: async (step, { harness }) => {
				const record = (await harness.snapshot(Watches, context))?.watches["banda-142"];
				ids.push(record?.task);
				if (step !== 2 || record?.task === undefined) return;
				// the task wakes at +2m and, with no look due, sleeps until the new time
				for (;;) {
					const task = await harness.getTask(record.task as TaskId, context);
					if (
						task?.state.status === "sleeping" &&
						(task.state as { until: number }).until === NOW + 60_000 + BUSY_EVERY
					)
						return;
					await new Promise((r) => setTimeout(r, 5));
				}
			},
		});
		expect(summary.record.next).toBe(NOW + 60_000 + BUSY_EVERY);
		expect(summary.task).toEqual({ status: "sleeping", until: summary.record.next });
		expect(ids[0]).toBeDefined();
		expect(ids).toEqual([ids[0], ids[0]]);
		// the baseline's read and the click's: the early wake read nothing
		expect(summary.looks).toBe(2);
	}, 60_000);

	it("Check now remakes the task only when the look found the object busy: its sleep would end too late", async () => {
		// quiet at the baseline (every check completed: the task sleeps five minutes); the first click finds it the
		// same, so the task stays; the second finds checks running, so the watch should look in two minutes: a new task
		const ids: (number | undefined)[] = [];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			world: (step) => (step <= 1 ? world(1) : world(0)),
			clicks: ["k1", "k2"],
			act: async (_step, { harness }) => {
				ids.push((await harness.snapshot(Watches, context))?.watches["banda-142"]?.task);
			},
		});
		// ids: before each click; the task after the last is the summary's
		expect(ids[0]).toBeDefined();
		expect(ids[1]).toBe(ids[0]);
		expect(summary.record.task).toBeDefined();
		expect(summary.record.task).not.toBe(ids[0]);
		expect(summary.task).toEqual({ status: "sleeping", until: NOW + BUSY_EVERY });
	}, 60_000);

	it("a check that first appears already failed wakes, in its own words", async () => {
		// lint is not there at the baseline; on the next push it comes already failed
		const lintLate = (step: number): World => {
			const at = structuredClone(world(0)) as {
				get_check_runs: { total_count: number; check_runs: { [key: string]: unknown }[] };
			};
			at.get_check_runs.check_runs = at.get_check_runs.check_runs.filter((run) => run.name !== "lint");
			if (step >= 1)
				at.get_check_runs.check_runs.push({ id: 77, name: "lint", status: "completed", conclusion: "failure" });
			at.get_check_runs.total_count = at.get_check_runs.check_runs.length;
			return at as unknown as World;
		};
		const summary = await watchScenario(await tempHome(), new Faults(), { world: lintLate, clicks: ["k1"] });
		expect(summary.wakes.flatMap((wake) => wake.changes)).toContain("lint failed");
	}, 60_000);
});
