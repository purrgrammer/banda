/**
 * What the owner sets. An agent's parts, which its panel's tabs show: its face and name, its personality in the
 * owner's words, its connections, permissions, memory, thinking tier and archive. A new agent is a short sheet with the
 * face defaulted: naming a friend, not filling a form. And Settings, one page. Every change is in effect at once.
 */
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	ChevronLeftIcon,
	EllipsisIcon,
	PencilIcon,
	PlusIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { accountTitle, backendOf } from "../../../src/core/provider-accounts.ts";
import { TIER_WORDS, TIERS, type Tier } from "../../../src/core/tiers.ts";
import { AvatarChoices } from "../avatar/Choices.tsx";
import type { ModelView, TiersView } from "../lib/api.ts";
import { Confirm } from "./Confirm.tsx";
import { ConnectionIcon } from "./ConnectionIcon.tsx";
import { Face, FaceStack } from "./Face.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ProviderAccountForm, ProviderAccountRename } from "./ProviderAccountForm.tsx";
import { ProviderKeyForm } from "./ProviderKeyForm.tsx";
import { ProviderSignIn, type SignInWay } from "./ProviderSignIn.tsx";
import type { Who } from "./Row.tsx";
import { shownTier, tierPicks } from "./tier-picks.ts";

/** A settings page: a bar with back and the title, then sections at a reading width. */
export function SettingsPage({
	title,
	phone = false,
	footer,
	onBack,
	wide = false,
	children,
}: {
	title: string;
	phone?: boolean;
	/** A page that reads like a document (a skill's instructions): the whole pane, not the settings column. */
	wide?: boolean;
	onBack?: () => void;
	/** The page's one action, pinned at the foot: "Add to the band". */
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex h-full min-w-0 flex-1 flex-col bg-paper">
			<header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line-soft px-2.5">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={phone ? "Close" : "Back to the chat"}
					className="text-ink-2"
					onClick={onBack}
				>
					{phone ? <XIcon /> : <ChevronLeftIcon className="size-5" />}
				</Button>
				<h1 data-page-title="" tabIndex={-1} className="text-ui font-semibold text-ink focus:outline-none">
					{title}
				</h1>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div
					className={cn("mx-auto flex flex-col gap-8 px-4 py-6", wide ? "w-full max-w-none md:px-8" : "max-w-[34rem]")}
				>
					{children}
				</div>
			</div>
			{footer === undefined ? null : (
				<div className="mx-auto flex w-full max-w-[34rem] gap-2 border-t border-line-soft px-4 py-3">{footer}</div>
			)}
		</div>
	);
}

/** One section of a settings page: a title, a line saying what it is for, its rows. */
export function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3">
			<header className="flex flex-col gap-0.5">
				<h2 className="text-body font-semibold text-ink">{title}</h2>
				{note === undefined ? null : <p className="text-ui text-ink-2">{note}</p>}
			</header>
			{children}
		</section>
	);
}

/** Rows in a hairline box: a setting each. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"flex flex-col divide-y divide-line-soft overflow-hidden rounded-tile border border-line-soft",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function RowOf({
	lead,
	title,
	detail,
	end,
	className,
}: {
	lead?: ReactNode;
	title: ReactNode;
	detail?: ReactNode;
	end?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex min-h-12 items-center gap-3 px-3.5 py-2.5", className)}>
			{lead}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="text-ui text-ink">{title}</span>
				{detail === undefined ? null : <span className="text-meta text-ink-2">{detail}</span>}
			</span>
			{end}
		</div>
	);
}

/** The face and the name, side by side: the face opens the shape and colour picker. */
export function FaceAndName({
	who,
	autoFocus = false,
	onChange,
}: {
	who: Who;
	autoFocus?: boolean;
	/** The face or the name changed: both, as they stand. */
	onChange?: (who: Who) => void;
}) {
	const [face, setFace] = useState(who.face);
	const [name, setName] = useState(who.name);
	const [picking, setPicking] = useState(false);
	// a face chosen elsewhere (designed from a description) replaces the one shown
	useEffect(() => {
		setFace(who.face);
	}, [who.face]);
	return (
		<div className="flex items-center gap-4">
			<Popover open={picking} onOpenChange={setPicking}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={`${name || "The agent"}'s face. Change it`}
						className="group/face relative rounded-full"
					>
						<Face face={face} name={name} size="panel" />
						<span className="absolute -right-0.5 -bottom-0.5 flex size-6 items-center justify-center rounded-full bg-paper text-ink-2 shadow-[0_0_0_1px_var(--line)] group-hover/face:text-ink">
							<PencilIcon className="size-3" />
						</span>
					</button>
				</PopoverTrigger>
				<PopoverContent
					className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
					align="start"
					aria-label="Choose a face"
				>
					<AvatarChoices
						initial={face}
						name={name}
						onPick={(picked) => {
							setFace(picked);
							onChange?.({ face: picked, name });
						}}
					/>
				</PopoverContent>
			</Popover>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
			<label className="flex flex-1 flex-col gap-1.5">
				<span className="text-ui font-medium text-ink">Name</span>
				<Input
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						onChange?.({ face, name: event.target.value });
					}}
					placeholder="Name your agent"
					autoFocus={autoFocus}
					className="text-heading"
				/>
			</label>
		</div>
	);
}

const STARTERS = {
	Researcher:
		"Curious and careful. Digs into what I ask until it's solid, says where each fact comes from, and tells me when the sources disagree.",
	Writer:
		"Writes the way I talk: short, plain, no fluff. Drafts my emails and posts, and never sends anything without showing me first.",
	"Keeper of the calendar":
		"Keeps my week sane. Knows what's coming, protects my mornings, and tells me the night before if tomorrow looks wrong.",
} as const;

/** The personality, the body of the agent's file, in the owner's words; a new agent may begin from a starter. */
export function Personality({
	text,
	starters = false,
	onChange,
}: {
	text?: string | undefined;
	/** Three starters to begin from: only when the agent is being made. */
	starters?: boolean;
	onChange?: (text: string) => void;
}) {
	const [value, set] = useState(text ?? "");
	const setValue = (next: string) => {
		set(next);
		onChange?.(next);
	};
	return (
		<Block title="Personality" note="How it talks and what it cares about, in your words.">
			<Textarea
				aria-label="Personality"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				placeholder="Warm and brief. Plans our family trips, keeps to the budget, and asks before booking anything."
				className="min-h-32"
			/>
			{starters ? (
				<span className="flex flex-wrap items-center gap-2">
					<span className="text-meta text-ink-2">Start from</span>
					{Object.entries(STARTERS).map(([name, words]) => (
						<button
							key={name}
							type="button"
							onClick={() => setValue(words)}
							className="rounded-full border border-line px-3 py-1 text-meta text-ink hover:bg-paper-3"
						>
							{name}
						</button>
					))}
				</span>
			) : null}
		</Block>
	);
}

export type ConnectionRow = {
	readonly connection: string;
	readonly icon?: ReactNode;
	/** Its name in the daemon ("github"), when it has one: what `connect` and the switches are for. */
	readonly id?: string | undefined;
	readonly url?: string | undefined;
	/** Every account signed in to it, and whether this agent may use each. */
	readonly accounts: readonly { readonly login: string; readonly on: boolean; readonly account?: string }[];
};

/**
 * The connections an agent uses: one row per account switched on for it, Remove asked first. Managing access and
 * accounts lives on the Connections page; adding one is the caller's (Add opens its dialog).
 */
export function Connections({
	agent,
	rows,
	onSwitch,
	onDetails,
	empty = "Nothing to connect yet.",
}: {
	agent: string;
	rows: readonly ConnectionRow[];
	/** What it says with no account on for the agent. */
	empty?: string | undefined;
	/** The owner took an account away from the agent (or gave it back). */
	onSwitch?: ((row: ConnectionRow, account: ConnectionRow["accounts"][number], on: boolean) => void) | undefined;
	/** Open the connection's details. */
	onDetails?: ((row: ConnectionRow) => void) | undefined;
}) {
	const used = rows.flatMap((row) => row.accounts.filter((account) => account.on).map((account) => ({ row, account })));
	return (
		<Block title="Connections" note={`What ${agent} may read. It asks before anything it writes.`}>
			{used.length === 0 ? (
				<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">{empty}</p>
			) : (
				<div className="flex flex-col">
					{used.map(({ row, account }) => {
						const as = account.account === undefined ? undefined : account.login;
						const what = as === undefined ? row.connection : `${row.connection} as ${as}`;
						return (
							<div
								key={`${row.id ?? row.connection}/${account.account ?? account.login}`}
								className="flex min-h-11 items-center gap-3 py-1.5"
							>
								<span className="flex size-5 shrink-0 items-center justify-center">
									{row.icon ?? <ConnectionIcon connection={row.id ?? row.connection} url={row.url} />}
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-ui text-ink">{row.connection}</span>
									{as === undefined ? null : <span className="truncate text-meta text-ink-2">{as}</span>}
								</span>
								{onDetails === undefined || row.id === undefined ? null : (
									<Button variant="ghost" size="xs" className="text-ink-2" onClick={() => onDetails(row)}>
										Details
									</Button>
								)}
								<Confirm
									title={`Remove ${row.connection}?`}
									body={`${agent} stops using ${what}. The account stays signed in for the others; add it back at any time.`}
									action="Remove"
									keep="Keep it"
									onConfirm={() => onSwitch?.(row, account, false)}
								>
									<Button variant="ghost" size="icon-xs" className="text-ink-2" aria-label={`Remove ${what}`}>
										<XIcon />
									</Button>
								</Confirm>
							</div>
						);
					})}
				</div>
			)}
		</Block>
	);
}

/** Three tiers of thinking, picked by name; the exact model lives beside them. */
function Thinking({
	value,
	saving,
	disabled,
	onPick,
}: {
	value: Tier | undefined;
	saving: boolean;
	disabled: boolean;
	onPick: (tier: Tier) => void;
}) {
	return (
		<div role="radiogroup" aria-label="Thinking" aria-busy={saving} className="flex rounded-field bg-paper-3 p-0.5">
			{TIERS.map((one) => (
				// biome-ignore lint/a11y/useSemanticElements: a segment of a segmented control
				<button
					key={one}
					type="button"
					role="radio"
					aria-checked={one === value}
					disabled={disabled}
					onClick={() => {
						if (one !== value) onPick(one);
					}}
					className={cn(
						"relative flex-1 rounded-[6px] px-3 py-1.5 text-ui text-ink-2 disabled:opacity-60",
						one === value && "bg-paper font-medium text-ink shadow-[0_0_0_1px_var(--line-soft)]",
					)}
				>
					{TIER_WORDS[one].name}
					{saving && one === value ? (
						// after a beat, so a save the daemon answers at once does not flash it
						<span className="absolute inset-y-0 right-1.5 flex items-center duration-150 animate-in fade-in-0 delay-150 fill-mode-backwards">
							<Spinner aria-label="Saving" className="size-3 text-ink-3" />
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}

/**
 * How hard the agent thinks, by name: the model behind each tier is the provider's, set in Settings. A pick shows at
 * once and only this selector renders for it; `save` rejecting puts back the tier the store holds and calls `onFailed`.
 */
export function ThinkingTiers({
	tier,
	custom,
	save,
	onFailed,
}: {
	/** What the store holds. */
	tier: Tier | undefined;
	custom: boolean;
	save: (tier: Tier) => Promise<unknown>;
	onFailed: (error: unknown, retry: () => void) => void;
}) {
	const latest = useRef({ tier, save, onFailed });
	latest.current = { tier, save, onFailed };
	const [picks] = useState(() =>
		tierPicks({
			save: (picked) => latest.current.save(picked),
			failed: (error, retry) => latest.current.onFailed(error, retry),
			stored: () => latest.current.tier,
		}),
	);
	const view = useSyncExternalStore(picks.subscribe, picks.view, picks.view);
	useEffect(() => {
		picks.saw(tier);
	}, [picks, tier]);
	const note = custom
		? "This agent's file names its own model, so it thinks the same whatever is picked here."
		: tier === undefined
			? "You can pick this once the chat has started."
			: "Quick answers fast; Deep takes its time on hard things.";
	return (
		<Block title="Thinking" note={note}>
			<Thinking
				value={shownTier(view, tier)}
				saving={view.saving}
				disabled={custom || tier === undefined}
				onPick={picks.pick}
			/>
		</Block>
	);
}

/** The standing permissions the owner gave: each with its scope, revokable. */
export function Permissions({
	agent,
	permissions,
	onRevoke,
}: {
	agent: string;
	permissions: readonly { readonly id?: string; readonly what: string; readonly scope: string }[];
	/** Take one back: it covers nothing from then on. */
	onRevoke?: ((id: string) => void) | undefined;
}) {
	return (
		<Block title="Permissions" note={`What ${agent} may do without asking: each one you allowed, and until when.`}>
			{permissions.length === 0 ? (
				<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">Nothing yet: {agent} asks every time.</p>
			) : (
				<Rows>
					{permissions.map((permission) => (
						<RowOf
							key={permission.id ?? permission.what}
							title={permission.what}
							detail={permission.scope}
							end={
								<Confirm
									title="Take this back?"
									body={`${agent} will ask you again before it does this: ${permission.what}.`}
									action="Revoke"
									keep="Keep it"
									onConfirm={
										permission.id === undefined || onRevoke === undefined
											? undefined
											: () => onRevoke(permission.id as string)
									}
								>
									<Button variant="destructive" size="xs">
										Revoke
									</Button>
								</Confirm>
							}
						/>
					))}
				</Rows>
			)}
		</Block>
	);
}

/** What archiving `agent` does, as its confirm says it. */
export function archiveWords(agent: string) {
	return {
		title: `Archive ${agent}?`,
		body: `${agent} stops, its routines pause and what it may do without asking ends. Its chat, memory and files stay; restore it from Settings.`,
	};
}

/**
 * The foot of an agent's About: Archive, after a short confirm. The last active agent cannot be archived, since the app
 * opens in a chat: the button is off and says why. A refusal shows under it.
 */
export function Archive({
	agent,
	last = false,
	onArchive,
}: {
	agent: string;
	/** It is the only active agent. */
	last?: boolean;
	onArchive?: () => Promise<unknown> | undefined;
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	const words = archiveWords(agent);
	return (
		<Block
			title="Archive"
			note={
				last
					? `${agent} is your only active agent, and banda opens in its chat: make another before archiving it.`
					: `${agent} leaves the band; its chat is kept, and Settings can bring it back.`
			}
		>
			<AlertDialog>
				<AlertDialogTrigger asChild>
					<Button variant="destructive" className="self-start" disabled={last}>
						<ArchiveIcon />
						Archive {agent}
					</Button>
				</AlertDialogTrigger>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{words.title}</AlertDialogTitle>
						<AlertDialogDescription>{words.body}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep {agent}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setError(undefined);
								void onArchive?.()?.catch((failed: unknown) =>
									setError(failed instanceof Error ? failed.message : String(failed)),
								);
							}}
						>
							Archive
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
		</Block>
	);
}

/** Archive's confirm as it opens, laid out in place: for the specimen, which shows it without covering the page. */
export function ArchiveConfirm({ agent }: { agent: string }) {
	const words = archiveWords(agent);
	return (
		<div className="flex w-full max-w-xs flex-col gap-4 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10">
			<div className="flex flex-col gap-1.5">
				<p className="text-body font-semibold text-ink">{words.title}</p>
				<p className="text-ui text-ink-2">{words.body}</p>
			</div>
			<div className="flex justify-end gap-2">
				<Button variant="outline">Keep {agent}</Button>
				<Button variant="destructive">Archive</Button>
			</div>
		</div>
	);
}

/** A group: who is in it, and its name. */
export function Members({ band, picked }: { band: readonly Who[]; picked: readonly string[] }) {
	return (
		<Block title="Who's in it" note="A message asks everyone unless it mentions one.">
			<Rows>
				{band.map((who) => (
					// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
					<label key={who.name} className="flex h-12 items-center gap-3 px-3.5">
						<Face face={who.face} name={who.name} size="message" />
						<span className="flex-1 text-ui text-ink">{who.name}</span>
						<Switch defaultChecked={picked.includes(who.name)} aria-label={`${who.name} in the group`} />
					</label>
				))}
			</Rows>
		</Block>
	);
}

/** A connection, as Settings lists it: one row whatever its accounts, a server with no sign-in among them. */
export type ConnectionLine = {
	readonly id: string;
	readonly service: string;
	/** The accounts signed in to it; none for a connection that needs no sign-in. */
	readonly logins: readonly string[];
	/** The agents that use it, by name. */
	readonly agents: readonly string[];
	/** An account's sign-in no longer fits what the connection asks. */
	readonly stale?: boolean;
};

export type SettingsData = {
	/** The provider the band thinks with, and the model behind each tier, by name. */
	readonly provider: { readonly id: string; readonly name: string };
	readonly models: { readonly quick: string; readonly balanced: string; readonly deep: string };
	readonly connections: readonly ConnectionLine[];
	/** Archived agents, to restore: each with when it was archived, in words. */
	readonly archived: readonly (Who & { readonly id?: string; readonly when: string })[];
	/** Archived groups, to restore: each its room, name, members' faces, and when it was archived, in words. */
	readonly archivedGroups?: readonly ArchivedGroup[];
	/** The owner's limits on every group; undefined until the daemon said. */
	readonly groupLimits?: GroupLimits | undefined;
	readonly theme: "system" | "light" | "dark";
	/** The pinned agents' tiles sit in the middle of the band's top row while they fit in one; left-aligned otherwise. */
	readonly centred?: boolean;
	/** Every routine is paused. */
	readonly paused: boolean;
	/** This device notifies when an agent asks: on, off, or blocked by the browser. */
	readonly notify?: "on" | "off" | "blocked" | undefined;
	/**
	 * The band's computer: up, starting, built (the first run), or off and why; whether its commands run in a sandbox;
	 * what it can reach.
	 */
	readonly computer?:
		| {
				readonly state: "up" | "starting" | "building" | "offline";
				readonly why?: string | undefined;
				readonly box: "container" | "host";
				readonly network: "guarded" | "none";
		  }
		| undefined;
	/** Sites an agent's browser is signed in to, as the owner: each its own credential, to sign out. */
	readonly signedIn?:
		| readonly { readonly agent: Who & { readonly id: string }; readonly site: string; readonly when: string }[]
		| undefined;
};

export type SettingsActions = {
	readonly onTheme?: (theme: SettingsData["theme"]) => void;
	readonly onCentred?: (centred: boolean) => void;
	readonly onPause?: (paused: boolean) => void;
	readonly onConnect?: () => void;
	readonly onNotify?: (on: boolean) => void;
	/** Sign an agent's browser out of a site. */
	readonly onSignOut?: (agent: string, site: string) => void;
	/** Open a connection's details. */
	readonly onDetails?: (connection: string) => void;
	/** Restore an archived agent; a refusal rejects with why. */
	readonly onRestore?: (who: Who & { readonly id?: string }) => Promise<unknown> | undefined;
	/** Restore an archived group; a refusal rejects with why. */
	readonly onRestoreGroup?: (room: number) => Promise<unknown> | undefined;
	/** Set one of the limits on every group; a refusal rejects with why. */
	readonly onGroupLimits?: (limits: Partial<GroupLimits>) => Promise<unknown> | undefined;
};

/** The owner's limits on every group: the agents one holds, how deep agents ask each other (1: never), their turns. */
export type GroupLimits = { readonly members: number; readonly depth: number; readonly chain: number };

export type ArchivedGroup = {
	readonly room: number;
	readonly name: string;
	readonly faces: readonly Who[];
	readonly when: string;
};

/** Each limit's choices, its words for each, and what the row says it bounds. */
const LIMIT_CHOICES: readonly {
	readonly limit: keyof GroupLimits;
	readonly title: string;
	readonly note: string;
	readonly values: readonly number[];
	readonly words: (value: number) => string;
}[] = [
	{
		limit: "members",
		title: "Agents in a group",
		note: "Each one asked works, so more agents cost more.",
		values: [2, 3, 4, 6, 8, 12, 16],
		words: (n) => `Up to ${n}`,
	},
	{
		limit: "depth",
		title: "Agents asking each other",
		note: "How many times an answer may ask another agent in turn.",
		values: [1, 2, 3, 4, 6],
		words: (n) => (n <= 1 ? "Never" : n === 2 ? "Once" : `Up to ${n - 1} deep`),
	},
	{
		limit: "chain",
		title: "Their turns from one message",
		note: "Past it, an agent's answer still posts but asks nobody.",
		values: [2, 4, 8, 16, 32],
		words: (n) => `Up to ${n}`,
	},
];

/** Settings' Groups: the limits on every group, a choice each; a refusal shows under it. */
export function GroupLimitsBlock({
	limits,
	onChange,
}: {
	limits: GroupLimits;
	onChange?: SettingsActions["onGroupLimits"];
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	return (
		<Block title="Groups" note="What bounds the work and cost of every group.">
			<Rows>
				{LIMIT_CHOICES.map(({ limit, title, note, values, words }) => {
					// a value set elsewhere, not among the choices, still shows as itself
					const all = values.includes(limits[limit]) ? values : [...values, limits[limit]].sort((a, b) => a - b);
					return (
						<div key={limit} className="flex min-h-14 items-center gap-3 px-3.5 py-2">
							<span className="flex flex-1 flex-col">
								<span className="text-ui text-ink">{title}</span>
								<span className="text-meta text-ink-2">{note}</span>
							</span>
							<Select
								value={String(limits[limit])}
								onValueChange={(value) => {
									setError(undefined);
									void Promise.resolve(onChange?.({ [limit]: Number(value) })).catch((failed: unknown) =>
										setError(failed instanceof Error ? failed.message : String(failed)),
									);
								}}
							>
								<SelectTrigger aria-label={title} className="w-36 shrink-0">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{all.map((value) => (
										<SelectItem key={value} value={String(value)}>
											{words(value)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					);
				})}
			</Rows>
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
		</Block>
	);
}

/** An archived group in Settings: its faces, its name, when it was archived, and Restore. */
function ArchivedGroupRow({
	group,
	onRestore,
}: {
	group: ArchivedGroup;
	onRestore?: SettingsActions["onRestoreGroup"];
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	return (
		<RowOf
			lead={
				<FaceStack faces={group.faces.map((face) => ({ ...face, paused: true }))} name={group.name} size="message" />
			}
			title={group.name}
			detail={error ?? `Archived ${group.when}`}
			end={
				<Button
					variant="outline"
					size="xs"
					disabled={busy}
					onClick={() => {
						setError(undefined);
						setBusy(true);
						void Promise.resolve(onRestore?.(group.room))
							.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
							.finally(() => setBusy(false));
					}}
				>
					<ArchiveRestoreIcon />
					Restore
				</Button>
			}
		/>
	);
}

/** Settings' archived groups, each to restore; shown only once there is one. */
export function ArchivedGroups({
	groups,
	onRestore,
}: {
	groups: readonly ArchivedGroup[];
	onRestore?: SettingsActions["onRestoreGroup"];
}) {
	if (groups.length === 0) return null;
	return (
		<Block title="Archived groups" note="Their messages kept. A restored group goes on where it was.">
			<Rows>
				{groups.map((group) => (
					<ArchivedGroupRow key={group.room} group={group} onRestore={onRestore} />
				))}
			</Rows>
		</Block>
	);
}

/** An archived agent in Settings: its face, paused, when it was archived, and Restore. */
function ArchivedRow({
	who,
	onRestore,
}: {
	who: Who & { readonly id?: string; readonly when: string };
	onRestore?: SettingsActions["onRestore"] | undefined;
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	return (
		<RowOf
			lead={<Face face={who.face} name={who.name} size="message" paused />}
			title={who.name}
			detail={error ?? `Archived ${who.when}`}
			end={
				<Button
					variant="outline"
					size="xs"
					disabled={busy}
					onClick={() => {
						setError(undefined);
						setBusy(true);
						void Promise.resolve(onRestore?.(who))
							.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
							.finally(() => setBusy(false));
					}}
				>
					<ArchiveRestoreIcon />
					Restore
				</Button>
			}
		/>
	);
}

/** Settings' Agents: the archived ones, each to restore; its routines stay paused until the owner resumes them. */
export function ArchivedAgents({
	archived,
	onRestore,
}: {
	archived: SettingsData["archived"];
	onRestore?: SettingsActions["onRestore"] | undefined;
}) {
	return (
		<Block
			title="Archived"
			note="Archived agents, their chats, memory and files kept. A restored agent's routines stay paused until you resume them."
		>
			{archived.length === 0 ? (
				<p className="text-ui text-ink-2">None archived. An agent you archive waits here, its chat kept.</p>
			) : (
				<Rows>
					{archived.map((who) => (
						<ArchivedRow key={who.id ?? who.name} who={who} onRestore={onRestore} />
					))}
				</Rows>
			)}
		</Block>
	);
}

/**
 * Settings, in tabs as the agent's panel has them: General (appearance, notifications, routines, the computer),
 * Memory (the shared facts and each agent's own, one set, never copies), Model (the provider and the models the
 * tiers use), Usage (model spend and caching), Connections (every account), Agents (the limits on groups; the archived agents and groups, to restore),
 * Devices (the phones paired, and pairing one).
 */
export type SettingsTab = "general" | "memory" | "model" | "usage" | "connections" | "agents" | "devices";

export function AppSettings({
	data,
	tab = "general",
	memory,
	providers,
	usage,
	tierModels,
	devices,
	bring,
	...act
}: {
	data: SettingsData;
	tab?: SettingsTab;
	memory?: ReactNode;
	/** Bringing skills and agents from the other harnesses on this computer, on the desktop (`BringSettings`). */
	bring?: ReactNode;
	/** The phones paired, and pairing one (`DevicesSettings`). */
	devices?: ReactNode;
	/** Every provider the band may think with, to connect, use or sign out of (`ModelProviders`). */
	providers?: ReactNode;
	usage?: ReactNode;
	tierModels?: {
		models: TiersView["models"];
		catalog: readonly ModelView[];
		onChange: (tier: Tier, id: string | null) => void;
	};
} & SettingsActions) {
	return (
		<Tabs defaultValue={tab} className="gap-6">
			<TabsList aria-label="Settings" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
				<TabsTrigger value="general">General</TabsTrigger>
				{memory === undefined ? null : <TabsTrigger value="memory">Memory</TabsTrigger>}
				<TabsTrigger value="model">Model</TabsTrigger>
				{usage === undefined ? null : <TabsTrigger value="usage">Usage</TabsTrigger>}
				<TabsTrigger value="connections">Connections</TabsTrigger>
				<TabsTrigger value="agents">Agents</TabsTrigger>
				{devices === undefined ? null : <TabsTrigger value="devices">Devices</TabsTrigger>}
			</TabsList>
			<TabsContent value="general" className="flex flex-col gap-8">
				<Block title="Appearance">
					<div role="radiogroup" aria-label="Appearance" className="flex self-start rounded-field bg-paper-3 p-0.5">
						{(["system", "light", "dark"] as const).map((one) => (
							// biome-ignore lint/a11y/useSemanticElements: a segment of a segmented control
							<button
								key={one}
								type="button"
								role="radio"
								aria-checked={data.theme === one}
								onClick={() => act.onTheme?.(one)}
								className={cn(
									"rounded-[6px] px-3.5 py-1.5 text-ui text-ink-2 capitalize",
									data.theme === one && "bg-paper font-medium text-ink shadow-[0_0_0_1px_var(--line-soft)]",
								)}
							>
								{one}
							</button>
						))}
					</div>
					<Rows>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
						<label className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
							<span className="flex flex-1 flex-col">
								<span className="text-ui text-ink">Centre pinned agents</span>
								<span className="text-meta text-ink-2">While they fit in one row at the top of the band.</span>
							</span>
							<Switch checked={data.centred === true} onCheckedChange={(on) => act.onCentred?.(on)} />
						</label>
					</Rows>
				</Block>
				{data.notify === undefined ? null : (
					<Block title="Notifications" note="On this device, when an agent waits on you and banda is not in front.">
						<Rows>
							{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
							<label className="flex min-h-12 items-center gap-3 px-3.5">
								<span className="flex flex-1 flex-col">
									<span className="text-ui text-ink">Notify me when an agent asks</span>
									{data.notify === "blocked" ? (
										<span className="text-meta text-ink-2">
											Your browser blocks them: allow notifications for banda in its settings.
										</span>
									) : null}
								</span>
								<Switch
									checked={data.notify === "on"}
									disabled={data.notify === "blocked"}
									onCheckedChange={(on) => act.onNotify?.(on)}
								/>
							</label>
						</Rows>
					</Block>
				)}
				<Block title="Routines">
					<Rows>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
						<label className="flex min-h-12 items-center gap-3 px-3.5">
							<span className="flex flex-1 flex-col">
								<span className="text-ui text-ink">Pause all routines</span>
								<span className="text-meta text-ink-2">The band still answers you; nothing wakes on its own.</span>
							</span>
							<Switch checked={data.paused} onCheckedChange={(on) => act.onPause?.(on)} />
						</label>
					</Rows>
				</Block>
				{data.computer === undefined ? null : <Computer computer={data.computer} />}
			</TabsContent>
			{memory === undefined ? null : (
				<TabsContent value="memory" className="flex flex-col gap-8">
					{memory}
				</TabsContent>
			)}
			<TabsContent value="model" className="flex flex-col gap-8">
				<Block title="Model provider" note="Who thinks for the band. Your provider sees what you ask.">
					<Rows>
						<RowOf
							lead={<img src={`/providers/${backendOf(data.provider.id)}.svg`} alt="" className="size-5 dark:invert" />}
							title={data.provider.name}
							detail="Thinks for every agent of the band"
						/>
						{(
							[
								["quick", "Quick", "Answers fast"],
								["balanced", "Balanced", "Most of the time"],
								["deep", "Deep", "Takes its time on hard things"],
							] as const
						).map(([tier, label, when]) => (
							<RowOf
								key={tier}
								className="pl-[2.875rem]"
								title={label}
								detail={when}
								end={
									tierModels === undefined || tierModels.catalog.length === 0 ? (
										<span className="truncate text-meta text-ink-2">{data.models[tier]}</span>
									) : (
										<ModelPicker
											tier={label}
											provider={data.provider.id}
											current={tierModels.models[tier]}
											catalog={tierModels.catalog}
											onChange={(id) => tierModels.onChange(tier, id)}
										/>
									)
								}
							/>
						))}
					</Rows>
				</Block>
				{providers}
			</TabsContent>
			{usage === undefined ? null : (
				<TabsContent value="usage" className="flex flex-col gap-6">
					{usage}
				</TabsContent>
			)}
			<TabsContent value="connections" className="flex flex-col gap-8">
				<ConnectionRows connections={data.connections} act={act} />
				<SignedIn sites={data.signedIn ?? []} onSignOut={act.onSignOut} />
			</TabsContent>
			<TabsContent value="agents" className="flex flex-col gap-8">
				{bring}
				{data.groupLimits === undefined ? null : (
					<GroupLimitsBlock limits={data.groupLimits} onChange={act.onGroupLimits} />
				)}
				<ArchivedAgents archived={data.archived} onRestore={act.onRestore} />
				<ArchivedGroups groups={data.archivedGroups ?? []} onRestore={act.onRestoreGroup} />
			</TabsContent>
			{devices === undefined ? null : (
				<TabsContent value="devices" className="flex flex-col gap-4">
					{devices}
				</TabsContent>
			)}
		</Tabs>
	);
}

/**
 * A provider account in Settings: how it connects, and where it stands. `id` is the account's; `name` its provider's,
 * which `provider` names by id when the account is not the provider's first (`anthropic@work`), with the owner's
 * `label` for it.
 */
export type ProviderRow = {
	readonly id: string;
	readonly name: string;
	readonly provider?: string | undefined;
	readonly label?: string | undefined;
	/** Signs in, or takes a key. */
	readonly by: "sign-in" | "key";
	readonly connected: boolean;
	/**
	 * Connected by a credential from around the daemon (ANTHROPIC_API_KEY and its kind), not one connected here:
	 * the band can think with it, but nothing has tried it and signing out cannot take it away.
	 */
	readonly ambient?: boolean | undefined;
	/** What an ambient credential came from ("ANTHROPIC_API_KEY"), to name it to the owner. */
	readonly source?: string | undefined;
	/** A sign-in under way, in a tab of its own. */
	readonly connecting?: boolean | undefined;
	/** It takes a pasted code now; the provider's ways to sign in, and the one under way. */
	readonly asks?: boolean | undefined;
	readonly ways?: readonly SignInWay[] | undefined;
	readonly way?: string | undefined;
	readonly error?: string | undefined;
};

/**
 * Settings' providers: each the band may think with. The one in use says so; a connected one is Use; one not connected
 * is Connect (a sign-in in its own tab, or a key here); any connected one signs out, asked first. On a device (`here`
 * false) only the connected ones show, to use or sign out of: a sign-in comes back to the computer banda runs on, so
 * providers are connected there.
 */
export function ModelProviders({
	current,
	providers,
	open,
	waiting,
	error,
	onUse,
	onConnect,
	onKey,
	onSignOut,
	onAnswer,
	onWay,
	onCancel,
	onAdd,
	onRename,
	adding: openAdding,
	renaming: openRenaming,
	here = true,
}: {
	/** The provider account the band thinks with. */
	current: string;
	/** On the computer banda runs on, where providers are connected; false on a device. */
	here?: boolean;
	providers: readonly ProviderRow[];
	/** The account whose key form is open. */
	open?: string | undefined;
	/** The account, or the provider adding one, connecting now. */
	waiting?: string | undefined;
	/** What went wrong, who, what and the fix, in words. */
	error?: string | undefined;
	onUse?: ((id: string) => void) | undefined;
	onConnect?: ((id: string) => void) | undefined;
	onKey?: ((id: string, key: string) => void) | undefined;
	onSignOut?: ((id: string) => void) | undefined;
	/** A sign-in's pasted code or address; another way to sign in; ending the sign-in under way. */
	onAnswer?: ((id: string, value: string) => void) | undefined;
	onWay?: ((id: string, way: string) => void) | undefined;
	onCancel?: ((id: string) => void) | undefined;
	/** Another account of a provider: its name, and its key for one that takes a key. */
	onAdd?: ((provider: string, label: string, key?: string) => void) | undefined;
	/** A new name for an account, in the owner's words. */
	onRename?: ((id: string, label: string) => void) | undefined;
	/** The provider whose "Add another account" form shows at first. */
	adding?: string | undefined;
	/** The account whose rename form shows at first. */
	renaming?: string | undefined;
}) {
	const [adding, setAdding] = useState<string | undefined>(openAdding);
	const [renaming, setRenaming] = useState<string | undefined>(openRenaming);
	const [leaving, setLeaving] = useState<string | undefined>(undefined);
	const connected = providers.filter((each) => each.connected);
	const backend = (row: ProviderRow) => row.provider ?? row.id;
	const many = (row: ProviderRow) =>
		(here ? providers : connected).filter((each) => backend(each) === backend(row)).length > 1;
	const title = (row: ProviderRow) => accountTitle(row.name, row.label, many(row));
	const shown = here ? providers : connected;
	return (
		<Block
			title="Providers"
			note={
				here
					? "Connect another to switch between them. Only the one in use sees what you ask."
					: "Connect another on the computer banda runs on. Only the one in use sees what you ask."
			}
		>
			<Rows className="max-h-[min(24rem,50dvh)] overflow-y-auto overscroll-contain">
				{shown.map((provider, n) => {
					const name = title(provider);
					const using = provider.id === current;
					const next = connected.find((each) => each.id !== provider.id);
					// an ambient credential is connected but never ours: connecting over it is still a sign-in
					const ambient = provider.ambient === true;
					// an account beyond the provider's first, not connected: added and failed, or signed out of elsewhere
					const extra = provider.provider !== undefined && provider.provider !== provider.id;
					const signing =
						provider.by === "sign-in" &&
						(!provider.connected || ambient) &&
						(provider.id === waiting || provider.connecting === true);
					const from = ambient ? (provider.source ?? "your environment") : undefined;
					const renamable = provider.connected && !ambient && many(provider) && onRename !== undefined;
					const leave = !using
						? "Its sign-in is forgotten. You can connect it again any time."
						: next === undefined
							? "It is the only provider connected: the band stops thinking until you connect one."
							: `The band thinks with ${title(next)} from its next answer on.`;
					const last = shown[n + 1] === undefined || backend(shown[n + 1] as ProviderRow) !== backend(provider);
					const addable =
						here &&
						last &&
						onAdd !== undefined &&
						shown.some((each) => backend(each) === backend(provider) && each.connected);
					const detail =
						provider.id === waiting || provider.connecting === true
							? provider.by === "sign-in"
								? "Finish signing in in the other tab…"
								: "Connecting…"
							: provider.error !== undefined
								? `Didn't connect: ${provider.error}`
								: from !== undefined
									? using
										? `In use · from ${from}, outside banda`
										: `From ${from}, outside banda`
									: using
										? "In use"
										: provider.connected
											? "Connected"
											: provider.by === "sign-in"
												? "Sign in with your account"
												: "Use a key";
					return (
						<div key={provider.id} className="flex flex-col">
							<RowOf
								lead={<img src={`/providers/${backend(provider)}.svg`} alt="" className="size-5 dark:invert" />}
								title={name}
								detail={detail}
								end={
									<span className="flex shrink-0 gap-1.5">
										{provider.connected && !using ? (
											<Button
												variant="outline"
												size="xs"
												aria-label={`Use ${name}`}
												onClick={() => onUse?.(provider.id)}
											>
												Use
											</Button>
										) : null}
										{provider.connected && !ambient ? (
											<>
												{renamable ? (
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button
																variant="ghost"
																size="icon-xs"
																className="sm:hidden"
																aria-label={`More for ${name}`}
															>
																<EllipsisIcon />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															<DropdownMenuItem onSelect={() => setRenaming(provider.id)}>Rename</DropdownMenuItem>
															<DropdownMenuItem variant="destructive" onSelect={() => setLeaving(provider.id)}>
																Sign out
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												) : null}
												{renamable ? (
													<Button
														variant="ghost"
														size="xs"
														className="hidden sm:inline-flex"
														aria-label={`Rename ${name}`}
														aria-expanded={renaming === provider.id}
														onClick={() => setRenaming((was) => (was === provider.id ? undefined : provider.id))}
													>
														Rename
													</Button>
												) : null}
												<Confirm
													title={`Sign out of ${name}?`}
													body={leave}
													action="Sign out"
													keep="Stay signed in"
													onConfirm={onSignOut === undefined ? undefined : () => onSignOut(provider.id)}
												>
													<Button
														variant="ghost"
														size="xs"
														className={renamable ? "hidden sm:inline-flex" : undefined}
														aria-label={`Sign out of ${name}`}
													>
														Sign out
													</Button>
												</Confirm>
												{renamable ? (
													<Confirm
														title={`Sign out of ${name}?`}
														body={leave}
														action="Sign out"
														keep="Stay signed in"
														onConfirm={onSignOut === undefined ? undefined : () => onSignOut(provider.id)}
														open={leaving === provider.id}
														onOpenChange={(open) => setLeaving(open ? provider.id : undefined)}
													/>
												) : null}
											</>
										) : !here ? null : (
											<>
												<Button
													variant="outline"
													size="xs"
													aria-label={`Connect ${name}`}
													aria-expanded={provider.by === "key" ? provider.id === open : undefined}
													disabled={provider.by === "key" && provider.id === waiting}
													onClick={() => onConnect?.(provider.id)}
												>
													Connect
												</Button>
												{extra && !signing ? (
													<Button
														variant="ghost"
														size="xs"
														aria-label={`Remove ${name}`}
														onClick={() => onSignOut?.(provider.id)}
													>
														Remove
													</Button>
												) : null}
											</>
										)}
									</span>
								}
							/>
							{renaming === provider.id ? (
								<ProviderAccountRename
									account={{ id: provider.id, title: name, label: provider.label ?? provider.name }}
									className="border-t border-line-soft p-3"
									onRename={onRename}
									onClose={() => setRenaming(undefined)}
								/>
							) : null}
							{here && provider.id === open && (!provider.connected || ambient) ? (
								<ProviderKeyForm
									provider={{ ...provider, name }}
									action="Connect"
									busy={provider.id === waiting}
									className="border-t border-line-soft p-3"
									onKey={onKey}
								/>
							) : null}
							{here && signing ? (
								<ProviderSignIn
									provider={{ ...provider, name }}
									asks={provider.asks}
									ways={provider.ways}
									way={provider.way}
									className="border-t border-line-soft p-3"
									onAnswer={onAnswer}
									onWay={onWay}
									onCancel={onCancel}
								/>
							) : null}
							{addable ? (
								adding === backend(provider) ? (
									<ProviderAccountForm
										provider={{ id: backend(provider), name: provider.name }}
										by={provider.by}
										busy={waiting === backend(provider)}
										className="border-t border-line-soft p-3"
										onAdd={(id, label, key) => {
											setAdding(undefined);
											onAdd?.(id, label, key);
										}}
										onClose={() => setAdding(undefined)}
									/>
								) : (
									<RowOf
										className="border-t border-line-soft pl-[2.875rem]"
										title={<span className="text-ink-2">Another {provider.name} account</span>}
										end={
											<Button
												variant="ghost"
												size="xs"
												aria-label={`Add another ${provider.name} account`}
												onClick={() => setAdding(backend(provider))}
											>
												<PlusIcon />
												{provider.by === "sign-in" ? "Sign in another" : "Add another"}
											</Button>
										}
									/>
								)
							) : null}
						</div>
					);
				})}
			</Rows>
			{error === undefined ? null : (
				<p role="alert" className="text-ui text-danger">
					{error}
				</p>
			)}
		</Block>
	);
}

/**
 * Every connection: one row each, the accounts signed in to it (or that it needs none) and which agents use it, with
 * its details, where access and accounts are changed; and Connect a service, the Connections page.
 */
function ConnectionRows({ connections, act }: { connections: readonly ConnectionLine[]; act: SettingsActions }) {
	return (
		<Block title="Connections" note="Each connection, who is signed in and which agents use it.">
			<Rows>
				{connections.map((connection) => (
					<RowOf
						key={connection.id}
						lead={
							<span className="flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3">
								<ConnectionIcon connection={connection.id} />
							</span>
						}
						title={connection.service}
						detail={
							connection.stale
								? "Sign in again to use it"
								: [
										connection.logins.length === 0 ? "No sign-in needed" : connection.logins.join(", "),
										connection.agents.length === 0 ? "No agent uses it" : `Used by ${connection.agents.join(", ")}`,
									].join(" · ")
						}
						end={
							act.onDetails === undefined ? undefined : (
								<Button variant="ghost" size="xs" onClick={() => act.onDetails?.(connection.id)}>
									Details
								</Button>
							)
						}
					/>
				))}
				<RowOf
					title={
						<span className="text-ink-2">{connections.length === 0 ? "No connections yet" : "More services"}</span>
					}
					end={
						<Button variant="outline" size="xs" onClick={act.onConnect}>
							<PlusIcon />
							Connect a service
						</Button>
					}
				/>
			</Rows>
		</Block>
	);
}

/** The band's computer, alive or not, and what keeps it apart: where its commands run and what it can reach. */
function Computer({ computer }: { computer: NonNullable<SettingsData["computer"]> }) {
	const { state, why, box, network } = computer;
	const coming = state === "starting" || state === "building";
	return (
		<Block title="The computer" note="Where the band works: its files, its commands, its browser.">
			<Rows>
				<RowOf
					lead={
						<span className="relative flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3">
							{state === "up" ? (
								<span
									aria-hidden="true"
									className="absolute size-2.5 animate-ping rounded-full bg-alive opacity-40 motion-reduce:hidden"
								/>
							) : null}
							<span
								aria-hidden="true"
								className={cn(
									"relative size-2.5 rounded-full",
									state === "up" ? "bg-alive" : coming ? "animate-pulse bg-alive" : "bg-ink-2/50",
								)}
							/>
						</span>
					}
					title={
						state === "up"
							? "Running"
							: state === "building"
								? "Building the agent's computer…"
								: state === "starting"
									? "Starting…"
									: "Off"
					}
					detail={
						state === "offline" ? (
							<>
								{why === undefined ? null : (
									<span className="block whitespace-pre-line break-words text-ink">{why}</span>
								)}
								<span className="block">
									The band answers, but can't browse, run commands or save files until it starts.
								</span>
							</>
						) : state === "building" ? (
							"The first run takes several minutes; it is ready once this says Running."
						) : state === "starting" ? (
							"A moment: its files and browser are coming up."
						) : (
							"Ready to browse, run commands and keep files."
						)
					}
				/>
				<RowOf
					lead={<span className="w-8 shrink-0" />}
					title={box === "container" ? "In a sandbox of its own" : "On this computer, unguarded"}
					detail={
						box === "container"
							? "Its commands and files stay inside it, away from yours."
							: "Its commands run on this machine itself, as banda was started."
					}
				/>
				<RowOf
					lead={<span className="w-8 shrink-0" />}
					title={network === "guarded" ? "Online, through banda's guard" : "No internet"}
					detail={
						network === "guarded"
							? "Public sites only; anything sent as you asks you first."
							: "It works with what it has, and reaches nothing outside."
					}
				/>
			</Rows>
		</Block>
	);
}

/** Sites an agent's browser is signed in to as the owner: each its own credential, each to sign out. */
function SignedIn({
	sites,
	onSignOut,
}: {
	sites: NonNullable<SettingsData["signedIn"]>;
	onSignOut?: SettingsActions["onSignOut"] | undefined;
}) {
	return (
		<Block
			title="Signed in, in the browser"
			note="Where you signed in for an agent. It opens these as you only once you allow it, and asks before sending anything."
		>
			{sites.length === 0 ? (
				<p className="text-ui text-ink-2">
					Nowhere yet. When an agent hands you a page to sign in, the site shows here.
				</p>
			) : (
				<Rows>
					{sites.map(({ agent, site, when }) => (
						<RowOf
							key={`${agent.id}/${site}`}
							lead={<Face face={agent.face} name={agent.name} size="message" />}
							title={site}
							detail={`${agent.name}'s browser · since ${when}`}
							end={
								<Confirm
									title={`Sign out of ${site}?`}
									body={`${agent.name}'s browser forgets your session there; you would sign in again for it.`}
									action="Sign out"
									keep="Stay signed in"
									onConfirm={() => onSignOut?.(agent.id, site)}
								>
									<Button variant="outline" size="xs">
										Sign out
									</Button>
								</Confirm>
							}
						/>
					))}
				</Rows>
			)}
		</Block>
	);
}
