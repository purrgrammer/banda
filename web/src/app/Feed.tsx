/**
 * A chat's segments (`lib/chat.ts`) drawn with the chat's components: the owner's words and the agent's messages as
 * runs of bubbles, files rich, questions and approvals as cards the owner answers in place, events as lines. A kind
 * the new feed does not draw yet falls back to its area's view, until slice 5b ports it.
 */
import {
	BrainIcon,
	CalendarClockIcon,
	CalendarXIcon,
	CircleAlertIcon,
	EyeIcon,
	EyeOffIcon,
	FilePenIcon,
	FileXIcon,
	RotateCwIcon,
} from "lucide-react";
import { type ReactNode, useContext, useRef } from "react";
import { cn } from "@/lib/cn";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { actOnRoutine } from "../areas/routines.ts";
import { actOnWatch } from "../areas/watches.ts";
import { AvatarCandidateMessage } from "../avatar/CandidateMessage.tsx";
import { AgentMessage } from "../chat/AgentMessage.tsx";
import { ApprovalCard, ChangeCard, Facts } from "../chat/Approval.tsx";
import { ArtifactCard, Browsed, QuestionCard } from "../chat/Cards.tsx";
import { Done, Settling } from "../chat/Done.tsx";
import { Bubble, DaySeparator, MessageActions, Run, UnreadDivider } from "../chat/Feed.tsx";
import { Line } from "../chat/Line.tsx";
import { ProposalCard } from "../chat/Proposal.tsx";
import { RoutineProposal } from "../chat/Routine.tsx";
import type { Who } from "../chat/Row.tsx";
import { SkillFeedItem } from "../chat/Skill.tsx";
import { WatchLine, WatchProposal } from "../chat/Watch.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Mentionable } from "../components/MentionChip.tsx";
import { actOnCapability, actOnProposal, answerAgent, answerWait, dismissQuestion } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { type Segment, tryAgainAfter } from "../lib/chat.ts";
import { linkMentions } from "../lib/mentions.ts";
import { changeNoun, changeWords } from "../lib/segments/changes.ts";
import { watchCallWords, watchObject } from "../lib/segments/watches.ts";
import { showAgents, showCapabilities, showControl, showWatching, useShell } from "../lib/shell.ts";
import { AgentPreview } from "./AgentPreview.tsx";
import { kindWords } from "./ArtifactPage.tsx";
import { ConnectFlowCard } from "./ConnectFlow.tsx";
import { DraftApproval } from "./DraftApproval.tsx";
import { FilePart } from "./FilePart.tsx";
import { HarnessSessionPart } from "./HarnessSession.tsx";
import { LiveView } from "./LiveBrowser.tsx";
import { FollowedObject, MessageObjects, MessageText } from "./Objects.tsx";
import { AskRef, approvalKind, didNotWords, didWords, sawOpen, wasOpen } from "./Settled.tsx";
import { routineTitle } from "./titles.ts";

const day = (at: number) => new Date(at).toDateString();
const time = (at: number | undefined) =>
	at === undefined ? undefined : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayLabel = (at: number) => {
	const now = new Date();
	if (day(at) === now.toDateString()) return "Today";
	if (day(at) === new Date(now.getTime() - 86_400_000).toDateString()) return "Yesterday";
	return new Date(at).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
};

/**
 * The owner's words in a bubble, each `@Name` of an agent the chat knows drawn as its chip, however far the message
 * has got: sending, queued or taken. The link is made here, for the eye alone, so the message stays what they wrote
 * and Copy gives that. With `chat`, the objects it names show too (`MessageText`).
 */
function OwnerWords({
	text,
	chat,
	agent,
}: {
	text: string;
	chat?: number | undefined;
	agent?: { readonly id: string; readonly name: string } | undefined;
}) {
	const agents = useContext(Mentionable);
	const linked = linkMentions(
		text,
		agents.map(({ id }) => id),
		agents,
	);
	return chat === undefined ? <Markdown>{linked}</Markdown> : <MessageText chat={chat} text={linked} agent={agent} />;
}

function ProposalFeedCard({ segment }: { segment: Extract<Segment, { kind: "proposal" }> }) {
	const { proposal, state } = segment;
	const card = (
		<ProposalCard
			proposal={proposal}
			state={state}
			onAct={(action) => actOnProposal(proposal.id, action).then(({ state }) => state)}
		/>
	);
	if (state === "pending") {
		sawOpen(segment.key);
		return card;
	}
	const yes = state === "accepted";
	const row =
		proposal.kind === "agent" ? (
			<Done
				kind={yes ? "agent" : "declined"}
				action={yes ? "created" : "didn't create"}
				reference={
					yes
						? { agent: { id: proposal.agentId, name: proposal.name, face: proposal.face }, title: proposal.description }
						: { where: proposal.name }
				}
				card={card}
			/>
		) : proposal.kind === "group" ? (
			<Done
				kind={yes ? "agent" : "declined"}
				action={yes ? "created the group" : "didn't create the group"}
				reference={{ where: proposal.name, title: proposal.memberNames.join(", ") }}
				card={card}
			/>
		) : (
			<Done
				kind={yes ? "change" : "declined"}
				action={yes ? "updated" : "kept as it was"}
				reference={{
					agent: {
						id: proposal.agent,
						name: proposal.displayName,
						face: (yes ? proposal.proposedAgent : proposal.beforeAgent).face,
					},
				}}
				card={card}
			/>
		);
	return <Settling settled fresh={wasOpen(segment.key)} card={card} row={row} />;
}

/** A routine's file name as words: portugal-fun-fact reads Portugal fun fact. */
const words = (name: string) => name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A change to a file of the band's an agent made: its card while it waits for the owner, a line once answered. */
function ChangeLine({ who, segment }: { who: Who; segment: Extract<Segment, { kind: "change" }> }) {
	const { subject, folder, name, state } = segment;
	const agentFile = subject?.agent;
	const capability = subject?.tool ?? subject?.connection;
	if (state === "pending") sawOpen(segment.key);
	if (state === "pending" && agentFile?.change !== undefined) {
		const change = agentFile.change;
		const removed = change.kind === "removed";
		return (
			<ChangeCard
				agent={who.name}
				what={removed ? `remove ${words(name)}` : `its file: ${words(name)}`}
				after={removed ? "" : <AgentPreview file={change} />}
				before={<AgentPreview file={agentFile.accepted} />}
				allowDisabled={!removed && !change.agent}
				onAllow={() =>
					void attempt("allow the change", () => answerAgent(name, true, removed ? null : (change.sha ?? null))).then(
						(done) => done && showAgents(done),
					)
				}
				onKeep={() =>
					void attempt("keep it as it is", () => answerAgent(name, false, null)).then(
						(done) => done && showAgents(done),
					)
				}
			/>
		);
	}
	if (state === "pending" && capability?.change !== undefined && (folder === "tools" || folder === "connections")) {
		const change = capability.change;
		const removed = change.kind === "removed";
		const noun = folder === "tools" ? "a tool it made" : "a connection";
		const described =
			"description" in capability && typeof capability.description === "string" ? capability.description : undefined;
		return (
			<ApprovalCard
				agent={who.name}
				what={
					removed
						? `stop using ${words(name)}`
						: change.kind === "changed"
							? `change ${noun}: ${words(name)}`
							: `use ${noun}: ${words(name)}`
				}
				verb={removed ? "Stop" : "Allow"}
				{...(described === undefined ? {} : { object: <Facts rows={[["What it does", described]]} /> })}
				onApprove={() =>
					void actOnCapability({ action: "accept", folder, name, sha: removed ? null : (change.sha ?? null) }).then(
						showCapabilities,
					)
				}
				onDecline={() => void actOnCapability({ action: "decline", folder, name }).then(showCapabilities)}
			/>
		);
	}
	if (state === "pending" && subject?.routine !== undefined)
		return (
			<RoutineLine
				chat={0}
				who={who}
				segment={{ kind: "routine", key: segment.key, state, name, routine: subject.routine }}
			/>
		);
	if (state === "done" || state === "declined")
		return (
			<Done
				kind={state === "declined" ? "declined" : folder === "agents" ? "change" : "permission"}
				action={state === "declined" ? "didn't allow" : "allowed"}
				reference={{ where: changeNoun(segment) }}
				time={segment.at === undefined ? undefined : time(segment.at)}
			/>
		);
	return <Line icon={state === "removed" ? FileXIcon : FilePenIcon}>{changeWords(segment)}</Line>;
}

/** A routine an agent wrote: its card while it waits for the owner; set up, declined or stopped, a row. */
function RoutineLine({
	who,
	segment,
	onRoutine,
}: {
	chat: number;
	who: Who;
	segment: Extract<Segment, { kind: "routine" }>;
	onRoutine?: ((name: string) => void) | undefined;
}) {
	const { routine, state, name } = segment;
	const title =
		name === undefined
			? "a routine"
			: routineTitle(
					name,
					routine?.accepted?.routine?.description ??
						(routine?.change && "routine" in routine.change ? routine.change.routine?.description : undefined),
				);
	const change = routine?.change;
	if (state === "pending") sawOpen(segment.key);
	const set = routine?.accepted?.routine;
	if (state === "done" && set !== undefined) {
		const open = name === undefined || onRoutine === undefined ? undefined : () => onRoutine(name);
		const card = (
			<RoutineProposal
				routine={{
					agent: who.name,
					title,
					kind: "new",
					when: set.when,
					next: (routine?.nextRuns ?? []).slice(0, 3).map(clock),
					ask: set.ask,
				}}
				settled="Set up"
			/>
		);
		return (
			<Settling
				settled
				fresh={wasOpen(segment.key)}
				card={card}
				row={
					<Done
						kind="routine"
						action="set up"
						reference={{ routine: { title, when: set.when }, onOpen: open }}
						card={card}
					/>
				}
			/>
		);
	}
	if (state === "declined" || state === "removed")
		return (
			<Done kind="declined" action={state === "declined" ? "didn't set up" : "stopped"} reference={{ where: title }} />
		);
	if (state === "pending" && routine !== undefined && name !== undefined && change !== undefined) {
		const shown = change.kind === "removed" ? routine.accepted?.routine : change.routine;
		return (
			<RoutineProposal
				routine={{
					agent: who.name,
					title,
					kind: change.kind === "added" ? "new" : change.kind,
					when: shown?.when ?? "",
					next: (routine.nextRuns ?? []).slice(0, 3).map(clock),
					ask: shown?.ask ?? "",
				}}
				onAllow={() =>
					void actOnRoutine(name, {
						action: "accept",
						sha: change.kind === "removed" ? null : (change.sha ?? null),
					}).then(showControl)
				}
				onDecline={() => void actOnRoutine(name, { action: "decline" }).then(showControl)}
			/>
		);
	}
	const line = (() => {
		switch (state) {
			case "working":
				return `Setting up ${title}…`;
			case "stopped":
				return `Didn't finish setting up ${title}`;
			case "refused":
				return segment.why === undefined ? "No routine set up" : `No routine set up: ${segment.why}`;
			default:
				return `${title} set up${routine?.accepted?.routine === undefined ? "" : ` · ${routine.accepted.routine.when}`}`;
		}
	})();
	return (
		<Line icon={CalendarClockIcon} tone={state === "refused" ? "danger" : "quiet"}>
			{line}
		</Line>
	);
}

/** A `watch` call's line: the proposal card while the owner's answer waits, else one line saying how it stands. */
function WatchCallLine({
	chat,
	who,
	agent,
	segment,
}: {
	chat: number;
	who: Who;
	agent: { readonly id: string; readonly name: string } | undefined;
	segment: Extract<Segment, { kind: "watchCall" }>;
}) {
	const { watch, state, name } = segment;
	const change = watch?.change;
	// the object as the owner's references draw it: by its key once the daemon resolved it, else by the file's link
	const what = watchObject(segment);
	const inline = (
		<FollowedObject chat={chat} agent={agent} reference={watch?.object?.ref ?? what} fallback={what} strong />
	);
	if (state === "pending" && watch !== undefined && name !== undefined && change !== undefined) {
		const shown = change.kind === "removed" ? watch.accepted?.watch : change.watch;
		return (
			<WatchProposal
				watch={{
					agent: who.name,
					title: what,
					object: inline,
					kind: change.kind === "added" ? "new" : change.kind,
					until:
						shown?.until ??
						(watch.object?.ends?.length === 0 ? "you stop it" : watch.object?.ends?.join(" or ")) ??
						"any of its ends",
					...(shown?.account === undefined ? {} : { account: shown.account }),
					ask: shown?.ask ?? "",
				}}
				onAllow={() =>
					void actOnWatch(name, {
						action: "accept",
						sha: change.kind === "removed" ? null : (change.sha ?? null),
					}).then(showWatching)
				}
				onDecline={() => void actOnWatch(name, { action: "decline" }).then(showWatching)}
			/>
		);
	}
	const words = watchCallWords(segment, who.name);
	const at = what === "" ? -1 : words.indexOf(what);
	return (
		<Line
			icon={state === "declined" || state === "removed" || watch?.state === "done" ? EyeOffIcon : EyeIcon}
			tone={state === "refused" ? "danger" : "quiet"}
		>
			{at < 0 ? (
				words
			) : (
				<>
					{words.slice(0, at)}
					{at === 0 ? inline : <span className="ml-1">{inline}</span>}
					{words.slice(at + what.length)}
				</>
			)}
		</Line>
	);
}

const clock = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Where a segment sits: the owner's side, the agent's, or across the feed. */
const sideOf = (segment: Segment): "owner" | "agent" | "line" => {
	if (segment.kind === "owner" || segment.kind === "owner-message") return "owner";
	if ((segment.kind === "question" || segment.kind === "approval") && segment.open === undefined) return "line";
	if (
		segment.kind === "companion" ||
		segment.kind === "question" ||
		segment.kind === "approval" ||
		segment.kind === "browsed" ||
		segment.kind === "connect" ||
		segment.kind === "harness" ||
		segment.kind === "avatar"
	)
		return "agent";
	if (segment.kind === "artifact") return segment.by === "owner" ? "owner" : "agent";
	if (segment.kind === "routine" || segment.kind === "change") return segment.state === "pending" ? "agent" : "line";
	return "line";
};

/** The transcript entry a segment stands for, from its key ("41", "41:ask", "answer:41"). */
const entryOf = (key: string): number | undefined => {
	const found = /\d+/.exec(key)?.[0];
	return found === undefined ? undefined : Number(found);
};

const atOf = (segment: Segment): number | undefined => ("at" in segment ? segment.at : undefined);

export function FeedView({
	chat,
	who,
	agent,
	segments,
	unreadAfter,
	compact,
	onOpenArtifact,
	onTryAgain,
	onRoutine,
	onActivity,
	onWorkingFace,
	outgoing = [],
	onRetry,
}: {
	chat: number;
	/** The agent whose chat it is. */
	who: Who;
	/** Its id: what a connect card it sent connects for. */
	agent?: string | undefined;
	segments: readonly Segment[];
	/** The key of the last segment the owner read: the unread divider follows it. */
	unreadAfter?: string | undefined;
	/** The phone: the face alone beside a run. */
	compact: boolean;
	onOpenArtifact?: (id: string, n?: number) => void;
	/** Ask again after the newest reply failed: offered on that failure alone, once nothing came after it. */
	onTryAgain?: (() => void) | undefined;
	/** A routine's event or trouble line was tapped: open the agent's routines. */
	onRoutine?: ((name: string) => void) | undefined;
	onActivity?: ((entry: number) => void) | undefined;
	/** The working face was tapped: open the current work's activity, and hand focus back to this slot after. */
	onWorkingFace?: ((face: HTMLElement) => void) | undefined;
	outgoing?: readonly { id: string; text: string; files: readonly File[]; state: "sending" | "failed" }[];
	onRetry?: (pending: { id: string; text: string; files: readonly File[]; state: "sending" | "failed" }) => void;
}) {
	const nodes: ReactNode[] = [];
	const shell = useShell();
	// the runs of this chat the working face stood on: each keeps it when the work ends
	const facedRuns = useRef(new Set<string>());
	const messageAuthor = (id: string) => {
		const accepted = shell.agents.find((view) => view.accepted?.agent?.id === id)?.accepted?.agent;
		if (accepted !== undefined)
			return {
				id,
				name: id === "sancho" ? (shell.companion?.name ?? accepted.name) : accepted.name,
				face: accepted.face,
			};
		return {
			id,
			name: id === "sancho" ? (shell.companion?.name ?? "Sancho") : id,
			face: id === "sancho" ? (shell.companion?.face ?? defaultAvatarFace()) : defaultAvatarFace(),
		};
	};
	const failed = tryAgainAfter(segments);
	let run:
		| { side: "owner" | "agent"; items: ReactNode[]; at?: number | undefined; key: string; work?: boolean }
		| undefined;
	let lastDay: string | undefined;
	// what the last drawn segment was: an agent's run is named by what it follows, so the working face and the reply that
	// comes to stand beside it are one run to React, and the face is never mounted again
	let previous = "start";
	const flush = () => {
		if (run === undefined) return;
		nodes.push(
			<Run
				key={run.key}
				{...(run.side === "agent"
					? {
							who,
							compact,
							faced: facedRuns.current.has(`${chat}:${run.key}`),
							work: run.work ? { onOpen: onWorkingFace } : undefined,
						}
					: {})}
				time={time(run.at)}
			>
				{run.items}
			</Run>,
		);
		run = undefined;
	};
	// what counts as unread: the agent's segments, and a routine's or a watch's trouble, which reached the owner as a
	// reply does
	const counts = (segment: Segment) =>
		sideOf(segment) === "agent" ||
		(segment.kind === "notice" && (segment.routine !== undefined || segment.watch !== undefined));
	const unread = segments.filter(counts);
	// the divider stands before the first of the agent's segments after the last one read: the owner's own words are
	// never unread
	const lastRead = unreadAfter === undefined ? -1 : segments.findIndex((segment) => segment.key === unreadAfter);
	const firstUnread = lastRead < 0 ? -1 : segments.findIndex((segment, index) => index > lastRead && counts(segment));
	segments.forEach((segment, index) => {
		const at = atOf(segment);
		if (at !== undefined && day(at) !== lastDay) {
			flush();
			lastDay = day(at);
			nodes.push(<DaySeparator key={`day-${lastDay}`}>{dayLabel(at)}</DaySeparator>);
		}
		if (firstUnread >= 0 && index === firstUnread) {
			const after = segments.slice(index).filter((each) => unread.includes(each)).length;
			if (after > 0) {
				flush();
				nodes.push(<UnreadDivider key="unread" count={after} />);
			}
		}
		const side = sideOf(segment);
		const again = segment.key === failed && onTryAgain !== undefined;
		const words =
			segment.kind === "notice" && segment.key.endsWith(":unanswered") ? `${who.name} didn't answer` : undefined;
		const entry = entryOf(segment.key);
		const inspect = entry === undefined || onActivity === undefined ? undefined : () => onActivity(entry);
		const part =
			again && segment.kind === "notice" ? (
				<Line
					key={segment.key}
					icon={CircleAlertIcon}
					tone="danger"
					action={{ label: "Try again", onClick: onTryAgain }}
				>
					{words ?? segment.text}
				</Line>
			) : words !== undefined ? (
				<Line key={segment.key} icon={CircleAlertIcon} tone="danger">
					{words}
				</Line>
			) : again && segment.kind === "companion" ? (
				// not delivered: the message as it was, then the way on
				partOf(chat, who, { ...segment, undelivered: false }, onOpenArtifact, agent, onRoutine, inspect, messageAuthor)
			) : (
				partOf(chat, who, segment, onOpenArtifact, agent, onRoutine, inspect, messageAuthor)
			);
		if (again && segment.kind === "companion") {
			flush();
			if (part !== null) {
				run = { side: "agent", items: [part], key: segment.key, at };
				flush();
			}
			previous = segment.key;
			nodes.push(
				<div key={`${segment.key}:again`}>
					<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Try again", onClick: onTryAgain }}>
						{`${who.name}'s message didn't reach you`}
					</Line>
				</div>,
			);
			return;
		}
		// the agent is at work: the face alone says so. It stays on the run it already stood on; any other run is older
		// work (the news of a run can come before the owner's words that began it), and the face goes alone to the foot
		if (segment.kind === "working") {
			if (run?.side !== "agent" || !facedRuns.current.has(`${chat}:${run.key}`)) {
				flush();
				run = { side: "agent", items: [], key: `after:${previous}` };
			}
			run.work = true;
			facedRuns.current.add(`${chat}:${run.key}`);
			return;
		}
		if (part === null) return;
		const follows = previous;
		previous = segment.key;
		// what comes after a face alone at the foot is the reply it stood for: its own run, beside that face
		if (run?.side === "agent" && side === "agent" && facedRuns.current.has(`${chat}:after:${follows}`)) flush();
		if (side === "line") {
			flush();
			nodes.push(
				<div
					key={segment.key}
					data-entry={entryOf(segment.key)}
					// a folded row sits close: a stretch of them reads as one log, a little apart from the words around it
					className="has-[[data-done]]:-my-1.5"
				>
					{part}
				</div>,
			);
			return;
		}
		if (run === undefined || run.side !== side) {
			flush();
			run = { side, items: [], key: side === "agent" ? `after:${follows}` : segment.key };
		}
		run.items.push(
			<div
				key={segment.key}
				data-entry={entryOf(segment.key)}
				data-open-ask={
					(segment.kind === "question" || segment.kind === "approval") && segment.open !== undefined ? "" : undefined
				}
				className={cn(
					"flex max-w-full scroll-my-24 flex-col gap-1 rounded-tile transition-[background-color] duration-700 data-[found]:bg-paper-3",
					side === "owner" ? "items-end" : "items-start",
				)}
			>
				{part}
			</div>,
		);
		run.at = at ?? run.at;
	});
	flush();
	// a change to its own file waits for the owner however the box came to hold it (another chat, a group, a stale
	// copy): its card follows the change, so the chat carries it when no line here does
	const own = agent === undefined ? undefined : shell.agents.find((view) => view.name === agent);
	if (
		own?.change !== undefined &&
		!segments.some(
			(segment) =>
				segment.kind === "change" &&
				segment.folder === "agents" &&
				segment.name === own.name &&
				segment.state === "pending",
		)
	)
		nodes.push(
			<div key={`own-change:${own.name}`}>
				<ChangeLine
					who={who}
					segment={{
						kind: "change",
						key: `own-change:${own.name}`,
						state: "pending",
						folder: "agents",
						name: own.name,
						subject: { agent: own },
					}}
				/>
			</div>,
		);
	for (const pending of outgoing) {
		nodes.push(
			<Run key={`outgoing:${pending.id}`}>
				<div className="flex flex-col items-end gap-1">
					{pending.text.trim() === "" ? null : (
						<Bubble mine>
							<OwnerWords text={pending.text} />
						</Bubble>
					)}
					{pending.files.map((file) => (
						<span
							key={`${file.name}-${file.size}`}
							className="rounded-tile border border-line-soft bg-paper px-3 py-1.5 text-meta text-ink-2"
						>
							{file.name}
						</span>
					))}
					<span className="flex h-6 items-center gap-1 px-1 text-ink-2">
						{pending.state === "failed" && (
							<button
								type="button"
								aria-label="Retry sending"
								title="Retry sending"
								onClick={() => onRetry?.(pending)}
								className="flex size-6 items-center justify-center rounded-full text-danger hover:bg-paper-3 focus-visible:outline"
							>
								<RotateCwIcon className="size-3.5" />
							</button>
						)}
					</span>
				</div>
			</Run>,
		);
	}
	return <>{nodes}</>;
}

function partOf(
	chat: number,
	who: Who,
	segment: Segment,
	onOpenArtifact?: (id: string, n?: number) => void,
	agent?: string,
	onRoutine?: (name: string) => void,
	onActivity?: () => void,
	messageAuthor?: (id: string) => Who & { readonly id: string },
): ReactNode {
	const routine = "routine" in segment && typeof segment.routine === "string" ? segment.routine : undefined;
	const openRoutine = routine === undefined || onRoutine === undefined ? undefined : () => onRoutine(routine);
	const objectAgent = agent === undefined ? undefined : { id: agent, name: who.name };
	switch (segment.kind) {
		case "owner":
			return (
				<>
					{segment.text.trim() === "" ? null : (
						<Bubble mine copy={segment.text}>
							{segment.queued ? (
								<OwnerWords text={segment.text} />
							) : (
								<OwnerWords chat={chat} text={segment.text} agent={objectAgent} />
							)}
						</Bubble>
					)}
					{segment.files.map((file) => (
						<FilePart key={`${file.name}-${"sha" in file ? file.sha : ""}`} chat={chat} file={file} />
					))}
				</>
			);
		case "owner-message":
			return (
				<>
					{segment.text.trim() === "" ? null : (
						<Bubble mine reaction={segment.reaction} copy={segment.text}>
							<OwnerWords chat={chat} text={segment.text} agent={objectAgent} />
						</Bubble>
					)}
					{segment.files.map((file) => (
						<FilePart key={`${file.name}-${"sha" in file ? file.sha : ""}`} chat={chat} file={file} />
					))}
				</>
			);
		case "companion": {
			const parts = (
				<>
					{segment.files.map((file) => (
						<FilePart key={`${file.name}-${"call" in file ? `${file.call}/${file.n}` : ""}`} chat={chat} file={file} />
					))}
					{segment.undelivered ? (
						<span className="px-1 text-meta text-danger">Not delivered</span>
					) : (
						<MessageObjects chat={chat} objects={segment.objects} agent={objectAgent} />
					)}
				</>
			);
			if (segment.text.trim() === "")
				return onActivity === undefined ? (
					parts
				) : (
					<MessageActions onActivity={onActivity}>
						<div className="flex min-w-0 flex-col gap-1">{parts}</div>
					</MessageActions>
				);
			return (
				<>
					<Bubble copy={segment.text} onActivity={onActivity}>
						<MessageText chat={chat} text={segment.text} agent={objectAgent} shown={segment.objects} />
					</Bubble>
					{parts}
				</>
			);
		}
		case "question": {
			const { ask } = segment;
			const open = segment.open;
			const card = (
				<QuestionCard
					question={ask.question}
					choices={ask.options ?? []}
					state={
						open !== undefined
							? { kind: "open" }
							: segment.ended?.outcome === "answered"
								? { kind: "answered", answer: segment.ended.said }
								: { kind: "dismissed" }
					}
					{...(open === undefined
						? {}
						: {
								onChoose: (choice: string) =>
									void attempt("send your answer", () => answerWait(open.wait, choice, "question")),
								onDismiss: () => void attempt("dismiss the question", () => dismissQuestion(open.wait)),
							})}
				/>
			);
			if (open !== undefined) {
				sawOpen(segment.key);
				return card;
			}
			const ended = segment.ended;
			const answered = ended?.outcome === "answered";
			const row =
				answered && ended?.inChat !== true ? (
					<Done kind="answer" action="answered" reference={{ where: ended.said, title: ask.question }} card={card} />
				) : (
					<Done
						kind={answered ? "answer" : "declined"}
						action={answered ? "answered below" : (ended?.said ?? "dismissed").toLowerCase()}
						reference={{ where: ask.question }}
						card={card}
					/>
				);
			return <Settling settled fresh={wasOpen(segment.key)} card={card} row={row} />;
		}
		case "approval": {
			const open = segment.open;
			const card = (
				<DraftApproval
					chat={chat}
					agent={{ id: agent, name: who.name }}
					ask={segment.ask}
					label={segment.label}
					wait={open?.wait}
					state={
						open !== undefined
							? { kind: "open" }
							: segment.ended?.outcome === "answered" && segment.ended.answer === "approve"
								? { kind: "done", words: segment.ended.said }
								: { kind: "declined" }
					}
				/>
			);
			if (open !== undefined) {
				sawOpen(segment.key);
				return card;
			}
			const { ask, label, ended } = segment;
			const verb = ask.verb ?? "Allow";
			const yes = ended?.outcome === "answered" && ended.answer === "approve";
			const outcome = ended?.outcome === "expired" || ended?.outcome === "cancelled" ? ended.outcome : "declined";
			// how it was approved, past the yes itself: "as you edited it", "allowed for this task"
			const how = yes ? ended.said.replace(/^Approved,?\s*(?:and\s+)?/, "") : "";
			const on = ask.on;
			return (
				<Settling
					settled
					fresh={wasOpen(segment.key)}
					card={card}
					row={
						<Done
							kind={yes ? approvalKind(verb, label) : "declined"}
							action={yes ? didWords(label, verb) : didNotWords(label, outcome)}
							note={how === "" ? undefined : how}
							reference={on === undefined ? undefined : { node: <AskRef chat={chat} on={on} agent={agent} /> }}
							card={card}
						/>
					}
				/>
			);
		}
		case "skill":
			return <SkillFeedItem name={segment.name} href={`#/skills/${segment.name}`} />;
		case "notice": {
			const watch = segment.watch;
			return (
				<Line
					icon={segment.routine === undefined ? CircleAlertIcon : CalendarXIcon}
					tone="danger"
					time={time(segment.at)}
					onClick={watch === undefined || onRoutine === undefined ? openRoutine : () => onRoutine(watch)}
				>
					{segment.text}
				</Line>
			);
		}
		case "effect":
			return <Done kind="permission" action={segment.label} />;
		case "proposal":
			return <ProposalFeedCard segment={segment} />;
		case "agentMessage":
			return messageAuthor === undefined ? null : (
				<AgentMessage author={messageAuthor(segment.from)} text={segment.text} time={time(segment.at)} />
			);
		case "wake":
			return (
				<Line icon={CalendarClockIcon} time={time(segment.at)} onClick={openRoutine}>
					{segment.text}
				</Line>
			);
		case "watch":
			// a feed item like any other: the object, then what changed on it; the object is a link, never a card
			return (
				<WatchLine
					name={segment.object.name}
					text={segment.text}
					ended={segment.ended !== undefined}
					time={time(segment.at)}
					onClick={onRoutine === undefined ? undefined : () => onRoutine(segment.watch)}
					object={
						<FollowedObject
							chat={chat}
							agent={objectAgent}
							reference={segment.object.ref}
							fallback={segment.object.name}
						/>
					}
				/>
			);
		case "watchCall":
			return <WatchCallLine chat={chat} who={who} agent={objectAgent} segment={segment} />;
		case "change":
			return <ChangeLine who={who} segment={segment} />;
		case "browser":
			return <LiveView chat={chat} who={who} />;
		case "memory":
			return segment.fact === undefined ? null : (
				<Line icon={BrainIcon}>
					{segment.act === "remember" ? "Remembered" : "Forgot"}: {segment.fact.text}
				</Line>
			);
		case "routine":
			return <RoutineLine chat={chat} who={who} segment={segment} onRoutine={onRoutine} />;
		case "working":
			return null;
		case "artifact": {
			const id = segment.id;
			return id === undefined ? null : (
				<ArtifactCard
					title={segment.title}
					kind={kindWords(segment.artifactKind ?? "file")}
					version={`Version ${segment.n ?? 1}${segment.change === undefined ? "" : ` · ${segment.change}`}`}
					{...(onOpenArtifact === undefined ? {} : { onOpen: () => onOpenArtifact(id, segment.n) })}
				/>
			);
		}
		case "avatar":
			return agent === undefined ? null : <AvatarCandidateMessage agent={agent} definition={segment.definition} />;
		case "harness":
			return <HarnessSessionPart chat={chat} call={segment.call} />;
		case "connect":
			return agent === undefined ? null : (
				<ConnectFlowCard connection={segment.connection} agent={{ id: agent, name: who.name }} />
			);
		case "browsed":
			return <Browsed pages={segment.pages} />;
		case "read":
			return <Browsed verb="Read" pages={segment.pages} />;
		case "refusal":
			return (
				<Line icon={CircleAlertIcon} tone="danger">
					{segment.why}
				</Line>
			);
		default:
			return null;
	}
}
