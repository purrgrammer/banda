/**
 * A harness session in the chat: an agent asked a coding harness (Claude Code) to work in a folder on the owner's
 * computer. The card follows it live, one line for its latest step; the owner can steer it in their own words or stop
 * it; the panel shows every step. The draft that starts it and the harness's own asks are ordinary approval cards.
 */
import {
	BrainIcon,
	CheckIcon,
	CircleAlertIcon,
	FileTextIcon,
	type LucideIcon,
	MessageSquareIcon,
	PencilIcon,
	SendIcon,
	SquareIcon,
	TerminalIcon,
	UserIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/cn";
import { Tile } from "./Cards.tsx";

/** One step of a session, as the harness reported it. */
export type HarnessStep =
	| { readonly kind: "asked"; readonly text: string }
	| { readonly kind: "steered"; readonly text: string; readonly taken: boolean }
	| { readonly kind: "read"; readonly path: string }
	| { readonly kind: "thought"; readonly text: string }
	| {
			readonly kind: "edit";
			readonly path: string;
			readonly added: number;
			readonly removed: number;
			readonly diff?: string;
	  }
	| { readonly kind: "run"; readonly command: string; readonly output?: string; readonly running?: boolean }
	| { readonly kind: "waiting"; readonly command: string }
	| { readonly kind: "said"; readonly text: string };

export type HarnessState = "working" | "waiting" | "done" | "stopped" | "interrupted";

export type HarnessSessionView = {
	/** The harness by name: "Claude Code". */
	readonly harness: string;
	/** The folder it works in, as the owner knows it: "~/sancho". */
	readonly folder: string;
	readonly state: HarnessState;
	readonly steps: readonly HarnessStep[];
	/** How long it has run: "1:48". */
	readonly elapsed: string;
	/** Its last words once it ended, first line only. */
	readonly outcome?: string | undefined;
};

/** The one line the card shows for a step: a verb and what it acted on. */
export function headlineOf(step: HarnessStep | undefined): { verb: string; object: string } {
	switch (step?.kind) {
		case "read":
			return { verb: "Reading", object: step.path };
		case "edit":
			return { verb: "Editing", object: step.path };
		case "run":
			return { verb: step.running === false ? "Ran" : "Running", object: step.command };
		case "waiting":
			return { verb: "Waiting on you:", object: step.command };
		case "thought":
			return { verb: "Thinking", object: "" };
		case "steered":
			return { verb: "Taking your note", object: "" };
		case "said":
			return { verb: "Writing", object: "" };
		default:
			return { verb: "Starting", object: "" };
	}
}

/** Files it changed, counted once per path, with the lines added and removed across its edits. */
export function changesOf(steps: readonly HarnessStep[]): { files: number; added: number; removed: number } {
	const paths = new Set<string>();
	let added = 0;
	let removed = 0;
	for (const step of steps) {
		if (step.kind !== "edit") continue;
		paths.add(step.path);
		added += step.added;
		removed += step.removed;
	}
	return { files: paths.size, added, removed };
}

const live = (state: HarnessState) => state === "working" || state === "waiting";

function Changes({ steps }: { steps: readonly HarnessStep[] }) {
	const { files, added, removed } = changesOf(steps);
	if (files === 0) return <span>No files changed</span>;
	return (
		<span className="tabular-nums">
			{files} {files === 1 ? "file" : "files"} <span className="text-alive">+{added}</span>{" "}
			<span className="text-danger">−{removed}</span>
		</span>
	);
}

/** Words for the harness, sent as the owner's own: no draft, the harness takes them after its current step. */
export function SteerField({
	harness,
	onSteer,
	className,
}: {
	harness: string;
	onSteer?: ((text: string) => void) | undefined;
	className?: string;
}) {
	const [text, setText] = useState("");
	const send = () => {
		const words = text.trim();
		if (words === "") return;
		onSteer?.(words);
		setText("");
	};
	return (
		<InputGroup className={className}>
			<InputGroupInput
				value={text}
				aria-label={`Tell ${harness}`}
				placeholder={`Tell ${harness}…`}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
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

/** Connecting a harness: the folder it works in is the account; what runs freely and what asks, said before. */
export function HarnessConnectCard({
	agent,
	harness,
	folder: given = "",
	connected,
	onConnect,
	onDismiss,
}: {
	agent: string;
	harness: string;
	folder?: string;
	/** The folder once connected: the card says done. */
	connected?: string | undefined;
	onConnect?: (folder: string) => void;
	onDismiss?: () => void;
}) {
	const [folder, setFolder] = useState(given);
	const id = `harness-folder-${harness.replace(/\W/g, "")}`;
	const head = (
		<span className="flex items-center gap-3">
			<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
				<TerminalIcon aria-hidden="true" className="size-4.5 text-ink-2" />
			</span>
			<span className="flex min-w-0 flex-col">
				<span className="text-ui font-semibold text-ink">
					{connected === undefined ? `Connect ${harness}` : `${harness} is connected`}
				</span>
				<span className="text-meta text-ink-2">
					{connected === undefined ? `For ${agent}, on this computer` : `In ${connected} · on for ${agent}`}
				</span>
			</span>
		</span>
	);
	if (connected !== undefined) return <Tile className="flex flex-col gap-3 p-4">{head}</Tile>;
	return (
		<Tile className="flex flex-col gap-3 p-4">
			{head}
			<label htmlFor={id} className="flex flex-col gap-1.5">
				<span className="text-meta text-ink-2">The folder it works in</span>
				<InputGroup>
					<InputGroupInput
						id={id}
						value={folder}
						className="font-code"
						placeholder="~/code/project"
						onChange={(event) => setFolder(event.target.value)}
					/>
				</InputGroup>
			</label>
			<ul className="flex flex-col gap-1 text-ui text-ink-2">
				<li>
					<span className="text-ink">Edits</span> in this folder run without asking. You see every change.
				</li>
				<li>
					<span className="text-ink">Commands</span>, and anything outside the folder, ask you first.
				</li>
				<li>It uses your {harness} sign-in and settings on this computer, including what you allowed there.</li>
			</ul>
			<span className="flex flex-wrap gap-2">
				<Button disabled={folder.trim() === ""} onClick={() => onConnect?.(folder.trim())}>
					Connect {harness}
				</Button>
				{onDismiss === undefined ? null : (
					<Button variant="ghost" onClick={onDismiss}>
						Not now
					</Button>
				)}
			</span>
		</Tile>
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
	const { verb, object } = headlineOf(
		state === "waiting" ? [...steps].reverse().find((step) => step.kind === "waiting") : last,
	);
	const notes = steps.filter((step): step is Extract<HarnessStep, { kind: "steered" }> => step.kind === "steered");
	return (
		<Tile className="flex flex-col gap-2.5 p-4">
			<span className="flex items-center gap-2 text-ui">
				<span
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						live(state) ? "bg-alive motion-safe:animate-pulse" : state === "done" ? "bg-ink" : "bg-ink-3",
					)}
				/>
				<span className="font-medium text-ink">{harness}</span>
				<span className="min-w-0 truncate font-code text-meta text-ink-2">{folder}</span>
				{live(state) ? (
					<Button variant="ghost" size="xs" className="ml-auto" onClick={onStop}>
						<SquareIcon />
						Stop
					</Button>
				) : null}
			</span>
			<span className="flex min-h-6 min-w-0 items-baseline gap-2 text-body">
				{state === "done" ? (
					<>
						<CheckIcon aria-hidden="true" className="size-4 shrink-0 self-center text-ink" />
						<span className="min-w-0 text-ink">{outcome ?? "Finished"}</span>
					</>
				) : state === "stopped" || state === "interrupted" ? (
					<>
						{state === "stopped" ? (
							<SquareIcon aria-hidden="true" className="size-3.5 shrink-0 self-center text-ink-2" />
						) : (
							<CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 self-center text-danger" />
						)}
						<span className="min-w-0 text-ink">
							{state === "stopped" ? "You stopped it" : "Interrupted when banda restarted. Nothing was sent again."}
						</span>
					</>
				) : (
					<>
						<span className="shrink-0 text-ink-2">{verb}</span>
						{object === "" ? null : state === "working" ? (
							<Shimmer as="span" className="min-w-0 truncate font-code text-ui">
								{object}
							</Shimmer>
						) : (
							<span className="min-w-0 truncate font-code text-ui text-ink">{object}</span>
						)}
					</>
				)}
			</span>
			{notes.length === 0 ? null : (
				<ul className="flex flex-col gap-1">
					{notes.map((note) => (
						<li key={note.text} className="flex min-w-0 items-baseline gap-1.5 text-meta text-ink-2">
							<UserIcon aria-hidden="true" className="size-3 shrink-0 self-center" />
							<span className="min-w-0 truncate text-ink">{note.text}</span>
							<span className="shrink-0">· {note.taken ? "taken" : "after this step"}</span>
						</li>
					))}
				</ul>
			)}
			{live(state) ? <SteerField harness={harness} onSteer={onSteer} /> : null}
			<span className="flex items-center gap-3 text-meta text-ink-2">
				<Changes steps={steps} />
				<span className="tabular-nums">{elapsed}</span>
				<Button variant="outline" size="xs" className="ml-auto" onClick={onOpen}>
					Open
				</Button>
			</span>
		</Tile>
	);
}

function Step({ step, last, working }: { step: HarnessStep; last: boolean; working: boolean }) {
	const status = last && working ? "active" : "complete";
	const at = (icon: LucideIcon, label: ReactNode, children?: ReactNode) => (
		<ChainOfThoughtStep icon={icon} status={status} label={label}>
			{children}
		</ChainOfThoughtStep>
	);
	const path = (words: string, file: string) => (
		<span className="min-w-0">
			<span className="text-ink-2">{words} </span>
			<span className="font-code text-meta [overflow-wrap:anywhere]">{file}</span>
		</span>
	);
	switch (step.kind) {
		case "asked":
			return at(MessageSquareIcon, <span className="text-ink-2">Asked</span>, <p className="text-ui">{step.text}</p>);
		case "steered":
			return at(
				UserIcon,
				<span className="text-ink-2">You said{step.taken ? "" : " · after this step"}</span>,
				<p className="text-ui">{step.text}</p>,
			);
		case "read":
			return at(FileTextIcon, path("Read", step.path));
		case "thought":
			return (
				<ChainOfThoughtStep icon={BrainIcon} status={status} label={<span className="text-ink-2">Thought</span>}>
					<details className="text-meta text-ink-2">
						<summary className="cursor-pointer hover:text-ink">Show</summary>
						<p className="mt-1">{step.text}</p>
					</details>
				</ChainOfThoughtStep>
			);
		case "edit":
			return at(
				PencilIcon,
				<span className="flex min-w-0 items-baseline gap-2">
					{path("Edited", step.path)}
					<span className="shrink-0 text-meta tabular-nums">
						<span className="text-alive">+{step.added}</span> <span className="text-danger">−{step.removed}</span>
					</span>
				</span>,
				step.diff === undefined ? null : <CodeBlock code={step.diff} language="diff" title={step.path} />,
			);
		case "run":
			return at(
				TerminalIcon,
				<span className="text-ink-2">{step.running === false ? "Ran" : "Running"}</span>,
				<Terminal command={step.command} output={step.output ?? ""} isStreaming={step.running !== false} />,
			);
		case "waiting":
			return (
				<ChainOfThoughtStep
					icon={CircleAlertIcon}
					status="active"
					label={<span className="text-ink">Waiting on you to allow</span>}
				>
					<span className="font-code text-meta [overflow-wrap:anywhere]">{step.command}</span>
				</ChainOfThoughtStep>
			);
		case "said":
			return at(MessageSquareIcon, <span className="text-ink-2">Said</span>, <p className="text-ui">{step.text}</p>);
	}
}

/** Every step of the session, for the panel, with the same way to steer it while it runs. */
export function HarnessTranscript({
	session,
	onSteer,
}: {
	session: HarnessSessionView;
	onSteer?: (text: string) => void;
}) {
	const working = session.state === "working";
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<span className="flex items-center gap-2 text-ui">
				<span className="font-medium text-ink">{session.harness}</span>
				<span className="min-w-0 truncate font-code text-meta text-ink-2">{session.folder}</span>
				<span className="ml-auto shrink-0 text-meta text-ink-2 tabular-nums">{session.elapsed}</span>
			</span>
			<ChainOfThought open>
				<ChainOfThoughtContent>
					{session.steps.map((step, index) => (
						<Step
							// biome-ignore lint/suspicious/noArrayIndexKey: steps are append-only, a step is its place
							key={`${step.kind}:${index}`}
							step={step}
							last={index === session.steps.length - 1}
							working={working}
						/>
					))}
				</ChainOfThoughtContent>
			</ChainOfThought>
			{working ? (
				<Shimmer as="span" className="text-ui">
					Working…
				</Shimmer>
			) : null}
			{live(session.state) ? <SteerField harness={session.harness} onSteer={onSteer} /> : null}
		</div>
	);
}
