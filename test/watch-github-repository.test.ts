import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { endedBy, type Json, sort } from "../src/core/follow.ts";
import { cardOf, draftedOn, parseObjects, recognise, refKey } from "../src/core/objects.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, GITHUB, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { githubObjectTools } from "./fixtures/github-objects.ts";
import { tempHome } from "./helpers.ts";

/** GitHub with the reads of the repository-level objects listed, as its server lists them. */
const github = async () => ({
	...GITHUB,
	tools: (await githubObjectTools()).filter((tool) =>
		[
			"list_pull_requests",
			"list_issues",
			"list_releases",
			"list_commits",
			"get_discussion",
			"get_discussion_comments",
			"actions_get",
			"actions_list",
		].includes(tool.name),
	),
});

type Item = { [key: string]: Json };
const pull = (number: number, login: string, title: string, state = "open"): Item => ({
	number,
	title,
	state,
	draft: false,
	merged: false,
	user: { login },
	created_at: `2026-11-0${Math.min(9, number % 10)}T09:00:00Z`,
});
const issue = (number: number, login: string, title: string): Item => ({
	number,
	title,
	state: "OPEN",
	user: { login },
	created_at: "2026-11-01T09:00:00Z",
});
const release = (id: number, tag: string, day: number, draft = false): Item => ({
	id,
	tag_name: tag,
	html_url: `https://github.com/acme/banda/releases/tag/${tag}`,
	...(draft ? {} : { published_at: `2026-11-0${day}T09:00:00Z` }),
	prerelease: false,
	draft,
	author: { login: "github-actions[bot]" },
});
const commit = (sha: string, login: string, message: string): Item => ({
	sha,
	html_url: `https://github.com/acme/banda/commit/${sha}`,
	commit: { message, author: { name: login, date: "2026-11-02T08:00:00Z" } },
	author: { login },
});

/** A repository's world: what each of its four reads answers at a step, as github-mcp-server's minimal answers. */
type RepositoryWorld = { pulls: Item[]; issues: Item[]; releases: Item[]; commits: Item[] };
const repository =
	(worldAt: (step: number) => RepositoryWorld): Answer =>
	(tool, args, step) => {
		if (args.owner !== "acme" || args.repo !== "banda") return failure("Not Found");
		const world = worldAt(step);
		if (tool === "list_pull_requests") return world.pulls;
		if (tool === "list_issues")
			return {
				issues: world.issues,
				totalCount: 40 + world.issues.length,
				pageInfo: { hasNextPage: true, hasPreviousPage: false, endCursor: `c${step}` },
			};
		if (tool === "list_releases") return world.releases;
		if (tool === "list_commits") return world.commits;
		return failure(`no ${tool}`);
	};

const REPOSITORY = "https://github.com/acme/banda";

describe("a watch on a repository", () => {
	it("others' new pull requests and issues wake, the account's own are nothing, a bot's tell; it never ends", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: REPOSITORY,
			answer: repository((step) => ({
				pulls: [
					...(step >= 2 ? [pull(15, "dependabot[bot]", "Bump vite")] : []),
					...(step >= 1 ? [pull(14, "bandarra", "My own change"), pull(13, "carol", "Faster boot")] : []),
					// one closing is no news: the list holds closed ones too, and a state change is nothing
					pull(12, "ana", "Keep objects as data", step >= 2 ? "closed" : "open"),
					pull(11, "ana", "Older"),
				],
				issues: [...(step >= 1 ? [issue(16, "dave", "Crash on start")] : []), issue(10, "bob", "Slow panel")],
				releases: [release(2, "v1.1", 1)],
				commits: [commit("a1b2c3d4", "ana", "Start")],
			})),
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => [...wake.changes].sort())).toEqual([
			["carol opened #13: Faster boot", "dave opened issue #16: Crash on start"],
		]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["dependabot[bot] opened #15: Bump vite"]]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "acme/banda", service: "GitHub" });
		expect(summary.record.done).toBeUndefined();
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);

	it("a new release wakes, a draft only once published; a push to the default branch tells", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: REPOSITORY,
			answer: repository((step) => ({
				pulls: [pull(11, "ana", "Older")],
				issues: [],
				releases: [
					...(step >= 2 ? [release(4, "v1.3", 3, step < 3)] : []),
					...(step >= 1 ? [release(3, "v1.2", 2)] : []),
					release(2, "v1.1", 1),
				],
				commits: [step >= 2 ? commit("e5f6a7b8", "ana", "Prepare v1.3") : commit("a1b2c3d4", "ana", "Start")],
			})),
			clicks: ["k1", "k2", "k3"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["released v1.2"], ["released v1.3"]]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["new commits on the default branch"]]);
		expect(summary.record.done).toBeUndefined();
	}, 60_000);

	it("a renamed default branch is no news; a push after it tells as on the default branch, never by a name", async () => {
		// a scripted mock: the repository's branches and which is the default, renamed from main to trunk at step 1 and
		// pushed to at step 2; list_commits without `sha` answers the default branch's head, as GitHub's does
		const asked: unknown[] = [];
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: REPOSITORY,
			answer: (tool, args, step) => {
				if (tool === "list_commits") asked.push(args.sha);
				const head = step >= 2 ? commit("e5f6a7b8", "ana", "After the rename") : commit("a1b2c3d4", "ana", "Start");
				const branches: { [name: string]: Item[] } = { [step >= 1 ? "trunk" : "main"]: [head] };
				const defaultBranch = step >= 1 ? "trunk" : "main";
				return repository(() => ({
					pulls: [pull(11, "ana", "Older")],
					issues: [],
					releases: [],
					commits: branches[typeof args.sha === "string" ? args.sha : defaultBranch] ?? [],
				}))(tool, args, step);
			},
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(asked.every((sha) => sha === undefined)).toBe(true);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["new commits on the default branch"]]);
	}, 60_000);

	it("one that slid onto a page as another left is nothing: a deleted release, a transferred issue", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: REPOSITORY,
			answer: repository((step) => ({
				pulls: [pull(11, "ana", "Older")],
				// a page of two: v1.2 deleted, v1.0 slides in; issue 10 transferred away, issue 8 slides in
				issues:
					step >= 1
						? [issue(9, "bob", "Nine"), issue(8, "bob", "Eight")]
						: [issue(10, "bob", "Ten"), issue(9, "bob", "Nine")],
				releases:
					step >= 1 ? [release(2, "v1.1", 2), release(1, "v1.0", 1)] : [release(3, "v1.2", 3), release(2, "v1.1", 2)],
				commits: [commit("a1b2c3d4", "ana", "Start")],
			})),
			clicks: ["k1"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.looks).toBe(2);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells).toEqual([]);
	}, 60_000);

	it("the account's own push is nothing; an empty repository's missing commits and releases are no failure", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: "github.com/acme/banda",
			answer: (tool, args, step) =>
				tool === "list_commits" && step === 0
					? failure("Git Repository is empty.")
					: tool === "list_releases"
						? failure("Not Found")
						: repository(() => ({
								pulls: [],
								issues: [],
								releases: [],
								commits: [commit("a1b2c3d4", "bandarra", "Initial commit")],
							}))(tool, args, step),
			clicks: ["k1"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.looks).toBe(2);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells).toEqual([]);
	}, 60_000);
});

const parsed = parseObjects(GITHUB_OBJECTS, () => true);
if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
const kinds = parsed.objects;
const hub = [{ name: "github", objects: kinds }];

describe("a repository as an object", () => {
	it("its URL and its tabs name it; a pull request's, an issue's or a file's never do", () => {
		for (const url of [
			"https://github.com/Acme/Banda",
			"https://github.com/acme/banda/",
			"https://github.com/acme/banda/pulls?q=is%3Aopen",
			"https://github.com/acme/banda#readme",
			"https://api.github.com/repos/acme/banda",
			"github.com/acme/banda",
		]) {
			const found = recognise(url, hub);
			expect(
				found.map((ref) => ref.kind),
				url,
			).toEqual(["repository"]);
			expect(refKey(found[0]!, kinds)).toBe("github:repository:github.com/acme/banda");
		}
		for (const [url, kind] of [
			["https://github.com/acme/banda/pull/142", "pull_request"],
			["https://github.com/acme/banda/issues/41", "issue"],
			["https://github.com/acme/banda/actions/runs/20/job/77", "check_run"],
			["https://api.github.com/repos/acme/banda/pulls/142", "pull_request"],
		])
			expect(
				recognise(url as string, hub).map((ref) => ref.kind),
				url,
			).toEqual([kind]);
		for (const url of ["https://github.com/acme/banda/blob/main/README.md", "https://github.com/acme/banda/tree/main"])
			expect(recognise(url, hub), url).toEqual([]);
		// `owner/repo` alone is any connection's `<connection>/<id>`: never taken for a repository
		expect(recognise("acme/banda", hub)).toEqual([]);
	});

	it("its card says what is newest: the release, the head, the newest pull request and issue", () => {
		const kind = kinds.repository!;
		const ref = recognise(REPOSITORY, hub)[0]!;
		const answers = {
			pulls: [pull(13, "carol", "Faster boot"), pull(12, "ana", "Keep objects as data", "closed")],
			issues: { issues: [issue(16, "dave", "Crash on start")], totalCount: 1 },
			releases: [release(4, "v1.3", 3, true), release(3, "v1.2", 2)],
			commits: [commit("e5f6a7b8c9", "ana", "Prepare v1.3\n\nThe long story")],
		};
		expect(cardOf(kind, ref, answers)).toEqual({
			card: "repository",
			repo: "acme/banda",
			release: "v1.2",
			released: Date.parse("2026-11-02T09:00:00Z"),
			commit: "Prepare v1.3",
			sha: "e5f6a7b",
			committed: Date.parse("2026-11-02T08:00:00Z"),
			pull: { number: 13, title: "Faster boot", author: "carol", state: "open" },
			issue: { number: 16, title: "Crash on start", author: "dave", state: "open" },
			url: "https://github.com/acme/banda",
		});
		// an empty repository: no releases, no commits, nothing opened, and still a card
		expect(cardOf(kind, ref, { pulls: [] })).toEqual({
			card: "repository",
			repo: "acme/banda",
			url: "https://github.com/acme/banda",
		});
		// no pull requests read: not a repository it could read
		expect(() => cardOf(kind, ref, { releases: [] })).toThrow();
	});

	it("follows as declared: nothing ends it, and each list is a page of the newest", () => {
		const follow = kinds.repository!.follow!;
		expect(follow.ends).toEqual({});
		expect(endedBy(follow, undefined, { pulls: [] })).toBeUndefined();
		const before: Json = { pulls: [pull(12, "ana", "A"), pull(11, "ana", "B")], commits: [commit("a1", "ana", "x")] };
		const after: Json = {
			pulls: [pull(13, "renovate[bot]", "Bump"), pull(12, "ana", "A")],
			commits: [commit("b2", "github-actions[bot]", "y")],
		};
		expect(
			sort(follow, "bandarra", before, after)
				.filter((each) => each.does !== "nothing")
				.map((each) => [each.does, each.says]),
		).toEqual([
			["tell", "new commits on the default branch"],
			["tell", "renovate[bot] opened #13: Bump"],
		]);
	});
});

/**
 * A discussion's life, as `get_discussion` and `get_discussion_comments` (with replies) answer it: open with one
 * comment; a second comment and a new title; a reply to the first; then answered.
 */
const discussion: Answer = (tool, args, step) => {
	if (args.owner !== "acme" || args.repo !== "banda" || Number(args.discussionNumber) !== 52)
		return failure("Not Found");
	if (tool === "get_discussion") {
		const found: Item = {
			number: 52,
			title: step >= 1 ? "How should a paused watch report?" : "Paused watches",
			body: "What should it say?",
			url: "https://github.com/acme/banda/discussions/52",
			closed: false,
			isAnswered: step >= 3,
			createdAt: "2026-11-01T09:00:00Z",
			category: { name: "Q&A" },
		};
		if (step >= 3) found.answerChosenAt = "2026-11-02T10:00:00Z";
		return found;
	}
	if (tool === "get_discussion_comments") {
		const comments: Item[] = [
			{
				id: "DC_1",
				body: "One wake, marked",
				isAnswer: step >= 3,
				...(step >= 2 ? { replies: [{ id: "DC_3", body: "Agreed" }], replyTotalCount: 1 } : {}),
			},
			...(step >= 1 ? [{ id: "DC_2", body: "Or a line per change" }] : []),
		];
		return {
			comments,
			pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: "a", endCursor: `e${step}` },
			totalCount: comments.length,
		};
	}
	return failure(`no ${tool}`);
};

describe("a watch on a discussion", () => {
	it("a new comment and a reply wake, a new title tells; answered wakes and ends it", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: "https://github.com/acme/banda/discussions/52",
			answer: discussion,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => [[...wake.changes].sort(), wake.ended ?? null])).toEqual([
			[["new comment (author not known)", "retitled: How should a paused watch report?"], null],
			[["new reply (author not known)"], null],
			[["answered"], "answered"],
		]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "acme/banda · discussion #52", service: "GitHub" });
		expect(summary.record.done?.why).toBe("answered");
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);

	it("closed wakes and ends it; a short page of comments says none is gone", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: "acme/banda/discussions/52",
			answer: (tool, args, step) => {
				const answer = discussion(tool, args, 0);
				if (tool === "get_discussion") return { ...(answer as Item), closed: step >= 2 };
				// a page short of the count: the first comment fell off it, which is no removal
				if (step >= 1) return { comments: [], pageInfo: {}, totalCount: 1 };
				return answer;
			},
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended ?? null])).toEqual([[["closed"], "closed"]]);
	}, 60_000);

	it("the account's own comment and reply, which GitHub's answer names no author of, wake saying so", async () => {
		// a scripted mock in github-mcp-server's shape: its MinimalDiscussionComment is an id, a body, isAnswer and the
		// replies, with no author, so what the account itself wrote reads as anyone's: its comment, then its reply
		const own = (id: string): Item => ({ id, body: "Written as bandarra, the watch's own account" });
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: "acme/banda/discussions/52",
			answer: (tool, args, step) => {
				const answer = discussion(tool, args, 0);
				if (tool !== "get_discussion_comments") return answer;
				const [first] = (answer as Item).comments as Item[];
				const comments = [
					step >= 2 ? { ...first, replies: [own("DC_10")], replyTotalCount: 1 } : first,
					...(step >= 1 ? [own("DC_9")] : []),
				] as Item[];
				return { ...(answer as Item), comments, totalCount: comments.length };
			},
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([
			["new comment (author not known)"],
			["new reply (author not known)"],
		]);
	}, 60_000);
});

describe("a discussion as an object", () => {
	it("its URL and id name it, a pull request's never; its card says its state, category and comments", () => {
		const found = recognise("https://github.com/Acme/Banda/discussions/052#discussioncomment-1", hub);
		expect(found.map((ref) => ref.kind)).toEqual(["discussion"]);
		expect(refKey(found[0]!, kinds)).toBe("github:discussion:acme/banda/discussions/52");
		expect(recognise("acme/banda#52", hub).map((ref) => ref.kind)).toEqual(["pull_request", "issue"]);
		const answers = {
			discussion: discussion("get_discussion", { owner: "acme", repo: "banda", discussionNumber: 52 }, 3),
		};
		expect(cardOf(kinds.discussion!, found[0]!, answers)).toEqual({
			card: "discussion",
			repo: "acme/banda",
			number: 52,
			title: "How should a paused watch report?",
			state: "answered",
			category: "Q&A",
			comments: null,
			url: "https://github.com/acme/banda/discussions/52",
		});
	});

	it("a comment on it is a draft on it", () => {
		const drafted = draftedOn(
			"github",
			"discussion_comment_write",
			{ method: "add", owner: "acme", repo: "banda", discussionNumber: 52, body: "One wake" },
			kinds,
		);
		expect(drafted).toEqual({
			refs: [{ connection: "github", kind: "discussion", values: { owner: "acme", repo: "banda", number: "52" } }],
			verb: "Comment",
			what: "Comment on",
			text: "body",
		});
		expect(
			draftedOn("github", "discussion_comment_write", { method: "delete", commentNodeID: "DC_1" }, kinds),
		).toBeUndefined();
	});
});

/**
 * A workflow run's life, as `actions_get`'s get_workflow_run and `actions_list`'s list_workflow_jobs answer it:
 * queued; in progress, lint failed while unit runs; then completed as `conclusion`.
 */
const run =
	(conclusion: string): Answer =>
	(tool, args, step) => {
		if (args.owner !== "acme" || args.repo !== "banda" || args.resource_id !== "20") return failure("Not Found");
		const status = step === 0 ? "queued" : step === 1 ? "in_progress" : "completed";
		if (tool === "actions_get" && args.method === "get_workflow_run") {
			const found: Item = {
				id: 20,
				name: "CI",
				display_title: "Keep objects as data",
				workflow_id: 3,
				run_number: 812,
				run_attempt: 1,
				event: "push",
				status,
				head_branch: "main",
				head_sha: "a1",
				html_url: "https://github.com/acme/banda/actions/runs/20",
				created_at: "2026-11-02T09:00:00Z",
				updated_at: `2026-11-02T09:0${step}:00Z`,
				run_started_at: "2026-11-02T09:00:30Z",
			};
			if (step >= 2) found.conclusion = conclusion;
			return found;
		}
		if (tool === "actions_list" && args.method === "list_workflow_jobs") {
			const job = (id: number, name: string, done: string | undefined): Item => ({
				id,
				run_id: 20,
				name,
				status: done === undefined ? "in_progress" : "completed",
				...(done === undefined ? {} : { conclusion: done, completed_at: "2026-11-02T09:03:00Z" }),
				runner_name: `runner-${step}`,
				steps: [{ name: "Set up job", status: "completed", conclusion: "success", number: 1 }],
			});
			const jobs =
				step === 0
					? []
					: [
							job(77, "unit", step >= 2 ? (conclusion === "success" ? "success" : "failure") : undefined),
							job(78, "lint", conclusion === "success" ? "success" : "failure"),
						];
			return { jobs: { total_count: jobs.length, jobs } };
		}
		return failure(`no ${tool}`);
	};

describe("a watch on a workflow run", () => {
	it("a job that fails wakes at once, though it came already failed; the run failing wakes and ends it", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: "https://github.com/acme/banda/actions/runs/20",
			answer: run("failure"),
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => [[...wake.changes].sort(), wake.ended ?? null])).toEqual([
			[["a job failed"], null],
			[["failed"], "completed"],
		]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "acme/banda · run 20", service: "GitHub" });
		expect(summary.record.done?.why).toBe("completed");
	}, 60_000);

	it("a run that succeeds says so as it ends; one cancelled or timed out wakes in those words", async () => {
		for (const [conclusion, words] of [
			["success", "succeeded"],
			["cancelled", "cancelled"],
			["timed_out", "timed out"],
		] as const) {
			const summary = await watchScenario(await tempHome(), new Faults(), {
				connection: await github(),
				object: "acme/banda/actions/runs/20",
				answer: (tool, args, step) =>
					tool === "actions_list" ? { jobs: { total_count: 0, jobs: [] } } : run(conclusion)(tool, args, step),
				clicks: ["k1", "k2"],
			});
			expect(watchInvariants(summary)).toEqual([]);
			expect(summary.wakes.map((wake) => [wake.changes, wake.ended])).toEqual([[[words], "completed"]]);
		}
	}, 60_000);
});

describe("a workflow run as an object", () => {
	it("its URL names it, a job's never; it is drawn as a check, its failing job as its step", () => {
		const found = recognise("https://github.com/acme/banda/actions/runs/0020?pr=142", hub);
		expect(found.map((ref) => ref.kind)).toEqual(["workflow_run"]);
		expect(refKey(found[0]!, kinds)).toBe("github:workflow_run:acme/banda/actions/runs/20");
		expect(recognise("https://github.com/acme/banda/actions/runs/20/job/77", hub).map((ref) => ref.kind)).toEqual([
			"check_run",
		]);
		const answers = {
			run: run("failure")(
				"actions_get",
				{ method: "get_workflow_run", owner: "acme", repo: "banda", resource_id: "20" },
				1,
			),
			jobs: run("failure")(
				"actions_list",
				{ method: "list_workflow_jobs", owner: "acme", repo: "banda", resource_id: "20" },
				1,
			),
		};
		expect(cardOf(kinds.workflow_run!, found[0]!, answers)).toEqual({
			card: "check-run",
			repo: "acme/banda",
			name: "CI",
			state: "running",
			where: "main",
			step: "unit",
			url: "https://github.com/acme/banda/actions/runs/20",
		});
	});
});
