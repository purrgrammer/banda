/**
 * An agent's one chat: the header (its face, name and presence), the feed, the working line, the pill and the
 * composer. Before its first message there is no chat yet: the first message starts it, on the agent's main thread.
 * What was rendered is read once the window has focus, so a row's unread follows what the owner saw.
 */
import { SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
	useConversation,
} from "@/components/ai-elements/conversation";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { agentMainThread } from "../../../src/core/gateway.ts";
import { MOOD_BEAT_MS } from "../avatar/scene.ts";
import { WaitingPill } from "../chat/Approval.tsx";
import { Composer } from "../chat/Composer.tsx";
import { Bubble, Run } from "../chat/Feed.tsx";
import { Starters } from "../chat/FirstRun.tsx";
import { HEADER_CLEARANCE, Header } from "../chat/Header.tsx";
import { Line } from "../chat/Line.tsx";
import { ChatLoading } from "../chat/Loading.tsx";
import type { Who } from "../chat/Row.tsx";
import { Mentionable } from "../components/MentionChip.tsx";
import { type ChatRow, type Item, type Posted, postMessage, readChat, upload } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { answeredWell, view } from "../lib/chat.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import { useShell } from "../lib/shell.ts";
import { useTranscript } from "../lib/transcript.ts";
import { ActivitySheet } from "./Activity.tsx";
import { FeedView } from "./Feed.tsx";
import { FACE_STARTER, firstStarters, firstWords } from "./first-words.ts";
import { HarnessActivitySheet } from "./HarnessSession.tsx";
import { chatActivity, harnessActivity } from "./harness-activity.ts";
import { type PendingMessage, settledByAnswer, shownMessages, stillPending } from "./outgoing.ts";
import { useSkills } from "./Skills.tsx";
import { useViewContext } from "./view-context.ts";

/**
 * Whether the run was stopped mid-call: nothing runs now, and the transcript ends on a call the stop aborted, with no
 * answer after it. (A run stopped between calls ends on an interrupted answer, which the feed says itself.)
 */
function stopped(items: readonly Item[], busy: boolean): boolean {
	const last = items.at(-1);
	return (
		!busy &&
		last?.role === "tool" &&
		last.error &&
		(last.notes ?? []).some((note) => (note as { code?: string }).code === "aborted")
	);
}

const DEFAULT_SHAPE = JSON.stringify(defaultAvatarFace().definition);

/** Whether the agent still wears the default face, whatever its colour: it has not been given one of its own. */
const defaultFace = (who: Who) => JSON.stringify(who.face.definition) === DEFAULT_SHAPE;

/** Post the owner's words and files to the agent's one chat: what the daemon did with it, or a refusal rejects with why. */
async function send(
	agent: string,
	text: string,
	files: readonly File[],
	id: string = crypto.randomUUID(),
): Promise<Posted> {
	const uploaded = await Promise.all(files.map((file) => upload(file)));
	const posted = await postMessage({
		id,
		text,
		thread: agentMainThread(agent),
		...(agent === "sancho" ? {} : { agent }),
		...(uploaded.length === 0 ? {} : { files: uploaded.map(({ sha, name }) => ({ sha, name })) }),
	});
	if ("refused" in posted) throw new Error(posted.refused);
	return posted;
}

export function AgentChat({
	agent,
	who,
	row,
	phone,
	panelOpen,
	at,
	onMissing,
	onBack,
	onPanel,
	onRoutine,
}: {
	agent: string;
	/** Open at this entry, as a search result does. */
	at?: number | undefined;
	/** The entry it opened at draws nothing: the nearest after it is shown instead. */
	onMissing?: ((at: number) => void) | undefined;
	who: Who;
	/** Its chat, once its first message started it. */
	row: ChatRow | undefined;
	phone: boolean;
	panelOpen: boolean;
	onBack: () => void;
	onPanel: () => void;
	/** A routine's line was tapped: open the panel on the agent's routines. */
	onRoutine?: ((name: string) => void) | undefined;
}) {
	const state = row?.state === "running" ? "working" : row?.state === "waiting" ? "waiting" : "idle";
	const [doing, setDoing] = useState<string | undefined>(undefined);
	const [activity, setActivity] = useState<{ anchor?: number }>();
	const shell = useShell();
	const agents = shell.agents;
	const [delegatedOpen, setDelegatedOpen] = useState<readonly number[]>();
	const delegated = harnessActivity(shell.harnesses?.sessions ?? [], row === undefined ? [] : [row.chat]);
	const status = chatActivity(state, doing, delegated);
	// a reply just finished well; what the agent is really doing always wins over it
	const [happy, setHappy] = useState(false);
	const happyEnds = useRef<ReturnType<typeof setTimeout>>(undefined);
	const onAnswered = useCallback(() => {
		setHappy(true);
		clearTimeout(happyEnds.current);
		happyEnds.current = setTimeout(() => setHappy(false), MOOD_BEAT_MS.happy);
	}, []);
	useEffect(() => {
		return () => clearTimeout(happyEnds.current);
	}, []);
	const openDelegated = () => setDelegatedOpen(delegated.sessions.map((session) => session.task));
	// the lead gets every tool; another agent, what its accepted file names
	const tools =
		agent === "sancho"
			? undefined
			: (agents.find(({ accepted }) => accepted?.agent?.id === agent)?.accepted?.agent?.tools ?? []);
	const mentionables = useMemo(
		() =>
			agents.flatMap(({ accepted }) => {
				const other = accepted?.agent;
				return other !== undefined && other.state === "active" && other.id !== agent
					? [{ id: other.id, name: other.name, face: other.face }]
					: [];
			}),
		[agents, agent],
	);
	return (
		<div className="feed-scope relative flex min-w-0 flex-1 flex-col bg-paper">
			<Header
				name={who.name}
				faces={[who]}
				state={happy && status.state === "idle" ? "happy" : status.state}
				doing={status.doing}
				attention={status.attention}
				delegated={
					delegated.sessions.length > 0
						? { count: delegated.sessions.length, waiting: delegated.waiting, onOpen: openDelegated }
						: undefined
				}
				phone={phone}
				panelOpen={panelOpen}
				onBack={onBack}
				onPanel={onPanel}
				onActivity={status.delegatedPrimary ? openDelegated : row === undefined ? undefined : () => setActivity({})}
			/>
			{delegatedOpen === undefined ? null : (
				<HarnessActivitySheet tasks={delegatedOpen} onClose={() => setDelegatedOpen(undefined)} />
			)}
			{row === undefined ? (
				<>
					<div className="feed-scroll min-h-0 flex-1 overflow-y-auto">
						<div className={`mx-auto flex w-full max-w-[44rem] flex-col gap-3 px-4 pb-5 ${HEADER_CLEARANCE}`}>
							<Run who={who} compact>
								<Bubble>{firstWords(who.name, tools)}</Bubble>
							</Run>
							<Starters
								starters={[...(defaultFace(who) ? [FACE_STARTER] : []), ...firstStarters(tools)]}
								onPick={(starter) => void attempt("send it", () => send(agent, starter, []))}
							/>
						</div>
					</div>
					<Foot
						agent={agent}
						who={who}
						mentionables={mentionables}
						onSend={async (text, files) => {
							await send(agent, text, files);
						}}
					/>
				</>
			) : (
				<Timeline
					chat={row.chat}
					read={row.read}
					who={who}
					mentionables={mentionables}
					agent={agent}
					tools={tools}
					at={at}
					onMissing={onMissing}
					onDoing={setDoing}
					onAnswered={onAnswered}
					onRoutine={onRoutine}
					activity={activity}
					onActivity={(entry) => setActivity({ anchor: entry })}
					onWorkActivity={() => setActivity({})}
					onCloseActivity={() => setActivity(undefined)}
				/>
			)}
		</div>
	);
}

function Timeline({
	chat,
	read,
	who,
	mentionables,
	agent,
	tools,
	at,
	onDoing,
	onAnswered,
	onRoutine,
	activity,
	onActivity,
	onWorkActivity,
	onCloseActivity,
	onMissing,
}: {
	onAnswered: () => void;
	chat: number;
	activity: { anchor?: number } | undefined;
	onActivity: (entry: number) => void;
	/** The working line was tapped: the current work's activity. */
	onWorkActivity: () => void;
	onCloseActivity: () => void;
	mentionables: readonly ChatAgent[];
	read: number;
	onRoutine?: ((name: string) => void) | undefined;
	/** What it does now, for the header: "Using its browser…". */
	onDoing: (doing: string | undefined) => void;
	who: Who;
	agent: string;
	/** Its tools, for its first words; undefined for the lead. */
	tools: readonly string[] | undefined;
	onMissing?: ((at: number) => void) | undefined;
	at?: number | undefined;
}) {
	const transcript = useTranscript(chat);
	const context = useViewContext(chat);
	// the working line that opened the sheet, for focus to go back to
	const openedFrom = useRef<HTMLElement | undefined>(undefined);
	const [outgoing, setOutgoing] = useState<PendingMessage[]>([]);
	const deliver = (pending: PendingMessage) => {
		void send(agent, pending.text, pending.files, pending.id).then(
			(posted) => {
				if (settledByAnswer(posted)) setOutgoing((items) => items.filter((item) => item.id !== pending.id));
			},
			() => setOutgoing((items) => items.map((item) => (item.id === pending.id ? { ...item, state: "failed" } : item))),
		);
	};
	const shown = useMemo(
		() => shownMessages(transcript.items, transcript.queued),
		[transcript.items, transcript.queued],
	);
	// once shown, never pending again: a message the transcript holds leaves the list for good
	useEffect(() => {
		if (shown.size > 0) setOutgoing((items) => stillPending(items, shown));
	}, [shown]);
	const visibleOutgoing = stillPending(outgoing, shown);
	// every agent the owner can name here, this one too: each named shows as its chip
	const named = useMemo(
		() => [{ id: agent, name: who.name, face: who.face }, ...mentionables],
		[agent, who.name, who.face, mentionables],
	);
	const segments = useMemo(
		() =>
			view(
				transcript.items,
				transcript.waits,
				{
					busy: transcript.busy,
					running: transcript.running,
					thinking: transcript.thinking,
					// the owner's messages waiting for the run (a steer, or a follow-up), shown as any message until the agent takes them
					queued: transcript.queued,
				},
				context,
			),
		[
			transcript.items,
			transcript.waits,
			transcript.busy,
			transcript.running,
			transcript.thinking,
			transcript.queued,
			context,
		],
	);
	// the divider sits after the last segment from an entry the owner had read when the chat opened, and only when
	// something unread was already there then: what arrives while the owner watches is not unread
	const opened = useRef(read);
	const shownAtOpen = useRef<number | undefined>(undefined);
	if (shownAtOpen.current === undefined && transcript.loaded) shownAtOpen.current = transcript.items.at(-1)?.id ?? 0;
	const unreadAfter = useMemo(() => {
		const atOpen = shownAtOpen.current;
		if (atOpen === undefined) return undefined;
		// the owner's own entries (a message, an edit made elsewhere) are never unread
		const unreadThen = transcript.items.some(
			(item) => item.id > opened.current && item.id <= atOpen && item.role !== "user",
		);
		if (!unreadThen) return undefined;
		const readItems = new Set(transcript.items.filter((item) => item.id <= opened.current).map((item) => item.id));
		let last: string | undefined;
		for (const segment of segments) {
			const entry = Number(/\d+/.exec(segment.key)?.[0] ?? Number.NaN);
			if (readItems.has(entry)) last = segment.key;
		}
		return last;
	}, [segments, transcript.items]);

	// what was rendered is read once the window has focus
	const through = transcript.items.at(-1)?.id;
	const sent = useRef(0);
	useEffect(() => {
		if (!transcript.loaded || through === undefined) return;
		const visible = () => {
			if (document.visibilityState !== "visible" || !document.hasFocus() || sent.current >= through) return;
			sent.current = through;
			void readChat(chat, through).catch(() => {
				sent.current = 0;
			});
		};
		window.addEventListener("focus", visible);
		document.addEventListener("visibilitychange", visible);
		visible();
		return () => {
			window.removeEventListener("focus", visible);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [chat, transcript.loaded, through]);

	const working = segments.find((segment) => segment.kind === "working");
	const doing = working?.kind === "working" ? working.text.replace(/^\p{Ll}/u, (c) => c.toUpperCase()) : undefined;
	useEffect(() => {
		onDoing(doing);
	}, [doing, onDoing]);
	// the view is one snapshot, so the run's end and how it ended are read together
	const wasWorking = useRef({ chat, working: false });
	useEffect(() => {
		const finished =
			wasWorking.current.chat === chat && wasWorking.current.working && working === undefined && answeredWell(segments);
		wasWorking.current = { chat, working: working !== undefined };
		if (finished) onAnswered();
	}, [chat, working, segments, onAnswered]);
	const ask = segments.find(
		(segment) => (segment.kind === "question" || segment.kind === "approval") && segment.open !== undefined,
	);
	return (
		<Conversation className="flex flex-col">
			<ConversationContent
				scrollClassName="feed-scroll min-h-0 flex-1 overflow-y-auto"
				className={`mx-auto w-full max-w-[44rem] px-4 pb-5 ${HEADER_CLEARANCE}`}
			>
				{transcript.older ? (
					<button
						type="button"
						className="self-center text-meta text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
						onClick={() => void attempt("load earlier messages", transcript.loadOlder)}
					>
						Earlier messages
					</button>
				) : null}
				{transcript.loaded ? null : <ChatLoading />}
				{/* the chat's beginning, once reached: the agent's first words, as the empty chat showed them */}
				{transcript.loaded && !transcript.older ? (
					<Run who={who} compact>
						<Bubble>{firstWords(who.name, tools)}</Bubble>
					</Run>
				) : null}
				<Mentionable.Provider value={named}>
					<FeedView
						chat={chat}
						outgoing={visibleOutgoing}
						onRetry={(pending) => {
							const retrying = { ...pending, state: "sending" as const };
							setOutgoing((items) => items.map((item) => (item.id === pending.id ? retrying : item)));
							deliver(retrying);
						}}
						who={who}
						agent={agent}
						segments={segments}
						unreadAfter={unreadAfter}
						compact
						{...(transcript.busy
							? {}
							: { onTryAgain: () => void attempt("ask again", () => send(agent, "Try again.", [])) })}
						onOpenArtifact={(id, n) => {
							location.hash = `#/artifact/${id}${n === undefined ? "" : `?v=${n}`}`;
						}}
						onRoutine={onRoutine}
						onActivity={onActivity}
						onWorkingLine={(line) => {
							openedFrom.current = line;
							onWorkActivity();
						}}
					/>
				</Mentionable.Provider>
				{stopped(transcript.items, transcript.busy) ? (
					<Line icon={SquareIcon}>Stopped. Send a message to go on.</Line>
				) : null}
			</ConversationContent>
			<OpenAt
				at={at}
				onMissing={onMissing}
				loaded={transcript.loaded}
				first={transcript.items[0]?.id}
				older={transcript.older}
				loadOlder={transcript.loadOlder}
			/>
			<div className="relative">
				<ConversationScrollButton className="-top-11 bottom-auto" />
			</div>
			<FollowingFoot
				agent={agent}
				who={who}
				mentionables={mentionables}
				{...(ask === undefined
					? {}
					: { ask: ask.kind === "question" ? ask.ask.question : ask.kind === "approval" ? ask.label : "" })}
				onSend={async (text, files) => {
					const id: string = crypto.randomUUID();
					const pending = { id, text, files, state: "sending" as const };
					setOutgoing((items) => [...items, pending]);
					deliver(pending);
				}}
			/>
			{activity === undefined ? null : (
				<ActivitySheet
					targets={[{ chat, name: who.name, ...activity }]}
					source={{ chat, transcript }}
					returnTo={openedFrom.current}
					onClose={() => {
						openedFrom.current = undefined;
						onCloseActivity();
					}}
				/>
			)}
		</Conversation>
	);
}

/**
 * Opened at an entry (a search result): page back until it is loaded, stop following the newest, and show it, marked
 * for a moment.
 */
function OpenAt({
	at,
	onMissing,
	loaded,
	first,
	older,
	loadOlder,
}: {
	onMissing?: ((at: number) => void) | undefined;
	at: number | undefined;
	loaded: boolean;
	first: number | undefined;
	older: boolean;
	loadOlder: () => Promise<void>;
}) {
	const { stopScroll } = useConversation();
	const found = useRef<number | undefined>(undefined);
	// the latest callback, read when it is needed: a new one is no reason to look again
	const missing = useRef(onMissing);
	missing.current = onMissing;
	useEffect(() => {
		if (at === undefined || found.current === at || !loaded) return;
		if (first !== undefined && first > at && older) {
			void loadOlder();
			return;
		}
		const entries = [...document.querySelectorAll<HTMLElement>("[data-entry]")];
		const target = entries.find((each) => Number(each.dataset.entry) >= at) ?? entries.at(-1);
		if (target === undefined) return;
		found.current = at;
		// an entry the feed draws nothing for (a step of a run, a line it no longer shows): the nearest after it, said
		if (Number(target.dataset.entry) !== at) missing.current?.(at);
		stopScroll();
		target.scrollIntoView({ block: "center" });
		target.setAttribute("data-found", "");
		const timer = setTimeout(() => {
			target.removeAttribute("data-found");
		}, 1600);
		return () => {
			clearTimeout(timer);
		};
	}, [at, first, loaded, older, loadOlder, stopScroll]);
	return null;
}

/** The composer inside the conversation: sending follows the newest again, whatever was being read. */
function FollowingFoot(props: Parameters<typeof Foot>[0]) {
	const { scrollToBottom } = useConversation();
	return (
		<Foot
			{...props}
			onSend={async (text, files) => {
				await props.onSend(text, files);
				void scrollToBottom("smooth");
			}}
		/>
	);
}

/** The pill, only while the open ask is out of view; a tap shows it. */
function AskPill({ ask }: { ask: string }) {
	const [hidden, setHidden] = useState(false);
	useEffect(() => {
		const target = document.querySelector("[data-open-ask]");
		if (target === null) {
			setHidden(false);
			return;
		}
		const watch = new IntersectionObserver(([entry]) => setHidden(entry !== undefined && !entry.isIntersecting));
		watch.observe(target);
		return () => {
			watch.disconnect();
		};
	});
	if (!hidden) return null;
	return (
		<WaitingPill
			ask={ask}
			onClick={() => document.querySelector("[data-open-ask]")?.scrollIntoView({ block: "center", behavior: "smooth" })}
		/>
	);
}

function Foot({
	agent,
	who,
	mentionables,
	ask,
	onSend,
}: {
	agent: string;
	who: Who;
	mentionables: readonly Who[];
	ask?: string;
	onSend: (text: string, files: readonly File[]) => Promise<void>;
}) {
	const { list } = useSkills();
	return (
		<div className="mx-auto flex w-full max-w-[44rem] flex-col items-center gap-2 px-3 pb-3">
			{ask === undefined ? null : <AskPill ask={ask} />}
			<Composer
				skills={list.flatMap(({ accepted }) =>
					accepted === undefined ? [] : [{ name: accepted.name, description: accepted.description }],
				)}
				to={who.name}
				mentionables={mentionables}
				keep={`a:${agent}`}
				focus
				className="w-full"
				onSend={onSend}
			/>
		</div>
	);
}
