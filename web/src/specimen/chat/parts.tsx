/** Everything a message can carry, and every card, one by one. */
import {
	BrainIcon,
	CalendarClockIcon,
	CalendarXIcon,
	CircleAlertIcon,
	FilePenIcon,
	FileXIcon,
	KeyRoundIcon,
	ShieldCheckIcon,
	SquareIcon,
} from "lucide-react";
import { useState } from "react";
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
import { Header, workingWords } from "../../chat/Header.tsx";
import { Line } from "../../chat/Line.tsx";
import { PullRequestCard } from "../../chat/Object.tsx";
import { RoutineProposal } from "../../chat/Routine.tsx";
import { VoiceMessage } from "../../chat/Voice.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { SourceLabels } from "../../components/SourceLink.tsx";
import { ATLAS, ATTACHED, MARA, OCTO, PAGE, PHOTO, POSTER, PR, REPLY_VOICE, SANCHO, VOICE } from "../fixtures.ts";
import { Group, HeaderStage, Section } from "../stage.tsx";

export function Parts() {
	return (
		<>
			<Section id="messages" note="Bubbles in runs; the owner's filled, an agent's framed.">
				<div className="flex max-w-2xl flex-col gap-4">
					<DaySeparator>Today</DaySeparator>
					<Run time="10:20">
						<Bubble>Can you look at flights to Lisbon for the long weekend? Mornings, window seat.</Bubble>
						<Bubble reaction="👍" copy="And ask Atlas whether Friday is free.">
							And ask Atlas whether Friday is free.
						</Bubble>
					</Run>
					<Run who={MARA} time="10:21">
						<Bubble>
							<p>On it. I'll check the three airlines you use and keep to €300.</p>
							<p>
								I asked <Mention who={ATLAS} /> about Friday.
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
			<Section
				id="message-layout"
				note="Copy keeps its own space beside the words; the time stays below. A leading heading uses the bubble's inset, later headings keep their separation."
			>
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
			<Section
				id="files"
				note="Sent by you or made by an agent, every file previews: images zoom, a PDF shows its first page, a sheet its rows."
			>
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
				note="A voice message either way: the owner's is transcribed on their side and goes as words with its audio; an agent may answer aloud."
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
				note="The daemon's card, the same for every agent: who it acts as, the verb is the button, the quiet one says what it won't do, at most one scope, never ticked until the owner ticks it. Money gets its facts. A service's tool with no words of its own is named as it is, with Allow."
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
				note="Under the floating face while an agent works: what it does now, shimmering. The feed has no working line."
			>
				<Group label="A chat with one agent">
					<HeaderStage>
						<Header name="Octo" faces={[OCTO]} state="working" doing="Reading the checks on #34…" />
					</HeaderStage>
				</Group>
				<Group label="Working, nothing more said">
					<HeaderStage>
						<Header name="Octo" faces={[OCTO]} state="working" />
					</HeaderStage>
				</Group>
				<Group label="A group: who is at work">
					<HeaderStage>
						<Header
							name="Trip"
							faces={[
								{ ...MARA, state: "working" },
								{ ...SANCHO, state: "working" },
							]}
							state="working"
							doing={workingWords(["Mara", "Sancho"])}
						/>
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
					<Line icon={FilePenIcon}>Allowed: Octo's tool pr-summary</Line>
					<Line icon={FileXIcon}>Not allowed: a change to Mara's file</Line>
					<ApprovalCard
						agent="Octo"
						what="use a tool it made: Pr summary"
						verb="Allow"
						object={<Facts rows={[["What it does", "Summarises a pull request's diff in five lines"]]} />}
					/>
				</div>
			</Section>
			<Section
				id="composer"
				note="Words, files, a voice message (transcribed here, sent with its audio). While the agent works: Stop when empty, Send once something is written, which steers the turn. The last one is live: its draft, words and files, survives a reload."
			>
				<div className="flex max-w-2xl flex-col gap-5">
					<Composer to="Mara" />
					<Composer to="Mara" files={ATTACHED} draft="Here are the photos and the terms. Which hotel is closer?" />
					<Composer to="Octo" state="working" />
					<Composer to="Octo" state="working" draft="Also check the 10:40, it might be cheaper." />
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

/** A composer while Octo works, live: what is sent steers (listed under it), Stop stops, and its draft is kept. */
function SteerComposer() {
	const [sent, setSent] = useState<readonly string[]>([]);
	const [stopped, setStopped] = useState(false);
	return (
		<div id="composer-steer" className="flex flex-col gap-2">
			<Composer
				to="Octo"
				state={stopped ? "ready" : "working"}
				keep="specimen:steer"
				onSend={async (text, files) => {
					// on its way a moment, as over a network: words written meanwhile stay in the composer
					await new Promise((resolve) => setTimeout(resolve, 600));
					setSent((was) => [...was, [text, ...files.map((file) => file.name)].filter(Boolean).join(" + ")]);
				}}
				onStop={() => setStopped(true)}
			/>
			<ul data-sent className="px-3 text-meta text-ink-2">
				{sent.map((each, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixture's log, appended only
					<li key={index}>Steered: {each}</li>
				))}
				{stopped ? <li>Stopped</li> : null}
			</ul>
		</div>
	);
}
