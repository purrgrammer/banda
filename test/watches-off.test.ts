import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Connected, ToolSettings } from "../src/core/connections.ts";
import type { Json } from "../src/core/follow.ts";
import { context } from "../src/core/store.ts";
import { Watches } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import {
	NOW,
	type ScenarioConnection,
	type Scene,
	watchInvariants,
	watchScenario,
	world,
} from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

const HOUR = 60 * 60_000;

const off = (harness: Harness, tool: string, why: "owner" | "waiting" = "owner", via = "github") =>
	harness.commit(async (tx) => {
		(await tx.doc(Connected)).off[`${via}__${tool}`] = why;
	}, context);
const on = (harness: Harness, tool: string, via = "github") =>
	harness.commit(async (tx) => {
		delete (await tx.doc(Connected)).off[`${via}__${tool}`];
	}, context);
const counter = (home: string) => () =>
	readFileSync(join(home, "reads.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean).length;
const record = async (harness: Harness) => (await harness.snapshot(Watches, context))?.watches["banda-142"];

/** A connection with a read of its own for what an optional read gives. */
const args = { owner: "{owner}", repo: "{repo}", number: "{number}" };
const LABELLED: ScenarioConnection = {
	name: "example",
	account: "bandarra",
	file: JSON.stringify({
		service: "Example",
		about: "An example",
		url: "https://example.com/mcp",
		auth: "key",
		reads: ["get", "labels"],
		objects: {
			item: {
				card: "issue",
				name: "{owner}/{repo} #{number}",
				urls: ["https://example.com/{owner}/{repo}/items/{number}"],
				ids: ["{owner}/{repo}#{number}"],
				reads: { issue: { tool: "get", args }, labels: { tool: "labels", args, optional: true } },
				fields: { title: "issue.title", state: "issue.state" },
				follow: {
					ends: {},
					otherwise: "tell",
					rules: [
						{ on: "labels[*]", does: "wake", says: "label {name}" },
						{ on: "issue.state", does: "wake", says: "now {to}" },
					],
				},
			},
		},
	}),
	tools: ["get", "labels"].map((name) => ({
		name,
		description: "read",
		inputSchema: { type: "object", properties: { number: { type: "integer" } } },
	})),
};

describe("a watch whose tool is off", () => {
	it("makes no call, shows why, wakes and tells nothing however long; back on, it reads again and fires nothing", async () => {
		const home = await tempHome();
		const reads = counter(home);
		const made: number[] = [];
		let stopped: Awaited<ReturnType<typeof record>>;
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			// the object changes while the tool is off (step 4), and again once the watch is back (step 7)
			world: (step) => world(step >= 7 ? 3 : step >= 4 ? 1 : 0),
			clicks: Array.from({ length: 8 }, () => undefined),
			at: (step) => NOW + step * 2 * HOUR,
			act: async (step, { harness, core }) => {
				if (step === 2) await off(harness, "pull_request_read");
				if (step === 6) await on(harness, "pull_request_read");
				const before = reads();
				await core.lookWatch(harness, "banda-142");
				made.push(reads() - before);
				if (step === 5) stopped = await record(harness);
			},
		});
		expect(made).toEqual([4, 0, 0, 0, 0, 4, 4, 4]);
		expect(stopped?.failed).toMatchObject({ off: true });
		expect(stopped?.failed?.why).toContain("You turned off");
		expect(stopped?.failed?.why).toContain("pull request read");
		expect(stopped?.done).toBeUndefined();
		expect(summary.tells).toEqual([]);
		// off for hours: no trouble line, since the owner turned it off themselves
		expect(summary.troubles).toEqual([]);
		// the resume fires nothing, and the object's next change after it wakes as ever
		expect(summary.wakes.map((wake) => wake.ended)).toEqual(["merged"]);
		expect(summary.record.failed).toBeUndefined();
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("a watch back from Off on an object that ended meanwhile ends, by the normal done path", async () => {
		const home = await tempHome();
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			// merged while the tool is off (step 4)
			world: (step) => world(step >= 4 ? 3 : 0),
			clicks: Array.from({ length: 9 }, () => undefined),
			at: (step) => NOW + step * 2 * HOUR,
			act: async (step, { harness, core }) => {
				if (step === 2) await off(harness, "pull_request_read");
				if (step === 6) await on(harness, "pull_request_read");
				await core.lookWatch(harness, "banda-142");
			},
		});
		expect(summary.wakes.map((wake) => wake.ended)).toEqual(["merged"]);
		expect(summary.record.done?.why).toBe("merged");
		expect(summary.record.failed).toBeUndefined();
		expect(watchInvariants(summary)).toEqual([]);
	}, 60_000);

	it("says so in other words when the tool waits for the owner to turn it on", async () => {
		const home = await tempHome();
		let stopped: Awaited<ReturnType<typeof record>>;
		await watchScenario(home, new Faults(), {
			tasks: false,
			world: () => world(0),
			clicks: [undefined, undefined],
			act: async (step, { harness, core }) => {
				if (step === 2) await off(harness, "pull_request_read", "waiting");
				await core.lookWatch(harness, "banda-142");
				if (step === 2) stopped = await record(harness);
			},
		});
		expect(stopped?.failed?.why).toContain("until you turn it on");
	}, 60_000);

	it("a switch landing mid-look keeps nothing that look read and stops the watch for that reason", async () => {
		const home = await tempHome();
		let scene: Scene | undefined;
		let landed = false;
		let stopped: Awaited<ReturnType<typeof record>>;
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			world: (step) => world(step >= 3 ? 1 : 0),
			clicks: [undefined, undefined, undefined, undefined],
			at: (step) => NOW + step * 2 * HOUR,
			answer: async (tool, args, step) => {
				if (step === 2 && !landed && scene !== undefined) {
					landed = true;
					await off(scene.harness, tool);
				}
				return (world(step >= 3 ? 1 : 0) as { [read: string]: Json })[String(args.method)] as Json;
			},
			act: async (step, each) => {
				scene = each;
				if (step === 3) await on(each.harness, "pull_request_read");
				await each.core.lookWatch(each.harness, "banda-142");
				if (step === 2) stopped = await record(each.harness);
			},
		});
		expect(stopped?.failed).toMatchObject({ off: true });
		expect(stopped?.failed?.why).toContain("You turned off");
		expect(summary.wakes).toEqual([]);
		expect(summary.tells).toEqual([]);
		expect(summary.troubles).toEqual([]);
		expect(summary.record.failed).toBeUndefined();
	}, 60_000);

	it("an optional read that is off is skipped: neither its going nor its coming back fires a change", async () => {
		const home = await tempHome();
		const answer = (tool: string, step: number): Json =>
			tool === "get"
				? { title: "x", state: step >= 6 ? "closed" : "open" }
				: step >= 3
					? [
							{ id: 1, name: "bug" },
							{ id: 2, name: "later" },
						]
					: [{ id: 1, name: "bug" }];
		const called: string[][] = [];
		let current: string[] = [];
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			connection: LABELLED,
			object: "https://example.com/a/b/items/1",
			answer: (tool, _args, step) => {
				current.push(tool);
				return answer(tool, step);
			},
			clicks: Array.from({ length: 7 }, () => undefined),
			at: (step) => NOW + step * 2 * HOUR,
			act: async (step, { harness, core }) => {
				if (step === 2) await off(harness, "labels", "owner", "example");
				if (step === 5) await on(harness, "labels", "example");
				current = [];
				await core.lookWatch(harness, "banda-142");
				called.push(current);
			},
		});
		// the off read is not called, the other goes on; a label added while it was off is no change once it is back
		expect(called.slice(0, 5)).toEqual([["get", "labels"], ["get"], ["get"], ["get"], ["get", "labels"]]);
		expect(summary.wakes.flatMap((wake) => wake.changes)).toEqual(["now closed"]);
		expect(summary.tells).toEqual([]);
		expect(summary.troubles).toEqual([]);
		expect(summary.record.failed).toBeUndefined();
	}, 60_000);

	it("Ask and Always ask change nothing for a watch", async () => {
		const home = await tempHome();
		const reads = counter(home);
		const made: number[] = [];
		const summary = await watchScenario(home, new Faults(), {
			tasks: false,
			world: () => world(0),
			clicks: [undefined, undefined, undefined],
			at: (step) => NOW + step * 2 * HOUR,
			act: async (step, { harness, core }) => {
				if (step > 1)
					await harness.commit(async (tx) => {
						(await tx.doc(ToolSettings)).set.github__pull_request_read = step === 2 ? "ask" : "always";
					}, context);
				const before = reads();
				await core.lookWatch(harness, "banda-142");
				made.push(reads() - before);
			},
		});
		expect(made).toEqual([4, 4, 4]);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes).toEqual([]);
	}, 60_000);
});
