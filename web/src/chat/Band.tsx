/**
 * The band: the sidebar, and the whole of the app's navigation. Its name, search, "+" and the menu (Skills, Connections,
 * Settings; a dot on it, and on each, while something there waits on the owner) at the top; one row per agent and
 * group, by their latest message, under the pinned ones: tiles of the same size, three to a row, the rest a scroll
 * away; the daemon's notices at the foot. Collapsed, the rail of faces, pinned first, the menu below.
 */
import { BlocksIcon, BookOpenIcon, PanelLeftIcon, PlugIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { RowsLoading } from "./Loading.tsx";
import { PinnedTile, Row, RowActions, type RowView } from "./Row.tsx";

export function Band({
	rows,
	pinned = [],
	onPin,
	phone = false,
	revealed,
	selected,
	collapsed = false,
	notice,
	loading = false,
	onSelect,
	onSearch,
	onNew,
	onSkills,
	waiting = {},
	onConnections,
	onSettings,
	className,
	brand,
}: {
	brand?: ReactNode;
	rows: readonly RowView[];
	/** The rows pinned to the top, by id, in the owner's order. */
	pinned?: readonly string[];
	/** Pin a row to the top, or let it go back among the rows. */
	onPin?: ((id: string, pinned: boolean) => void) | undefined;
	/** On the phone a long press offers the pin; elsewhere it sits on the row on hover. */
	phone?: boolean;
	/** Show the pin of this row or tile as on hover (the specimen). */
	revealed?: string | undefined;
	selected?: string | undefined;
	collapsed?: boolean;
	/** A daemon's notice at the foot: offline, the computer off. */
	notice?: ReactNode;
	/** Before the rows arrive: their shapes. */
	loading?: boolean;
	onSelect?: (id: string) => void;
	onSearch?: () => void;
	onNew?: () => void;
	onSkills?: () => void;
	/** What waits on the owner: a dot on the menu and on that item. */
	waiting?: { readonly skills?: boolean; readonly connections?: boolean };
	onConnections?: () => void;
	onSettings?: () => void;
	className?: string;
}) {
	const tiles = pinned.flatMap((id) => rows.filter((row) => row.id === id));
	const rest = rows.filter((row) => !pinned.includes(row.id));
	const [heldId, setHeld] = useState<string>();
	const held = rows.find((row) => row.id === heldId);
	const hold = (id: string) => (phone && onPin !== undefined ? () => setHeld(id) : undefined);
	const pin = (id: string, on: boolean) => (phone || onPin === undefined ? undefined : () => onPin(id, on));
	return (
		<nav
			aria-label="Your band"
			className={cn(
				"flex h-full shrink-0 flex-col bg-paper-2",
				collapsed ? "w-[4.5rem] items-center" : "w-[var(--sidebar-width)]",
				className,
			)}
		>
			<div className={cn("flex h-12 shrink-0 items-center gap-1", collapsed ? "justify-center" : "px-3")}>
				{collapsed ? (
					(brand ?? (
						<Button variant="ghost" size="icon-sm" aria-label="Open the sidebar">
							<PanelLeftIcon />
						</Button>
					))
				) : (
					<>
						{brand}
						<Button
							variant="ghost"
							size="icon-sm"
							className="ml-auto text-ink-2"
							aria-label="Search, ⌘K"
							onClick={onSearch}
						>
							<SearchIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							className="text-ink-2"
							aria-label="New agent or group"
							onClick={onNew}
						>
							<PlusIcon />
						</Button>
						<Menu waiting={waiting} onSkills={onSkills} onConnections={onConnections} onSettings={onSettings} />
					</>
				)}
			</div>
			<div
				className={cn("flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto", collapsed ? "items-center px-2" : "px-2")}
			>
				{loading ? <RowsLoading /> : null}
				{rows.length === 0 && !collapsed && !loading ? (
					<p className="px-3 py-6 text-ui text-ink-2">Your band is empty. Make an agent with +.</p>
				) : null}
				{tiles.length === 0 || collapsed ? null : (
					<ul
						aria-label="Pinned"
						className={cn(
							"grid shrink-0 snap-x snap-mandatory grid-flow-col gap-1 overflow-x-auto pb-2 [scrollbar-width:none]",
							// three to a row; past three, the next one peeks in so the row reads as one that scrolls
							tiles.length > 3 ? "auto-cols-[calc((100%-0.5rem)/3.4)]" : "auto-cols-[calc((100%-0.5rem)/3)]",
						)}
					>
						{tiles.map((row) => (
							<li key={row.id} className="flex">
								<PinnedTile
									row={row}
									selected={row.id === selected}
									revealed={row.id === revealed}
									onUnpin={pin(row.id, false)}
									onHold={hold(row.id)}
									{...(onSelect === undefined ? {} : { onSelect: () => onSelect(row.id) })}
								/>
							</li>
						))}
					</ul>
				)}
				{/* a row that moves up slides to its place rather than jumping; reduced motion keeps it still */}
				<MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.8 }}>
					{(collapsed ? [...tiles, ...rest] : rest).map((row) => (
						<motion.div key={row.id} layout="position" className={cn(collapsed && "flex justify-center")}>
							<Row
								row={row}
								selected={row.id === selected}
								collapsed={collapsed}
								revealed={row.id === revealed}
								onPin={collapsed ? undefined : pin(row.id, true)}
								onHold={hold(row.id)}
								{...(onSelect === undefined ? {} : { onSelect: () => onSelect(row.id) })}
							/>
						</motion.div>
					))}
				</MotionConfig>
			</div>
			<Sheet open={held !== undefined} onOpenChange={(open) => (open ? undefined : setHeld(undefined))}>
				<SheetContent side="bottom" showCloseButton={false} className="gap-0 rounded-t-tile bg-paper p-0">
					<SheetTitle className="sr-only">{held?.name ?? ""}</SheetTitle>
					<SheetDescription className="sr-only">Pin it to the top, or unpin it</SheetDescription>
					{held === undefined ? null : (
						<RowActions
							row={held}
							pinned={pinned.includes(held.id)}
							onPin={(on) => {
								onPin?.(held.id, on);
								setHeld(undefined);
							}}
						/>
					)}
				</SheetContent>
			</Sheet>
			{notice === undefined || collapsed ? null : <div className="px-3 pb-2">{notice}</div>}
			{collapsed ? (
				<div className="flex shrink-0 justify-center py-2">
					<Menu waiting={waiting} onSkills={onSkills} onConnections={onConnections} onSettings={onSettings} />
				</div>
			) : null}
		</nav>
	);
}

/** The menu: Skills, Connections, Settings; a dot on it, and on an item, while something there waits on the owner. */
function Menu({
	waiting,
	onSkills,
	onConnections,
	onSettings,
}: {
	waiting: { readonly skills?: boolean; readonly connections?: boolean };
	onSkills?: (() => void) | undefined;
	onConnections?: (() => void) | undefined;
	onSettings?: (() => void) | undefined;
}) {
	const any = waiting.skills === true || waiting.connections === true;
	const items = [
		{ label: "Skills", icon: BookOpenIcon, on: onSkills, dot: waiting.skills === true },
		{ label: "Connections", icon: PlugIcon, on: onConnections, dot: waiting.connections === true },
		{ label: "Settings", icon: SettingsIcon, on: onSettings, dot: false },
	];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className="relative text-ink-2"
					aria-label={any ? "Menu, something waits on you" : "Menu"}
				>
					<BlocksIcon />
					{any ? <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-ink" /> : null}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-40">
				{items.map(({ label, icon: Icon, on, dot }) => (
					<DropdownMenuItem key={label} onSelect={() => on?.()}>
						<Icon />
						{label}
						{dot ? (
							<span role="img" aria-label="waits on you" className="ml-auto size-1.5 rounded-full bg-ink" />
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A notice at the band's foot: the daemon's own state, plain, with what the owner can do. */
export function BandNotice({ children }: { children: ReactNode }) {
	return <p className="rounded-field bg-paper-3 px-3 py-2 text-meta text-ink-2">{children}</p>;
}
