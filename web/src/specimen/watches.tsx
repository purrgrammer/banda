/**
 * Watches, as docs/watches-ui-specimen.md draws them: the agent's row while a change waits on the owner, the wake and
 * lifecycle lines in the chat with the object's card beneath, and the panel's Watching section below the routines.
 * Fixture data only; nothing here reads a service or runs an agent.
 */
import {
	CircleAlertIcon,
	EllipsisIcon,
	EyeIcon,
	EyeOffIcon,
	PauseIcon,
	PlayIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { Bubble, Run } from "../chat/Feed.tsx";
import { Line } from "../chat/Line.tsx";
import { CheckRunCard, GitHubMark, PullRequestCard } from "../chat/Object.tsx";
import { AgentPanel, Panel, PanelSection, Routines } from "../chat/Panel.tsx";
import { Row, type RowView } from "../chat/Row.tsx";
import { Connections, Memory, Permissions, Personality } from "../chat/Settings.tsx";
import { ATLAS, CHECK_RUN, OCTO, OTTO, PERMISSIONS, PR, ROUTINES } from "./fixtures.ts";
import { Group, Section, StageContext } from "./stage.tsx";

/** The band while watches live in it: an ask, unread only, and a paused watch dimming the face. */
const WATCH_ROWS: readonly RowView[] = [
	{
		id: "octo",
		name: "Octo",
		faces: [OCTO],
		excerpt: "",
		time: "10:12",
		ask: "Review requested by @ana",
	},
	{
		id: "atlas",
		name: "Atlas",
		faces: [ATLAS],
		excerpt: "Checks failed on banda#34",
		time: "10:31",
		unread: 1,
	},
	{
		id: "otto",
		name: "Otto",
		faces: [OTTO],
		excerpt: "Done · merged",
		time: "Mon",
		paused: true,
	},
];

/** One row per watch: the object's title, what ends it, the last look and what it saw, paused or done. */
type WatchRowView = {
	readonly id: string;
	/** The object's title, never an id or an internal key. */
	readonly title: string;
	/** What ends it, in words: "Until it merges". */
	readonly until: string;
	/** The last look and what it saw: "Looked 10:31 · saw 2 checks failed". */
	readonly last?: string | undefined;
	readonly paused?: boolean | undefined;
	/** What ended it, until the owner removes the row: "Done · merged". */
	readonly done?: string | undefined;
};

const WATCHES: readonly WatchRowView[] = [
	{
		id: "pr-34",
		title: "One word per thing: chat, source, poll, extension",
		until: "Until it merges",
		last: "Looked 10:31 · saw 2 checks failed",
	},
	{
		id: "issue-41",
		title: "The panel loses the open file on reload",
		until: "Until it closes",
		last: "Looked 9:58 · saw nothing new",
		paused: true,
	},
	{
		id: "pr-35",
		title: "Routines wake in their agent's chat",
		until: "Until it merges",
		done: "Done · merged",
	},
];

/** Below the routines: what the agent follows. Follow takes a link; Check now and Pause sit on the row. */
function Watching({ watches }: { watches: readonly WatchRowView[] }) {
	return (
		<PanelSection
			title="Watching"
			action={
				<Button variant="outline" size="xs">
					<PlusIcon />
					Follow
				</Button>
			}
		>
			<ul className="-mx-2 flex flex-col">
				{watches.map((watch) => (
					<WatchRow key={watch.id} watch={watch} />
				))}
			</ul>
		</PanelSection>
	);
}

function WatchRow({ watch }: { watch: WatchRowView }) {
	const quiet = watch.paused === true || watch.done !== undefined;
	return (
		<li className="group/watch relative flex items-start gap-2 rounded-field px-2 py-2 hover:bg-paper-3">
			<button
				type="button"
				aria-label={`${watch.title}: open`}
				className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
			>
				<GitHubMark className={cn("mt-1 size-3.5 shrink-0", quiet && "opacity-60")} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className={cn("truncate text-ui font-medium", quiet ? "text-ink-2" : "text-ink")}>{watch.title}</span>
					<span className="truncate text-meta text-ink-2">
						{watch.done ?? (watch.paused === true ? `${watch.until} · Paused` : watch.until)}
					</span>
					{watch.last === undefined || watch.done !== undefined ? null : (
						<span className="truncate text-meta text-ink-2">{watch.last}</span>
					)}
				</span>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-xs" className="text-ink-2" aria-label={`${watch.title}: more`}>
						<EllipsisIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{watch.done === undefined ? (
						<>
							<DropdownMenuItem>
								<EyeIcon />
								Check now
							</DropdownMenuItem>
							<DropdownMenuItem>
								{watch.paused === true ? <PlayIcon /> : <PauseIcon />}
								{watch.paused === true ? "Resume" : "Pause"}
							</DropdownMenuItem>
						</>
					) : (
						<DropdownMenuItem>
							<Trash2Icon />
							Remove
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/** A wake's line leads with the service's icon; the words come from the kind's rules, never from the model. */
function WakeLine({ children, time }: { children: ReactNode; time?: string | undefined }) {
	return (
		<Line time={time} onClick={() => {}}>
			<GitHubMark className="mr-1.5 inline size-3.5 fill-current align-[-2px]" />
			{children}
		</Line>
	);
}

export function WatchesSection() {
	return (
		<>
			<Section
				id="watch-rows"
				title="A watch in the sidebar"
				note="A watch has no row of its own: it belongs to its agent. A change that waits on the owner reads as the ask, with the waiting dot; one that needs no decision only raises the unread count; a paused watch dims the face. A watch never fires a notification; it only badges."
			>
				<div className="flex max-w-[var(--sidebar-width)] flex-col gap-0.5 rounded-tile bg-paper-2 p-2">
					{WATCH_ROWS.map((row) => (
						<Row key={row.id} row={row} />
					))}
				</div>
			</Section>
			<Section
				id="watch-lines"
				title="A watch in the chat"
				note="Each wake is an event line in place: the change in the kind's words, the object's card beneath, then the agent's reply if it answered. Tapping the line opens the watch in the panel. Lifecycle and problems are lines too; the final line of an ended watch stays."
			>
				<div className="flex max-w-2xl flex-col gap-3">
					<Line icon={EyeIcon}>Following banda#34 until merged</Line>
					<WakeLine time="10:12">Review requested by @ana</WakeLine>
					<PullRequestCard
						pr={{ ...PR, checks: { passed: 10, failed: 0, running: 1 }, reviews: "Ana asked for your review" }}
					/>
					<Run who={OCTO} time="10:14">
						<Bubble>Ana wants your review on #34. The diff is small, two files; the checks are still running.</Bubble>
					</Run>
					<WakeLine time="10:31">Checks failed on banda#34</WakeLine>
					<CheckRunCard run={CHECK_RUN} />
					<Line icon={CircleAlertIcon} tone="danger">
						Can't reach GitHub since 10:42
					</Line>
					<Line icon={PauseIcon}>Paused</Line>
					<Line icon={EyeOffIcon}>Done · merged</Line>
				</div>
				<Group label="An object's card offers Follow among its quiet actions" className="items-start">
					<div className="w-full max-w-2xl">
						<PullRequestCard
							pr={PR}
							actions={
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${PR.repo} #${PR.number}`}>
											<EllipsisIcon />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem>
											<EyeIcon />
											Follow until it merges
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							}
						/>
					</div>
				</Group>
			</Section>
			<Section
				id="watching-panel"
				title="Watching, in the panel"
				note="Below the agent's routines, one row per watch: the service's icon, the object's title, what ends it, the last look and what it saw, paused or done. Check now and Pause on the row; tapping opens the object's card and the watch's editor; Follow takes a link."
			>
				<Group label="Octo's Routines tab, Watching beneath">
					<div className="flex h-[680px] w-fit overflow-hidden rounded-tile border border-line-soft [&>aside]:border-l-0">
						<Panel name="Octo">
							<AgentPanel
								who={OCTO}
								tab="routines"
								routines={
									<>
										<Routines agent="Octo" routines={ROUTINES.slice(2)} />
										<Watching watches={WATCHES} />
									</>
								}
								access={
									<>
										<Connections
											agent="Octo"
											rows={[{ connection: "GitHub", accounts: [{ login: "@bandarra", on: true }] }]}
											compact
										/>
										<Permissions agent="Octo" permissions={PERMISSIONS.slice(0, 1)} />
									</>
								}
								memory={<Memory agent="Octo" facts={[]} />}
								about={
									<Personality text="Keeps an eye on the repo. Follows what you ask it to, and speaks only when something needs you." />
								}
							/>
						</Panel>
					</div>
				</Group>
			</Section>
		</>
	);
}

/**
 * `#/specimen/watches?scheme=dark&width=phone`: the watches sections alone, one scheme at a time, for the docs'
 * captures (docs/screenshots/watches/).
 */
export function WatchesPreview() {
	const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
	const scheme = query.get("scheme") === "dark" ? "dark" : "light";
	const width = query.get("width") === "phone" ? "phone" : "desktop";
	return (
		<StageContext.Provider value={{ scheme, width }}>
			<div style={{ colorScheme: scheme }} data-scheme={scheme} className="flex min-h-svh flex-col bg-paper-2 text-ink">
				<header className="shrink-0 border-b border-line-soft bg-paper">
					<div
						className={cn(
							"mx-auto flex h-10 w-full items-center px-4",
							width === "phone" ? "max-w-[390px]" : "max-w-[110rem]",
						)}
					>
						<a href="#/specimen?section=watch-rows" className="text-meta text-ink-2">
							Watches · specimen
						</a>
					</div>
				</header>
				<main
					className={cn(
						"mx-auto flex w-full flex-col gap-12 p-4",
						width === "phone" ? "max-w-[390px]" : "max-w-[110rem] md:p-6",
					)}
				>
					<WatchesSection />
				</main>
			</div>
		</StageContext.Provider>
	);
}
