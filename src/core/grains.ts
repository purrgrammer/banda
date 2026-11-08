/**
 * Permissions at a wider grain (DESIGN.md "Permissions"): given by the owner from an agent's Access, not by answering
 * an ask, for a write its connection's objects say may be allowed at its kind's place or anywhere. One binds the account
 * the write acts as, always, and for a place the arguments that name it; every other argument is free, so a later
 * call is within it whatever object it acts on there. Its words are the daemon's, from the connection's data. A place
 * is also earned from the owner's answers to its asks (`withPlace`), and then offered on the card.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness, JsonObject, Tx } from "@earendil-works/pi-durable";
import { log } from "./activity.ts";
import { acceptedAgent, agentWords, LEAD } from "./agents.ts";
import {
	accountArg,
	accountLabel,
	accountsOn,
	Connected,
	connectionTools,
	type InEffect,
	signsIn,
} from "./connections.ts";
import { type Grain, grainsOf, grainWords, placeValue } from "./objects.ts";
import {
	agentOfChat,
	canonical,
	FLOOR_WORDS,
	isEarned,
	isOpen,
	type Offering,
	type PermissionScope,
	Permissions,
	type PlaceShape,
	permissionWhen,
	refusal,
} from "./permissions.ts";
import { context } from "./store.ts";
import { answerCovered, coveredAsks } from "./wait.ts";

/** What the owner allows from Access: which agent may run which write, as which account, at which grain, how long. */
export type GrainAsked = {
	readonly agent: string;
	readonly connection: string;
	/** The tool as the model knows it: `github__merge_pull_request`. */
	readonly tool: string;
	/** The account's key, as the connection's accounts name it. */
	readonly account: string;
	readonly grain: Grain;
	/** For a place: each of its placeholders' values, `{"owner": "purrgrammer", "repo": "banda"}`. */
	readonly place?: { readonly [placeholder: string]: string };
	readonly scope: Extract<PermissionScope, { scope: "always" | "until" }>;
};

/**
 * Allow `asked` as the owner: a permission of the agent's for the tool at the grain, given directly (wait 0) and logged
 * as the owner's, which answers in the same commit the agent's open asks it covers. Refused unless the agent exists,
 * the account is switched on for it, the tool is a write in effect off the floor, and the write declares the grain.
 * The id of the permission (an equal one already given always, if so) and its words, or why not.
 */
export async function allowGrain(
	harness: Harness,
	asked: GrainAsked,
	now: number,
	ctx: Context = context,
): Promise<{ readonly id: string; readonly what: string } | { readonly refused: string }> {
	return harness.commit(async (tx) => {
		const { agent, scope } = asked;
		if (agent !== LEAD && (await acceptedAgent(tx, agent)) === undefined) return { refused: "no such agent" };
		const name = await agentWords(tx, agent);
		const tool = (await connectionTools(tx)).find(
			(each) => each.name === asked.tool && each.connection.name === asked.connection,
		);
		if (tool === undefined) return { refused: "that tool is not in effect" };
		if (tool.read || tool.readsWhen !== undefined)
			return { refused: "only a write asks first, so only one is allowed" };
		if (tool.floor !== undefined)
			return { refused: `this is never allowed ahead: it asks every time, as ${FLOOR_WORDS[tool.floor]}` };
		if (!signsIn(tool.connection)) return { refused: "a write is allowed ahead as one of its connection's accounts" };
		if (!(await accountsOn(tx, agent, asked.connection)).includes(asked.account))
			return { refused: `that account is not switched on for ${name}` };
		const grains = grainsOf(tool.tool, tool.connection.objects);
		const grain = asked.grain === "place" ? grains?.place : asked.grain === "action" ? grains?.action : undefined;
		if (grain === undefined) return { refused: "this cannot be allowed that widely" };
		if (scope.scope !== "always" && scope.scope !== "until")
			return { refused: "a permission given here lasts always or until a time" };
		const values: { [placeholder: string]: string } = {};
		const args = (asked.grain === "place" ? grains?.place?.args : undefined) ?? {};
		const given = asked.place ?? {};
		if (Object.keys(given).some((placeholder) => !Object.hasOwn(args, placeholder)))
			return { refused: "a place names only its own parts" };
		for (const placeholder of Object.keys(args)) {
			const value = given[placeholder];
			if (typeof value !== "string" || !placeValue(value.trim()))
				return { refused: `say the place's ${placeholder}: letters, digits, dots, dashes or underscores` };
			values[placeholder] = value.trim();
		}
		const { match, what } = await grainShape(tx, tool, asked.account, grain.words, args, values);
		const why = refusal(scope, { match, what }, undefined, now);
		if (why !== undefined) return { refused: why };
		const doc = await tx.doc(Permissions);
		const same = Object.entries(doc.permissions).find(
			([, permission]) =>
				scope.scope === "always" &&
				permission.scope === "always" &&
				permission.agent === agent &&
				permission.tool === asked.tool &&
				permission.grain === asked.grain &&
				canonical(permission.match) === canonical(match),
		);
		if (same !== undefined) return { id: same[0], what: same[1].what };
		// reads first: a transaction reads tables only until its first write
		const covered = await coveredAsks(
			tx,
			0,
			{ tool: asked.tool, shape: { match, what }, scope, errand: { chat: 0, input: 0 }, agent },
			now,
		);
		for (const [key, permission] of Object.entries(doc.permissions))
			if (permission.scope === "until" && !isOpen(permission, now)) delete doc.permissions[key];
		const id = String(doc.next);
		doc.next += 1;
		doc.permissions[id] = {
			tool: asked.tool,
			match,
			what,
			scope: scope.scope,
			...(scope.scope === "until" ? { until: scope.until } : {}),
			agent,
			grain: asked.grain,
			at: now,
			wait: 0,
		};
		await log(tx, { at: now, what: `You allowed ${name} to ${what}, ${permissionWhen(scope)}` });
		await answerCovered(
			tx,
			covered,
			{ id: id, scope: scope.scope, ...(scope.scope === "until" ? { until: scope.until } : {}) },
			now,
		);
		return { id: id, what };
	}, ctx);
}

/**
 * A grain's permission for `tool` as `account`: it binds the account's argument and, for a place, the arguments that
 * name it (`args`, by placeholder, with their `values`); its words are the grain's, the place filled, and the account.
 * Reads only.
 */
async function grainShape(
	tx: Tx,
	tool: InEffect,
	account: string,
	words: string,
	args: { readonly [placeholder: string]: string },
	values: { readonly [placeholder: string]: string },
): Promise<{ readonly match: JsonObject; readonly what: string }> {
	const match: JsonObject = { [accountArg(tool.listed.schema)]: account };
	for (const [placeholder, arg] of Object.entries(args)) match[arg] = values[placeholder] as string;
	const login = (await tx.doc(Connected)).accounts[tool.connection.name]?.[account]?.id ?? account;
	return { match, what: `${grainWords(words, values)} as ${accountLabel(login)}` };
}

/**
 * `draft` with the place it acts in, as a permission at its place's grain would bind it, and whether the owner's
 * answers to `chat`'s agent earned it: for a connection's plain write off the floor, signed in, whose objects declare
 * a place its draft names. Unchanged otherwise. Reads only.
 */
export async function withPlace<D extends Offering & { readonly tool: string; readonly args: JsonObject }>(
	tx: Tx,
	chat: number,
	draft: D,
): Promise<D> {
	if (draft.floor !== undefined || draft.permission === undefined) return draft;
	const tool = (await connectionTools(tx)).find((each) => each.name === draft.tool);
	if (tool === undefined || tool.read || tool.readsWhen !== undefined || tool.floor !== undefined) return draft;
	if (!signsIn(tool.connection)) return draft;
	const place = grainsOf(tool.tool, tool.connection.objects)?.place;
	const account = draft.args[accountArg(tool.listed.schema)];
	if (place === undefined || typeof account !== "string") return draft;
	const values: { [placeholder: string]: string } = {};
	for (const [placeholder, arg] of Object.entries(place.args)) {
		const value = draft.args[arg];
		if (typeof value !== "string" || !placeValue(value)) return draft;
		values[placeholder] = value;
	}
	const shape = await grainShape(tx, tool, account, place.words, place.args, values);
	const agent = await agentOfChat(tx, chat);
	const earned = agent !== undefined && (await isEarned(tx, agent, draft.tool, shape.match));
	const shown: PlaceShape = {
		...shape,
		words: grainWords(place.words, values),
		...(earned ? { earned: true as const } : {}),
	};
	return { ...draft, place: shown };
}
