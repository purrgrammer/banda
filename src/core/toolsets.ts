/**
 * Toolsets (DESIGN.md "Agents"): labels for groups of tools, for the web to show and to give or take away a group at
 * once. Plain data with no dependencies, so the daemon and the web read the same lists. A tool that asks the owner to
 * accept something is `propose_<what>`; a tool that acts is a plain verb.
 */
export const TOOLSETS: { readonly [name: string]: readonly string[] } = {
	files: ["read", "write", "edit"],
	shell: ["bash"],
	skills: ["skill"],
	agents: ["message_agent", "read_agent_chat", "propose_agent", "propose_group", "propose_agent_change"],
	avatar: ["read_avatar_instructions"],
	requests: ["propose_send", "ask_hosts"],
	routines: ["schedule"],
	watches: ["watch"],
	memory: ["remember", "recall", "forget"],
	web: ["web_fetch"],
	browser: [
		"browser_snapshot",
		"browser_navigate",
		"browser_click",
		"browser_type",
		"browser_select",
		"browser_scroll",
		"browser_wait",
		"browser_screenshot",
		"browser_send",
		"browser_hand_over",
		"propose_key",
	],
};

/**
 * What an agent that runs commands may ask about what its proxy held: to send one request, or to be allowed hosts. Its
 * commands' writes are held whatever its file lists, so it gets both with `bash`.
 */
export const EGRESS_TOOLS = ["propose_send", "ask_hosts"] as const;

/** Every agent can keep a promise with routines and watches and maintain its scoped memory, whatever its file lists. */
export const ALWAYS_TOOLSETS = ["routines", "watches", "memory"] as const;

/** How an agent speaks to the owner, in its own chats. */
export const MESSAGE_USER = "message_user";
/** How a group member speaks, in its room: in its chat for the group, in place of `message_user`. */
export const MESSAGE_GROUP = "message_group";
/** Ask the owner something and wait for the answer: in a direct chat, or in the room of a member's group. */
export const ASK_USER = "ask_user";
/** One emoji on the owner's message the run answers. */
export const REACT = "react";
/** Put a file of the box in the owner's Library as its next version. */
export const PUBLISH = "publish";
/** Offer the owner a card that connects a service the agent has no account of. */
export const CONNECT = "connect";
/** Offer a generated face for the agent, which only the owner's card applies; direct chats only. */
export const PROPOSE_AVATAR = "propose_avatar";

/**
 * The acts toward the owner besides the words, which every chat gets whatever its file lists; `propose_avatar` only a
 * direct chat. Together with `message_user` and `message_group` they are the speaking tools.
 */
export const OWNER_ACTS = [ASK_USER, REACT, PUBLISH, CONNECT, PROPOSE_AVATAR] as const;
const SPEAKING: ReadonlySet<string> = new Set([MESSAGE_USER, MESSAGE_GROUP, ...OWNER_ACTS]);

/** Whether a call of `name` is a message: something the owner (or the room) is shown, not a step of the work. */
export const isMessageTool = (name: string): boolean => SPEAKING.has(name);

/** Whether a call of `name` speaks in the agent's own chat: every speaking tool but `message_group`. */
export const isOwnerMessage = (name: string): boolean => name !== MESSAGE_GROUP && SPEAKING.has(name);

/**
 * A speaking call's arguments as one message's parts (`text`, `files`, `question`, `reaction`, `artifact`, `connect`,
 * `avatar`, …), whichever speaking tool made it, so what reads a message reads them in one shape.
 */
export function messageArgs(name: string, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
	switch (name) {
		case PUBLISH:
			return { artifact: { path: args.path, title: args.title, change: args.change } };
		case CONNECT:
			return { connect: args.connection, ...(args.reason === undefined ? {} : { text: args.reason }) };
		case PROPOSE_AVATAR:
			return { avatar: args };
		default:
			return { ...args };
	}
}
/** Send a message to another agent's direct chat. */
export const MESSAGE_AGENT = "message_agent";
/** Read another agent's direct chat as untrusted, bounded data. */
export const READ_AGENT_CHAT = "read_agent_chat";
/** Owner-reviewed proposals, accepted before they change definitions. */
export const PROPOSE_AGENT = "propose_agent";
export const PROPOSE_GROUP = "propose_group";
export const PROPOSE_AGENT_CHANGE = "propose_agent_change";
/** Tools available only in direct agent chats, never a group's execution chat. */
export const DIRECT_META_TOOLS = [
	MESSAGE_AGENT,
	READ_AGENT_CHAT,
	PROPOSE_AGENT,
	PROPOSE_GROUP,
	PROPOSE_AGENT_CHANGE,
] as const;

/**
 * The extension every group member's chat selects besides its own (`groupToolsName`): `message_group`, its one way to
 * speak. Neither is in any other chat's selection (`store.ts` leaves them out of the default).
 */
export const GROUP_TOOLS = "banda.group";

/** The extension of group member chat `chat`: whom its `message_group` may ask, by name. */
export const groupToolsName = (chat: number) => `${GROUP_TOOLS}:${chat}`;

/** Whether extension `name` is a group's, which only its members' chats select. */
export const isGroupTools = (name: string) => name === GROUP_TOOLS || name.startsWith(`${GROUP_TOOLS}:`);

/** The tools every direct agent chat gets: speaking, meta tools, shipped avatar guidance and always-included toolsets. */
export const EVERY_AGENT: readonly string[] = [
	MESSAGE_USER,
	...OWNER_ACTS,
	"tool_search",
	MESSAGE_AGENT,
	READ_AGENT_CHAT,
	PROPOSE_AGENT,
	PROPOSE_GROUP,
	PROPOSE_AGENT_CHANGE,
	"read_avatar_instructions",
	"skill",
	"search",
	"read_search_result",
	...ALWAYS_TOOLSETS.flatMap((label) => TOOLSETS[label] ?? []),
];
