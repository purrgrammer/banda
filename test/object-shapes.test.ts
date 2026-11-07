import fc from "fast-check";
import { expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import {
	cardOf,
	draftedOn,
	grainsOf,
	grainWords,
	parseObjects,
	plainLine,
	readArgs,
	recognise,
	refKey,
} from "../src/core/objects.ts";
import { objects } from "../src/core/parts/objects.ts";
import { githubObjectTools } from "./fixtures/github-objects.ts";
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
				place: undefined,
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
	expect(
		cardOf(GITHUB_OBJECTS.pull_request, ref, {
			pr: primary,
			checks: { total_count: 1, check_runs: [{ status: "completed", conclusion: "skipped" }] },
		}),
	).toMatchObject({ checks: null });
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

it("a kind's place names only its name's placeholders, and a write's grains need the words and place to say them", () => {
	const errors = (issue: object) => {
		const parsed = parseObjects({ issue: { ...GITHUB_OBJECTS.issue, ...issue } }, () => true);
		return "errors" in parsed ? parsed.errors : [];
	};
	expect(errors({})).toEqual([]);
	expect(errors({ place: "{owner}/{team}" })).toEqual([
		"objects.issue.place names {team}, which its name does not use",
	]);
	for (const place of ["", "repo", "{owner}{repo}", "{owner}/{owner}", 7])
		expect(errors({ place }), String(place)).toEqual([
			'objects.issue.place is where one lives, from its name\'s placeholders: "{owner}/{repo}"',
		]);
	expect(errors({ plural: "Issues!" })).toHaveLength(1);
	const comment = GITHUB_OBJECTS.issue.writes[0];
	expect(errors({ place: undefined, writes: [comment] })).toEqual([
		"objects.issue.writes[0].grains: its kind says no place for the place's grain",
	]);
	expect(errors({ plural: undefined, writes: [comment] })).toEqual([
		"objects.issue.writes[0].grains: its kind says no plural to word them with",
	]);
	expect(errors({ writes: [{ ...comment, grains: ["object"] }] })).toEqual([
		"objects.issue.writes[0].grains is a list of place, action",
	]);
	// a write whose words depend on its arguments has no one verb for a grain
	expect(errors({ writes: [{ ...GITHUB_OBJECTS.issue.writes[1], grains: ["action"] }] })).toEqual([
		"objects.issue.writes[0].grains: a write with other words for some arguments has no wider grain",
	]);
});

it("words a write's wider grains from its kinds: one verb, their plurals, and the place every kind agrees on", () => {
	const parsed = parseObjects(GITHUB_OBJECTS, () => true);
	if (!("objects" in parsed)) throw new Error(parsed.errors.join("; "));
	expect(grainsOf("merge_pull_request", parsed.objects)).toEqual({
		what: "merge pull requests",
		place: { words: "merge pull requests in {owner}/{repo}", args: { owner: "owner", repo: "repo" } },
		action: { words: "merge pull requests anywhere" },
	});
	expect(grainsOf("add_issue_comment", parsed.objects)).toMatchObject({
		what: "comment on pull requests and issues",
		place: { words: "comment on pull requests and issues in {owner}/{repo}" },
	});
	// a review's free method could be any of its writes: it declares none
	expect(grainsOf("pull_request_review_write", parsed.objects)).toBeUndefined();
	expect(grainsOf("dismiss_notification", parsed.objects)).toBeUndefined();
	expect(grainWords("merge pull requests in {owner}/{repo}", { owner: "purrgrammer", repo: "banda" })).toBe(
		"merge pull requests in purrgrammer/banda",
	);
	// kinds that disagree on where the place is give no place's grain
	const { pull_request, issue } = parsed.objects;
	if (pull_request === undefined || issue === undefined) throw new Error("no kinds");
	expect(grainsOf("add_issue_comment", { pull_request, issue: { ...issue, place: "{owner}" } })).toEqual({
		what: "comment on pull requests and issues",
		action: { words: "comment on pull requests and issues anywhere" },
	});
});
