/** A skill in chat is one quiet feed item; its files and instructions belong to the detail page and Activity. */

import { BookOpenIcon, ChevronDownIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Markdown } from "../components/Markdown.tsx";
import { FILTER_FROM, filterSkills } from "../lib/skill-page.ts";
import { Line } from "./Line.tsx";

export type SkillSummary = {
	readonly name: string;
	readonly description: string;
	/** Only the owner's /name loads it; agents never see it. */
	readonly ownerOnly?: boolean;
};

export type SkillInfo = SkillSummary & {
	/** The workspace file; no separate synced definition. */
	readonly path: string;
	readonly body: string;
	readonly files?: readonly string[];
};

export type SkillRow = SkillSummary & {
	/** An agent's change waits on the owner. */
	readonly changed?: boolean;
};

/** A quiet marker on a row: what sets this skill apart, in two words. */
function RowMark({ children }: { children: string }) {
	return (
		<span className="shrink-0 rounded-full border border-line-soft px-1.5 py-px text-meta text-ink-2">{children}</span>
	);
}

/** The Skills page's list: every accepted skill, flat and visible, a filter once it grows. */
export function SkillList({ skills, hrefFor }: { skills: readonly SkillRow[]; hrefFor: (name: string) => string }) {
	const [query, setQuery] = useState("");
	const shown = filterSkills(skills, query);
	return (
		<div className="flex min-w-0 flex-col gap-2" data-skill-list="">
			{skills.length >= FILTER_FROM ? (
				<Input
					type="search"
					aria-label="Filter skills"
					placeholder="Filter skills"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			) : null}
			{skills.length === 0 ? (
				<p className="text-ui text-ink-2">No skills yet.</p>
			) : shown.length === 0 ? (
				<p className="text-ui text-ink-2">No skill matches “{query.trim()}”.</p>
			) : (
				<ul className="flex min-w-0 flex-col gap-0.5">
					{shown.map((skill) => (
						<li key={skill.name} className="min-w-0">
							<a
								href={hrefFor(skill.name)}
								className="flex min-w-0 flex-col gap-0.5 rounded-field px-2 py-1.5 text-left hover:bg-paper-3 focus-visible:bg-paper-3"
							>
								<span className="flex min-w-0 items-center gap-2">
									<span className="truncate font-mono text-ui font-medium text-ink">/{skill.name}</span>
									{skill.ownerOnly === true ? <RowMark>Only you</RowMark> : null}
									{skill.changed === true ? <RowMark>Changed</RowMark> : null}
								</span>
								<span className="line-clamp-2 text-meta text-ink-2">{skill.description}</span>
							</a>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The feed records the load, not the skill's instructions. Its name opens the current skill's detail page. */
export function SkillFeedItem({ name, href, agent }: { name: string; href: string; agent?: string }) {
	return (
		<Line icon={BookOpenIcon}>
			{agent === undefined ? "Loaded " : `${agent} loaded `}
			<a
				href={href}
				className="font-mono font-medium text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink"
			>
				/{name}
			</a>
		</Line>
	);
}

/** A skill's files and metadata, as shown on its detail page. */
export function SkillDetail({ skill }: { skill: SkillInfo }) {
	return (
		<article className="flex min-w-0 flex-col gap-6" data-skill-detail="">
			<header className="flex min-w-0 items-start gap-3">
				<span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-paper-3 text-ink-2">
					<BookOpenIcon aria-hidden="true" className="size-5" />
				</span>
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="break-words font-mono text-heading font-semibold text-ink">/{skill.name}</h1>
					<p className="text-body text-ink-2">{skill.description}</p>
					{skill.ownerOnly === true ? (
						<p className="text-meta text-ink-2">
							Only you can run this, with <span className="font-mono">/{skill.name}</span>. Agents don't see it.
						</p>
					) : (
						<p className="text-meta text-ink-2">Shared with the band</p>
					)}
				</div>
			</header>
			<section className="flex min-w-0 flex-col gap-2">
				<h2 className="text-ui font-semibold text-ink">Instructions</h2>
				<p className="flex min-w-0 items-center gap-1.5 text-meta text-ink-2">
					<FileTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
					<span className="min-w-0 break-all font-mono">{skill.path}</span>
				</p>
				{skill.body.trim() === "" ? (
					<p className="text-ui text-ink-2">No instructions in this skill.</p>
				) : (
					<div className="banda-document min-w-0 rounded-field bg-paper-2 p-4 text-body text-ink md:p-6">
						<Markdown>{skill.body}</Markdown>
					</div>
				)}
			</section>
			<section className="flex min-w-0 flex-col gap-2">
				<h2 className="text-ui font-semibold text-ink">Files</h2>
				<p className="text-meta text-ink-2">
					Other files in this skill are only data. Agents follow just its main instructions.
				</p>
				{skill.files === undefined || skill.files.length === 0 ? (
					<p className="text-ui text-ink-2">No other files.</p>
				) : (
					<ul className="flex min-w-0 flex-col divide-y divide-line-soft rounded-field border border-line-soft">
						{skill.files.map((file) => (
							<li key={file} className="flex min-w-0 items-start gap-2 px-3 py-2 text-ui text-ink-2">
								<FileTextIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
								<span className="break-all font-mono">{file}</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</article>
	);
}

/** A tool result's exact loaded body and paths, not a copy of today's catalogue entry. */
export function SkillToolPreview({ skill }: { skill: SkillInfo }) {
	return (
		<div className="flex min-w-0 flex-col gap-3" data-skill-tool-preview="">
			<p className="text-meta text-ink-2">
				Loaded /{skill.name} · {skill.path}
			</p>
			<p className="text-ui text-ink-2">{skill.description}</p>
			{skill.body.trim() === "" ? (
				<p className="text-ui text-ink-2">No instructions in this skill.</p>
			) : (
				<div className="banda-document max-h-96 min-w-0 overflow-auto rounded-field bg-paper-2 p-3 text-ui text-ink">
					<Markdown>{skill.body}</Markdown>
				</div>
			)}
			{skill.files === undefined || skill.files.length === 0 ? null : (
				<p className="break-words text-meta text-ink-2">Other files: {skill.files.join(", ")}</p>
			)}
		</div>
	);
}

/** A quiet disclosure in About, linking to the same detail page as the feed. */
export function SkillCatalogue({
	skills,
	hrefFor,
}: {
	skills: readonly SkillSummary[];
	hrefFor: (name: string) => string;
}) {
	return (
		<Collapsible className="min-w-0">
			<CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-ui text-ink hover:text-ink-2">
				<span>
					Skills <span className="text-meta text-ink-2">· {skills.length} shared</span>
				</span>
				<ChevronDownIcon
					aria-hidden="true"
					className="size-4 transition-transform group-data-[state=open]:rotate-180"
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex min-w-0 flex-col gap-2 pt-3">
				<p className="text-meta text-ink-2">Use /name in a message, or let the agent choose when one fits.</p>
				{skills.length === 0 ? (
					<p className="text-ui text-ink-2">No skills yet.</p>
				) : (
					<ul className="flex min-w-0 flex-col gap-0.5">
						{skills.map((skill) => (
							<li key={skill.name} className="min-w-0">
								<a
									href={hrefFor(skill.name)}
									className="flex min-w-0 flex-col rounded-field px-2 py-1.5 text-left hover:bg-paper-3 focus-visible:bg-paper-3"
								>
									<span className="truncate font-mono text-ui text-ink">/{skill.name}</span>
									<span className="line-clamp-2 text-meta text-ink-2">{skill.description}</span>
								</a>
							</li>
						))}
					</ul>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
