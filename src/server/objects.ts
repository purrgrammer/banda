import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Accepted, acceptedAgent } from "../core/agents.ts";
import type { BlobStore } from "../core/blobs.ts";
import { type Attachment, hold, safeName } from "../core/blobs.ts";
import {
	acceptedConnection,
	accountLabel,
	accountsOn,
	Connected,
	type Connection,
	mayUse,
	signsIn,
} from "../core/connections.ts";
import { mimeOf } from "../core/gateway.ts";
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
import { BadRequest } from "./http.ts";

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
			/** Opaque account key for owner-only follow-up reads, never rendered. */
			readonly accountKey?: string;
			/** Execution chat for an owner-only follow-up read; the endpoint rechecks it before acting. */
			readonly authorityChat?: number;
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
	blobs,
	now = Date.now,
	fault = () => {},
}: {
	harness: Harness;
	capabilities: Pick<Capabilities, "readFor" | "listedSchema" | "shipped"> &
		Partial<Pick<Capabilities, "readAttachment">>;
	blobs?: BlobStore;
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
			...(account === "" ? {} : { accountKey: account }),
			authorityChat: chat,
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
	async function attachment(
		chat: number,
		refText: string,
		attachmentId: string,
		agent?: string,
		account?: string,
		ctx: Context = context,
	): Promise<Attachment | undefined> {
		const connections = await known(ctx);
		const refs = recognise(refText, connections);
		const ref = refs.find((candidate) => candidate.connection === "gmail" && candidate.kind === "email");
		if (ref === undefined) return undefined;
		const displayed = (
			await show(
				chat,
				[{ refs: [refText], ...(agent === undefined ? {} : { agent }), ...(account === undefined ? {} : { account }) }],
				false,
				ctx,
			)
		)[0];
		if (
			displayed?.shown !== "card" ||
			displayed.card.card !== "email" ||
			displayed.authorityChat === undefined ||
			displayed.accountKey === undefined
		)
			return undefined;
		if (blobs === undefined || capabilities.readAttachment === undefined)
			throw new BadRequest("Gmail attachment storage is unavailable.", 503);
		let metadata: { id: string; name: string; mimeType: string; size: number; sha?: string } | undefined;
		try {
			const parsed: unknown = JSON.parse(displayed.card.attachmentManifest);
			if (Array.isArray(parsed))
				metadata = parsed.find(
					(each) =>
						typeof each === "object" && each !== null && "id" in each && (each as { id?: unknown }).id === attachmentId,
				) as typeof metadata;
		} catch {
			return undefined;
		}
		if (metadata === undefined) return undefined;
		if (metadata.size > 10 * 1024 * 1024) throw new BadRequest("That attachment is larger than 10 MB.");
		const authorityChat = displayed.authorityChat;
		const accountKey = displayed.accountKey;
		const access = await harness.commit((tx) => objectAccess(tx, authorityChat, ref, accountKey), ctx);
		if (access === undefined) return undefined;
		const key = readingKey(accountKey, displayed.key);
		const reading = (await harness.snapshot(Readings, ctx))?.readings[key];
		if (
			reading?.source !== access.source ||
			reading.card?.card !== "email" ||
			reading.card.attachmentManifest !== displayed.card.attachmentManifest
		)
			return undefined;
		const name = safeName(metadata.name);
		const mimeType = mimeOf(name);
		if (metadata.sha !== undefined) {
			const bytes = await blobs.read(metadata.sha).catch(() => undefined);
			if (
				bytes !== undefined &&
				(await harness.commit((tx) => objectAccess(tx, authorityChat, ref, accountKey), ctx))?.stamp === access.stamp
			)
				return { sha: metadata.sha, name, mimeType, size: bytes.length };
		}
		fault("object:attachment:read");
		const fetched = await capabilities.readAttachment(
			"gmail",
			accountKey,
			ref.values.id ?? "",
			attachmentId,
			{ chat: authorityChat, ref, stamp: access.stamp },
			ctx,
		);
		if ("failed" in fetched) throw new BadRequest(`Gmail could not open that attachment: ${fetched.failed}`, 502);
		if (metadata.size > 0 && metadata.size !== fetched.bytes.length)
			throw new BadRequest("Gmail returned an attachment with a different size.", 502);
		fault("object:attachment:received");
		return blobs.exclusive(async () => {
			const sha = await blobs.put(fetched.bytes);
			const file = { sha, name, mimeType, size: fetched.bytes.length };
			fault("object:attachment:stored");
			const kept = await harness.commit(async (tx) => {
				if ((await objectAccess(tx, authorityChat, ref, accountKey))?.stamp !== access.stamp) return false;
				const doc = await tx.doc(Readings);
				const current = doc.readings[key];
				if (current?.source !== access.source || current.card?.card !== "email") return false;
				let manifest: unknown;
				try {
					manifest = JSON.parse(current.card.attachmentManifest);
				} catch {
					return false;
				}
				if (!Array.isArray(manifest)) return false;
				let matched = false;
				const updated = manifest.map((each) => {
					if (typeof each !== "object" || each === null || !("id" in each) || each.id !== attachmentId) return each;
					matched = true;
					return { ...each, sha };
				});
				if (!matched) return false;
				doc.readings[key] = {
					...current,
					card: { ...current.card, attachmentManifest: JSON.stringify(updated) },
				};
				await hold(tx, authorityChat, file, "connection", now(), { connection: "gmail", account: accountKey });
				return true;
			}, ctx);
			if (!kept) return undefined;
			fault("object:attachment:kept");
			if ((await harness.commit((tx) => objectAccess(tx, authorityChat, ref, accountKey), ctx))?.stamp !== access.stamp)
				return undefined;
			return file;
		});
	}
	return { show, attachment };
}
export type Objects = ReturnType<typeof openObjects>;
