/**
 * The system under fault: the real core on a store at `home`, a gateway that appends each send to
 * `<home>/sent.jsonl` (so sends survive a killed process) and echo models, every effect passing its fault point.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry, type Harness, type TaskId, type TaskOutcome } from "@earendil-works/pi-durable";
import type { Delivered } from "../../src/core/ask.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import {
	type Gateway,
	type Inbound,
	messageKey,
	type Origin,
	type Outbound,
	PermanentSendError,
	routeKey,
} from "../../src/core/gateway.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, MessageRefs, NUDGE, Routes, type TurnInput, type TurnResult } from "../../src/core/turn.ts";
import { echoModels, FAUX_MODEL } from "../fixtures/models.ts";
import type { Faults } from "./faults.ts";

export type Sent = { readonly to: Origin; readonly out: Outbound };

/** Where the fake gateway reaches the owner, and the peer whose every send it refuses. */
export const OWNER_ORIGIN: Origin = { gateway: "fake", peer: "owner" };
export const REFUSING = "gone";

/** A message the agents or the daemon sent, how it ended, and, given up, how the notice about it ended. */
export type MessageSummary = {
	readonly id: number;
	readonly origin: Origin;
	readonly text: string;
	readonly outcome: TaskOutcome<Delivered>;
	readonly notice?: TaskOutcome<Delivered>;
};

export type Summary = {
	/** Per message id, its Turn's outcome. */
	readonly outcomes: Record<string, TaskOutcome<TurnResult>>;
	/** Nudge outcomes, attributed to the latest owner input admitted before that nudge in its chat. */
	readonly nudges: Record<string, TaskOutcome<TurnResult>[]>;
	/** Every message task, in the order they were created. */
	readonly messages: readonly MessageSummary[];
	/** Per route key, the message ids of its chat's inbound entries, in order. */
	readonly inbound: Record<string, string[]>;
	/** Per route key, its chat's inputs and the daemon's nudges, in order. */
	readonly inputs: Record<string, ("input" | "nudge")[]>;
};

/** Every `banda.message` task (or task of `kind`), in order. */
function messageTasks(harness: Harness, kind = "banda.message") {
	return harness.commit(async (tx) => {
		const found = [];
		let cursor: Parameters<typeof tx.scanTasks>[2];
		do {
			const page = await tx.scanTasks({ kind }, 100, cursor);
			found.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	}, context);
}

export function banda(home: string, faults: Faults) {
	let sends = 0;
	const gateway: Gateway = {
		name: "fake",
		strength: "bearer",
		can: { buttons: false, files: false, threads: true },
		start() {},
		ownerOrigin: () => OWNER_ORIGIN,
		async send(to, out) {
			faults.hit("send:before");
			if (to.peer === REFUSING) throw new PermanentSendError("refused");
			appendFileSync(join(home, "sent.jsonl"), `${JSON.stringify({ to, out })}\n`);
			faults.hit("send:after");
			return `out-${process.pid}-${++sends}`;
		},
	};
	const blobs = new BlobStore(join(home, "blobs"));
	const core = defineCore({
		blobs,
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		ownerOrigin: (except) =>
			except !== undefined && routeKey(except) === routeKey(OWNER_ORIGIN) ? undefined : OWNER_ORIGIN,
	});
	const { models } = echoModels(faults);
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models, registry, wrapStorage: (s) => faults.storage(s) });
		harness.resume();
		return harness;
	};
	return { core, open };
}

/** Wait until the Turn of every message has ended, and every message it sent, notices included. */
export async function settle(harness: Harness, messages: readonly Inbound[]): Promise<void> {
	const refs = (await harness.snapshot(MessageRefs, context))?.messages ?? {};
	for (const m of messages) {
		const ref = refs[messageKey(m.origin.gateway, m.id)];
		if (ref === undefined) throw new Error(`message ${m.id} was never received`);
		await harness.waitForTask(ref.turn as TaskId<TurnResult>, context);
	}
	// a message given up queues its notice, and a run that left the owner unanswered its nudge, which is a Turn of
	// its own: settle until no new one appears
	const all = async () => [...(await messageTasks(harness)), ...(await messageTasks(harness, "banda.turn"))];
	let seen = -1;
	for (let tasks = await all(); tasks.length !== seen; tasks = await all()) {
		seen = tasks.length;
		for (const task of tasks) await harness.waitForTask(task.id as TaskId<Delivered>, context);
	}
}

export async function summarize(harness: Harness, messages: readonly Inbound[]): Promise<Summary> {
	const refs = (await harness.snapshot(MessageRefs, context))?.messages ?? {};
	const outcomes: Summary["outcomes"] = {};
	for (const m of messages) {
		const turn = refs[messageKey(m.origin.gateway, m.id)]!.turn as TaskId<TurnResult>;
		outcomes[m.id] = (await harness.getTask(turn, context))!.state.outcome as TaskOutcome<TurnResult>;
	}
	const nudges: Summary["nudges"] = {};
	for (const task of await messageTasks(harness, "banda.turn")) {
		const input = task.input as unknown as TurnInput;
		if (input.internal?.kind !== NUDGE) continue;
		const owner = messages
			.filter((m) => {
				const ref = refs[messageKey(m.origin.gateway, m.id)];
				return ref?.chat === input.chat && ref.turn !== undefined && ref.turn < Number(task.id);
			})
			.at(-1);
		if (owner !== undefined) {
			nudges[owner.id] ??= [];
			nudges[owner.id].push((task.state as { outcome: TaskOutcome<TurnResult> }).outcome);
		}
	}
	const tasks = await messageTasks(harness);
	const outcomeOf = (id: number) =>
		(tasks.find((task) => Number(task.id) === id)?.state as { outcome?: TaskOutcome<Delivered> } | undefined)
			?.outcome as TaskOutcome<Delivered>;
	const sent: MessageSummary[] = tasks.map((task) => {
		const input = task.input as unknown as { origin: Origin; out: Outbound };
		const outcome = outcomeOf(Number(task.id));
		const notice =
			outcome?.status === "completed" && "notice" in outcome.result && outcome.result.notice !== undefined
				? outcomeOf(outcome.result.notice)
				: undefined;
		return {
			id: Number(task.id),
			origin: input.origin,
			text: input.out.text,
			outcome,
			...(notice === undefined ? {} : { notice }),
		};
	});
	const inbound: Summary["inbound"] = {};
	const inputs: Summary["inputs"] = {};
	for (const [key, { chat }] of Object.entries((await harness.snapshot(Routes, context))?.routes ?? {})) {
		const handle = await harness.conversation(chat as never, context);
		const entries = [...(await handle!.entries({}, 10_000, undefined, context)).items].reverse();
		inbound[key] = entries
			.filter((e) => e.kind === "banda.inbound")
			.map((e) => (e.data as { message: string }).message);
		inputs[key] = entries.flatMap((e) =>
			e.kind === "banda.inbound" ? ["input"] : e.kind === NUDGE ? ["nudge"] : e.kind === "banda.notice" ? [] : [],
		);
	}
	return { outcomes, nudges, messages: sent, inbound, inputs };
}

export function readSent(home: string): Sent[] {
	try {
		const lines = readFileSync(join(home, "sent.jsonl"), "utf8").split("\n").filter(Boolean);
		return lines.map((line) => JSON.parse(line) as Sent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
