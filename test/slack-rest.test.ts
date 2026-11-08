/**
 * The Slack adapter against a fake Slack (test/fixtures/slack.ts): each read's shape, Slack's mrkdwn as plain words,
 * authors as handles with bots and other teams marked, the owner's handle, the per-(account, method) budget, and a post
 * as an approved draft on the floor.
 */
import { expect, it } from "vitest";
import { Unauthorized } from "../src/core/mcp.ts";
import { REST_APIS } from "../src/core/rest.ts";
import {
	type SlackMessage,
	slackBudget,
	slackCall,
	slackDraft,
	slackExpand,
	slackPermalink,
	slackResolve,
	slackWriteCall,
} from "../src/core/slack-rest.ts";
import { slackNotifies, slackPlain, slackTs } from "../src/core/slack-text.ts";
import { definition } from "./fixtures/shipped.ts";
import { fakeSlack, ROOT_TS } from "./fixtures/slack.ts";

/** A fake whose token no other test shares, so the adapter's per-token memory starts empty. */
let tokens = 0;
function world() {
	const slack = fakeSlack();
	slack.access = `xoxp-test-${++tokens}`;
	let clock = 1_700_000_500_000;
	const budget = slackBudget(() => clock);
	const read = async (tool: string, args: Record<string, unknown> = {}) => {
		const result = await slackCall(slack.access, tool, args, undefined, slack.fetch, budget, () => clock);
		if (result.isError) throw new Error(result.text);
		return JSON.parse(result.text) as Record<string, unknown>;
	};
	return { slack, budget, read, tick: (ms: number) => (clock += ms), now: () => clock };
}

it("names the account @user at team from auth.test alone, asked once per token", async () => {
	const { slack, read } = world();
	expect(await read("whoami")).toEqual({
		handle: "@ana at Acme",
		user: "ana",
		user_id: "U0ANA",
		team: "Acme",
		team_id: "T0ACME",
		url: "https://acme.slack.com/",
	});
	await read("whoami");
	expect(slack.calls.filter((call) => call.method === "auth.test")).toHaveLength(1);
	expect(slack.calls.some((call) => call.method === "team.info")).toBe(false);
	expect(REST_APIS.slack.account).toEqual({ tool: "whoami", field: "handle" });
});

it("reads a channel by its id, never through a list, and names a direct message by its person", async () => {
	const { slack, read } = world();
	expect(await read("get_channel", { channel: "C0GENERAL" })).toEqual({
		id: "C0GENERAL",
		name: "general",
		topic: "Company-wide",
		member_count: 12,
		private: false,
		is_member: true,
	});
	expect(await read("get_channel", { channel: "slack/G0DEPLOYS" })).toMatchObject({ name: "deploys", private: true });
	expect(await read("get_channel", { channel: "D0BOB" })).toMatchObject({ name: "@bob", private: true });
	expect(slack.calls.some((call) => call.method === "conversations.list")).toBe(false);
	await expect(read("get_channel", { channel: "C0NOPE" })).rejects.toThrow("not one the owner can see");
	await expect(read("get_channel", { channel: "general" })).rejects.toThrow("Give a channel's id");
});

it("says each message's author as a handle: the owner's own post is theirs, a bot is [bot], another team is outside", async () => {
	const { read } = world();
	const history = (await read("channel_history", { channel: "C0GENERAL" })) as {
		channel: string;
		messages: SlackMessage[];
		active: boolean;
	};
	expect(history.channel).toBe("C0GENERAL");
	const [own, bot, outside, mention, root] = history.messages;
	// the owner's post through banda carries bot_id and bot_profile, and is still the owner's
	expect(own).toMatchObject({ from: "@ana", user: "U0ANA", text: "Shipping today", mentions_me: false });
	expect(bot).toMatchObject({ from: "@deploybot [bot]", text: "Deploy finished & healthy" });
	expect(outside).toMatchObject({ from: "@olga (outside)", user: "U0OLGA" });
	expect(mention).toEqual({
		ts: "1700000100.000200",
		from: "@bob",
		user: "U0BOB",
		text: "@ana can you check #deploys? See the log (https://example.test/log)",
		date: "2023-11-14T22:15:00.000Z",
		mentions_me: true,
	});
	expect(root).toMatchObject({ ts: ROOT_TS, thread_ts: ROOT_TS, reply_count: 2 });
	expect(history.active).toBe(true);
});

it("reads a thread once per message, its first message first, even when Slack repeats it", async () => {
	const { slack, read } = world();
	slack.replies[`C0GENERAL/${ROOT_TS}`]?.unshift({ ...slack.history.C0GENERAL?.[4] });
	const thread = (await read("get_thread", { channel: "C0GENERAL", ts: `p${ROOT_TS.replace(".", "")}` })) as {
		messages: SlackMessage[];
	} & Record<string, unknown>;
	expect(thread).toMatchObject({ channel: "C0GENERAL", channel_name: "general", root: ROOT_TS, total: 3 });
	expect(thread.messages.map((each) => [each.from, each.text])).toEqual([
		["@bob", "Release notes draft"],
		["@ana", "Looks good"],
		["@bob", "Thanks @ana"],
	]);
	expect(thread.messages[2]?.mentions_me).toBe(true);
	expect(slack.calls.find((call) => call.method === "conversations.replies")?.params).toMatchObject({ ts: ROOT_TS });
});

it("searches newest first, each match with its channel and permalink, and reads a person", async () => {
	const { slack, read } = world();
	const found = (await read("search_messages", { query: "deploy" })) as {
		messages: (SlackMessage & { channel_name: string; permalink: string })[];
	} & Record<string, unknown>;
	expect(found).toMatchObject({ query: "deploy", total: 3 });
	expect(found.messages[0]).toMatchObject({
		from: "@deploybot [bot]",
		channel_id: "C0GENERAL",
		channel_name: "general",
		permalink: "https://acme.slack.com/archives/C0GENERAL/p1700000300000400",
	});
	expect(slack.calls.find((call) => call.method === "search.messages")?.params).toMatchObject({
		sort: "timestamp",
		sort_dir: "desc",
		count: "20",
	});
	expect(await read("get_person", { user: "U0BOB" })).toEqual({
		id: "U0BOB",
		name: "bob",
		real_name: "Bob Stone",
		title: "Engineer",
		tz: "America/New_York",
		status_text: "On call",
		email: "bob@acme.test",
		outside: false,
		url: "https://acme.slack.com/team/U0BOB",
	});
	expect(await read("get_person", { user: "slack/user/U0OLGA" })).toMatchObject({ outside: true });
	expect(await read("list_channels")).toMatchObject({
		channels: [
			{ id: "C0GENERAL", name: "general", private: false },
			{ id: "G0DEPLOYS", name: "deploys", private: true },
		],
	});
});

it("renders mrkdwn as plain words and says who a post will notify", () => {
	const names = (kind: "user" | "channel", id: string) =>
		({ U0BOB: "@bob", C0GENERAL: "#general" })[id as "U0BOB"] ?? (kind === "user" ? undefined : undefined);
	expect(slackPlain("*Bold* and _it_ and ~gone~ &lt;tag&gt; &amp; <!here>", names)).toBe(
		"Bold and it and gone <tag> & @here",
	);
	expect(
		slackPlain("<@U0BOB> in <#C0GENERAL> and <#C0X|ops>, <mailto:a@b.test|a@b.test>, <!subteam^S1|@devs>", names),
	).toBe("@bob in #general and #ops, a@b.test, @devs");
	expect(slackPlain("<@U0NEW>", names)).toBe("@U0NEW");
	expect(slackNotifies("<!here> hi <@U0BOB> <@U0BOB> <!channel> <!subteam^S1|@devs>", names)).toEqual([
		"@here (everyone active in the channel)",
		"@bob",
		"@channel (everyone in the channel)",
		"@devs",
	]);
	expect(slackNotifies("no one", names)).toEqual([]);
	expect(slackTs("p1700000000000100")).toBe("1700000000.000100");
	expect(slackTs("1700000000.000100")).toBe("1700000000.000100");
	expect(slackTs("p17")).toBeUndefined();
});

it("runs one call at a time per account and method, and holds the queue for Retry-After, answering in words", async () => {
	const { slack, budget, read, tick, now } = world();
	await read("whoami");
	// two reads of the same method at once: the second request leaves only after the first answered
	let inFlight = 0;
	let most = 0;
	const slow: typeof fetch = async (input, init) => {
		inFlight++;
		most = Math.max(most, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 5));
		inFlight--;
		return slack.fetch(input, init);
	};
	await Promise.all([
		slackCall(slack.access, "get_channel", { channel: "C0GENERAL" }, undefined, slow, budget),
		slackCall(slack.access, "get_channel", { channel: "G0DEPLOYS" }, undefined, slow, budget),
	]);
	expect(most).toBe(1);

	slack.busy = 30;
	const refused = await slackCall(
		slack.access,
		"channel_history",
		{ channel: "C0GENERAL" },
		undefined,
		slack.fetch,
		budget,
		now,
	);
	expect(refused.isError).toBe(true);
	const back = new Date(Math.ceil((now() + 30_000) / 60_000) * 60_000);
	const hhmm = `${String(back.getHours()).padStart(2, "0")}:${String(back.getMinutes()).padStart(2, "0")}`;
	expect(refused.text).toBe(`Slack is busy, back at ${hhmm}`);
	slack.busy = undefined;
	const asked = slack.calls.length;
	// held: answered at once, in words, with no request
	await expect(read("channel_history", { channel: "C0GENERAL" })).rejects.toThrow(`Slack is busy, back at ${hhmm}`);
	expect(slack.calls.length).toBe(asked);
	// another method of the same account is its own queue
	await expect(read("get_person", { user: "U0BOB" })).resolves.toMatchObject({ name: "bob" });
	tick(30_001);
	await expect(read("channel_history", { channel: "C0GENERAL" })).resolves.toMatchObject({ channel: "C0GENERAL" });
});

it("refuses an answer past the bound, says a missing scope, and hands a refused token to the daemon to refresh", async () => {
	const { slack } = world();
	const huge: typeof fetch = async () =>
		new Response("x".repeat(5 * 1024 * 1024), { headers: { "content-type": "application/json" } });
	const big = await slackCall("xoxp-huge", "whoami", {}, undefined, huge, slackBudget());
	expect(big).toEqual({ text: "Slack's answer was too large", isError: true });
	const scoped: typeof fetch = async () => Response.json({ ok: false, error: "missing_scope", needed: "search:read" });
	expect((await slackCall("xoxp-scope", "whoami", {}, undefined, scoped, slackBudget())).text).toBe(
		"The owner did not allow this in Slack (it needs search:read): they sign in again and allow it.",
	);
	await expect(slackCall("xoxp-stale", "whoami", {}, undefined, slack.fetch, slackBudget())).rejects.toBeInstanceOf(
		Unauthorized,
	);
});

it("posts an approved message once, as a draft on the private floor whose words name the channel", async () => {
	const { slack, budget } = world();
	const connection = definition("slack");
	expect(connection.floors.post_message).toBe("private");
	expect(connection.reads).not.toContain("post_message");
	// Slack takes no idempotency key: a crash between approval and the send asks the owner again
	expect("idempotent" in REST_APIS.slack).toBe(false);

	const planted = slackExpand("post_message", { channel: "C0GENERAL", text: "hi", _channel_name: "ceo-only" });
	expect(planted).toEqual({ channel: "C0GENERAL", text: "hi" });
	const shown = await slackResolve(
		slack.access,
		"post_message",
		{ channel: "C0GENERAL", text: "<!here> <@U0BOB> see <#G0DEPLOYS>", thread_ts: ROOT_TS },
		undefined,
		slack.fetch,
		budget,
	);
	expect(shown).toEqual({ _channel_name: "general", _names: { U0BOB: "@bob", G0DEPLOYS: "#deploys" } });
	expect(slackDraft("post_message", { ...shown, thread_ts: ROOT_TS })).toEqual({
		what: "Reply in thread in #general",
		verb: "Send",
	});
	expect(slackDraft("post_message", { _channel_name: "@bob" })?.what).toBe("Post in @bob");
	slack.channels.C0TRICK = { id: "C0TRICK", name: "ops\u200b\u0007 \u202e", is_member: true, topic: { value: "" } };
	const tricked = await slackResolve(
		slack.access,
		"post_message",
		{ channel: "C0TRICK", text: "hi" },
		undefined,
		slack.fetch,
		budget,
	);
	expect(tricked._channel_name).toBe("ops");
	await expect(
		slackResolve(slack.access, "post_message", { channel: "C0NOPE", text: "x" }, undefined, slack.fetch, budget),
	).rejects.toThrow("not one the owner can see");

	const result = await slackWriteCall(
		slack.access,
		"post_message",
		{ channel: "C0GENERAL", text: "I'll look", thread_ts: ROOT_TS, ...shown },
		undefined,
		slack.fetch,
		budget,
	);
	expect(result.isError).toBe(false);
	expect(slack.posts()).toEqual([
		{ channel: "C0GENERAL", text: "I'll look", thread_ts: ROOT_TS, ts: "1700001000.000000" },
	]);
	expect(slack.calls.find((call) => call.method === "chat.postMessage")?.params).toEqual({
		channel: "C0GENERAL",
		text: "I'll look",
		thread_ts: ROOT_TS,
	});
	expect(JSON.parse(result.text)).toEqual({
		ok: true,
		channel: "C0GENERAL",
		ts: "1700001000.000000",
		link: `https://acme.slack.com/archives/C0GENERAL/p1700001000000000?thread_ts=${ROOT_TS}&cid=C0GENERAL`,
	});
	expect(slackPermalink("https://acme.slack.com/", "C1", "1700000000.000100")).toBe(
		"https://acme.slack.com/archives/C1/p1700000000000100",
	);
});
