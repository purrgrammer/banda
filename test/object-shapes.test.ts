import fc from "fast-check";
import { expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { cardOf, draftedOn, parseObjects, plainLine, readArgs, recognise, refKey } from "../src/core/objects.ts";
import { objects } from "../src/core/parts/objects.ts";
import { githubObjectTools } from "./fixtures/github-objects.ts";
import { definition } from "./fixtures/shipped.ts";
import { pbtRuns } from "./pbt.ts";

const github = { name: "github", objects: GITHUB_OBJECTS };
const ref = { connection: "github", kind: "pull_request", values: { owner: "acme", repo: "banda", number: "34" } };
it("accepts curated data, rejects reads that can write and unbounded overlapping template grammar", () => {
	expect(parseObjects(GITHUB_OBJECTS, () => true)).toHaveProperty("objects");
	expect(parseObjects(GITHUB_OBJECTS, () => false)).toHaveProperty("errors");
	for (const shape of [
		`${[..."abcdefghij"].map((c) => `{${c}}`).join("-")}/end`,
		"{a}*",
		"*-{a}",
		"{a}.{b}",
		"**/{a}",
	]) {
		const parsed = parseObjects(
			{
				issue: {
					...GITHUB_OBJECTS.issue,
					urls: [],
					ids: [shape],
					normalize: {},
					name: "Issue",
					writes: [],
					reads: { issue: { tool: "get", args: {} } },
				},
			},
			() => true,
		);
		expect(parsed, shape).toHaveProperty("errors");
	}
	// The parent's 185-character nonmatch cannot reach a backtracking regex after parsing.
	const safe = parseObjects(
		{
			issue: {
				...GITHUB_OBJECTS.issue,
				urls: [],
				ids: ["{a}/{b}/end"],
				normalize: {},
				name: "Issue",
				writes: [],
				creates: [],
				reads: { issue: { tool: "get", args: {} } },
			},
		},
		() => true,
	);
	expect(safe).toHaveProperty("objects");
	if ("objects" in safe)
		expect(recognise(`${"a-".repeat(90)}wrong`, [{ name: "example", objects: safe.objects }])).toEqual([]);
});
it("a read's argument may be a list of words, the fields a list read asks for; nothing else that is not a scalar", () => {
	const withArgs = (args: unknown) =>
		parseObjects({ issue: { ...GITHUB_OBJECTS.issue, reads: { issue: { tool: "issue_read", args } } } }, () => true);
	const parsed = withArgs({ owner: "{owner}", fields: ["number", "user", "created_at"] });
	expect(parsed).toHaveProperty("objects");
	if ("objects" in parsed) {
		const found = recognise("https://github.com/acme/banda/issues/12", [
			{ name: "github", objects: parsed.objects },
		])[0]!;
		expect(readArgs(parsed.objects.issue!.reads.issue!, found, undefined)).toEqual({
			owner: "acme",
			fields: ["number", "user", "created_at"],
		});
	}
	for (const fields of [["{owner}"], [1], [["a"]], { a: "b" }, Array.from({ length: 33 }, () => "a"), ["a b"]])
		expect(withArgs({ fields }), JSON.stringify(fields)).toHaveProperty("errors");
});
it("validates identity metadata and leaves other providers' identities case-sensitive by default", () => {
	for (const normalize of [
		null,
		[],
		"lowercase",
		{ absent: "integer" },
		{ owner: "anything" },
		{ owner: null },
		JSON.parse('{"__proto__":"lowercase"}'),
	])
		expect(parseObjects({ issue: { ...GITHUB_OBJECTS.issue, normalize } }, () => true)).toHaveProperty("errors");
	const parsed = parseObjects({ issue: { ...GITHUB_OBJECTS.issue, normalize: {} } }, () => true);
	if (!("objects" in parsed)) throw new Error("invalid test definition");
	const found = recognise("https://github.com/Owner/Repo/issues/001", [{ name: "other", objects: parsed.objects }])[0]!;
	expect(found.values).toEqual({ owner: "Owner", repo: "Repo", number: "001" });
	expect(refKey(found, parsed.objects)).toBe("other:issue:Owner/Repo#001");
});
it("malformed object data never throws during parsing", () => {
	fc.assert(
		fc.property(fc.jsonValue(), (value) => {
			expect(() => parseObjects(value, () => true)).not.toThrow();
		}),
		{ numRuns: pbtRuns(100) },
	);
	fc.assert(
		fc.property(fc.jsonValue(), fc.string({ maxLength: 300 }), (normalize, shape) => {
			expect(() =>
				parseObjects({ issue: { ...GITHUB_OBJECTS.issue, normalize, urls: [], ids: [shape] } }, () => true),
			).not.toThrow();
		}),
		{ numRuns: pbtRuns(100) },
	);
	for (const write of [null, 1, "a", false, []])
		expect(() => parseObjects({ issue: { ...GITHUB_OBJECTS.issue, writes: [write] } }, () => true)).not.toThrow();
});
it("maps numeric PR/issue IDs but preserves string Actions/notification IDs against upstream input schemas", async () => {
	const tools = await githubObjectTools();
	for (const [reference, kind, expected] of [
		["https://github.com/acme/banda/pull/34/files?x=1", "pull_request", { pullNumber: 34 }],
		["https://github.com/acme/banda/issues/12#comment", "issue", { issue_number: 12 }],
		["https://github.com/acme/banda/actions/runs/9/job/201", "check_run", { resource_id: "201" }],
		["notification/7", "notification", { notificationID: "7" }],
	] as const) {
		const found = recognise(reference, [github])[0];
		expect(found?.kind).toBe(kind);
		if (found === undefined) throw new Error("no ref");
		const read = Object.values(GITHUB_OBJECTS[kind].reads)[0]!;
		expect(readArgs(read, found, tools.find((t) => t.name === read.tool)?.inputSchema as never)).toMatchObject(
			expected,
		);
		expect(recognise(refKey(found, GITHUB_OBJECTS), [github])).toContainEqual(found);
	}
	expect(recognise("https://api.github.com/repos/acme/banda/check-runs/201", [github])).toEqual([]);
	expect(recognise("https://github.com.evil/acme/banda/pull/34", [github])).toEqual([]);
});
it("recognises the object a browser opens, not the raw path before URL normalisation", () => {
	for (const path of ["pull/34/../../issues/35", "pull/34/%2e%2e/.%2E/issues/35", "pull/34/..\\..\\issues/35"]) {
		const url = `https://github.com/o/r/${path}`;
		expect(new URL(url).pathname).toBe("/o/r/issues/35");
		expect(recognise(url, [github])).toEqual([
			{ connection: "github", kind: "issue", values: { owner: "o", repo: "r", number: "35" } },
		]);
	}
	for (const url of [
		"https://name:secret@github.com/o/r/pull/34",
		"https://github.com@evil.test/o/r/pull/34",
		"https://github.com/o/r/pull/34/../../../../elsewhere",
	])
		expect(recognise(url, [github])).toEqual([]);
});
it("a URL names its object with a tab, a query or a fragment after it, never a deeper path", () => {
	for (const url of [
		"https://github.com/o/r/pull/34",
		"https://github.com/o/r/pull/34/",
		"https://github.com/o/r/pull/34/files",
		"https://github.com/o/r/pull/34/files/?w=1#diff",
		"https://github.com/o/r/pull/34#issuecomment-1",
	])
		expect(
			recognise(url, [github]).map((r) => r.kind),
			url,
		).toEqual(["pull_request"]);
	// a commit of a pull request, a path below a tab: something inside it, not the object
	for (const url of ["https://github.com/o/r/pull/34/commits/a1b2c3", "https://github.com/o/r/pull/34/files/a/b"])
		expect(recognise(url, [github]), url).toEqual([]);
});
it("URL recognition is invariant under browser parsing for generated dot segments and separators", () => {
	fc.assert(
		fc.property(
			fc.array(fc.constantFrom("pull", "issues", "34", "35", ".", "..", "%2e", "%2e%2e", ".%2E", "%2E."), {
				maxLength: 12,
			}),
			fc.constantFrom("/", "\\"),
			(parts, separator) => {
				const input = `HTTPS://GITHUB.COM/o/r/${parts.join(separator)}`;
				expect(recognise(input, [github])).toEqual(recognise(new URL(input).href, [github]));
			},
		),
		{ numRuns: pbtRuns(100) },
	);
});
it("unifies GitHub web, API, shorthand, canonical and draft identities without numeric rounding", () => {
	for (const alias of [
		"HTTPS://GITHUB.COM/ACME/Banda/pull/00034/files",
		"https://api.github.com/repos/ACME/BANDA/pulls/034",
		"ACME/Banda#00034",
		"github:pull_request:ACME/Banda#034",
	]) {
		const found = recognise(alias, [github]).find((r) => r.kind === "pull_request");
		expect(found, alias).toEqual(ref);
		expect(refKey(found!, GITHUB_OBJECTS)).toBe("github:pull_request:acme/banda#34");
	}
	expect(refKey({ ...ref, values: { owner: "ACME", repo: "Banda", number: "034" } }, GITHUB_OBJECTS)).toBe(
		"github:pull_request:acme/banda#34",
	);
	expect(
		draftedOn("github", "merge_pull_request", { owner: "ACME", repo: "Banda", pullNumber: "034" }, GITHUB_OBJECTS)
			?.refs,
	).toEqual([ref]);
	for (const [alias, key] of [
		["https://github.com/O/R/actions/runs/001/job/000201", "github:check_run:o/r/actions/jobs/201"],
		["https://api.github.com/repos/O/R/actions/jobs/0201", "github:check_run:o/r/actions/jobs/201"],
		["github:check_run:O/R/actions/jobs/0201", "github:check_run:o/r/actions/jobs/201"],
		["notification/0009007199254740993", "github:notification:notification/9007199254740993"],
	])
		expect(refKey(recognise(alias!, [github])[0]!, GITHUB_OBJECTS)).toBe(key);
	for (const id of ["abc", "1.5", "-1", "000"])
		expect(recognise(`https://github.com/o/r/pull/${id}`, [github])).toEqual([]);
});
it("malformed nonempty reviews stay unavailable; only known absence says None yet", () => {
	const reviewsOf = (reviews: unknown) => cardOf(GITHUB_OBJECTS.pull_request, ref, { pr: { title: "Work" }, reviews });
	for (const reviews of [
		[{}],
		[null],
		[{ user: { login: "ana" }, state: "NEW_STATE" }],
		[{ state: "APPROVED" }],
		[{ user: { login: "ana" }, state: "APPROVED" }, {}],
	])
		expect(reviewsOf(reviews)).toMatchObject({ reviews: "Reviews unavailable" });
	for (const reviews of [
		[],
		[{ user: { login: "ana" }, state: "PENDING" }],
		[{ user: { login: "ana" }, state: "DISMISSED" }],
	])
		expect(reviewsOf(reviews)).toMatchObject({ reviews: "None yet" });
});
it("rejects absent primary data and preserves unavailable, incomplete and skipped information", () => {
	for (const bad of [{}, null, { error: "no" }, { pull_request: { title: "not a flat payload" } }])
		expect(() => cardOf(GITHUB_OBJECTS.pull_request, ref, { pr: bad })).toThrow();
	const primary = { title: "Work", state: "open", number: 34 };
	expect(cardOf(GITHUB_OBJECTS.pull_request, ref, { pr: primary })).toMatchObject({
		checks: null,
		added: null,
		removed: null,
		reviews: "Reviews unavailable",
	});
	expect(
		cardOf(GITHUB_OBJECTS.pull_request, ref, {
			pr: primary,
			checks: { total_count: 3, check_runs: [{ status: "completed", conclusion: "success" }] },
			reviews: Array.from({ length: 100 }, () => ({ user: { login: "ana" }, state: "APPROVED" })),
		}),
	).toMatchObject({ checks: null, reviews: "Reviews incomplete" });
	for (const conclusion of ["skipped", "neutral", "cancelled", "new_unknown_value"]) {
		expect(
			cardOf(
				GITHUB_OBJECTS.check_run,
				{ ...ref, kind: "check_run" },
				{ job: { name: "Build", status: "completed", conclusion } },
			),
		).toMatchObject({ state: conclusion === "new_unknown_value" ? "unknown" : conclusion });
	}
	// a skipped or neutral run counts for nothing, as GitHub counts it, and leaves the summary whole; a cancelled one
	// did not pass; only a conclusion banda has no word for leaves the summary unsaid
	const summary = (...conclusions: string[]) =>
		cardOf(GITHUB_OBJECTS.pull_request, ref, {
			pr: primary,
			checks: {
				total_count: conclusions.length,
				check_runs: conclusions.map((conclusion) => ({ status: "completed", conclusion })),
			},
		});
	expect(summary("skipped")).toMatchObject({ checks: { passed: 0, failed: 0, running: 0 } });
	expect(summary("success", "skipped", "neutral", "success")).toMatchObject({
		checks: { passed: 2, failed: 0, running: 0 },
	});
	expect(summary("success", "cancelled")).toMatchObject({ checks: { passed: 1, failed: 1, running: 0 } });
	expect(summary("success", "new_unknown_value")).toMatchObject({ checks: null });
});
it("draft data names exact effect verbs and editable fields, never caller card prose", () => {
	expect(
		draftedOn(
			"github",
			"add_issue_comment",
			{ owner: "acme", repo: "banda", issue_number: 34, body: "send this" },
			GITHUB_OBJECTS,
		),
	).toMatchObject({ verb: "Comment", what: "Comment on", text: "body", refs: [ref, { ...ref, kind: "issue" }] });
	expect(
		draftedOn("github", "merge_pull_request", { owner: "acme", repo: "banda", pullNumber: 34 }, GITHUB_OBJECTS),
	).toMatchObject({ verb: "Merge" });
	expect(
		draftedOn(
			"github",
			"issue_write",
			{ owner: "acme", repo: "banda", issue_number: 34, state: "closed", state_reason: "not_planned" },
			GITHUB_OBJECTS,
		),
	).toMatchObject({ verb: "Close", what: "Close as not planned" });
	expect(objects.refuse?.({ objects: ["a/b#1", "a/b#2", "a/b#3", "a/b#4"] })).toMatch(/at most/);
	expect(plainLine("hello\u202e\nworld")).toBe("hello world");
});

/** A kind named by words: a mail search, by its query. */
const SEARCH = {
	search: {
		card: "email",
		normalize: { query: "text" },
		name: "mail matching {query}",
		urls: ["https://mail.google.com/mail/u/*/#search/{query}"],
		ids: ["mail/search/{query}"],
		reads: { found: { tool: "search", args: { query: "{query}", max_results: 25 } } },
		fields: { subject: "found.subject" },
	},
};

it("a text placeholder names an object by words: encoded in its ids and URLs, said decoded", () => {
	const parsed = parseObjects(SEARCH, () => true);
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	const mail = { name: "mail", objects: parsed.objects };
	const query = { connection: "mail", kind: "search", values: { query: "from:boss is:unread" } };
	// a browser's address, an id with its words encoded, as written, or the ref's own key: one search
	for (const text of [
		"https://mail.google.com/mail/u/0/#search/from%3Aboss+is%3Aunread",
		"mail/search/from%3Aboss%20is%3Aunread",
		"mail/search/from:boss is:unread",
		"mail/search/from:boss   is:unread",
		"mail:search:mail/search/from%3Aboss%20is%3Aunread",
	])
		expect(recognise(text, [mail])).toEqual([query]);
	expect(refKey(query, parsed.objects)).toBe("mail:search:mail/search/from%3Aboss%20is%3Aunread");
	expect(recognise(refKey(query, parsed.objects), [mail])).toEqual([query]);
	expect(readArgs(parsed.objects.search!.reads.found!, query, undefined)).toEqual({
		query: "from:boss is:unread",
		max_results: 25,
	});
	// a literal plus is %2B; a bad escape, a control character or nothing at all names nothing
	expect(recognise("mail/search/a%2Bb", [mail])[0]?.values.query).toBe("a+b");
	for (const text of [
		"mail/search/%E0%A4%A",
		"mail/search/a%00b",
		"mail/search/",
		"mail/search/a/b",
		"mail/search/a?b",
	])
		expect(recognise(text, [mail])).toEqual([]);
});

it("words go last in a template: only its end tells where they stop", () => {
	const parsed = parseObjects({ search: { ...SEARCH.search, urls: [], ids: ["mail/search/{query}/x"] } }, () => true);
	expect("errors" in parsed ? parsed.errors : []).toContainEqual(expect.stringContaining("must end with {query}"));
	const rule = parseObjects({ search: { ...SEARCH.search, normalize: { query: "words" } } }, () => true);
	expect("errors" in rule ? rule.errors : []).toContainEqual(
		expect.stringContaining("lowercase, integer, text or slack-ts"),
	);
});

it("any words survive a round trip through a ref's key", () => {
	const parsed = parseObjects(SEARCH, () => true);
	if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
	const mail = { name: "mail", objects: parsed.objects };
	fc.assert(
		fc.property(fc.string({ minLength: 1, maxLength: 40, unit: "binary" }), (words) => {
			const query = words.replace(/\s+/g, " ").trim();
			fc.pre(query !== "" && !/[\p{Cc}\p{Cf}]/u.test(query) && encodeURIComponent(query).length < 450);
			const ref = { connection: "mail", kind: "search", values: { query } };
			expect(recognise(refKey(ref, parsed.objects), [mail])).toEqual([ref]);
		}),
		{ numRuns: pbtRuns(100) },
	);
});

function slackKinds() {
	return definition("slack").objects ?? {};
}

it("names a Slack thread by its link, a reply's link or its id, one object, its p-digits read as Slack's timestamp", () => {
	const kinds = slackKinds();
	const slack = { name: "slack", objects: kinds };
	const thread = { connection: "slack", kind: "thread", values: { channel: "C0GENERAL", ts: "1700000000.000100" } };
	for (const name of [
		"https://acme.slack.com/archives/C0GENERAL/p1700000000000100",
		"https://acme.slack.com/archives/C0GENERAL/p1700000500000900?thread_ts=1700000000.000100&cid=C0GENERAL",
		"slack/C0GENERAL/p1700000000000100",
		"slack/C0GENERAL/p1700000000.000100",
	])
		expect(recognise(name, [slack])[0], name).toEqual(thread);
	expect(refKey(thread, kinds)).toBe("slack:thread:slack/C0GENERAL/p1700000000.000100");
	expect(recognise(refKey(thread, kinds), [slack])).toEqual([thread]);
	// a thread's link is first a thread; drawn as its channel only when the thread cannot be read
	expect(recognise("https://acme.slack.com/archives/C0GENERAL/p1700000000000100", [slack]).map((r) => r.kind)).toEqual([
		"thread",
		"channel",
	]);
	const channel = { connection: "slack", kind: "channel", values: { channel: "C0GENERAL" } };
	expect(recognise("https://acme.slack.com/archives/C0GENERAL", [slack])).toEqual([channel]);
	expect(recognise("slack/C0GENERAL", [slack])).toEqual([channel]);
	expect(recognise(refKey(channel, kinds), [slack])).toEqual([channel]);
	const person = { connection: "slack", kind: "person", values: { user: "U0BOB" } };
	expect(recognise("https://acme.slack.com/team/U0BOB", [slack])).toEqual([person]);
	expect(recognise("slack/user/U0BOB", [slack])).toEqual([person]);
	const search = recognise("slack/search/from:@bob failed", [slack]);
	expect(search).toEqual([{ connection: "slack", kind: "search", values: { query: "from:@bob failed" } }]);
	expect(recognise(refKey(search[0]!, kinds), [slack])).toEqual(search);
	for (const lookalike of [
		"https://acme.slack.com.evil.test/archives/C0GENERAL",
		"https://slack.com.evil/archives/C0GENERAL",
		"http://acme.slack.com/archives/C0GENERAL",
	])
		expect(recognise(lookalike, [slack]), lookalike).toEqual([]);
	expect(recognise("https://acme.slack.com/archives/C0GENERAL/pnot-a-ts", [slack]).map((r) => r.kind)).toEqual([
		"channel",
	]);
	// a post names the thread it replies in, else the channel, and says so in the owner's words
	expect(
		draftedOn("slack", "post_message", { channel: "C0GENERAL", text: "x", thread_ts: "1700000000.000100" }, kinds),
	).toMatchObject({ refs: [thread, channel], verb: "Send", what: "Reply in", text: "text" });
	expect(draftedOn("slack", "post_message", { channel: "C0GENERAL", text: "x" }, kinds)).toMatchObject({
		refs: [channel],
		what: "Post in",
	});
});

it("draws Slack's thread, channel, search and person from the adapter's readings", () => {
	const kinds = slackKinds();
	const message = (ts: string, from: string, text: string, avatar?: string) => ({
		ts,
		from,
		user: "U0",
		text,
		date: "2023-11-14T22:13:20.000Z",
		mentions_me: false,
		...(avatar === undefined ? {} : { avatar }),
	});
	const thread = cardOf(
		kinds.thread!,
		{ connection: "slack", kind: "thread", values: { channel: "C0GENERAL", ts: "1700000000.000100" } },
		{
			thread: {
				channel: "C0GENERAL",
				channel_name: "general",
				root: "1700000000.000100",
				messages: [
					message("1700000000.000100", "@bob", "Release notes", "https://avatars.slack-edge.com/bob_48.png"),
					// a face off Slack's image host is never drawn, whatever the reading says
					message("1700000150.000150", "@deploybot [bot]", "Deploy\u0007 done", "https://evil.test/bot.png"),
				],
				total: 2,
				url: "https://acme.slack.com/archives/C0GENERAL/p1700000000000100",
			},
		},
		"slack",
	);
	expect(thread).toEqual({
		card: "messages",
		title: "Release notes",
		search: false,
		messages: [
			{
				id: "1700000150.000150",
				from: "@deploybot [bot]",
				subject: "",
				date: "2023-11-14T22:13:20.000Z",
				text: "Deploy done",
			},
			{
				id: "1700000000.000100",
				from: "@bob",
				subject: "",
				date: "2023-11-14T22:13:20.000Z",
				text: "Release notes",
				avatar: "https://avatars.slack-edge.com/bob_48.png",
			},
		],
		total: 2,
		url: "https://acme.slack.com/archives/C0GENERAL/p1700000000000100",
		service: "slack",
		place: "thread",
		channel: "#general",
	});
	// a long thread's card still opens with its first message, and a message keeps its lines (quotes are lines)
	const replies = [1, 2, 3, 4, 5, 6].map((n) => message(`170000000${n}.000200`, "@ana", `reply ${n}`));
	const long = cardOf(
		kinds.thread!,
		{ connection: "slack", kind: "thread", values: { channel: "C0GENERAL", root: "1700000000.000100" } },
		{
			thread: {
				channel: "C0GENERAL",
				channel_name: "general",
				root: "1700000000.000100",
				messages: [message("1700000000.000100", "@bob", "> quoted\nanswer"), ...replies],
				total: 7,
			},
		},
		"slack",
	) as { messages: { id: string; text: string }[] };
	expect(long.messages.map((each) => each.id)).toEqual([
		"1700000006.000200",
		"1700000005.000200",
		"1700000004.000200",
		"1700000003.000200",
		"1700000000.000100",
	]);
	expect(long.messages.at(-1)?.text).toBe("> quoted\nanswer");
	const dm = cardOf(
		kinds.channel!,
		{ connection: "slack", kind: "channel", values: { channel: "D0BOB" } },
		{
			channel: { id: "D0BOB", name: "@bob", topic: "", member_count: null, private: true, is_member: true },
			history: { channel: "D0BOB", messages: [], url: "https://evil.test/archives/D0BOB" },
		},
		"slack",
	);
	expect(dm).toEqual({
		card: "messages",
		title: "@bob",
		search: false,
		messages: [],
		total: null,
		service: "slack",
		place: "channel",
		topic: "",
		members: null,
	});
	const search = cardOf(
		kinds.search!,
		{ connection: "slack", kind: "search", values: { query: "in:#deploys failed" } },
		{
			search: {
				query: "in:#deploys failed",
				messages: [message("1700000300.000400", "@ana", "failed again")],
				total: 9,
			},
		},
		"slack",
	);
	expect(search).toMatchObject({
		card: "messages",
		title: "in:#deploys failed",
		search: true,
		total: 9,
		service: "slack",
	});
	const person = cardOf(
		kinds.person!,
		{ connection: "slack", kind: "person", values: { user: "U0OLGA" } },
		{
			person: {
				id: "U0OLGA",
				name: "olga",
				real_name: "Olga Ivanova",
				title: "Partner",
				tz: "Europe/Berlin",
				status_text: "Away",
				outside: true,
				url: "https://acme.slack.com/team/U0OLGA",
				avatar: "https://avatars.slack-edge.com/olga_72.png",
			},
		},
		"slack",
	);
	expect(person).toEqual({
		card: "contact",
		name: "Olga Ivanova",
		emails: "",
		phones: "",
		organization: "",
		title: "Partner",
		other: false,
		photo: "https://avatars.slack-edge.com/olga_72.png",
		url: "https://acme.slack.com/team/U0OLGA",
		service: "slack",
		handle: "@olga",
		status: "Away",
		timezone: "Europe/Berlin",
		outside: true,
	});
});
