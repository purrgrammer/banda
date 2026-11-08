/** Exploration: a dialog with nothing left to do folds into one row of the feed. */
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApprovalCard, Facts } from "../../chat/Approval.tsx";
import { Done, type DoneObject, Settling } from "../../chat/Done.tsx";
import { Bubble, Run } from "../../chat/Feed.tsx";
import { IssueCard, PullRequestCard } from "../../chat/Object.tsx";
import { RoutineProposal } from "../../chat/Routine.tsx";
import { MARA, OCTO, PR, SANCHO } from "../fixtures.ts";
import { Group, Section } from "../stage.tsx";

const PR_URL = "https://github.com/purrgrammer/banda/pull/34";
const ISSUE = {
	repo: "purrgrammer/banda",
	number: 41,
	title: "Approval cards say a tool's name as a verb",
	state: "open",
	author: "purrgrammer",
	labels: ["ui"],
	comments: 0,
	url: "https://github.com/purrgrammer/banda/issues/41",
} as const;
const COMMENT = "Looks good to me. One nit: the routine card still says routine.\nOtherwise ready to merge.";

const PR_OPEN: DoneObject = { object: { ...PR, card: "pull-request" }, href: PR_URL };
const PR_MERGED: DoneObject = { object: { ...PR, state: "merged", card: "pull-request" }, href: PR_URL };
const PR_35: DoneObject = {
	object: { ...PR, number: 35, state: "open", title: "Routines wake in their agent's chat", card: "pull-request" },
	href: "https://github.com/purrgrammer/banda/pull/35",
};
const ISSUE_OPEN: DoneObject = { object: { ...ISSUE, card: "issue" }, href: ISSUE.url };
const ISSUE_CLOSED: DoneObject = {
	object: { ...ISSUE, number: 29, title: "Rename source", state: "completed", card: "issue" },
	href: "https://github.com/purrgrammer/banda/issues/29",
};

const MERGE_CARD = (
	<ApprovalCard
		agent="Octo"
		what="Merge purrgrammer/banda #34"
		verb="Merge"
		as="@bandarra on GitHub"
		object={<PullRequestCard pr={{ ...PR, state: "merged" }} />}
		state={{ kind: "done", words: "Merged · 10:55" }}
	/>
);

function Fold() {
	const [allowed, setAllowed] = useState(false);
	return (
		<div className="flex flex-col gap-2">
			<Settling
				settled={allowed}
				card={
					<ApprovalCard
						agent="Octo"
						what="Comment on purrgrammer/banda #34"
						verb="Comment"
						as="@bandarra on GitHub"
						object={<PullRequestCard pr={PR} />}
						text={COMMENT}
						state={allowed ? { kind: "done", words: "Commented · 10:52" } : { kind: "open" }}
						onApprove={() => setAllowed(true)}
					/>
				}
				row={
					<Done
						kind="comment"
						action="commented on"
						reference={PR_OPEN}
						time="10:52"
						card={
							<ApprovalCard
								agent="Octo"
								what="Comment on purrgrammer/banda #34"
								verb="Comment"
								as="@bandarra on GitHub"
								text={COMMENT}
								state={{ kind: "done", words: "Commented · 10:52" }}
							/>
						}
					/>
				}
			/>
			<Button variant="ghost" size="sm" className="self-start" disabled={!allowed} onClick={() => setAllowed(false)}>
				<RotateCcwIcon /> Ask again
			</Button>
		</div>
	);
}

export function DoneSection() {
	return (
		<Section id="done" note="A card with nothing left to do folds into one row; the chevron opens the card it was.">
			<div className="flex max-w-2xl flex-col gap-6">
				<Group label="Allow it: the card folds (a chat with Octo)" className="flex-col flex-nowrap items-stretch">
					<Fold />
				</Group>
				<Group label="A chat with Octo: no face, no name" className="flex-col flex-nowrap items-stretch">
					<div className="flex flex-col gap-3">
						<Run time="10:40">
							<Bubble>Tidy up #34 and get it in. File the nit as an issue.</Bubble>
						</Run>
						<div className="flex flex-col">
							<Done kind="review" action="approved" reference={PR_OPEN} time="10:51" />
							<Done kind="comment" action="commented on" reference={PR_OPEN} time="10:52" />
							<Done
								kind="issue"
								action="opened"
								reference={ISSUE_OPEN}
								time="10:52"
								card={<IssueCard issue={ISSUE} />}
							/>
							<Done kind="label" action="labelled ui" reference={ISSUE_OPEN} time="10:53" />
							<Done
								kind="push"
								action="pushed 3 files to"
								reference={{ where: "terminology", title: "feat: routines wake in their agent's chat" }}
								time="10:54"
							/>
							<Done kind="merge" action="merged" reference={PR_MERGED} time="10:55" card={MERGE_CARD} />
						</div>
						<Run who={OCTO} time="10:55" compact>
							<Bubble>Merged #34 and filed the nit as #41.</Bubble>
						</Run>
					</div>
				</Group>
				<Group label="A group: who did what" className="flex-col flex-nowrap items-stretch">
					<div className="flex flex-col gap-3">
						<Run time="9:02">
							<Bubble>Make me an agent for trips, have it book the 9:15, and Octo: merge #34.</Bubble>
						</Run>
						<div className="flex flex-col">
							<Done
								kind="agent"
								who={SANCHO}
								action="made the agent"
								reference={{ agent: MARA, title: "plans trips, keeps to the budget" }}
								time="9:03"
								card={
									<ApprovalCard
										agent="Sancho"
										what="Make an agent: Mara"
										verb="Make"
										object={
											<Facts
												rows={[
													["name", "Mara"],
													["personality", "Warm and brief. Plans trips for the family, keeps to the budget."],
													["may use", "Browser, email"],
												]}
											/>
										}
										state={{ kind: "done", words: "Made · 9:03" }}
									/>
								}
							/>
							<Done
								kind="permission"
								who={MARA}
								action="may now use"
								reference={{ where: "flights.example", title: "for this task" }}
								time="9:05"
								card={
									<ApprovalCard
										agent="Mara"
										what="Reach flights.example"
										verb="Allow"
										scope="Don't ask again for this task"
										state={{ kind: "done", words: "Allowed for this task · 9:05" }}
									/>
								}
							/>
							<Done
								kind="answer"
								who={MARA}
								action="asked, you chose"
								reference={{ where: "TP 1351 at 9:15", title: "Which flight should I book?" }}
								time="9:09"
							/>
							<Done
								kind="book"
								who={MARA}
								action="booked"
								reference={{ where: "TP 1351", title: "€214 · Fri 14 Nov, 9:15 · 14A" }}
								time="9:10"
								card={
									<ApprovalCard
										agent="Mara"
										what="Book TP 1351 for €214"
										verb="Book"
										object={
											<Facts
												rows={[
													["Flight", "TP 1351, Fri 14 Nov, 9:15 to 9:35"],
													["Seat", "14A, window"],
													["Price", "€214, paid with Visa ending 6411"],
												]}
											/>
										}
										state={{ kind: "done", words: "Booked · 9:10" }}
									/>
								}
							/>
							<Done
								kind="send"
								who={MARA}
								action="emailed"
								reference={{ where: "Inês", title: "we land Friday at 11:30" }}
								time="9:11"
								card={
									<ApprovalCard
										agent="Mara"
										what="Send an email to Inês"
										verb="Send"
										text="Hi Inês, we land Friday at 11:30. Lunch on Saturday?"
										state={{ kind: "done", words: "Sent · 9:11" }}
									/>
								}
							/>
							<Done kind="merge" who={OCTO} action="merged" reference={PR_MERGED} time="9:11" card={MERGE_CARD} />
							<Done
								kind="change"
								who={MARA}
								action="updated"
								reference={{ agent: MARA, title: "personality: prefers morning flights, window seats" }}
								time="9:12"
							/>
							<Done
								kind="routine"
								who={MARA}
								action="set up"
								reference={{ routine: { title: "Fare watch", when: "daily at 08:00" }, onOpen: () => {} }}
								time="9:12"
								card={
									<RoutineProposal
										routine={{
											agent: "Mara",
											title: "Fare watch",
											kind: "new",
											when: "Daily at 08:00",
											next: ["Sat 08:00", "Sun 08:00"],
											ask: "Check fares to Lisbon for the long weekend; tell me only if one drops below €200.",
										}}
										settled="Set up · 9:12"
									/>
								}
							/>
						</div>
						<Run who={MARA} time="9:12">
							<Bubble>Booked, window 14A. I told Inês, and I'll watch fares each morning.</Bubble>
						</Run>
					</div>
				</Group>
				<Group label="Opened: the card it was, settled" className="flex-col flex-nowrap items-stretch">
					<Done kind="merge" action="merged" reference={PR_MERGED} time="10:55" open card={MERGE_CARD} />
				</Group>
				<Group label="Every kind · declined stays, struck" className="flex-col flex-nowrap items-stretch">
					<div className="flex flex-col">
						<Done kind="pull-request" action="opened" reference={PR_35} />
						<Done kind="close" action="closed" reference={ISSUE_CLOSED} />
						<Done
							kind="declined"
							action="didn't merge"
							reference={PR_35}
							card={
								<ApprovalCard
									agent="Octo"
									what="Merge purrgrammer/banda #35"
									verb="Merge"
									as="@bandarra on GitHub"
									object={<Facts rows={[["checks", "6 passed, 1 failing"]]} />}
									state={{ kind: "declined" }}
								/>
							}
						/>
					</div>
				</Group>
			</div>
		</Section>
	);
}
