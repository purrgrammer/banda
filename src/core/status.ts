/** Status (DESIGN.md "Flows"), derived from the task graph and the tasks' own inputs: nothing records it. */

import type { Context } from "@earendil-works/chord/context";
import type { Harness, TaskGraphNode, TaskId, Tx } from "@earendil-works/pi-durable";
import { LEAD } from "./agents.ts";

import type { Origin } from "./gateway.ts";
import { Groups } from "./groups.ts";
import { agentOfChat } from "./permissions.ts";
import { RoutineRuns } from "./routines.ts";
import { context } from "./store.ts";
import { Routes } from "./turn.ts";
import { type Ask, WAIT, type WaitInput } from "./wait.ts";

export type State = "running" | "waiting" | "idle";

export type ChatStatus = {
	readonly origin: Origin;
	readonly chat: number;
	/** The agent it runs. */
	readonly agent: string;
	readonly state: State;
	/** Inputs whose run has not settled yet. */
	readonly unanswered: number;
};

/** An open Wait, as whoever may answer it sees it. */
export type OpenWait = {
	/** The ask's id: what answers it. */
	readonly key: string;
	readonly chat: number;
	/** A routine approval's visible parent; `chat` still owns the Wait and its task scope. */
	readonly displayChat?: number;
	readonly ask: Ask;
	readonly deadline: number;
	/** The tool call that opened it. */
	readonly call?: string;
};

/** A task that cannot run, and why: no registered definition takes it, or the restart limit ended it (`cutOff`). */
export type Parked = {
	readonly task: number;
	readonly kind: string;
	readonly chat: number;
	readonly reason: string;
};

export type Status = {
	readonly chats: readonly ChatStatus[];
	readonly waits: readonly OpenWait[];
	/** Tasks that cannot run because no registered definition takes them, which is a bug in the daemon. */
	readonly parked: readonly Parked[];
};

/**
 * `waiting`: a live Wait, and no other work in the chat but the tasks waiting on it; `running`: other work;
 * `idle`: nothing but background tasks (Turns sending, asks being sent).
 */
export function stateOf(nodes: readonly TaskGraphNode[], chat: number): State {
	const live = nodes.filter((node) => Number(node.conversationId) === chat && !node.background);
	const waits = live.filter((node) => node.kind === WAIT);
	if (waits.length === 0) return live.length > 0 ? "running" : "idle";
	const byId = new Map(live.map((node) => [Number(node.id), node]));
	const waitingOnOne = new Set<number>();
	for (const wait of waits) {
		for (let owner = wait.owner; owner !== undefined; owner = byId.get(Number(owner))?.owner)
			waitingOnOne.add(Number(owner));
	}
	return live.every((node) => node.kind === WAIT || waitingOnOne.has(Number(node.id))) ? "waiting" : "running";
}

async function nodes(harness: Harness, ctx: Context): Promise<TaskGraphNode[]> {
	const graph = await harness.watchTaskGraph(ctx);
	try {
		return Object.values(graph.value.tasks);
	} finally {
		await graph.stop();
	}
}

/** Open Waits, oldest first; a chat filter includes its routines' approvals without changing their ownership. */
export async function openWaits(
	harness: Harness,
	chat?: number,
	ctx: Context = context,
	live?: readonly TaskGraphNode[],
): Promise<OpenWait[]> {
	const waits = (live ?? (await nodes(harness, ctx))).filter(
		(node) => node.kind === WAIT && node.state.status !== "completing",
	);
	if (waits.length === 0) return [];
	const open = await Promise.all(
		waits.map(async (node) => {
			const input = (await harness.getTask(node.id as TaskId, ctx))?.input as WaitInput | undefined;
			return input === undefined
				? []
				: [
						{
							key: input.key,
							chat: Number(node.conversationId),
							ask: input.ask,
							deadline: input.deadline,
							...(input.call === undefined ? {} : { call: input.call }),
							id: Number(node.id),
						},
					];
		}),
	);
	const shown = await harness.commit(async (tx) => {
		const runs = (await tx.doc(RoutineRuns)).runs;
		const routes = (await tx.doc(Routes)).chats;
		const groups = (await tx.doc(Groups)).byExecution;
		const shown: (OpenWait & { id: number })[] = [];
		for (const wait of open.flat()) {
			const run = runs[wait.chat];
			const displayChat =
				wait.ask.type === "approval" &&
				run !== undefined &&
				routes[run.chat]?.agent === run.agent &&
				routes[wait.chat] === undefined &&
				groups[wait.chat] === undefined &&
				groups[run.chat] === undefined &&
				(await agentOfChat(tx, wait.chat)) === run.agent
					? run.chat
					: undefined;
			shown.push({ ...wait, ...(displayChat === undefined ? {} : { displayChat }) });
		}
		return shown;
	}, ctx);
	return shown
		.filter((wait) => chat === undefined || wait.chat === chat || wait.displayChat === chat)
		.sort((a, b) => a.id - b.id)
		.map(({ id: _, ...wait }) => wait);
}

/**
 * The chats whose agent is at work in a routine's run: a run's conversation is its own, apart from the chat it speaks
 * in, so that chat's own tasks say nothing of it. A run counts for the chat it speaks in while that chat is its
 * agent's; one that waits on the owner is not at work.
 */
async function routinesAtWork(
	harness: Harness,
	live: readonly TaskGraphNode[],
	homes: { readonly [chat: string]: { readonly agent?: string } },
	ctx: Context,
): Promise<ReadonlySet<number>> {
	const apart = [...new Set(live.flatMap((node) => (node.background ? [] : [Number(node.conversationId)])))].filter(
		(chat) => homes[chat] === undefined,
	);
	const working = new Set<number>();
	// the runs are read only while something works outside the chats: most pushes of the shell find nothing there
	if (apart.length === 0) return working;
	const runs = (await harness.snapshot(RoutineRuns, ctx))?.runs ?? {};
	for (const chat of apart) {
		const run = runs[chat];
		const home = run === undefined ? undefined : homes[run.chat];
		if (
			run !== undefined &&
			home !== undefined &&
			(home.agent ?? LEAD) === run.agent &&
			stateOf(live, chat) === "running"
		)
			working.add(run.chat);
	}
	return working;
}

export async function status(harness: Harness, ctx: Context = context): Promise<Status> {
	const live = await nodes(harness, ctx);
	const waits = await openWaits(harness, undefined, ctx, live);
	const homes = (await harness.snapshot(Routes, ctx))?.chats ?? {};
	const routines = await routinesAtWork(harness, live, homes, ctx);
	const chats: ChatStatus[] = Object.entries(homes).map(([id, { origin, agent }]) => {
		const chat = Number(id);
		const own = stateOf(live, chat);
		// a chat with nothing of its own going says what its agent's routines do: one waits on the owner here (its
		// approval is shown in this chat), or one is at work
		const state =
			own !== "idle"
				? own
				: waits.some((wait) => wait.displayChat === chat)
					? "waiting"
					: routines.has(chat)
						? "running"
						: "idle";
		return {
			origin,
			chat,
			// a chat from before agents had files ran the lead
			agent: (agent as string | undefined) ?? LEAD,
			state,
			unanswered: live.filter((node) => Number(node.conversationId) === chat && node.kind === "banda.turn").length,
		};
	});
	const parked = live.flatMap((node) =>
		node.blocked === undefined
			? []
			: [{ task: Number(node.id), kind: node.kind, chat: Number(node.conversationId), reason: node.blocked }],
	);
	return { chats, waits, parked };
}

/**
 * The tasks the restart limit ended: cut off by crashes `settings.restartLimit` times in a row, pi-durable ends a task
 * with a failure whose detail is `{ reason: "restart_limit" }` instead of running it again. Read from the stored
 * terminal records, so it holds whichever process ended them. A scan of every ended task: for checks, not a live view.
 */
export async function cutOff(harness: Harness, ctx: Context = context): Promise<Parked[]> {
	return harness.commit(async (tx) => {
		const found: Parked[] = [];
		let cursor: Parameters<Tx["scanTasks"]>[2];
		do {
			const page = await tx.scanTasks({ status: "terminal" }, 100, cursor);
			for (const task of page.items) {
				const outcome = task.state.status === "terminal" ? task.state.outcome : undefined;
				const detail = outcome?.error?.detail;
				if (
					typeof detail === "object" &&
					detail !== null &&
					!Array.isArray(detail) &&
					detail.reason === "restart_limit"
				)
					found.push({
						task: Number(task.id),
						kind: task.kind,
						chat: Number(task.conversationId),
						reason: "restart_limit",
					});
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	}, ctx);
}

/** The work that will not finish: tasks that cannot run (`parked`) and those the restart limit ended (`cutOff`). */
export async function stuck(harness: Harness, ctx: Context = context): Promise<Parked[]> {
	return [...(await status(harness, ctx)).parked, ...(await cutOff(harness, ctx))];
}
