/**
 * A group's chat: its members' faces in the header, the log as runs of bubbles under each member's face and name,
 * mentions as the member's face and name, members' asks answered in place, and the composer, whose message goes to
 * everyone unless it @mentions someone. The log is read again whenever the group's row says it grew.
 */
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	CircleAlertIcon,
	PencilIcon,
	SquareIcon,
	UserMinusIcon,
	UserPlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
	useConversation,
} from "@/components/ai-elements/conversation";
import { archiveGroup, groupOf, postToGroup } from "../areas/groups.ts";
import { ArtifactCard, QuestionCard } from "../chat/Cards.tsx";
import { Composer } from "../chat/Composer.tsx";
import { Bubble, MessageActions, Run } from "../chat/Feed.tsx";
import { Header, workingWords } from "../chat/Header.tsx";
import { Line } from "../chat/Line.tsx";
import { ChatLoading, GroupEmpty } from "../chat/Loading.tsx";
import { GroupPanel, Panel } from "../chat/Panel.tsx";
import { SkillFeedItem } from "../chat/Skill.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { MENTION_LINK, Mentionable } from "../components/MentionChip.tsx";
import { answerWait, api, dismissQuestion, type GroupNoticeView, type GroupView, upload } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { failureWords } from "../lib/chat.ts";
import { mentionParts, mentionsIn } from "../lib/mentions.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import { useShell } from "../lib/shell.ts";
import { ActivitySheet, type ActivityTarget } from "./Activity.tsx";
import { kindWords } from "./ArtifactPage.tsx";
import { whoOf } from "./band.ts";
import { DraftApproval } from "./DraftApproval.tsx";
import { HarnessActivitySheet } from "./HarnessSession.tsx";
import { chatActivity, harnessActivity } from "./harness-activity.ts";
import { MessageObjects, OwnerMessage } from "./Objects.tsx";
import { useSkills } from "./Skills.tsx";

/** A message's markdown with each agent it mentions as a link, which `Markdown` draws as its chip. */
function linkedMentions(text: string, ids: readonly string[], known: readonly ChatAgent[]): string {
	return mentionParts(text, ids, known)
		.map((part) => {
			if ("text" in part) return part.text;
			const agent = known.find((each) => each.id === part.mention);
			return agent === undefined ? "" : `[${agent.name}](${MENTION_LINK}${agent.id})`;
		})
		.join("");
}

export function GroupChat({
	room,
	agents,
	archived = [],
	phone,
	at,
	onBack,
	onArchived = onBack,
}: {
	room: number;
	/** Open at this entry, as a search result does. */
	at?: number | undefined;
	agents: readonly ChatAgent[];
	/** Archived agents: still named in the group's history, never asked. */
	archived?: readonly ChatAgent[];
	phone: boolean;
	onBack: () => void;
	/** After the owner archived it: it left the band. */
	onArchived?: () => void;
}) {
	const shell = useShell();
	const row = shell.groups?.find((group) => group.room === room);
	const [group, setGroup] = useState<GroupView | undefined>(undefined);
	/** Its log could not be read: said, with Try again. */
	const [unread, setUnread] = useState(false);
	const [attempted, setAttempted] = useState(0);
	const [panel, setPanel] = useState(!phone);
	const [activity, setActivity] = useState<readonly ActivityTarget[]>();
	const latest = row?.latest;
	const asking = row?.asking.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the row says the log or its asks changed
	useEffect(() => {
		let gone = false;
		setUnread(false);
		void groupOf(room)
			.then((view) => {
				if (!gone) setGroup(view);
			})
			.catch(() => {
				if (!gone) setUnread(true);
			});
		return () => {
			gone = true;
		};
	}, [room, latest, asking, attempted]);
	// what was shown is read once the window has focus
	useEffect(() => {
		if (group === undefined || group.latest <= group.read) return;
		if (document.visibilityState === "visible" && document.hasFocus())
			void api(`/groups/${room}/read`, { method: "POST", body: JSON.stringify({ through: group.latest }) }).catch(
				() => {},
			);
	}, [group, room]);
	// an archived member stays in the room, its face paused; only the others may be mentioned or asked
	const known = [...agents, ...archived];
	const all = (row?.members ?? group?.members ?? []).map((id) => ({
		...whoOf(known, id),
		paused: archived.some((agent) => agent.id === id),
		...(row?.working.includes(id) ? { state: "working" as const } : {}),
	}));
	const members = all.filter((member) => agents.some((agent) => agent.id === member.id));
	const name = row?.name ?? group?.name ?? "Group";
	const working = members.filter((member) => member.state === "working");
	const executions = row?.executions ?? group?.executions ?? {};
	const [delegatedOpen, setDelegatedOpen] = useState<readonly number[]>();
	const delegated = harnessActivity(shell.harnesses?.sessions ?? [], Object.values(executions));
	const status = chatActivity(
		(row?.asking ?? group?.asking ?? []).length ? "waiting" : working.length ? "working" : "idle",
		workingWords(working.map((member) => member.name)),
		delegated,
	);
	const openDelegated = () => setDelegatedOpen(delegated.sessions.map((session) => session.task));
	const activityTargets = (working.length ? working : members).flatMap((member) => {
		const chat = executions[member.id];
		return chat === undefined ? [] : [{ chat, name: member.name, heading: name }];
	});

	const others = agents
		.filter((agent) => !all.some((member) => member.id === agent.id))
		.map((agent) => ({ id: agent.id, face: agent.face, name: agent.name }));
	const change = (body: { name?: string; add?: string[]; remove?: string[] }) =>
		void api<GroupView>(`/groups/${room}`, { method: "PUT", body: JSON.stringify(body) }).then(setGroup, () => {});
	const panelView = (
		<Panel name={name} phone={phone} onClose={() => setPanel(false)}>
			<GroupPanel
				name={name}
				members={all}
				others={others}
				onRename={(next) => change({ name: next })}
				onAdd={(who) => (who.id === undefined ? undefined : change({ add: [who.id] }))}
				onRemove={(who) => (who.id === undefined ? undefined : change({ remove: [who.id] }))}
				most={shell.groupLimits?.members}
				onArchive={() => void archiveGroup(room, true).then(onArchived, () => {})}
			/>
		</Panel>
	);
	if (phone && panel) return panelView;
	return (
		<>
			<div className="flex min-w-0 flex-1 flex-col bg-paper">
				<Header
					name={name}
					faces={all}
					state={status.state}
					attention={status.attention}
					delegated={
						status.secondary
							? { count: delegated.sessions.length, waiting: delegated.waiting, onOpen: openDelegated }
							: undefined
					}
					phone={phone}
					doing={status.doing}
					onBack={onBack}
					panelOpen={panel}
					onPanel={() => setPanel((open) => !open)}
					onActivity={
						status.delegatedPrimary
							? openDelegated
							: activityTargets.length
								? () => setActivity(activityTargets)
								: undefined
					}
				/>
				<Conversation className="flex flex-col">
					<ConversationContent
						scrollClassName="min-h-0 flex-1 overflow-y-auto"
						className="mx-auto w-full max-w-[44rem] px-4 py-5"
					>
						{group === undefined && unread ? (
							<Line
								icon={CircleAlertIcon}
								tone="danger"
								action={{ label: "Try again", onClick: () => setAttempted((n) => n + 1) }}
							>
								Couldn't read {name}: banda on this computer didn't answer
							</Line>
						) : group === undefined ? (
							<ChatLoading />
						) : null}
						{group !== undefined && group.messages.length === 0 ? <GroupEmpty name={name} faces={all} /> : null}
						{logOf(group).map((line) => {
							// a member's reaction shows on the owner's message it went on; alone, it is no line of its own
							if ("message" in line && reactionOnly(line.message)) return null;
							if ("notice" in line) {
								const { notice } = line;
								const who = notice.agent === undefined ? undefined : whoOf(known, notice.agent).name;
								return (
									<div key={`n${notice.entry}`} data-entry={notice.entry}>
										{noticeLine(notice, who)}
									</div>
								);
							}
							const { message } = line;
							const node = (() => {
								if ("owner" in message.author)
									return (
										<Run
											key={message.entry}
											time={new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
										>
											{message.text.trim() === "" ? null : (
												<Bubble mine copy={message.text} reaction={reactionsOn(group, message.entry)}>
													<Mentionable.Provider value={known}>
														<OwnerMessage chat={room} text={linkedMentions(message.text, message.mentions, known)} />
													</Mentionable.Provider>
												</Bubble>
											)}
											{message.loaded?.map((name) => (
												<SkillFeedItem key={name} name={name} href={`#/skills/${name}`} />
											))}
										</Run>
									);
								const member = whoOf(known, message.author.agent);
								const chat = executions[message.author.agent];
								const anchor = message.activity;
								const inspect =
									anchor === undefined || chat === undefined
										? undefined
										: () => setActivity([{ chat, name: member.name, anchor, heading: message.text || name }]);
								// what the member's message published to the Library, opened at that version
								const artifact = message.artifact;
								const objects = (
									<MessageObjects
										chat={room}
										text={message.text}
										objects={message.objects}
										agent={{ id: message.author.agent, name: member.name }}
									/>
								);
								return (
									<Run
										key={message.entry}
										who={member}
										time={new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
									>
										{message.text.trim() === "" ? null : (
											<Bubble copy={message.text} onActivity={inspect}>
												<Mentionable.Provider value={known}>
													<Markdown>{linkedMentions(message.text, message.mentions, known)}</Markdown>
												</Mentionable.Provider>
											</Bubble>
										)}
										{message.text.trim() === "" && inspect ? (
											<MessageActions onActivity={inspect}>
												<div className="min-w-0">{objects}</div>
											</MessageActions>
										) : (
											objects
										)}
										{artifact === undefined ? null : (
											<ArtifactCard
												title={artifact.title}
												kind={kindWords(artifact.kind)}
												version={`Version ${artifact.n}`}
												onOpen={() => {
													location.hash = `#/artifact/${artifact.id}?v=${artifact.n}`;
												}}
											/>
										)}
									</Run>
								);
							})();
							return (
								<div
									key={message.entry}
									data-entry={message.entry}
									className="scroll-my-24 rounded-tile transition-[background-color] duration-700 data-[found]:bg-paper-3"
								>
									{node}
								</div>
							);
						})}
						{(group?.asks ?? []).map(({ agent, wait }) => (
							<Run key={wait.key} who={whoOf(known, agent)}>
								{wait.ask.type === "question" ? (
									<QuestionCard
										question={wait.ask.question}
										choices={wait.ask.options ?? []}
										onChoose={(choice) =>
											void attempt("send your answer", () => answerWait(wait.key, choice, "question"))
										}
										onDismiss={() => void attempt("dismiss the question", () => dismissQuestion(wait.key))}
									/>
								) : (
									<DraftApproval
										chat={room}
										agent={{ id: agent, name: whoOf(known, agent).name }}
										ask={wait.ask}
										label={wait.label ?? wait.ask.label ?? wait.ask.tool}
										wait={wait.key}
									/>
								)}
							</Run>
						))}
					</ConversationContent>
					<OpenAt at={at} ready={group !== undefined} />
					<div className="relative">
						<ConversationScrollButton className="-top-11 bottom-auto" />
					</div>
					<GroupFoot
						to={name}
						keep={`g:${room}`}
						group
						mentionables={members}
						className="w-full"
						state={working.length > 0 ? "working" : "ready"}
						onSend={async (words, files) => {
							const uploaded = await Promise.all(files.map((file) => upload(file)));
							const mentioned = mentionsIn(
								words,
								agents.filter((agent) => members.some((member) => member.id === agent.id)),
							);
							await postToGroup(
								room,
								crypto.randomUUID(),
								words,
								mentioned.length === 0 ? members.map((member) => member.id) : mentioned,
								uploaded.map(({ sha, name: fileName }) => ({ sha, name: fileName })),
							);
						}}
						onStop={() => void api(`/groups/${room}/stop`, { method: "POST", body: "{}" })}
					/>
				</Conversation>
			</div>
			{delegatedOpen === undefined ? null : (
				<HarnessActivitySheet tasks={delegatedOpen} onClose={() => setDelegatedOpen(undefined)} />
			)}
			{activity === undefined ? null : <ActivitySheet targets={activity} onClose={() => setActivity(undefined)} />}
			{!phone && panel ? panelView : null}
		</>
	);
}

/** Opened at an entry (a search result): stop following the newest and show it, marked for a moment. */
function OpenAt({ at, ready }: { at: number | undefined; ready: boolean }) {
	const { stopScroll } = useConversation();
	const found = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (at === undefined || !ready || found.current === at) return;
		const target = document.querySelector<HTMLElement>(`[data-entry="${at}"]`);
		if (target === null) return;
		found.current = at;
		stopScroll();
		target.scrollIntoView({ block: "center" });
		target.setAttribute("data-found", "");
		const timer = setTimeout(() => target.removeAttribute("data-found"), 1600);
		return () => {
			clearTimeout(timer);
		};
	}, [at, ready, stopScroll]);
	return null;
}

/** The group's composer: sending follows the newest again, whatever was being read. */
function GroupFoot(
	props: Parameters<typeof Composer>[0] & { onSend: NonNullable<Parameters<typeof Composer>[0]["onSend"]> },
) {
	const { scrollToBottom } = useConversation();
	const { list } = useSkills();
	return (
		<div className="mx-auto flex w-full max-w-[44rem] flex-col items-center gap-2 px-3 pb-3">
			<Composer
				{...props}
				skills={list.flatMap(({ accepted }) =>
					accepted === undefined ? [] : [{ name: accepted.name, description: accepted.description }],
				)}
				focus
				onSend={async (text, files) => {
					await props.onSend(text, files);
					void scrollToBottom("smooth");
				}}
			/>
		</div>
	);
}

/** A group's log in the order it happened: its messages and the daemon's notices, by entry. */
/** A member's message that is a reaction alone: nothing of it shows but its emoji, on the owner's message. */
const reactionOnly = (message: GroupView["messages"][number]) =>
	message.reaction !== undefined &&
	message.text.trim() === "" &&
	(message.files ?? []).length === 0 &&
	(message.objects ?? []).length === 0 &&
	message.artifact === undefined;

/** The members' emoji on the owner's message at `entry`, each once; undefined when none reacted. */
function reactionsOn(group: GroupView | undefined, entry: number): string | undefined {
	const emoji = new Set(
		(group?.messages ?? []).flatMap((message) => (message.reaction?.on === entry ? [message.reaction.emoji] : [])),
	);
	return emoji.size === 0 ? undefined : [...emoji].join("");
}

function logOf(
	group: GroupView | undefined,
): ({ readonly message: GroupView["messages"][number] } | { readonly notice: GroupNoticeView })[] {
	if (group === undefined) return [];
	return [
		...group.messages.map((message) => ({ message, entry: message.entry })),
		...group.notices.map((notice) => ({ notice, entry: notice.entry })),
	].sort((a, b) => a.entry - b.entry);
}

/** A notice as its line: who joined or left, the group's new name, a member's run that ended without an answer. */
function noticeLine(notice: GroupNoticeView, who: string | undefined) {
	const time = new Date(notice.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (notice.added)
		return (
			<Line icon={UserPlusIcon} time={time}>
				You added {who}
			</Line>
		);
	if (notice.removed)
		return (
			<Line icon={UserMinusIcon} time={time}>
				You removed {who}
			</Line>
		);
	if (notice.renamed !== undefined)
		return (
			<Line icon={PencilIcon} time={time}>
				You named the group {notice.renamed}
			</Line>
		);
	if (notice.archived)
		return (
			<Line icon={ArchiveIcon} time={time}>
				You archived the group
			</Line>
		);
	if (notice.restored)
		return (
			<Line icon={ArchiveRestoreIcon} time={time}>
				You restored the group
			</Line>
		);
	if (notice.stopped) return <Line icon={SquareIcon}>{who} was stopped</Line>;
	if (notice.unanswered)
		return (
			<Line icon={CircleAlertIcon} tone="danger" time={time}>
				{who} didn't answer
			</Line>
		);
	return (
		<Line icon={CircleAlertIcon} tone="danger">
			{who} couldn't answer: {failureWords(notice.failed ?? "")}
		</Line>
	);
}
