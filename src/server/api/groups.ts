/**
 * The API's shapes for groups (DESIGN.md "Groups"): a chat with several agents as equal participants, whose one log
 * is what they read. A message asks only the agents it mentions to work. Re-exported by `../api.ts`.
 */
import type { ShownWait } from "../api.ts";

/** Who wrote a group message: the owner, or a member agent by its id. */
export type GroupAuthorView = { readonly owner: true } | { readonly agent: string };

/** A message in a group's log: its entry, who wrote it, its words, and the agents it asked to work. */
export type GroupMessageView = {
	readonly entry: number;
	readonly author: GroupAuthorView;
	/** The model entry that issued this message's durable tool task, in the member's execution. */
	readonly activity?: number;
	readonly objects?: readonly string[];
	readonly text: string;
	readonly mentions: readonly string[];
	/** Skills actually loaded by a member for this owner's message, not just requested. */
	readonly loaded?: readonly string[];
	readonly at: number;
	/** What a member's message published to the Library: the artifact and its version, opened beside the room. */
	readonly artifact?: {
		readonly id: string;
		readonly n: number;
		readonly title: string;
		readonly kind: import("../../core/artifacts.ts").ArtifactKind;
	};
	/** A member's emoji on the owner's message at entry `on`: shown on that message; alone, the whole answer. */
	readonly reaction?: { readonly emoji: string; readonly on: number };
	/** The files it carries, each a blob fetched by its `sha`. */
	readonly files?: readonly {
		readonly sha: string;
		readonly name: string;
		readonly mimeType: string;
		readonly size: number;
	}[];
};

/**
 * A group, as the shell lists it: its name, its members (agent ids), the members working now, and its newest message,
 * whose entry changes whenever the log grows.
 */
export type GroupRow = {
	readonly room: number;
	readonly name: string;
	readonly members: readonly string[];
	readonly working: readonly string[];
	readonly at: number;
	/** The newest entry of its log, message or notice: it changes whenever the log grows. */
	readonly latest: number;
	readonly last?: GroupMessageView;
	/** Each member's own chat in the group, by agent: where its work runs, its browser tab among it. */
	readonly executions: { readonly [agent: string]: number };
	/** The asks its members wait on the owner for, by key: they change whenever one opens or ends. */
	readonly asking: readonly string[];
	/** The newest entry the owner read (`POST /api/groups/:room/read`), and the members' messages after it. */
	readonly read: number;
	readonly unread: number;
};

/** An ask a member waits on the owner for, answered in the room. */
export type GroupAskView = { readonly agent: string; readonly wait: ShownWait };

/**
 * What the daemon says in a group: an agent's run there ended without its answer (it failed, why, or was stopped); the
 * owner added or removed a member, or renamed it.
 */
export type GroupNoticeView = {
	readonly entry: number;
	readonly agent?: string;
	readonly at: number;
	readonly failed?: string;
	readonly stopped?: true;
	/** The owner asked it, and it posted nothing, even nudged. */
	readonly unanswered?: true;
	readonly added?: true;
	readonly removed?: true;
	readonly renamed?: string;
};

/** `GET /api/groups/:room`: the group and its whole log, oldest first: its messages, and the daemon's notices. */
export type GroupView = GroupRow & {
	readonly messages: readonly GroupMessageView[];
	readonly notices: readonly GroupNoticeView[];
	/** What its members ask the owner, open now: questions and approvals, oldest first. */
	readonly asks: readonly GroupAskView[];
};

/** `POST /api/groups`: a new group of these agents, named as given or after them. Answers `{ room }`. */
export type NewGroup = { readonly name?: string; readonly members: readonly string[] };

/**
 * `POST /api/groups/:room/messages`: the owner's message, once per `key` (the browser's id for it); `mentions` are
 * the members asked to work. Answers with the group.
 */
export type PostGroupMessage = {
	readonly key: string;
	readonly text: string;
	readonly mentions?: readonly string[];
	/** Uploaded blobs (`POST /api/blobs`), up to ten. */
	readonly files?: readonly { readonly sha: string; readonly name: string }[];
};

/** `PUT /api/groups/:room`: rename it, add members (active agents) or remove them. Answers with the group. */
export type ChangeGroup = {
	readonly name?: string;
	readonly add?: readonly string[];
	readonly remove?: readonly string[];
};

/** `POST /api/groups/:room/stop`: stop `agent`'s work in the group, or every member's. Answers with the group. */
export type StopGroup = { readonly agent?: string };

/** The groups, pushed on the shell stream whenever one changes: newest message first. */
export type GroupsShellEvent = { readonly type: "groups"; readonly groups: readonly GroupRow[] };
