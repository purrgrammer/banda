import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import { acceptedAgent } from "./agents.ts";
import { acceptedConnection, accountsOn, Connected, mayUse, readsFor, signsIn, toolName } from "./connections.ts";
import { Groups } from "./groups.ts";
import { type ObjectRead, type ObjectRef, readArgs } from "./objects.ts";
import { agentOfChat } from "./permissions.ts";

/** One member's authority, never the union of a room's members. Also used at each remote call and publication. */
export async function objectAccess(tx: Tx, chat: number, ref: ObjectRef, account: string) {
	const id = await agentOfChat(tx, chat);
	if (id === undefined) return undefined;
	const agent = await acceptedAgent(tx, id);
	if (agent === undefined || agent.state !== "active" || !mayUse(agent, ref.connection)) return undefined;
	const groups = await tx.doc(Groups);
	const execution = groups.byExecution[chat];
	if (execution !== undefined && !groups.groups[execution.room]?.members.includes(id)) return undefined;
	const connection = await acceptedConnection(tx, ref.connection);
	const kind = connection?.objects?.[ref.kind];
	if (connection === undefined || kind === undefined) return undefined;
	const doc = await tx.doc(Connected);
	const listed = doc.connections[ref.connection];
	if (listed?.sha !== connection.sha) return undefined;
	if (signsIn(connection) && !(await accountsOn(tx, id, ref.connection)).includes(account)) return undefined;
	if (!signsIn(connection) && account !== "") return undefined;
	const schemas = [];
	const reads: Record<string, ObjectRead> = {};
	/** The schema each read's tool was listed with, as the doc holds it: what a read's arguments are shaped by. */
	const listedWith: Record<string, JsonObject | undefined> = {};
	for (const [as, read] of Object.entries(kind.reads)) {
		const tool = listed.tools[read.tool];
		const enabled =
			tool !== undefined &&
			!doc.off[toolName(connection.name, read.tool)] &&
			(connection.reads.includes(read.tool) ||
				readsFor(connection.readsWhen?.[read.tool], readArgs(read, ref, tool.schema)));
		schemas.push([as, tool?.schema, enabled]);
		if (!enabled) {
			if (!read.optional) return undefined;
			continue;
		}
		reads[as] = read;
		listedWith[as] = tool.schema;
	}
	const source = JSON.stringify([connection.sha, doc.accounts[ref.connection]?.[account], schemas]);
	return { connection, kind, reads, schemas: listedWith, source, stamp: JSON.stringify([source, agent, doc.epoch]) };
}
