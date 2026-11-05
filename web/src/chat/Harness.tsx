/**
 * A harness session in the chat: an agent handed work to a coding harness (Claude Code, Codex, pi) in a project on the
 * owner's computer, at once, with no draft. The card follows it live, one line for its latest step; the owner steers it
 * in their own words or stops it; the sheet shows every step. The harness's own asks are ordinary approval cards.
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
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Terminal } from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
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
			readonly added?: number;
			readonly removed?: number;
			readonly diff?: string;
	  }
	| { readonly kind: "run"; readonly command: string; readonly output?: string; readonly running?: boolean }
	| { readonly kind: "waiting"; readonly command: string }
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
	/** How long it has run: "1:48". */
	readonly elapsed: string;
	/** Its last words once it ended, first line only. */
	readonly outcome?: string | undefined;
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

function Changes({ steps }: { steps: readonly HarnessStep[] }) {
	const { files, added, removed } = changesOf(steps);
	if (files === 0) return <span>No files changed</span>;
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

/**
 * A harness on this computer: connecting picks the folder it works in (the account); connected, it says where, is
 * switched on or off for the agent, and its folder changes or it disconnects. What runs freely and what asks is said
 * before connecting.
 */
export function HarnessConnectCard({
	agent,
	harness,
	folder: given = "",
	connected,
	on,
	asks,
	about,
	provider,
	logo,
	folded = false,
	onRemove,
	onConnect,
	onSwitch,
	onDisconnect,
	onDismiss,
}: {
	/** The agent it is for; none on the Connections page. */
	agent?: string | undefined;
	harness: string;
	/** The folder the field starts with. */
	folder?: string;
	/** The folder it is connected in: the card says so. */
	connected?: string | undefined;
	/** Whether `agent` may use it. */
	on?: boolean | undefined;
	/** What it asks the owner, in its file's words. */
	asks?: string | undefined;
	/** What it is, in a line: the folded card's subtitle. */
	about?: string | undefined;
	/** Whose it is: its card shows that provider's logo. */
	provider?: string | undefined;
	/** Its own mark, shown before a provider's. */
	logo?: string | undefined;
	/** Not connected, it shows as one row with Connect until that is tapped. */
	folded?: boolean;
	/** The owner added it: Remove forgets it. */
	onRemove?: (() => void) | undefined;
	/** Connect, or change the folder; a promise keeps the field open until it settles, and open when it fails. */
	onConnect?: (folder: string) => unknown;
	onSwitch?: ((on: boolean) => void) | undefined;
	onDisconnect?: (() => void) | undefined;
	onDismiss?: (() => void) | undefined;
}) {
	const [folder, setFolder] = useState(connected ?? given);
	const [changing, setChanging] = useState(false);
	const id = `harness-folder-${harness.replace(/\W/g, "")}${agent === undefined ? "" : `-${agent.replace(/\W/g, "")}`}`;
	const [opened, setOpened] = useState(false);
	const asking = connected === undefined || changing;
	if (connected === undefined && folded && !opened)
		return (
			<Tile className="flex items-center gap-3 p-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
					<HarnessMark provider={provider} logo={logo} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-ui font-semibold text-ink">{harness}</span>
					<span className="min-w-0 truncate text-meta text-ink-2">{about ?? "On this computer"}</span>
				</span>
				{onRemove === undefined ? null : (
					<Button variant="ghost" size="sm" onClick={onRemove}>
						Remove
					</Button>
				)}
				<Button variant="outline" size="sm" onClick={() => setOpened(true)}>
					Connect
				</Button>
			</Tile>
		);
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
					<HarnessMark provider={provider} logo={logo} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-ui font-semibold text-ink">
						{connected === undefined ? `Connect ${harness}` : harness}
					</span>
					<span className="min-w-0 truncate text-meta text-ink-2">
						{connected === undefined
							? agent === undefined
								? "On this computer, for the agents you choose"
								: `For ${agent}, on this computer`
							: `In ${connected}`}
					</span>
				</span>
				{connected !== undefined && agent !== undefined && onSwitch !== undefined ? (
					<Switch
						checked={on === true}
						aria-label={`${harness} for ${agent}`}
						onCheckedChange={(next) => onSwitch(next)}
					/>
				) : null}
			</span>
			{asking ? (
				<>
					<label htmlFor={id} className="flex flex-col gap-1.5">
						<span className="text-meta text-ink-2">Your code folder</span>
						<InputGroup>
							<InputGroupInput
								id={id}
								value={folder}
								className="font-code"
								placeholder="~/code"
								onChange={(event) => setFolder(event.target.value)}
							/>
						</InputGroup>
					</label>
					{connected === undefined ? (
						<ul className="flex flex-col gap-1 text-ui text-ink-2">
							<li>Each task works in one of its projects (a git repository), or in the folder itself.</li>
							<li>{asks ?? "It asks you whatever its own settings on this computer ask."}</li>
							<li>
								{agent ?? "Your agents"} can start it without asking you. It uses your {harness} sign-in and settings on
								this computer.
							</li>
						</ul>
					) : null}
					<span className="flex flex-wrap gap-2">
						<Button
							disabled={folder.trim() === "" || folder.trim() === connected}
							onClick={() => {
								const done = onConnect?.(folder.trim());
								// a refused folder leaves the field as it was, to fix
								void Promise.resolve(done).then(
									() => setChanging(false),
									() => {},
								);
							}}
						>
							{connected === undefined ? `Connect ${harness}` : "Use this folder"}
						</Button>
						{changing ? (
							<Button
								variant="ghost"
								onClick={() => {
									setChanging(false);
									setFolder(connected ?? given);
								}}
							>
								Cancel
							</Button>
						) : onDismiss === undefined ? null : (
							<Button variant="ghost" onClick={onDismiss}>
								Not now
							</Button>
						)}
						{connected === undefined && onRemove !== undefined ? (
							<Button variant="ghost" onClick={onRemove}>
								Remove
							</Button>
						) : null}
					</span>
				</>
			) : (
				<span className="flex flex-wrap items-center gap-2">
					{agent !== undefined && onSwitch !== undefined ? (
						<span className="mr-auto text-meta text-ink-2">{on === true ? `On for ${agent}` : `Off for ${agent}`}</span>
					) : null}
					<Button variant="outline" size="sm" onClick={() => setChanging(true)}>
						Change folder
					</Button>
					{onDisconnect === undefined ? null : (
						<Button variant="ghost" size="sm" onClick={onDisconnect}>
							Disconnect
						</Button>
					)}
					{onRemove === undefined ? null : (
						<Button variant="ghost" size="sm" onClick={onRemove}>
							Remove
						</Button>
					)}
				</span>
			)}
		</Tile>
	);
}

/** A harness banda knows but this computer has not installed: what it is, and the command that installs it. */
export function HarnessMissingCard({
	harness,
	about,
	install,
	provider,
	logo,
}: {
	harness: string;
	logo?: string;
	about?: string;
	install?: string;
	provider?: string;
}) {
	return (
		<Tile className="flex flex-col gap-2.5 p-3">
			<span className="flex items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
					<HarnessMark provider={provider} logo={logo} className="opacity-60" />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-ui font-semibold text-ink-2">{harness}</span>
					<span className="min-w-0 truncate text-meta text-ink-2">{about ?? "Not on this computer"}</span>
				</span>
				<span className="shrink-0 text-meta text-ink-2">Not installed</span>
			</span>
			{install === undefined ? null : (
				<span className="flex min-w-0 items-center gap-2 rounded-field bg-paper-2 px-3 py-2">
					<code className="min-w-0 flex-1 font-code text-meta break-all text-ink">{install}</code>
					<CodeBlockCopyButton text={install} label={`Copy how to install ${harness}`} />
				</span>
			)}
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
				<HarnessMark
					provider={session.provider}
					logo={session.logo}
					className={session.provider === undefined && session.logo === undefined ? "size-4" : "size-5"}
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
				) : state === "stopped" || state === "interrupted" || state === "failed" ? (
					<>
						{state === "stopped" ? (
							<SquareIcon aria-hidden="true" className="size-3.5 shrink-0 self-center text-ink-2" />
						) : (
							<CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 self-center text-danger" />
						)}
						<span className="min-w-0 text-ink">
							{state === "stopped"
								? "You stopped it"
								: state === "failed"
									? `It ended with a problem: ${outcome ?? "it did not say why"}`
									: "Interrupted when banda restarted. Nothing was sent again."}
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
					{step.added === undefined || step.removed === undefined ? null : (
						<span className="shrink-0 text-meta tabular-nums">
							<span className="text-alive">+{step.added}</span> <span className="text-danger">−{step.removed}</span>
						</span>
					)}
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
				<HarnessMark
					provider={session.provider}
					logo={session.logo}
					className={session.provider === undefined && session.logo === undefined ? "size-4" : "size-5"}
				/>
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
