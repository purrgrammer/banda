/**
 * The band: the sidebar, and the whole of the app's navigation. Its name, search, "+" and the menu (Skills, Connections,
 * Settings; a dot on it, and on each, while something there waits on the owner) at the top; one row per agent and
 * group, by their latest message, under the pinned ones: tiles of the same size, three to a row, the rest a scroll
 * away; the daemon's notices at the foot. Collapsed, the rail of faces, pinned first, the menu below.
 */
import { BookOpenIcon, EllipsisIcon, PanelLeftIcon, PlugIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { withMod } from "@/lib/keys";
import { RowsLoading } from "./Loading.tsx";
import { PinnedTile, Row, RowActions, type RowView } from "./Row.tsx";

export function Band({
	rows,
	pinned = [],
	onPin,
	phone = false,
	revealed,
	centred = false,
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
	/** Centre the pinned tiles while they fit in one row (the specimen compares it with the default, left-aligned). */
	centred?: boolean;
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
	const band = useId();
	// a tile just pinned past the strip's edge: the strip scrolls to it before it paints, so its face flies to where
	// it shows
	const strip = useRef<HTMLUListElement>(null);
	const before = useRef(pinned);
	useLayoutEffect(() => {
		const added = pinned.find((id) => !before.current.includes(id));
		before.current = pinned;
		const list = strip.current;
		if (added === undefined || list === null) return;
		const tile = list.querySelector<HTMLElement>(`[data-pin="${CSS.escape(added)}"]`);
		if (tile !== null) list.scrollLeft = tile.offsetLeft + tile.offsetWidth - list.clientWidth;
	}, [pinned]);
	const [heldId, setHeld] = useState<string>();
	const held = rows.find((row) => row.id === heldId);
	const hold = (id: string) => (phone && onPin !== undefined ? () => setHeld(id) : undefined);
	// the row or tile that just moved: its words arrive after its face, which flies there
	const [moved, setMoved] = useState<string>();
	const move = (id: string, on: boolean) => {
		setMoved(id);
		onPin?.(id, on);
	};
	const pin = (id: string, on: boolean) => (phone || onPin === undefined ? undefined : () => move(id, on));
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
							aria-label={`Search, ${withMod("K")}`}
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
			{/* a face flies between its row and its tile, and what moves for it slides; reduced motion keeps it still.
			    One group per band, so two bands on a page never trade faces. */}
			<MotionConfig reducedMotion="user" transition={{ type: "spring", duration: 0.45, bounce: 0.1 }}>
				<LayoutGroup id={band}>
					<motion.div
						layoutScroll
						className={cn(
							"flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto",
							collapsed ? "items-center px-2" : "px-2",
						)}
					>
						{loading ? <RowsLoading /> : null}
						{rows.length === 0 && !collapsed && !loading ? (
							<p className="px-3 py-6 text-ui text-ink-2">Your band is empty. Make an agent with +.</p>
						) : null}
						{tiles.length === 0 || collapsed ? null : (
							<motion.ul
								ref={strip}
								layoutScroll
								aria-label="Pinned"
								className={cn(
									"grid shrink-0 snap-x snap-mandatory grid-flow-col gap-1 overflow-x-auto pb-2 [scrollbar-width:none]",
									// three to a row; past three, the next one peeks in so the row reads as one that scrolls
									tiles.length > 3 ? "auto-cols-[calc((100%-0.5rem)/3.4)]" : "auto-cols-[calc((100%-0.5rem)/3)]",
									centred && tiles.length < 3 && "justify-center",
								)}
							>
								{tiles.map((row) => (
									<motion.li key={row.id} layout="position" data-pin={row.id} className="flex">
										<PinnedTile
											row={row}
											selected={row.id === selected}
											revealed={row.id === revealed}
											arriving={row.id === moved}
											onUnpin={pin(row.id, false)}
											onHold={hold(row.id)}
											{...(onSelect === undefined ? {} : { onSelect: () => onSelect(row.id) })}
										/>
									</motion.li>
								))}
							</motion.ul>
						)}
						{(collapsed ? [...tiles, ...rest] : rest).map((row) => (
							<motion.div key={row.id} layout="position" className={cn(collapsed && "flex justify-center")}>
								<Row
									row={row}
									selected={row.id === selected}
									collapsed={collapsed}
									revealed={row.id === revealed}
									arriving={row.id === moved}
									onPin={collapsed ? undefined : pin(row.id, true)}
									onHold={hold(row.id)}
									{...(onSelect === undefined ? {} : { onSelect: () => onSelect(row.id) })}
								/>
							</motion.div>
						))}
					</motion.div>
				</LayoutGroup>
			</MotionConfig>
			<Sheet open={held !== undefined} onOpenChange={(open) => (open ? undefined : setHeld(undefined))}>
				<SheetContent side="bottom" showCloseButton={false} className="gap-0 rounded-t-tile bg-paper p-0">
					<SheetTitle className="sr-only">{held?.name ?? ""}</SheetTitle>
					<SheetDescription className="sr-only">Pin it to the top, or unpin it</SheetDescription>
					{held === undefined ? null : (
						<RowActions
							row={held}
							pinned={pinned.includes(held.id)}
							onPin={(on) => {
								move(held.id, on);
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
					<EllipsisIcon />
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
