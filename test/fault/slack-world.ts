/**
 * Slack as a watch reads it, for the scenario harness (`watch-scenario.ts`): a channel and a thread whose messages each
 * step of the world says, answered as banda's Slack reads answer them (authors in the account's form, `mentions_me`),
 * a page at a time as Slack pages them: history newest first, a thread's replies oldest first after its first message,
 * which comes on every page; `oldest` and `cursor` honoured, at most `pageMax` messages a page.
 */
import { readFileSync } from "node:fs";
import type { Json } from "../../src/core/follow.ts";
import { REST_APIS } from "../../src/core/rest.ts";
import {
	type Answer,
	failure,
	NOW,
	type ScenarioConnection,
	type ScenarioOptions,
	type WatchSummary,
	watchInvariants,
} from "./watch-scenario.ts";

export const ME = "@ana at Acme";
export const CHANNEL = "C0GENERAL";
export const ROOT = "1700000000.000100";

/** Slack as banda ships it, signed in as @ana at Acme. */
export const SLACK: ScenarioConnection = {
	name: "slack",
	file: readFileSync(new URL("../../shipped/connections/slack.json", import.meta.url), "utf8"),
	tools: REST_APIS.slack.tools,
	account: ME,
};

export type Said = { [key: string]: Json };

/** A message, as banda's read says it: by `author` (`@bob at Acme`, `@deploybot [bot]`), at second `n` past the root. */
export const said = (n: number, author: string, text: string, mentions = false): Said => {
	const ts = `${1700000000 + n}.000100`;
	return {
		ts,
		from: author.replace(/ at .*$/, ""),
		author,
		user: `U${author.replace(/[^a-z]/g, "").toUpperCase()}`,
		text,
		date: new Date((1700000000 + n) * 1000).toISOString(),
		mentions_me: mentions,
	};
};

/** What the channel and the thread hold at a step, and a read that fails there instead (Slack busy). */
export type SlackStep = {
	readonly channel?: readonly Said[];
	readonly replies?: readonly Said[];
	readonly topic?: string;
	readonly busy?: string;
	/** What a search finds, each with its `channel_name` and `permalink` (`match`). */
	readonly search?: readonly Said[];
	/** Who `slack/user/U0BOB` is, as `get_person` says. */
	readonly person?: Said;
};

/** A search's match, as banda's read says it: a message with its channel's name and its own link. */
export const match = (n: number, author: string, text: string, channel = "deploys"): Said => ({
	...said(n, author, text),
	channel_id: `C0${channel.toUpperCase()}`,
	channel_name: channel,
	permalink: `https://acme.slack.com/archives/C0${channel.toUpperCase()}/p${1700000000 + n}000100`,
});

const later = (a: Json | undefined, b: Json | undefined) => Number(a) > Number(b);

/** One page of `messages` as `args` ask: after `oldest`, from `cursor`, at most `pageMax`; and the next cursor. */
function page(messages: readonly Said[], args: { readonly [key: string]: unknown }, pageMax: number) {
	const after = messages.filter((each) => args.oldest === undefined || later(each.ts, args.oldest as Json));
	const limit = Math.min(typeof args.limit === "number" ? args.limit : 100, pageMax);
	const from = typeof args.cursor === "string" ? Number(/^c(\d+)$/.exec(args.cursor)?.[1] ?? 0) : 0;
	const next: Said = from + limit < after.length ? { next_cursor: `c${from + limit}` } : {};
	return { items: after.slice(from, from + limit), next };
}

/** The thread's first message. */
export const PARENT = said(0, "@bob at Acme", "Release notes draft");

/** Slack's reads at each step of `world`, each read counted in `asked` (its tool and the page it asked for). */
export function slackWorld(
	world: (step: number) => SlackStep,
	pageMax = 15,
	asked: { tool: string; oldest?: unknown; cursor?: unknown }[] = [],
): Answer {
	return (tool, args, step): ReturnType<Answer> => {
		const at = world(step);
		asked.push({ tool, oldest: args.oldest, cursor: args.cursor });
		if (at.busy !== undefined && (tool === "channel_history" || tool === "get_thread")) return failure(at.busy);
		const newestFirst = [...(at.channel ?? [])].sort((a, b) => (later(a.ts, b.ts) ? -1 : 1));
		const active = newestFirst.some((each) => NOW - Number(each.ts) * 1000 < 10 * 60_000);
		if (tool === "search_messages") {
			const found = [...(at.search ?? [])].sort((a, b) => (later(a.ts, b.ts) ? -1 : 1));
			return { query: String(args.query), messages: found, total: found.length };
		}
		if (tool === "get_person" && args.user === "U0BOB" && at.person !== undefined) return at.person;
		if (tool === "get_channel" && args.channel === CHANNEL)
			return { id: CHANNEL, name: "general", topic: at.topic ?? "", member_count: 12, private: false, is_member: true };
		if (tool === "channel_history" && args.channel === CHANNEL) {
			const { items, next } = page(newestFirst, args, pageMax);
			return { channel: CHANNEL, messages: items, active, url: `https://acme.slack.com/archives/${CHANNEL}`, ...next };
		}
		if (tool === "get_thread" && args.channel === CHANNEL && args.ts === ROOT) {
			const replies = [...(at.replies ?? [])].sort((a, b) => (later(a.ts, b.ts) ? 1 : -1));
			const { items, next } = page(replies, args, pageMax);
			return {
				channel: CHANNEL,
				channel_name: "general",
				root: ROOT,
				messages: [PARENT, ...items],
				total: replies.length + 1,
				active: false,
				url: `https://acme.slack.com/archives/${CHANNEL}/p${ROOT.replace(".", "")}`,
				...next,
			};
		}
		return failure(`no ${tool}`);
	};
}

const before = Array.from({ length: 5 }, (_, n) => said(10 + n, "@bob at Acme", `earlier ${n}`));
const burst = Array.from({ length: 40 }, (_, n) =>
	n === 20 ? said(100 + n, "@cy at Acme", "<@U0ANA> can you look?", true) : said(100 + n, "@cy at Acme", `burst ${n}`),
);

/** What must hold of a followed Slack object however the process was killed: the invariants, and every run ended. */
const slackProblems =
	(more: (summary: WatchSummary, say: (what: string, ok: boolean) => void) => void) =>
	(summary: WatchSummary): string[] => {
		const errors = watchInvariants(summary);
		const say = (what: string, ok: boolean) => {
			if (!ok) errors.push(what);
		};
		more(summary, say);
		say("no walk of pages is left held", summary.record.pages === undefined);
		say("it looks", summary.record.failed === undefined);
		for (const turn of summary.turns) say("a run ended", turn?.status === "completed");
		say("nothing is parked", summary.parked.length === 0);
		return errors;
	};

/**
 * The Slack scenarios the watch fault worker runs by name: a channel's burst of forty walked in three pages of fifteen
 * (a kill at a page's fetch, at the commit that holds the walk, and at the merge and its wake), and a thread's reply
 * beside the owner's own.
 */
export const SLACK_SCENARIOS: {
	readonly [name: string]: {
		readonly options: ScenarioOptions;
		readonly problems: (summary: WatchSummary) => string[];
	};
} = {
	"slack-burst": {
		options: {
			connection: SLACK,
			object: `slack/${CHANNEL}`,
			answer: slackWorld((step) => ({ channel: step >= 1 ? [...before, ...burst] : before })),
			clicks: ["k1", "k2", "k3"],
		},
		problems: slackProblems((summary, say) => {
			say(`one wake, got ${summary.wakes.length}`, summary.wakes.length === 1);
			say("the wake names the mention", summary.wakes[0]?.changes.includes("@cy mentioned you") === true);
			say("the wake has no gap", summary.wakes[0]?.gap === undefined);
			say("no tell beside the wake", summary.tells.length === 0);
		}),
	},
	"slack-thread": {
		options: {
			connection: SLACK,
			object: `slack/${CHANNEL}/p${ROOT.replace(".", "")}`,
			answer: slackWorld((step) => ({
				replies: [
					said(5, "@cy at Acme", "first look"),
					...(step >= 1 ? [said(20, ME, "I'll look today")] : []),
					...(step >= 2 ? [said(30, "@bob at Acme", "any news?")] : []),
				],
			})),
			clicks: ["k1", "k2"],
		},
		problems: slackProblems((summary, say) => {
			const words = summary.wakes.map((wake) => wake.changes.join(", "));
			say(
				`one wake, for bob's reply: ${words.join(" | ")}`,
				JSON.stringify(words) === JSON.stringify(["@bob replied"]),
			);
			say("no tell", summary.tells.length === 0);
		}),
	},
};
