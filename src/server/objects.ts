import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Accepted, acceptedAgent } from "../core/agents.ts";
import {
	acceptedConnection,
	accountLabel,
	accountsOn,
	Connected,
	type Connection,
	mayUse,
	signsIn,
} from "../core/connections.ts";
import { Groups } from "../core/groups.ts";
import { objectAccess } from "../core/object-access.ts";
import {
	cardOf,
	keepReading,
	nameOf,
	type ObjectCard,
	type ObjectRef,
	type Reading,
	Readings,
	readArgs,
	readingKey,
	recognise,
	refKey,
} from "../core/objects.ts";
import { agentOfChat } from "../core/permissions.ts";
import { context } from "../core/store.ts";
import type { Capabilities } from "./capabilities.ts";

export const PER_MESSAGE = 3;
export const OLD = 60 * 60_000;
/** Account and agent select authority; neither confers it, even on a draft. */
export type ObjectAsk = (
	| { readonly ref: string }
	| { readonly refs: readonly string[]; readonly account?: string | undefined }
) & { readonly agent?: string };
export type ObjectShown =
	| { readonly shown: "link" }
	| { readonly shown: "connect"; readonly connection: string }
	| {
			readonly shown: "card";
			readonly key: string;
			readonly connection: string;
			readonly service: string;
			readonly account?: string;
			readonly name: string;
			readonly at: number;
			readonly old: boolean;
			readonly card: ObjectCard;
			readonly subject?: ObjectShown;
	  }
	| {
			readonly shown: "failed";
			readonly key: string;
			readonly connection: string;
			readonly service: string;
			readonly account?: string;
			readonly name: string;
			readonly at: number;
			readonly why: string;
	  };
type Known = Connection & { readonly accepted: boolean; readonly missing?: boolean };
type Attempt = {
	chat: number;
	ref: ObjectRef;
	account: string;
	stamp: string;
	result: Promise<Reading | undefined>;
};

/** Readings are display data only. No entries, model requests, tasks or writes are made here. */
export function openObjects({
	harness,
	capabilities,
	now = Date.now,
	fault = () => {},
}: {
	harness: Harness;
	capabilities: Pick<Capabilities, "readFor" | "listedSchema" | "shipped">;
	now?: () => number;
	fault?: (point: string) => void;
}) {
	const inFlight = new Map<string, Promise<Reading | undefined>>();
	async function known(ctx: Context): Promise<Known[]> {
		const accepted = await harness.commit(async (tx) => {
			const out: Known[] = [];
			for (const path of Object.keys((await tx.doc(Accepted)).files).sort()) {
				const name = /^connections\/(.+)\.md$/.exec(path)?.[1];
				const connection = name === undefined ? undefined : await acceptedConnection(tx, name);
				if (connection !== undefined) out.push({ ...connection, accepted: true });
			}
			return out;
		}, ctx);
		for (const shipped of await capabilities.shipped()) {
			const old = accepted.findIndex((c) => c.name === shipped.name);
			if (old < 0) accepted.push({ ...shipped, accepted: false });
			else if (accepted[old]?.objects === undefined) accepted[old] = { ...shipped, accepted: true, missing: true };
		}
		return accepted;
	}
	async function reading(
		chat: number,
		ref: ObjectRef,
		account: string,
		refresh: boolean,
		ctx: Context,
	): Promise<Reading | undefined> {
		const access = await harness.commit((tx) => objectAccess(tx, chat, ref, account), ctx);
		if (access === undefined) return undefined;
		const key = readingKey(account, refKey(ref, access.connection.objects ?? {}));
		const kept = (await harness.snapshot(Readings, ctx))?.readings[key];
		if (kept?.source === access.source && !refresh) return kept;
		// Different agents cannot lend an in-flight authority check to one another.
		const flight = JSON.stringify([chat, key, access.stamp]);
		const going = inFlight.get(flight);
		if (going !== undefined) return going;
		// A bounded daemon-wide fanout, including many simultaneous requests.
		if (inFlight.size >= 8) return undefined;
		const started = (async () => {
			const answers: Record<string, unknown> = {};
			let failed: string | undefined;
			for (const [as, each] of Object.entries(access.reads)) {
				const current = await harness.commit((tx) => objectAccess(tx, chat, ref, account), ctx);
				if (current?.stamp !== access.stamp) return undefined;
				const schema = await capabilities.listedSchema(ref.connection, each.tool, ctx);
				const answer = await capabilities.readFor(
					ref.connection,
					account,
					each.tool,
					readArgs(each, ref, schema),
					{ chat, ref, stamp: access.stamp },
					ctx,
				);
				if ("failed" in answer) {
					if (each.optional) continue;
					failed = answer.failed;
					break;
				}
				if (answer.text.length > 1_000_000) {
					if (each.optional) continue;
					failed = "The reading was too large.";
					break;
				}
				try {
					answers[as] = JSON.parse(answer.text) as unknown;
				} catch {
					if (each.optional) continue;
					failed = "The service did not return an object.";
					break;
				}
			}
			let card: ObjectCard | undefined;
			if (failed === undefined) {
				try {
					card = cardOf(access.kind, ref, answers);
				} catch {
					failed = "The service returned an incomplete reading.";
				}
			}
			const found: Reading = {
				connection: ref.connection,
				account,
				kind: ref.kind,
				source: access.source,
				at: now(),
				...(card === undefined ? { failed: failed ?? "The object could not be read." } : { card }),
			};
			fault("object:answered");
			const stored = await harness.commit(async (tx) => {
				if ((await objectAccess(tx, chat, ref, account))?.stamp !== access.stamp) return false;
				await keepReading(tx, key, found);
				return true;
			}, ctx);
			if (!stored) return undefined;
			fault("object:kept");
			return found;
		})().finally(() => inFlight.delete(flight));
		inFlight.set(flight, started);
		return started;
	}
	async function drawn(
		connection: Known,
		refs: readonly ObjectRef[],
		chat: number,
		account: string,
		refresh: boolean,
		attempts: Map<string, Attempt>,
		ctx: Context,
		depth = 0,
	): Promise<ObjectShown> {
		const kinds = connection.objects ?? {};
		let last: { ref: ObjectRef; found: Reading; stamp: string } | undefined;
		for (const ref of refs.slice(0, 4)) {
			const access = await harness.commit((tx) => objectAccess(tx, chat, ref, account), ctx);
			if (access === undefined) return { shown: "link" };
			// A request may reach this candidate through a URL, shorthand fallback or notification subject.
			// Share successes AND failures, but never across an authority generation or another request's Retry.
			const key = JSON.stringify([chat, account, refKey(ref, access.connection.objects ?? {}), access.stamp]);
			let attempt = attempts.get(key);
			if (attempt === undefined) {
				attempt = { chat, ref, account, stamp: access.stamp, result: reading(chat, ref, account, refresh, ctx) };
				attempts.set(key, attempt);
			}
			const found = await attempt.result;
			if (found === undefined) return { shown: "link" };
			last = { ref, found, stamp: access.stamp };
			if (found.card !== undefined) break;
		}
		if (last === undefined) return { shown: "link" };
		const { ref, found, stamp } = last;
		const label =
			account === ""
				? undefined
				: accountLabel((await harness.snapshot(Connected, ctx))?.accounts[connection.name]?.[account]?.id ?? account);
		const base = {
			key: refKey(ref, kinds),
			connection: connection.name,
			service: connection.service,
			...(label === undefined ? {} : { account: label }),
			name: nameOf(ref, kinds),
			at: found.at,
		};
		if ((await harness.commit((tx) => objectAccess(tx, chat, ref, account), ctx))?.stamp !== stamp)
			return { shown: "link" };
		if (found.card === undefined)
			return { shown: "failed", ...base, why: found.failed ?? "The object could not be read." };
		let subject: ObjectShown | undefined;
		if (found.card.card === "notification" && found.card.subject !== undefined && depth === 0) {
			const named = recognise(found.card.subject, [connection]).filter((r) => kinds[r.kind]?.card !== "notification");
			if (named.length > 0) subject = await drawn(connection, named, chat, account, refresh, attempts, ctx, 1);
		}
		// A revocation during the subject read must also hide the notification.
		if ((await harness.commit((tx) => objectAccess(tx, chat, ref, account), ctx))?.stamp !== stamp)
			return { shown: "link" };
		return {
			shown: "card",
			...base,
			old: now() - found.at > OLD,
			card: found.card,
			...(subject === undefined ? {} : { subject }),
		};
	}
	async function show(
		chat: number,
		asks: readonly ObjectAsk[],
		refresh = false,
		ctx: Context = context,
	): Promise<ObjectShown[]> {
		const connections = await known(ctx);
		const out: ObjectShown[] = [];
		const seen = new Set<string>();
		const rendered = new Set<string>();
		const attempts = new Map<string, Attempt>();
		let count = 0;
		for (const ask of asks.slice(0, 8)) {
			const refs = ("ref" in ask ? [ask.ref] : ask.refs.slice(0, 4)).flatMap((r) => recognise(r, connections));
			const connection = connections.find((c) => c.name === refs[0]?.connection);
			const own = refs.filter((r) => r.connection === connection?.name).slice(0, 4);
			const first = own[0];
			if (connection === undefined || first === undefined || count >= PER_MESSAGE) {
				out.push({ shown: "link" });
				continue;
			}
			const identity = JSON.stringify([ask.agent, "account" in ask ? ask.account : undefined, own]);
			if (seen.has(identity)) {
				out.push({ shown: "link" });
				continue;
			}
			seen.add(identity);
			count++;
			if (connection.missing) {
				out.push({
					shown: "failed",
					key: refKey(first, connection.objects ?? {}),
					connection: connection.name,
					service: connection.service,
					name: nameOf(first, connection.objects ?? {}),
					at: now(),
					why: "This connection has no object definitions. Accept the current connection file to show cards.",
				});
				continue;
			}
			const selected = await harness.commit(async (tx) => {
				const group = (await tx.doc(Groups)).groups[chat];
				const direct = await agentOfChat(tx, chat);
				const members = group === undefined ? (direct === undefined ? [] : [direct]) : group.members;
				for (const id of members) {
					if (ask.agent !== undefined && ask.agent !== id) continue;
					const agent = await acceptedAgent(tx, id);
					if (agent === undefined || agent.state !== "active" || !mayUse(agent, connection.name)) continue;
					const execution = group === undefined ? chat : group.executions[id]?.chat;
					if (execution === undefined) continue;
					const accounts = await accountsOn(tx, id, connection.name);
					const account = signsIn(connection)
						? "account" in ask && ask.account !== undefined
							? ask.account
							: accounts[0]
						: "";
					if (account !== undefined && (!signsIn(connection) || accounts.includes(account)))
						return { chat: execution, account };
				}
				return undefined;
			}, ctx);
			if (!connection.accepted || selected === undefined) {
				out.push({ shown: "connect", connection: connection.name });
				continue;
			}
			const keyFor = (key: string) => JSON.stringify([selected.chat, selected.account, key]);
			const shown = await drawn(connection, own, selected.chat, selected.account, refresh, attempts, ctx);
			if (shown.shown === "card" || shown.shown === "failed") {
				const key = keyFor(shown.key);
				if (rendered.has(key)) {
					count--;
					out.push({ shown: "link" });
					continue;
				}
				rendered.add(key);
			}
			out.push(shown);
		}
		// Publication is the whole response, not each earlier card: a later read may have crossed a revocation.
		const valid = await harness.commit(async (tx) => {
			for (const attempt of attempts.values()) {
				if ((await objectAccess(tx, attempt.chat, attempt.ref, attempt.account))?.stamp !== attempt.stamp) return false;
			}
			return true;
		}, ctx);
		return valid ? out : out.map(() => ({ shown: "link" }));
	}
	return { show };
}
export type Objects = ReturnType<typeof openObjects>;
