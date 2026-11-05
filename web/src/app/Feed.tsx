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
	FilePenIcon,
	FileXIcon,
	RotateCwIcon,
	ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { actOnRoutine } from "../areas/routines.ts";
import { AvatarCandidateMessage } from "../avatar/CandidateMessage.tsx";
import { AgentMessage } from "../chat/AgentMessage.tsx";
import { ApprovalCard, ChangeCard, Facts } from "../chat/Approval.tsx";
import { ArtifactCard, Browsed, QuestionCard } from "../chat/Cards.tsx";
import { Bubble, DaySeparator, MessageActions, Run, UnreadDivider } from "../chat/Feed.tsx";
import { Line } from "../chat/Line.tsx";
import { ProposalCard } from "../chat/Proposal.tsx";
import { RoutineProposal } from "../chat/Routine.tsx";
import type { Who } from "../chat/Row.tsx";
import { SkillFeedItem } from "../chat/Skill.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { actOnCapability, actOnProposal, answerAgent, answerWait, dismissQuestion } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { type Segment, tryAgainAfter } from "../lib/chat.ts";
import { changeWords } from "../lib/segments/changes.ts";
import { showAgents, showCapabilities, showControl, useShell } from "../lib/shell.ts";
import { AgentPreview } from "./AgentPreview.tsx";
import { kindWords } from "./ArtifactPage.tsx";
import { ConnectFlow } from "./ConnectFlow.tsx";
import { DraftApproval } from "./DraftApproval.tsx";
import { FilePart } from "./FilePart.tsx";
import { LiveView } from "./LiveBrowser.tsx";
import { MessageObjects, OwnerMessage } from "./Objects.tsx";
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

function ProposalFeedCard({ segment }: { segment: Extract<Segment, { kind: "proposal" }> }) {
	return (
		<ProposalCard
			proposal={segment.proposal}
			state={segment.state}
			onAct={(action) => actOnProposal(segment.proposal.id, action).then(({ state }) => state)}
		/>
	);
}

/** A routine's file name as words: portugal-fun-fact reads Portugal fun fact. */
const words = (name: string) => name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A change to a file of the band's an agent made: its card while it waits for the owner, a line once answered. */
function ChangeLine({ who, segment }: { who: Who; segment: Extract<Segment, { kind: "change" }> }) {
	const { subject, folder, name, state } = segment;
	const agentFile = subject?.agent;
	const capability = subject?.tool ?? subject?.connection;
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
	return (
		<Line icon={state === "declined" || state === "removed" ? FileXIcon : FilePenIcon}>{changeWords(segment)}</Line>
	);
}

/** A routine an agent wrote: its card while it waits for the owner, a line once answered. */
function RoutineLine({ who, segment }: { chat: number; who: Who; segment: Extract<Segment, { kind: "routine" }> }) {
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
			case "declined":
				return `${title} not set up`;
			case "removed":
				return `${title} stopped`;
			default:
				return `${title} set up${routine?.accepted?.routine === undefined ? "" : ` · ${routine.accepted.routine.when}`}`;
		}
	})();
	return (
		<Line
			icon={state === "declined" || state === "removed" ? CalendarXIcon : CalendarClockIcon}
			tone={state === "refused" ? "danger" : "quiet"}
		>
			{line}
		</Line>
	);
}

const clock = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Where a segment sits: the owner's side, the agent's, or across the feed. */
const sideOf = (segment: Segment): "owner" | "agent" | "line" => {
	if (segment.kind === "owner" || segment.kind === "owner-message") return "owner";
	if (
		segment.kind === "companion" ||
		segment.kind === "question" ||
		segment.kind === "approval" ||
		segment.kind === "browsed" ||
		segment.kind === "connect" ||
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
	outgoing?: readonly { id: string; text: string; files: readonly File[]; state: "sending" | "failed" }[];
	onRetry?: (pending: { id: string; text: string; files: readonly File[]; state: "sending" | "failed" }) => void;
}) {
	const nodes: ReactNode[] = [];
	const shell = useShell();
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
	let run: { side: "owner" | "agent"; items: ReactNode[]; at?: number | undefined; key: string } | undefined;
	let lastDay: string | undefined;
	const flush = () => {
		if (run === undefined) return;
		nodes.push(
			<Run key={run.key} {...(run.side === "agent" ? { who, compact } : {})} time={time(run.at)}>
				{run.items}
			</Run>,
		);
		run = undefined;
	};
	// what counts as unread: the agent's segments, and a routine's trouble, which reached the owner as a reply does
	const counts = (segment: Segment) =>
		sideOf(segment) === "agent" || (segment.kind === "notice" && segment.routine !== undefined);
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
			nodes.push(
				<div key={`${segment.key}:again`}>
					<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Try again", onClick: onTryAgain }}>
						{`${who.name}'s message didn't reach you`}
					</Line>
				</div>,
			);
			return;
		}
		if (part === null) return;
		if (side === "line") {
			flush();
			nodes.push(
				<div key={segment.key} data-entry={entryOf(segment.key)}>
					{part}
				</div>,
			);
			return;
		}
		if (run === undefined || run.side !== side) {
			flush();
			run = { side, items: [], key: segment.key };
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
				<div
					className={cn(
						"flex flex-col items-end gap-1 transition-opacity duration-200",
						pending.state === "sending" && "opacity-60",
					)}
				>
					{pending.text.trim() === "" ? null : (
						<Bubble mine>
							<Markdown>{pending.text}</Markdown>
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
								<Markdown>{segment.text}</Markdown>
							) : (
								<OwnerMessage chat={chat} text={segment.text} agent={objectAgent} />
							)}
						</Bubble>
					)}
					{segment.files.map((file) => (
						<FilePart key={`${file.name}-${"sha" in file ? file.sha : ""}`} chat={chat} file={file} />
					))}
					{segment.queued === true ? <span className="px-1 text-meta text-ink-2">Waiting its turn</span> : null}
				</>
			);
		case "owner-message":
			return (
				<>
					{segment.text.trim() === "" ? null : (
						<Bubble mine reaction={segment.reaction} copy={segment.text}>
							<OwnerMessage chat={chat} text={segment.text} agent={objectAgent} />
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
						<MessageObjects chat={chat} text={segment.text} objects={segment.objects} agent={objectAgent} />
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
						<Markdown>{segment.text}</Markdown>
					</Bubble>
					{parts}
				</>
			);
		}
		case "question": {
			const { ask } = segment;
			const open = segment.open;
			return (
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
		}
		case "approval": {
			const open = segment.open;
			return (
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
		}
		case "skill":
			return <SkillFeedItem name={segment.name} href={`#/skills/${segment.name}`} />;
		case "notice":
			return (
				<Line
					icon={segment.routine === undefined ? CircleAlertIcon : CalendarXIcon}
					tone="danger"
					time={time(segment.at)}
					onClick={openRoutine}
				>
					{segment.text}
				</Line>
			);
		case "effect":
			return <Line icon={ShieldCheckIcon}>{segment.label}</Line>;
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
			return <RoutineLine chat={chat} who={who} segment={segment} />;
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
		case "connect":
			return agent === undefined ? null : (
				<ConnectFlow connection={segment.connection} agent={{ id: agent, name: who.name }} />
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
