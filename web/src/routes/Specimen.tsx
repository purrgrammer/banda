/**
 * The specimen (`#/specimen`): every component of the app with fixture data, in light and dark side by side, at desktop
 * or phone width, indexed by `specimen/registry.ts`. Its contents, the section in view, the theme and the width live in
 * the hash (`specimen/url.ts`), so any section can be linked and `only=1` shows one alone for a screenshot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { ActivityPreview } from "../specimen/agent/activity.tsx";
import { RecordedActivityPreview } from "../specimen/agent/recorded-activity.tsx";
import { SkillDetailPreview } from "../specimen/agent/skills.tsx";
import { ToolsetsPreview } from "../specimen/agent/toolsets.tsx";
import { McpPreview } from "../specimen/connections/mcp.tsx";
import { CONTENTS } from "../specimen/contents.tsx";
import {
	type Entry,
	GROUPS,
	type GroupId,
	SECTIONS,
	STATUS_WORDS,
	sectionOf,
	sectionsOf,
} from "../specimen/registry.ts";
import { StageContext } from "../specimen/stage.tsx";
import { hrefOf, previewOf, type Scheme, type View, viewOf, type Width } from "../specimen/url.ts";

/** The hash, and a way to change it: pushed (a place to come back to) or replaced (the same place, described better). */
function useHash() {
	const [hash, setHash] = useState(location.hash);
	useEffect(() => {
		const changed = () => setHash(location.hash);
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, []);
	const go = useCallback((href: string, how: "push" | "replace") => {
		if (href === location.hash) return;
		if (how === "push") location.hash = href;
		else {
			history.replaceState(null, "", href);
			setHash(href);
		}
	}, []);
	return { hash, go };
}

export function Specimen() {
	const { hash, go } = useHash();
	const preview = previewOf(hash);
	if (preview?.kind === "toolsets") return <ToolsetsPreview />;
	if (preview?.kind === "mcp") return <McpPreview />;
	if (preview?.kind === "skill") return <SkillDetailPreview name={preview.name} />;
	if (preview?.kind === "recorded") return <RecordedActivityPreview />;
	if (preview?.kind === "activity") return <ActivityPreview />;
	return <Page view={viewOf(hash)} go={go} />;
}

function Page({ view, go }: { view: View; go: (href: string, how: "push" | "replace") => void }) {
	const entry = view.section === undefined ? undefined : sectionOf(view.section);
	// one section alone shows at the width it exists at
	const width = view.only && entry?.only !== undefined ? entry.only : view.width;
	const [current, setCurrent] = useState(view.section);
	const [filter, setFilter] = useState("");
	const [contentsOpen, setContentsOpen] = useState(false);
	const main = useRef<HTMLElement>(null);
	// the hash's section is scrolled to when it was navigated to (a link, the nav), never when the scroll wrote it
	const [target, setTarget] = useState<{ id: string | undefined; n: number }>({ id: view.section, n: 0 });
	const written = useRef<string | undefined>(undefined);
	// a scroll under way to the target: what the scroll finds in between is not the section in view
	const settling = useRef(false);
	useEffect(() => {
		if (view.section === written.current) return;
		written.current = undefined;
		setTarget((was) => ({ id: view.section, n: was.n + 1 }));
	}, [view.section]);
	useEffect(() => {
		if (target.id === undefined) return;
		let frame = 0;
		let tries = 0;
		settling.current = true;
		const scroll = () => {
			const element = document.getElementById(target.id ?? "");
			if (element !== null) {
				element.scrollIntoView();
				setCurrent(target.id);
				frame = requestAnimationFrame(() => {
					settling.current = false;
				});
			} else if (tries++ < 30) frame = requestAnimationFrame(scroll);
			else settling.current = false;
		};
		frame = requestAnimationFrame(scroll);
		return () => {
			cancelAnimationFrame(frame);
			settling.current = false;
		};
	}, [target]);

	// the section in view: the top-most one past the first third of the page, among those this width shows
	useEffect(() => {
		const root = main.current;
		if (root === null || view.only) return;
		const sections = SECTIONS.filter((entry) => entry.only === undefined || entry.only === width)
			.map((entry) => document.getElementById(entry.id))
			.filter((element): element is HTMLElement => element !== null);
		const observer = new IntersectionObserver(
			() => {
				if (settling.current) return;
				const line = root.getBoundingClientRect().top + root.clientHeight / 3;
				let seen: HTMLElement | undefined;
				for (const section of sections) {
					if (section.getBoundingClientRect().top <= line) seen = section;
					else break;
				}
				const id = (seen ?? sections[0])?.id;
				if (id !== undefined) setCurrent(id);
			},
			{ root, threshold: [0, 0.1, 0.5, 1] },
		);
		for (const section of sections) observer.observe(section);
		return () => observer.disconnect();
	}, [view.only, width]);
	// what the scroll found goes to the hash, replaced, so the link in the address bar is the section in view
	useEffect(() => {
		if (current === undefined || view.only || current === view.section) return;
		written.current = current;
		go(hrefOf({ ...view, section: current }), "replace");
	}, [current, view, go]);

	const pick = (id: string) => {
		const picked = sectionOf(id);
		const at = picked?.only !== undefined && picked.only !== width ? picked.only : width;
		setContentsOpen(false);
		go(hrefOf({ ...view, width: at, section: id }), "push");
		setTarget((was) => ({ id, n: was.n + 1 }));
	};
	const contents = <Contents filter={filter} onFilter={setFilter} current={current} width={width} onPick={pick} />;
	const page = (
		<div className="mx-auto flex max-w-[110rem] flex-col gap-12 p-4 pb-24 md:p-6">
			{GROUPS.map((group) => (
				<GroupBlock key={group.id} id={group.id} only={view.only} />
			))}
		</div>
	);
	return (
		<StageContext.Provider value={{ scheme: view.scheme, width, ...(view.only && entry ? { only: entry.id } : {}) }}>
			<Toaster />
			{view.only ? (
				<main className="min-h-svh bg-paper-2 text-ink">{entry === undefined ? <NoSection /> : page}</main>
			) : (
				<div className="flex h-svh flex-col bg-paper-2 text-ink">
					<header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b border-line-soft bg-paper px-4 py-2">
						<Sheet open={contentsOpen} onOpenChange={setContentsOpen}>
							<SheetTrigger
								className="rounded-field border border-line px-2.5 py-1 text-meta font-medium text-ink-2 hover:text-ink md:hidden"
								aria-label="Contents"
							>
								Contents
							</SheetTrigger>
							<SheetContent side="left" className="w-72 overflow-y-auto p-3 pt-10">
								<SheetHeader className="sr-only">
									<SheetTitle>Contents</SheetTitle>
									<SheetDescription>Every section of the specimen, by group.</SheetDescription>
								</SheetHeader>
								{contents}
							</SheetContent>
						</Sheet>
						<a href="#/specimen" className="text-meta text-ink-2 hover:text-ink">
							Specimen
						</a>
						{entry === undefined ? null : (
							<span className="hidden truncate text-meta text-ink-2 sm:inline" aria-live="polite">
								· {entry.title}
							</span>
						)}
						<div className="ml-auto flex items-center gap-2">
							<Segmented
								label="Theme"
								value={view.scheme}
								onChange={(scheme: Scheme) => go(hrefOf({ ...view, scheme }), "replace")}
								options={[
									["both", "Both"],
									["light", "Light"],
									["dark", "Dark"],
								]}
							/>
							<Segmented
								label="Width"
								value={width}
								onChange={(next: Width) => go(hrefOf({ ...view, width: next }), "replace")}
								options={[
									["desktop", "Desktop"],
									["phone", "Phone"],
								]}
							/>
						</div>
					</header>
					<div className="flex min-h-0 flex-1">
						<div className="hidden w-60 shrink-0 flex-col overflow-y-auto p-3 md:flex">{contents}</div>
						<main ref={main} className="min-w-0 flex-1 overflow-y-auto">
							{page}
						</main>
					</div>
				</div>
			)}
		</StageContext.Provider>
	);
}

/** One group of the page: its heading, then its components, each rendering its sections. */
function GroupBlock({ id, only }: { id: GroupId; only: boolean }) {
	const group = GROUPS.find((one) => one.id === id);
	if (group === undefined) return null;
	return (
		<>
			{only ? null : (
				<div id={`group-${id}`} className="flex scroll-mt-4 flex-col gap-1 border-b border-line pb-3 pt-6 first:pt-0">
					<p className="text-display font-semibold text-ink">{group.title}</p>
					<p className="max-w-[var(--measure)] text-ui text-ink-2">{group.note}</p>
				</div>
			)}
			{CONTENTS[id].map(([name, Block]) => (
				<Block key={name} />
			))}
		</>
	);
}

/** The contents: every section by group, filtered as you type, the one in view marked. */
function Contents({
	filter,
	onFilter,
	current,
	width,
	onPick,
}: {
	filter: string;
	onFilter: (text: string) => void;
	current: string | undefined;
	width: Width;
	onPick: (id: string) => void;
}) {
	const words = filter.trim().toLowerCase();
	const matches = (entry: Entry, group: string) =>
		words === "" ||
		entry.title.toLowerCase().includes(words) ||
		entry.id.includes(words) ||
		group.toLowerCase().includes(words) ||
		STATUS_WORDS[entry.status].toLowerCase().includes(words);
	const list = useRef<HTMLElement>(null);
	useEffect(() => {
		if (current === undefined) return;
		list.current?.querySelector(`[data-section="${current}"]`)?.scrollIntoView({ block: "nearest" });
	}, [current]);
	return (
		<nav ref={list} aria-label="Contents" className="flex flex-col gap-3">
			<Input
				type="search"
				value={filter}
				onChange={(event) => onFilter(event.target.value)}
				placeholder="Filter sections"
				aria-label="Filter sections"
				className="h-8 text-ui"
			/>
			{GROUPS.map((group) => {
				const entries = sectionsOf(group.id).filter((entry) => matches(entry, group.title));
				if (entries.length === 0) return null;
				return (
					<div key={group.id} className="flex flex-col gap-0.5">
						<p className="px-2.5 pb-1 pt-2 text-meta font-semibold uppercase tracking-wide text-ink-2">{group.title}</p>
						{entries.map((entry) => {
							const elsewhere = entry.only !== undefined && entry.only !== width;
							return (
								<button
									type="button"
									key={entry.id}
									data-section={entry.id}
									aria-current={current === entry.id ? "true" : undefined}
									onClick={() => onPick(entry.id)}
									className={cn(
										"flex items-baseline justify-between gap-2 rounded-field px-2.5 py-1 text-left text-ui text-ink-2 hover:bg-paper-3 hover:text-ink",
										current === entry.id && "bg-paper-3 font-medium text-ink",
										elsewhere && "text-ink-3",
									)}
								>
									<span className="min-w-0 truncate">{entry.title}</span>
									{entry.status === "app" ? null : (
										<span className="shrink-0 text-meta text-ink-3">{STATUS_WORDS[entry.status]}</span>
									)}
									{elsewhere ? <span className="shrink-0 text-meta text-ink-3">{entry.only}</span> : null}
								</button>
							);
						})}
					</div>
				);
			})}
			{words !== "" && GROUPS.every((group) => sectionsOf(group.id).every((entry) => !matches(entry, group.title))) ? (
				<p className="px-2.5 text-ui text-ink-2">No section matches.</p>
			) : null}
		</nav>
	);
}

function NoSection() {
	return (
		<p className="p-6 text-ui text-ink-2">
			No such section.{" "}
			<a href="#/specimen" className="text-ink underline">
				Open the specimen
			</a>
			.
		</p>
	);
}

function Segmented<T extends string>({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: T;
	onChange: (value: T) => void;
	options: readonly (readonly [T, string])[];
}) {
	return (
		<fieldset aria-label={label} className="flex rounded-field border-0 bg-paper-3 p-0.5">
			{options.map(([one, text]) => (
				<button
					key={one}
					type="button"
					aria-pressed={value === one}
					onClick={() => onChange(one)}
					className={cn(
						"rounded-[6px] px-2.5 py-1 text-meta font-medium text-ink-2",
						value === one && "bg-paper text-ink shadow-[0_0_0_1px_var(--line-soft)]",
					)}
				>
					{text}
				</button>
			))}
		</fieldset>
	);
}
