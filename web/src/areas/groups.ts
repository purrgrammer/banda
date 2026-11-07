/**
 * Groups in the app (DESIGN.md "Groups"): the groups as the daemon last pushed them, and the owner's calls: make one,
 * post to it (asking the agents mentioned to work), read it, stop its work.
 */
import { api, type GroupLimitsView, type GroupRow, type GroupView, type PostedFile } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

declare module "../lib/shell.ts" {
	interface Shell {
		/** Every group, newest message first; undefined until the daemon said. */
		readonly groups?: readonly GroupRow[];
		/** The owner's limits on every group, from Settings. */
		readonly groupLimits?: GroupLimitsView;
	}
}

export const shell: ShellHandlers = {
	groups: (event) => ({ groups: event.groups, groupLimits: event.limits }),
};

/** Archive group `room`, or restore it. The group as it is after. */
export const archiveGroup = (room: number, archived: boolean) =>
	api<GroupView>(`/groups/${room}/archive`, { method: "POST", body: JSON.stringify({ archived }) });

/** Set some of the owner's limits on every group; all of them as they are after, or rejects with why. */
export const setGroupLimits = (limits: Partial<GroupLimitsView>) =>
	api<GroupLimitsView>("/groups/limits", { method: "PUT", body: JSON.stringify(limits) });

/** A new group of these agents; its room. */
export const createGroup = (members: readonly string[], name?: string) =>
	api<{ room: number }>("/groups", {
		method: "POST",
		body: JSON.stringify({ members, ...(name === undefined || name.trim() === "" ? {} : { name }) }),
	});

/** Group `room` and its whole log. */
export const groupOf = (room: number) => api<GroupView>(`/groups/${room}`);

/** The owner's message, once per `key`; the agents in `mentions` are asked to work. The group as it is after. */
export const postToGroup = (
	room: number,
	key: string,
	text: string,
	mentions: readonly string[],
	files: readonly PostedFile[] = [],
) =>
	api<GroupView>(`/groups/${room}/messages`, {
		method: "POST",
		body: JSON.stringify({ key, text, mentions, ...(files.length === 0 ? {} : { files }) }),
	});

/** Stop `agent`'s work in the group, or everyone's. The group as it is after. */
export const stopGroup = (room: number, agent?: string) =>
	api<GroupView>(`/groups/${room}/stop`, {
		method: "POST",
		body: JSON.stringify(agent === undefined ? {} : { agent }),
	});
