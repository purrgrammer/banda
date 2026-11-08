import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/follow.ts";
import { REST_APIS } from "../src/core/rest.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, GITHUB, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { githubObjectTools } from "./fixtures/github-objects.ts";
import { tempHome } from "./helpers.ts";

/** Gmail as banda ships it, signed in as ana@example.com: the shape each connection's watch scenario copies. */
const GMAIL = {
	name: "gmail",
	file: readFileSync(new URL("../shipped/connections/gmail.md", import.meta.url), "utf8"),
	tools: REST_APIS.gmail.tools,
	account: "ana@example.com",
};

/** An email as `get_message` answers it: unread, then read and labelled. */
const email: Answer = (tool, args, step) => {
	if (tool !== "get_message") return failure(`no ${tool}`);
	return {
		id: String(args.message_id),
		threadId: "t1",
		from: "Bob <bob@example.com>",
		to: "ana@example.com",
		cc: "",
		subject: "Lunch?",
		date: "Mon, 2 Nov 2026 09:00:00 +0100",
		snippet: "Are you free",
		body: "Are you free on Thursday?",
		attachments: [],
		labels: step >= 1 ? ["INBOX", "IMPORTANT"] : ["INBOX", "UNREAD"],
		unread: step < 1,
	};
};

describe("a watch through any connection", () => {
	it("a Gmail email, until Gmail declares how one is followed, is refused in the kind's words", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			object: "gmail/18c2f0a1b2c3d4e5",
			answer: email,
			clicks: ["k1"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.record.failed?.why).toBe(
			"Gmail here cannot follow a email yet: update Gmail on the Connections page",
		);
		expect(summary.wakes).toEqual([]);
		expect(summary.reads).toBe(0);
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
