/**
 * Search (DESIGN.md "The app": Cmd/Ctrl+K): one query over what was said in the agents' chats and the groups, and the
 * artifacts' titles and words. The index catches up before it answers, so what was just said is found. A hit names
 * where it opens: an agent's chat at an entry, a group at an entry, or an artifact. A group member's own execution
 * chat is never a hit: what it said is the group's.
 */
import { context } from "../../core/store.ts";
import type { SearchHit } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

export const search: AreaModule = {
	start: ({ retrieval }) => ({
		route: async ({ method, path, url }) => {
			if (path !== "/search" || method !== "GET") return undefined;
			const query = url.searchParams.get("q") ?? "";
			if (query.length > 200) throw new BadRequest("q is a few words");
			if (!query.trim()) return { body: [] };
			const found = await retrieval.page({ query, limit: 30 }, context);
			const hits: SearchHit[] = found.hits.flatMap((hit): SearchHit[] => {
				if (hit.kind === "message") {
					const agent = found.routes[hit.chat]?.agent;
					if (agent === undefined) return [];
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
			return { body: hits };
		},
	}),
};
