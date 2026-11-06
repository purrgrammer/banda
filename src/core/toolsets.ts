/**
 * Toolsets (DESIGN.md "Agents"): labels for groups of tools, for the web to show and to give or take away a group at
 * once. Plain data with no dependencies, so the daemon and the web read the same lists. A tool that asks the owner to
 * accept something is `propose_<what>`; a tool that acts is a plain verb.
 */
export const TOOLSETS: { readonly [name: string]: readonly string[] } = {
	files: ["read", "write", "edit"],
	shell: ["bash", "propose_send", "ask_hosts"],
	routines: ["schedule"],
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

/** Every agent can keep a promise with routines and maintain its scoped memory, whatever its file lists. */
export const ALWAYS_TOOLSETS = ["routines", "memory"] as const;

/** How an agent speaks to the owner, in its own chats. */
export const MESSAGE_USER = "message_user";
/** How a group member speaks, in its room: in its chat for the group, in place of `message_user`. */
export const MESSAGE_GROUP = "message_group";
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
