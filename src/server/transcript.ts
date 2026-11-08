/**
 * What the web reads (DESIGN.md "Clients"): chats from the routes, transcripts paged from the entries, live
 * events from pi-durable's agent event stream. All derived from the store; nothing here writes.
 */

import type { Context } from "@earendil-works/chord";
import {
	type AssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type Models,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	CompactionEntry,
	type ConversationId,
	type EntryId,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	type MessageChange,
	type SubmissionId,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { AgentBrowserView } from "../box/browsers.ts";
import { ActivityLog } from "../core/activity.ts";
import { Accepted, ChatTier } from "../core/agents.ts";
import { ARTIFACT_EDIT } from "../core/artifacts.ts";
import { EFFECT, type EffectRan } from "../core/ask.ts";
import type { Attachment } from "../core/blobs.ts";
import { ChatReads } from "../core/chat-reads.ts";
import { budgetPolicy } from "../core/compaction.ts";
import { Companion } from "../core/companion.ts";
import { Connected } from "../core/connections.ts";
import { AGENT_MESSAGE, HARNESS_ENDED } from "../core/foreign.ts";
import { type Origin, type Outbound, OWNER } from "../core/gateway.ts";
import { Permissions } from "../core/permissions.ts";
import { PROPOSAL_ENTRY, PROPOSAL_RESULT, type Proposal } from "../core/proposals.ts";
import { Control, Routines, TROUBLE, type TroubleData, WAKE, type WakeData } from "../core/routines.ts";
import { localTime } from "../core/schedule.ts";
import { openWaits, status } from "../core/status.ts";
import { context } from "../core/store.ts";
import { thinkingMs, thinkingTimes } from "../core/timing.ts";
import { isMessageTool, MESSAGE_GROUP, messageArgs } from "../core/toolsets.ts";
import { goesOn, Routes, type Unanswered, type Undelivered, unansweredText, undeliveredText } from "../core/turn.ts";
import { type Ask, WAIT, type WaitEnded } from "../core/wait.ts";
import type {
	AgentView,
	Block,
	CapabilitiesView,
	ChatContext,
	ChatPrompt,
	ChatRow,
	ComputerView,
	ControlView,
	Item,
	ItemPage,
	LiveEvent,
	MemoryView,
	Queued,
	Receipt,
	RunningTool,
	ShellEvent,
	ShownWait,
	ToolCall,
	ToolNote,
	TurnUsage,
} from "./api.ts";
import { companion } from "./companion.ts";
import { approvalLabel, doing } from "./doing.ts";
import { proposalView } from "./proposals.ts";
import type { Area } from "./routes/area.ts";
import { appendArgument } from "./stream-args.ts";

/** Entries scanned per step of a page; bookkeeping entries show nothing. */
const PAGE = 50;
/**
 * Messages (the owner's and the agent's words) a page back in time holds, scanning on past tool steps, which fold into
 * one line each run: a page of entries could otherwise be all steps and show next to nothing.
 */
const PAGE_MESSAGES = 10;
/** Entries a page scans at most, however few messages they hold. */
const PAGE_SCAN = 2000;

const textOf = (content: string | readonly { type: string; text?: string }[]) =>
	typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");

const blockOf = (block: AssistantMessage["content"][number]): Block =>
	block.type === "text"
		? { type: "text", text: block.text }
		: block.type === "thinking"
			? { type: "thinking", text: block.thinking }
			: { type: "tool", text: "", call: { id: block.id, name: block.name, args: block.arguments } };

/**
 * A result's text without the block pi-durable appends to tell the model its diagnostics, which show as notes of their
 * own: that block exactly, rebuilt from the entry's diagnostics, at the end. A `<harness>` tag anywhere else is the
 * tool's own output, which the owner sees as the model does.
 */
function withoutRemarks(text: string, diagnostics: readonly { severity?: unknown; message?: unknown }[]): string {
	if (diagnostics.length === 0) return text;
	const block = `<harness>\n${diagnostics.map((d) => `[${String(d.severity)}] ${String(d.message)}`).join("\n")}\n</harness>`;
	if (!text.endsWith(block)) return text;
	return text.slice(0, -block.length).replace(/\n$/, "");
}

/** The daemon's tools that name their subject in a receipt (`Receipt`), by the kind each names. */
const RECEIPTS: { readonly [tool: string]: Receipt["kind"] } = {
	remember: "fact",
	forget: "fact",
	schedule: "routine",
	propose_avatar: "avatar",
	message_user: "artifacts",
	message_group: "artifacts",
	skill: "skill",
};

/**
 * The receipt a successful call of one of the daemon's tools put in its result's details; none for any other tool, so
 * nothing a connection or the box returns can pose as one.
 */
export function receiptOf(tool: string, isError: boolean, details: unknown): Receipt | undefined {
	const kind = RECEIPTS[tool];
	if (kind === undefined || isError) return undefined;
	const receipt = (details as { receipt?: unknown } | undefined)?.receipt as Record<string, unknown> | undefined;
	if (typeof receipt !== "object" || receipt === null || receipt.kind !== kind) return undefined;
	if (
		kind === "avatar" &&
		Number.isSafeInteger(receipt.assistant) &&
		Number(receipt.assistant) > 0 &&
		Number.isSafeInteger(receipt.index) &&
		Number(receipt.index) >= 0 &&
		typeof receipt.definition === "object" &&
		receipt.definition !== null &&
		!Array.isArray(receipt.definition)
	)
		return {
			kind,
			assistant: receipt.assistant as number,
			index: receipt.index as number,
			definition: receipt.definition as Extract<Receipt, { kind: "avatar" }>["definition"],
		};
	if (
		kind === "skill" &&
		typeof receipt.name === "string" &&
		/^[0-9a-f]{64}$/.test(String(receipt.sha)) &&
		(receipt.by === "agent" || receipt.by === "owner") &&
		typeof receipt.description === "string" &&
		Array.isArray(receipt.files) &&
		receipt.files.every((path) => typeof path === "string")
	)
		return {
			kind,
			name: receipt.name,
			sha: receipt.sha as string,
			by: receipt.by,
			description: receipt.description,
			files: receipt.files as string[],
			...(typeof receipt.invocation === "object" &&
			receipt.invocation !== null &&
			typeof (receipt.invocation as { gateway?: unknown }).gateway === "string" &&
			typeof (receipt.invocation as { message?: unknown }).message === "string"
				? { invocation: receipt.invocation as { gateway: string; message: string } }
				: {}),
		};
	if (
		kind === "artifacts" &&
		Array.isArray(receipt.artifacts) &&
		receipt.artifacts.every(
			(shown) =>
				typeof shown === "object" &&
				shown !== null &&
				/^[0-9a-f]{16}$/.test(String((shown as { id?: unknown }).id)) &&
				Number.isSafeInteger((shown as { n?: unknown }).n) &&
				Number((shown as { n?: unknown }).n) > 0,
		)
	)
		return { kind, artifacts: (receipt.artifacts as { id: string; n: number }[]).map(({ id, n }) => ({ id, n })) };
	if (kind === "fact" && typeof receipt.id === "string" && typeof receipt.text === "string")
		return { kind, id: receipt.id, text: receipt.text };
	if (
		kind === "routine" &&
		typeof receipt.name === "string" &&
		typeof receipt.sha === "string" &&
		(receipt.change === "added" || receipt.change === "changed" || receipt.change === "same")
	)
		return { kind, name: receipt.name, sha: receipt.sha, change: receipt.change };
	return undefined;
}

/** The summary a compaction entry holds, without the frame pi-durable gives it for the model. */
function summaryOf(text: string): string {
	return /<summary>\n?([\s\S]*?)\n?<\/summary>\s*$/.exec(text)?.[1] ?? text;
}

export function turnUsage(usage: Usage | undefined): TurnUsage {
	return {
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		...(usage?.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
		cost: usage?.cost?.total ?? 0,
	};
}

export function itemOf(entry: EntryRecord): Item | undefined {
	const id = Number(entry.id);
	if (entry.kind === WAIT) {
		const ended = entry.data as unknown as WaitEnded;
		return {
			id,
			role: "wait",
			...ended,
			...(ended.ask.type === "approval"
				? { label: ended.ask.label ?? approvalLabel(ended.ask.tool, ended.ask.args) }
				: {}),
		};
	}
	if (entry.kind === EFFECT) {
		const ran = entry.data as unknown as EffectRan;
		return {
			id,
			role: "effect",
			label: ran.label ?? approvalLabel(ran.tool, undefined),
			permission: ran.permission,
			at: ran.at,
		};
	}
	if (entry.kind === PROPOSAL_RESULT) {
		const data = entry.data as { proposal?: unknown; state?: unknown } | undefined;
		if (typeof data?.proposal !== "string" || (data.state !== "accepted" && data.state !== "declined"))
			return undefined;
		return { id, role: "proposalResult", proposal: data.proposal, state: data.state };
	}
	if (entry.kind === PROPOSAL_ENTRY) {
		const proposal = proposalView(entry.data as unknown as Proposal);
		return proposal === undefined
			? { id, role: "notice", text: "Couldn't show this agent change: its recorded definition is invalid." }
			: { id, role: "proposal", proposal };
	}
	// a harness's end wakes its agent; the session's card already says how it ended
	if (entry.kind === HARNESS_ENDED) return undefined;
	if (entry.kind === AGENT_MESSAGE) {
		const data = entry.data as { from?: unknown; text?: unknown; at?: unknown } | undefined;
		if (typeof data?.from !== "string" || typeof data.text !== "string") return undefined;
		return {
			id,
			role: "agentMessage",
			from: data.from,
			text: data.text,
			...(typeof data.at === "number" ? { at: data.at } : {}),
		};
	}
	if (entry.kind === "banda.notice") {
		const data = entry.data as { undelivered?: Undelivered; unanswered?: Unanswered } | undefined;
		if (data?.unanswered !== undefined) return { id, role: "notice", text: unansweredText(data.unanswered) };
		return data?.undelivered === undefined
			? undefined
			: { id, role: "notice", text: undeliveredText(data.undelivered) };
	}
	const message: Message | undefined = entry.kind === "banda.skill-load" ? entry.model?.[1] : entry.model?.[0];
	if (entry.kind === CompactionEntry.kind) {
		const reason = (entry.data as { reason?: unknown } | undefined)?.reason;
		return {
			id,
			role: "compaction",
			reason: typeof reason === "string" ? reason : "threshold",
			summary: summaryOf(message === undefined ? "" : textOf(message.content as Parameters<typeof textOf>[0])),
			...(message === undefined ? {} : { at: message.timestamp }),
		};
	}
	// the daemon's words to a nudged run
	if (goesOn(entry.kind))
		return {
			id,
			role: "instruction",
			text: message ? textOf(message.content) : "",
			...(message ? { at: message.timestamp } : {}),
		};
	if (entry.kind === WAKE) {
		const data = entry.data as unknown as WakeData;
		return {
			id,
			role: "wake",
			routine: data.routine,
			text: data.description,
			...(data.owner === true ? { owner: true as const } : {}),
			...(message ? { at: message.timestamp } : {}),
		};
	}
	if (entry.kind === TROUBLE) {
		const data = entry.data as unknown as TroubleData;
		return { id, role: "notice", text: troubleText(data), routine: data, at: data.at };
	}
	if (message?.role === "user") {
		const data = entry.data as { origin?: Origin; message?: string; files?: Attachment[]; said?: string } | undefined;
		const images = typeof message.content === "string" ? 0 : message.content.filter((p) => p.type === "image").length;
		return {
			id,
			role: "user",
			// what the sender wrote: the model's text also names the attachments, which show as files
			text: data?.said ?? textOf(message.content),
			...(images === 0 ? {} : { images }),
			at: message.timestamp,
			...(data?.origin === undefined ? {} : { origin: data.origin }),
			...(data?.message === undefined ? {} : { message: data.message }),
			...(data?.files === undefined ? {} : { files: data.files }),
			...(entry.kind === ARTIFACT_EDIT
				? {
						artifact: { id: String((entry.data as { id?: unknown }).id), n: Number((entry.data as { n?: unknown }).n) },
					}
				: {}),
		};
	}
	if (message?.role === "assistant") {
		const thought = thinkingMs(message);
		const thinking = message.content
			.flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
			.join("\n\n");
		const error =
			message.stopReason === "error"
				? (message.errorMessage ?? "the model failed")
				: message.stopReason === "aborted"
					? "interrupted"
					: undefined;
		const calls = message.content.flatMap((block): ToolCall[] =>
			block.type === "toolCall" ? [{ id: block.id, name: block.name, args: block.arguments }] : [],
		);
		return {
			id,
			role: "assistant",
			stop: message.stopReason,
			text: textOf(message.content),
			...(thinking === "" ? {} : { thinking }),
			at: message.timestamp,
			...(thought === undefined ? {} : { thinkingMs: thought }),
			...(error === undefined ? {} : { error }),
			...(calls.length === 0 ? {} : { calls }),
			model: `${message.provider}/${message.model}`,
			usage: turnUsage(message.usage),
		};
	}
	if (message?.role === "toolResult") {
		const diagnostics = (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics;
		const notes = (Array.isArray(diagnostics) ? diagnostics : []).flatMap((d): ToolNote[] =>
			typeof d === "object" && d !== null && typeof d.message === "string"
				? [{ severity: d.severity ?? "info", code: typeof d.code === "string" ? d.code : "", text: d.message }]
				: [],
		);
		const patch = (message.details as { patch?: unknown } | undefined)?.patch;
		const images = message.content.filter((p) => p.type === "image").length;
		const receipt = receiptOf(message.toolName, message.isError, message.details);
		return {
			id,
			role: "tool",
			call: message.toolCallId,
			name: message.toolName,
			text: withoutRemarks(textOf(message.content), Array.isArray(diagnostics) ? diagnostics : []),
			error: message.isError,
			at: message.timestamp,
			...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
			...(notes.length === 0 ? {} : { notes }),
			...(typeof patch === "string" ? { patch } : {}),
			...(images === 0 ? {} : { images }),
			...(receipt === undefined ? {} : { receipt }),
		};
	}
	return undefined;
}

/** Every routed chat, most recently addressed first. */
export async function chats(harness: Harness, ctx: Context = context): Promise<ChatRow[]> {
	// the newest admission is the newest message, whichever route it came by
	const homes = (await harness.snapshot(Routes, ctx))?.chats ?? {};
	const latest = new Map(Object.entries(homes).map(([id, home]) => [Number(id), home.lastAdmit ?? 0]));
	const now = await status(harness, ctx);
	const tiers = (await harness.snapshot(ChatTier, ctx))?.chats ?? {};
	const reads = (await harness.snapshot(ChatReads, ctx))?.chats ?? {};
	const rows = await Promise.all(
		now.chats.map(async (row) => {
			const at = await lastSaid(harness, row.chat, ctx);
			const tier = tiers[row.chat];
			const wait = now.waits.find((open) => open.chat === row.chat);
			const last = await lastWords(
				harness,
				row.chat,
				ctx,
				wait === undefined ? undefined : { call: wait.call, words: askWords(wait.ask) },
			);
			return {
				...row,
				unread: await unread(harness, row.chat, reads[row.chat] ?? 0, ctx),
				read: reads[row.chat] ?? 0,
				...(last === undefined
					? {}
					: { excerpt: last.text, by: last.by, ...(last.at === undefined ? {} : { said: last.at }) }),
				...(wait === undefined ? {} : { ask: askWords(wait.ask) }),
				...(tier === undefined ? {} : { tier: tier.tier, ...(tier.custom === true ? { custom: true as const } : {}) }),
				title: await title(harness, row.chat, ctx),
				...(at === undefined ? {} : { at }),
			};
		}),
	);
	return rows.sort((a, b) => (latest.get(b.chat) ?? 0) - (latest.get(a.chat) ?? 0));
}

/** A routine's trouble in the daemon's words, as the raw transcript and a chat's excerpt say it. */
export function troubleText(data: TroubleData): string {
	const what = `Routine "${data.description}"`;
	if (data.trouble === "failed") return `${what} failed: ${data.why}`;
	if (data.trouble === "stalled") return `${what} skipped its ${localTime(data.due)} run: its last run is still going`;
	return `${what} paused: it ran ${data.runsADay} times today, the most it may`;
}

/** Count what reached the owner: speaking calls that show a reply and a routine's trouble, never the model's notes or tool results. */
async function unread(harness: Harness, id: number, after: number, ctx: Context): Promise<number> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	if (chat === undefined) return 0;
	const calls: ToolCall[] = [];
	const results = new Map<string, Extract<Item, { role: "tool" }>>();
	let troubles = 0;
	let cursor: Parameters<typeof chat.entries>[2];
	do {
		const page = await chat.entries({ minEntryId: (after + 1) as EntryId, order: "ascending" }, PAGE, cursor, ctx);
		for (const entry of page.items) {
			const item = itemOf(entry);
			if (item?.role === "notice" && item.routine !== undefined) troubles++;
			if (item?.role === "tool") results.set(item.call, item);
			if (item?.role === "assistant")
				calls.push(
					...(item.calls ?? [])
						.filter((call) => call.name !== MESSAGE_GROUP && isMessageTool(call.name))
						.map((call) => ({ ...call, args: messageArgs(call.name, call.args) })),
				);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	const replies = calls.filter((call) => {
		const args = call.args;
		const result = results.get(call.id);
		const words = (part: unknown) => typeof part === "string" && part.trim() !== "";
		const undelivered =
			result?.error === true && /^(Not sent|Not delivered|The message was cancelled)/.test(result.text);
		return (
			words(args.text) ||
			(Array.isArray(args.files) && args.files.some((path) => typeof path === "string")) ||
			args.view === "browser" ||
			(words(args.question) && !undelivered) ||
			(words(args.reaction) && result?.error !== true)
		);
	}).length;
	return replies + troubles;
}

/**
 * The newest thing that reached the owner in chat `id`, as the band's row shows it and orders by: the owner's own
 * message, an agent's message (its words, else its question, its files, its reaction, its browser), or the open ask
 * `ask` names by its call; one plain line, who it came from and when. A run's own steps never count: a row moves only
 * when something reaches the owner. Undefined before anything did.
 */
async function lastWords(
	harness: Harness,
	id: number,
	ctx: Context,
	ask?: { readonly call?: string | undefined; readonly words: string },
): Promise<{ text: string; by: "owner" | "agent"; at?: number } | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	const page = await chat?.entries({ order: "descending" }, 200, undefined, ctx);
	const line = (text: string) => plain(text).slice(0, 160);
	const name = (path: unknown) => (typeof path === "string" ? (path.split("/").at(-1) ?? path) : "");
	for (const entry of page?.items ?? []) {
		const item = itemOf(entry);
		// a routine in trouble reached the owner: its line is news, as a reply is
		if (item?.role === "notice" && item.routine !== undefined)
			return { text: line(item.text), by: "agent", ...(item.at === undefined ? {} : { at: item.at }) };
		// an approval the owner answered is the owner's newest act in the chat: it orders the row as a message does
		if (item?.role === "wait" && item.ask.type === "approval" && item.outcome === "answered")
			return {
				text: line(`${item.answer === "approve" ? "Approved" : "Declined"}: ${item.label ?? askWords(item.ask)}`),
				by: "owner",
				at: item.at,
			};
		if (item?.role === "user") {
			const files = (item.files ?? []).map((file) => file.name);
			const words = typeof item.text === "string" ? item.text.trim() : "";
			if (words !== "" || files.length > 0)
				return {
					text: words !== "" ? line(words) : `Sent ${files.join(", ")}`,
					by: "owner",
					...(item.at === undefined ? {} : { at: item.at }),
				};
			continue;
		}
		if (item?.role !== "assistant") continue;
		const at = item.at === undefined ? {} : { at: item.at };
		for (const call of [...(item.calls ?? [])].reverse()) {
			if (ask?.call !== undefined && call.id === ask.call) return { text: line(ask.words), by: "agent", ...at };
			if (call.name === MESSAGE_GROUP || !isMessageTool(call.name)) continue;
			const { text, question, files, reaction, view } = messageArgs(call.name, call.args);
			const words = [text, question].find((part) => typeof part === "string" && part.trim() !== "");
			if (typeof words === "string") return { text: line(words), by: "agent", ...at };
			if (Array.isArray(files) && files.length > 0)
				return { text: `Sent ${files.map(name).filter(Boolean).join(", ")}`, by: "agent", ...at };
			if (typeof reaction === "string" && reaction.trim() !== "")
				return { text: `Reacted ${reaction.trim()}`, by: "agent", ...at };
			if (view === "browser") return { text: "Shared what it sees in its browser", by: "agent", ...at };
		}
	}
	return undefined;
}

/** An open ask in a few words, for the row: the question, or what the approval would do. */
export function askWords(ask: Ask): string {
	const words = ask.type === "question" ? ask.question : (ask.label ?? ask.tool);
	return plain(words).slice(0, 120);
}

async function title(harness: Harness, id: number, ctx: Context): Promise<string> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	const page = await chat?.entries({ order: "ascending" }, 10, undefined, ctx);
	for (const entry of page?.items ?? []) {
		const item = itemOf(entry);
		if (item?.role === "user" || item?.role === "wake") return plain(item.text).slice(0, 120);
	}
	return `chat ${id}`;
}

/** When the chat's newest message was written, from its newest few entries; undefined when none says. */
async function lastSaid(harness: Harness, id: number, ctx: Context): Promise<number | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	const page = await chat?.entries({ order: "descending" }, 20, undefined, ctx);
	for (const entry of page?.items ?? []) {
		const at = entry.model?.[0]?.timestamp;
		if (typeof at === "number") return at;
	}
	return undefined;
}

/** A message's text as one plain line: markdown's markup dropped, for a title. */
export function plain(markdown: string): string {
	return (
		markdown
			.replace(/```[^\n]*\n?/g, "")
			.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/(\*\*|~~|`)(\S(?:.*?\S)?)\1/g, "$2")
			// single `*` or `_` emphasis only between non-word characters, so snake_case stays
			.replace(/(^|\W)(__|\*|_)(\S(?:.*?\S)?)\2(?=\W|$)/g, "$1$3")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** The `n`th image of a transcript item (an entry id), or undefined. */
/**
 * The `n`th file of the message `message_user` call `call` sent in chat `id`, as it was sent; undefined when
 * there is none.
 */
export async function messageFile(
	harness: Harness,
	id: number,
	call: string,
	n: number,
	ctx: Context = context,
): Promise<Attachment | undefined> {
	return harness.commit(async (tx) => {
		let cursor: Parameters<typeof tx.scanTasks>[2];
		do {
			const page = await tx.scanTasks({ kind: "banda.message", conversationId: id as ConversationId }, 100, cursor);
			const found = page.items.find((task) => (task.input as { call?: string }).call === call);
			if (found === undefined) {
				cursor = page.next;
				continue;
			}
			const file = (found.input as unknown as { out: Outbound }).out.files?.[n];
			// a file is known by its blob; anything else is not one this daemon can serve
			return typeof file?.sha === "string" && /^[0-9a-f]{64}$/.test(file.sha) ? file : undefined;
		} while (cursor !== undefined);
		return undefined;
	}, ctx);
}

/** One item of chat `id`'s transcript, by its entry id; undefined when there is none. */
export async function item(
	harness: Harness,
	id: number,
	entry: number,
	ctx: Context = context,
): Promise<Item | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	const page = await chat?.entries({ minEntryId: entry as EntryId, maxEntryId: entry as EntryId }, 1, undefined, ctx);
	const found = page?.items[0];
	return found === undefined ? undefined : itemOf(found);
}

export async function image(
	harness: Harness,
	id: number,
	item: number,
	n: number,
	ctx: Context = context,
): Promise<{ data: Buffer; mimeType: string } | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	const page = await chat?.entries({ minEntryId: item as EntryId, maxEntryId: item as EntryId }, 1, undefined, ctx);
	const content = page?.items[0]?.model?.[0]?.content;
	if (content === undefined || typeof content === "string") return undefined;
	const found = content.filter((part) => part.type === "image")[n];
	return found === undefined ? undefined : { data: Buffer.from(found.data, "base64"), mimeType: found.mimeType };
}

/**
 * Write the chat list, the agents and the companion to `write`, then again whenever the task graph, the routes,
 * the accepted files or the companion change, or `subscribe` says something else did (the agents folder), until `signal`
 * aborts. Changes in a burst are written once.
 */
/** What the shell stream pushes besides the chats and the companion. */
export type ShellSources = {
	readonly agents: () => Promise<AgentView[]>;
	readonly memory: () => Promise<MemoryView>;
	readonly control: () => Promise<ControlView>;
	/** The companion's computer as it is now. */
	readonly computer?: () => ComputerView;
	/** Its connections and the tools it made, with the changes waiting. */
	readonly capabilities?: () => Promise<CapabilitiesView>;
	/** Each agent's browser as it is now: open, whose, who holds it. */
	readonly browsers?: () => readonly AgentBrowserView[];
	/** The areas' own events and the docs they watch (`routes/area.ts`). */
	readonly areas?: readonly Area[];
};

export async function shell(
	harness: Harness,
	{ agents, control, memory, computer, capabilities, browsers, areas = [] }: ShellSources,
	subscribe: (listener: () => void) => () => void,
	write: (event: ShellEvent) => void,
	signal: AbortSignal,
	ctx: Context = context,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	let said = "";
	let known = "";
	let offered = "";
	let machine = "";
	let browsing = "";
	// each area event as last written, by its type: written again only when it changed
	const told = new Map<string, string>();
	const tell = async () => {
		const now = await companion(harness, ctx);
		// written when it changed, so a busy task graph does not repeat it
		if (JSON.stringify(now) !== said) {
			said = JSON.stringify(now);
			write({ type: "companion", companion: now });
		}
	};
	const push = async () => {
		timer = undefined;
		let rows: ChatRow[];
		try {
			rows = await chats(harness, ctx);
			write({ type: "chats", rows });
		} catch {
			// the store closed under the stream, which ends with it
			return;
		}
		if (computer !== undefined) {
			// written when it changed, like the companion
			const now = computer();
			if (JSON.stringify(now) !== machine) {
				machine = JSON.stringify(now);
				write({ type: "computer", computer: now });
			}
		}
		if (browsers !== undefined) {
			const now = browsers();
			if (JSON.stringify(now) !== browsing) {
				browsing = JSON.stringify(now);
				write({ type: "browsers", browsers: now });
			}
		}
		try {
			write({ type: "control", control: await control() });
			await tell();
		} catch {
			// the store closed under the stream, which ends with it
			return;
		}
		try {
			write({ type: "agents", agents: await agents() });
		} catch {
			// the box is not up; a later change tries again
		}
		try {
			const remembered = await memory();
			// written when it changed: reading the box's files is not, by itself, news
			if (JSON.stringify(remembered) !== known) {
				known = JSON.stringify(remembered);
				write({ type: "memory", memory: remembered });
			}
		} catch {
			// the store closed under the stream, which ends with it
		}
		for (const area of areas) {
			if (area.shell === undefined) continue;
			try {
				for (const event of await area.shell()) {
					const now = JSON.stringify(event);
					if (told.get(event.type) === now) continue;
					told.set(event.type, now);
					write(event);
				}
			} catch {
				// the store closed, or what the area reads is not up: a later change tries again
			}
		}
		if (capabilities === undefined) return;
		try {
			const usable = await capabilities();
			// written when it changed, like memory
			if (JSON.stringify(usable) !== offered) {
				offered = JSON.stringify(usable);
				write({ type: "capabilities", capabilities: usable });
			}
		} catch {
			// the box is not up, or the store closed: a later change tries again
		}
	};
	// pushes in flight, so the stream ends only after them: none writes into a response that ended
	const pushing = new Set<Promise<void>>();
	const pushed = () => {
		const running = push().finally(() => pushing.delete(running));
		pushing.add(running);
		return running;
	};
	const changed = async () => {
		timer ??= setTimeout(() => void pushed(), 100);
	};
	// watching before the first push, so a change while it reads is pushed after it
	const watches = [
		await harness.watchTaskGraph(ctx),
		await harness.watchDoc(Routes, ctx),
		await harness.watchDoc(ChatReads, ctx),
		await harness.watchDoc(Accepted, ctx),
		await harness.watchDoc(Companion, ctx),
		await harness.watchDoc(Routines, ctx),
		await harness.watchDoc(Control, ctx),
		await harness.watchDoc(ActivityLog, ctx),
		await harness.watchDoc(Permissions, ctx),
		await harness.watchDoc(Connected, ctx),
		...(await Promise.all(areas.flatMap((area) => area.watch ?? []).map((doc) => harness.watchDoc(doc, ctx)))),
	];
	for (const watch of watches) watch?.start(changed);
	const unsubscribe = subscribe(() => void changed());
	await pushed();
	try {
		await new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
			// a doc not made yet has no watch, and nothing to close
			void Promise.race(watches.flatMap((watch) => (watch === undefined ? [] : [watch.closed]))).then(() => resolve());
		});
	} finally {
		unsubscribe();
		clearTimeout(timer);
		for (const watch of watches) await watch?.stop();
		await Promise.all(pushing);
	}
}

export type PageQuery = {
	/** Items with an id above `after` (exclusive), oldest first; otherwise the newest, going back. */
	readonly after?: number;
	/** Items with an id below `before` (exclusive). */
	readonly before?: number;
	/** Items with an id up to `through` (inclusive). */
	readonly through?: number;
};

/** One page of a transcript, or undefined when there is no such chat. */
export async function items(
	harness: Harness,
	id: number,
	query: PageQuery,
	ctx: Context = context,
): Promise<ItemPage | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	if (chat === undefined) return undefined;
	const max = Math.min(query.before === undefined ? Infinity : query.before - 1, query.through ?? Infinity);
	const order = query.after === undefined ? "descending" : "ascending";
	const range = {
		order,
		...(query.after === undefined ? {} : { minEntryId: (query.after + 1) as EntryId }),
		...(max === Infinity ? {} : { maxEntryId: max as EntryId }),
	} as const;
	const found: Item[] = [];
	let messages = 0;
	let scanned = 0;
	let last: number | undefined;
	let cursor: Parameters<typeof chat.entries>[2];
	// forward (`after`, the live tail) one step; back in time, steps until the page holds enough to read
	do {
		const page = await chat.entries(range, PAGE, cursor, ctx);
		for (const entry of page.items) {
			last = Number(entry.id);
			const item = itemOf(entry);
			if (item === undefined) continue;
			found.push(item);
			if (item.role === "user" || (item.role === "assistant" && item.text.trim() !== "")) messages++;
		}
		scanned += page.items.length;
		cursor = page.next;
	} while (order === "descending" && cursor !== undefined && messages < PAGE_MESSAGES && scanned < PAGE_SCAN);
	return {
		items: order === "descending" ? found.reverse() : found,
		// the cursor would only continue this scan; the last id scanned bounds the next one just as well
		...(cursor === undefined || last === undefined ? {} : { next: last }),
	};
}

/**
 * How full chat `id`'s context is, against its budget; undefined when there is no such chat. Derived: the newest
 * answer's usage, the thresholds pi-durable acts on, and its live and usage docs.
 */
export async function chatContext(
	harness: Harness,
	id: number,
	models: Pick<Models, "getModel">,
	ctx: Context = context,
): Promise<ChatContext | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	if (chat === undefined) return undefined;
	const ref = (await chat.agent(ctx)).model;
	const window = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId)?.contextWindow;
	const view = await chat.context(ctx);
	let tokens: number | undefined;
	for (let i = view.entries.length - 1; i >= 0 && tokens === undefined; i--) {
		const message = view.entries[i]?.model?.[0];
		if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const u = message.usage;
		const total = u.input + u.cacheRead + u.cacheWrite + u.output;
		if (total > 0) tokens = total;
	}
	const live = await harness.snapshot(LiveDoc, id as ConversationId, ctx);
	const usage = await harness.snapshot(UsageDoc, id as ConversationId, ctx);
	const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}])
		for (const u of Object.values(bucket) as unknown as Usage[]) {
			spent.input += u.input;
			spent.output += u.output;
			spent.cacheRead += u.cacheRead;
			spent.cacheWrite += u.cacheWrite;
			spent.cost += u.cost?.total ?? 0;
		}
	const policy = window === undefined || window <= 0 ? undefined : budgetPolicy(window);
	const budget = policy === undefined || window === undefined ? undefined : window - policy.reserveTokens;
	return {
		...(ref === undefined ? {} : { model: `${ref.provider}/${ref.modelId}` }),
		...(window === undefined ? {} : { window }),
		...(tokens === undefined ? {} : { tokens }),
		...(budget === undefined || policy === undefined
			? {}
			: { budget, ...(policy.backgroundTokens > 0 ? { background: budget - policy.backgroundTokens } : {}) }),
		...(view.head?.kind === CompactionEntry.kind ? { since: Number(view.head.id) } : {}),
		compacting: (live?.compactions?.length ?? 0) > 0,
		...(live?.compactionFailure === undefined ? {} : { failure: live.compactionFailure.error }),
		spent,
	};
}

/**
 * The system prompt and tools chat `id`'s model is sent; undefined when there is no such chat. Read, never built: each
 * request's preparation (pi-durable) renders the agent's sections and tools into `pi.system` entries, and the request
 * sends the context they are part of, so replaying that context's system messages as pi-ai does gives what the
 * request selected by `at` sent (or the newest recorded context when omitted). Empty before a first request.
 */
export async function chatPrompt(
	harness: Harness,
	id: number,
	ctx: Context = context,
	at?: number,
): Promise<ChatPrompt | undefined> {
	const chat = await harness.conversation(id as ConversationId, ctx);
	if (chat === undefined) return undefined;
	if (at !== undefined) {
		const visible = await chat.entries({ minEntryId: at as EntryId, maxEntryId: at as EntryId }, 1, undefined, ctx);
		if (visible.items.length === 0) return undefined;
	}
	const { messages } = await chat.context(ctx, at === undefined ? undefined : { at: at as EntryId });
	return {
		system: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages).map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: JSON.parse(JSON.stringify(tool.parameters)) as ChatPrompt["tools"][number]["parameters"],
		})),
	};
}

/**
 * The owner's messages in chat `id`'s queue, oldest first: read from pi-durable's inbox, never kept. Only the owner's
 * (`banda.inbound` from the owner): others' and the daemon's own follow-ups are not theirs to see waiting.
 */
export async function queuedInputs(harness: Harness, id: number, ctx: Context = context): Promise<Queued[]> {
	const inbox = await harness.snapshot(InboxDoc, id as ConversationId, ctx);
	return (inbox?.items ?? []).flatMap((queued): Queued[] => {
		if (queued.mode === "write" || queued.entry?.kind !== "banda.inbound") return [];
		const data = queued.entry.data as
			| { origin?: Origin; message?: string; files?: Attachment[]; said?: string }
			| null
			| undefined;
		if (data?.origin?.peer !== OWNER) return [];
		const content = queued.content as string | readonly { type: string; text?: string }[];
		const images = typeof content === "string" ? 0 : content.filter((part) => part.type === "image").length;
		return [
			{
				id: String(queued.id),
				// what the owner wrote, as its entry will show it
				text: data.said ?? textOf(content),
				...(data.message === undefined ? {} : { message: data.message }),
				...(data.files === undefined ? {} : { files: data.files }),
				...(images === 0 ? {} : { images }),
			},
		];
	});
}

/**
 * Stream a chat's live events to `write` until `signal` aborts or the stream ends (the store closed). Resolves
 * with false when there is no such chat.
 */
export async function live(
	harness: Harness,
	id: number,
	write: (event: LiveEvent) => void,
	signal: AbortSignal,
	ctx: Context = context,
): Promise<boolean> {
	if ((await harness.conversation(id as ConversationId, ctx)) === undefined) return false;
	const stream = await watchEvents(harness, id as ConversationId, ctx);
	let partial: Block[] = [];
	// A thinking block's start: the daemon's stamp on the message when the stream carries it, else when it was seen.
	const started = (index: number, message?: AssistantMessage) =>
		(message === undefined ? undefined : thinkingTimes(message).get(index)?.start) ??
		partial[index]?.startedAt ??
		Date.now();
	// A thinking block ends when a later block begins.
	const opened = (index: number) => {
		const now = Date.now();
		partial = partial.map((b, i) =>
			i < index && b.type === "thinking" && b.endedAt === undefined ? { ...b, endedAt: now } : b,
		);
	};
	const fromMessage = (message: AssistantMessage) =>
		message.content.map((block, index): Block => {
			const b = blockOf(block);
			if (b.type !== "thinking") return b;
			// Ended: the daemon's stamp, else when this stream saw it end, else now if a later block has begun.
			const end =
				thinkingTimes(message).get(index)?.end ??
				partial[index]?.endedAt ??
				(index < message.content.length - 1 ? Date.now() : undefined);
			return { ...b, startedAt: started(index, message), ...(end === undefined ? {} : { endedAt: end }) };
		});
	const inputEntry = async (inputs: readonly SubmissionId[] | undefined) => {
		const first = inputs?.[0];
		if (first === undefined) return undefined;
		const handle = await harness.submission(first, ctx);
		const submission = await handle?.status(ctx);
		return submission?.entry === undefined ? undefined : Number(submission.entry);
	};
	const ready = async (snapshot: typeof stream.snapshot) => {
		const input = await inputEntry(snapshot.run?.inputs);
		const message = snapshot.generation?.message;
		partial = [];
		partial = message === undefined ? [] : fromMessage(message);
		// a model's call's arguments are in its answer, the newest assistant entry
		const answer = [...snapshot.entries].reverse().find((entry) => entry.model?.[0]?.role === "assistant")?.model?.[0];
		const argsOf = (call: string) =>
			answer?.role === "assistant"
				? answer.content.find((block) => block.type === "toolCall" && block.id === call)
				: undefined;
		const running = snapshot.tools.flatMap((slot): RunningTool[] => {
			if (slot.status === "done") return [];
			const block = argsOf(slot.callId);
			const label = block?.type === "toolCall" ? doing(slot.name, block.arguments) : doing(slot.name, undefined);
			return [
				{
					call: slot.callId,
					name: slot.name,
					output: slot.output ?? "",
					...((slot.droppedBytes ?? 0) > 0 ? { dropped: true } : {}),
					...(label === undefined ? {} : { doing: block === undefined ? "working" : label }),
				},
			];
		});
		write({
			type: "ready",
			tail: Number(snapshot.entries.at(-1)?.id ?? 0),
			busy: snapshot.run !== undefined,
			...(input === undefined ? {} : { input }),
			partial,
			running,
		});
	};
	const change = (c: MessageChange) => {
		if (c.type === "text_delta" || c.type === "thinking_delta") {
			const known = partial[c.contentIndex];
			if (known === undefined) {
				opened(c.contentIndex);
				partial[c.contentIndex] =
					c.type === "text_delta"
						? { type: "text", text: c.delta }
						: { type: "thinking", text: c.delta, startedAt: started(c.contentIndex) };
				write({ type: "start", partial });
			} else {
				partial[c.contentIndex] = { ...known, text: known.text + c.delta };
				write({ type: "delta", index: c.contentIndex, text: c.delta });
			}
		} else if (c.type === "toolcall_delta") {
			const known = partial[c.contentIndex];
			if (known?.call) {
				const args = appendArgument(known.call.args, c.path, c.delta) as ToolCall["args"];
				partial[c.contentIndex] = { ...known, call: { ...known.call, args } };
				write({ type: "start", partial });
			}
		} else if (c.type === "message") {
			partial = fromMessage(c.message);
			write({ type: "start", partial });
		} else if ("block" in c) {
			if (partial[c.contentIndex] === undefined) opened(c.contentIndex);
			const b = blockOf(c.block);
			partial[c.contentIndex] = b.type === "thinking" ? { ...b, startedAt: started(c.contentIndex) } : b;
			write({ type: "start", partial });
		}
	};
	await ready(stream.snapshot);
	// the open asks, from the task graph: written whole whenever they change
	let asked = "";
	const asks = async () => {
		try {
			const waits = (await openWaits(harness, id, ctx)).map(
				(wait): ShownWait =>
					wait.ask.type === "approval"
						? { ...wait, label: wait.ask.label ?? approvalLabel(wait.ask.tool, wait.ask.args) }
						: wait,
			);
			const now = JSON.stringify(waits);
			if (now === asked) return;
			asked = now;
			write({ type: "waits", waits });
		} catch {
			// the store closed under the stream, which ends with it
		}
	};
	let queued = Promise.resolve();
	const graph = await harness.watchTaskGraph(ctx);
	graph?.start(async () => {
		queued = queued.then(asks);
	});
	// the owner's messages waiting for the run, from the inbox: written whole whenever it changes, on a line of its own
	// so a slow read of the asks never holds it back
	let waiting = "";
	let inboxed = Promise.resolve();
	const inbox = async () => {
		try {
			const now = JSON.stringify(await queuedInputs(harness, id, ctx));
			if (now === waiting) return;
			waiting = now;
			write({ type: "queued", queued: JSON.parse(now) });
		} catch {
			// the store closed under the stream, which ends with it
		}
	};
	await asks();
	await inbox();
	stream.start(async (events) => {
		for (const event of events) {
			if (event.type === "snapshot") {
				await ready(event);
				// after a fresh `ready` the asks come again, whether or not they changed
				asked = "";
				waiting = "";
				queued = queued.then(asks);
				inboxed = inboxed.then(inbox);
			} else if (event.type === "inbox_update") inboxed = inboxed.then(inbox);
			else if (event.type === "run_start") {
				const input = await inputEntry(event.inputs);
				write({ type: "busy", busy: true, ...(input === undefined ? {} : { input }) });
			} else if (event.type === "run_end") write({ type: "busy", busy: false });
			else if (event.type === "tool_execution_start" && event.parentToolCallId === undefined) {
				const label = doing(event.toolName, event.args);
				write({
					type: "tool",
					call: event.toolCallId,
					name: event.toolName,
					...(label === undefined ? {} : { doing: label }),
				});
			} else if (event.type === "tool_execution_update" && event.parentToolCallId === undefined && event.output) {
				const o = event.output;
				write(
					"set" in o
						? { type: "output", call: event.toolCallId, set: o.set }
						: {
								type: "output",
								call: event.toolCallId,
								...(o.trimStart === undefined ? {} : { trim: o.trimStart }),
								...(o.append === undefined ? {} : { append: o.append }),
							},
				);
			} else if (event.type === "tool_execution_end" && event.parentToolCallId === undefined)
				write({ type: "toolEnd", call: event.toolCallId });
			else if (event.type === "message_start" && event.message.role === "assistant") {
				partial = [];
				partial = fromMessage(event.message);
				write({ type: "start", partial });
			} else if (event.type === "message_update") for (const c of event.changes) change(c);
			else if (event.type === "message_end" || event.type === "entry_appended") {
				const item = itemOf(event.entry);
				if (item !== undefined) write({ type: "entry", item });
			}
		}
	});
	const stop = () => void stream.stop();
	signal.addEventListener("abort", stop, { once: true });
	try {
		await stream.closed;
	} finally {
		signal.removeEventListener("abort", stop);
		await graph?.stop();
		// the asks being read when it stopped are written before the stream ends
		await queued;
		await inboxed;
	}
	return true;
}
