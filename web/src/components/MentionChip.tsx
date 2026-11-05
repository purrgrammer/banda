/**
 * A mention of an agent in a message (DESIGN.md "Groups"): its face and name; a
 * tap opens the agent's page. `Markdown` draws one for each `[@Name](#/a/<id>)` link `linkMentions` wrote,
 * for the agents the `Mentionable` context names; any other `@` stays words.
 */

import { createContext, useContext } from "react";
import { Mention } from "../chat/Feed.tsx";
import type { ChatAgent } from "../lib/navigation.ts";

/** The agents a message may mention: a group's members. */
export const Mentionable = createContext<readonly ChatAgent[]>([]);

/** How a mention links: to its agent's page in the app. */
export const MENTION_LINK = "#/a/";

export function MentionChip({ agent }: { agent: ChatAgent }) {
	// one chip for a mention, however the message was written: the feed's
	return <Mention who={{ face: agent.face, name: agent.name, id: agent.id }} />;
}

/** The agent a link names, if it is a mention of one the context knows. */
export function useMentioned(href: string | undefined): ChatAgent | undefined {
	const agents = useContext(Mentionable);
	if (href === undefined || !href.startsWith(MENTION_LINK)) return undefined;
	const id = href.slice(MENTION_LINK.length);
	return agents.find((agent) => agent.id === id);
}
