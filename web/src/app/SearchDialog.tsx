/**
 * Search (Cmd/Ctrl+K): with nothing typed, the band's rows, a keyboard switcher; typed, the agents, skills and pages
 * matched in the app at once, then every chat, group and artifact the daemon finds a moment after the owner stops
 * typing. The previous hits stay on screen, dimmed, while a new search runs.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Who } from "../chat/Row.tsx";
import { Search } from "../chat/Search.tsx";
import { api, type SearchHit } from "../lib/api.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import type { BandRow } from "./band.ts";
import { matchAgents, matchPages, matchSkills } from "./palette.ts";
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
	rows,
	agents,
	skills,
	whoOf,
	groupName,
	onGo,
	phone = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The band's rows, in the band's order: the Recent section, so search doubles as a switcher. */
	rows: readonly BandRow[];
	agents: readonly ChatAgent[];
	skills: readonly { readonly name: string; readonly description: string }[];
	whoOf: (agent: string) => Who;
	groupName: (room: number) => string;
	onGo: (where: Where) => void;
	phone?: boolean;
}) {
	const [query, setQuery] = useState("");
	/** The newest answer, and the query it answered: hits stay (dimmed) while the next search runs. */
	const [found, setFound] = useState<{ hits: readonly SearchHit[]; for: string }>();
	const [searching, setSearching] = useState(false);
	const [failed, setFailed] = useState(false);
	const [tries, setTries] = useState(0);
	const trimmed = query.trim();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tries` searches again after a failure
	useEffect(() => {
		if (trimmed === "") {
			setFound(undefined);
			setSearching(false);
			setFailed(false);
			return;
		}
		setSearching(true);
		setFailed(false);
		let gone = false;
		const timer = setTimeout(() => {
			void api<SearchHit[]>(`/search?q=${encodeURIComponent(trimmed)}`)
				.then((hits) => {
					if (gone) return;
					setFound({ hits, for: trimmed });
					setSearching(false);
				})
				.catch(() => {
					if (gone) return;
					setFailed(true);
					setSearching(false);
				});
		}, 200);
		return () => {
			gone = true;
			clearTimeout(timer);
		};
	}, [trimmed, tries]);
	const hits = (found?.hits ?? []).map((hit, index) => {
		const when = "at" in hit ? new Date(hit.at).toLocaleDateString([], { day: "numeric", month: "short" }) : "Artifact";
		const who =
			hit.kind === "chat"
				? hit.by === "owner"
					? { chip: "you" as const, name: "You" }
					: whoOf(hit.agent)
				: hit.kind === "group"
					? hit.who === "owner"
						? { chip: "you" as const, name: `You in ${groupName(hit.room)}` }
						: { ...whoOf(hit.who), name: `${whoOf(hit.who).name} in ${groupName(hit.room)}` }
					: { chip: "artifact" as const, name: hit.title };
		return { id: String(index), who, when, ...around(hit.text, found?.for ?? trimmed) };
	});
	const close = () => onOpenChange(false);
	const pick = (value: string) => {
		const [kind = "", rest = ""] = value.split(/:(.*)/s);
		if (kind === "recent") {
			const row = rows.find((each) => each.id === rest);
			if (row === undefined) return;
			close();
			return onGo(row.to);
		}
		if (kind === "agent") {
			close();
			return onGo({ name: "agent", id: rest });
		}
		if (kind === "skill") {
			close();
			return onGo({ name: "skill", id: rest });
		}
		if (kind === "page") {
			close();
			return onGo({ name: rest as "skills" | "connections" | "settings" });
		}
		const hit = found?.hits[Number(rest)];
		if (hit === undefined) return;
		close();
		if (hit.kind === "chat") onGo({ name: "agent", id: hit.agent, at: hit.entry });
		else if (hit.kind === "group") onGo({ name: "group", room: hit.room, at: hit.entry });
		else onGo({ name: "artifact", id: hit.id });
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="top-[12vh] translate-y-0 border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-lg"
			>
				<DialogTitle className="sr-only">Search banda</DialogTitle>
				<Search
					query={query}
					onQuery={setQuery}
					recent={rows}
					agents={matchAgents(agents, trimmed)}
					skills={matchSkills(skills, trimmed)}
					pages={matchPages(trimmed)}
					hits={hits}
					searching={searching}
					stale={found !== undefined && found.for !== trimmed}
					onRetry={failed ? () => setTries((n) => n + 1) : undefined}
					onPick={pick}
					phone={phone}
					onCancel={close}
				/>
			</DialogContent>
		</Dialog>
	);
}
