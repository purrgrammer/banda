/**
 * Search (Cmd/Ctrl+K), on cmdk's listbox: with nothing typed, the band's rows to switch to; with a query, agents,
 * skills and pages found in the app, then the chats the daemon found, each hit opening its chat at that message.
 * Arrows move the active row, Home and End jump, Enter opens, Esc closes; while a new search runs the previous hits
 * stay, dimmed, so the list never collapses — but they are inert (Enter, clicks and the arrows skip them) until the
 * new answer makes them live again; the local sections always answer the query as typed, so they stay live.
 */
import { Command as CommandPrimitive } from "cmdk";
import { BookOpenIcon, FileTextIcon, PlugIcon, SearchIcon, SettingsIcon, UserIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CommandEmpty, CommandGroup, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/cn";
import { firstLiveValue } from "../app/palette.ts";
import { Face, FaceStack } from "./Face.tsx";
import type { Who } from "./Row.tsx";

/** A chat or artifact hit: who said it (or a chip for "You" and an artifact), the match, and when. */
export type Hit = {
	readonly id: string;
	readonly who: Who | { readonly chip: "you" | "artifact"; readonly name: string };
	readonly before: string;
	readonly match: string;
	readonly after: string;
	/** The hit's date; an artifact has none and says "Artifact" here. */
	readonly when: string;
};

/** A band row offered with nothing typed: the switcher. */
export type RecentRow = {
	readonly id: string;
	readonly name: string;
	readonly faces: readonly Who[];
	readonly excerpt: string;
	readonly by?: string | undefined;
};

export type AgentHit = Who & { readonly id: string };
export type SkillHit = { readonly name: string; readonly description: string };
export type PageHit = { readonly id: "skills" | "connections" | "settings"; readonly label: string };

const PAGE_ICONS: Record<PageHit["id"], ComponentType<{ className?: string }>> = {
	skills: BookOpenIcon,
	connections: PlugIcon,
	settings: SettingsIcon,
};

/** A muted chip where a hit has no face: the owner, an artifact, a skill, a page. */
function Chip({ icon: Icon }: { icon: ComponentType<{ className?: string }> }) {
	return (
		<span
			aria-hidden="true"
			className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-3"
		>
			<Icon className="size-4 text-ink-2" />
		</span>
	);
}

function Item({
	value,
	disabled = false,
	onSelect,
	children,
}: {
	value: string;
	disabled?: boolean;
	onSelect?: () => void;
	children: ReactNode;
}) {
	return (
		<CommandPrimitive.Item
			value={value}
			disabled={disabled}
			{...(onSelect === undefined ? {} : { onSelect })}
			className="flex w-full cursor-default items-center gap-3 rounded-field px-2.5 py-2 text-left select-none data-[selected=true]:bg-paper-3"
		>
			{children}
		</CommandPrimitive.Item>
	);
}

const heading = (words: string) => <span className="text-meta font-medium text-ink-2">{words}</span>;

/**
 * `hits` are the chat hits shown, the previous query's while `stale`; `searching`: the daemon is being asked;
 * `onRetry`: the search failed, and can be tried again. `onPick` gets the active row's value: `recent:<row>`,
 * `agent:<id>`, `skill:<name>`, `page:<id>` or `hit:<n>`.
 */
export function Search({
	query,
	onQuery,
	recent = [],
	agents = [],
	skills = [],
	pages = [],
	hits = [],
	searching = false,
	stale = false,
	onPick,
	onRetry,
	phone = false,
	onCancel,
}: {
	query: string;
	onQuery?: (query: string) => void;
	recent?: readonly RecentRow[];
	agents?: readonly AgentHit[];
	skills?: readonly SkillHit[];
	pages?: readonly PageHit[];
	hits?: readonly Hit[];
	searching?: boolean;
	stale?: boolean;
	onPick?: (value: string) => void;
	onRetry?: (() => void) | undefined;
	phone?: boolean;
	onCancel?: () => void;
}) {
	const typed = query.trim() !== "";
	const pick = (value: string) => () => onPick?.(value);
	// the active row, controlled: stale hits are inert, so the selection must be able to leave them
	const [active, setActive] = useState("");
	// a search starts over kept hits: the active row leaves them for the first live local row, or none
	useEffect(() => {
		if (stale && active.startsWith("hit:")) setActive(firstLiveValue(agents, skills, pages));
	}, [stale, active, agents, skills, pages]);
	// the answer in: the hits are live again, and with nothing active the first of them takes the selection
	useEffect(() => {
		const [first] = hits;
		if (!stale && active === "" && first !== undefined) setActive(`hit:${first.id}`);
	}, [stale, active, hits]);
	return (
		<CommandPrimitive
			label="Search banda"
			shouldFilter={false}
			value={active}
			onValueChange={setActive}
			className="flex w-full max-w-lg flex-col overflow-hidden rounded-tile border border-line bg-paper shadow-composer"
		>
			<div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line-soft px-3.5">
				<SearchIcon className="size-4 shrink-0 text-ink-2" />
				<CommandPrimitive.Input
					autoFocus
					aria-label="Search banda"
					placeholder="Search banda"
					value={query}
					{...(onQuery === undefined ? {} : { onValueChange: onQuery })}
					className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-2"
				/>
				{phone ? (
					<Button variant="ghost" size="sm" className="-mr-2 shrink-0 text-ink-2" onClick={onCancel}>
						Cancel
					</Button>
				) : (
					<kbd className="rounded-[5px] border border-line px-1.5 text-meta text-ink-2">esc</kbd>
				)}
			</div>
			<CommandList className="max-h-[min(22rem,60dvh)] scroll-py-1.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1.5 empty:p-0">
				{!typed && recent.length > 0 ? (
					<CommandGroup heading={heading("Recent")} className="p-0">
						{recent.map((row) => {
							const [first] = row.faces;
							return (
								<Item key={row.id} value={`recent:${row.id}`} onSelect={pick(`recent:${row.id}`)}>
									{row.faces.length > 1 || first === undefined ? (
										<FaceStack faces={row.faces} name={row.name} size="message" />
									) : (
										<Face face={first.face} name={row.name} size="message" />
									)}
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate text-ui font-medium text-ink">{row.name}</span>
										<span className="truncate text-meta text-ink-2">
											{row.by === undefined ? null : `${row.by}: `}
											{row.excerpt}
										</span>
									</span>
								</Item>
							);
						})}
					</CommandGroup>
				) : null}
				{typed && agents.length > 0 ? (
					<CommandGroup heading={heading("Agents")} className="p-0">
						{agents.map((agent) => (
							<Item key={agent.id} value={`agent:${agent.id}`} onSelect={pick(`agent:${agent.id}`)}>
								<Face face={agent.face} name={agent.name} size="message" />
								<span className="truncate text-ui font-medium text-ink">{agent.name}</span>
							</Item>
						))}
					</CommandGroup>
				) : null}
				{typed && skills.length > 0 ? (
					<CommandGroup heading={heading("Skills")} className="p-0">
						{skills.map((skill) => (
							<Item key={skill.name} value={`skill:${skill.name}`} onSelect={pick(`skill:${skill.name}`)}>
								<Chip icon={BookOpenIcon} />
								<span className="flex min-w-0 flex-1 items-baseline gap-2">
									<span className="shrink-0 text-ui font-medium text-ink">{skill.name}</span>
									<span className="truncate text-meta text-ink-2">{skill.description}</span>
								</span>
							</Item>
						))}
					</CommandGroup>
				) : null}
				{typed && pages.length > 0 ? (
					<CommandGroup heading={heading("Pages")} className="p-0">
						{pages.map((page) => (
							<Item key={page.id} value={`page:${page.id}`} onSelect={pick(`page:${page.id}`)}>
								<Chip icon={PAGE_ICONS[page.id]} />
								<span className="truncate text-ui font-medium text-ink">{page.label}</span>
							</Item>
						))}
					</CommandGroup>
				) : null}
				{typed && hits.length > 0 ? (
					<CommandGroup heading={heading("Chats")} aria-busy={searching} className={cn("p-0", stale && "opacity-60")}>
						{hits.map((hit) => (
							<Item key={hit.id} value={`hit:${hit.id}`} disabled={stale} onSelect={pick(`hit:${hit.id}`)}>
								{"face" in hit.who ? (
									<Face face={hit.who.face} name={hit.who.name} size="message" />
								) : (
									<Chip icon={hit.who.chip === "you" ? UserIcon : FileTextIcon} />
								)}
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-meta text-ink-2">
										{hit.who.name} · {hit.when}
									</span>
									<span className="truncate text-ui text-ink-2">
										{hit.before}
										<mark className="bg-transparent font-semibold text-ink">{hit.match}</mark>
										{hit.after}
									</span>
								</span>
							</Item>
						))}
					</CommandGroup>
				) : null}
				{typed && onRetry !== undefined ? (
					<p role="alert" className="flex flex-col items-center gap-2 px-4 py-6 text-center text-ui text-ink-2">
						Couldn't search: banda on this computer didn't answer.
						<Button variant="outline" size="sm" onClick={onRetry}>
							Try again
						</Button>
					</p>
				) : null}
				{typed && onRetry === undefined && searching && hits.length === 0 ? (
					<p role="status" className="px-4 py-2 text-center text-meta text-ink-2">
						Searching…
					</p>
				) : null}
				{typed && onRetry === undefined && !searching ? (
					<CommandEmpty className="px-4 py-6 text-ui text-ink-2">Nothing matches “{query}”.</CommandEmpty>
				) : null}
			</CommandList>
		</CommandPrimitive>
	);
}
