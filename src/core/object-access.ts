import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import { acceptedAgent } from "./agents.ts";
import { toolWords } from "./ask.ts";
import { acceptedConnection, accountsOn, Connected, mayUse, readsFor, signsIn, toolName } from "./connections.ts";
import { Groups } from "./groups.ts";
import { type ObjectRead, type ObjectRef, readArgs } from "./objects.ts";
import { agentOfChat } from "./permissions.ts";

/** A read a kind needs that the owner's switch holds off (`Connected.off`), for either reason it can be off. */
export type OffRead = {
	readonly tool: string;
	/** The tool in the owner's words, as its definition says them. */
	readonly words?: string;
	readonly why: "owner" | "waiting";
	readonly service: string;
};

/** Why a card or a watch stands still for an off tool, and how to change it, in the owner's words. */
export const offWords = ({ tool, words, why, service }: OffRead): string =>
	why === "owner"
		? `You turned off "${words ?? toolWords(tool)}" for ${service}. Turn it back on in ${service}'s details, under Connections.`
		: `"${words ?? toolWords(tool)}" is off until you turn it on in ${service}'s details, under Connections.`;

/** One member's authority, never the union of a room's members. Also used at each remote call and publication. */
export async function objectAccess(tx: Tx, chat: number, ref: ObjectRef, account: string) {
	const standing = await objectStanding(tx, chat, ref, account);
	return standing === undefined || standing.off !== undefined ? undefined : standing;
}

/**
 * What `objectAccess` finds, and, where it would find nothing only because a read the object needs is switched off,
 * that read (`off`): the same member's authority, so a card or a watch may say why without saying more than it could.
 * Off for a read only a watch makes (`follow`), a card goes on and `stopped` says so; each of a kind's reads counts.
 */
export async function objectStanding(tx: Tx, chat: number, ref: ObjectRef, account: string) {
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
	if (listed?.version !== connection.version) return undefined;
	if (signsIn(connection) && !(await accountsOn(tx, id, ref.connection)).includes(account)) return undefined;
	if (!signsIn(connection) && account !== "") return undefined;
	const schemas = [];
	const reads: Record<string, ObjectRead> = {};
	/** The schema each read's tool was listed with, as the doc holds it: what a read's arguments are shaped by. */
	const listedWith: Record<string, JsonObject | undefined> = {};
	let off: OffRead | undefined;
	let stopped: OffRead | undefined;
	/** The optional reads off now, by name: a watch's reading changes shape with them, so it starts over when they move. */
	const skipped: string[] = [];
	for (const [as, read] of Object.entries(kind.reads)) {
		const tool = listed.tools[read.tool];
		const readable =
			tool !== undefined &&
			(connection.reads.includes(read.tool) ||
				readsFor(connection.readsWhen?.[read.tool], readArgs(read, ref, tool.schema)));
		const switched = doc.off[toolName(connection.name, read.tool)];
		const enabled = readable && switched === undefined;
		schemas.push([as, tool?.schema, enabled]);
		if (!readable) {
			if (!read.optional) return undefined;
			continue;
		}
		if (switched !== undefined) {
			const words = connection.words?.[read.tool];
			const found = {
				tool: read.tool,
				...(words === undefined ? {} : { words }),
				why: switched,
				service: connection.service,
			};
			if (read.optional) skipped.push(as);
			else if (read.follow === true) stopped ??= found;
			else off ??= found;
			continue;
		}
		reads[as] = read;
		listedWith[as] = tool.schema;
	}
	if (off !== undefined) return { off };
	// the sign-in the read is made with, not what the account is called: a rename changes no access
	const held = doc.accounts[ref.connection]?.[account];
	const source = JSON.stringify([connection.version, held && [held.id, held.generation, held.at], schemas]);
	return {
		connection,
		kind,
		reads,
		schemas: listedWith,
		source,
		stamp: JSON.stringify([source, agent, doc.epoch]),
		skipped,
		...(stopped === undefined ? {} : { stopped }),
	};
}
