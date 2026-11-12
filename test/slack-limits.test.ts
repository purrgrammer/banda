/**
 * Slack under its own limits: a fake Slack that answers each method no more often than Slack's tiers allow, history and
 * replies once a minute as Slack clamps an app outside its Marketplace, refusing the rest with `Retry-After`. Six watches
 * of one account and an agent reading another thread every third minute share the budget for an hour: each method meets Slack's refusal at
 * most once, every watch keeps looking, and what changes is seen.
 */
import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/follow.ts";
import { slackBudget, slackCall } from "../src/core/slack-rest.ts";
import { context } from "../src/core/store.ts";
import { Watches } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import { SLACK } from "./fault/slack-world.ts";
import { failure, NOW, type Scene, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { fakeSlack, ROOT_TS, SLACK_CLAMPED } from "./fixtures/slack.ts";
import { tempHome } from "./helpers.ts";

const MINUTE = 60_000;
const MINUTES = 60;
const NAMES = ["banda-142", "banda-142-2", "banda-142-3", "banda-142-4", "banda-142-5", "banda-142-6"];

describe("Slack's limits, an hour of six watches and an agent on one clamped account", () => {
	it("meets each refusal at most once, keeps every watch looking, and sees what changed", async () => {
		const slack = fakeSlack();
		slack.access = "xoxp-an-hour";
		Object.assign(slack.limits, SLACK_CLAMPED);
		slack.pageMax = 15;
		const at = (step: number) => NOW + step * MINUTE;
		let clock = at(0);
		slack.now = () => clock;
		const budget = slackBudget(() => clock);
		const read = (tool: string, args: { readonly [key: string]: unknown }) =>
			slackCall(slack.access, tool, { ...args }, undefined, slack.fetch, budget, () => clock);
		const answer = async (tool: string, args: { readonly [key: string]: unknown }, step: number) => {
			clock = at(step);
			const result = await read(tool, args);
			return result.isError ? failure(result.text, result.retryAt) : (JSON.parse(result.text) as Json);
		};
		const thread = `C0GENERAL/${ROOT_TS}`;
		// a second thread, which no watch follows
		const OTHER = "1700000300.000300";
		slack.history.C0GENERAL?.push({
			type: "message",
			ts: OTHER,
			user: "U0BOB",
			team: "T0ACME",
			text: "another thread",
			thread_ts: OTHER,
			reply_count: 1,
		});
		slack.replies[`C0GENERAL/${OTHER}`] = [
			{ type: "message", ts: "1700000301.000300", thread_ts: OTHER, user: "U0CY", team: "T0ACME", text: "r" },
		];
		const stamp = (step: number, n: number) => `${Math.floor(at(step) / 1000) + n}.000100`;
		let agent = 0;
		const settled = async (harness: Scene["harness"], now: number) => {
			for (let i = 0; i < 400; i++) {
				const watches = (await harness.snapshot(Watches, context))?.watches ?? {};
				if (NAMES.every((name) => (watches[name]?.next ?? 0) > now)) return;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error("the watches never looked");
		};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: SLACK,
			object: "slack/C0GENERAL",
			more: [
				"slack/G0DEPLOYS",
				`slack/C0GENERAL/p${ROOT_TS.replace(".", "")}`,
				"slack/search/deploy",
				"slack/user/U0BOB",
				"slack/D0BOB",
			],
			answer,
			clicks: Array.from({ length: MINUTES }, () => undefined),
			at,
			act: async (step, { harness, now }) => {
				clock = now;
				// the team talks: a message most minutes in #general, a reply in the thread now and then, and a mention once
				if (step % 2 === 0)
					slack.history.C0GENERAL?.unshift({
						type: "message",
						ts: stamp(step, 1),
						user: "U0BOB",
						team: "T0ACME",
						text: step === 30 ? "<@U0ANA> the deploy failed" : `chatter ${step}`,
					});
				if (step % 5 === 0)
					slack.replies[thread]?.push({
						type: "message",
						ts: stamp(step, 2),
						thread_ts: ROOT_TS,
						user: "U0CY",
						team: "T0ACME",
						text: `reply ${step}`,
					});
				// an agent reads another thread every third minute, through the same budget as the watches
				if (step % 3 === 0) {
					const other = await read("get_thread", { channel: "C0GENERAL", ts: OTHER, limit: 15 });
					if (!other.isError) agent++;
				}
				await settled(harness, now);
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		// each method met Slack's refusal at most once in the hour: the budget learned its limit from it
		for (const [method, refused] of Object.entries(slack.refused)) expect(refused, method).toBeLessThanOrEqual(1);
		// within Slack's limits throughout: no sixty seconds held more answered calls of a method than it allows
		for (const [method, times] of Object.entries(slack.answered)) {
			const limit = SLACK_CLAMPED[method] ?? Number.POSITIVE_INFINITY;
			for (const [i, time] of times.entries())
				expect(times.filter((other, j) => j >= i && other - time < MINUTE).length, method).toBeLessThanOrEqual(limit);
		}
		// every watch kept looking, and the agent read as Slack allowed
		const histories = (channel: string) =>
			slack.calls.filter((call) => call.method === "conversations.history" && call.params.channel === channel).length;
		expect(histories("C0GENERAL")).toBeGreaterThanOrEqual(10);
		expect(histories("G0DEPLOYS")).toBeGreaterThanOrEqual(5);
		expect(histories("D0BOB")).toBeGreaterThanOrEqual(5);
		expect(agent).toBeGreaterThanOrEqual(5);
		for (const name of NAMES) expect(summary.records[name]?.looked, name).toBeGreaterThan(at(MINUTES - 31));
		// what changed was seen: the mention woke Mara, and the thread's replies too
		const woke = summary.wakes.flatMap((wake) => wake.changes);
		expect(woke).toContain("@bob mentioned you");
		expect(woke.some((change) => change.endsWith("replied"))).toBe(true);
		// a name is looked up once: Slack's answer, or that it has none, is remembered
		expect(slack.calls.filter((call) => call.method === "users.info").length).toBeLessThanOrEqual(10);
		// what it cost Slack, for the record
		const by: Record<string, number> = {};
		for (const call of slack.calls) by[call.method] = (by[call.method] ?? 0) + 1;
		console.info(`an hour against Slack's limits: ${JSON.stringify({ requests: by, refused: slack.refused, agent })}`);
	}, 240_000);
});
