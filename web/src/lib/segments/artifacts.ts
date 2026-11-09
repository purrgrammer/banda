/**
 * Artifacts in a chat: a `message_user` call that published one as its card after the message, naming the version that
 * call made; and the owner's own version, told to the chat as their words, as a card on their side in place of the
 * words. Which version is which comes from the Library (`ViewContext.artifacts`) and the entry's own {id, n}, never
 * from anyone's words; a card whose artifact left the Library says so.
 */
import type { ArtifactKind, ArtifactView } from "../../../../src/server/api.ts";
import type { Segment } from "../chat.ts";
import type { FeedState } from "../feed.ts";
import type { Segmenter } from "./types.ts";

/** An artifact's card: the version a call published, or one the owner made, once the Library knows it. */
export type ArtifactSegment = {
	readonly kind: "artifact";
	readonly key: string;
	/** Who made it: the companion's card sits on its side, the owner's on theirs. */
	readonly by: "companion" | "owner";
	/** As the call named it, until the Library says. */
	readonly title: string;
	readonly change?: string;
	/** The artifact and version, once the Library holds them. */
	readonly id?: string;
	readonly n?: number;
	readonly artifactKind?: ArtifactKind;
	/** Its message was refused (the file could not be read): nothing was published. */
	readonly failed?: boolean;
	/** It was published, and the owner removed it from the Library since. */
	readonly removed?: boolean;
	/** Its call ended: what it published is in the Library, unless it was removed. */
	readonly ended?: boolean;
	readonly at?: number;
	/** The publishing call, which the Library finds the version by. */
	readonly call?: string;
	/** Shown again by a message, by its id: not published by it. */
	readonly shown?: boolean;
};

declare module "./types.ts" {
	interface AreaSegments {
		artifact: ArtifactSegment;
	}
	interface ViewContext {
		/** This chat's artifacts: the Library, and the chat the view is of. */
		readonly artifacts?: { readonly chat: number; readonly library: readonly ArtifactView[] };
	}
}

type Named = { path?: unknown; title?: unknown; change?: unknown };

const nameOf = (path: string) => (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "") || "Untitled";

/**
 * A document the companion published, as its feed line: by what the Library holds of that call's version, never the
 * call's title until the Library names it.
 */
export function artifactLine(segment: ArtifactSegment): { state: FeedState; text: string } {
	if (segment.failed === true) return { state: "refused", text: "Not published" };
	if (segment.removed === true) return { state: "removed", text: "A document, removed from the Library since" };
	if (segment.id === undefined) return { state: "working", text: "Publishing a document…" };
	if (segment.shown === true) return { state: "done", text: `${segment.title} · v${segment.n ?? 1}` };
	const version = segment.n === undefined || segment.n === 1 ? "" : ` · v${segment.n}`;
	return {
		state: "done",
		text: `${segment.n === undefined || segment.n === 1 ? "Published" : "Updated"}: ${segment.title}${version}`,
	};
}

export const artifacts: Segmenter = {
	message: (call, key, { result }) => {
		// artifacts a message showed again: each at the version its receipt names, once it was sent
		if (result?.error === false && result.receipt?.kind === "artifacts")
			return result.receipt.artifacts.map(({ id, n }) => ({
				kind: "artifact",
				key: `${key}:artifact:${id}`,
				by: "companion",
				title: "A document",
				id,
				n,
				shown: true,
				ended: true,
				...(result.at === undefined ? {} : { at: result.at }),
			}));
		const given = call.args.artifact as Named | undefined;
		if (typeof given !== "object" || given === null || typeof given.path !== "string") return [];
		const title = typeof given.title === "string" ? given.title : nameOf(given.path);
		return [
			{
				kind: "artifact",
				key: `${key}:artifact`,
				by: "companion",
				title,
				...(typeof given.change === "string" ? { change: given.change } : {}),
				call: call.id,
				...(result?.error === true ? { failed: true } : {}),
				...(result === undefined ? {} : { ended: true }),
				...(result?.at === undefined ? {} : { at: result.at }),
			},
		];
	},
	after: (segments, { items, context }) => {
		const known = context.artifacts;
		if (known === undefined) return segments;
		const published = new Map<string, { artifact: ArtifactView; n: number }>();
		for (const artifact of known.library)
			for (const [key, n] of Object.entries(artifact.published)) {
				const [chat, call] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
				if (Number(chat) === known.chat) published.set(call, { artifact, n });
			}
		const library = new Map(known.library.map((artifact) => [artifact.id, artifact]));
		// the owner's versions told to this chat, by their entry: its own {id, n}
		const told = new Map<string, { readonly id: string; readonly n: number }>();
		for (const item of items)
			if (item.role === "user" && item.artifact !== undefined) told.set(`${item.id}`, item.artifact);
		return segments.map((segment): Segment => {
			// shown again by id: its title and kind from the Library, the version as it was sent
			if (segment.kind === "artifact" && segment.shown === true && segment.id !== undefined) {
				const artifact = library.get(segment.id);
				if (artifact !== undefined) return { ...segment, title: artifact.title, artifactKind: artifact.kind };
				// removed from the Library since: no card to open, as for one it published
				const { id: _gone, ...rest } = segment;
				return { ...rest, removed: true };
			}
			if (segment.kind === "artifact" && segment.call !== undefined) {
				const found = published.get(segment.call);
				// published (its call ended) and not in the Library: removed from it since
				if (found === undefined)
					return segment.ended === true && segment.failed !== true ? { ...segment, removed: true } : segment;
				return {
					...segment,
					id: found.artifact.id,
					n: found.n,
					title: found.artifact.title,
					artifactKind: found.artifact.kind,
				};
			}
			// the owner's version, told to the chat as their words: their card
			// (the core's `owner`, or the tasks area's `owner-message`, whichever came before this pass)
			if (segment.kind === "owner" || segment.kind === "owner-message") {
				const version = told.get(segment.key);
				if (version === undefined) return segment;
				const artifact = library.get(version.id);
				const restored = artifact?.versions[version.n - 1]?.restored;
				return {
					kind: "artifact",
					key: segment.key,
					by: "owner",
					...(artifact === undefined
						? // removed from the Library since: what the chat showed of it, and that it is gone
							{ title: segment.text, removed: true }
						: { title: artifact.title, id: artifact.id, n: version.n, artifactKind: artifact.kind }),
					...(restored === undefined ? {} : { change: `restored v${restored}` }),
					...(segment.at === undefined ? {} : { at: segment.at }),
				};
			}
			return segment;
		});
	},
	shown: (segment) =>
		segment.kind !== "artifact"
			? undefined
			: segment.by === "companion"
				? [artifactLine(segment).text]
				: [segment.title, ...(segment.change === undefined ? [] : [segment.change])],
};
