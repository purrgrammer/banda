/**
 * Archiving an agent (DESIGN.md "Agents"): its accepted file says `state: archived`, and that is the whole switch. In
 * the commit that accepts it, its routines are paused and its permissions revoked (`retire`); from that commit on, its
 * chats take no input, nobody may mention it, and a routine of its runs nowhere. What it was already doing is stopped
 * after the commit (`stopArchived`), and again at every start, so a crash between the two leaves nothing running.
 * Restoring is the same file saying `state: active`: its routines stay paused and its permissions stay gone.
 */
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type Harness, LiveDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { log } from "./activity.ts";
import { Accepted, AgentChats, agentPath, agentWords, archivedFile } from "./agents.ts";
import { Permissions } from "./permissions.ts";
import { Routines, routineAgent } from "./routines.ts";
import { context } from "./store.ts";
import { Watches, watchAgent } from "./watches.ts";

/**
 * In the commit that archives agent `id`: its routines paused as the owner's own pause (which restoring leaves as it
 * is) and every permission given in its chats revoked, each said in the activity. Idempotent: a second call finds
 * nothing left to do.
 */
export async function retire(tx: Tx, id: string, now: number): Promise<void> {
	const { routines } = await tx.doc(Routines);
	const owned: string[] = [];
	for (const [name, record] of Object.entries(routines))
		if (record.paused === undefined && routineAgent(record) === id) owned.push(name);
	const doc = await tx.doc(Permissions);
	const taken = Object.entries(doc.permissions).filter(([, permission]) => permission.agent === id);
	const name = await agentWords(tx, id);
	for (const routine of owned) {
		const record = routines[routine];
		if (record === undefined) continue;
		record.paused = "owner";
		await log(tx, { at: now, routine, what: `paused: you archived ${name}` });
	}
	for (const [key, permission] of taken) {
		delete doc.permissions[key];
		await log(tx, { at: now, what: `You took back: ${permission.what} (you archived ${name})` });
	}
	// its watches too: paused as the owner's own pause, so restoring brings none back unasked
	const { watches } = await tx.doc(Watches);
	for (const [watch, record] of Object.entries(watches))
		if (record.paused === undefined && record.done === undefined && watchAgent(record) === id) {
			record.paused = "owner";
			await log(tx, { at: now, watch, what: `paused: you archived ${name}` });
		}
}

/**
 * Stop whatever archived agents are doing: the inputs not yet admitted to their chats, their turns queued in groups,
 * then the runs their chats are in. Nothing for an agent that is active; cheap when nothing runs.
 */
export async function stopArchived(harness: Harness, ctx: Context = context): Promise<void> {
	const { archived, chats } = await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		const all = (await tx.doc(AgentChats)).chats;
		const archived = new Set(
			[...new Set(Object.values(all))].filter((agent) => archivedFile(agent, files[agentPath(agent)])),
		);
		const chats: number[] = [];
		for (const [chat, agent] of Object.entries(all)) if (archived.has(agent)) chats.push(Number(chat));
		return { archived, chats };
	}, ctx);
	if (archived.size === 0) return;
	const mine = new Set(chats);
	const graph = await harness.taskGraph(ctx);
	const nodes = Object.values(graph.value.tasks).filter(
		(node) =>
			(node.kind === "banda.admit" && mine.has(Number(node.conversationId))) || node.kind === "banda.group-turn",
	);
	graph.dispose();
	for (const node of nodes) {
		const task = await harness.getTask(node.id as TaskId, ctx);
		if (task === undefined || task.state.status === "terminal") continue;
		if (node.kind === "banda.group-turn" && !archived.has((task.input as { agent: string }).agent)) continue;
		await harness.abortTask(node.id as TaskId, ctx);
	}
	for (const chat of chats) {
		const busy = await harness.commit(
			async (tx) => (await tx.doc(LiveDoc, chat as ConversationId)).run !== undefined,
			ctx,
		);
		if (busy) await (await harness.conversation(chat as ConversationId, ctx))?.abort(ctx);
	}
}
