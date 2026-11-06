/**
 * A harness session in the chat: an agent handed work to a coding harness (Claude Code, Codex, pi) in a project on the
 * owner's computer, at once, with no draft. The card follows it live, one line for its latest step; the owner steers it
 * in their own words or stops it; the sheet shows every step. The harness's own asks are ordinary approval cards.
 */
import {
	BotIcon,
	BrainIcon,
	CheckIcon,
	ChevronDownIcon,
	CircleAlertIcon,
	FileTextIcon,
	type LucideIcon,
	MessageSquareIcon,
	PencilIcon,
	SendIcon,
	SquareIcon,
	TerminalIcon,
	UserIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { projectOf } from "../lib/project.ts";
import { Tile } from "./Cards.tsx";
import { Confirm } from "./Confirm.tsx";

export { projectOf };

/** One step of a session, as the harness reported it. */
export type HarnessStep =
	| { readonly kind: "asked"; readonly text: string }
	| { readonly kind: "steered"; readonly text: string; readonly taken: boolean; readonly from?: "agent" }
	| { readonly kind: "read"; readonly path: string }
	| { readonly kind: "thought"; readonly text: string }
	| {
			readonly kind: "edit";
			readonly path: string;
			readonly added?: number;
			readonly removed?: number;
			readonly diff?: string;
	  }
	| { readonly kind: "run"; readonly command: string; readonly output?: string; readonly running?: boolean }
	| { readonly kind: "waiting"; readonly command: string }
	| { readonly kind: "decided"; readonly command: string; readonly allowed: boolean }
	| { readonly kind: "said"; readonly text: string };

export type HarnessState = "working" | "waiting" | "done" | "stopped" | "interrupted" | "failed";

export type HarnessSessionView = {
	/** The harness by name: "Claude Code". */
	readonly harness: string;
	/** Whose it is, by the app's provider logos: its mark beside its name. */
	readonly provider?: string | undefined;
	/** Its own mark, in its own colours. */
	readonly logo?: string | undefined;
	/** The folder it works in, as the owner knows it: "~/sancho". */
	readonly folder: string;
	readonly state: HarnessState;
	readonly steps: readonly HarnessStep[];
	/** How many older steps the daemon dropped: with it, a kept step's place never moves while more stream in. */
	readonly dropped?: number | undefined;
	/** How long it has run: "1:48". */
	readonly elapsed: string;
	/** Its last words once it ended, first line only. */
	readonly outcome?: string | undefined;
	/** The agent that started it, by name: whose follow-ups and Stop the card names. */
	readonly agent?: string | undefined;
	/** Its number, as its agent says it ("session 42"), and the one it goes on from. */
	readonly task?: number | undefined;
	readonly continues?: number | undefined;
	readonly continuation?: "native" | "summary" | undefined;
	/** Its agent stopped it, not the owner. */
	readonly stoppedBy?: "agent" | undefined;
};

/**
 * A harness's mark: its own logo in its own colours (pi's), else its provider's (Claude Code: Anthropic's), else the
 * terminal for one with none (the owner's own).
 */
export function HarnessMark({
	provider,
	logo,
	className,
}: {
	provider?: string | undefined;
	logo?: string | undefined;
	className?: string;
}) {
	if (logo !== undefined) return <img src={`/harnesses/${logo}.svg`} alt="" className={cn("size-6", className)} />;
	return provider === undefined ? (
		<TerminalIcon aria-hidden="true" className={cn("size-4.5 text-ink-2", className)} />
	) : (
		// the logos are padded inside their box: a size up reads as large as GitHub's mark beside them
		<img src={`/providers/${provider}.svg`} alt="" className={cn("size-6 dark:invert", className)} />
	);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with the project's path gone: a path into the folder becomes relative, the folder itself ".". */
export function relativeTo(text: string, folder?: string): string {
	if (folder === undefined || folder === "") return text;
	const tail = escaped(folder.replace(/^~\//, "").replace(/^\//, ""));
	return text
		.replace(new RegExp(`(?:~|\\/)[^\\s'"]*?${tail}\\/`, "g"), "")
		.replace(new RegExp(`(?:~|\\/)[^\\s'"]*?${tail}(?=[\\s'"]|$)`, "g"), ".");
}

/** A command without the shell's throat-clearing: no `cd <path> &&` prefix, paths relative to the project. */
export function cleanCommand(command: string, folder?: string): string {
	let text = command.trim().replace(/\s+/g, " ");
	for (;;) {
		const match = /^cd (?:"[^"]*"|'[^']*'|[^\s&]+) ?&& ?/.exec(text);
		if (match === null) break;
		text = text.slice(match[0].length);
	}
	return relativeTo(text, folder);
}

/** Truncated in the middle, never the end: a command's head and its tail both read. CSS ellipsis stays a last resort. */
export function middleEllipsis(text: string, max = 64): string {
	if (text.length <= max) return text;
	const keep = max - 1;
	const head = Math.ceil(keep * 0.6);
	return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

const unquote = (token: string) => token.replace(/^["']|["']$/g, "");

const TESTS = /\b(vitest|jest|pytest|cargo test|go test)\b|\bnpm (run )?test/;

/** What a command does, in words; an unknown command stays itself, cleaned and middle-truncated, in mono. */
export function runHeadline(
	command: string,
	folder?: string,
	ran = false,
): { verb: string; object: string; code: boolean } {
	const clean = cleanCommand(command, folder);
	const tokens = clean.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const head = (tokens[0] ?? "").split("/").at(-1) ?? "";
	const positional = tokens
		.slice(1)
		.filter((token) => !token.startsWith("-") && token !== "&&" && token !== "|")
		.map(unquote);
	const first = positional[0];
	if ((head === "rg" || head === "grep") && first !== undefined && first !== "")
		return { verb: ran ? "Searched for" : "Searching for", object: `"${middleEllipsis(first, 48)}"`, code: false };
	if (head === "cat" || head === "head" || head === "tail") {
		// `head -n 20 file`: the count is not the file; the last non-numeric word is
		const file = positional.filter((token) => !/^\d+$/.test(token)).at(-1);
		if (file !== undefined) return { verb: ran ? "Read" : "Reading", object: middleEllipsis(file), code: true };
	}
	if (head === "sed" && positional.length > 1)
		return { verb: ran ? "Read" : "Reading", object: middleEllipsis(positional.at(-1) ?? ""), code: true };
	if (head === "ls")
		return {
			verb: ran ? "Listed" : "Listing",
			object:
				first === undefined || first === "." ? (folder === undefined ? "." : projectOf(folder)) : middleEllipsis(first),
			code: true,
		};
	if (TESTS.test(clean)) return { verb: ran ? "Ran tests" : "Running tests", object: "", code: false };
	if (head === "git") return { verb: ran ? "Checked git" : "Checking git", object: "", code: false };
	return { verb: ran ? "Ran" : "Running", object: middleEllipsis(clean, 72), code: true };
}

/** The one line the card shows for a step: a verb and what it acted on, in the owner's words where it can. */
export function headlineOf(
	step: HarnessStep | undefined,
	folder?: string,
): { verb: string; object: string; code: boolean } {
	switch (step?.kind) {
		case "read":
			return { verb: "Reading", object: middleEllipsis(relativeTo(step.path, folder)), code: true };
		case "edit":
			return { verb: "Editing", object: middleEllipsis(relativeTo(step.path, folder)), code: true };
		case "run":
			return runHeadline(step.command, folder, step.running === false);
		case "waiting":
			return { verb: "Waiting on you:", object: middleEllipsis(cleanCommand(step.command, folder)), code: true };
		case "thought":
			return { verb: "Thinking", object: "", code: false };
		case "steered":
			return { verb: step.from === "agent" ? "Taking a follow-up" : "Taking your note", object: "", code: false };
		case "decided":
			return {
				verb: step.allowed ? "Going on: you allowed" : "Going on: you denied",
				object: middleEllipsis(cleanCommand(step.command, folder)),
				code: true,
			};
		case "said":
			return { verb: "Writing", object: "", code: false };
		default:
			return { verb: "Starting", object: "", code: false };
	}
}

/** The session's state in words for the card's foot: the clock never runs loose, it belongs to a state. */
export function stateWordsOf(state: HarnessState, elapsed: string): string {
	switch (state) {
		case "working":
			return `Working ${elapsed}`;
		case "waiting":
			return "Waiting on you";
		case "done":
			return `Took ${elapsed}`;
		case "stopped":
			return "Stopped";
		case "interrupted":
			return "Interrupted";
		case "failed":
			return "Failed";
	}
}

/** What the status region announces when the state changes, for a screen reader. */
export function announceOf(state: HarnessState, harness: string): string {
	switch (state) {
		case "working":
			return `${harness} is working`;
		case "waiting":
			return `${harness} is waiting on you`;
		case "done":
			return `${harness} finished`;
		case "failed":
			return `${harness} failed`;
		default:
			return `${harness} stopped`;
	}
}

/**
 * A step's identity while the session streams: its kind at its absolute place. The daemon drops old steps (the first,
 * the ask, always kept), so a relative index moves; `dropped` pins it. A key saved as expanded never lands on a
 * different step, and a step that arrives later can never inherit one.
 */
export function stepKey(step: HarnessStep, index: number, dropped = 0): string {
	return `${step.kind}:${index === 0 ? 0 : dropped + index}`;
}

/** The sheet's expanded steps, toggled one at a time: a step stays open while new ones arrive. */
export function toggledStep(open: ReadonlySet<string>, key: string): ReadonlySet<string> {
	const next = new Set(open);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/**
 * Files it changed, counted once per path, with the lines added and removed across its edits: undefined counts once
 * any edit did not say, never a made-up zero.
 */
export function changesOf(steps: readonly HarnessStep[]): { files: number; added?: number; removed?: number } {
	const paths = new Set<string>();
	let added: number | undefined = 0;
	let removed: number | undefined = 0;
	for (const step of steps) {
		if (step.kind !== "edit") continue;
		paths.add(step.path);
		added = added === undefined || step.added === undefined ? undefined : added + step.added;
		removed = removed === undefined || step.removed === undefined ? undefined : removed + step.removed;
	}
	return {
		files: paths.size,
		...(added === undefined ? {} : { added }),
		...(removed === undefined ? {} : { removed }),
	};
}

const live = (state: HarnessState) => state === "working" || state === "waiting";

/** "No files changed" is only information once the session ended; while it works, silence. */
function Changes({ steps, ended }: { steps: readonly HarnessStep[]; ended: boolean }) {
	const { files, added, removed } = changesOf(steps);
	if (files === 0) return ended ? <span>No files changed</span> : null;
	return (
		<span className="tabular-nums">
			{files} {files === 1 ? "file" : "files"}
			{added === undefined || removed === undefined ? null : (
				<>
					{" "}
					<span className="text-alive">+{added}</span> <span className="text-danger">−{removed}</span>
				</>
			)}
		</span>
	);
}

/**
 * Words for the harness, sent as the owner's own: no draft, the harness takes them after its current step. The field
 * stays folded behind "Add a note", so several live sessions never show several open fields.
 */
export function SteerField({
	harness,
	onSteer,
	className,
}: {
	harness: string;
	onSteer?: ((text: string) => void) | undefined;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const send = () => {
		const words = text.trim();
		if (words === "") return;
		onSteer?.(words);
		setText("");
		setOpen(false);
	};
	if (!open)
		return (
			<Button variant="outline" size="sm" className={cn("self-start", className)} onClick={() => setOpen(true)}>
				Add a note
			</Button>
		);
	return (
		<InputGroup className={className}>
			<InputGroupInput
				value={text}
				autoFocus
				aria-label={`Note for ${harness}`}
				placeholder={`Note for ${harness} · read after this step`}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						setOpen(false);
						return;
					}
					if (event.key !== "Enter") return;
					event.preventDefault();
					send();
				}}
			/>
			<InputGroupAddon align="inline-end">
				<InputGroupButton size="icon-xs" aria-label="Send" disabled={text.trim() === ""} onClick={send}>
					<SendIcon />
				</InputGroupButton>
			</InputGroupAddon>
		</InputGroup>
	);
}

/**
 * A harness on this computer, as a tile: its mark, its name, where it works and for whom, and what to do. Connecting and
 * changing it happen in the connect dialog (Connect, Edit); Disconnect and Remove ask first. In an agent's Access it has
 * the switch for that agent instead.
 */
export function HarnessTile({
	harness,
	provider,
	logo,
	about,
	connected,
	on,
	agents,
	agent,
	onConnect,
	onEdit,
	onSwitch,
	onDisconnect,
	onRemove,
}: {
	harness: string;
	provider?: string | undefined;
	logo?: string | undefined;
	/** What it is, in a line, while not connected. */
	about?: string | undefined;
	/** The code folder it is connected to. */
	connected?: string | undefined;
	/** In an agent's Access: whether that agent may use it. */
	on?: boolean | undefined;
	/** The agents it is on for, by name, as the Connections page says. */
	agents?: readonly string[] | undefined;
	/** The agent of the Access tab it is in. */
	agent?: string | undefined;
	onConnect?: (() => void) | undefined;
	onEdit?: (() => void) | undefined;
	onSwitch?: ((on: boolean) => void) | undefined;
	onDisconnect?: (() => void) | undefined;
	onRemove?: (() => void) | undefined;
}) {
	if (agent !== undefined && connected !== undefined)
		return (
			<div className="flex min-h-11 items-center gap-3 py-1.5">
				<HarnessMark provider={provider} logo={logo} className="size-5 shrink-0" />
				<span className="min-w-0 flex-1 truncate text-ui text-ink">{harness}</span>
				<Switch checked={on === true} aria-label={`${harness} for ${agent}`} onCheckedChange={onSwitch} />
			</div>
		);
	const where =
		connected === undefined
			? (about ?? "On this computer")
			: agents === undefined
				? `In ${connected}`
				: `In ${connected} · ${agents.length === 0 ? "on for no agent yet" : `on for ${agents.join(", ")}`}`;
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
					<HarnessMark provider={provider} logo={logo} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-ui font-semibold text-ink">{harness}</span>
					<span className="min-w-0 truncate text-meta text-ink-2">{where}</span>
				</span>
				{connected !== undefined && agent !== undefined && onSwitch !== undefined ? (
					<Switch
						checked={on === true}
						aria-label={`${harness} for ${agent}`}
						onCheckedChange={(next) => onSwitch(next)}
					/>
				) : null}
			</span>
			<span className="flex flex-wrap items-center gap-2">
				{connected === undefined ? (
					<Button size="sm" onClick={onConnect}>
						Connect
					</Button>
				) : onEdit === undefined ? null : (
					<Button variant="outline" size="sm" onClick={onEdit}>
						Edit
					</Button>
				)}
				{connected === undefined || onDisconnect === undefined ? null : (
					<Confirm
						title={`Disconnect ${harness}?`}
						body={`No agent can hand it work, and what it is doing now stops. Your folder and its files stay as they are.`}
						action="Disconnect"
						onConfirm={onDisconnect}
					>
						<Button variant="destructive" size="sm">
							Disconnect
						</Button>
					</Confirm>
				)}
				{onRemove === undefined ? null : (
					<Confirm
						title={`Remove ${harness}?`}
						body="banda forgets the command that starts it, and disconnects it."
						action="Remove"
						onConfirm={onRemove}
					>
						<Button variant="destructive" size="sm">
							Remove
						</Button>
					</Confirm>
				)}
				{agent !== undefined && connected !== undefined ? (
					<span className="ml-auto text-meta text-ink-2">{on === true ? `On for ${agent}` : `Off for ${agent}`}</span>
				) : null}
			</span>
		</Tile>
	);
}

/** The verb and object of a headline, as the card and the sheet's rows draw them. */
function HeadWords({ verb, object, code }: { verb: string; object: string; code: boolean }) {
	return (
		<>
			<span className="shrink-0 text-ink-2">{verb}</span>
			{object === "" ? null : (
				<span className={cn("min-w-0 truncate text-ink", code ? "font-code text-meta" : "text-ui")}>{object}</span>
			)}
		</>
	);
}

/** The session in the chat: live while it works, its outcome once it ends. */
export function HarnessCard({
	session,
	onStop,
	onOpen,
	onSteer,
}: {
	session: HarnessSessionView;
	onStop?: () => void;
	onOpen?: () => void;
	onSteer?: (text: string) => void;
}) {
	const { harness, folder, state, steps, elapsed, outcome } = session;
	// a note not yet taken is not what it is doing: the headline stays on its current step
	const last = steps.filter((step) => step.kind !== "steered" || step.taken).at(-1);
	const { verb, object, code } = headlineOf(
		state === "waiting" ? [...steps].reverse().find((step) => step.kind === "waiting") : last,
		folder,
	);
	const notes = steps.filter((step): step is Extract<HarnessStep, { kind: "steered" }> => step.kind === "steered");
	const headline =
		state === "done" ? (
			<>
				<CheckIcon aria-hidden="true" className="size-4 shrink-0 self-center text-ink" />
				<span className="min-w-0 text-ink">{outcome ?? "Finished"}</span>
			</>
		) : state === "stopped" || state === "interrupted" || state === "failed" ? (
			<>
				{state === "stopped" ? (
					<SquareIcon aria-hidden="true" className="size-3.5 shrink-0 self-center fill-current text-ink-2" />
				) : (
					<CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 self-center text-danger" />
				)}
				<span className="min-w-0 text-ink">
					{state === "stopped"
						? session.stoppedBy === "agent"
							? `${session.agent ?? "Its agent"} stopped it`
							: "You stopped it"
						: state === "failed"
							? `It ended with a problem: ${outcome ?? "it did not say why"}`
							: "Interrupted when banda restarted. Nothing was sent again."}
				</span>
			</>
		) : (
			<>
				<span className="shrink-0 text-ink-2">{verb}</span>
				{object === "" ? null : state === "working" ? (
					<Shimmer as="span" className={cn("min-w-0 truncate", code ? "font-code" : "", "text-ui")}>
						{object}
					</Shimmer>
				) : (
					<span className={cn("min-w-0 truncate text-ink", code ? "font-code" : "", "text-ui")}>{object}</span>
				)}
			</>
		);
	return (
		<Tile className="flex flex-col gap-2.5 p-4">
			<span role="status" aria-live="polite" className="sr-only">
				{announceOf(state, harness)}
			</span>
			<span className="flex items-center gap-2 text-ui">
				<span
					aria-hidden="true"
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						live(state) ? "bg-alive motion-safe:animate-pulse" : state === "done" ? "bg-ink" : "bg-ink-3",
					)}
				/>
				<HarnessMark
					provider={session.provider}
					logo={session.logo}
					className={session.provider === undefined && session.logo === undefined ? "size-4" : "size-5"}
				/>
				<span className="font-medium text-ink">{harness}</span>
				<span className="min-w-0 truncate text-meta text-ink-2">{projectOf(folder)}</span>
				{live(state) ? (
					<Button variant="ghost" size="xs" className="ml-auto" onClick={onStop}>
						<SquareIcon className="fill-current" />
						Stop
					</Button>
				) : null}
			</span>
			{session.continues === undefined ? null : (
				<p className="text-meta text-ink-2">
					{session.continuation === "native"
						? "Resumed its original session."
						: session.continuation === "summary"
							? "Started fresh with a summary of the earlier work."
							: "Opening the follow-up…"}
				</p>
			)}
			{onOpen === undefined ? (
				<span className="flex min-h-6 min-w-0 items-baseline gap-2 text-body">{headline}</span>
			) : (
				// the whole line opens the sheet: on a touch screen it is the big target Steps repeats
				<button
					type="button"
					onClick={onOpen}
					className="-mx-1 flex min-h-6 min-w-0 cursor-pointer items-baseline gap-2 rounded-field px-1 text-left text-body outline-none hover:bg-paper-2 focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:min-h-11 pointer-coarse:items-center max-sm:min-h-11 max-sm:items-center"
				>
					{headline}
				</button>
			)}
			{notes.length === 0 ? null : (
				<ul className="flex flex-col gap-1">
					{notes.map((note, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: notes are append-only, a note is its place
						<li key={`${index}:${note.text}`} className="flex min-w-0 items-baseline gap-1.5 text-meta text-ink-2">
							{note.from === "agent" ? (
								<BotIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
							) : (
								<UserIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
							)}
							<span className="min-w-0 truncate text-ink">{note.text}</span>
							<span className="shrink-0">· {note.taken ? "taken" : "after this step"}</span>
						</li>
					))}
				</ul>
			)}
			{live(state) ? <SteerField harness={harness} onSteer={onSteer} /> : null}
			<span className="flex items-center gap-3 text-meta text-ink-2">
				<Changes steps={steps} ended={!live(state)} />
				<span className="tabular-nums">{stateWordsOf(state, elapsed)}</span>
				<Button variant="ghost" size="xs" className="ml-auto" onClick={onOpen}>
					Steps
				</Button>
			</span>
		</Tile>
	);
}

/**
 * A long text behind three lines and "Show all": nothing is cut, only folded. Whether the clamp cut anything is
 * measured, not guessed: a narrow screen wraps sooner, and a cut with no way to the rest would lose words.
 */
function ClampedText({ text, muted = false }: { text: string; muted?: boolean }) {
	const [all, setAll] = useState(false);
	const [cut, setCut] = useState(false);
	const ref = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (all) return;
		const element = ref.current;
		if (element === null) return;
		const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
		measure();
		const watcher = new ResizeObserver(measure);
		watcher.observe(element);
		return () => watcher.disconnect();
	}, [all]);
	// the measure is the truth once mounted; the static guess covers server renders
	const long = cut || text.split("\n").length > 3 || text.length > 240;
	return (
		<div className="flex flex-col items-start gap-1">
			<p
				ref={ref}
				className={cn("text-ui whitespace-pre-wrap", muted ? "text-ink-2" : "text-ink", !all && "line-clamp-3")}
			>
				{text}
			</p>
			{long && !all ? (
				<Button variant="ghost" size="xs" onClick={() => setAll(true)}>
					Show all
				</Button>
			) : null}
		</div>
	);
}

/** A command whole and raw, as the harness said it: what expands under a one-line row. */
function Raw({ text }: { text: string }) {
	return (
		<p className="rounded-field bg-paper-2 px-3 py-2 font-code text-meta whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
			{text}
		</p>
	);
}

/** One step as a one-line row: its icon, its phrase, and what expands. `always` shows folded or not: the ask. */
function stepLine(
	step: HarnessStep,
	folder: string,
	agent?: string,
): { icon: LucideIcon; words: ReactNode; detail?: ReactNode; always?: ReactNode } {
	const oneline = (text: string) => text.replace(/\s+/g, " ").trim();
	switch (step.kind) {
		case "asked":
			// what was asked is the session's point: three lines always, "Show all" for the rest, never a click to see it
			return {
				icon: MessageSquareIcon,
				words: <span className="shrink-0 text-ink-2">Asked</span>,
				always: <ClampedText text={step.text} />,
			};
		case "steered":
			return {
				icon: step.from === "agent" ? BotIcon : UserIcon,
				words: (
					<HeadWords
						verb={`${step.from === "agent" ? `${agent ?? "Its agent"} followed up` : "You said"}${step.taken ? "" : " · after this step"}`}
						object={oneline(step.text)}
						code={false}
					/>
				),
				detail: <ClampedText text={step.text} />,
			};
		case "decided":
			return {
				icon: step.allowed ? CheckIcon : XIcon,
				words: (
					<HeadWords
						verb={step.allowed ? "You allowed" : "You denied"}
						object={middleEllipsis(cleanCommand(step.command, folder))}
						code
					/>
				),
				detail: <Raw text={step.command} />,
			};
		case "read":
			return {
				icon: FileTextIcon,
				words: <HeadWords verb="Read" object={relativeTo(step.path, folder)} code />,
			};
		case "thought":
			return {
				icon: BrainIcon,
				words: <HeadWords verb="Thought" object={oneline(step.text)} code={false} />,
				detail: <ClampedText text={step.text} muted />,
			};
		case "edit":
			return {
				icon: PencilIcon,
				words: (
					<>
						<HeadWords verb="Edited" object={relativeTo(step.path, folder)} code />
						{step.added === undefined || step.removed === undefined ? null : (
							<span className="shrink-0 text-meta tabular-nums">
								<span className="text-alive">+{step.added}</span> <span className="text-danger">−{step.removed}</span>
							</span>
						)}
					</>
				),
				detail:
					step.diff === undefined ? undefined : (
						<CodeBlock code={step.diff} language="diff" title={relativeTo(step.path, folder)} />
					),
			};
		case "run": {
			const { verb, object, code } = headlineOf(step, folder);
			return {
				icon: TerminalIcon,
				words: <HeadWords verb={verb} object={object} code={code} />,
				detail: <Terminal command={step.command} output={step.output ?? ""} isStreaming={step.running !== false} />,
			};
		}
		case "waiting":
			return {
				icon: CircleAlertIcon,
				words: (
					<HeadWords verb="Waiting on you to allow" object={middleEllipsis(cleanCommand(step.command, folder))} code />
				),
				detail: <Raw text={step.command} />,
			};
		case "said":
			return {
				icon: MessageSquareIcon,
				words: <HeadWords verb="Said" object={oneline(step.text)} code={false} />,
				detail: <ClampedText text={step.text} />,
			};
	}
}

/** A step in the sheet, folded to its one line; the row is a real button, 44px tall on a touch screen. */
function StepRow({
	step,
	folder,
	last,
	working,
	agent,
	open,
	onToggle,
}: {
	step: HarnessStep;
	folder: string;
	last: boolean;
	working: boolean;
	agent?: string | undefined;
	open: boolean;
	onToggle: () => void;
}) {
	const status = step.kind === "waiting" ? "active" : last && working ? "active" : "complete";
	const { icon, words, detail, always } = stepLine(step, folder, agent);
	if (detail === undefined)
		return (
			<ChainOfThoughtStep
				icon={icon}
				status={status}
				label={<span className="flex min-w-0 items-baseline gap-1.5">{words}</span>}
			>
				{always}
			</ChainOfThoughtStep>
		);
	return (
		<ChainOfThoughtStep
			icon={icon}
			status={status}
			label={
				// the touch target grows by an invisible halo (±13px: 44px on an 18px row), never by moving the text off
				// the icon's line; expanded content stays in this text column, aligned with the words, not the icon
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="relative -mx-1 flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-field px-1 text-left outline-none before:absolute before:inset-x-0 before:inset-y-0 hover:bg-paper-2 focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:before:-inset-y-[13px] max-sm:before:-inset-y-[13px]"
				>
					<span className="flex min-w-0 flex-1 items-baseline gap-1.5">{words}</span>
					<span aria-hidden="true" className="flex h-[1.125rem] shrink-0 items-center">
						<ChevronDownIcon
							className={cn(
								"size-3.5 shrink-0 text-ink-3 transition-transform motion-reduce:transition-none",
								open && "rotate-180",
							)}
						/>
					</span>
				</button>
			}
		>
			{open ? detail : null}
		</ChainOfThoughtStep>
	);
}

/**
 * Every step of the session, for the sheet and the panel: each step folded to one line until the owner opens it.
 * With `follow` it opens at the newest step and follows it until the owner scrolls up, the chat's way back down.
 */
export function HarnessTranscript({
	session,
	onSteer,
	follow = false,
	defaultOpenSteps,
	className,
}: {
	session: HarnessSessionView;
	onSteer?: (text: string) => void;
	/** In the steps sheet: a bounded, scrolling log that sticks to the newest step. */
	follow?: boolean;
	/** For fixtures: steps open at first, by key ("run:5"). */
	defaultOpenSteps?: readonly string[];
	className?: string;
}) {
	const working = session.state === "working";
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(defaultOpenSteps));
	const header = (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="flex items-center gap-2 text-ui">
				<HarnessMark
					provider={session.provider}
					logo={session.logo}
					className={session.provider === undefined && session.logo === undefined ? "size-4" : "size-5"}
				/>
				<span className="font-medium text-ink">{session.harness}</span>
				<span className="min-w-0 truncate text-meta text-ink-2">{projectOf(session.folder)}</span>
				<span className="ml-auto shrink-0 text-meta text-ink-2 tabular-nums">
					{stateWordsOf(session.state, session.elapsed)}
				</span>
			</span>
			<span className="min-w-0 truncate text-meta text-ink-2">
				{session.task === undefined ? null : (
					<>
						session {session.task}
						{session.continues === undefined ? "" : `, on from ${session.continues}`} ·{" "}
					</>
				)}
				<span className="font-code">{session.folder}</span>
			</span>
		</div>
	);
	const steps = (
		<ChainOfThought open>
			<ChainOfThoughtContent>
				{session.steps.map((step, index) => {
					const key = stepKey(step, index, session.dropped);
					return (
						<StepRow
							key={key}
							step={step}
							folder={session.folder}
							last={index === session.steps.length - 1}
							working={working}
							agent={session.agent}
							open={open.has(key)}
							onToggle={() => setOpen((prior) => toggledStep(prior, key))}
						/>
					);
				})}
			</ChainOfThoughtContent>
		</ChainOfThought>
	);
	const tail = working ? (
		<Shimmer as="span" className="text-ui">
			Working…
		</Shimmer>
	) : null;
	const steer = live(session.state) ? <SteerField harness={session.harness} onSteer={onSteer} /> : null;
	if (!follow)
		return (
			<div className={cn("flex min-w-0 flex-col gap-4", className)}>
				{header}
				{steps}
				{tail}
				{steer}
			</div>
		);
	return (
		<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-4", className)}>
			{header}
			<Conversation aria-label="Steps" className="-mx-1">
				<ConversationContent className="gap-2 px-1">
					{steps}
					{tail}
				</ConversationContent>
				<ConversationScrollButton label="Jump to latest" />
			</Conversation>
			{steer}
		</div>
	);
}
