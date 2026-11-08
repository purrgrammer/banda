/** GitHub's objects: a pull request, an issue, a check run and a notification, in every state, with a draft on each. */
import { DraftApproval } from "../../app/DraftApproval.tsx";
import { ObjectReading } from "../../app/Objects.tsx";
import { ApprovalCard } from "../../chat/Approval.tsx";
import { Bubble } from "../../chat/Feed.tsx";
import { ObjectUnavailable } from "../../chat/Loading.tsx";
import {
	CheckRunCard,
	IssueCard,
	NotificationCard,
	ObjectLink,
	ObjectReference,
	PullRequestCard,
} from "../../chat/Object.tsx";
import { CHECK_RUN, ISSUE, PR } from "../fixtures.ts";
import { Labelled, Section } from "../stage.tsx";

/** A fixed time the specimen's readings are dated from: Monday 2 November 2026, 09:00. */
const SPECIMEN_NOW = new Date(2026, 10, 2, 9, 0).getTime();

export function GithubSection() {
	return (
		<Section
			id="github"
			note="A pull request, an issue, a check run, and a notification as its subject; each in its states, and with a draft."
		>
			<div className="grid gap-6 lg:grid-cols-2">
				<Labelled label="Quiet actions and details · long metadata">
					<ObjectReading
						chat={1}
						onRefresh={() => {}}
						shown={{
							shown: "card",
							key: "specimen-long",
							name: "banda #34",
							connection: "github",
							service: "GitHub",
							account: "@bandarra",
							at: SPECIMEN_NOW,
							old: true,
							card: {
								...PR,
								card: "pull-request",
								repo: "an-organisation-with-a-long-name/a-repository-with-a-very-long-name-that-must-not-stretch-the-chat",
								title:
									"A realistic pull request title that keeps its full meaning even on a narrow phone and can wrap safely",
								branch: "ernesto/6aa9457fc87469c60ed88413/qa-commit-a-failed-web-case-s-proven-pre-cb5c56",
								url: "https://github.com/purrgrammer/banda/pull/34",
							},
						}}
					/>
				</Labelled>
				<Labelled label="Owner reference: source icon, object-type icon and linked title; aligned with the words, no metadata or card">
					<Bubble mine>
						Approve and merge{" "}
						<ObjectLink object={{ ...PR, card: "pull-request" }} href="https://github.com/purrgrammer/banda/pull/34" />
					</Bubble>
				</Labelled>
				<Labelled label="Pull requests: open · failing · running · draft · merged · closed, an old reading">
					<div className="flex flex-col gap-3">
						<PullRequestCard pr={PR} />
						<PullRequestCard pr={{ ...PR, checks: { passed: 9, failed: 2, running: 0 }, reviews: "None yet" }} />
						<PullRequestCard
							pr={{ ...PR, checks: { passed: 6, failed: 0, running: 5 }, reviews: "Ana requested changes" }}
						/>
						<PullRequestCard pr={{ ...PR, state: "draft", reviews: "None yet" }} />
						<PullRequestCard pr={{ ...PR, state: "merged" }} />
						<PullRequestCard pr={{ ...PR, state: "closed", asOf: "2 Nov, 09:40" }} />
						<PullRequestCard pr={{ ...PR, checks: { passed: 0, failed: 0, running: 0 } }} />
						<PullRequestCard
							pr={{ ...PR, state: "unknown", checks: null, reviews: "Unavailable", added: null, removed: null }}
						/>
					</div>
				</Labelled>
				<Labelled label="Issues: open · closed · not planned">
					<div className="flex flex-col gap-3">
						<IssueCard issue={ISSUE} />
						<IssueCard issue={{ ...ISSUE, state: "completed", comments: 5 }} />
						<IssueCard issue={{ ...ISSUE, state: "unknown", comments: null }} />
						<IssueCard
							issue={{
								...ISSUE,
								state: "not-planned",
								assignee: undefined,
								labels: ["idea"],
								comments: 1,
								asOf: "yesterday",
							}}
						/>
					</div>
				</Labelled>
				<Labelled label="Check runs: failed · running · queued · passed · cancelled · skipped · neutral · unknown">
					<div className="flex flex-col gap-3">
						<CheckRunCard run={CHECK_RUN} />
						{(["cancelled", "skipped", "neutral", "unknown"] as const).map((state) => (
							<CheckRunCard
								key={state}
								run={{ ...CHECK_RUN, state, step: undefined, took: undefined, log: undefined }}
							/>
						))}
						<CheckRunCard
							run={{ ...CHECK_RUN, state: "running", step: "npm run typecheck", took: "1m 04s", log: undefined }}
						/>
						<CheckRunCard
							run={{ ...CHECK_RUN, name: "lint", state: "queued", step: undefined, took: undefined, log: undefined }}
						/>
						<CheckRunCard
							run={{ ...CHECK_RUN, name: "build", state: "passed", step: undefined, took: "48s", log: undefined }}
						/>
					</div>
				</Labelled>
				<Labelled label="Unrecognised or unavailable explicit object">
					<ObjectReference reference="https://github.com/purrgrammer/banda/discussions/34" />
				</Labelled>
				<Labelled label="Notifications: unread · done">
					<div className="flex flex-col gap-4">
						<NotificationCard reason="review-requested" when="9:40">
							<PullRequestCard pr={PR} />
						</NotificationCard>
						<NotificationCard reason="mention" when="Yesterday" unread={false}>
							<IssueCard issue={ISSUE} />
						</NotificationCard>
						<NotificationCard reason="ci" when="10:12">
							<CheckRunCard run={CHECK_RUN} />
						</NotificationCard>
						<NotificationCard reason="activity" when="">
							<ObjectUnavailable what="Repository activity" why="Subject preview unavailable" fix="Try again" />
						</NotificationCard>
					</div>
				</Labelled>
				<Labelled label="A draft on each: comment · close · re-run · mark done">
					<div className="flex flex-col gap-3">
						<ApprovalCard
							agent="Octo"
							as="@bandarra on GitHub"
							what={`Comment on ${PR.repo} #${PR.number}`}
							verb="Comment"
							object={<PullRequestCard pr={PR} />}
							text="Looks good. One nit: `poll` still appears in docs/routines.md; rename it there too and this is ready."
							scope="Don't ask again for comments on this pull request"
						/>
						<ApprovalCard
							agent="Octo"
							as="@bandarra on GitHub"
							what={`Close ${ISSUE.repo} #${ISSUE.number} as done`}
							verb="Close"
							object={<IssueCard issue={ISSUE} />}
							text="Fixed in #34: the panel keeps the open file across reloads."
						/>
					</div>
				</Labelled>
				<Labelled label="ask_hosts naming *: the wildcard flagged in red">
					<DraftApproval
						chat={0}
						agent={{ name: "Nostr" }}
						label="allow 3 hosts"
						ask={{
							type: "approval",
							tool: "ask_hosts",
							args: { hosts: "relay.damus.io\nnos.lol\n*", why: "read and post to my relays" },
							editable: ["hosts"],
						}}
					/>
				</Labelled>
				<Labelled label="Interrupted attempt: original bytes only, retry or skip">
					<DraftApproval
						chat={0}
						agent={{ name: "Octo" }}
						label="Comment on purrgrammer/banda #34 again"
						ask={{
							type: "approval",
							tool: "github__add_issue_comment",
							interrupted: true,
							as: "@bandarra on GitHub",
							args: { owner: "purrgrammer", repo: "banda", issue_number: 34, body: "Looks good. Ready for review." },
							editable: ["body"],
						}}
					/>
				</Labelled>
				<Labelled label="Answered: done · not sent">
					<div className="flex flex-col gap-3">
						<ApprovalCard
							agent="Octo"
							as="@bandarra on GitHub"
							what="Re-run the failed routine"
							verb="Re-run"
							object={<CheckRunCard run={CHECK_RUN} />}
							state={{ kind: "done", words: "Re-ran at 10:14" }}
						/>
						<ApprovalCard
							agent="Octo"
							as="@bandarra on GitHub"
							what="Mark 4 notifications done"
							verb="Mark done"
							scope="Don't ask again for marking notifications done"
							state={{ kind: "declined" }}
						/>
					</div>
				</Labelled>
			</div>
		</Section>
	);
}
