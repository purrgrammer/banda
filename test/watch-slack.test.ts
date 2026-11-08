import { describe, expect, it } from "vitest";
import { context } from "../src/core/store.ts";
import { Watches, type WatchRecord } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import { CHANNEL, ME, ROOT, SLACK, SLACK_SCENARIOS, type SlackStep, said, slackWorld } from "./fault/slack-world.ts";
import { NOW, type ScenarioOptions, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

const THREAD = `slack/${CHANNEL}/p${ROOT.replace(".", "")}`;
const CHANNEL_REF = `slack/${CHANNEL}`;

/** Five messages in the channel before the watch: its baseline. */
const BEFORE = Array.from({ length: 5 }, (_, n) => said(10 + n, "@bob at Acme", `earlier ${n}`));
/** Forty at once, one of them mentioning the owner. */
const BURST = Array.from({ length: 40 }, (_, n) =>
	n === 20 ? said(100 + n, "@cy at Acme", "<@U0ANA> can you look?", true) : said(100 + n, "@cy at Acme", `burst ${n}`),
);

const follow = async (
	object: string,
	world: (step: number) => SlackStep,
	clicks: readonly (string | undefined)[],
	more: Partial<ScenarioOptions> & { home?: string; pageMax?: number } = {},
) => {
	const { home = await tempHome(), pageMax, ...options } = more;
	const summary = await watchScenario(home, new Faults(), {
		connection: SLACK,
		object,
		answer: slackWorld(world, pageMax),
		clicks,
		...options,
	});
	expect(watchInvariants(summary)).toEqual([]);
	return summary;
};

/** The watch's record as it stands, read in a scenario's act. */
const recordNow = async (harness: Parameters<NonNullable<ScenarioOptions["act"]>>[1]["harness"]) =>
	structuredClone((await harness.snapshot(Watches, context))?.watches["banda-142"] ?? {}) as WatchRecord;

describe("a watch on a Slack thread", () => {
	it("a reply wakes; the owner's own reply is nothing; a bot's reply only tells", async () => {
		const replies = [said(5, "@cy at Acme", "first look")];
		const summary = await follow(
			THREAD,
			(step) => ({
				replies: [
					...replies,
					...(step >= 1 ? [said(20, "@bob at Acme", "any news?")] : []),
					...(step >= 2 ? [said(30, ME, "I'll look today")] : []),
					...(step >= 3 ? [said(40, "@deploybot [bot]", "deployed 41")] : []),
				],
			}),
			["k1", "k2", "k3"],
		);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["@bob replied"]]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["@deploybot [bot] replied"]]);
		expect(summary.wakes[0]?.object).toMatchObject({ service: "Slack", account: ME });
	}, 60_000);

	it("an edit and a deletion in the newest page tell", async () => {
		const summary = await follow(
			THREAD,
			(step) => ({
				replies: [
					said(5, "@cy at Acme", step >= 1 ? "first look, edited" : "first look"),
					...(step >= 2 ? [] : [said(6, "@cy at Acme", "oops")]),
				],
			}),
			["k1", "k2"],
		);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([
			["@cy edited a message"],
			["a message from @cy was deleted"],
		]);
		expect(summary.wakes).toEqual([]);
	}, 60_000);
});

describe("a watch on a Slack channel", () => {
	it("a message tells in its author's words; a mention wakes; the owner's own post is nothing", async () => {
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({
				channel: [
					...BEFORE,
					...(step >= 1 ? [said(50, "@cy at Acme", "lunch?\nanyone")] : []),
					...(step >= 2 ? [said(60, "@bob at Acme", "<@U0ANA> the deploy failed", true)] : []),
					...(step >= 3 ? [said(70, ME, "on it")] : []),
				],
			}),
			["k1", "k2", "k3"],
		);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["@cy: lunch? anyone"]]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["@bob mentioned you"]]);
	}, 60_000);

	it("a topic changed tells", async () => {
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({ channel: BEFORE, topic: step >= 1 ? "Ship it" : "Company-wide" }),
			["k1"],
		);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["topic: Ship it"]]);
	}, 60_000);

	it("a burst of forty at fifteen a page is one wake with all forty in the window, behind between", async () => {
		const seen: WatchRecord[] = [];
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({ channel: step >= 1 ? [...BEFORE, ...BURST] : BEFORE }),
			["k1", "k2", "k3"],
			{
				act: async (_step, { harness }) => {
					seen.push(await recordNow(harness));
				},
			},
		);
		// before the second and third looks the walk was held, the watch behind; the third merged it
		expect(seen[1]?.pages?.history?.items).toHaveLength(15);
		expect(seen[2]?.pages?.history?.items).toHaveLength(30);
		expect(summary.record.pages).toBeUndefined();
		expect(summary.tells).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]?.changes).toContain("@cy mentioned you");
		expect(summary.wakes[0]?.changes.at(-1)).toBe("and 20 more");
		expect(summary.wakes[0]?.gap).toBeUndefined();
	}, 60_000);

	it("Slack busy holds: the row says since when, the walk kept, and the next look goes on from its cursor", async () => {
		const seen: WatchRecord[] = [];
		const busy = "Slack is busy, back at 09:31";
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({ channel: step >= 1 ? [...BEFORE, ...BURST] : BEFORE, ...(step === 2 ? { busy } : {}) }),
			["k1", "k2", "k3", "k4"],
			{
				at: (step) => NOW + step * 60_000,
				act: async (_step, { harness }) => {
					seen.push(await recordNow(harness));
				},
			},
		);
		expect(seen[2]?.failed).toMatchObject({ why: busy, since: NOW + 2 * 60_000 });
		expect(seen[2]?.pages?.history?.items).toHaveLength(15);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]?.gap).toBeUndefined();
	}, 60_000);

	it("pages held across a restart are merged once", async () => {
		const home = await tempHome();
		const world = (step: number): SlackStep => ({ channel: step >= 1 ? [...BEFORE, ...BURST] : BEFORE });
		const held = await follow(CHANNEL_REF, world, ["k1"], { home });
		expect(held.record.pages?.history?.items).toHaveLength(15);
		expect(held.wakes).toEqual([]);
		const merged = await follow(CHANNEL_REF, world, ["k1", "k2", "k3", "k4"], { home });
		expect(merged.wakes).toHaveLength(1);
		expect(merged.record.pages).toBeUndefined();
	}, 60_000);

	it("a walk the budget cannot finish within an hour merges what it read, and the wake says changes may be missing", async () => {
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({ channel: step >= 1 ? [...BEFORE, ...BURST] : BEFORE }),
			["k1", "k2", "k3"],
			{ pageMax: 5, at: (step) => NOW + Math.max(0, step - 1) * 31 * 60_000 },
		);
		// three pages of five, the newest fifteen: the mention among the twenty-five not reached is the gap's
		expect(summary.wakes).toEqual([]);
		expect(summary.tells).toHaveLength(1);
		expect(summary.tells[0]?.gap).toBe(true);
		expect(summary.tells[0]?.changes).toContain("@cy: burst 39");
		expect(summary.tells[0]?.changes).not.toContain("@cy: burst 24");
		expect(summary.record.behind).toBeDefined();
		expect(summary.record.pages).toBeUndefined();
	}, 60_000);
});

describe("the fault worker's Slack scenarios", () => {
	it.each(Object.keys(SLACK_SCENARIOS))(
		"%s holds what it must, with no fault",
		async (name) => {
			const scenario = SLACK_SCENARIOS[name] as (typeof SLACK_SCENARIOS)[string];
			expect(scenario.problems(await watchScenario(await tempHome(), new Faults(), scenario.options))).toEqual([]);
		},
		60_000,
	);
});
