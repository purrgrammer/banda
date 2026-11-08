/**
 * Wait (DESIGN.md "Core", "Flows"): a task a tool call blocks on, with an answer slot someone outside fills. The slot
 * is a document of the Wait's own; whoever answers writes it in one commit, after the checks of law 1: the sender is
 * one the Wait's `who` admits, on a gateway strong enough to carry them, and nobody answered first. The deadline is
 * decided in the commit that reads the slot, so an answer and an expiry never both win.
 */
import { randomInt } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	defineTask,
	type Harness,
	type JsonObject,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { type Origin, OWNER, type Strength } from "./gateway.ts";
import {
	agentOfChat,
	countAnswer,
	countRan,
	covering,
	type Errand,
	errandOf,
	type Floor,
	floorNow,
	give,
	isOpen,
	matches,
	type OfferedScope,
	offeredScopes,
	type Permission,
	type PermissionScope,
	type PermissionShape,
	type PlaceShape,
	refusal,
	shapeFor,
	storedScope,
} from "./permissions.ts";
import { context } from "./store.ts";

/** One value a question's form asks for. */
export type Field = {
	readonly name: string;
	/** Default `text`. `choice` picks one of `options`. */
	readonly type?: "text" | "number" | "boolean" | "choice";
	readonly options?: readonly string[];
	/** Default required. */
	readonly optional?: boolean;
	/** A line under the field saying what it wants. */
	readonly hint?: string;
};

/** What a Wait shows whoever may fill it: a question (with options to pick, or fields to fill), or an approval. */
export type Ask =
	| {
			readonly type: "question";
			readonly question: string;
			/** Suggested answers, shown as buttons; an answer in other words is still an answer. */
			readonly options?: readonly string[];
			/** Any number of the options may be picked together. */
			readonly multiple?: boolean;
			/** A form: the values to fill. */
			readonly fields?: readonly Field[];
			/**
			 * The browser handed to the owner: to sign in to `site` (their session then stays in the browser's profile), or
			 * to do something only they can (a passkey, a CAPTCHA). Answered when they give the browser back. `taken`: not
			 * asked for, but the owner took the browser while the agent's call needed it, which waits for it back.
			 */
			readonly handOver?: { readonly site: string; readonly signIn: boolean; readonly taken?: boolean };
	  }
	| {
			readonly type: "approval";
			readonly tool: string;
			/** The draft: the exact arguments the effect runs with, once approved, stored whole. */
			readonly args: JsonObject;
			/** What it would do, in the daemon's words (the tool's own code), never the model's. */
			readonly label?: string;
			/** The arguments, by name, whose text the owner may edit before approving. */
			readonly editable?: string[];
			/**
			 * The arguments, by name, that are the effect in full rather than in words (a request's headers and raw
			 * body): the card keeps them behind a disclosure, under what it leads with.
			 */
			readonly details?: string[];
			/**
			 * The object it acts on, where it has one (DESIGN.md "Connections", objects): each kind it may be, by its ref
			 * (the first that reads is it), and the account its card reads as.
			 */
			readonly on?: { readonly refs: readonly string[]; readonly account?: string };
			/** The account it acts as, in words: "@bandarra on GitHub". */
			readonly as?: string;
			/** The effect's own verb, the card's button: "Comment". */
			readonly verb?: string;
			/** On the floor: it asks every time, and no permission is given for it or covers it. */
			readonly floor?: Floor;
			/** What a permission given with this approval would cover; absent on the floor. */
			readonly permission?: PermissionShape;
			/**
			 * What a permission for anything sent to the draft's host would cover (a held request's alone, never on the
			 * floor): offered as "host", it holds for the chats of the agent that asked.
			 */
			readonly host?: PermissionShape & { readonly host: string };
			/**
			 * Where it acts, at its place's grain (a connection's write that declares one): what the owner's answers
			 * earn, and once earned the one scope offered.
			 */
			readonly place?: PlaceShape;
			/** Its chat read foreign content before it asked: no scope but an earned place, or a host, is offered. */
			readonly foreign?: boolean;
			/** The effect started before a restart and may have partly run: approving runs it again. */
			readonly interrupted?: boolean;
			/** The task it is for: related asks of one task show together. */
			readonly errand?: Errand;
			/**
			 * The scopes a permission given with it may have, in order (the task's first), each in words of its consequence;
			 * none on the floor or for a run again. The daemon's, never the app's choice.
			 */
			readonly scopes?: readonly OfferedScope[];
	  };

/** What an owner may give with an approval: the draft's text as they edited it, and a permission for later effects. */
export type Approving = {
	readonly edits?: { readonly [arg: string]: string };
	readonly permission?: PermissionScope;
};

/** How long an edited text may be. */
export const MAX_EDIT_CHARS = 100_000;

/**
 * A question's answer is text (always accepted: the asker's own words), the options picked, or the values of its
 * form's fields; an approval's is `approve` or `deny`.
 */
export type Answer = string | string[] | { [field: string]: string | number | boolean };

/** Who wrote an answer: a gateway's peer; only the owner (`owner`) fills a Wait. */
export type Sender = { readonly gateway: string; readonly peer: string };

export type WaitInput = {
	/** The ask's id, which buttons, `yes <id>` and the CLI name: unguessable and never shown to the model. */
	readonly key: string;
	readonly ask: Ask;
	/** Epoch ms, at most a week ahead (a timer's reach); no answer by then and the Wait ends `expired`. */
	readonly deadline: number;
	/** The tool call that opened it, so a client shows the ask with that call. */
	readonly call?: string;
};

export type WaitResult =
	| {
			readonly answer: Answer;
			readonly by: Sender;
			readonly at: number;
			/** The draft as the owner edited it, which is what runs. */
			readonly draft?: JsonObject;
			/** The permission given with the approval. */
			readonly permission?: string;
	  }
	| { readonly expired: true }
	| { readonly dismissed: true; readonly by: Sender; readonly at: number };

/** A permission as an ended approval records it. */
export type Permitted = { readonly scope: PermissionScope["scope"]; readonly until?: number };

/** The `banda.wait` entry a Wait leaves in its chat when it ends: what was asked and how it ended. */
export type WaitEnded = {
	readonly ask: Ask;
	readonly call?: string;
	readonly outcome: "answered" | "dismissed" | "expired" | "cancelled";
	readonly answer?: Answer;
	/** The inbound message whose own words answered the question, not a button press. */
	readonly message?: string;
	readonly by?: Sender;
	readonly at: number;
	/** The draft as the owner edited it before approving: what ran. */
	readonly edited?: JsonObject;
	/** The permission the owner gave with the approval. */
	readonly permitted?: Permitted;
};

export const WAIT = "banda.wait";

/** A message that carries an ask: where it went (its route key and origin) and the gateway's id for it. */
export type Delivery = { readonly route: string; readonly origin: Origin; readonly message: string };

/**
 * The answer slot: written once, by the first sender the Wait admits; and the messages that delivered the ask, as
 * plain text answers a question only where it was seen, and each is told how the ask ended.
 */
export const Answers = defineDoc<{
	answer?: Answer;
	/** The inbound message whose words answered a question. */
	message?: string;
	/** The owner explicitly chose to skip a question. */
	dismissed?: boolean;
	by?: Sender;
	at?: number;
	delivered?: Delivery[];
	/** An approval's draft as the owner edited it, and the permission they gave with it. */
	draft?: JsonObject;
	permission?: { id: string; scope: PermissionScope["scope"]; until?: number };
}>({
	kind: "banda.answer",
	version: 1,
	scope: "task",
	initial: () => ({}),
	checkpointWhen: () => false,
});

/**
 * A tool task's own tasks (its Waits, its messages) by name, each written in the commit that creates it, so a rerun
 * of the tool finds it instead of asking or sending again.
 */
export const TasksOf = defineDoc<{ tasks: { [name: string]: number } }>({
	kind: "banda.tasks-of",
	version: 1,
	scope: "task",
	initial: () => ({ tasks: {} }),
	checkpointWhen: () => false,
});

/** Lowercase letters and digits without look-alikes, so an id can be typed. */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** A new ask id: 10 characters, about 50 bits. */
export function newKey(): string {
	let key = "";
	for (let i = 0; i < 10; i++) key += ALPHABET[randomInt(ALPHABET.length)];
	return key;
}

export const KEY = /^[2-9a-hjkmnp-z]{10}$/;

/** Whether `sender`, on a gateway of `strength`, may fill a Wait: the owner, on a gateway strong enough to know them. */
export function admits(sender: Sender, strength: Strength | undefined): boolean {
	return strength !== undefined && strength !== "weak" && sender.peer === OWNER;
}

/**
 * `answer` as it fills `ask`, or why it cannot. A form's values may come as text (the CLI's `field=value`): a number
 * or a yes/no is read from it, and a choice matched to its option.
 */
export function normalize(ask: Ask, answer: Answer): { readonly answer: Answer } | { readonly invalid: string } {
	if (ask.type === "approval")
		return answer === "approve" || answer === "deny"
			? { answer }
			: { invalid: "an approval is answered approve or deny" };
	if (typeof answer === "string") return answer.trim() === "" ? { invalid: "the answer is empty" } : { answer };
	if (Array.isArray(answer)) {
		if (ask.multiple !== true) return { invalid: "this question takes one answer" };
		const picked = answer.map((value) => String(value).trim()).filter((value) => value !== "");
		return picked.length === 0 ? { invalid: "pick at least one" } : { answer: [...new Set(picked)] };
	}
	const values = answer as { readonly [field: string]: string | number | boolean };
	if (ask.fields === undefined) return { invalid: "this question takes text" };
	const known = new Set(ask.fields.map((field) => field.name));
	const unknown = Object.keys(values).filter((name) => !known.has(name));
	if (unknown.length > 0) return { invalid: `no field ${unknown.join(", ")}` };
	const filled: { [field: string]: string | number | boolean } = {};
	for (const field of ask.fields) {
		const raw = values[field.name];
		if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
			if (field.optional === true) continue;
			return { invalid: `${field.name} is required` };
		}
		const value = read(field, raw);
		if (value === undefined) return { invalid: `${field.name} ${expected(field)}` };
		filled[field.name] = value;
	}
	return { answer: filled };
}

function read(field: Field, raw: string | number | boolean): string | number | boolean | undefined {
	const text = String(raw).trim();
	switch (field.type ?? "text") {
		case "number": {
			const n = typeof raw === "number" ? raw : Number(text);
			return text !== "" && Number.isFinite(n) ? n : undefined;
		}
		case "boolean":
			if (typeof raw === "boolean") return raw;
			return /^(y|yes|true)$/i.test(text) ? true : /^(n|no|false)$/i.test(text) ? false : undefined;
		case "choice":
			return field.options?.find((option) => option.toLowerCase() === text.toLowerCase());
		default:
			return typeof raw === "string" ? text : undefined;
	}
}

/** A form's fields in words, one line each: what each takes, whether it may be left out, and its hint. */
export function fieldLines(fields: readonly Field[], markdown = true): string {
	return fields
		.map((field) => {
			const kind =
				field.type === "number"
					? "a number"
					: field.type === "boolean"
						? "yes or no"
						: field.type === "choice"
							? `one of ${(field.options ?? []).join(", ")}`
							: "text";
			const name = markdown ? `**${field.name}**` : field.name;
			return `- ${name}: ${kind}${field.optional ? ", optional" : ""}${field.hint ? ` (${field.hint})` : ""}`;
		})
		.join("\n");
}

/** What `field` takes, in words. */
export function expected(field: Field): string {
	switch (field.type ?? "text") {
		case "number":
			return "is a number";
		case "boolean":
			return "is yes or no";
		case "choice":
			return `is one of ${(field.options ?? []).join(", ")}`;
		default:
			return "is text";
	}
}

/** The Wait filled and its chat, or why it was not. */
export type Filled = { readonly answered: number; readonly chat: number } | { readonly refused: string };

/**
 * Fill Wait `id` with `answer` from `sender`, in `tx`, or say why not. The slot is written only here, and only once.
 */
export async function fill(
	tx: Tx,
	id: number,
	answer: Answer,
	sender: Sender,
	strength: Strength | undefined,
	now: number,
	approving: Approving = {},
	message?: string,
): Promise<Filled> {
	const task = await tx.task(id as TaskId);
	if (
		task === undefined ||
		task.kind !== WAIT ||
		task.state.status === "terminal" ||
		task.state.status === "completing"
	)
		return { refused: "this ask is closed" };
	const input = task.input as unknown as WaitInput;
	if (!admits(sender, strength)) return { refused: "this ask is not yours to answer" };
	if (now >= input.deadline) return { refused: "this ask expired" };
	const normal = normalize(input.ask, answer);
	if ("invalid" in normal) return { refused: normal.invalid };
	const chat = Number(task.conversationId);
	const { ask } = input;
	const { edits, permission } = approving;
	let draft: JsonObject | undefined;
	if (edits !== undefined || permission !== undefined) {
		if (ask.type !== "approval" || normal.answer !== "approve")
			return { refused: "only an approval, approved, carries edits or a permission" };
		if (ask.interrupted === true) return { refused: "running it again is approved once, as it was" };
		if (edits !== undefined) {
			const edited = editsOf(ask, edits);
			if ("refused" in edited) return edited;
			draft = edited.draft;
		}
		if (permission !== undefined) {
			const why = refusal(permission, shapeFor(permission, ask), await floorNow(tx, ask), now, offeredScopes(ask));
			if (why !== undefined) return { refused: why };
		}
	}
	const slot = await tx.doc(Answers, id as TaskId);
	if (slot.answer !== undefined || slot.dismissed === true) return { refused: "this ask was already answered" };
	// reads first: a transaction reads tables only until its first write
	const giving = permission !== undefined && ask.type === "approval" ? shapeFor(permission, ask) : undefined;
	const place = ask.type === "approval" && ask.interrupted !== true ? ask.place : undefined;
	const errand = giving === undefined ? { chat, input: 0 } : await errandOf(tx, chat);
	const agent = giving === undefined && place === undefined ? undefined : await agentOfChat(tx, chat);
	const covered =
		giving === undefined || permission === undefined || ask.type !== "approval"
			? []
			: await coveredAsks(
					tx,
					id,
					{ tool: ask.tool, shape: giving, scope: storedScope(permission), errand, agent },
					now,
				);
	slot.answer = normal.answer;
	if (message !== undefined && ask.type === "question") slot.message = message;
	slot.by = sender;
	slot.at = now;
	if (draft !== undefined) slot.draft = draft;
	// trust is earned from the owner's own answers: this one, in the commit that records it
	if (place !== undefined && agent !== undefined && ask.type === "approval")
		await countAnswer(tx, {
			agent,
			tool: ask.tool,
			place: place.match,
			answer: normal.answer === "deny" ? "declined" : draft === undefined ? "approved" : "edited",
			now,
		});
	if (giving !== undefined && permission !== undefined && ask.type === "approval") {
		const given = await give(tx, { tool: ask.tool, shape: giving, scope: permission, wait: id, errand, agent, now });
		const stored = storedScope(permission);
		const permitted = {
			id: given,
			scope: stored.scope,
			...(stored.scope === "until" ? { until: stored.until } : {}),
		};
		slot.permission = permitted;
		await answerCovered(tx, covered, permitted, sender, now);
	}
	return { answered: id, chat };
}

/**
 * Never ask twice: answer the open asks `covered` (`coveredAsks`, read before the commit's first write) with the
 * permission just given, `permitted`, in the commit that gives it; each counts as an effect it let run.
 */
export async function answerCovered(
	tx: Tx,
	covered: readonly number[],
	permitted: { readonly id: string; readonly scope: PermissionScope["scope"]; readonly until?: number },
	sender: Sender,
	now: number,
): Promise<void> {
	for (const other of covered) {
		const answers = await tx.doc(Answers, other as TaskId);
		answers.answer = "approve";
		answers.by = sender;
		answers.at = now;
		answers.permission = { ...permitted };
	}
	await countRan(tx, permitted.id, now, covered.length);
}

/** Close an unanswered question without inventing an answer; only the owner can dismiss it. */
export async function dismissQuestion(
	harness: Harness,
	key: string,
	sender: Sender,
	strength: Strength,
	ctx: Context = context,
): Promise<Filled> {
	return harness.commit(async (tx) => {
		const wait = await waitByKey(tx, key);
		if (wait === undefined) return { refused: "no open ask has this id" };
		if (wait.input.ask.type !== "question")
			return { refused: "an approval cannot be dismissed: approve or decline it" };
		if (!admits(sender, strength)) return { refused: "this ask is not yours to answer" };
		const now = Date.now();
		if (now >= wait.input.deadline) return { refused: "this ask expired" };
		const slot = await tx.doc(Answers, wait.id as TaskId);
		if (slot.answer !== undefined || slot.dismissed === true) return { refused: "this ask is closed" };
		slot.dismissed = true;
		slot.by = sender;
		slot.at = now;
		return { answered: wait.id, chat: wait.chat };
	}, ctx);
}

/**
 * The other open approvals a permission about to be given would cover, as an effect starting now would find it: the
 * same tool and bound values, open for that ask's task, never on the floor or for a run again, and only in the chats
 * of its agent. Reads only.
 */
export async function coveredAsks(
	tx: Tx,
	id: number,
	given: {
		tool: string;
		shape: PermissionShape;
		scope: Exclude<PermissionScope, { scope: "place" }>;
		errand: Errand;
		agent: string | undefined;
	},
	now: number,
): Promise<number[]> {
	const permission: Permission = {
		tool: given.tool,
		match: given.shape.match,
		what: given.shape.what,
		scope: given.scope.scope,
		...(given.scope.scope === "until" ? { until: given.scope.until } : {}),
		...(given.scope.scope === "task" ? { task: given.errand } : {}),
		...(given.agent === undefined ? {} : { agent: given.agent }),
		at: now,
		wait: id,
	};
	const covered = [];
	for (const wait of await liveWaits(tx)) {
		const { ask } = wait.input;
		if (wait.id === id || ask.type !== "approval" || now >= wait.input.deadline) continue;
		if (ask.floor !== undefined || ask.permission === undefined || ask.interrupted === true) continue;
		if (!matches(permission, ask.tool, ask.args)) continue;
		if (permission.agent === undefined || (await agentOfChat(tx, wait.chat)) !== permission.agent) continue;
		const errand = permission.scope === "task" ? await errandOf(tx, wait.chat) : undefined;
		if (!isOpen(permission, now, errand)) continue;
		if ((await tx.doc(Answers, wait.id as TaskId)).answer !== undefined) continue;
		covered.push(wait.id);
	}
	return covered;
}

/** The draft with the owner's edits, or why they cannot be made: only the text the tool says may be edited. */
function editsOf(
	ask: Extract<Ask, { type: "approval" }>,
	edits: { readonly [arg: string]: string },
): { readonly draft?: JsonObject } | { readonly refused: string } {
	const draft: JsonObject = { ...ask.args };
	let changed = false;
	for (const [arg, text] of Object.entries(edits)) {
		if (!(ask.editable ?? []).includes(arg) || typeof ask.args[arg] !== "string")
			return { refused: `${arg} cannot be edited` };
		if (typeof text !== "string") return { refused: `${arg} is text` };
		if (text.length > MAX_EDIT_CHARS) return { refused: `${arg} is too long` };
		if (text !== ask.args[arg]) changed = true;
		draft[arg] = text;
	}
	return changed ? { draft } : {};
}

/** The open Waits, in `chat` alone when given, oldest first. */
export async function liveWaits(
	tx: Tx,
	chat?: number,
): Promise<{ readonly id: number; readonly chat: number; readonly input: WaitInput }[]> {
	const found = [];
	for (const status of ["pending", "running"] as const) {
		let cursor: Parameters<Tx["scanTasks"]>[2];
		do {
			const page = await tx.scanTasks(
				{
					kind: WAIT,
					status,
					...(chat === undefined ? {} : { conversationId: chat as ConversationId }),
				},
				100,
				cursor,
			);
			for (const task of page.items)
				found.push({
					id: Number(task.id),
					chat: Number(task.conversationId),
					input: task.input as unknown as WaitInput,
				});
			cursor = page.next;
		} while (cursor !== undefined);
	}
	return found.sort((a, b) => a.id - b.id);
}

/** The open Wait with `key`, if any. */
export async function waitByKey(tx: Tx, key: string) {
	return (await liveWaits(tx)).find((wait) => wait.input.key === key);
}

/**
 * Fill the open Wait with `key` from outside any run: the web's and the CLI's answers. `type`, when given, is the kind
 * of ask the answer is for, so `approve` never answers a question with the word.
 */
export async function answer(
	harness: Harness,
	key: string,
	value: Answer,
	sender: Sender,
	strength: Strength,
	{ now = Date.now(), type, approving }: { now?: number; type?: Ask["type"]; approving?: Approving } = {},
	ctx: Context = context,
): Promise<Filled> {
	return harness.commit(async (tx) => {
		const wait = await waitByKey(tx, key);
		if (wait === undefined) return { refused: "no open ask has this id" };
		if (type !== undefined && wait.input.ask.type !== type)
			return { refused: wait.input.ask.type === "approval" ? "this ask is an approval" : "this ask is a question" };
		return fill(tx, wait.id, value, sender, strength, now, approving);
	}, ctx);
}

/**
 * Run again every task the restart limit parked while it waited on an open Wait. pi-durable counts a crash against a
 * task whose state has not changed since, and a tool blocked on a Wait changes nothing while it waits: so five
 * restarts during one ask would park the tool, though waiting is all it did. A parked task with no open Wait under it
 * stays parked.
 */
export async function revive(harness: Harness, ctx: Context = context): Promise<number[]> {
	const graph = await harness.taskGraph(ctx);
	const nodes = Object.values(graph.value.tasks);
	graph.dispose();
	const waiting = new Set(nodes.filter((node) => node.kind === WAIT).map((node) => Number(node.owner)));
	const revived = nodes
		.filter((node) => node.blocked === "restart_limit" && waiting.has(Number(node.id)))
		.map((node) => Number(node.id));
	for (const id of revived) await harness.retryTask(id as TaskId, ctx);
	return revived;
}

/** How an ask ended, in a few words for where it was shown: `✓ Approved`, `✓ blue`, `✗ Expired`. */
export function outcomeLabel({ ask, outcome, answer }: WaitEnded): string {
	if (outcome === "cancelled") return answer === undefined ? "✗ Cancelled" : "✗ Stopped before your answer was used";
	if (outcome === "dismissed") return "✗ Dismissed";
	if (outcome === "expired") return ask.type === "approval" ? "✗ Expired, not approved" : "✗ Expired";
	if (ask.type === "approval")
		return answer === "approve"
			? `✓ ${ask.interrupted ? "Run again" : "Approved"}`
			: `✗ ${ask.interrupted ? "Skipped" : "Denied"}`;
	const words = typeof answer === "string" ? answer : Array.isArray(answer) ? answer.join(", ") : "Answered";
	const line = words.replace(/\s+/g, " ").trim();
	return `✓ ${line.length > 40 ? `${line.slice(0, 39)}…` : line}`;
}

/** What a Wait's end repeats of its input: the ask, and the call that opened it. */
const asked = ({ ask, call }: WaitInput) => ({ ask, ...(call === undefined ? {} : { call }) });

/**
 * A Wait stopped with its tool: cancelled, and the answer it already holds kept on the record, so whoever gave it is
 * told it came too late to be used rather than that it was never asked.
 */
export function cancelledEnd(
	input: WaitInput,
	slot: {
		readonly answer?: Answer;
		readonly message?: string;
		readonly dismissed?: boolean;
		readonly by?: Sender;
		readonly at?: number;
	},
	now: number,
): WaitEnded {
	if (slot.dismissed === true && slot.by !== undefined)
		return { ...asked(input), outcome: "dismissed", by: slot.by, at: slot.at ?? now };
	if (slot.answer === undefined || slot.by === undefined) return { ...asked(input), outcome: "cancelled", at: now };
	return {
		...asked(input),
		outcome: "cancelled",
		answer: slot.answer,
		by: slot.by,
		at: slot.at ?? now,
		...(slot.message === undefined ? {} : { message: slot.message }),
	};
}

/** How a Wait ended, from its record; undefined while it is live. */
export function endedOf(
	record: { readonly input: unknown; readonly state: { readonly status: string; readonly outcome?: unknown } },
	now: number,
): WaitEnded | undefined {
	if (record.state.status !== "terminal") return undefined;
	const ask = asked(record.input as WaitInput);
	const outcome = record.state.outcome as { status: string; result?: WaitResult };
	if (outcome.status !== "completed" || outcome.result === undefined) return { ...ask, outcome: "cancelled", at: now };
	if ("expired" in outcome.result) return { ...ask, outcome: "expired", at: now };
	if ("dismissed" in outcome.result)
		return { ...ask, outcome: "dismissed", by: outcome.result.by, at: outcome.result.at };
	return { ...ask, outcome: "answered", answer: outcome.result.answer, by: outcome.result.by, at: outcome.result.at };
}

type WaitState = { phase: "await"; invocation: number };

/** Who answers an approval an open permission covered: the owner, through what they allowed ahead. */
export const BY_PERMISSION: Sender = { gateway: "permission", peer: OWNER };

/**
 * Never ask twice: an approval that a permission given since its tool last looked now covers is answered by that
 * permission as the Wait starts, as the effect would have run within it. Not a run again, never the floor (`covering`
 * says so). Reads before it writes.
 */
async function coveredAtStart(tx: Tx, ask: Ask, chat: number, id: TaskId, now: number): Promise<void> {
	if (ask.type !== "approval" || ask.interrupted === true) return;
	const slot = await tx.doc(Answers, id);
	if (slot.answer !== undefined) return;
	const found = await covering(tx, ask, chat, now);
	if (found === undefined) return;
	slot.answer = "approve";
	slot.by = BY_PERMISSION;
	slot.at = now;
	slot.permission = {
		id: found.id,
		scope: found.permission.scope,
		...(found.permission.until === undefined ? {} : { until: found.permission.until }),
	};
	await countRan(tx, found.id, now);
}

/**
 * The Wait task. `ended` runs in the commit that ends it, however it ends, with the messages that delivered its ask:
 * what tells each of them how it ended.
 */
export const defineWait = (
	ended: (tx: Tx, chat: number, end: WaitEnded, delivered: readonly Delivery[]) => Promise<void>,
) =>
	defineTask<WaitInput, WaitState, WaitResult>({
		name: WAIT,
		version: 1,
		initial: () => ({ phase: "await", invocation: 0 }),
		phases: {
			await: async (task, runtime, ctx) => {
				const chat = runtime.conversationId;
				const end = async (tx: Tx, entry: WaitEnded) => {
					await tx.appendEntry(chat, { kind: WAIT, data: entry as unknown as JsonObject });
					await ended(tx, Number(chat), entry, (await tx.doc(Answers, runtime.taskId)).delivered ?? []);
				};
				/** The Wait's end, when the slot is filled or the deadline passed; decided in the commit that reads the slot. */
				const closing = async (tx: Tx) => {
					const slot = await tx.doc(Answers, runtime.taskId);
					const now = runtime.now();
					if (slot.dismissed === true && slot.by !== undefined) {
						const at = slot.at ?? now;
						await end(tx, { ...asked(task.input), outcome: "dismissed", by: slot.by, at });
						return {
							status: "terminal",
							outcome: { status: "completed", result: { dismissed: true, by: slot.by, at } },
						} as const;
					}
					if (slot.answer !== undefined && slot.by !== undefined) {
						const at = slot.at ?? now;
						const { permission, draft } = slot;
						const permitted =
							permission === undefined
								? {}
								: {
										permitted: {
											scope: permission.scope,
											...(permission.until === undefined ? {} : { until: permission.until }),
										},
									};
						await end(tx, {
							...asked(task.input),
							outcome: "answered",
							answer: slot.answer,
							by: slot.by,
							at,
							...(slot.message === undefined ? {} : { message: slot.message }),
							...(draft === undefined ? {} : { edited: draft }),
							...permitted,
						});
						const result: WaitResult = {
							answer: slot.answer,
							by: slot.by,
							at,
							...(draft === undefined ? {} : { draft }),
							...(permission === undefined ? {} : { permission: permission.id }),
						};
						return { status: "terminal", outcome: { status: "completed", result } } as const;
					}
					if (now >= task.input.deadline) {
						await end(tx, { ...asked(task.input), outcome: "expired", at: now });
						const result: WaitResult = { expired: true };
						return { status: "terminal", outcome: { status: "completed", result } } as const;
					}
					return undefined;
				};
				let done = false;
				// A fresh checkpoint per invocation: waiting is never what crashed, so a Wait is never parked.
				const invocation = task.state.checkpoint.invocation + 1;
				await runtime.commit(async (tx) => {
					await coveredAtStart(tx, task.input.ask, Number(chat), runtime.taskId, runtime.now());
					const end = await closing(tx);
					done = end !== undefined;
					return end ?? { status: "running", checkpoint: { phase: "await", invocation } };
				}, ctx);
				if (done) return;
				const watch = await runtime.watchDoc(Answers, runtime.taskId, ctx);
				if (watch === undefined) throw new Error("the answer slot is gone");
				let timer: NodeJS.Timeout | undefined;
				try {
					await new Promise<void>((resolve, reject) => {
						let checking = false;
						let requested = false;
						const check = () => {
							if (done) return;
							if (checking) {
								requested = true;
								return;
							}
							checking = true;
							void (async () => {
								try {
									do {
										requested = false;
										await runtime.commit(async (tx) => {
											const end = await closing(tx);
											if (end !== undefined) done = true;
											return end;
										}, ctx);
									} while (requested && !done);
									if (done) resolve();
								} catch (error) {
									reject(error);
								} finally {
									checking = false;
								}
							})();
						};
						runtime.signal.addEventListener("abort", () => reject(runtime.signal.reason), { once: true });
						timer = setTimeout(check, Math.max(task.input.deadline - runtime.now(), 0));
						watch.start(async (value) => {
							if (value?.answer !== undefined || value?.dismissed === true) check();
						});
						// A fill may commit between the first slot read and registration. Check once after watching.
						check();
					});
				} finally {
					clearTimeout(timer);
					await watch.stop();
				}
			},
		},
		abort: (task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				const slot = await tx.doc(Answers, runtime.taskId);
				const entry = cancelledEnd(task.input, slot, runtime.now());
				await tx.appendEntry(runtime.conversationId, { kind: WAIT, data: entry as unknown as JsonObject });
				await ended(tx, Number(runtime.conversationId), entry, slot.delivered ?? []);
				return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } };
			}, ctx),
	});
