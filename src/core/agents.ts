/**
 * Agents (DESIGN.md "Agents"): `agents/<name>.md` in the workspace, frontmatter and instructions. The box writes them,
 * so the daemon runs only the version the owner accepted: the store keeps each accepted file whole, bound to the hash
 * of the bytes the owner saw, and a chat starts from it. The lead, `sancho`, is accepted from the start, can
 * never be removed, and gets every tool. Any agent may be archived (`state: archived`) but the last active one, since
 * the app opens in a chat.
 */
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
	AgentDoc,
	type ConversationId,
	type DocumentReader,
	defineDoc,
	defineExtension,
	defineTask,
	type Harness,
	LiveDoc,
	type ModelRef,
	type Tx,
} from "@earendil-works/pi-durable";
import { type AvatarFace, readAvatarFace, writeAvatarFace } from "./avatar-face.ts";
import { DEFAULT_FACE, DEFAULT_NAME, DEFAULT_PERSONALITY, type StoredAvatarFace, withPersonality } from "./choices.ts";
import { Companion, nameLine } from "./companion.ts";
import { context } from "./store.ts";
import { DEFAULT_TIER, isTier, modelFor, TIERS, type Tier } from "./tiers.ts";
import {
	DIRECT_META_TOOLS,
	EVERY_AGENT,
	GROUP_TOOLS,
	groupToolsName,
	MESSAGE_GROUP,
	MESSAGE_USER,
	PROPOSE_AVATAR,
} from "./toolsets.ts";
import { hiddenError, nfc } from "./visible.ts";

/** The lead: every gateway's new chats run it unless the owner picks another. */
export const LEAD = "sancho";

/** An agent's name, which is its file's: lowercase words joined by `-`. */
export const AGENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** What an agent file may weigh. */
export const MAX_AGENT_BYTES = 64 * 1024;

export { EVERY_AGENT, TOOLSETS } from "./toolsets.ts";

/** An agent as its accepted file says. */
export type Agent = {
	/** Its stable identity: the file's name, never its visible name. */
	readonly id: string;
	/** What the owner calls it; changing this never changes references to it. */
	readonly name: string;
	/** Its face everywhere the owner sees it. */
	readonly face: AvatarFace;
	/** Whether it may work: an archived agent's chats take no input and its routines are paused. */
	readonly state: "active" | "archived";
	/** What another agent, or the owner picking one, reads to choose it. */
	readonly description: string;
	/** Its model, else the configured default. */
	readonly model?: ModelRef;
	/** How hard its new chats think, else the owner's current default. */
	readonly tier?: Tier;

	/** The tools its file names, besides those every agent gets (`EVERY_AGENT`); the lead gets every tool. */
	readonly tools: readonly string[];
	/** The connections whose tools it gets; the lead gets every connection's. */
	readonly connections?: readonly string[];
	/** The body: its instructions, a prompt section. */
	readonly instructions: string;
};

export const agentPath = (name: string) => `agents/${name}.md`;

export const shaOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** An accepted file: its text, the hash the owner accepted, and when. */
export type AcceptedFile = { sha: string; text: string; at: number };

/** The lead's file as the daemon first writes it: its personality the default, which the owner may change. */
export const LEAD_TEXT = withPersonality(
	`---
face: ${writeAvatarFace(DEFAULT_FACE)}
description: The lead. Talks with the owner, and does the work or hands it to the agent best placed for it.
---
You are the owner's lead agent. You work in your own computer, the box, and the owner reaches you from the web and from their phone.
`,
	DEFAULT_PERSONALITY,
);

/**
 * The workspace's "before" files as the owner accepted them, by their path in the workspace. The lead is accepted from
 * the start: the daemon wrote it.
 */
export const Accepted = defineDoc<{
	files: { [path: string]: AcceptedFile };
	/** By path: when the owner last took an accepted file out of effect (a removal accepted). */
	removed?: { [path: string]: number };
	/**
	 * Set once the daemon has written every accepted agent file into the box (`seed`): until then a file missing there
	 * is one the daemon has yet to write, never a removal the box proposes.
	 */
	seeded?: true;
}>({
	kind: "banda.accepted",
	version: 1,
	scope: "session",
	initial: () => ({ files: { [agentPath(LEAD)]: { sha: shaOf(LEAD_TEXT), text: LEAD_TEXT, at: 0 } } }),
	// changes are rare and whole files: each one a base
	checkpointWhen: () => true,
});

/**
 * In `tx`: the accepted file at `path` out of effect, and when, so a chat that made it can say it was removed since,
 * not that it never was.
 */
export async function unaccept(tx: Tx, path: string, at: number): Promise<void> {
	const doc = await tx.doc(Accepted);
	delete doc.files[path];
	doc.removed ??= {};
	doc.removed[path] = at;
}

/** A JSON-storable copy of an Agent: mutable arrays are the store representation of its readonly definition. */
export type EffectiveAgent = {
	id: string;
	name: string;
	face: StoredAvatarFace;
	state: "active" | "archived";
	description: string;
	model?: { provider: string; modelId: string };
	tier?: Tier;
	tools: string[];
	connections?: string[];
	instructions: string;
};

/** The accepted agent version currently effective in one chat, changed only at a safe model boundary. */
export const ChatAgent = defineDoc<{ agent?: EffectiveAgent }>({
	kind: "banda.chat-agent",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** Every execution chat and the agent it runs, regardless of whether it is routed or belongs to a group. */
export const AgentChats = defineDoc<{ chats: { [chat: string]: string } }>({
	kind: "banda.agent-chats",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** A model as an agent file names it: `provider/model`. */
function modelOf(value: string): ModelRef | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

const FIELDS = [
	"name",
	"face",
	"state",
	"description",
	"model",
	"tier",
	"tools",
	"connections",
	// read and ignored: a face's colour and skills are no longer an agent's, and a file may still say them
	"colour",
	"skills",
] as const;

/** A file's frontmatter as read: each key's value (a list as an array), the body after it, and what is wrong. */
export type Frontmatter = {
	readonly values: Map<string, string | string[]>;
	readonly body: string;
	readonly errors: string[];
	/** The value of `key` when it is one value; a list there is an error. */
	readonly one: (key: string) => string | undefined;
	/** The values of `key` when it is a list; one value there is an error. */
	readonly list: (key: string) => string[];
};

/**
 * A `---` frontmatter of `key: value` lines (a list as `[a, b]`, or as `- item` lines under its key) and the body
 * after it; keys outside `fields` are errors, each saying what to write instead. Undefined when there is none. Read as
 * NFC; a character nobody sees anywhere in the file is an error (`visible.ts`).
 */
export function frontmatter(raw: string, fields: readonly string[]): Frontmatter | undefined {
	const text = nfc(raw);
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (match === null) return undefined;
	const errors: string[] = [];
	const hidden = hiddenError(text, { lines: true });
	if (hidden !== undefined) errors.push(hidden);
	const values = new Map<string, string | string[]>();
	let list: string[] | undefined;
	for (const [n, raw] of (match[1] ?? "").split(/\r?\n/).entries()) {
		const line = raw.trimEnd();
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const item = /^\s+-\s*(.*)$/.exec(line);
		if (item !== null) {
			if (list === undefined) errors.push(`line ${n + 2}: a "- item" belongs under a key such as "tools:"`);
			else list.push(unquote(item[1] ?? ""));
			continue;
		}
		const field = /^([a-z][a-z_]*):\s*(.*)$/.exec(line);
		if (field === null) {
			errors.push(`line ${n + 2}: write "key: value"`);
			list = undefined;
			continue;
		}
		const [, key = "", value = ""] = field;
		list = undefined;
		if (!fields.includes(key)) errors.push(`"${key}" is not a field: use ${fields.join(", ")}`);
		if (values.has(key)) {
			errors.push(`"${key}" is given twice`);
			continue;
		}
		if (value === "") {
			list = [];
			values.set(key, list);
		} else if (!value.startsWith("[")) values.set(key, unquote(value));
		else if (!value.endsWith("]")) {
			errors.push(`"${key}": close the list with ]`);
			values.set(key, []);
		} else
			values.set(
				key,
				value
					.slice(1, -1)
					.split(",")
					.map((part) => unquote(part.trim()))
					.filter((part) => part !== ""),
			);
	}
	const one = (key: string) => {
		const value = values.get(key);
		if (Array.isArray(value)) errors.push(`"${key}" is one value, not a list`);
		return typeof value === "string" ? value : undefined;
	};
	const many = (key: string) => {
		const value = values.get(key);
		if (value === undefined) return [];
		if (typeof value === "string") {
			errors.push(`"${key}" is a list: write ${key}: [${value}]`);
			return [];
		}
		return value;
	};
	return { values, body: text.slice(match[0].length).trim(), errors, one, list: many };
}

/**
 * Parse an agent file: a `---` frontmatter of `key: value` lines (a list as `[a, b]`, or as `- item` lines under its
 * key), then the instructions. Every problem is reported, each saying what to write instead. `tools` are those there
 * are, and `known` says whether a model exists; unchecked when not given.
 */
export function parseAgent(
	id: string,
	text: string,
	{ tools: there, known }: { tools?: readonly string[]; known?: (model: ModelRef) => boolean } = {},
): { readonly agent: Agent } | { readonly errors: readonly string[] } {
	if (Buffer.byteLength(text) > MAX_AGENT_BYTES) return { errors: ["An agent file is at most 64 KB."] };
	const nameErrors: string[] = [];
	if (!AGENT_NAME.test(id))
		nameErrors.push(`"${id}" is not an agent name: use lowercase letters, digits and dashes, such as "researcher"`);
	const read = frontmatter(text, FIELDS);
	if (read === undefined)
		return { errors: [...nameErrors, "an agent file starts with its frontmatter between two --- lines"] };
	const { values, errors, one: text_, list: names } = read;
	errors.unshift(...nameErrors);
	const name = text_("name") ?? id;
	if (name === "") errors.push(`"name" is what the owner calls the agent: give it a name`);
	else if ([...name].length > 60) errors.push(`"name" is at most 60 characters`);
	const faceText = text_("face");
	const face =
		faceText === undefined ? { ok: true as const, face: structuredClone(DEFAULT_FACE) } : readAvatarFace(faceText);
	if (!face.ok) errors.push(...face.errors.map((error) => `"face": ${error}`));
	const stateText = text_("state") ?? "active";
	if (stateText !== "active" && stateText !== "archived")
		errors.push(`"state: ${stateText}" is not an agent's state: use active or archived`);
	const description = text_("description") ?? "";
	if (description === "") errors.push(`add a "description:", which is how the owner and other agents choose it`);
	const modelText = text_("model");
	const model = modelText === undefined ? undefined : modelOf(modelText);
	if (modelText !== undefined && model === undefined)
		errors.push(`"model: ${modelText}" is not a model: write provider/model, such as anthropic/claude-sonnet-5-5`);
	else if (model !== undefined && known !== undefined && !known(model))
		errors.push(`"model: ${modelText}" is not a model this daemon knows`);
	const tierText = text_("tier");
	if (tierText !== undefined && !isTier(tierText))
		errors.push(`"tier: ${tierText}" is how hard it thinks: use ${TIERS.join(", ")}`);
	if (id === LEAD && values.has("tools")) errors.push(`the lead gets every tool: drop "tools"`);
	// a tool the daemon no longer has is refused only in a file being checked
	const tools = [...new Set(names("tools"))];
	if (there !== undefined)
		for (const tool of tools)
			if (!there.includes(tool)) errors.push(`"${tool}" is not a tool: use ${there.join(", ")}`);
	if (id === LEAD && values.has("connections")) errors.push(`the lead gets every connection: drop "connections"`);
	const connections = names("connections");
	for (const connection of connections)
		if (!AGENT_NAME.test(connection)) errors.push(`"${connection}" is not a connection's name`);
	if (errors.length > 0) return { errors };
	return {
		agent: {
			id,
			name,
			face: face.ok ? face.face : structuredClone(DEFAULT_FACE),
			state: stateText === "archived" ? "archived" : "active",
			description,
			...(model === undefined ? {} : { model }),
			...(isTier(tierText) ? { tier: tierText } : {}),
			tools,
			...(connections.length === 0 ? {} : { connections }),
			instructions: read.body,
		},
	};
}

/** An agent as canonical file text. Its stable id stays in the file's name, never duplicated in its bytes. */
export function agentText(agent: Agent): string {
	const lines = [
		`name: ${agent.name}`,
		`face: ${writeAvatarFace(agent.face)}`,
		`state: ${agent.state}`,
		`description: ${agent.description}`,
	];
	if (agent.model !== undefined) lines.push(`model: ${agent.model.provider}/${agent.model.modelId}`);
	if (agent.tier !== undefined) lines.push(`tier: ${agent.tier}`);

	if (agent.id !== LEAD && agent.tools.length > 0) lines.push(`tools: [${agent.tools.join(", ")}]`);
	if (agent.id !== LEAD && (agent.connections?.length ?? 0) > 0)
		lines.push(`connections: [${agent.connections?.join(", ")}]`);
	return `---\n${lines.join("\n")}\n---\n${agent.instructions.trim()}\n`;
}

function unquote(value: string): string {
	const quoted = /^(["'])(.*)\1$/.exec(value);
	return quoted === null ? value : (quoted[2] ?? "");
}

/**
 * The tools an agent's chats get: those every agent gets (`EVERY_AGENT`, which a file listing them only repeats), then
 * those its file names (the lead: `all`), once each.
 */
export function toolsOf(agent: Pick<Agent, "id" | "tools">, all: readonly string[]): string[] {
	return [...new Set([...EVERY_AGENT, ...(agent.id === LEAD ? all : agent.tools)])];
}

/**
 * The tools a chat of `agent` is sent now, derived from what is in effect, never kept as the truth: another agent's are what
 * every agent gets, its file's and those of the connections it names (`connected`); the lead's, every tool installed
 * (`all`) but the connections' (`<connection>__<tool>`) it was given no account of, which only `connected` names; or
 * none to write when `all` is unknown, which leaves the harness offering whatever is installed.
 */
export function chatTools(
	agent: Pick<Agent, "id" | "tools">,
	all: readonly string[] | undefined,
	connected: readonly string[],
	group = false,
): string[] | undefined {
	const tools =
		agent.id !== LEAD
			? [...new Set([...toolsOf(agent, []), ...connected])]
			: all &&
				toolsOf(
					agent,
					all.filter((tool) => !tool.includes("__") || connected.includes(tool)),
				);
	if (tools === undefined) return undefined;
	// a group member's chat has the same base as its own, but the meta tools and the face
	const inGroupChat = (tool: string) =>
		tool !== PROPOSE_AVATAR && !DIRECT_META_TOOLS.includes(tool as (typeof DIRECT_META_TOOLS)[number]);
	// a group member speaks to its room, and nowhere else does an agent post to one
	const speaking = tools.filter(
		(tool) => tool !== MESSAGE_USER && tool !== MESSAGE_GROUP && (!group || inGroupChat(tool)),
	);
	return group ? [MESSAGE_GROUP, ...speaking] : [MESSAGE_USER, ...speaking];
}

/** Whether `chat`'s stored agent selects the group extensions: whether it is a group member's chat. */
function inGroup(state: { readonly extensions?: unknown }): boolean {
	const selected = state.extensions;
	const added = Array.isArray(selected) ? selected : (selected as { add?: unknown } | undefined)?.add;
	return Array.isArray(added) && added.includes(GROUP_TOOLS);
}

/**
 * In `tx`: make `chat` a group member's chat: it selects the group's extensions, and is offered `message_group` in
 * place of `message_user`. Its tools are written after, by `applyTools`.
 */
export async function asMember(tx: Tx, chat: ConversationId): Promise<void> {
	const state = await tx.doc(AgentDoc, chat);
	if (inGroup(state)) return;
	state.extensions = { add: [GROUP_TOOLS, groupToolsName(Number(chat))] };
	// the lead's chat may offer every tool installed: what speaks only in a direct chat is taken out by name
	state.modelTools = { remove: [MESSAGE_USER, PROPOSE_AVATAR] };
}

/**
 * Write `chat`'s tool list as `chatTools` says, when it differs. pi-durable reads the list from the chat's agent state
 * at every request, so it is a copy of what is derived: whoever changes what it derives from (a definition applied, the
 * daemon's tools installed at its start) writes it again, between runs.
 */
export async function applyTools(
	tx: Tx,
	chat: ConversationId,
	agent: Pick<Agent, "id" | "tools">,
	all: readonly string[] | undefined,
	connected: readonly string[],
): Promise<void> {
	const state = await tx.doc(AgentDoc, chat);
	const tools = chatTools(agent, all, connected, inGroup(state));
	if (tools === undefined) return;
	const was = state.tools;
	if (Array.isArray(was) && was.length === tools.length && was.every((tool, i) => tool === tools[i])) return;
	state.tools = tools;
}

/** The agent `name` as accepted, or undefined when there is none (or what was accepted no longer parses). */
export async function acceptedAgent(tx: Tx, name: string): Promise<Agent | undefined> {
	const file = (await tx.doc(Accepted)).files[agentPath(name)];
	if (file === undefined) return undefined;
	const parsed = parseAgent(name, file.text);
	return "agent" in parsed && parsed.agent.state === "active" ? parsed.agent : undefined;
}

/** Whether the accepted file at `file` says its agent is archived; a file that no longer parses says nothing. */
export function archivedFile(name: string, file: AcceptedFile | undefined): boolean {
	if (file === undefined) return false;
	const parsed = parseAgent(name, file.text);
	return "agent" in parsed && parsed.agent.state === "archived";
}

/** The agents whose accepted files say they are active, by id, sorted. */
export function activeAgents(files: { readonly [path: string]: AcceptedFile }): string[] {
	return Object.entries(files)
		.flatMap(([path, file]) => {
			const id = /^agents\/(.+)\.md$/.exec(path)?.[1];
			if (id === undefined) return [];
			const parsed = parseAgent(id, file.text);
			return "agent" in parsed && parsed.agent.state === "active" ? [id] : [];
		})
		.sort();
}

/** Whether agent `name` is archived, as its accepted file says. */
export async function isArchived(tx: Tx, name: string): Promise<boolean> {
	return archivedFile(name, (await tx.doc(Accepted)).files[agentPath(name)]);
}

/** What the owner calls agent `id`: the lead by the companion's name, any other by its accepted file's. Reads only. */
/** `agentWords` from a committed read, for a prompt section. */
export async function agentWordsIn(read: DocumentReader, id: string, ctx: Context): Promise<string> {
	if (id === LEAD) return (await read.snapshot(Companion, ctx))?.name ?? DEFAULT_NAME;
	const file = (await read.snapshot(Accepted, ctx))?.files[agentPath(id)];
	const parsed = file === undefined ? undefined : parseAgent(id, file.text);
	return parsed !== undefined && "agent" in parsed ? parsed.agent.name : id;
}

export async function agentWords(tx: Tx, id: string): Promise<string> {
	if (id === LEAD) return (await tx.doc(Companion)).name ?? DEFAULT_NAME;
	const file = (await tx.doc(Accepted)).files[agentPath(id)];
	const parsed = file === undefined ? undefined : parseAgent(id, file.text);
	return parsed !== undefined && "agent" in parsed ? parsed.agent.name : id;
}

/**
 * The agent a new chat runs when nobody picked one (a gateway's first message): the lead while it is active, else the
 * first active agent by id. Undefined when none is, which the last-active rule keeps from happening.
 */
export async function defaultAgent(tx: Tx): Promise<Agent | undefined> {
	const lead = await acceptedAgent(tx, LEAD);
	if (lead !== undefined) return lead;
	const [first] = activeAgents((await tx.doc(Accepted)).files);
	return first === undefined ? undefined : acceptedAgent(tx, first);
}

/**
 * The tier each chat runs on (DESIGN.md "The companion"): the owner's choice, which nothing derives. The model it
 * names is the chat's agent state, which `startAs` writes and a switch (`switchTier`) writes again between runs.
 * `custom`: the agent's file names its own model, which no tier changes. `inherited`: this is the default a chat
 * started with, not a tier the owner chose; an accepted agent change may replace it.
 */
export type ChatTierEntry = { tier: Tier; custom?: true; inherited?: true };

export const ChatTier = defineDoc<{ chats: { [chat: string]: ChatTierEntry } }>({
	kind: "banda.chat-tier",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** The model `tier` runs on now, as the companion's choice of models says; `fallback` is the configured model. */
export async function tierModel(tx: Tx, tier: Tier, fallback: ModelRef): Promise<ModelRef> {
	return { ...modelFor(tier, await tx.doc(Companion), fallback) };
}

/**
 * Start `chat` as `agent`: its model (else `tier`'s, else the companion's tier's; `model` is the configured one, which
 * a provider without presets runs on every tier), its tools and its instructions, fixed for the chat's life so its
 * prompt's prefix never changes; only a switch of tier changes its model, between runs. `tools` are every tool there
 * is, the lead's; without them the lead's are left to the harness, which offers whatever is installed; `connected` are
 * another agent's connections' tools. `cwd` is its working directory, relative to the workspace; unset, it works at the
 * workspace's root. `name` is the companion's: the lead's instructions start by saying it, and no other
 * agent's do.
 */
export async function startAs(
	tx: Tx,
	chat: ConversationId,
	agent: Agent,
	{
		model,
		tier,
		tools,
		cwd,
		name,
		connected = [],
	}: {
		model: ModelRef;
		tier?: Tier | undefined;
		tools?: readonly string[];
		cwd?: string;
		name?: string;
		connected?: readonly string[];
	},
): Promise<void> {
	const state = await tx.doc(AgentDoc, chat);
	if (cwd !== undefined) state.cwd = cwd;
	const chosen = tier ?? agent.tier ?? (await tx.doc(Companion)).tier ?? DEFAULT_TIER;
	state.model = { ...(agent.model ?? (await tierModel(tx, chosen, model))) };
	(await tx.doc(ChatTier)).chats[Number(chat)] = {
		tier: chosen,
		...(agent.model === undefined ? {} : { custom: true }),
		...(tier === undefined ? { inherited: true } : {}),
	};
	await applyTools(tx, chat, agent, tools, connected);
	const instructions = [agent.id === LEAD && name !== undefined ? nameLine(name) : "", agent.instructions]
		.filter((part) => part !== "")
		.join("\n\n");
	if (instructions === "") delete state.instructions;
	else state.instructions = instructions;
	(await tx.doc(ChatAgent, chat)).agent = copyAgent(agent);
	(await tx.doc(AgentChats)).chats[Number(chat)] = agent.id;
}

/**
 * Apply an accepted definition to an existing idle chat. Its own chosen tier stays its own; a model named by the
 * definition makes it custom, and removing that model puts it back on the chat's tier. The caller supplies the
 * connection tools as they stand at this boundary.
 */
export async function refreshAs(
	tx: Tx,
	chat: ConversationId,
	agent: Agent,
	{
		model,
		tools,
		name,
		connected = [],
	}: {
		model: ModelRef;
		tools?: readonly string[];
		name?: string;
		connected?: readonly string[];
	},
): Promise<void> {
	const state = await tx.doc(AgentDoc, chat);
	const tiers = await tx.doc(ChatTier);
	const entry = tiers.chats[Number(chat)] ?? {
		tier: agent.tier ?? (await tx.doc(Companion)).tier ?? DEFAULT_TIER,
		inherited: true,
	};
	tiers.chats[Number(chat)] = entry;
	if (entry.inherited === true) entry.tier = agent.tier ?? (await tx.doc(Companion)).tier ?? DEFAULT_TIER;
	if (agent.model === undefined) {
		delete entry.custom;
		state.model = await tierModel(tx, entry.tier, model);
	} else {
		entry.custom = true;
		state.model = { ...agent.model };
	}
	await applyTools(tx, chat, agent, tools, connected);
	const instructions = [agent.id === LEAD && name !== undefined ? nameLine(name) : "", agent.instructions]
		.filter((part) => part !== "")
		.join("\n\n");
	if (instructions === "") delete state.instructions;
	else state.instructions = instructions;
	(await tx.doc(ChatAgent, chat)).agent = copyAgent(agent);
}

export function copyAgent(agent: Agent): EffectiveAgent {
	return {
		id: agent.id,
		name: agent.name,
		face: structuredClone(agent.face),
		state: agent.state,
		description: agent.description,
		...(agent.model === undefined ? {} : { model: { ...agent.model } }),
		...(agent.tier === undefined ? {} : { tier: agent.tier }),
		tools: [...agent.tools],
		...(agent.connections === undefined ? {} : { connections: [...agent.connections] }),
		instructions: agent.instructions,
	};
}

/**
 * Write `chat`'s model as its tier says; a chat with a model of its own, or none,
 * keeps what it has. Only in a commit that sees the chat idle: a run asks for its model at every request.
 */
export async function applyTier(tx: Tx, chat: number, fallback: ModelRef): Promise<void> {
	const entry = (await tx.doc(ChatTier)).chats[chat];
	if (entry === undefined || entry.custom === true) return;
	(await tx.doc(AgentDoc, chat as ConversationId)).model = await tierModel(tx, entry.tier, fallback);
}

/** Why a chat's tier cannot change: it has none (a chat that never started), or runs the model its agent file names. */
export type TierRefused = { readonly refused: "unknown" | "custom" };

/**
 * Switching a chat's tier, the owner's choice from the chat's menu. The tier is stored at once; the model changes
 * between runs, never inside one, since a run asks the agent state for its model at every request: in the same commit
 * when the chat is idle, else by a background task that waits on the run and writes the model in the commit that sees
 * the chat idle, so the run that follows asks the new one. `model` is the configured model.
 */
export function defineTierSwitch(model: () => ModelRef) {
	const TierSwitch = defineTask<{ readonly chat: number }, { phase: "wait" }, null>({
		name: "banda.tier-switch",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const run = (await tx.doc(LiveDoc, task.input.chat as ConversationId)).run;
					// a run that follows another hands the chat on: wait for that one too
					if (run !== undefined)
						return { status: "waiting", on: [run.taskId], policy: "allSettled", checkpoint: { phase: "wait" } };
					await applyTier(tx, task.input.chat, model());
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		abort: (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted" } }), ctx),
	});

	/** Put `chat` on `tier`: now when it is idle, else once its run ends; or why not. */
	async function switchTier(
		harness: Harness,
		chat: number,
		tier: Tier,
		ctx: Context = context,
	): Promise<TierRefused | undefined> {
		return harness.commit(async (tx): Promise<TierRefused | undefined> => {
			const entry = (await tx.doc(ChatTier)).chats[chat];
			if (entry === undefined) return { refused: "unknown" };
			if (entry.custom === true) return { refused: "custom" };
			const same = entry.tier === tier;
			delete entry.inherited;
			if (same) return undefined;
			entry.tier = tier;
			if ((await tx.doc(LiveDoc, chat as ConversationId)).run === undefined) await applyTier(tx, chat, model());
			else
				await tx.createTask(
					TierSwitch,
					{ chat },
					{ ownership: { kind: "conversation" }, background: true, conversationId: chat as ConversationId },
				);
			return undefined;
		}, ctx);
	}

	/** Apply a new provider or model choice in the choice's commit. Busy chats keep their current run's model. */
	async function modelsChanged(tx: Tx): Promise<void> {
		for (const [id, entry] of Object.entries((await tx.doc(ChatTier)).chats)) {
			const chat = Number(id) as ConversationId;
			if (entry?.custom === true) continue;
			if ((await tx.doc(LiveDoc, chat)).run !== undefined) {
				await tx.createTask(
					TierSwitch,
					{ chat },
					{ ownership: { kind: "conversation" }, background: true, conversationId: chat },
				);
			} else await applyTier(tx, chat, model());
		}
	}

	return { extension: defineExtension({ name: "banda.tiers", tasks: [TierSwitch] }), switchTier, modelsChanged };
}
