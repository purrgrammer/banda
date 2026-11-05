/**
 * Search (Cmd/Ctrl+K): one field over every chat, every group and the artifacts; a result opens its chat at that
 * message. Asks the daemon a moment after the owner stops typing.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Who } from "../chat/Row.tsx";
import { Search } from "../chat/Search.tsx";
import { api, type SearchHit } from "../lib/api.ts";
import type { Where } from "./where.ts";

/** The text around the first word of the query that matches, for the result's line. */
function around(text: string, query: string): { before: string; match: string; after: string } {
	const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const lower = text.toLowerCase();
	const at = words.map((word) => [lower.indexOf(word), word.length] as const).find(([index]) => index >= 0);
	const plain = (part: string) => part.replace(/\s+/g, " ");
	if (at === undefined) return { before: plain(text).slice(0, 80), match: "", after: "" };
	const [index, length] = at;
	return {
		before: (index > 30 ? "…" : "") + plain(text.slice(Math.max(0, index - 30), index)),
		match: text.slice(index, index + length),
		after: plain(text.slice(index + length, index + length + 80)),
	};
}

export function SearchDialog({
	open,
	onOpenChange,
	whoOf,
	groupName,
	onGo,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	whoOf: (agent: string) => Who;
	groupName: (room: number) => string;
	onGo: (where: Where) => void;
}) {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<readonly SearchHit[] | undefined>([]);
	const [failed, setFailed] = useState(false);
	const [tries, setTries] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tries` searches again after a failure
	useEffect(() => {
		if (query.trim() === "") {
			setHits([]);
			return;
		}
		setHits(undefined);
		setFailed(false);
		let gone = false;
		const timer = setTimeout(() => {
			void api<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`)
				.then((found) => {
					if (!gone) setHits(found);
				})
				.catch(() => {
					if (!gone) setFailed(true);
				});
		}, 200);
		return () => {
			gone = true;
			clearTimeout(timer);
		};
	}, [query, tries]);
	const shown = (hits ?? []).map((hit, index) => {
		const when = "at" in hit ? new Date(hit.at).toLocaleDateString([], { day: "numeric", month: "short" }) : "Artifact";
		const who =
			hit.kind === "chat"
				? hit.by === "owner"
					? { emoji: "🙂", name: "You" }
					: whoOf(hit.agent)
				: hit.kind === "group"
					? hit.who === "owner"
						? { emoji: "🙂", name: `You in ${groupName(hit.room)}` }
						: { ...whoOf(hit.who), name: `${whoOf(hit.who).name} in ${groupName(hit.room)}` }
					: { emoji: "📄", name: hit.title };
		return { id: String(index), who, when, ...around(hit.text, query) };
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="top-[12vh] translate-y-0 border-0 bg-transparent p-0 shadow-none sm:max-w-lg"
			>
				<DialogTitle className="sr-only">Search your chats</DialogTitle>
				<Search
					query={query}
					hits={query.trim() === "" ? [] : hits === undefined ? undefined : shown}
					onQuery={setQuery}
					onRetry={failed ? () => setTries((n) => n + 1) : undefined}
					onPick={(id) => {
						const hit = hits?.[Number(id)];
						if (hit === undefined) return;
						onOpenChange(false);
						if (hit.kind === "chat") onGo({ name: "agent", id: hit.agent, at: hit.entry });
						else if (hit.kind === "group") onGo({ name: "group", room: hit.room, at: hit.entry });
						else onGo({ name: "artifact", id: hit.id });
					}}
				/>
			</DialogContent>
		</Dialog>
	);
}
