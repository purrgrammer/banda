import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { type Json, sort } from "../src/core/follow.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, GITHUB, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { HOSTED_DISCUSSION_COMMENTS, PATCHED_DISCUSSION_COMMENTS } from "./fixtures/github-discussion-comments.ts";
import { githubObjectTools } from "./fixtures/github-objects.ts";
import { tempHome } from "./helpers.ts";

/**
 * Whose a discussion's comments are, as two real answers of `get_discussion_comments` say it (the fixture's): the
 * hosted server's names no author, a build with the author added names each but a deleted account's. The watch's
 * account is Wolfe-Jam, who wrote comments and replies in that discussion, so its own are real ones.
 */
type Item = { [key: string]: Json };
type Comments = typeof PATCHED_DISCUSSION_COMMENTS | typeof HOSTED_DISCUSSION_COMMENTS;

const OBJECT = "https://github.com/github/github-mcp-server/discussions/1257";

/** The recorded page as it stood at a step: the comments named, each with only the replies named. */
const page = (recorded: Comments, shown: { readonly [comment: string]: readonly string[] }): Item => {
	const comments = (recorded.comments as readonly Item[])
		.filter((comment) => String(comment.id) in shown)
		.map((comment) => {
			const keep = shown[String(comment.id)] ?? [];
			const { replies, replyTotalCount: _, ...rest } = comment;
			const kept = ((replies ?? []) as Item[]).filter((reply) => keep.includes(String(reply.id)));
			return kept.length === 0 ? rest : { ...rest, replies: kept, replyTotalCount: kept.length };
		});
	return { comments, pageInfo: recorded.pageInfo, totalCount: comments.length };
};

// the recorded comments by whom (patched answer): a deleted account, hstaudacher, Wolfe-Jam (the account), trent-j
const GONE = "DC_kwDOODGMVM4A4fTc";
const GONE_TOO = "DC_kwDOODGMVM4A48iA";
const OTHER = "DC_kwDOODGMVM4A47zL";
const OWN = "DC_kwDOODGMVM4BCj5v";
const OWN_REPLY = "DC_kwDOODGMVM4BCtcF";
const OTHER_REPLY = "DC_kwDOODGMVM4BCtUW";
const OWN_REPLY_TOO = "DC_kwDOODGMVM4BDG1p";

/**
 * The discussion's life, a step at a time: the baseline holds a deleted account's comment; then another's comment;
 * then the account's own; then its own reply; then its own reply and another's in one look; then a deleted
 * account's comment.
 */
const STEPS: readonly { readonly [comment: string]: readonly string[] }[] = [
	{ [GONE]: [] },
	{ [GONE]: [], [OTHER]: [] },
	{ [GONE]: [], [OTHER]: [], [OWN]: [] },
	{ [GONE]: [], [OTHER]: [], [OWN]: [OWN_REPLY] },
	{ [GONE]: [], [OTHER]: [], [OWN]: [OWN_REPLY, OTHER_REPLY, OWN_REPLY_TOO] },
	{ [GONE]: [], [OTHER]: [], [OWN]: [OWN_REPLY, OTHER_REPLY, OWN_REPLY_TOO], [GONE_TOO]: [] },
];
const CLICKS = ["k1", "k2", "k3", "k4", "k5"];

/** GitHub as `recorded` answers the comments; `get_discussion` is a scripted mock, the same at every step. */
const answer =
	(recorded: Comments): Answer =>
	(tool, args, step) => {
		if (args.owner !== "github" || args.repo !== "github-mcp-server" || Number(args.discussionNumber) !== 1257)
			return failure("Not Found");
		if (tool === "get_discussion")
			return {
				number: 1257,
				title: "Curation for github.com/mcp",
				url: OBJECT,
				closed: false,
				isAnswered: false,
				createdAt: "2025-10-01T09:00:00Z",
				category: { name: "General" },
			};
		if (tool === "get_discussion_comments") return page(recorded, STEPS[Math.min(step, STEPS.length - 1)] ?? {});
		return failure(`no ${tool}`);
	};

/** GitHub's discussion reads, signed in as Wolfe-Jam. */
const github = async () => ({
	...GITHUB,
	account: "Wolfe-Jam",
	tools: (await githubObjectTools()).filter((tool) =>
		["get_discussion", "get_discussion_comments"].includes(tool.name),
	),
});

describe("a discussion's comments, as a server that names their author answers them", () => {
	it("the account's own comments and replies wake nothing; another's wake by name; a deleted account's say so", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: OBJECT,
			answer: answer(PATCHED_DISCUSSION_COMMENTS),
			clicks: CLICKS,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([
			["hstaudacher commented"],
			["trent-j replied"],
			["new comment (author not known)"],
		]);
		expect(summary.tells).toEqual([]);
	}, 60_000);

	it("a daemon restarted between looks wakes the same", async () => {
		const home = await tempHome();
		const options = { connection: await github(), object: OBJECT, answer: answer(PATCHED_DISCUSSION_COMMENTS) };
		const first = await watchScenario(home, new Faults(), { ...options, clicks: CLICKS.slice(0, 2) });
		expect(first.wakes.map((wake) => wake.changes)).toEqual([["hstaudacher commented"]]);
		const summary = await watchScenario(home, new Faults(), { ...options, clicks: CLICKS });
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([
			["hstaudacher commented"],
			["trent-j replied"],
			["new comment (author not known)"],
		]);
	}, 60_000);

	it("two watches on one reading each wake the same, the account's own in neither", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: OBJECT,
			answer: answer(PATCHED_DISCUSSION_COMMENTS),
			clicks: CLICKS,
			second: true,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(Object.keys(summary.versions)).toHaveLength(1);
		const by = (watch: string) => summary.wakes.filter((wake) => wake.watch === watch).map((wake) => wake.changes);
		const woke = [["hstaudacher commented"], ["trent-j replied"], ["new comment (author not known)"]];
		expect(by("banda-142")).toEqual(woke);
		expect(by("banda-142-otto")).toEqual(woke);
	}, 60_000);
});

describe("a discussion's comments, as GitHub's hosted server answers them", () => {
	it("names no author, so every comment and reply wakes saying the author is not known, the account's own too", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: OBJECT,
			answer: answer(HOSTED_DISCUSSION_COMMENTS),
			clicks: CLICKS,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([
			["new comment (author not known)"],
			["new comment (author not known)"],
			["new reply (author not known)"],
			// two replies in one look: a wake says the same words once
			["new reply (author not known)"],
			["new comment (author not known)"],
		]);
	}, 60_000);
});

describe("the discussion kind's rules over one look", () => {
	const follow = GITHUB_OBJECTS.discussion.follow as unknown as Parameters<typeof sort>[0];
	const reading = (recorded: Comments, shown: { readonly [comment: string]: readonly string[] }) => ({
		comments: page(recorded, shown),
	});
	const said = (recorded: Comments, before: (typeof STEPS)[number], after: (typeof STEPS)[number]) =>
		sort(follow, "Wolfe-Jam", reading(recorded, before), reading(recorded, after))
			.filter((each) => each.does !== "nothing")
			.map((each) => [each.does, each.says]);

	it("a mixed look wakes for another's reply alone, the account's own beside it sorted to nothing", () => {
		expect(said(PATCHED_DISCUSSION_COMMENTS, STEPS[3]!, STEPS[4]!)).toEqual([["wake", "trent-j replied"]]);
		expect(
			sort(
				follow,
				"Wolfe-Jam",
				reading(PATCHED_DISCUSSION_COMMENTS, STEPS[3]!),
				reading(PATCHED_DISCUSSION_COMMENTS, STEPS[4]!),
			).map((each) => each.does),
		).toEqual(["wake", "nothing"]);
	});

	it("the account's own comment and reply are nothing; another account's would wake", () => {
		const [, other, comment, reply] = STEPS as [
			unknown,
			(typeof STEPS)[number],
			(typeof STEPS)[number],
			(typeof STEPS)[number],
		];
		expect(said(PATCHED_DISCUSSION_COMMENTS, other, comment)).toEqual([]);
		expect(said(PATCHED_DISCUSSION_COMMENTS, comment, reply)).toEqual([]);
		const as = (me: string, before: (typeof STEPS)[number], after: (typeof STEPS)[number]) =>
			sort(follow, me, reading(PATCHED_DISCUSSION_COMMENTS, before), reading(PATCHED_DISCUSSION_COMMENTS, after)).map(
				(each) => [each.does, each.says],
			);
		expect(as("hstaudacher", other, comment)).toEqual([["wake", "Wolfe-Jam commented"]]);
		expect(as("hstaudacher", comment, reply)).toEqual([["wake", "Wolfe-Jam replied"]]);
	});

	it("an author left out, or null, is not known: never taken for the account's", () => {
		const nulled = (shown: (typeof STEPS)[number]) => {
			const answered = page(PATCHED_DISCUSSION_COMMENTS, shown);
			return {
				comments: { ...answered, comments: (answered.comments as Item[]).map((c) => ({ ...c, author: null })) },
			};
		};
		expect(
			sort(follow, "Wolfe-Jam", nulled(STEPS[1]!), nulled(STEPS[2]!)).map((each) => [each.does, each.says]),
		).toEqual([["wake", "new comment (author not known)"]]);
		expect(said(HOSTED_DISCUSSION_COMMENTS, STEPS[1]!, STEPS[2]!)).toEqual([
			["wake", "new comment (author not known)"],
		]);
	});
});
