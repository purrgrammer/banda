/** Contextual disclosure over the chat's existing entries and stream. Opening it never submits work. */
import {
	ArrowLeftIcon,
	BookOpenIcon,
	CheckIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	ClockIcon,
	MessageSquareIcon,
	SparklesIcon,
} from "lucide-react";
import { type CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ModelContext, RawRow, RawValue } from "../chat/ActivityDetail.tsx";
import { SkillToolPreview } from "../chat/Skill.tsx";
import { shortPreview, ToolIcon, toolIcon, toolPreview } from "../chat/tool-presentation.tsx";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtStep,
} from "../components/ai-elements/chain-of-thought.tsx";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "../components/ai-elements/conversation.tsx";
import { Terminal } from "../components/ai-elements/terminal.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Button } from "../components/ui/button.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import {
	type ActivityAnchor,
	type ActivityWork,
	activityCalls,
	activityEnd,
	activityWork,
	findActivity,
} from "../lib/activity.ts";
import {
	type Block,
	type ChatPrompt,
	chatPrompt,
	type Item,
	type RunningTool,
	type ShownWait,
	type ToolCall,
} from "../lib/api.ts";
import { userFiles } from "../lib/chat.ts";
import { useReturnFocus } from "../lib/return-focus.ts";
import { type Transcript, useTranscript } from "../lib/transcript.ts";
import { FilePart } from "./FilePart.tsx";

export type ActivityTarget = {
	readonly chat: number;
	readonly name: string;
	readonly anchor?: ActivityAnchor;
	readonly heading?: string;
};
/** A transcript given instead of read from the daemon (the specimen's), with the model context it was prompted with. */
type Source = { readonly chat: number; readonly transcript: Transcript; readonly prompt?: ChatPrompt };
type Depth = "activity" | "transcript";

export function ActivitySheet({
	targets,
	source,
	onClose,
	returnTo,
	style,
}: {
	targets: readonly ActivityTarget[];
	source?: Source;
	onClose: () => void;
	/** Opened from the working face: focus goes back to it, or to its slot if the work ended meanwhile. */
	returnTo?: HTMLElement | undefined;
	/** The specimen's frame passes its colour scheme to the sheet, which opens outside the frame. */
	style?: CSSProperties;
}) {
	const [index, setIndex] = useState(0);
	const [depth, setDepth] = useState<Depth>("activity");
	// mounted open, from state, with no Radix trigger: closed, focus returns to what opened it
	const returnFocus = useReturnFocus(true);
	const heading = useRef<HTMLHeadingElement>(null);
	const target = targets[index];
	if (!target) return null;
	const drill = (next: Depth) => {
		setDepth(next);
		requestAnimationFrame(() => heading.current?.focus());
	};
	const props = { target, depth, onDrill: () => drill("transcript") };
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent
				className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
				{...(style === undefined ? {} : { style })}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					heading.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					// the face's slot went with the run when no reply came to take it: back to what opened the sheet, as anywhere
					if (returnTo === undefined || !returnTo.isConnected) {
						returnFocus(event);
						return;
					}
					event.preventDefault();
					(returnTo.querySelector("button") ?? returnTo).focus();
				}}
			>
				<SheetHeader className="gap-2 border-b border-line-soft pr-12">
					{depth === "transcript" ? (
						<Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => drill("activity")}>
							<ArrowLeftIcon data-icon="inline-start" />
							Activity
						</Button>
					) : null}
					<SheetTitle ref={heading} tabIndex={-1} className="outline-none">
						{depth === "activity" ? "Activity" : "Full transcript"}
					</SheetTitle>
					<SheetDescription>{target.name}</SheetDescription>
					{targets.length > 1 ? (
						<Tabs
							value={String(index)}
							onValueChange={(value) => {
								setIndex(Number(value));
								setDepth("activity");
							}}
						>
							<TabsList aria-label="Agent activity" className="h-auto max-w-full flex-wrap">
								{targets.map((member, n) => (
									<TabsTrigger key={member.chat} value={String(n)}>
										{member.name}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					) : null}
				</SheetHeader>
				{source?.chat === target.chat ? (
					<ActivityBody key={index} {...props} transcript={source.transcript} given={source.prompt} />
				) : (
					<FetchedActivity key={index} {...props} />
				)}
			</SheetContent>
		</Sheet>
	);
}

type BodyProps = {
	target: ActivityTarget;
	depth: Depth;
	onDrill: () => void;
	transcript: Transcript;
	/** The model context, when it came with the transcript instead of being fetched. */
	given?: ChatPrompt | undefined;
};
function FetchedActivity(props: Omit<BodyProps, "transcript" | "given">) {
	const transcript = useTranscript(props.target.chat);
	return <ActivityBody {...props} transcript={transcript} />;
}

function ActivityBody({ target, depth, onDrill, transcript, given }: BodyProps) {
	const { items, input, busy, older, loaded, missing, loadOlder, partial, running } = transcript;
	const works = useMemo(() => activityWork(items, input), [items, input]);
	// Pin the first selected work: a new owner input must not retarget an open sheet.
	const pinned = useRef<ActivityAnchor | undefined>(target.anchor);
	const work = findActivity(works, pinned.current);
	useEffect(() => {
		if (pinned.current === undefined && work) pinned.current = work.items[0]?.id;
	}, [work]);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [historyError, setHistoryError] = useState(false);
	const needOlder = loaded && older && (!work || work === works[0]);
	useEffect(() => {
		if (!needOlder || loadingOlder || historyError) return;
		setLoadingOlder(true);
		void loadOlder()
			.catch(() => setHistoryError(true))
			.finally(() => setLoadingOlder(false));
	}, [needOlder, loadingOlder, historyError, loadOlder]);
	const live = work?.active === true && busy;
	const selectedRequest = work?.items.find((item) => item.role === "assistant" && item.id === target.anchor);
	const lastAssistant = [...(work?.items ?? [])].reverse().find((item) => item.role === "assistant")?.id;
	const contextAt = live ? undefined : (selectedRequest?.id ?? lastAssistant);
	const requestAvailable = live || contextAt !== undefined;
	const [fetched, setFetched] = useState<ChatPrompt>();
	const prompt = given ?? fetched;
	const [promptError, setPromptError] = useState(false);
	const [retry, setRetry] = useState(0);
	const enabled = depth === "transcript" && requestAvailable && !needOlder && given === undefined;
	// A newly committed model request invalidates the live context; streamed text does not.
	const promptRequest = useMemo(
		() => ({ chat: target.chat, at: contextAt, lastAssistant, retry }),
		[target.chat, contextAt, lastAssistant, retry],
	);
	useEffect(() => {
		if (!enabled) return;
		let stale = false;
		// Keep disclosure state and focus while a newer request's recorded context is fetched.
		setPromptError(false);
		void chatPrompt(promptRequest.chat, promptRequest.at)
			.then((value) => {
				if (!stale) setFetched(value);
			})
			.catch(() => {
				if (!stale) setPromptError(true);
			});
		return () => {
			stale = true;
		};
	}, [enabled, promptRequest]);
	const timelineScroll = useRef(0);
	if (missing) return <Empty>This chat is no longer available.</Empty>;
	if (historyError)
		return (
			<Empty>
				Couldn’t load the earlier activity.
				<Button variant="ghost" onClick={() => setHistoryError(false)}>
					Try again
				</Button>
			</Empty>
		);
	if (!loaded || needOlder) return <Empty>Loading activity…</Empty>;
	if (!work) return <Empty>No recorded activity for this message.</Empty>;
	if (depth === "activity")
		return (
			<div
				data-activity-timeline=""
				className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
				ref={(node) => {
					if (node) node.scrollTop = timelineScroll.current;
				}}
				onScroll={(event) => {
					timelineScroll.current = event.currentTarget.scrollTop;
				}}
			>
				<p className="mb-6 line-clamp-3 whitespace-pre-wrap break-words text-body font-medium [overflow-wrap:anywhere]">
					{target.heading ?? work.title}
				</p>
				<ActivityTimeline
					work={work}
					live={live}
					partial={partial}
					waits={live ? transcript.waits : []}
					onDrill={onDrill}
				/>
			</div>
		);
	return (
		<Conversation aria-label="Full transcript" aria-live="off" initial={false}>
			<ConversationContent className="px-5 py-5" scrollClassName="overflow-y-auto" data-raw-content="">
				{!requestAvailable ? (
					<p className="text-ui text-ink-2">No model request recorded for this work.</p>
				) : prompt ? (
					<ModelContext prompt={prompt} />
				) : promptError ? null : (
					<p className="text-ui text-ink-2">Loading model context…</p>
				)}
				{promptError ? (
					<div className="text-ui text-danger">
						Couldn’t load the model context.
						<Button variant="ghost" onClick={() => setRetry((n) => n + 1)}>
							Try again
						</Button>
					</div>
				) : null}
				<ActivityTranscript
					chat={target.chat}
					work={work}
					partial={live ? partial : []}
					running={live ? running : []}
					waits={live ? transcript.waits : []}
				/>
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
}
function Empty({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-col gap-3 p-5 text-ui text-ink-2">{children}</div>;
}

const LABELS: Record<string, string> = {
	message_user: "Sending a message",
	message_group: "Posting to the group",
	bash: "Running a command",
	read: "Reading a file",
	write: "Writing a file",
	edit: "Editing a file",
	web_fetch: "Reading a page",
	browser_navigate: "Opening a page",
	browser_snapshot: "Reading the browser",
	browser_click: "Clicking",
	browser_type: "Typing",
	browser_select: "Selecting an option",
	browser_scroll: "Scrolling",
	browser_wait: "Waiting for the page",
	browser_screenshot: "Taking a screenshot",
	browser_send: "Sending from the browser",
	browser_hand_over: "Handing over the browser",
	schedule: "Setting a routine",
	remember: "Saving a memory",
	recall: "Looking up memories",
	forget: "Removing a memory",
	propose_key: "Requesting a credential",
};
function titleOf(call: ToolCall) {
	return Object.hasOwn(LABELS, call.name) ? (LABELS[call.name] ?? call.name) : call.name;
}
function Inspect({
	title,
	preview,
	state,
	onClick,
}: {
	title: string;
	preview?: string | undefined;
	state?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-11 w-full flex-col gap-1.5 rounded-field px-1 py-2 text-left hover:bg-paper-2"
			aria-label={`Inspect ${title}`}
		>
			<span className="flex w-full items-center justify-between gap-2">
				<span>{title}</span>
				<ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
			</span>
			{preview ? (
				<span data-tool-preview="" className="line-clamp-2 break-words text-meta text-ink-2 [overflow-wrap:anywhere]">
					{preview}
				</span>
			) : null}
			{state ? <span className="text-meta text-ink-2">{state}</span> : null}
		</button>
	);
}
function ActivityTimeline({
	work,
	live,
	partial,
	onDrill,
	waits,
}: {
	work: ActivityWork;
	live: boolean;
	partial: readonly Block[];
	waits: readonly ShownWait[];
	onDrill: () => void;
}) {
	const called = new Map(activityCalls(work).map((call) => [`${call.entry}:${call.call.id}`, call]));
	const end = activityEnd(work);
	const error = end === "Stopped" || end === "Failed" || end === "Cut off";
	const waiting = new Set(waits.map((wait) => wait.call));
	return (
		<ChainOfThought defaultOpen>
			<ChainOfThoughtHeader>{live ? "Working" : "How the work was done"}</ChainOfThoughtHeader>
			<ChainOfThoughtContent>
				{work.items.map((item) =>
					item.role === "assistant" ? (
						<Fragment key={item.id}>
							{item.thinking ? (
								<ChainOfThoughtStep
									icon={SparklesIcon}
									status="complete"
									label={<Inspect title="Thinking" preview={shortPreview(item.thinking)} onClick={onDrill} />}
								/>
							) : null}
							{item.text ? (
								<ChainOfThoughtStep
									icon={SparklesIcon}
									status="complete"
									label={<Inspect title="Model note" preview={shortPreview(item.text)} onClick={onDrill} />}
								/>
							) : null}
							{item.calls?.map((call) => {
								const result = called.get(`${item.id}:${call.id}`)?.result;
								return (
									<ChainOfThoughtStep
										key={call.id}
										icon={toolIcon(call.name)}
										status={result ? "complete" : live ? "active" : "pending"}
										label={
											<Inspect
												title={titleOf(call)}
												preview={toolPreview(call.name, call.args)}
												state={
													result?.notes?.some((note) => note.code === "aborted")
														? "Stopped"
														: result?.error
															? "Failed"
															: result
																? `Done${result.durationMs === undefined ? "" : ` · ${(result.durationMs / 1000).toFixed(1)}s`}`
																: live
																	? waiting.has(call.id)
																		? "Waiting on you"
																		: "Working"
																	: "No recorded result"
												}
												onClick={onDrill}
											/>
										}
									/>
								);
							})}
							{item.error ? (
								<ChainOfThoughtStep
									icon={CircleAlertIcon}
									status="complete"
									label={
										<Inspect
											title={item.stop === "aborted" ? "Stopped" : "Model error"}
											preview={shortPreview(item.error)}
											onClick={onDrill}
										/>
									}
								/>
							) : null}
						</Fragment>
					) : item.role === "tool" && item.receipt?.kind === "skill" ? (
						<ChainOfThoughtStep
							key={item.id}
							icon={BookOpenIcon}
							status="complete"
							label={
								<Inspect title={`Loaded /${item.receipt.name}`} preview={item.receipt.description} onClick={onDrill} />
							}
						/>
					) : item.role === "notice" ? (
						<ChainOfThoughtStep
							key={item.id}
							icon={CircleAlertIcon}
							status="complete"
							label={<Inspect title="Notice" preview={shortPreview(item.text)} onClick={onDrill} />}
						/>
					) : null,
				)}
				{live
					? partial.map((block, n) => (
							<ChainOfThoughtStep
								// biome-ignore lint/suspicious/noArrayIndexKey: content indices are the substrate's stable block identities.
								key={n}
								icon={block.call ? toolIcon(block.call.name) : SparklesIcon}
								status="active"
								label={
									<Inspect
										title={block.call ? titleOf(block.call) : block.type === "thinking" ? "Thinking" : "Model note"}
										preview={block.call ? toolPreview(block.call.name, block.call.args) : shortPreview(block.text)}
										onClick={onDrill}
									/>
								}
							/>
						))
					: null}
				<ChainOfThoughtStep
					icon={live ? ClockIcon : error ? CircleAlertIcon : CheckIcon}
					status={live ? "active" : "complete"}
					label={<Inspect title={live ? "Working…" : end} onClick={onDrill} />}
				/>
			</ChainOfThoughtContent>
		</ChainOfThought>
	);
}

function ModelRecord({
	item,
	partial = [],
}: {
	item?: Extract<Item, { role: "assistant" }>;
	partial?: readonly Block[];
}) {
	const thinking =
		item?.thinking ??
		partial
			.filter((block) => block.type === "thinking")
			.map((block) => block.text)
			.join("");
	const text =
		item?.text ??
		partial
			.filter((block) => block.type === "text" || block.type === "other")
			.map((block) => block.text)
			.join("");
	const calls = item?.calls ?? partial.flatMap((block) => (block.call ? [block.call] : []));
	const streaming = item ? {} : { state: "Streaming" };
	return (
		<div className="flex min-w-0 flex-col gap-4">
			{thinking ? (
				<RawRow title="Thinking" icon={<SparklesIcon className="size-4" />} defaultOpen {...streaming}>
					<p data-thinking="" className="whitespace-pre-wrap text-ui text-ink-2">
						{thinking}
					</p>
				</RawRow>
			) : null}
			{text ? (
				<RawRow title="Model note" icon={<SparklesIcon className="size-4" />} defaultOpen {...streaming}>
					<Markdown>{text}</Markdown>
				</RawRow>
			) : null}
			{calls.map((call) => (
				<RawRow
					key={call.id}
					title={call.name}
					icon={<ToolIcon name={call.name} />}
					summary={toolPreview(call.name, call.args)}
					defaultOpen={!item}
					{...streaming}
				>
					<RawValue label="Arguments">{JSON.stringify(call.args)}</RawValue>
				</RawRow>
			))}
			{item?.error ? <p className="whitespace-pre-wrap text-ui text-danger">{item.error}</p> : null}
			{item ? (
				<RawRow title="Request details" icon={<SparklesIcon className="size-4" />}>
					<RawValue label="Request">
						{JSON.stringify({
							entry: item.id,
							at: item.at,
							model: item.model,
							stop: item.stop,
							thinkingMs: item.thinkingMs,
							usage: item.usage,
						})}
					</RawValue>
				</RawRow>
			) : null}
		</div>
	);
}

function ActivityTranscript({
	chat,
	work,
	partial,
	running,
	waits,
}: {
	chat: number;
	work: ActivityWork;
	partial: readonly Block[];
	running: readonly RunningTool[];
	waits: readonly ShownWait[];
}) {
	const occurrences = activityCalls(work);
	const calls = new Map(occurrences.flatMap((value) => (value.result ? [[value.result.id, value.call] as const] : [])));
	const activeCalls = new Map(occurrences.filter((value) => !value.result).map((value) => [value.call.id, value.call]));
	// One model request keeps its React identity from partial to committed, including open rows and focus.
	let request = 0;
	const rows = work.items.map((item) => {
		if (item.role === "user" || item.role === "wake" || (item.role === "watch" && item.tell === undefined))
			return (
				<RawRow
					key={item.id}
					title={item.role === "user" ? "Your message" : item.role === "wake" ? "Routine" : "Watch"}
					icon={<MessageSquareIcon className="size-4" />}
					defaultOpen
				>
					<p className="whitespace-pre-wrap text-ui text-ink-2">{item.text}</p>
					{item.role === "user"
						? userFiles(item).map((file) => (
								<FilePart
									key={
										file.kind === "blob"
											? file.sha
											: file.kind === "sent"
												? `${file.call}:${file.n}`
												: `${file.item}:${file.n}`
									}
									chat={chat}
									file={file}
								/>
							))
						: null}
				</RawRow>
			);
		if (item.role === "assistant") return <ModelRecord key={`model:${request++}`} item={item} />;
		if (item.role === "tool") {
			const call = calls.get(item.id);
			return (
				<RawRow
					key={item.id}
					title={`${item.name} result`}
					icon={<ToolIcon name={item.name} />}
					state={item.notes?.some((note) => note.code === "aborted") ? "Stopped" : item.error ? "Failed" : "Done"}
					summary={item.durationMs === undefined ? undefined : `${(item.durationMs / 1000).toFixed(1)}s`}
				>
					{item.receipt?.kind === "skill" ? (
						<SkillToolPreview
							skill={{
								name: item.receipt.name,
								description: item.receipt.description,
								path: `skills/${item.receipt.name}/SKILL.md`,
								body: item.text,
								files: item.receipt.files,
							}}
						/>
					) : item.name === "bash" && typeof call?.args.command === "string" ? (
						<Terminal command={call.args.command} output={item.text} />
					) : (
						<RawValue label={item.error ? "Error" : "Result"}>{item.text}</RawValue>
					)}
					{item.patch ? <CodeBlock title="Change" language="diff" code={item.patch} /> : null}
					<RawValue label="Result details">
						{JSON.stringify({
							entry: item.id,
							call: item.call,
							at: item.at,
							durationMs: item.durationMs,
							notes: item.notes,
							receipt: item.receipt,
						})}
					</RawValue>
					{Array.from({ length: item.images ?? 0 }, (_, n) => (
						<FilePart
							// biome-ignore lint/suspicious/noArrayIndexKey: immutable result image indices are their API identity.
							key={`${item.id}:image:${n}`}
							chat={chat}
							file={{ kind: "item", item: item.id, n, image: true, name: `Image ${n + 1}` }}
						/>
					))}
				</RawRow>
			);
		}
		if (item.role === "instruction")
			return (
				<RawRow key={item.id} title="Daemon instruction" icon={<MessageSquareIcon className="size-4" />} defaultOpen>
					<p className="whitespace-pre-wrap text-ui text-ink-2">{item.text}</p>
				</RawRow>
			);
		const title =
			item.role === "compaction"
				? "Compaction"
				: item.role === "effect"
					? "Effect"
					: item.role === "wait"
						? "Question or approval"
						: "Notice";
		return (
			<RawRow key={item.id} title={title} icon={<CircleAlertIcon className="size-4" />} defaultOpen>
				<RawValue label={title}>{JSON.stringify(item)}</RawValue>
			</RawRow>
		);
	});
	if (partial.length) rows.push(<ModelRecord key={`model:${request}`} partial={partial} />);
	return (
		<>
			{rows}
			{waits.map((wait) => (
				<RawRow
					key={wait.key}
					title={wait.label ?? (wait.ask.type === "question" ? "Question" : "Approval")}
					icon={<ClockIcon className="size-4" />}
					state="Waiting on you"
					defaultOpen
				>
					<RawValue label="Ask">{JSON.stringify(wait)}</RawValue>
				</RawRow>
			))}
			{running.map((tool) => (
				<RawRow
					key={`running:${tool.call}`}
					title={`${tool.name} output`}
					icon={<ToolIcon name={tool.name} />}
					state="Running"
					defaultOpen
				>
					{tool.name === "bash" ? (
						<Terminal
							command={
								typeof activeCalls.get(tool.call)?.args.command === "string"
									? String(activeCalls.get(tool.call)?.args.command)
									: ""
							}
							output={tool.output}
						/>
					) : (
						<RawValue label="Output">{tool.output}</RawValue>
					)}
					{tool.dropped ? (
						<p className="text-meta text-ink-2">Earlier live output is outside the retained window.</p>
					) : null}
				</RawRow>
			))}
		</>
	);
}
