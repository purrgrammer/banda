/**
 * Groups (DESIGN.md "Groups"): the owner makes a group of agents, posts to it, and stops its members' work. A message
 * asks only the members it mentions to work; each answers in the room. The shell lists the groups and pushes them
 * whenever one changes.
 */
import {
	type ConversationId,
	type Harness,
	type TaskId,
	ToolTask,
	type ToolTaskInput,
	type Tx,
} from "@earendil-works/pi-durable";
import { type ArtifactKind, Artifacts, publishedBy } from "../../core/artifacts.ts";
import { type Attachment, safeName } from "../../core/blobs.ts";
import { GroupReads, readGroup } from "../../core/chat-reads.ts";
import { mimeOf } from "../../core/gateway.ts";
import { type GroupLine, type GroupMessage, Groups } from "../../core/groups.ts";
import { status } from "../../core/status.ts";
import { context } from "../../core/store.ts";
import type { defineCore } from "../../core/turn.ts";
import type { GroupAskView, GroupMessageView, GroupNoticeView, GroupRow, GroupView, ShownWait } from "../api.ts";
import { shownWait } from "../doing.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

type GroupsApi = ReturnType<typeof defineCore>["groups"];

/** The open asks of a room's members, each with the agent whose chat asks, oldest first. */
async function asksOf(
	executions: { readonly [agent: string]: number },
	waits: readonly ShownWait[],
): Promise<GroupAskView[]> {
	const agentOf = new Map(Object.entries(executions).map(([agent, chat]) => [chat, agent]));
	return waits.flatMap((wait) => {
		const agent = agentOf.get(wait.chat);
		return agent === undefined ? [] : [{ agent, wait }];
	});
}

/** Every open ask, as the app shows one. */
const openAsks = async (harness: Harness) => (await status(harness)).waits.map(shownWait);

/** Every group, newest message (else newest group) first. */
export async function groupRows(groups: GroupsApi, harness: Harness): Promise<GroupRow[]> {
	const rows: GroupRow[] = [];
	const waits = await openAsks(harness);
	const reads = (await harness.snapshot(GroupReads, context))?.rooms ?? {};
	for (const room of await groups.rooms(harness)) {
		const log = await groups.log(harness, room.room);
		const last = log.filter((line) => "message" in line).at(-1);
		const asks = await asksOf(room.executions, waits);
		const read = reads[room.room] ?? 0;
		rows.push({
			...room,
			read,
			unread: log.filter((line) => "message" in line && line.entry > read && "agent" in line.message.author).length,
			latest: log.at(-1)?.entry ?? 0,
			asking: asks.map(({ wait }) => wait.key),
			...(last === undefined || !("message" in last) ? {} : { last: messageView(last) }),
		});
	}
	return rows.sort((a, b) => (b.last?.at ?? b.at) - (a.last?.at ?? a.at));
}

function messageView({ entry, message }: { entry: number; message: GroupMessage }): GroupMessageView {
	return {
		entry,
		author: "owner" in message.author ? { owner: true } : { agent: message.author.agent },
		text: message.text,
		...(message.objects === undefined ? {} : { objects: [...message.objects] }),
		mentions: [...message.mentions],
		at: message.at ?? 0,
		...(message.files === undefined || message.files.length === 0
			? {}
			: { files: message.files.map(({ sha, name, mimeType, size }) => ({ sha, name, mimeType, size })) }),
		...(message.reaction === undefined ? {} : { reaction: { ...message.reaction } }),
	};
}

/** `sending` keys each published message by its durable task, not the provider's reusable call id. */
async function activityOf(harness: Harness, message: GroupMessage, chat: number): Promise<number | undefined> {
	if ("owner" in message.author) return undefined;
	const id = /^message:(\d+):/.exec(message.key)?.[1];
	if (id === undefined) return undefined;
	let task = await harness.getTask(Number(id) as TaskId, context);
	let first = true;
	while (task?.kind === ToolTask.definition.name && Number(task.conversationId) === chat) {
		const input = task.input as unknown as ToolTaskInput;
		if (first && message.call !== (input.kind === "model" ? input.callId : input.call.id)) return undefined;
		first = false;
		if (input.kind === "model") return Number(input.assistant);
		task = await harness.getTask(input.parent, context);
	}
	return undefined;
}

/** Loaded receipts, read from members' execution transcripts rather than inferred from an owner's request. */
async function loadedIn(tx: Tx, room: number, executions: Record<string, number>, log: readonly GroupLine[]) {
	const loaded = new Map<string, Set<string>>();
	const entries = new Map(log.flatMap((line) => ("message" in line ? [[line.message.key, line.entry] as const] : [])));
	for (const chat of Object.values(executions)) {
		const input = new Set<number>();
		const pending: { key: string; name: string }[] = [];
		let cursor: Parameters<Tx["scanEntries"]>[2];
		do {
			const page = await tx.scanEntries({ conversationId: chat as ConversationId, order: "ascending" }, 100, cursor);
			for (const entry of page.items) {
				if (entry.kind === "banda.group-input") {
					const data = entry.data as { room?: unknown; through?: unknown } | undefined;
					if (data?.room === room && typeof data.through === "number") input.add(data.through);
				}
				if (entry.kind !== "banda.skill-load") continue;
				const data = entry.data as { name?: unknown; group?: { room?: unknown; key?: unknown } } | undefined;
				if (data?.group?.room === room && typeof data.group.key === "string" && typeof data.name === "string")
					pending.push({ key: data.group.key, name: data.name });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		for (const { key, name } of pending) {
			if (!input.has(entries.get(key) ?? -1)) continue;
			const names = loaded.get(key) ?? new Set<string>();
			names.add(name);
			loaded.set(key, names);
		}
	}
	return loaded;
}

/** Group `room` and its whole log; a 404 when there is none. */
export async function groupView(groups: GroupsApi, harness: Harness, room: number): Promise<GroupView> {
	const row = (await groups.rooms(harness)).find((each) => each.room === room);
	if (row === undefined) throw new BadRequest("no such group", 404);
	const log = await groups.log(harness, room);
	// a member's message shows what its call published to the Library, found by its chat and that call
	const published = await harness.commit(async (tx) => {
		const found = new Map<number, { id: string; n: number; title: string; kind: ArtifactKind }>();
		const { artifacts } = await tx.doc(Artifacts);
		for (const line of log) {
			if (!("message" in line) || line.message.call === undefined || !("agent" in line.message.author)) continue;
			const chat = row.executions[line.message.author.agent];
			const at = chat === undefined ? undefined : await publishedBy(tx, chat, line.message.call);
			const artifact = at === undefined ? undefined : artifacts[at.id];
			if (at !== undefined && artifact !== undefined)
				found.set(line.entry, { ...at, title: artifact.title, kind: artifact.kind });
		}
		return found;
	}, context);
	const loaded = await harness.commit((tx) => loadedIn(tx, room, row.executions, log), context);
	const messages: GroupMessageView[] = [];
	for (const line of log) {
		if (!("message" in line)) continue;
		const artifact = published.get(line.entry);
		const chat = "agent" in line.message.author ? row.executions[line.message.author.agent] : undefined;
		const activity = chat === undefined ? undefined : await activityOf(harness, line.message, chat);
		messages.push({
			...messageView(line),
			...(loaded.has(line.message.key) ? { loaded: [...(loaded.get(line.message.key) ?? [])] } : {}),
			...(artifact === undefined ? {} : { artifact }),
			...(activity === undefined ? {} : { activity }),
		});
	}
	const notices: GroupNoticeView[] = log.flatMap((line) =>
		"notice" in line ? [{ entry: line.entry, ...line.notice }] : [],
	);
	const last = messages.at(-1);
	const asks = await asksOf(row.executions, await openAsks(harness));
	const read = (await harness.snapshot(GroupReads, context))?.rooms[room] ?? 0;
	return {
		...row,
		read,
		unread: messages.filter((message) => message.entry > read && "agent" in message.author).length,
		latest: log.at(-1)?.entry ?? 0,
		asking: asks.map(({ wait }) => wait.key),
		...(last === undefined ? {} : { last }),
		messages,
		notices,
		asks,
	};
}

/** The uploaded files a message names: up to ten `{sha, name}`; a refusal when malformed. */
function uploaded(value: unknown): { sha: string; name: string }[] {
	if (value === undefined) return [];
	const refused = new BadRequest("files are up to ten {sha, name} of uploaded blobs");
	if (!Array.isArray(value) || value.length > 10) throw refused;
	return value.map((file) => {
		const { sha, name } = (file ?? {}) as { sha?: unknown; name?: unknown };
		if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) throw refused;
		if (typeof name !== "string" || name === "" || name.length > 200) throw refused;
		return { sha, name };
	});
}

const names = (value: unknown, what: string): string[] => {
	if (!Array.isArray(value) || value.some((each) => typeof each !== "string"))
		throw new BadRequest(`${what} are agents' names`);
	return value as string[];
};

export const groups: AreaModule = {
	start: (deps) => {
		const { harness } = deps;
		const api = deps.core.groups;
		// the doc exists before anything watches it: a watch acquires only a doc that does
		const ready = harness.commit(async (tx) => {
			await tx.doc(Groups);
			await tx.doc(GroupReads);
		}, context);
		return {
			watch: [Groups, GroupReads],
			shell: async () => {
				await ready;
				return [{ type: "groups", groups: await groupRows(api, harness) }];
			},
			route: async ({ method, path, json }) => {
				if (path === "/groups" && method === "GET") return { body: await groupRows(api, harness) };
				if (path === "/groups" && method === "POST") {
					const { name, members } = await json();
					if (name !== undefined && typeof name !== "string") throw new BadRequest("name is a few words");
					const room = await api
						.create(harness, { members: names(members, "members"), ...(name === undefined ? {} : { name }) })
						.catch((error: unknown) => {
							throw new BadRequest((error as Error).message);
						});
					deps.changed();
					return { body: { room } };
				}
				const match = /^\/groups\/(\d{1,12})(?:\/(messages|stop|read))?$/.exec(path);
				if (match === null) return undefined;
				const room = Number(match[1]);
				const action = match[2];
				if (action === undefined && method === "GET") return { body: await groupView(api, harness, room) };
				if (action === undefined && method === "PUT") {
					const { name, add, remove } = await json();
					if (name !== undefined && typeof name !== "string") throw new BadRequest("name is a few words");
					await api
						.change(harness, room, {
							...(name === undefined ? {} : { name }),
							...(add === undefined ? {} : { add: names(add, "add") }),
							...(remove === undefined ? {} : { remove: names(remove, "remove") }),
						})
						.catch((error: unknown) => {
							throw new BadRequest((error as Error).message);
						});
					deps.changed();
					return { body: await groupView(api, harness, room) };
				}
				if (action === "read" && method === "POST") {
					const { through } = await json();
					if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0)
						throw new BadRequest("through is the newest entry read");
					await readGroup(harness, room, through);
					deps.changed();
					return { body: { read: true } };
				}
				if (action === "messages" && method === "POST") {
					const { key, text, mentions, files } = await json();
					if (typeof key !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(key))
						throw new BadRequest("key is the message's id");
					if (typeof text !== "string") throw new BadRequest("text is the message");
					const uploads = uploaded(files);
					// the blobs are checked and the message that holds them committed under one lock, so no sweep comes between
					const posted = await deps.blobs.exclusive(async () => {
						const attachments: Attachment[] = [];
						for (const { sha, name } of uploads) {
							const bytes = await deps.blobs.read(sha).catch(() => undefined);
							if (bytes === undefined) throw new BadRequest(`${name} is no longer uploaded: attach it again`);
							attachments.push({ sha, name: safeName(name), mimeType: mimeOf(name), size: bytes.length });
						}
						return api.post(harness, {
							key,
							room,
							text,
							mentions: mentions === undefined ? [] : names(mentions, "mentions"),
							...(attachments.length === 0 ? {} : { files: attachments }),
						});
					});
					if ("refused" in posted) throw new BadRequest(posted.refused);
					deps.changed();
					return { body: await groupView(api, harness, room) };
				}
				if (action === "stop" && method === "POST") {
					const { agent } = await json();
					if (agent !== undefined && typeof agent !== "string") throw new BadRequest("agent is an agent's name");
					if (!(await api.stop(harness, room, agent))) throw new BadRequest("no such group", 404);
					deps.changed();
					return { body: await groupView(api, harness, room) };
				}
				return undefined;
			},
		};
	},
};
