/**
 * Search (DESIGN.md "The app": Cmd/Ctrl+K): one query over what was said in the agents' chats and the groups, and the
 * artifacts' titles and words. The index catches up before it answers, so what was just said is found. A hit names
 * where it opens: an agent's chat at an entry, a group at an entry, or an artifact. A group member's own execution
 * chat is never a hit: what it said is the group's.
 */
import { Artifacts } from "../../core/artifacts.ts";
import type { ArtifactText } from "../../core/search.ts";
import { context } from "../../core/store.ts";
import { Routes } from "../../core/turn.ts";
import type { SearchHit } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

/** An artifact's words indexed at most: its title always, and this much of a text version. */
const MAX_TEXT = 200_000;
const TEXT_KINDS = new Set(["markdown", "text", "table", "page"]);

export const search: AreaModule = {
	start: (deps) => {
		const { harness, desk, blobs } = deps;
		const groups = deps.core.groups;
		const index = desk.search;

		/** Catch the index up with the chats, the groups' logs and the artifacts; answer the agent each chat runs. */
		async function catchUp() {
			await index.messages(harness, context);
			const executions = new Set<number>();
			for (const room of await groups.rooms(harness)) {
				for (const chat of Object.values(room.executions)) executions.add(chat);
				const log = await groups.log(harness, room.room);
				index.groupLines(
					room.room,
					log.map((line) =>
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
			const artifacts = (await harness.snapshot(Artifacts, context))?.artifacts ?? {};
			const texts: ArtifactText[] = [];
			for (const [id, artifact] of Object.entries(artifacts)) {
				const newest = artifact.versions.at(-1);
				if (newest === undefined) continue;
				let text = "";
				if (TEXT_KINDS.has(artifact.kind)) {
					const bytes = await blobs.read(newest.sha).catch(() => undefined);
					text = bytes === undefined ? "" : bytes.subarray(0, MAX_TEXT).toString("utf8");
				}
				texts.push({ id, title: artifact.title, sha: newest.sha, text });
			}
			index.artifacts(texts);
			const routes = (await harness.snapshot(Routes, context))?.chats ?? {};
			return { executions, agentOf: (chat: number) => routes[chat]?.agent };
		}

		return {
			route: async ({ method, path, url }) => {
				if (path !== "/search" || method !== "GET") return undefined;
				const query = url.searchParams.get("q") ?? "";
				if (query.length > 200) throw new BadRequest("q is a few words");
				const { executions, agentOf } = await catchUp();
				const hits: SearchHit[] = index
					.find(query, 40, ["message", "group", "artifact"])
					.flatMap((hit): SearchHit[] => {
						if (hit.kind === "message") {
							const agent = agentOf(hit.chat);
							if (executions.has(hit.chat) || agent === undefined) return [];
							return [
								{
									kind: "chat",
									chat: hit.chat,
									agent,
									entry: hit.entry,
									by: hit.who === "owner" ? "owner" : "agent",
									text: hit.text,
									at: hit.at,
								},
							];
						}
						if (hit.kind === "group")
							return [{ kind: "group", room: hit.room, entry: hit.entry, who: hit.who, text: hit.text, at: hit.at }];
						if (hit.kind === "artifact") return [{ kind: "artifact", id: hit.id, title: hit.title, text: hit.text }];
						return [];
					});
				return { body: hits.slice(0, 30) };
			},
		};
	},
};
