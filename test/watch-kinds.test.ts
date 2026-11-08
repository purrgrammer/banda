import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/follow.ts";
import { REST_APIS } from "../src/core/rest.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, GITHUB, watchFile, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { githubObjectTools } from "./fixtures/github-objects.ts";
import { tempHome } from "./helpers.ts";

/** Gmail as banda ships it, signed in as ana@example.com: the shape each connection's watch scenario copies. */
const GMAIL = {
	name: "gmail",
	file: readFileSync(new URL("../shipped/connections/gmail.md", import.meta.url), "utf8"),
	tools: REST_APIS.gmail.tools,
	account: "ana@example.com",
};

/** An email as `get_message` answers it: unread in the inbox; then read and marked important; then starred. */
const email: Answer = (tool, args, step) => {
	if (tool !== "get_message") return failure(`no ${tool}`);
	return {
		id: String(args.message_id),
		threadId: "t1",
		from: "Bob <bob@example.com>",
		fromAddress: "bob@example.com",
		to: "ana@example.com",
		cc: "",
		subject: "Lunch?",
		date: "Mon, 2 Nov 2026 09:00:00 +0100",
		snippet: "Are you free",
		body: "Are you free on Thursday?",
		attachments: [],
		labels: step === 0 ? ["INBOX", "UNREAD"] : step === 1 ? ["INBOX", "IMPORTANT"] : ["INBOX", "IMPORTANT", "STARRED"],
		unread: step === 0,
	};
};

/** A message of a conversation or a search, as Gmail's reads give it. */
const message = (id: string, from: string, subject: string, labels: string[] = ["INBOX"]) => ({
	id,
	threadId: "t1",
	from,
	fromAddress: (/<(.+)>/.exec(from)?.[1] ?? from).toLowerCase(),
	to: "ana@example.com",
	cc: "",
	subject,
	date: "Mon, 2 Nov 2026 09:00:00 +0100",
	snippet: subject,
	body: subject,
	attachments: [],
	labels,
	unread: labels.includes("UNREAD"),
});

const BOB = "Bob <bob@example.com>";
const ANA = "Ana <ana@example.com>";
const CAROL = "Carol <carol@example.com>";

/**
 * A conversation's life, as `get_thread` answers it: Bob asks; then the owner reads it and answers herself; then
 * Carol replies; then the owner stars it.
 */
const conversation: Answer = (tool, args, step) => {
	if (tool !== "get_thread") return failure(`no ${tool}`);
	const messages = [message("m1", BOB, "Lunch?", step === 0 ? ["INBOX", "UNREAD"] : ["INBOX"])];
	if (step >= 1) messages.push(message("m2", ANA, "Re: Lunch?", ["SENT"]));
	if (step >= 2) messages.push(message("m3", CAROL, "Re: Lunch?", step >= 3 ? ["INBOX", "STARRED"] : ["INBOX"]));
	return {
		id: String(args.thread_id),
		subject: "Lunch?",
		total: messages.length,
		labels: [...new Set(messages.flatMap((each) => each.labels))],
		messages,
	};
};

describe("a watch on Gmail", () => {
	it("an email is followed for its labels, and until it is read: read and marked important ends it", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			object: "gmail/18c2f0a1b2c3d4e5",
			answer: email,
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		// reading it is no change of its own (UNREAD gone is nothing), but it is the end; the label says itself
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended ?? null])).toEqual([[["marked important"], "read"]]);
		expect(summary.wakes[0]?.object).toMatchObject({ service: "Gmail" });
		expect(summary.record.done?.why).toBe("read");
		expect(summary.tells).toEqual([]);
	}, 60_000);

	it("an email followed until trashed tells each label, and wakes for none of them", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			watch: watchFile("gmail/18c2f0a1b2c3d4e5", GMAIL.account).replace("---\n", "---\nuntil: trashed\n"),
			answer: email,
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["marked important"], ["starred"]]);
		expect(summary.record.done).toBeUndefined();
	}, 60_000);

	it("a conversation: the owner's own reply is nothing, another's wakes, a label only tells; it never ends", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			object: "gmail/thread/t1",
			answer: conversation,
			clicks: ["k1", "k2", "k3"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([[`${CAROL} replied`]]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "conversation t1", service: "Gmail" });
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["starred"]]);
		expect(summary.record.done).toBeUndefined();
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);

	it("a conversation longer than a page: an older message falling off it is not gone", async () => {
		const long: Answer = (tool, args, step) => {
			if (tool !== "get_thread") return failure(`no ${tool}`);
			const all = Array.from({ length: 25 + step }, (_, n) => message(`m${n}`, BOB, `Re: ${n}`));
			const messages = all.slice(-25);
			return { id: String(args.thread_id), subject: "Lunch?", total: all.length, labels: ["INBOX"], messages };
		};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			object: "gmail/thread/t1",
			answer: long,
			clicks: ["k1"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([[`${BOB} replied`]]);
		expect(summary.tells).toEqual([]);
	}, 60_000);

	/**
	 * A search's life, as `search_messages` answers it: one mail from the boss; then a new one; then the same again;
	 * then the first is read, so it matches no more, and the owner's own mail to the boss matches.
	 */
	const search: Answer = (tool, args, step) => {
		if (tool !== "search_messages") return failure(`no ${tool}`);
		if (args.query !== "from:boss is:unread" || args.max_results !== 25) return failure(`not ${String(args.query)}`);
		const boss = "The Boss <boss@example.com>";
		const messages = [
			...(step >= 3 ? [message("m9", ANA, "Re: Numbers")] : []),
			...(step >= 1 ? [message("m2", boss, "Numbers for Thursday")] : []),
			...(step < 3 ? [message("m1", boss, "Budget")] : []),
		].map(({ id, threadId, from, fromAddress, subject, date, snippet }) => ({
			id,
			threadId,
			from,
			fromAddress,
			subject,
			date,
			snippet,
		}));
		return { resultSizeEstimate: messages.length, messages };
	};

	it("a search: new mail matching wakes in from: subject words; the same again, mail gone or the owner's own is nothing", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			object: "https://mail.google.com/mail/u/0/#search/from%3Aboss+is%3Aunread",
			answer: search,
			clicks: ["k1", "k2", "k3"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["The Boss <boss@example.com>: Numbers for Thursday"]]);
		expect(summary.wakes[0]?.object).toMatchObject({
			name: "mail matching from:boss is:unread",
			ref: "gmail:search:gmail/search/from%3Aboss%20is%3Aunread",
			service: "Gmail",
		});
		expect(summary.tells).toEqual([]);
		expect(summary.record.done).toBeUndefined();
		expect(summary.card).toBeDefined();
	}, 60_000);
});

/** GitHub with the reads of a check run and a notification listed, as its server lists them. */
const github = async () => ({
	...GITHUB,
	tools: (await githubObjectTools()).filter((tool) =>
		["pull_request_read", "issue_read", "actions_get", "get_notification_details"].includes(tool.name),
	),
});

/**
 * A job's life, as `actions_get`'s get_workflow_job answers it (go-github's WorkflowJob): queued; in progress, its
 * first step done; then completed as `conclusion`.
 */
const job =
	(conclusion: string): Answer =>
	(tool, args, step) => {
		if (tool !== "actions_get" || args.method !== "get_workflow_job") return failure(`no ${tool}`);
		const status = step === 0 ? "queued" : step === 1 ? "in_progress" : "completed";
		const steps: { [key: string]: Json }[] =
			step === 0
				? []
				: [
						{
							name: "Set up job",
							status: "completed",
							conclusion: "success",
							number: 1,
							started_at: "a",
							completed_at: "b",
						},
						{
							name: "Tests",
							status: step === 1 ? "in_progress" : "completed",
							...(step === 1 ? {} : { conclusion }),
							number: 2,
							started_at: "b",
							...(step === 1 ? {} : { completed_at: "c" }),
						},
					];
		return {
			id: Number(args.resource_id),
			run_id: 20,
			name: "unit",
			workflow_name: "ci",
			head_branch: "objects",
			head_sha: "a1",
			status,
			...(step >= 2 ? { conclusion, completed_at: "2026-11-02T09:04:00Z" } : {}),
			created_at: "2026-11-02T09:00:00Z",
			...(step >= 1 ? { started_at: "2026-11-02T09:01:00Z", runner_name: `runner-${step}`, runner_id: step } : {}),
			steps,
			labels: ["ubuntu-latest"],
			run_attempt: 1,
			html_url: `https://github.com/acme/banda/actions/runs/20/job/${String(args.resource_id)}`,
			check_run_url: `https://api.github.com/repos/acme/banda/check-runs/${String(args.resource_id)}`,
		};
	};

const CHECK = "https://github.com/acme/banda/actions/runs/20/job/77";

describe("a watch on a check run", () => {
	it("a failed job wakes once, with the end: it is done when completed", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: CHECK,
			answer: job("failure"),
			clicks: ["k1", "k2"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		// starting and its steps' progress are nothing; the failure wakes and ends it
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended])).toEqual([[["failed"], "completed"]]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "acme/banda · check 77", service: "GitHub" });
		expect(summary.record.done?.why).toBe("completed");
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);

	it("a job that timed out or was cancelled wakes in those words; one that succeeded says so as it ends", async () => {
		for (const [conclusion, words] of [
			["timed_out", "timed out"],
			["cancelled", "cancelled"],
			["success", "succeeded"],
		]) {
			const summary = await watchScenario(await tempHome(), new Faults(), {
				connection: await github(),
				object: CHECK,
				answer: job(conclusion as string),
				clicks: ["k1", "k2"],
			});
			expect(watchInvariants(summary)).toEqual([]);
			expect(summary.wakes.map((wake) => [wake.changes, wake.ended])).toEqual([[[words], "completed"]]);
			expect(summary.record.done?.why).toBe("completed");
		}
	}, 60_000);
});

/**
 * A notification thread's life, as `get_notification_details` answers it (go-github's Notification): unread, review
 * requested; then the same; then a new comment moves it on and mentions the account; then the owner reads it.
 */
const thread: Answer = (tool, args, step) => {
	if (tool !== "get_notification_details") return failure(`no ${tool}`);
	const active = step >= 2;
	return {
		id: String(args.notificationID),
		repository: { id: 1, name: "banda", full_name: "acme/banda", owner: { login: "acme" }, pushed_at: `p${step}` },
		subject: {
			title: "Keep objects as data",
			url: "https://api.github.com/repos/acme/banda/pulls/142",
			latest_comment_url: `https://api.github.com/repos/acme/banda/issues/comments/${active ? 6 : 5}`,
			type: "PullRequest",
		},
		reason: active ? "mention" : "review_requested",
		unread: step < 3,
		updated_at: active ? "2026-11-02T10:00:00Z" : "2026-11-02T09:00:00Z",
		...(step >= 3 ? { last_read_at: "2026-11-02T10:05:00Z" } : {}),
		url: `https://api.github.com/notifications/threads/${String(args.notificationID)}`,
	};
};

describe("a watch on a notification", () => {
	it("new activity on the thread wakes in the reason's words; it ends once read", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: await github(),
			object: "https://api.github.com/notifications/threads/9001",
			answer: thread,
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => [[...wake.changes].sort(), wake.ended ?? null])).toEqual([
			[["mentioned you", "new activity"], null],
			[["read"], "read"],
		]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "notification 9001", service: "GitHub" });
		expect(summary.record.done?.why).toBe("read");
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);
});
