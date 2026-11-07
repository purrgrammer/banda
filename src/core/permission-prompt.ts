/**
 * What an agent knows of its own trust (DESIGN.md "Permissions"): how it asks, and what it may do without asking and
 * until when, in the daemon's words. A prompt section, rendered before each request like the status line (`now.ts`), so
 * a grant or a revocation reaches the agent at its next model boundary as a small system entry, the cached prefix kept.
 * Its words hold no time of their own, so a chat gains an entry only when what it may do changed. It never lists
 * another agent's permissions, nor one for a task (the effect's result says that one); knowing one widens nothing.
 */
import { defineExtension, type PromptSection } from "@earendil-works/pi-durable";
import { AgentChats } from "./agents.ts";
import { isOpen, type Permission, Permissions, permissionTo, permissionWhen } from "./permissions.ts";

export const ASKING_WORDS =
	"How you ask: reads run when you call them. Anything that changes something outside your computer (a " +
	"connection's write, a request your computer's proxy holds) is proposed: the owner sees exactly that on a card, " +
	"and it runs once they approve it. Proposing is how you ask the owner, never a way around them, so a write being " +
	"held is no reason to refuse it: propose it. Moving money, touching a password or a key, changing an account, and " +
	"sending private data to someone the owner has not approved ask every time, whatever you were allowed.";

/** The section for an agent with `permissions` (all of them, every agent's) at `now`; no agent, the asking alone. */
export function permissionsLines(
	permissions: { readonly [id: string]: Permission },
	now: number,
	agent: string | undefined,
): string {
	if (agent === undefined) return ASKING_WORDS;
	const own = Object.entries(permissions)
		.filter(([, permission]) => permission.agent === agent && permission.scope !== "task" && isOpen(permission, now))
		.sort(([a], [b]) => Number(a) - Number(b))
		.map(([, permission]) => `- ${permissionTo(permission)}, ${permissionWhen(permission)}`);
	const allowed =
		own.length === 0
			? "You have no permissions: everything outside your computer asks."
			: `The owner allowed you to do these without asking:\n${own.join("\n")}`;
	return `${ASKING_WORDS}\n${allowed}`;
}

export const permissionsSection = (clock: () => number = Date.now): PromptSection => ({
	key: "permissions",
	render: async ({ conversationId, read }, ctx) => {
		const agent = (await read.snapshot(AgentChats, ctx))?.chats[conversationId];
		const permissions = agent === undefined ? {} : ((await read.snapshot(Permissions, ctx))?.permissions ?? {});
		return permissionsLines(permissions, clock(), agent);
	},
});

export const permissionsExtension = (clock: () => number = Date.now) =>
	defineExtension({ name: "banda.permissions-prompt", sections: [permissionsSection(clock)] });
