/**
 * The band: the sidebar, and the whole of the app's navigation. Its name, search and "+" at the top; one row per agent
 * and group, by their latest message; Connections, Settings and the daemon's notices at the foot. Collapsed, the rail of faces.
 */
import { PanelLeftIcon, PlugIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
			<div className={cn("flex shrink-0 items-center py-2", collapsed ? "justify-center" : "px-2")}>
				{collapsed ? (
					<Button variant="ghost" size="icon-sm" className="text-ink-2" aria-label="Settings">
						<SettingsIcon />
					</Button>
				) : (
					<div className="flex w-full flex-col">
						<Button
							variant="ghost"
							className="w-full justify-start gap-2.5 px-2.5 font-normal text-ink-2"
							onClick={onConnections}
						>
							<PlugIcon />
							Connections
						</Button>
						<Button
							variant="ghost"
							className="w-full justify-start gap-2.5 px-2.5 font-normal text-ink-2"
							onClick={onSettings}
						>
							<SettingsIcon />
							Settings
						</Button>
					</div>
				)}
			</div>
		</nav>
	);
}

/** A notice at the band's foot: the daemon's own state, plain, with what the owner can do. */
export function BandNotice({ children }: { children: ReactNode }) {
	return <p className="rounded-field bg-paper-3 px-3 py-2 text-meta text-ink-2">{children}</p>;
}
