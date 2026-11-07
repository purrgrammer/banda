/**
 * Permissions at a wider grain (DESIGN.md "Permissions"): given by the owner from an agent's Access, not by answering
 * an ask, for a write its connection's objects say may be allowed at its kind's place or anywhere. One binds the account
 * the write acts as, always, and for a place the arguments that name it; every other argument is free, so a later
 * call is within it whatever object it acts on there. Its words are the daemon's, from the connection's data.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness, JsonObject } from "@earendil-works/pi-durable";
import { log } from "./activity.ts";
import { acceptedAgent, agentWords, LEAD } from "./agents.ts";
import { accountArg, accountLabel, accountsOn, Connected, connectionTools, signsIn } from "./connections.ts";
import { type Grain, grainsOf, grainWords, placeValue } from "./objects.ts";
import {
	canonical,
	FLOOR_WORDS,
	isOpen,
	type PermissionScope,
	Permissions,
	permissionWhen,
	refusal,
} from "./permissions.ts";
import { context } from "./store.ts";
import { answerCovered, BY_PERMISSION, coveredAsks } from "./wait.ts";

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
		const match: JsonObject = { [accountArg(tool.listed.schema)]: asked.account };
		for (const [placeholder, arg] of Object.entries(args)) match[arg] = values[placeholder] as string;
		const login = (await tx.doc(Connected)).accounts[asked.connection]?.[asked.account]?.id ?? asked.account;
		const what = `${grainWords(grain.words, values)} as ${accountLabel(login)}`;
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
			BY_PERMISSION,
			now,
		);
		return { id: id, what };
	}, ctx);
}
