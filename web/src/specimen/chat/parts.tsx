/** Everything a message can carry, and every card, one by one. */
import {
	BrainIcon,
	CalendarClockIcon,
	CalendarXIcon,
	CircleAlertIcon,
	EyeIcon,
	EyeOffIcon,
	FilePenIcon,
	FileXIcon,
	KeyRoundIcon,
	ShieldCheckIcon,
	SquareIcon,
} from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import { ApprovalCard, ChangeCard, Details, Facts, WaitingPill } from "../../chat/Approval.tsx";
import { ArtifactCard, Browsed, QuestionCard, SignInCard, ViewCard } from "../../chat/Cards.tsx";
import { Composer } from "../../chat/Composer.tsx";
import { Bubble, DaySeparator, JumpToLatest, Mention, Run, UnreadDivider } from "../../chat/Feed.tsx";
import { FileChanges } from "../../chat/FileChanges.tsx";
import {
	AudioFile,
	CodeFile,
	DocumentFile,
	ImageFile,
	PdfFile,
	PlainFile,
	SheetFile,
	VideoFile,
} from "../../chat/Files.tsx";
import { Header } from "../../chat/Header.tsx";
import { Line } from "../../chat/Line.tsx";
import {
	type CheckRun,
	type DriveFile,
	type EmailMessage,
	type Messages,
	ObjectLink,
	PullRequestCard,
} from "../../chat/Object.tsx";
import { RoutineProposal } from "../../chat/Routine.tsx";
import { VoiceMessage } from "../../chat/Voice.tsx";
import { Named, WatchLine, WatchProposal } from "../../chat/Watch.tsx";
import { WorkingLine } from "../../chat/WorkingLine.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { SourceLabels } from "../../components/SourceLink.tsx";
import { watchWords } from "../../lib/chat.ts";
import { PLANNING } from "../connections/calendar.tsx";
import { ANA } from "../connections/contacts.tsx";
import { PLAN } from "../connections/drive.tsx";
import {
	ATLAS,
	ATTACHED,
	CHECK_RUN,
	DISCUSSION,
	ISSUE,
	MARA,
	OCTO,
	OTTO,
	PAGE,
	PHOTO,
	POSTER,
	PR,
	REPLY_VOICE,
	REPOSITORY,
	SANCHO,
	sampleFace,
	VOICE,
} from "../fixtures.ts";
import { FrameContext, Group, HeaderStage, Section } from "../stage.tsx";

/** The objects a watch's lines name, one of each kind banda ships can follow, drawn as the owner's references are. */
const EMAIL: EmailMessage = {
	from: "Ana García <ana@example.com>",
	to: "bandarra@example.com",
	subject: "The launch checklist",
	date: "Today · 10:24",
	snippet: "Three things before Friday…",
	body: "",
	unread: true,
	url: "https://mail.google.com/mail/u/0/#inbox/18f2a",
};
const THREAD: Messages = {
	title: "Re: quarterly planning",
	search: false,
	total: 3,
	messages: [],
	url: "https://mail.google.com/mail/u/0/#all/18e9c",
};
const SEARCH: Messages = {
	title: "from:boss is:unread",
	search: true,
	total: 14,
	messages: [],
	url: "https://mail.google.com/mail/u/0/#search/from%3Aboss%20is%3Aunread",
};
const RUN: CheckRun = {
	...CHECK_RUN,
	name: "ci",
	state: "running",
	step: undefined,
	took: undefined,
	log: undefined,
	url: "https://github.com/purrgrammer/banda/actions/runs/9921",
};
const FOLDER: DriveFile = {
	...PLAN,
	name: "Northstar",
	kind: "folder",
	mimeType: "application/vnd.google-apps.folder",
	description: "",
	url: "https://drive.google.com/drive/folders/1fOlDeR",
};
/** Each object by the name the daemon gives it (a Google object's is its id) and as it is drawn inline. */
const FOLLOWED = {
	pr: {
		name: "purrgrammer/banda #142",
		object: <ObjectLink object={{ ...PR, card: "pull-request" }} href={PR.url ?? ""} />,
	},
	issue: {
		name: "purrgrammer/banda #41",
		object: <ObjectLink object={{ ...ISSUE, card: "issue" }} href={ISSUE.url ?? ""} />,
	},
	check: {
		name: "purrgrammer/banda · check 7781",
		object: <ObjectLink object={{ ...CHECK_RUN, card: "check-run" }} href={CHECK_RUN.url ?? ""} />,
	},
	run: {
		name: "purrgrammer/banda · run 9921",
		object: <ObjectLink object={{ ...RUN, card: "check-run" }} href={RUN.url ?? ""} />,
	},
	// a notification is drawn as the thing it is about, never inline: its line names it
	notification: { name: "notification 2048" },
	repository: {
		name: "purrgrammer/banda",
		object: <ObjectLink object={{ ...REPOSITORY, card: "repository" }} href={REPOSITORY.url ?? ""} />,
	},
	discussion: {
		name: "purrgrammer/banda · discussion #52",
		object: <ObjectLink object={{ ...DISCUSSION, card: "discussion" }} href={DISCUSSION.url ?? ""} />,
	},
	email: { name: "18f2a", object: <ObjectLink object={{ ...EMAIL, card: "email" }} href={EMAIL.url ?? ""} /> },
	thread: {
		name: "conversation 18e9c",
		object: <ObjectLink object={{ ...THREAD, card: "messages" }} href={THREAD.url ?? ""} />,
	},
	search: {
		name: "mail matching from:boss is:unread",
		object: <ObjectLink object={{ ...SEARCH, card: "messages" }} href={SEARCH.url ?? ""} />,
	},
	event: {
		name: "cGxhbm5pbmc",
		object: <ObjectLink object={{ ...PLANNING, card: "event" }} href={PLANNING.url ?? ""} />,
	},
	file: { name: "1aBcD_eFgH-ijk", object: <ObjectLink object={{ ...PLAN, card: "file" }} href={PLAN.url ?? ""} /> },
	folder: {
		name: "folder 1fOlDeR",
		object: <ObjectLink object={{ ...FOLDER, card: "file" }} href={FOLDER.url ?? ""} />,
	},
	contact: { name: "c1234567890", object: <ObjectLink object={{ ...ANA, card: "contact" }} href={ANA.url ?? ""} /> },
};
const AT = (hour: number, minute: number) => new Date(2026, 10, 8, hour, minute).getTime();

/** A watch's line as the chat draws it: `changes` on `of`, with the words `watchWords` gives them. */
function saw(
	of: { readonly name: string; readonly object?: ReactNode },
	changes: readonly string[],
	time: string,
	more: { ended?: string; resumed?: true; gap?: true; burst?: number } = {},
) {
	return (
		<WatchLine
			name={of.name}
			object={of.object}
			ended={more.ended !== undefined}
			time={time}
			text={watchWords({ object: { key: "", ref: "", connection: "", service: "", name: of.name }, changes, ...more })}
		/>
	);
}

/** An agent's name too long for a phone's bubble. */
const LONG_NAME = "Ana María de la Vega Ortega Fernández Hidalgo";

export function Parts() {
	return (
		<>
			<Section id="messages" note="Bubbles in runs; the owner's filled, an agent's framed.">
				<div className="flex max-w-2xl flex-col gap-4">
					<DaySeparator>Today</DaySeparator>
					<Run time="10:20">
						<Bubble>Can you look at flights to Lisbon for the long weekend? Mornings, window seat.</Bubble>
						<Bubble reaction="👍" copy="And ask @Atlas whether Friday is free.">
							And ask <Mention who={ATLAS} /> whether Friday is free.
						</Bubble>
						{/* a mention never breaks across lines; a name too long for the bubble ends in an ellipsis */}
						<Bubble copy="Loop in @Ana María de la Vega Ortega Fernández Hidalgo too.">
							Loop in <Mention who={{ face: sampleFace("sprout", "#56a875"), name: LONG_NAME }} /> too.
						</Bubble>
					</Run>
					<Run who={MARA} time="10:21">
						<Bubble>
							<p>On it. I'll check the three airlines you use and keep to €300.</p>
							<p>
								I asked <Mention who={ATLAS} /> about Friday.
							</p>
							{/* a mention near the end of a line moves to the next one whole, face and name together */}
							<p>
								Friday is clear for now, but before I book anything I want <Mention who={ATLAS} /> and{" "}
								<Mention who={{ face: sampleFace("sprout", "#56a875"), name: LONG_NAME }} /> to agree on the train back.
							</p>
						</Bubble>
					</Run>
					<UnreadDivider count={3} />
					<Run who={MARA} time="10:42" compact>
						<Bubble>Compact, on the phone: the face alone.</Bubble>
					</Run>
					<div className="flex justify-center">
						<JumpToLatest count={3} />
					</div>
				</div>
			</Section>
			<Section id="source-links" note="An icon identifies the source. An empty label uses its message or name.">
				<SourceLabels.Provider
					value={async (href) => ({
						label: href.includes("/artifact/")
							? "Lisbon itinerary"
							: href.includes("/g/")
								? "Morning train confirmed"
								: "Take the 09:15 train",
					})}
				>
					<Markdown>
						{
							"[Our decision](#/a/mara?at=42) · [Group discussion](#/g/7?at=12) · [Itinerary](#/artifact/abcdef0123456789)\n\n[](#/a/mara?at=42) · [](#/g/7?at=12) · [](#/artifact/abcdef0123456789)"
						}
					</Markdown>
				</SourceLabels.Provider>
			</Section>
			<Section id="message-layout" note="Copy keeps its own space beside the words; headings keep theirs.">
				<Run time="10:42">
					<Bubble copy="Hi">Hi</Bubble>
				</Run>
				{[1, 2, 3].map((level) => {
					const text = `${"#".repeat(level)} First heading\n\nThe first heading starts at the message's top inset.\n\n${"#".repeat(level)} Next heading\n\nThis one keeps space above it.`;
					return (
						<Run key={level} who={MARA}>
							<Bubble copy={text}>
								<Markdown>{text}</Markdown>
							</Bubble>
						</Run>
					);
				})}
			</Section>
			<Section id="files" note="Every file previews: images zoom, a PDF shows its first page, a sheet its rows.">
				<Group label="Image · PDF · video" className="items-start">
					<ImageFile src={PHOTO} alt="coast.jpg" width={260} />
					<PdfFile
						file={{ name: "Booking terms.pdf", size: "1.2 MB" }}
						pages={12}
						title="Booking terms and conditions"
						lines={[
							"1. Who these terms are between",
							"These terms are between you and Alfama Stays, Rua dos Remédios 12, Lisbon.",
							"2. Your booking",
							"A booking is confirmed once paid in full.",
						]}
					/>
					<PdfFile file={{ name: "Scan.pdf", size: "3 MB" }} pages={1} />
					<VideoFile file={{ name: "street.mov", size: "18 MB" }} duration="0:42" poster={POSTER} />
					<PlainFile file={{ name: "backup.zip", size: "48 MB" }} />
				</Group>
				<Group label="Document · sheet · code" className="items-start">
					<DocumentFile
						file={{ name: "Itinerary.md", size: "4 KB" }}
						lines={[
							"Friday: 9:15 to Lisbon, window 14A",
							"Hotel in Alfama, two nights",
							"Saturday: lunch with Inês",
							"Sunday: back at 18:40",
						]}
					/>
					<SheetFile
						file={{ name: "Flights.csv", size: "2 KB" }}
						total={214}
						rows={[
							["Flight", "Leaves", "Price"],
							["TP 1351", "9:15", "€214"],
							["FR 7211", "6:40", "€96"],
							["IB 3105", "11:05", "€288"],
						]}
					/>
					<CodeFile
						file={{ name: "fetch_prices.py", size: "1 KB" }}
						language="Python"
						highlightAs="python"
						code={
							'import httpx\n\ndef prices(route: str) -> list[float]:\n    r = httpx.get(f"https://api.example/{route}")\n    return [f["price"] for f in r.json()]'
						}
					/>
				</Group>
				<Group label="Audio" className="items-start">
					<AudioFile file={{ name: "call.m4a", size: "3 MB" }} duration="2:14" />
					<AudioFile file={{ name: "call.m4a", size: "3 MB" }} duration="0:51 / 2:14" playing />
				</Group>
			</Section>
			<Section
				id="voice"
				note="A voice message either way: yours transcribed and sent with its audio, an agent's answered aloud."
			>
				<div className="flex max-w-2xl flex-col gap-4">
					<Run time="10:20">
						<VoiceMessage mine duration="0:05" segments={VOICE} />
					</Run>
					<Run who={MARA} time="10:44">
						<VoiceMessage duration="0:04" segments={REPLY_VOICE} at={2} playing />
					</Run>
				</div>
			</Section>
			<Section id="cards" note="What an agent made, sees, asks, or hands you.">
				<div className="flex max-w-2xl flex-col gap-3">
					<ArtifactCard title="Lisbon long weekend" kind="Plan" version="3 versions · you edited the last" />
					<ViewCard host="flights.example" title="Lisbon, Fri 14 Nov" shot={PAGE} />
					<Group label="After the browser closed: what it opened stays, where it happened">
						<Browsed pages={["https://en.wikipedia.org/wiki/Lisbon"]} />
						<Browsed
							pages={[
								"https://en.wikipedia.org/wiki/Braga",
								"https://en.wikipedia.org/wiki/Porto",
								"https://en.wikipedia.org/wiki/Coimbra",
							]}
						/>
					</Group>
					<Group label="Reading the web: the pages a stretch of reads read, the same quiet line">
						<Browsed verb="Read" pages={["https://docs.python.org/3/library/asyncio.html"]} />
						<Browsed
							verb="Read"
							pages={[
								"https://www.visitportugal.com/en/content/lisbon-card",
								"https://en.wikipedia.org/wiki/Lisbon_Metro",
							]}
						/>
					</Group>
					<QuestionCard
						question="Which flight should I book?"
						choices={["TP 1351 at 9:15", "IB 3105 at 11:05", "Neither"]}
					/>
					<QuestionCard
						question="Which flight should I book?"
						choices={[]}
						state={{ kind: "answered", answer: "TP 1351 at 9:15" }}
					/>
					<SignInCard agent="Mara" site="flights.example" />
					<PullRequestCard pr={PR} />
					<PullRequestCard
						pr={{
							...PR,
							number: 35,
							state: "draft",
							title: "Routines wake in their agent's chat",
							checks: { passed: 6, failed: 1, running: 0 },
							reviews: "None yet",
							asOf: "9:12",
						}}
					/>
				</div>
			</Section>
			<Section
				id="approvals"
				note="The approval card, the same for every agent: what will happen, as whom, the verb as the button, at most one scope."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<Group label="Allow → Approved · same card height" className="flex-col items-start">
						{(["open", "done"] as const).map((kind) => (
							<ApprovalCard
								key={kind}
								agent="Sancho"
								what="Use GitHub's label_write as @purrgrammer"
								verb="Allow"
								as="@purrgrammer on GitHub"
								state={kind === "open" ? { kind } : { kind, words: "Approved" }}
							/>
						))}
					</Group>
					<ApprovalCard
						agent="Octo"
						what="Comment on purrgrammer/banda #34"
						verb="Comment"
						as="@bandarra on GitHub"
						object={<PullRequestCard pr={PR} />}
						text={"Looks good to me. One nit: the routine card still says routine.\nOtherwise ready to merge."}
						scope="Don't ask again for this task"
					/>
					<ApprovalCard
						agent="Mara"
						what="Send an email to Inês"
						verb="Send"
						text={"Hi Inês, we land Friday at 11:30. Lunch on Saturday?"}
						state={{ kind: "open", editing: true }}
					/>
					<ApprovalCard
						agent="Octo"
						what="Merge purrgrammer/banda #34"
						verb="Merge"
						as="@bandarra on GitHub"
						state={{ kind: "done", words: "Merged · 10:52" }}
					/>
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
									["Changes", "Free until Wed; no refund after"],
								]}
							/>
						}
						state={{ kind: "declined" }}
					/>
					<ApprovalCard
						agent="Mara"
						what="send a request from www.cp.pt to api-gateway.cp.pt/cp/services/travel-api/journeys"
						verb="Send"
						object={
							<>
								<Facts
									rows={[
										["sends › departureStationCode", "94-31039"],
										["sends › arrivalStationCode", "94-2006"],
										["sends › travelDate", "2026-12-12"],
										["sends › filters", "(3 fields)"],
									]}
								/>
								<Details
									rows={[
										["page", "www.cp.pt"],
										["method", "POST"],
										["address", "https://api-gateway.cp.pt/cp/services/travel-api/journeys"],
										[
											"headers",
											[
												"Origin: https://www.cp.pt",
												"Content-Type: application/json",
												"x-api-key: ca39… (32 characters)",
												"x-cp-connect-id: 5f0e… (36 characters)",
												"x-cp-connect-secret: hidden (12 characters)",
											].join("\n"),
										],
										[
											"body",
											'{"departureStationCode":"94-31039","arrivalStationCode":"94-2006","travelDate":"2026-12-12","filters":{"class":2,"adults":1,"children":0}}',
										],
									]}
								/>
							</>
						}
					/>
					<ApprovalCard
						agent="Octo"
						what="Push 3 files to purrgrammer/banda"
						verb="Push"
						as="@bandarra on GitHub"
						object={
							<>
								<Facts
									rows={[
										["branch", "routines-in-chat"],
										["message", "feat: routines wake in their agent's chat"],
									]}
								/>
								<FileChanges
									files={[
										{
											path: "src/core/routines.ts",
											content: 'export function wake(routine: string) {\n\treturn "woke " + routine;\n}\n',
											lines: 3,
										},
										{ path: "src/core/routines.test.ts", content: 'import { wake } from "./routines.ts";\n', lines: 1 },
										{ path: "README.md", content: "# banda\n\nRoutines wake in chat.\n", lines: 3 },
									]}
								/>
							</>
						}
					/>
					<ApprovalCard
						agent="Sancho"
						what="Create an issue on purrgrammer/banda"
						verb="Create"
						as="@purrgrammer on GitHub"
						object={<Facts rows={[["title", "Approval cards say a tool's name as a verb"]]} />}
						text={"The card for issue_write read “issue write” and its button said “Issue”."}
						scope="Create an issue on purrgrammer/banda as @purrgrammer without asking until this task is done"
					/>
					<ApprovalCard
						agent="Sancho"
						what="Use GitHub's label_write as @purrgrammer"
						verb="Allow"
						as="@purrgrammer on GitHub"
						object={
							<Facts
								rows={[
									["method", "create"],
									["name", "needs-review"],
								]}
							/>
						}
						scope="Use GitHub's label_write as @purrgrammer without asking until this task is done"
					/>
					<ChangeCard
						agent="Mara"
						what="its personality"
						after={
							"Warm and brief. Plans trips for the family, keeps to the budget, prefers morning flights and window seats, and asks before booking."
						}
						before={"Warm and brief. Plans trips for the family and asks before booking."}
					/>
				</div>
			</Section>
			<Section
				id="working"
				note="At the foot of the feed while agents work and have shown nothing yet: their faces and Working…, gone at the first thing they show. A tap opens the activity. The header says nothing of the work."
			>
				<Group label="A chat with one agent">
					<div className="flex max-w-xl flex-col gap-3">
						<Run time="10:41">
							<Bubble mine>Which train should I take to Madrid on Saturday?</Bubble>
						</Run>
						<WorkingLine who={[OCTO]} onOpen={() => {}} />
					</div>
				</Group>
				<Group label="A group: one member at work">
					<WorkingLine who={[MARA]} onOpen={() => {}} />
				</Group>
				<Group label="Two members">
					<WorkingLine who={[MARA, SANCHO]} onOpen={() => {}} />
				</Group>
				<Group label="Three members">
					<WorkingLine who={[MARA, SANCHO, OCTO]} onOpen={() => {}} />
				</Group>
				<Group label="Five members: three faces and a count">
					<WorkingLine who={[MARA, SANCHO, OCTO, ATLAS, OTTO]} onOpen={() => {}} />
				</Group>
				<Group label="At phone width">
					<div className="flex w-full max-w-[390px] flex-col gap-3 rounded-card border border-line-soft bg-paper p-4">
						<Run time="10:05">
							<Bubble mine>
								<Mention who={MARA} /> book the 9:15. <Mention who={SANCHO} /> add it to my calendar.
							</Bubble>
						</Run>
						<WorkingLine who={[MARA, SANCHO]} onOpen={() => {}} />
					</div>
				</Group>
				<Group label="The header while it works: the face at rest, no words">
					<HeaderStage>
						<Header name="Octo" faces={[OCTO]} state="working" />
					</HeaderStage>
				</Group>
			</Section>
			<Section id="lines" note="What no one said: a routine ran, a sign-in to finish, a failure, a run you stopped.">
				<div className="flex flex-col gap-3">
					<Line icon={CalendarClockIcon} time="8:00">
						Morning brief ran
					</Line>
					<Line icon={KeyRoundIcon} action={{ label: "Finish" }}>
						GitHub sign-in isn't finished
					</Line>
					<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Try again" }}>
						Your message didn't reach Mara
					</Line>
					<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Try again" }}>
						Mara didn't answer
					</Line>
					<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Try again" }}>
						Mara's message didn't reach you
					</Line>
					<Line icon={SquareIcon}>Stopped. Send a message to go on.</Line>
				</div>
			</Section>
			<Section
				id="routine-items"
				note="An agent's routine waits for you as its card; once answered, and each time it runs, it is a line."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<RoutineProposal
						routine={{
							agent: "Atlas",
							title: "Morning brief",
							kind: "new",
							when: "Weekdays at 08:00",
							next: ["Thu 08:00", "Fri 08:00", "Mon 08:00"],
							ask: "Tell me what is on my plate today: meetings, deadlines, and anything waiting on me.",
						}}
					/>
					<RoutineProposal
						routine={{
							agent: "Octo",
							title: "PR watch",
							kind: "changed",
							when: "Every 2 hours",
							next: ["10:00", "12:00"],
							ask: "Check my open pull requests and tell me only when one needs me.",
						}}
					/>
					<RoutineProposal
						routine={{ agent: "Sancho", title: "Portugal fun fact", kind: "removed", when: "", next: [], ask: "" }}
					/>
					<Line icon={CalendarClockIcon}>Setting up Morning brief…</Line>
					<Line icon={CalendarClockIcon}>Morning brief set up · weekdays at 08:00</Line>
					<Line icon={CalendarXIcon}>Lisbon weekday weather not set up</Line>
					<Line icon={CalendarXIcon}>Portugal fun fact stopped</Line>
					<Line icon={CalendarClockIcon} time="08:00">
						Morning brief ran
					</Line>
				</div>
			</Section>
			<Section
				id="watch-items"
				note="Each change a kind's rules say matters is a line in the chat's own voice, the object drawn as your own references are; the eyes mark following and its end, nothing else. One line of each kind banda ships can follow."
			>
				<div className="flex max-w-2xl flex-col gap-5">
					<div className="flex flex-col gap-3">
						<WatchProposal
							watch={{
								agent: "Mara",
								title: "purrgrammer/banda #142",
								object: <Named>{FOLLOWED.pr.object}</Named>,
								kind: "new",
								until: "merged",
								account: "@bandarra",
								ask: "Tell me when it is approved or a check fails. If Ana asks for changes, summarise what she wants.",
							}}
						/>
						<Line icon={EyeIcon}>
							Mara followed <Named>{FOLLOWED.pr.object}</Named>
						</Line>
						<Line icon={EyeOffIcon}>Mara isn't following purrgrammer/banda #150</Line>
						<Line icon={EyeIcon} tone="danger">
							Mara couldn't follow it: no connection you have recognises that link
						</Line>
					</div>
					<Group label="GitHub" className="flex-col items-stretch">
						{saw(FOLLOWED.pr, ["ana approved", "lint failed"], "09:10")}
						<PullRequestCard pr={{ ...PR, checks: { passed: 2, failed: 1, running: 0 }, reviews: "Approved by ana" }} />
						{saw(FOLLOWED.pr, ["ana requested changes", "bob commented", "lint failed"], "10:02", {
							burst: AT(9, 58),
						})}
						{saw(FOLLOWED.pr, ["checks finished"], "10:40")}
						{saw(FOLLOWED.pr, ["lint failed", "ana commented"], "11:30", { resumed: true })}
						{saw(FOLLOWED.pr, ["lint failed"], "12:05", { gap: true })}
						{saw(FOLLOWED.pr, ["merged"], "17:02", { ended: "merged" })}
						{saw(FOLLOWED.issue, ["bob commented", "labelled bug"], "11:15")}
						{saw(FOLLOWED.issue, ["assigned to bandarra"], "11:20")}
						{saw(FOLLOWED.issue, ["closed"], "16:48", { ended: "closed" })}
						{saw(FOLLOWED.check, ["failed"], "09:31", { ended: "completed" })}
						{saw(FOLLOWED.run, ["a job failed"], "09:33")}
						{saw(FOLLOWED.run, ["succeeded"], "09:52", { ended: "completed" })}
						{saw(FOLLOWED.notification, ["new comment"], "10:05")}
						{saw(FOLLOWED.notification, [], "10:30", { ended: "read" })}
						{saw(
							FOLLOWED.repository,
							["ana-k opened #143: Follow a repository's releases", "released v0.1.0-alpha.6"],
							"08:40",
						)}
						{saw(FOLLOWED.repository, ["new commits on the default branch"], "09:05")}
						{saw(FOLLOWED.discussion, ["new reply"], "14:12")}
						{saw(FOLLOWED.discussion, ["answered"], "15:30", { ended: "answered" })}
					</Group>
					<Group label="Gmail" className="flex-col items-stretch">
						{saw(FOLLOWED.email, ["starred"], "10:26")}
						{saw(FOLLOWED.email, [], "10:41", { ended: "read" })}
						{saw(FOLLOWED.thread, ["Mira from Northstar <mira@northstar.example> replied"], "16:42")}
						{saw(FOLLOWED.thread, ["archived"], "17:10")}
						{saw(FOLLOWED.search, ["Inês Duarte <ines@example.com>: Numbers for Thursday's review"], "11:02")}
					</Group>
					<Group label="Calendar" className="flex-col items-stretch">
						{saw(FOLLOWED.event, ["Mira accepted", "Teo declined"], "09:20")}
						{saw(FOLLOWED.event, ["location: Northstar HQ, 4th floor", "Bo Lindqvist invited"], "12:00")}
						{saw(FOLLOWED.event, ["cancelled"], "18:05", { ended: "cancelled" })}
					</Group>
					<Group label="Drive" className="flex-col items-stretch">
						{saw(FOLLOWED.file, ["Ana García edited it"], "16:42")}
						{saw(FOLLOWED.file, ["renamed: Q1 rollout plan v2", "shared with Teo Ruiz"], "16:50")}
						{saw(FOLLOWED.file, ["trashed"], "18:30", { ended: "trashed" })}
						{saw(FOLLOWED.folder, ["new file: Q1 budget"], "13:15")}
					</Group>
					<Group label="Contacts" className="flex-col items-stretch">
						{saw(FOLLOWED.contact, ["new phone +34 611 111 111", "now at Aurora", "title: Lead"], "08:02")}
					</Group>
					<Group label="Health" className="flex-col items-stretch">
						<Line icon={CircleAlertIcon} tone="danger" time="13:10">
							purrgrammer/banda #98 · can't reach GitHub since 12:10 · GitHub did not answer
						</Line>
						<Line icon={CircleAlertIcon} tone="danger" time="15:40">
							purrgrammer/banda #120 · paused: it woke 24 times today, the most it may. Resume it in the panel
						</Line>
					</Group>
				</div>
			</Section>
			<Section
				id="feed-lines"
				note="Memory, work done within a permission, a refusal, a change to the band's files; one quiet line each."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<Line icon={BrainIcon}>Remembered: your sister Ana lives in Lisbon; her birthday is 12 December</Line>
					<Line icon={BrainIcon}>Forgot: you prefer aisle seats</Line>
					<Line icon={ShieldCheckIcon}>Commented on purrgrammer/banda #34, as you allowed for this task</Line>
					<Line icon={CircleAlertIcon} tone="danger">
						Not done: that site is not on the list your computer may reach
					</Line>
					<Line icon={FilePenIcon}>Allowed: the routine Morning briefing</Line>
					<Line icon={FileXIcon}>Not allowed: a change to Mara's file</Line>
					<ApprovalCard
						agent="Octo"
						what="set up a routine: Morning briefing"
						verb="Allow"
						object={<Facts rows={[["What it does", "Summarises the day's mail at nine"]]} />}
					/>
				</div>
			</Section>
			<Section
				id="composer"
				note="Words, files and a voice message, the same while the agent works: what is sent shows at once. Send is off until there is something to send. The last one keeps its draft across a reload."
			>
				<div className="flex max-w-2xl flex-col gap-5">
					<Composer to="Mara" />
					<Composer to="Mara" files={ATTACHED} draft="Here are the photos and the terms. Which hotel is closer?" />
					<Composer to="Octo" draft="Also check the 10:40, it might be cheaper." />
					<Composer to="Mara" state="recording" />
					<Composer to="Trip" group />
					<div className="flex justify-center">
						<WaitingPill ask="book the 9:15 to Lisbon?" />
					</div>
					<SteerComposer />
				</div>
			</Section>
			<Section id="object-in-chat" note="A link the daemon knows unfurls beneath the words.">
				<div className="flex max-w-2xl flex-col gap-2">
					<Run who={OCTO} time="10:31">
						<Bubble>CI is green again on github.com/purrgrammer/banda/pull/34.</Bubble>
						<PullRequestCard pr={PR} />
					</Run>
				</div>
			</Section>
		</>
	);
}

/** A composer while Octo works, live: what is sent goes in the queue (listed under it), and its draft is kept. */
function SteerComposer() {
	const scheme = useContext(FrameContext);
	const [sent, setSent] = useState<readonly string[]>([]);
	return (
		<div id="composer-steer" className="flex flex-col gap-2">
			<Composer
				to="Octo"
				keep={`specimen:steer:${scheme}`}
				onSend={async (text, files) => {
					// on its way a moment, as over a network: words written meanwhile stay in the composer
					await new Promise((resolve) => setTimeout(resolve, 600));
					setSent((was) => [...was, [text, ...files.map((file) => file.name)].filter(Boolean).join(" + ")]);
				}}
			/>
			<ul data-sent className="px-3 text-meta text-ink-2">
				{sent.map((each, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixture's log, appended only
					<li key={index}>Sent: {each}</li>
				))}
			</ul>
		</div>
	);
}
