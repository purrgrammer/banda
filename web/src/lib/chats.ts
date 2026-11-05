/**
 * The owner's chats as the app finds them (DESIGN.md "The app"): each agent's one chat, always the same. Pure, for the
 * tests.
 */
import { isMain, mainAgentOf } from "../../../src/core/gateway.ts";
import type { ChatRow } from "../../../src/server/api.ts";

/** The main chat, once its first message started it. */
export const mainOf = (rows: readonly ChatRow[]): ChatRow | undefined => rows.find((row) => isMain(row.origin));

/** One permanent agent's stable main chat, once its first message started it. */
export const agentMainOf = (rows: readonly ChatRow[], agent: string): ChatRow | undefined =>
	rows.find((row) => mainAgentOf(row.origin) === agent);
