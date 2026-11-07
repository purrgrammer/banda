/**
 * The band: the sidebar, and the whole of the app's navigation. Its name, search, "+" and the menu (Skills, Connections,
 * Settings; a dot on it, and on each, while something there waits on the owner) at the top; one row per agent and
 * group, by their latest message; the daemon's notices at the foot. Collapsed, the rail of faces, the menu below.
 */
import { BlocksIcon, BookOpenIcon, PanelLeftIcon, PlugIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { RowsLoading } from "./Loading.tsx";
import { Row, type RowView } from "./Row.tsx";

export function Band({
	rows,
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
				{/* a row that moves up slides to its place rather than jumping; reduced motion keeps it still */}
				<MotionConfig reducedMotion="user" transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.8 }}>
					{rows.map((row) => (
						<motion.div key={row.id} layout="position" className={cn(collapsed && "flex justify-center")}>
							<Row
								row={row}
								selected={row.id === selected}
								collapsed={collapsed}
								{...(onSelect === undefined ? {} : { onSelect: () => onSelect(row.id) })}
							/>
						</motion.div>
					))}
				</MotionConfig>
			</div>
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
