import { describe, expect, it } from "vitest";
import { parseWatch, watchText } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import { type World, watchProblems, watchScenario, world } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

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
});

