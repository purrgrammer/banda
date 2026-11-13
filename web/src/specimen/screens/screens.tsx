/** Whole screens: the app on the desktop and the phone, first run, the first chat, a group. */
import { CalendarClockIcon } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import { AgentMessage } from "../../chat/AgentMessage.tsx";
import { ApprovalCard, Facts, WaitingPill } from "../../chat/Approval.tsx";
import { Band } from "../../chat/Band.tsx";
import { ViewCard } from "../../chat/Cards.tsx";
import { Composer } from "../../chat/Composer.tsx";
import { ConnectCard } from "../../chat/Connect.tsx";
import { Bubble, DaySeparator, Mention, Run, UnreadDivider } from "../../chat/Feed.tsx";
import { ImageFile } from "../../chat/Files.tsx";
import { BringBlock, type BringHarness, FirstBring, pickKey } from "../../chat/FirstBring.tsx";
import { FirstRun, Starters } from "../../chat/FirstRun.tsx";
import { FirstSkills } from "../../chat/FirstSkills.tsx";
import { Header } from "../../chat/Header.tsx";
import { Line } from "../../chat/Line.tsx";
import { PullRequestCard } from "../../chat/Object.tsx";
import { ProposalCard } from "../../chat/Proposal.tsx";
import { RowActions, type RowView, type Who } from "../../chat/Row.tsx";
import { VoiceMessage } from "../../chat/Voice.tsx";
import { WorkingLine } from "../../chat/WorkingLine.tsx";
import {
	ATLAS,
	MARA,
	OCTO,
	OTTO,
	PAGE,
	PHOTO,
	PR,
	PROVIDERS,
	ROWS,
	SANCHO,
	SIGN_IN_WAYS,
	SKILL_OFFERS,
	VOICE,
} from "../fixtures.ts";
import { Section, StageContext } from "../stage.tsx";

/** A chat: its header, its timeline, its composer. */
export function ChatScreen({
	name,
	face,
	faces,
	group = false,
	pill,
	keyboard = false,
	panelOpen = false,
	children,
}: {
	name: string;
	face?: Who["face"] | undefined;
	faces?: readonly Who[];
	group?: boolean;
	pill?: string;
	/** The phone's keyboard is up: the composer and the pill ride on it. */
	keyboard?: boolean;
	/** The panel is open beside it: its toggle shows pressed. */
	panelOpen?: boolean;
	children: ReactNode;
}) {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<div className="flex min-w-0 flex-1 flex-col bg-paper">
			<Header name={name} face={face} faces={faces} phone={phone} panelOpen={panelOpen} onPanel={() => {}} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div
					className={`flex flex-col gap-4 px-4 pt-4 pb-5 ${group ? "mx-auto max-w-[44rem]" : "[&>[data-compact-agent-run]]:-ms-2"}`}
				>
					{children}
				</div>
			</div>
			<div className="mx-auto flex w-full max-w-[44rem] flex-col items-center gap-2 px-3 pb-3">
				{pill === undefined ? null : <WaitingPill ask={pill} />}
				<Composer to={name} group={group} mentionables={group ? faces : undefined} className="w-full" />
			</div>
			{keyboard ? <Keyboard /> : null}
		</div>
	);
}

/** A stand-in for the phone's keyboard: the space it takes, so the composer can be seen riding on it. */
function Keyboard() {
	const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
	return (
		<div aria-hidden="true" className="flex h-[250px] shrink-0 flex-col gap-2.5 bg-paper-3 px-1 pt-2.5">
			{rows.map((row) => (
				<div key={row} className="flex justify-center gap-1.5">
					{[...row].map((key) => (
						<span
							key={key}
							className="flex h-10 w-[8.4%] items-center justify-center rounded-[5px] bg-paper text-body text-ink"
						>
							{key}
						</span>
					))}
				</div>
			))}
			<div className="flex justify-center gap-1.5">
				<span className="h-10 w-1/2 rounded-[5px] bg-paper" />
			</div>
		</div>
	);
}

export function MaraChat({ keyboard = false, panelOpen = false }: { keyboard?: boolean; panelOpen?: boolean } = {}) {
	return (
		<ChatScreen name="Mara" face={MARA.face} pill="book the 9:15 to Lisbon?" keyboard={keyboard} panelOpen={panelOpen}>
			<DaySeparator>Today</DaySeparator>
			<Run time="10:20">
				<VoiceMessage mine duration="0:05" segments={VOICE} />
				<ImageFile src={PHOTO} alt="coast.jpg" width={220} />
			</Run>
			<Run who={MARA} time="10:21" compact>
				<Bubble>
					On it: mornings, window seat, under €300. I'll ask <Mention who={ATLAS} /> about Friday.
				</Bubble>
				<ViewCard host="flights.example" title="Lisbon, Fri 14 Nov" shot={PAGE} />
			</Run>
			<AgentMessage
				author={{ ...ATLAS, id: "atlas" }}
				text="Friday looks clear; I found two morning flights under €250."
				time="10:24"
			/>
			<UnreadDivider count={2} />
			<Run who={MARA} time="10:42" compact>
				<Bubble>Three fit. The 9:15 is the one I'd take: €214, window 14A, back Sunday 18:40.</Bubble>
				<ApprovalCard
					agent="Mara"
					what="Book TP 1351 for €214"
					verb="Book"
					as="ana@example.com on flights.example"
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
				/>
			</Run>
			<ProposalCard
				proposal={{
					id: "specimen:proposal",
					chat: 1,
					from: "mara",
					kind: "agent",
					agentId: "researcher",
					name: "Researcher",
					face: OCTO.face,
					description: "Finds sources and checks claims.",
					instructions: "Research carefully. Show sources and separate facts from guesses.",
					at: 0,
					state: "pending",
				}}
				state="pending"
			/>
		</ChatScreen>
	);
}

function AgentToolsChat() {
	return (
		<ChatScreen name="Mara" face={MARA.face}>
			<DaySeparator>Today</DaySeparator>
			<Run who={MARA} time="10:21">
				<Bubble>I asked Atlas to check the dates and read its latest note.</Bubble>
			</Run>
			<AgentMessage
				author={{ ...ATLAS, id: "atlas" }}
				text="Friday looks clear; I found two morning flights under €250."
				time="10:24"
			/>
			<ProposalCard
				proposal={{
					id: "specimen:propose-agent",
					chat: 1,
					from: "mara",
					kind: "agent",
					agentId: "researcher",
					name: "Researcher",
					face: OCTO.face,
					description: "Finds sources and checks claims.",
					model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
					tier: "deep",
					instructions: "Research carefully. Show sources and separate facts from guesses.",
					at: 0,
					state: "pending",
				}}
				state="pending"
				onAct={async (action) => (action === "accept" ? "accepted" : "declined")}
			/>
			<ProposalCard
				proposal={{
					id: "specimen:propose-group",
					chat: 1,
					from: "mara",
					kind: "group",
					name: "Lisbon research",
					members: ["mara", "atlas"],
					memberNames: ["Mara", "Atlas"],
					at: 0,
					state: "pending",
				}}
				state="pending"
				onAct={async (action) => (action === "accept" ? "accepted" : "declined")}
			/>
			<ProposalCard
				proposal={{
					id: "specimen:propose-agent-change",
					chat: 1,
					from: "mara",
					kind: "agentChange",
					agent: "atlas",
					displayName: "Atlas",
					base: "accepted-version",
					before: "---\nname: Atlas\ndescription: Tracks dates.\n---\nCompare dates carefully.\n",
					result:
						"---\nname: Atlas\nface: {…}\nstate: active\ndescription: Checks travel dates and fares.\ntier: balanced\n---\nCompare dates and report sources.\n",
					beforeAgent: {
						name: "Atlas",
						face: ATLAS.face,
						description: "Tracks dates.",
						instructions: "Compare dates carefully.",
					},
					proposedAgent: {
						name: "Atlas",
						face: OCTO.face,
						description: "Checks travel dates and fares.",
						tier: "balanced",
						instructions: "Compare dates and report sources.",
					},
					name: "Atlas",
					description: "Checks travel dates and fares.",
					at: 0,
					state: "pending",
				}}
				state="pending"
				onAct={async (action) => (action === "accept" ? "accepted" : "declined")}
			/>
			<ProposalCard
				proposal={{
					id: "specimen:propose-agent-edited",
					chat: 1,
					from: "mara",
					kind: "agent",
					agentId: "fact-checker",
					name: "Fact checker",
					face: OTTO.face,
					description: "Checks claims.",
					instructions: "Check each claim against two sources.",
					at: 0,
					state: "accepted",
				}}
				state="accepted"
				edited={{ description: "Checks claims before they reach me." }}
			/>
		</ChatScreen>
	);
}

/** The band's rows and groups of every size, two members to five, one with a long name: what flies when pinned. */
const PIN_ROWS: readonly RowView[] = [
	...ROWS,
	{ id: "weekend", name: "Weekend", faces: [MARA, ATLAS, OTTO], excerpt: "Otto: Market opens at 9.", time: "Sat" },
	{
		id: "launch",
		name: "Launch",
		faces: [OCTO, ATLAS, OTTO, SANCHO],
		excerpt: "Atlas: The post is drafted.",
		time: "Fri",
		unread: 3,
	},
	{
		id: "everyone",
		name: "Everyone in the band",
		faces: [SANCHO, MARA, OCTO, ATLAS, OTTO],
		excerpt: "Sancho: Morning, all.",
		time: "Thu",
	},
];

/** The band as the owner would use it: pin and unpin, and watch the face fly; Sancho pinned from the start. */
function PinnableBand({ phone }: { phone: boolean }) {
	const [pinned, setPinned] = useState<readonly string[]>(["sancho", "mara"]);
	return (
		<Band
			rows={PIN_ROWS}
			pinned={pinned}
			phone={phone}
			selected="mara"
			onPin={(id, on) =>
				setPinned((was) => (on ? [...was.filter((each) => each !== id), id] : was.filter((each) => each !== id)))
			}
			{...(phone ? { className: "w-full" } : {})}
		/>
	);
}

export function Screens() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<>
			<Section
				id="app"
				note="The band and a chat, the panel closed; on the phone, the band first and the chat over it."
				bleed
			>
				{phone ? (
					<Band rows={ROWS} pinned={["sancho"]} className="w-full" />
				) : (
					<Band rows={ROWS} pinned={["sancho"]} selected="mara" />
				)}
				{phone ? null : <MaraChat />}
			</Section>
			<Section
				id="pinned"
				note="Pinned agents and groups sit above the list as tiles. Pin a row to see it fly up; hover a row or a tile for its pin."
				bleed
			>
				<PinnableBand phone={phone} />
				{phone ? null : <Band rows={ROWS} pinned={["sancho", "mara", "octo"]} revealed="atlas" onPin={() => {}} />}
				{phone ? null : (
					<Band rows={ROWS} pinned={["sancho", "mara", "octo", "trip", "atlas"]} revealed="mara" onPin={() => {}} />
				)}
			</Section>
			<Section id="pinned-alignment" note="One, two and three pins, left-aligned (the default) and centred." bleed>
				<div className="flex w-full flex-col gap-3">
					{[["sancho"], ["sancho", "mara"], ["sancho", "mara", "octo"]].map((pins) => (
						<div key={pins.length} className="flex gap-3">
							<div className="h-40 overflow-hidden rounded-card">
								<Band rows={ROWS} pinned={pins} />
							</div>
							<div className="h-40 overflow-hidden rounded-card">
								<Band rows={ROWS} pinned={pins} centred />
							</div>
						</div>
					))}
				</div>
			</Section>
			{phone ? (
				<Section id="pinned-hold" note="A long press on a row or a tile opens a sheet with the one thing to do." bleed>
					<div className="relative flex w-full flex-col">
						<Band rows={ROWS} pinned={["sancho"]} className="w-full" />
						<div aria-hidden="true" className="absolute inset-0 bg-black/40" />
						<div className="absolute inset-x-0 bottom-0 rounded-t-tile bg-paper shadow-lg">
							{ROWS[1] === undefined ? null : <RowActions row={ROWS[1]} pinned={false} />}
						</div>
					</div>
				</Section>
			) : null}
			{phone ? (
				<Section id="app-chat" bleed>
					<MaraChat />
				</Section>
			) : null}
			{phone ? (
				<Section id="app-keyboard" note="The keyboard takes the bottom; the composer and the pill ride on it." bleed>
					<MaraChat keyboard />
				</Section>
			) : null}
			<Section
				id="working-chat"
				note="One agent at work: its face and Working… at the foot of the feed, until it shows something. The header says nothing of it."
				bleed
			>
				{phone ? null : <Band rows={ROWS} selected="octo" />}
				<ChatScreen name="Octo" face={OCTO.face}>
					<Line icon={CalendarClockIcon} time="8:00">
						Routine "PR watch" ran
					</Line>
					<Run who={OCTO} time="8:01" compact>
						<Bubble>One pull request needs you: CI went red overnight.</Bubble>
						<PullRequestCard pr={{ ...PR, checks: { passed: 9, failed: 2, running: 0 } }} />
					</Run>
					<Run time="10:28">
						<Bubble>Why is CI red on #34?</Bubble>
					</Run>
					<WorkingLine who={[OCTO]} onOpen={() => {}} />
				</ChatScreen>
			</Section>
			<Section id="first-run" note="The first agent, and the providers to pick from: one screen." bleed>
				<div className="flex-1">
					<FirstRun providers={PROVIDERS} open="google" />
				</div>
			</Section>
			<Section
				id="first-run-signing-in"
				note="A sign-in under way: paste its code here, pick another way, or Cancel."
				bleed
			>
				<div className="flex-1">
					<FirstRun
						providers={PROVIDERS.map((provider) =>
							provider.id === "anthropic"
								? { ...provider, connecting: true, asks: true, ways: SIGN_IN_WAYS, way: "browser" }
								: provider,
						)}
					/>
				</div>
			</Section>
			<Section
				id="first-skills"
				note="Right after the provider, once: the skills banda ships, each with a switch."
				bleed
			>
				<div className="flex-1">
					<FirstSkills skills={SKILL_OFFERS} picked={new Set(["bro", "catch-me-up"])} />
				</div>
			</Section>
			<Section
				id="first-bring"
				note="In the desktop app, when other harnesses are here: pick what to bring along, or start fresh with banda's skills."
				bleed
			>
				<div className="flex-1">
					<FirstBring
						harnesses={BRING_HARNESSES}
						picked={new Set(["claude-code", "codex"])}
						left={new Set([pickKey("skills", "motion-brief")])}
					/>
				</div>
			</Section>
			<Section id="bring-settings" note="Settings → Agents, on the desktop: the same picker, any time.">
				<BringBlock
					harnesses={BRING_HARNESSES}
					picked={new Set(["codex"])}
					left={new Set()}
					done="3 skills and 1 agent"
				/>
			</Section>
			<Section id="first-chat" note="The agent's first words, and requests a tap sends as written." bleed>
				{phone ? null : <Band rows={ROWS.filter((row) => row.id === "sancho")} selected="sancho" />}
				<ChatScreen name="Sancho" face={SANCHO.face}>
					<Run who={SANCHO} compact>
						<Bubble>
							<p>Hi, I'm Sancho. Ask me anything: I can read the web, write, plan and keep track of things for you.</p>
							<p>Connect GitHub and I'll keep an eye on your pull requests.</p>
						</Bubble>
						<ConnectCard
							agent="Sancho"
							connection="GitHub"
							id="github"
							state={{
								kind: "connect",
								why: "Sancho can read your pull requests and issues, and asks before it writes.",
							}}
						/>
					</Run>
					<Starters
						starters={[
							"Plan a long weekend somewhere warm in November",
							"Summarise today's tech news in five bullets",
							"Every weekday at 8, tell me what's on my plate",
						]}
					/>
				</ChatScreen>
			</Section>
			<Section id="group" note="A message asks everyone unless it mentions someone; each answers under its face." bleed>
				{phone ? null : <Band rows={ROWS} selected="trip" />}
				<ChatScreen name="Trip" faces={[SANCHO, MARA]} group>
					<Run time="9:50">
						<Bubble>Can we do Lisbon the weekend of the 14th? Check my calendar and flights.</Bubble>
					</Run>
					<Run who={SANCHO} time="9:51" compact={false}>
						<Bubble>Your calendar is free Friday from noon and all weekend.</Bubble>
					</Run>
					<Run who={MARA} time="9:53" compact={false}>
						<Bubble>
							Then Friday morning flights work. <Mention who={SANCHO} />, can you block Friday afternoon?
						</Bubble>
					</Run>
					<Run who={SANCHO} time="9:58" compact={false}>
						<Bubble>Saturday works for both. Blocked Friday 12:00 to 18:00.</Bubble>
					</Run>
					<Run time="10:05">
						<Bubble>
							<Mention who={MARA} /> book the 9:15. <Mention who={SANCHO} /> add it to my calendar.
						</Bubble>
					</Run>
					<WorkingLine who={[MARA, SANCHO]} onOpen={() => {}} />
				</ChatScreen>
			</Section>
			<Section
				id="agent-meta-tools"
				note="Messages between agents as feed lines; proposals as cards for your review."
				bleed
			>
				<AgentToolsChat />
			</Section>
		</>
	);
}

const BRING_HARNESSES: readonly BringHarness[] = [
	{
		name: "claude-code",
		service: "Claude Code",
		folder: "~/.claude",
		provider: "anthropic",
		connect: { install: "npm install -g @agentclientprotocol/claude-agent-acp@0.100.0" },
		skills: [
			{ name: "shadcn", about: "Manages shadcn components and projects.", added: false },
			{ name: "motion-brief", about: "Turn a motion idea into a brief.", added: false },
			{ name: "bro", about: "Say that again, in plain words.", added: true },
			{ name: "My_Notes", about: "", added: false, problem: "Its folder's name is not a skill name banda takes." },
		],
		agents: [{ name: "code-reviewer", about: "Reviews a diff for bugs before it lands.", added: false }],
	},
	{
		name: "codex",
		service: "Codex",
		folder: "~/.codex",
		provider: "openai",
		connect: "ready",
		skills: [
			{ name: "shadcn", about: "Manages shadcn components and projects.", added: false },
			{ name: "openai-docs", about: "Look up OpenAI's API docs.", added: false },
		],
		agents: [],
	},
];
