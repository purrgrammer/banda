/**
 * GitHub's objects (DESIGN.md "Connections"), as `scripts/shipped-github.ts` writes them into the file banda ships: a
 * pull request, an issue, a check run and a notification, each with the URLs and ids that name it, the reads (of
 * github-mcp-server's own read tools, its minimal answers) that fetch it, the fields its card shows and the writes that
 * act on it. Data, never code: the daemon draws each card.
 */
export const GITHUB_OBJECTS = {
	pull_request: {
		card: "pull-request",
		normalize: { owner: "lowercase", repo: "lowercase", number: "integer" },
		name: "{owner}/{repo} #{number}",
		plural: "pull requests",
		place: "{owner}/{repo}",
		urls: [
			"https://github.com/{owner}/{repo}/pull/{number}",
			"https://api.github.com/repos/{owner}/{repo}/pulls/{number}",
		],
		ids: ["{owner}/{repo}#{number}"],
		reads: {
			pr: {
				tool: "pull_request_read",
				args: { method: "get", owner: "{owner}", repo: "{repo}", pullNumber: "{number}" },
			},
			checks: {
				optional: true,
				tool: "pull_request_read",
				args: {
					method: "get_check_runs",
					owner: "{owner}",
					repo: "{repo}",
					pullNumber: "{number}",
					perPage: 100,
					page: 1,
				},
			},
			reviews: {
				optional: true,
				tool: "pull_request_read",
				args: {
					method: "get_reviews",
					owner: "{owner}",
					repo: "{repo}",
					pullNumber: "{number}",
					perPage: 100,
					page: 1,
				},
			},
		},
		fields: {
			number: "pr.number",
			title: "pr.title",
			state: "pr.state",
			merged: "pr.merged",
			draft: "pr.draft",
			author: "pr.user",
			branch: "pr.head.ref",
			added: "pr.additions",
			removed: "pr.deletions",
			url: "pr.html_url",
			checks: "checks.check_runs",
			checks_total: "checks.total_count",
			reviews: "reviews",
		},
		writes: [
			{
				tool: "add_issue_comment",
				id: { owner: "owner", repo: "repo", number: "issue_number" },
				verb: "Comment",
				what: "Comment on",
				text: "body",
				grains: ["place", "action"],
			},
			{
				tool: "merge_pull_request",
				id: { owner: "owner", repo: "repo", number: "pullNumber" },
				verb: "Merge",
				grains: ["place", "action"],
			},
			{
				tool: "pull_request_review_write",
				id: { owner: "owner", repo: "repo", number: "pullNumber" },
				verb: "Review",
				text: "body",
				verbs: [
					{ when: { event: "APPROVE" }, verb: "Approve" },
					{ when: { event: "REQUEST_CHANGES" }, verb: "Request changes", what: "Request changes on" },
				],
			},
			{
				tool: "update_pull_request",
				id: { owner: "owner", repo: "repo", number: "pullNumber" },
				verb: "Change",
				verbs: [
					{ when: { state: "closed" }, verb: "Close" },
					{ when: { state: "open" }, verb: "Reopen" },
				],
			},
		],
	},
	issue: {
		card: "issue",
		normalize: { owner: "lowercase", repo: "lowercase", number: "integer" },
		name: "{owner}/{repo} #{number}",
		plural: "issues",
		place: "{owner}/{repo}",
		urls: [
			"https://github.com/{owner}/{repo}/issues/{number}",
			"https://api.github.com/repos/{owner}/{repo}/issues/{number}",
		],
		ids: ["{owner}/{repo}#{number}"],
		reads: {
			issue: {
				tool: "issue_read",
				args: { method: "get", owner: "{owner}", repo: "{repo}", issue_number: "{number}" },
			},
		},
		fields: {
			number: "issue.number",
			title: "issue.title",
			state: "issue.state",
			reason: "issue.state_reason",
			author: "issue.user",
			labels: "issue.labels",
			comments: "issue.comments",
			assignees: "issue.assignees",
			url: "issue.html_url",
		},
		writes: [
			{
				tool: "add_issue_comment",
				id: { owner: "owner", repo: "repo", number: "issue_number" },
				verb: "Comment",
				what: "Comment on",
				text: "body",
				grains: ["place", "action"],
			},
			{
				tool: "issue_write",
				id: { owner: "owner", repo: "repo", number: "issue_number" },
				verb: "Change",
				text: "body",
				verbs: [
					{ when: { state: "closed", state_reason: "not_planned" }, verb: "Close", what: "Close as not planned" },
					{ when: { state: "closed" }, verb: "Close" },
					{ when: { state: "open" }, verb: "Reopen" },
				],
			},
		],
		creates: [
			{
				tool: "issue_write",
				when: { method: "create" },
				in: { owner: "owner", repo: "repo" },
				verb: "Create",
				what: "Create an issue on {owner}/{repo}",
				text: "body",
			},
		],
	},
	check_run: {
		card: "check-run",
		normalize: { owner: "lowercase", repo: "lowercase", job: "integer" },
		name: "{owner}/{repo} · check {job}",
		urls: [
			"https://github.com/{owner}/{repo}/actions/runs/*/job/{job}",
			"https://api.github.com/repos/{owner}/{repo}/actions/jobs/{job}",
		],
		ids: ["{owner}/{repo}/actions/jobs/{job}"],
		reads: {
			job: {
				tool: "actions_get",
				args: { method: "get_workflow_job", owner: "{owner}", repo: "{repo}", resource_id: "{job}" },
			},
		},
		fields: {
			name: "job.name",
			status: "job.status",
			conclusion: "job.conclusion",
			steps: "job.steps",
			started: "job.started_at",
			completed: "job.completed_at",
			where: "job.head_branch",
			url: "job.html_url",
		},
	},
	notification: {
		card: "notification",
		normalize: { thread: "integer" },
		name: "notification {thread}",
		urls: ["https://api.github.com/notifications/threads/{thread}"],
		ids: ["notification/{thread}"],
		reads: { thread: { tool: "get_notification_details", args: { notificationID: "{thread}" } } },
		fields: {
			reason: "thread.reason",
			unread: "thread.unread",
			at: "thread.updated_at",
			title: "thread.subject.title",
			subject: "thread.subject.url",
		},
		writes: [
			{
				tool: "dismiss_notification",
				id: { thread: "threadID" },
				verb: "Mark read",
				verbs: [{ when: { state: "done" }, verb: "Mark done" }],
			},
		],
	},
} as const;
