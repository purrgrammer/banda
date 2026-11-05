/**
 * Search (⌘K): one field over every chat; a result is a row that opens its chat scrolled to that message, the match
 * in ink.
 */
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Face } from "./Face.tsx";
import type { Who } from "./Row.tsx";

export type Hit = {
	readonly id: string;
	readonly who: Who | { readonly emoji: string; readonly name: string };
	readonly before: string;
	readonly match: string;
	readonly after: string;
	readonly when: string;
};

/** `hits` undefined: still searching; `onRetry`: the search failed, and can be tried again. */
export function Search({
	query,
	hits,
	onQuery,
	onPick,
	onRetry,
}: {
	query: string;
	hits?: readonly Hit[] | undefined;
	onQuery?: (query: string) => void;
	onPick?: (id: string) => void;
	onRetry?: (() => void) | undefined;
}) {
	return (
		<div className="flex w-full max-w-lg flex-col overflow-hidden rounded-tile border border-line bg-paper shadow-composer">
			<div className="flex h-12 items-center gap-2.5 border-b border-line-soft px-3.5">
				<SearchIcon className="size-4 text-ink-2" />
				<input
					aria-label="Search your chats"
					{...(onQuery === undefined
						? { defaultValue: query }
						: { value: query, onChange: (event) => onQuery(event.target.value) })}
					className="h-full flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-2"
					placeholder="Search your chats"
				/>
				<kbd className="rounded-[5px] border border-line px-1.5 text-meta text-ink-2">esc</kbd>
			</div>
			{onRetry !== undefined ? (
				<p role="alert" className="flex flex-col items-center gap-2 px-4 py-6 text-center text-ui text-ink-2">
					Couldn't search: banda on this computer didn't answer.
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				</p>
			) : hits === undefined ? (
				<p role="status" className="px-4 py-6 text-center text-ui text-ink-2">
					Searching…
				</p>
			) : hits.length === 0 && query.trim() !== "" ? (
				<p className="px-4 py-6 text-center text-ui text-ink-2">Nothing in your chats says “{query}”.</p>
			) : null}
			<ul className="flex flex-col p-1.5 empty:hidden">
				{(hits ?? []).map((hit, index) => (
					<li key={hit.id}>
						<button
							type="button"
							onClick={() => onPick?.(hit.id)}
							className={
								index === 0
									? "flex w-full items-center gap-3 rounded-field bg-paper-3 px-2.5 py-2 text-left"
									: "flex w-full items-center gap-3 rounded-field px-2.5 py-2 text-left hover:bg-paper-3"
							}
						>
							{"face" in hit.who ? (
								<Face face={hit.who.face} name={hit.who.name} size="message" />
							) : (
								<span
									role="img"
									aria-label={hit.who.name}
									className="inline-flex size-7 shrink-0 items-center justify-center"
								>
									{hit.who.emoji}
								</span>
							)}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-meta text-ink-2">
									{hit.who.name} · {hit.when}
								</span>
								<span className="truncate text-ui text-ink-2">
									{hit.before}
									<mark className="bg-transparent font-semibold text-ink">{hit.match}</mark>
									{hit.after}
								</span>
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
