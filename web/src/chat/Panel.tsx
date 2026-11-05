/**
 * The panel: the chat's right-hand column on the desktop, a sheet from the header on the phone. An agent's is the
 * agent's whole home: who it is over four tabs (routines, access, memory, about); a file or artifact the owner
 * opens replaces it until Back. The browser is not here: the chat already shows it. A group's panel lists its members.
 */
import { ChevronLeftIcon, MoreHorizontalIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { AvatarChoices } from "../avatar/Choices.tsx";
import { Confirm } from "./Confirm.tsx";
import { Face, FaceStack, type FaceState } from "./Face.tsx";
import type { Who } from "./Row.tsx";

/** The column itself: on the desktop beside the chat; on the phone, full width under a bar that closes it. */
export function Panel({
	name,
	phone = false,
	onClose,
	children,
	className,
}: {
	name: string;
	phone?: boolean;
	onClose?: () => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<aside
			aria-label={`${name}'s panel`}
			className={cn(
				"flex h-full min-h-0 shrink-0 flex-col bg-paper",
				phone ? "w-full" : "w-[var(--panel-width)] border-l border-line-soft",
				className,
			)}
		>
			{phone ? (
				<div className="relative flex h-12 shrink-0 items-center justify-between border-b border-line-soft px-2.5">
					<span aria-hidden="true" className="mx-auto h-1 w-9 rounded-full bg-line" />
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Close the panel"
						className="absolute right-2.5"
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col divide-y divide-line-soft overflow-y-auto">{children}</div>
		</aside>
	);
}

/** A section's title, with at most one quiet action beside it. */
export function PanelSection({
	title,
	action,
	children,
	className,
}: {
	title?: string | undefined;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-2 px-4 py-4", className)}>
			{title === undefined ? null : (
				<header className="flex h-6 items-center justify-between">
					<h3 className="text-meta font-semibold text-ink-2">{title}</h3>
					{action}
				</header>
			)}
			{children}
		</section>
	);
}

export type PanelTab = "routines" | "access" | "memory" | "about";

/**
 * The tab a panel opens on: Routines when there are some; else Access when it can reach nothing yet; else About,
 * where the agent becomes the owner's own.
 */
export function firstTab({ routines, connected }: { routines: number; connected: boolean }): PanelTab {
	if (routines > 0) return "routines";
	return connected ? "about" : "access";
}

/**
 * An agent's panel: its face and its name over four tabs, opening on the one `firstTab` picks. Everything about the
 * agent lives here, so it has no settings page of its own.
 */
export function AgentPanel({
	who,
	state = "idle",
	paused = false,
	tab,
	routines,
	access,
	memory,
	about,
	onIdentity,
}: {
	who: Who;
	/** The owner changed its face or its name, in place at the top: both, as they stand. */
	onIdentity?: ((who: Who) => void) | undefined;
	state?: FaceState;
	paused?: boolean;
	/** The tab open; `firstTab` picks it. */
	tab: PanelTab;
	routines: ReactNode;
	access: ReactNode;
	memory: ReactNode;
	about: ReactNode;
}) {
	// the suggested tab until the owner picks one: it changes as what the agent has loads or arrives (a routine waiting);
	// another agent's panel is another panel (keyed by the agent), so a rename keeps the tab
	const [picked, setPicked] = useState<string>();
	const open = picked ?? tab;
	return (
		<Tabs value={open} onValueChange={setPicked} className="min-h-0 flex-1">
			<div className="flex flex-col items-center gap-1.5 px-4 pt-6 pb-4 text-center">
				<Identity who={who} state={state} paused={paused} onChange={onIdentity} />
			</div>
			<TabsList aria-label={`About ${who.name}`}>
				<TabsTrigger value="routines">Routines</TabsTrigger>
				<TabsTrigger value="access">Access</TabsTrigger>
				<TabsTrigger value="memory">Memory</TabsTrigger>
				<TabsTrigger value="about">About</TabsTrigger>
			</TabsList>
			<TabsContent value="routines">{routines}</TabsContent>
			<TabsContent value="access" className="flex flex-col gap-8 px-4 py-5">
				{access}
			</TabsContent>
			<TabsContent value="memory" className="flex flex-col gap-8 px-4 py-5">
				{memory}
			</TabsContent>
			<TabsContent value="about" className="flex flex-col gap-8 px-4 py-5">
				{about}
			</TabsContent>
		</Tabs>
	);
}

/**
 * The agent's face and name at the top of its panel, edited where they show: a tap on the face picks another, a tap
 * on the name edits it in place (Enter or leaving keeps it, Escape puts it back; an empty name is not kept).
 */
function Identity({
	who,
	state,
	paused,
	onChange,
}: {
	who: Who;
	state: FaceState;
	paused: boolean;
	onChange?: ((who: Who) => void) | undefined;
}) {
	const [naming, setNaming] = useState<string | undefined>(undefined);
	const [picking, setPicking] = useState(false);
	const face = <Face face={who.face} name={who.name} size="panel" state={state} paused={paused} />;
	const keep = () => {
		const name = naming?.trim();
		setNaming(undefined);
		if (name !== undefined && name !== "" && name !== who.name) onChange?.({ face: who.face, name });
	};
	return (
		<>
			{onChange === undefined ? (
				face
			) : (
				<Popover open={picking} onOpenChange={setPicking}>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={`${who.name}'s face. Change it`}
							className="group/face relative rounded-full"
						>
							{face}
							<span className="absolute -right-0.5 -bottom-0.5 flex size-6 items-center justify-center rounded-full bg-paper text-ink-2 opacity-0 shadow-[0_0_0_1px_var(--line)] transition-opacity group-hover/face:opacity-100 group-focus-visible/face:opacity-100">
								<PencilIcon className="size-3" />
							</span>
						</button>
					</PopoverTrigger>
					<PopoverContent
						className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
						align="center"
						aria-label="Choose a face"
					>
						<AvatarChoices initial={who.face} name={who.name} onPick={(face) => onChange({ face, name: who.name })} />
					</PopoverContent>
				</Popover>
			)}
			{onChange !== undefined && naming !== undefined ? (
				<Input
					value={naming}
					aria-label="Its name"
					autoFocus
					onFocus={(event) => event.currentTarget.select()}
					onChange={(event) => setNaming(event.target.value)}
					onBlur={keep}
					onKeyDown={(event) => {
						if (event.key === "Enter") keep();
						if (event.key === "Escape") {
							event.preventDefault();
							setNaming(undefined);
						}
					}}
					className="mt-1 h-8 max-w-56 text-center text-heading font-semibold"
				/>
			) : onChange === undefined ? (
				<h2 className="mt-1.5 text-heading font-semibold text-ink">{who.name}</h2>
			) : (
				<h2 className="mt-1.5">
					<button
						type="button"
						aria-label={`${who.name}: rename`}
						className="rounded-field px-1.5 text-heading font-semibold text-ink hover:bg-paper-3"
						onClick={() => setNaming(who.name)}
					>
						{who.name}
					</button>
				</h2>
			)}
		</>
	);
}

export type RoutineRowView = {
	readonly id: string;
	readonly name: string;
	/** When, in words: "Every weekday at 8:00". */
	readonly when: string;
	readonly next?: string | undefined;
	/** The last run and what came of it, in words: "Last ran today 08:00", "Last run failed today 08:00". */
	readonly last?: string | undefined;
	readonly paused?: boolean | undefined;
	/** A change the agent asked for, waiting for the owner: what allowing it does. */
	readonly waiting?: "set up" | "change" | "stop" | undefined;
	readonly onAllow?: (() => void) | undefined;
	readonly onDecline?: (() => void) | undefined;
};

const WAITING_ALLOW = { "set up": "Set it up", change: "Change it", stop: "Stop it" } as const;

/** The agent's routines, the one section always present: rows, or one example of what a routine can be. */
export function Routines({
	routines,
	agent,
	allPaused = false,
	onRunNow,
	onPause,
	onAllPaused,
	onAdd,
	onOpen,
}: {
	routines: readonly RoutineRowView[];
	agent: string;
	/** All of the agent's routines are paused: each row says so, and the face dims. */
	allPaused?: boolean;
	onRunNow?: (id: string) => void;
	/** Pause one routine, or resume it. */
	onPause?: (id: string, paused: boolean) => void;
	/** Routines on (false) or all paused (true). */
	onAllPaused?: (paused: boolean) => void;
	/** Make one: the editor, empty. */
	onAdd?: () => void;
	/** Open a routine's editor. */
	onOpen?: (id: string) => void;
}) {
	return (
		<PanelSection>
			<div className="flex items-center gap-2">
				{routines.length === 0 ? null : (
					// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
					<label className="flex flex-1 items-center gap-2.5 text-ui text-ink">
						<Switch checked={!allPaused} onCheckedChange={(on) => onAllPaused?.(!on)} />
						Routines on
					</label>
				)}
				{routines.length === 0 || onAdd === undefined ? null : (
					<Button variant="outline" size="xs" className="ml-auto" onClick={onAdd}>
						<PlusIcon />
						Add
					</Button>
				)}
			</div>
			{routines.length === 0 ? (
				<div className="flex flex-col items-start gap-2 rounded-field bg-paper-2 p-3">
					<p className="text-ui text-ink">
						{agent} has no routines. A routine wakes {agent} on a timer, and what it finds lands in this chat.
					</p>
					<p className="text-meta text-ink-2">"Every weekday at 8:00, tell me what is on my plate today."</p>
					<Button variant="outline" size="sm" className="mt-1" disabled={onAdd === undefined} onClick={onAdd}>
						<PlusIcon />
						Add a routine
					</Button>
				</div>
			) : (
				<ul className="-mx-2 flex flex-col">
					{routines.map((routine) => (
						<RoutineRow
							key={routine.id}
							routine={routine}
							paused={allPaused || routine.paused === true}
							{...(onRunNow === undefined ? {} : { onRunNow: () => onRunNow(routine.id) })}
							{...(onOpen === undefined ? {} : { onOpen: () => onOpen(routine.id) })}
							{...(onPause === undefined || allPaused
								? {}
								: { onPause: () => onPause(routine.id, routine.paused !== true) })}
						/>
					))}
				</ul>
			)}
		</PanelSection>
	);
}

function RoutineRow({
	routine,
	paused,
	onRunNow,
	onPause,
	onOpen,
}: {
	routine: RoutineRowView;
	paused: boolean;
	onRunNow?: () => void;
	onPause?: () => void;
	onOpen?: () => void;
}) {
	if (routine.waiting !== undefined)
		return (
			<li className="flex flex-col gap-2 rounded-field px-2 py-2">
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-ui font-medium text-ink">{routine.name}</span>
					<span className="truncate text-meta text-ink-2">
						{routine.when} · Waiting for you to {routine.waiting === "set up" ? "set it up" : `${routine.waiting} it`}
					</span>
				</span>
				<span className="flex gap-1.5">
					<Button size="xs" onClick={routine.onAllow}>
						{WAITING_ALLOW[routine.waiting]}
					</Button>
					<Button variant="ghost" size="xs" onClick={routine.onDecline}>
						Don't
					</Button>
				</span>
			</li>
		);
	return (
		<li className="group/routine relative flex items-start gap-2 rounded-field px-2 py-2 hover:bg-paper-3">
			<button
				type="button"
				onClick={onOpen}
				disabled={onOpen === undefined}
				aria-label={`${routine.name}: edit`}
				className="flex min-w-0 flex-1 flex-col text-left"
			>
				<span className={cn("truncate text-ui font-medium", paused ? "text-ink-2" : "text-ink")}>{routine.name}</span>
				<span className="truncate text-meta text-ink-2">
					{routine.when}
					{paused ? " · Paused" : routine.next === undefined ? null : ` · Next ${routine.next}`}
				</span>
				{routine.last === undefined ? null : <span className="truncate text-meta text-ink-2">{routine.last}</span>}
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-xs" className="text-ink-2" aria-label={`${routine.name}: more`}>
						<MoreHorizontalIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={onOpen} disabled={onOpen === undefined}>
						<PencilIcon />
						Edit
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onRunNow}>
						<PlayIcon />
						Run now
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onPause} disabled={onPause === undefined}>
						{paused ? <PlayIcon /> : <PauseIcon />}
						{paused ? "Resume" : "Pause"}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/** The top of a section that replaced the panel's content: back, a title, and its own actions. */
export function PanelBar({
	title,
	detail,
	actions,
	onBack,
}: {
	title: string;
	detail?: string | undefined;
	actions?: ReactNode;
	onBack?: (() => void) | undefined;
}) {
	return (
		<div className="flex h-12 shrink-0 items-center gap-1 border-b border-line-soft px-2">
			<Button variant="ghost" size="icon-sm" aria-label="Back" className="text-ink-2" onClick={onBack}>
				<ChevronLeftIcon className="size-5" />
			</Button>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-ui font-semibold text-ink">{title}</span>
				{detail === undefined ? null : <span className="truncate text-meta text-ink-2">{detail}</span>}
			</span>
			{actions}
		</div>
	);
}

/** A group's panel: its faces and name, its members, and who may join. No tabs: a group keeps nothing else. */
export function GroupPanel({
	name,
	members,
	others,
	onRename,
	onAdd,
	onRemove,
}: {
	name: string;
	members: readonly (Who & { readonly state?: FaceState | undefined; readonly paused?: boolean })[];
	/** Agents of the band not in it, who may be added. */
	others: readonly (Who & { readonly id?: string })[];
	onRename?: (name: string) => void;
	onAdd?: (who: Who & { readonly id?: string }) => void;
	onRemove?: (who: Who & { readonly id?: string }) => void;
}) {
	const [editing, setEditing] = useState(false);
	return (
		<>
			<PanelSection className="relative">
				<div className="flex flex-col items-center gap-2 pt-2 pb-1 text-center">
					<FaceStack faces={members} name={name} size="panel" />
					{editing ? (
						<form
							className="mt-1 flex w-full gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								const next = new FormData(event.currentTarget).get("name");
								if (typeof next === "string" && next.trim() !== "" && next.trim() !== name) onRename?.(next.trim());
								setEditing(false);
							}}
						>
							<Input name="name" defaultValue={name} aria-label="The group's name" className="h-8 flex-1" autoFocus />
							<Button type="submit" size="sm">
								Save
							</Button>
						</form>
					) : (
						<button
							type="button"
							onClick={() => setEditing(onRename !== undefined)}
							className="group/name mt-1 flex items-center gap-1.5 rounded-field px-1.5 text-heading font-semibold text-ink hover:bg-paper-3"
							aria-label={`${name}: rename`}
						>
							{name}
							{onRename === undefined ? null : (
								<PencilIcon aria-hidden="true" className="size-3.5 text-ink-3 group-hover/name:text-ink-2" />
							)}
						</button>
					)}
					<p className="text-meta text-ink-2">
						{members.length} agents · a message asks everyone unless it mentions one
					</p>
				</div>
			</PanelSection>
			<PanelSection title="Members">
				<ul className="-mx-2 flex flex-col">
					{members.map((member) => (
						<li
							key={member.name}
							className="group/member flex h-10 items-center gap-2.5 rounded-field px-2 hover:bg-paper-3"
						>
							<Face
								face={member.face}
								name={member.name}
								size="message"
								state={member.state ?? "idle"}
								paused={member.paused ?? false}
							/>
							<span className="flex-1 text-ui text-ink">{member.name}</span>
							{members.length <= 1 || onRemove === undefined ? null : (
								<Confirm
									title={`Remove ${member.name}?`}
									body={`${member.name} leaves this group: it no longer sees what is said here. Its own chat is kept.`}
									action="Remove"
									keep={`Keep ${member.name}`}
									onConfirm={() => onRemove(member)}
								>
									<Button
										variant="ghost"
										size="xs"
										className="text-ink-2 opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
									>
										Remove
									</Button>
								</Confirm>
							)}
						</li>
					))}
				</ul>
			</PanelSection>
			{others.length === 0 ? null : (
				<PanelSection title="Add to the group">
					<ul className="-mx-2 flex flex-col">
						{others.map((other) => (
							<li key={other.name}>
								<button
									type="button"
									onClick={() => onAdd?.(other)}
									className="flex h-10 w-full items-center gap-2.5 rounded-field px-2 text-left hover:bg-paper-3"
								>
									<Face face={other.face} name={other.name} size="message" />
									<span className="flex-1 text-ui text-ink-2">{other.name}</span>
									<PlusIcon aria-hidden="true" className="size-4 text-ink-3" />
								</button>
							</li>
						))}
					</ul>
				</PanelSection>
			)}
		</>
	);
}
