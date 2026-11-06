/** Shared retrieval for Cmd+K and agents. Only owner-visible sources enter the result audience. */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { acceptedAgent } from "./agents.ts";
import { Artifacts } from "./artifacts.ts";
import type { BlobStore } from "./blobs.ts";
import { type defineGroups, Groups } from "./groups.ts";
import type { ArtifactText, Hit, Search } from "./search.ts";
import { sourceLink } from "./source-link.ts";
import { Routes } from "./turn.ts";

export const SEARCH_KINDS = ["message", "group", "artifact"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type SearchSource =
	| { kind: "message"; chat: number; entry: number }
	| { kind: "group"; room: number; entry: number }
	| { kind: "artifact"; id: string };
export type SearchArgs = { query: string; kinds?: SearchKind[]; limit?: number; cursor?: string };
const MAX_TEXT = 200_000;
const TEXT_KINDS = new Set(["markdown", "text", "table", "page"]);
const fingerprint = (query: string, kinds: readonly string[]) =>
	createHash("sha256")
		.update(JSON.stringify([query, kinds]))
		.digest("hex")
		.slice(0, 24);

export function searchService({
	index,
	harness,
	groups,
	blobs,
}: {
	index: Search;
	harness: () => Harness;
	groups: ReturnType<typeof defineGroups>;
	blobs: BlobStore;
}) {
	// Catch-up has awaits between reading a cursor and committing it. Serialize both callers of this service.
	let tail: Promise<unknown> = Promise.resolve();
	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const next = tail.then(work);
		tail = next.catch(() => {});
		return next;
	}
	async function catchUp(ctx: Context) {
		const store = harness();
		await index.messages(store, ctx);
		const executions = new Set(Object.keys((await store.snapshot(Groups, ctx))?.byExecution ?? {}).map(Number));
		const rooms = await groups.rooms(store, ctx);
		for (const room of rooms) {
			for (const chat of Object.values(room.executions)) executions.add(chat);
			index.groupLines(
				room.room,
				(await groups.log(store, room.room, ctx)).map((line) =>
					"message" in line
						? {
								entry: line.entry,
								who: "owner" in line.message.author ? "owner" : line.message.author.agent,
								text: line.message.text,
								at: line.message.at ?? 0,
							}
						: { entry: line.entry, who: "", text: "", at: 0 },
				),
			);
		}
		const artifacts = (await store.snapshot(Artifacts, ctx))?.artifacts ?? {};
		const texts: ArtifactText[] = [];
		for (const [id, artifact] of Object.entries(artifacts)) {
			const newest = artifact.versions.at(-1);
			if (newest === undefined) continue;
			let text = "";
			if (TEXT_KINDS.has(artifact.kind)) {
				// Missing bytes are a retrieval failure, not a successful empty search.
				text = (await blobs.read(newest.sha)).subarray(0, MAX_TEXT).toString("utf8");
			}
			texts.push({ id, title: artifact.title, sha: newest.sha, text });
		}
		index.artifacts(texts);
		const routes = (await store.snapshot(Routes, ctx))?.chats ?? {};
		const chats = Object.keys(routes)
			.map(Number)
			.filter((chat) => !executions.has(chat));
		return {
			routes,
			rooms,
			texts,
			audience: { paths: [], chats, rooms: rooms.map((room) => room.room), artifacts: true },
		};
	}
	async function page(args: SearchArgs, ctx: Context) {
		const kinds = [...new Set(args.kinds ?? SEARCH_KINDS)].sort();
		const limit = args.limit ?? 10;
		if (!args.query.trim() || args.query.length > 200) throw new Error("query must contain 1–200 characters");
		if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("limit must be 1–30");
		if (kinds.some((kind) => !SEARCH_KINDS.includes(kind))) throw new Error("unknown search kind");
		const key = fingerprint(args.query, kinds);
		let offset = 0;
		if (args.cursor !== undefined) {
			const match = /^([a-f0-9]{24}):(\d{1,8})$/.exec(args.cursor);
			if (!match || match[1] !== key) throw new Error("cursor belongs to a different search; start again");
			offset = Number(match[2]);
		}
		const state = await catchUp(ctx);
		const hits = index.find(args.query, limit + 1, kinds, state.audience, { offset, excerpts: true });
		return {
			...state,
			hits: hits.slice(0, limit).map((hit) =>
				hit.kind === "fact"
					? hit
					: {
							...hit,
							text: hit.text.length > 800 ? `${hit.text.slice(0, 800)}…` : hit.text,
						},
			),
			...(hits.length > limit ? { nextCursor: `${key}:${offset + limit}` } : {}),
		};
	}
	function result(hit: Hit, state: Awaited<ReturnType<typeof catchUp>>) {
		if (hit.kind === "fact") throw new Error("memory is not a search source");
		const source: SearchSource =
			hit.kind === "artifact"
				? { kind: hit.kind, id: hit.id }
				: hit.kind === "group"
					? { kind: hit.kind, room: hit.room, entry: hit.entry }
					: { kind: hit.kind, chat: hit.chat, entry: hit.entry };
		const agent = hit.kind === "message" ? state.routes[hit.chat]?.agent : undefined;
		const title =
			hit.kind === "artifact"
				? hit.title
				: hit.kind === "group"
					? (state.rooms.find((room) => room.room === hit.room)?.name ?? "Group")
					: `Chat with ${agent}`;
		const href =
			hit.kind === "artifact"
				? `#/artifact/${hit.id}`
				: hit.kind === "group"
					? `#/g/${hit.room}?at=${hit.entry}`
					: `#/a/${agent}?at=${hit.entry}`;
		return {
			kind: hit.kind,
			title: title.slice(0, 200),
			excerpt: hit.text,
			source,
			href,
			...(hit.kind === "artifact"
				? {}
				: {
						at: hit.at,
						who: hit.kind === "message" && hit.who === "companion" ? agent : hit.who,
					}),
		};
	}
	return {
		label: (href: string, ctx: Context) =>
			exclusive(async () => {
				const target = sourceLink(href);
				if (!target) return undefined;
				const state = await catchUp(ctx);
				let label: string | undefined;
				if (target.kind === "artifact") {
					label = state.texts.find((item) => item.id === target.id)?.title;
				} else {
					const id =
						target.kind === "group"
							? target.room
							: state.audience.chats.find((chat) => state.routes[chat]?.agent === target.agent);
					if (id === undefined || !(target.kind === "group" ? state.audience.rooms : state.audience.chats).includes(id))
						return undefined;
					if (target.entry !== undefined) {
						label = index.context(target.kind, id, target.entry).find((line) => line.entry === target.entry)?.text;
					} else if (target.kind === "group") {
						label = state.rooms.find((room) => room.room === id)?.name;
					} else {
						label = (await harness().commit((tx) => acceptedAgent(tx, target.agent), ctx))?.name ?? target.agent;
					}
				}
				if (!label?.trim()) return undefined;
				label = label.replace(/\s+/g, " ").trim();
				return { kind: target.kind, label: label.length > 100 ? `${label.slice(0, 100)}…` : label };
			}),
		page: (args: SearchArgs, ctx: Context) => exclusive(() => page(args, ctx)),
		search: (args: SearchArgs, ctx: Context) =>
			exclusive(async () => {
				const found = await page(args, ctx);
				return {
					results: found.hits.map((hit) => result(hit, found)),
					...(found.nextCursor === undefined ? {} : { nextCursor: found.nextCursor }),
				};
			}),
		read: (source: SearchSource, offset: number, ctx: Context) =>
			exclusive(async () => {
				if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
				const state = await catchUp(ctx);
				let text: string;
				if (source.kind === "artifact") {
					const artifact = state.texts.find((item) => item.id === source.id);
					if (!artifact) throw new Error("artifact is no longer available");
					text = `${artifact.title}\n${artifact.text}`;
				} else {
					const id = source.kind === "message" ? source.chat : source.room;
					const allowed = source.kind === "message" ? state.audience.chats : state.audience.rooms;
					if (!allowed.includes(id)) throw new Error("source is not a visible chat or group");
					const lines = index.context(source.kind, id, source.entry);
					if (!lines.length) throw new Error("message is no longer available");
					text = lines
						.map((line) => {
							const who =
								source.kind === "message" && line.who === "companion"
									? (state.routes[source.chat]?.agent ?? "agent")
									: line.who;
							return `[${line.entry}] ${who}: ${line.text}`;
						})
						.join("\n\n");
				}
				return {
					source,
					text: text.slice(offset, offset + 12_000),
					...(text.length > offset + 12_000 ? { nextOffset: offset + 12_000 } : {}),
					coverage:
						"Visible message context; artifacts include titles and at most the first 200 KB of the latest text version.",
				};
			}),
	};
}
