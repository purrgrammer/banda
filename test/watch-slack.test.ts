import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/follow.ts";
import { type SlackBudget, slackBudget, slackCall } from "../src/core/slack-rest.ts";
import { context } from "../src/core/store.ts";
import { Followed, MAX_WINDOW_BYTES, Watches, type WatchRecord } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import {
	CHANNEL,
	ME,
	match,
	ROOT,
	type Said,
	SLACK,
	SLACK_SCENARIOS,
	type SlackStep,
	said,
	slackWorld,
} from "./fault/slack-world.ts";
import { failure, NOW, type ScenarioOptions, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { fakeSlack } from "./fixtures/slack.ts";
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

describe("a walk held on a Slack channel", () => {
	it("a walk read for another object or account is never gone on from: the look starts afresh", async () => {
		const seen: WatchRecord[] = [];
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({ channel: step >= 1 ? [...BEFORE, ...BURST] : BEFORE }),
			["k1", "k2", "k3", "k4"],
			{
				act: async (step, { harness }) => {
					// the record as a look for another object (or as another account) left it, its walk that object's
					if (step === 2)
						await harness.commit(async (tx) => {
							const record = (await tx.doc(Watches)).watches["banda-142"];
							if (record !== undefined) record.key = "other-account slack:channel:slack/C0OTHER";
						}, context);
					seen.push(await recordNow(harness));
				},
			},
		);
		// the second look began a walk of its own, one page in, not the third page of the walk it found
		expect(seen[2]?.pages?.history?.items).toHaveLength(15);
		expect(summary.record.pages).toBeUndefined();
		expect(summary.wakes).toHaveLength(1);
	}, 60_000);

	it("a walk whose page keeps failing for an hour stops asking from its cursor and merges with a gap", async () => {
		const seen: WatchRecord[] = [];
		const asked: { tool: string; oldest?: unknown; cursor?: unknown }[] = [];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: SLACK,
			object: CHANNEL_REF,
			answer: slackWorld(
				(step) => ({
					channel: step >= 1 ? [...BEFORE, ...BURST] : BEFORE,
					...(step === 2 || step === 3 ? { busy: "Slack refused (invalid_cursor)." } : {}),
				}),
				15,
				asked,
			),
			clicks: ["k1", "k2", "k3", "k4"],
			at: (step) => NOW + Math.max(0, step - 1) * 40 * 60_000,
			act: async (_step, { harness }) => {
				seen.push(await recordNow(harness));
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		// past the hour the failing look let go of the cursor; the next asked the newest page and merged, with a gap
		expect(seen[3]?.pages?.history).toBeDefined();
		expect(seen[3]?.pages?.history?.cursor).toBeUndefined();
		const history = asked.filter((each) => each.tool === "channel_history");
		expect(history.at(-1)?.cursor).toBeUndefined();
		expect(summary.record.pages).toBeUndefined();
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes.concat(summary.tells).at(-1)?.gap).toBe(true);
	}, 60_000);

	it("a window of long messages stays within its bytes: the oldest are pushed off, never told as deleted", async () => {
		const long = (n: number, words: string) => said(n, "@cy at Acme", `${words} ${"x".repeat(3900)}`);
		const before = Array.from({ length: 80 }, (_, n) => long(10 + n, `old ${n}`));
		let kept: unknown[] = [];
		const summary = await follow(
			CHANNEL_REF,
			(step) => ({ channel: step >= 1 ? [...before, long(200, "new one")] : before }),
			["k1"],
			{
				pageMax: 100,
				act: async (_step, { harness }) => {
					const objects = (await harness.snapshot(Followed, context))?.objects ?? {};
					kept = (Object.values(objects)[0]?.answers.history as { messages?: unknown[] } | undefined)?.messages ?? [];
				},
			},
		);
		// the baseline's window, as the first look kept it
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(80);
		expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
		expect(summary.tells).toHaveLength(1);
		expect(summary.tells[0]?.changes).toHaveLength(1);
		expect(summary.tells[0]?.changes[0]).toMatch(/^@cy: new one x/);
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

describe("three channel watches on one account, Slack answering history once a minute", () => {
	it("look in turn as the queue opens: none retries in a loop, the rows say since when, the queue stays shallow", async () => {
		const slack = fakeSlack();
		slack.access = "xoxp-three-watches";
		slack.perMinute.add("conversations.history");
		const at = (step: number) => NOW + step * 60_000;
		let clock = at(0);
		slack.now = () => clock;
		const budget = slackBudget(() => clock);
		// the budget as every caller meets it, measured: how many calls of one method wait in its queue at once
		let deepest = 0;
		const waiting = new Map<string, number>();
		const measured: SlackBudget = {
			run: (key, call) => {
				waiting.set(key, (waiting.get(key) ?? 0) + 1);
				deepest = Math.max(deepest, waiting.get(key) ?? 0);
				const ran = budget.run(key, call);
				const done = () => waiting.set(key, (waiting.get(key) ?? 1) - 1);
				ran.then(done, done);
				return ran;
			},
		};
		const answer = async (tool: string, args: { readonly [key: string]: unknown }, step: number) => {
			clock = at(step);
			const result = await slackCall(slack.access, tool, { ...args }, undefined, slack.fetch, measured, () => clock);
			return result.isError ? failure(result.text, result.retryAt) : (JSON.parse(result.text) as Json);
		};
		const records: { [name: string]: WatchRecord }[] = [];
		const names = ["banda-142", "banda-142-2", "banda-142-3"];
		const settled = async (harness: Parameters<NonNullable<ScenarioOptions["act"]>>[1]["harness"], now: number) => {
			for (let i = 0; i < 400; i++) {
				const watches = (await harness.snapshot(Watches, context))?.watches ?? {};
				if (names.every((name) => (watches[name]?.next ?? 0) > now)) return structuredClone(watches);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error("the watches never looked");
		};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: SLACK,
			object: "slack/C0GENERAL",
			more: ["slack/G0DEPLOYS", "slack/D0BOB"],
			answer,
			clicks: [undefined, undefined, undefined],
			at,
			act: async (_step, { harness, now }) => {
				records.push(await settled(harness, now));
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		const history = slack.calls.filter((call) => call.method === "conversations.history");
		// one good read a minute, and at most one refusal beside it: the held queue answered the rest itself
		expect(history).toHaveLength(5);
		// a minute on, two have looked; the third's row says since when Slack has been busy, and when it looks again
		const second = records[0] ?? {};
		const failing = names.filter((name) => second[name]?.failed !== undefined);
		expect(failing).toHaveLength(1);
		expect(second[failing[0] as string]?.failed).toMatchObject({
			since: at(0),
			why: "Slack is busy, back at 09:02",
		});
		expect(second[failing[0] as string]?.next).toBe(at(2));
		// another minute, the last: each in turn, and then none failing
		for (const each of records.slice(1)) expect(names.filter((name) => each[name]?.failed !== undefined)).toEqual([]);
		expect(new Set(names.map((name) => records[2]?.[name]?.looked))).toEqual(new Set([at(0), at(1), at(2)]));
		expect(deepest).toBeLessThanOrEqual(3);
	}, 60_000);
});

describe("a watch on a Slack search, a person and a thread's reactions", () => {
	it("a search: a new match wakes in its channel's words; the owner's own and one indexed late are nothing", async () => {
		const summary = await follow(
			"slack/search/deploy",
			(step) => ({
				search: [
					match(10, "@bob at Acme", "deploy 41 failed"),
					...(step >= 1 ? [match(30, "@cy at Acme", "deploy 42 failed")] : []),
					...(step >= 2 ? [match(40, ME, "deploy 42 fixed")] : []),
					// Slack indexed it late: older than the newest match the watch had
					...(step >= 3 ? [match(20, "@dee at Acme", "deploy 41 rolled back")] : []),
				],
			}),
			["k1", "k2", "k3"],
		);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["@cy in #deploys: deploy 42 failed"]]);
		expect(summary.tells).toEqual([]);
	}, 60_000);

	it("a person: a status changed tells, cleared tells, a face changed is nothing", async () => {
		const bob = (status: string, avatar = "https://avatars.slack-edge.com/bob_72.png") => ({
			id: "U0BOB",
			name: "bob",
			real_name: "Bob Stone",
			title: "Engineer",
			tz: "America/New_York",
			status_text: status,
			outside: false,
			avatar,
		});
		const summary = await follow(
			"slack/user/U0BOB",
			(step) => ({
				person:
					step === 0
						? bob("On call")
						: step === 1
							? bob("At lunch")
							: bob("", "https://avatars.slack-edge.com/bob_new.png"),
			}),
			["k1", "k2"],
		);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["status: At lunch"], ["status: cleared"]]);
		expect(summary.wakes).toEqual([]);
	}, 60_000);

	it("a reaction on the owner's own reply tells; the owner's own edit beside it is nothing", async () => {
		const mine = (text: string, reactions?: Said[]) => ({
			...said(20, ME, text),
			...(reactions === undefined ? {} : { reactions }),
		});
		const summary = await follow(
			THREAD,
			(step) => ({
				replies: [
					said(5, "@cy at Acme", "first look"),
					step === 0 ? mine("I'll look") : mine("I'll look today", [{ name: "tada", count: 2 }]),
				],
			}),
			["k1"],
		);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["2 reacted :tada:"]]);
		expect(summary.wakes).toEqual([]);
	}, 60_000);
});
