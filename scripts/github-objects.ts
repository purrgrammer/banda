/**
 * GitHub's objects (DESIGN.md "Connections"), as `scripts/shipped-github.ts` writes them into the file banda ships: a
 * pull request, an issue, a check run, a workflow run, a notification, a discussion and a repository, each with the URLs and ids that name it, the reads (of
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
			comments: {
				optional: true,
				follow: true,
				tool: "pull_request_read",
				args: {
					method: "get_comments",
					owner: "{owner}",
					repo: "{repo}",
					pullNumber: "{number}",
					perPage: 100,
					page: 1,
				},
			},
		},
		// how a watch follows it: reviews and comments by id, check runs by name (every push gives them new ids), what
		// is noise, whose items are the account's own, what wakes and what only tells, and what ends the watch
		follow: {
			keys: { "checks.check_runs": "name" },
			totals: { "checks.check_runs": "checks.total_count", comments: "pr.review_comments" },
			ignore: [
				"pr.updated_at",
				"pr.comments",
				"pr.review_comments",
				"pr.commits",
				"pr.changed_files",
				"pr.mergeable",
				"pr.mergeable_state",
				"checks.total_count",
				"checks.check_runs[*].id",
				"checks.check_runs[*].html_url",
				"checks.check_runs[*].details_url",
				"checks.check_runs[*].started_at",
				"checks.check_runs[*].completed_at",
				"checks.check_runs[*].check_suite",
				"checks.check_runs[*].app",
				"checks.check_runs[*].output",
				"reviews[*].html_url",
				"reviews[*].user.avatar_url",
				"reviews[*].user.profile_url",
				"reviews[*].submitted_at",
				"comments[*].html_url",
				"comments[*].user.avatar_url",
				"comments[*].user.profile_url",
				"comments[*].reactions",
				"comments[*].updated_at",
			],
			authors: { reviews: "user.login", comments: "user.login" },
			// a push's check runs appear one by one: over the first look at a new head the list is not all of them, so
			// "all" holds only once the head is the one the reading before saw
			derived: {
				checks_done: { when: "all checks.check_runs[*].status = completed", steady: "pr.head.sha" },
				checks_green: { when: "all checks.check_runs[*].conclusion = success|skipped|neutral", steady: "pr.head.sha" },
			},
			rules: [
				{ on: "pr.merged", to: true, does: "wake", says: "merged" },
				{ on: "pr.state", to: "closed", does: "wake", says: "closed" },
				{ on: "pr.state", to: "open", does: "wake", says: "reopened" },
				{ on: "pr.draft", to: false, does: "wake", says: "ready for review" },
				{ on: "pr.title", does: "tell", says: "retitled: {to}" },
				{ on: "checks.check_runs[*].conclusion", to: "failure", does: "wake", says: "{name} failed" },
				{ on: "checks.check_runs[*].conclusion", to: "timed_out", does: "wake", says: "{name} timed out" },
				{ on: "derived.checks_green", to: true, does: "wake", says: "all checks green" },
				{ on: "derived.checks_done", to: true, does: "tell", says: "checks finished" },
				{
					on: "reviews[*]",
					kind: "added",
					does: "wake",
					says: "{user.login} {state}",
					words: {
						APPROVED: "approved",
						CHANGES_REQUESTED: "requested changes",
						COMMENTED: "reviewed",
						DISMISSED: "dismissed a review",
						PENDING: "started a review",
					},
				},
				{ on: "reviews[*].state", to: "DISMISSED", does: "tell", says: "{user.login}'s review was dismissed" },
				{ on: "comments[*]", kind: "added", does: "wake", says: "{user.login} commented" },
				// a run a push brings may come already finished: its first sight is an item added, not a conclusion changed
				{
					on: "checks.check_runs[*]",
					kind: "added",
					where: "conclusion = failure",
					does: "wake",
					says: "{name} failed",
				},
				{
					on: "checks.check_runs[*]",
					kind: "added",
					where: "conclusion = timed_out",
					does: "wake",
					says: "{name} timed out",
				},
				{ on: "pr.head.sha", does: "tell", says: "new commits" },
			],
			ends: { merged: "pr.merged = true", closed: "pr.state = closed" },
			busy: "checks.check_runs[*].status != completed",
			// GitHub tells nothing when a push comes, so a quiet pull request is looked at often enough that a push is
			// seen within minutes: four reads every five minutes
			every: "5m",
			// a review's comments, a push's checks: what comes within a minute of a change wakes with it
			settle: "1m",
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
			comments: {
				optional: true,
				follow: true,
				tool: "issue_read",
				args: {
					method: "get_comments",
					owner: "{owner}",
					repo: "{repo}",
					issue_number: "{number}",
					perPage: 100,
					page: 1,
				},
			},
		},
		// how a watch follows it: closed or reopened and others' comments wake; labels, assignees and the title only
		// tell; the account's own comments are nothing; it ends when closed
		follow: {
			ignore: [
				"issue.updated_at",
				"issue.comments",
				"issue.reactions",
				"issue.closed_at",
				"issue.closed_by",
				"issue.user.avatar_url",
				"issue.user.profile_url",
				"comments[*].html_url",
				"comments[*].user.avatar_url",
				"comments[*].user.profile_url",
				"comments[*].reactions",
				"comments[*].updated_at",
			],
			authors: { comments: "user.login" },
			rules: [
				{
					on: "issue.state",
					to: "closed",
					does: "wake",
					says: "closed",
				},
				{ on: "issue.state", to: "open", does: "wake", says: "reopened" },
				{ on: "comments[*]", kind: "added", does: "wake", says: "{user.login} commented" },
				{ on: "issue.labels[*]", kind: "added", does: "tell", says: "labelled {to}" },
				{ on: "issue.labels[*]", kind: "removed", does: "tell", says: "unlabelled {from}" },
				{ on: "issue.assignees[*]", kind: "added", does: "tell", says: "assigned to {to}" },
				{ on: "issue.assignees[*]", kind: "removed", does: "tell", says: "unassigned {from}" },
				{ on: "issue.title", does: "tell", says: "retitled: {to}" },
			],
			ends: { closed: "issue.state = closed" },
			every: "10m",
			settle: "1m",
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
		// how a watch follows it: a job that fails, times out or is cancelled wakes, one that succeeds tells, and it
		// ends when completed; its steps' progress, timestamps and runner are nothing until then
		follow: {
			keys: { "job.steps": "number" },
			ignore: [
				"job.created_at",
				"job.started_at",
				"job.completed_at",
				"job.runner_id",
				"job.runner_name",
				"job.runner_group_id",
				"job.runner_group_name",
				"job.steps[*].started_at",
				"job.steps[*].completed_at",
			],
			rules: [
				{ on: "job.conclusion", to: "failure", does: "wake", says: "failed" },
				{ on: "job.conclusion", to: "timed_out", does: "wake", says: "timed out" },
				{ on: "job.conclusion", to: "cancelled", does: "wake", says: "cancelled" },
				{ on: "job.conclusion", to: "success", does: "tell", says: "succeeded" },
				{
					on: "job.conclusion",
					does: "tell",
					says: "{to}",
					words: { action_required: "needs action", neutral: "finished neutral", skipped: "skipped", stale: "stale" },
				},
			],
			ends: { completed: "job.status = completed" },
			// a job runs minutes: it is looked at often until it completes
			every: "2m",
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
	// a workflow run is the page a push or a pull request's checks link to: drawn as a check, its jobs as its steps
	workflow_run: {
		card: "check-run",
		normalize: { owner: "lowercase", repo: "lowercase", run: "integer" },
		name: "{owner}/{repo} · run {run}",
		urls: [
			"https://github.com/{owner}/{repo}/actions/runs/{run}",
			"https://api.github.com/repos/{owner}/{repo}/actions/runs/{run}",
		],
		ids: ["{owner}/{repo}/actions/runs/{run}"],
		reads: {
			run: {
				tool: "actions_get",
				args: { method: "get_workflow_run", owner: "{owner}", repo: "{repo}", resource_id: "{run}" },
			},
			// its latest attempt's jobs: the one that fails is named before the run completes
			jobs: {
				optional: true,
				tool: "actions_list",
				args: { method: "list_workflow_jobs", owner: "{owner}", repo: "{repo}", resource_id: "{run}", perPage: 50 },
			},
		},
		// how a watch follows it: a job that fails wakes at once (the card names it); the run failing, timing out or cancelled
		// wakes, succeeding tells, and it ends when completed. Its jobs' steps, runners and times are nothing
		follow: {
			totals: { "jobs.jobs.jobs": "jobs.jobs.total_count" },
			derived: { job_failed: "jobs.jobs.jobs[*].conclusion = failure|timed_out" },
			ignore: [
				"run.updated_at",
				"run.run_started_at",
				"run.head_commit",
				"jobs.jobs.total_count",
				"jobs.jobs.jobs[*].steps",
				"jobs.jobs.jobs[*].started_at",
				"jobs.jobs.jobs[*].completed_at",
				"jobs.jobs.jobs[*].runner_id",
				"jobs.jobs.jobs[*].runner_name",
				"jobs.jobs.jobs[*].runner_group_id",
				"jobs.jobs.jobs[*].runner_group_name",
			],
			rules: [
				{ on: "run.conclusion", to: "failure", does: "wake", says: "failed" },
				{ on: "run.conclusion", to: "startup_failure", does: "wake", says: "failed to start" },
				{ on: "run.conclusion", to: "timed_out", does: "wake", says: "timed out" },
				{ on: "run.conclusion", to: "cancelled", does: "wake", says: "cancelled" },
				{ on: "run.conclusion", to: "success", does: "tell", says: "succeeded" },
				{
					on: "run.conclusion",
					does: "tell",
					says: "{to}",
					words: { action_required: "needs action", neutral: "finished neutral", skipped: "skipped", stale: "stale" },
				},
				// a job may come into the list already failed (it failed between two looks): a condition over the jobs
				// sees that, where a rule on a job's conclusion would see only an item added
				{ on: "derived.job_failed", to: true, does: "wake", says: "a job failed" },
			],
			ends: { completed: "run.status = completed" },
			// a run takes minutes: looked at often until it completes, a failing job's siblings joining its wake
			every: "2m",
			settle: "1m",
		},
		// no `completed`: a run has no completion time of its own, only when it last changed
		fields: {
			name: "run.name",
			status: "run.status",
			conclusion: "run.conclusion",
			steps: "jobs.jobs.jobs",
			started: "run.run_started_at",
			where: "run.head_branch",
			url: "run.html_url",
		},
	},
	notification: {
		card: "notification",
		normalize: { thread: "integer" },
		name: "notification {thread}",
		urls: ["https://api.github.com/notifications/threads/{thread}"],
		ids: ["notification/{thread}"],
		reads: { thread: { tool: "get_notification_details", args: { notificationID: "{thread}" } } },
		// how a watch follows it: new activity on the thread (its updated_at, a new reason) wakes, a new title tells,
		// and it ends once read (marked done, GitHub answers it read too)
		follow: {
			ignore: ["thread.repository", "thread.url", "thread.last_read_at", "thread.subject.latest_comment_url"],
			rules: [
				{
					on: "thread.reason",
					does: "wake",
					says: "{to}",
					words: {
						approval_requested: "approval requested",
						assign: "assigned to you",
						author: "activity on your thread",
						ci_activity: "a workflow run finished",
						comment: "new comment",
						invitation: "invited you",
						manual: "subscribed",
						member_feature_requested: "feature requested",
						mention: "mentioned you",
						review_requested: "review requested",
						security_advisory_credit: "credited in an advisory",
						security_alert: "security alert",
						state_change: "state changed",
						subscribed: "activity",
						team_mention: "your team was mentioned",
					},
				},
				{ on: "thread.updated_at", does: "wake", says: "new activity" },
				{ on: "thread.subject.title", does: "tell", says: "retitled: {to}" },
			],
			ends: { read: "thread.unread = false" },
			every: "5m",
			settle: "1m",
		},
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
	discussion: {
		card: "discussion",
		normalize: { owner: "lowercase", repo: "lowercase", number: "integer" },
		name: "{owner}/{repo} · discussion #{number}",
		urls: ["https://github.com/{owner}/{repo}/discussions/{number}"],
		// not `{owner}/{repo}#{number}`: that names a pull request or an issue first, and a discussion shares their numbers
		ids: ["{owner}/{repo}/discussions/{number}"],
		reads: {
			discussion: {
				tool: "get_discussion",
				args: { owner: "{owner}", repo: "{repo}", discussionNumber: "{number}" },
			},
			// oldest first, a hundred, each with its replies: a comment past the hundredth is not seen, and the count beside
			// the page says when it is short, so none counts as gone
			comments: {
				optional: true,
				follow: true,
				tool: "get_discussion_comments",
				args: { owner: "{owner}", repo: "{repo}", discussionNumber: "{number}", perPage: 100, includeReplies: true },
			},
		},
		// how a watch follows it: new comments and replies wake, answered or closed wakes and ends it, a new title tells.
		// GitHub's answer names no comment's author, so the account's own comments wake too
		follow: {
			totals: { "comments.comments": "comments.totalCount" },
			ignore: [
				"discussion.body",
				"comments.totalCount",
				"comments.pageInfo",
				"comments.comments[*].body",
				"comments.comments[*].replyTotalCount",
				"comments.comments[*].replies[*].body",
			],
			rules: [
				{ on: "discussion.isAnswered", to: true, does: "wake", says: "answered" },
				{ on: "discussion.closed", to: true, does: "wake", says: "closed" },
				{ on: "discussion.closed", to: false, does: "wake", says: "reopened" },
				{ on: "discussion.title", does: "tell", says: "retitled: {to}" },
				{ on: "comments.comments[*]", kind: "added", does: "wake", says: "new comment" },
				{ on: "comments.comments[*].replies[*]", kind: "added", does: "wake", says: "new reply" },
			],
			ends: { answered: "discussion.isAnswered = true", closed: "discussion.closed = true" },
			every: "10m",
			settle: "1m",
		},
		fields: {
			number: "discussion.number",
			title: "discussion.title",
			closed: "discussion.closed",
			answered: "discussion.isAnswered",
			category: "discussion.category.name",
			comments: "comments.totalCount",
			url: "discussion.url",
		},
		writes: [
			{
				tool: "discussion_comment_write",
				id: { owner: "owner", repo: "repo", number: "discussionNumber" },
				verb: "Comment",
				what: "Comment on",
				text: "body",
				verbs: [
					{ when: { method: "reply" }, verb: "Reply", what: "Reply on" },
					{ when: { method: "update" }, verb: "Edit", what: "Edit a comment on" },
					{ when: { method: "delete" }, verb: "Delete", what: "Delete a comment on" },
					{ when: { method: "mark_answer" }, verb: "Mark answer", what: "Mark an answer on" },
					{ when: { method: "unmark_answer" }, verb: "Unmark answer", what: "Unmark the answer on" },
				],
			},
		],
	},
	repository: {
		card: "repository",
		normalize: { owner: "lowercase", repo: "lowercase" },
		name: "{owner}/{repo}",
		// the repository's own page and its tabs (`/pulls`, `/releases`), never a page inside it: a pull request's URL is
		// one more part deeper than a tab, so it is never taken for its repository's
		urls: ["https://github.com/{owner}/{repo}", "https://api.github.com/repos/{owner}/{repo}"],
		// `owner/repo` alone would be any connection's `<connection>/<id>`: the host says it is GitHub's
		ids: ["github.com/{owner}/{repo}"],
		// each the first page of the newest, asking only for the fields it diffs and draws (bodies would outgrow an
		// answer); the pull requests first, the one read every repository answers, so a page that is not a repository
		// fails before the rest are made
		reads: {
			pulls: {
				tool: "list_pull_requests",
				args: {
					owner: "{owner}",
					repo: "{repo}",
					state: "all",
					sort: "created",
					direction: "desc",
					perPage: 30,
					page: 1,
					fields: ["number", "title", "state", "draft", "merged", "user", "created_at"],
				},
			},
			issues: {
				optional: true,
				tool: "list_issues",
				args: {
					owner: "{owner}",
					repo: "{repo}",
					orderBy: "CREATED_AT",
					direction: "DESC",
					perPage: 30,
					fields: ["number", "title", "state", "user", "created_at"],
				},
			},
			releases: {
				optional: true,
				tool: "list_releases",
				args: {
					owner: "{owner}",
					repo: "{repo}",
					perPage: 10,
					page: 1,
					fields: ["id", "tag_name", "name", "html_url", "published_at", "prerelease", "draft", "author"],
				},
			},
			// the default branch's head: one commit, so a push is its sha changing (an empty repository has none)
			commits: {
				optional: true,
				tool: "list_commits",
				args: {
					owner: "{owner}",
					repo: "{repo}",
					perPage: 1,
					page: 1,
					fields: ["sha", "html_url", "commit", "author"],
				},
			},
		},
		// how a watch follows it: a release, and a pull request or an issue opened by someone else, wake; a push to the
		// default branch tells; the account's own are nothing, a bot's only tell; nothing ends it. Pull requests and
		// issues are read open and closed alike, so one closing never moves the page, and each list is a page of the
		// newest: one that slid onto it as another left is nothing
		follow: {
			keys: { pulls: "number", "issues.issues": "number", commits: "sha" },
			newest: { pulls: "number", "issues.issues": "number", releases: "published_at" },
			ignore: ["issues.totalCount", "issues.pageInfo"],
			authors: { pulls: "user.login", "issues.issues": "user.login", commits: "author.login" },
			rules: [
				// a release is the repository's news whoever cut it: most are cut by a workflow's bot, so no author is read
				{ on: "releases[*]", kind: "added", does: "wake", says: "released {tag_name}" },
				{ on: "releases[*].draft", to: false, does: "wake", says: "released {tag_name}" },
				{ on: "pulls[*]", kind: "added", does: "wake", says: "{user.login} opened #{number}: {title}" },
				{ on: "issues.issues[*]", kind: "added", does: "wake", says: "{user.login} opened issue #{number}: {title}" },
				{ on: "commits[*]", kind: "added", does: "tell", says: "new commits on the default branch" },
			],
			ends: {},
			// nothing in a repository is urgent: four reads every quarter of an hour
			every: "15m",
			settle: "1m",
		},
		fields: { pulls: "pulls", issues: "issues.issues", releases: "releases", commits: "commits" },
	},
} as const;
