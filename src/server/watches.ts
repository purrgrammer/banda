/**
 * Watches in the box against their accepted versions, as routines are (DESIGN.md "Watches", "The workspace"). A
 * watch file is a "before" file: the owner allows a change by the hash of the text the app showed them ("Follow this?"),
 * and only the store's copy runs. The owner's own actions (following an object from its card, pausing a watch,
 * removing it, checking now) take effect at once.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { log } from "../core/activity.ts";
import { Accepted, activeAgents, agentWords, isArchived, shaOf, unaccept } from "../core/agents.ts";
import { connectionPath, parseConnection } from "../core/connections.ts";
import { withAsk } from "../core/routines.ts";
import { context } from "../core/store.ts";
import {
	ALLOWED_KEPT,
	acceptedWatch,
	accountFor,
	followed,
	type Looked,
	MAX_WATCH_BYTES,
	parseWatch,
	WATCH_NAME,
	type Watch,
	Watches,
	type WatchRecord,
	WatchRefused,
	watchAgent,
	watchPath,
	watchText,
	withUntil,
} from "../core/watches.ts";
import { boxFiles, type Workspace, write } from "./agents.ts";
import type { WatchFileView, WatchState, WatchSummary, WatchView } from "./api.ts";
import { BadRequest } from "./http.ts";

type Reconcile = (harness: Harness, ctx?: Context) => Promise<void>;

const summary = (watch: Watch): WatchSummary => ({
	object: watch.object,
	...(watch.account === undefined ? {} : { account: watch.account }),
	...(watch.until === undefined ? {} : { until: watch.until }),
	ask: watch.ask,
});

const fileView = (name: string, sha: string, text: string): WatchFileView => {
	const parsed = parseWatch(name, text);
	return { sha, ...("watch" in parsed ? { watch: summary(parsed.watch) } : { errors: parsed.errors }) };
};

const watchFiles = (workspace: Workspace, ctx: Context) => boxFiles(workspace, ctx, "watches", MAX_WATCH_BYTES);

/** The words that can end a watch on the kind `ref` names (`github:pull_request:…`), as its accepted connection says. */
function endsOf(accepted: { readonly [path: string]: { readonly text: string } }, connection: string, ref: string) {
	const file = accepted[connectionPath(connection)];
	if (file === undefined) return undefined;
	const parsed = parseConnection(connection, file.text);
	const follow = "connection" in parsed ? parsed.connection.objects?.[ref.split(":")[1] ?? ""]?.follow : undefined;
	return follow === undefined ? undefined : Object.keys(follow.ends);
}

/** How a watch stands, in the one word its row shows. */
function stateOf(view: Omit<WatchView, "state">, record: WatchRecord): WatchState {
	if (view.change !== undefined) return "allow";
	if (record.done !== undefined) return "done";
	if (record.paused === "owner") return "paused";
	if (record.failed !== undefined) return "failing";
	return "active";
}

/** Every watch, accepted or only in the box, with the change the box holds and its state; by name. */
export async function watches(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<WatchView[]> {
	const accepted = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	const records = (await harness.snapshot(Watches, ctx))?.watches ?? {};
	let boxed: Map<string, { text: string } | { unreadable: string }> | undefined;
	try {
		boxed = (await watchFiles(workspace, ctx)).files;
	} catch {
		// the box is down: what is in effect still shows
	}
	const names = new Set([
		...Object.keys(accepted).flatMap((path) => /^watches\/(.+)\.md$/.exec(path)?.slice(1) ?? []),
		...(boxed?.keys() ?? []),
	]);
	const views = [...names].map((name): WatchView => {
		const file = accepted[watchPath(name)];
		const box = boxed?.get(name);
		const record: WatchRecord = records[name] ?? {};
		const change: WatchView["change"] =
			boxed === undefined
				? undefined
				: box === undefined
					? file === undefined || record.edit?.base === null
						? undefined
						: { kind: "removed" }
					: "unreadable" in box
						? { kind: file === undefined ? "added" : "changed", errors: [`${watchPath(name)}: ${box.unreadable}`] }
						: shaOf(box.text) === file?.sha || shaOf(box.text) === record.edit?.base
							? undefined
							: { kind: file === undefined ? "added" : "changed", ...fileView(name, shaOf(box.text), box.text) };
		// the reference its card is read by: as the record says, else from its reading's key (connection/account/rest)
		const ref =
			record.ref ??
			(record.key === undefined
				? undefined
				: `${record.key.split("/")[0] ?? ""}:${record.key.split("/").slice(2).join("/")}`);
		const ends =
			record.connection === undefined || ref === undefined ? undefined : endsOf(accepted, record.connection, ref);
		const object =
			record.key === undefined || ref === undefined || record.name === undefined || record.connection === undefined
				? undefined
				: {
						key: record.key,
						ref,
						name: record.name,
						connection: record.connection,
						service: record.service ?? record.connection,
						...(record.account === undefined ? {} : { account: record.account }),
						...(ends === undefined ? {} : { ends }),
					};
		const view = {
			name,
			...(file === undefined ? {} : { accepted: fileView(name, file.sha, file.text) }),
			...(change === undefined ? {} : { change }),
			agent: watchAgent(record),
			...(object === undefined ? {} : { object }),
			...(record.looked === undefined ? {} : { looked: record.looked }),
			...(record.next === undefined || record.paused !== undefined || record.done !== undefined
				? {}
				: { next: record.next }),
			...(record.saw === undefined ? {} : { saw: [...record.saw] }),
			...(record.sawAt === undefined ? {} : { sawAt: record.sawAt }),
			...(record.failed === undefined
				? {}
				: {
						failed: {
							at: record.failed.at,
							why: record.failed.why,
							since: record.failed.since,
							...(record.failed.run === undefined ? {} : { run: true as const }),
						},
					}),
			...(record.last === undefined ? {} : { lastRun: record.last }),
			...(record.behind === undefined || record.done !== undefined ? {} : { behind: record.behind }),
			...(record.paused === undefined ? {} : { paused: record.paused }),
			...(record.done === undefined ? {} : { done: { ...record.done } }),
			...(record.allowed?.length ? { allowed: [...record.allowed] } : {}),
		};
		return { ...view, state: stateOf(view, record) };
	});
	return views.sort((a, b) => a.name.localeCompare(b.name));
}

const named = (name: string) => {
	if (!WATCH_NAME.test(name)) throw new BadRequest(`"${name}" is not a watch's name`);
	return name;
};

/**
 * Allow the box's change to watch `name`, as the owner saw it: `sha` is the hash of the text shown, or null for a
 * removal. A file changed since is refused, as is one that does not parse. Its task follows at once.
 */
export async function accept(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	sha: string | null,
	now: number,
	ctx: Context = context,
): Promise<void> {
	const box = (await watchFiles(workspace, ctx)).files.get(named(name));
	if (sha === null) {
		if (box !== undefined) throw new BadRequest(`${watchPath(name)} is back in the box: look again`, 409);
		await harness.commit(async (tx) => {
			await unaccept(tx, watchPath(name), now);
			await log(tx, { at: now, watch: name, what: "You removed it" });
		}, ctx);
	} else {
		if (box === undefined || "unreadable" in box || shaOf(box.text) !== sha)
			throw new BadRequest(`${watchPath(name)} changed since you saw it: look again`, 409);
		const parsed = parseWatch(name, box.text);
		if ("errors" in parsed) throw new BadRequest(parsed.errors.join("\n"));
		await harness.commit(async (tx) => {
			const files = (await tx.doc(Accepted)).files;
			const known = files[watchPath(name)] !== undefined;
			files[watchPath(name)] = { sha, text: box.text, at: now };
			const { watches } = await tx.doc(Watches);
			watches[name] ??= {};
			const record = watches[name] as WatchRecord;
			record.allowed = [...(record.allowed ?? []).filter((each) => each !== sha), sha].slice(-ALLOWED_KEPT);
			await log(tx, { at: now, watch: name, what: known ? "You allowed its change" : "You allowed it" });
		}, ctx);
	}
	await reconcile(harness, ctx);
}

/** Decline the box's change to watch `name`: the accepted file is written back, or a new one removed. */
export async function decline(harness: Harness, workspace: Workspace, name: string, ctx: Context = context) {
	const file = (await harness.snapshot(Accepted, ctx))?.files[watchPath(named(name))];
	const env = workspace.env();
	const path = `${workspace.root}/${watchPath(name)}`;
	if (file !== undefined) return write(env, workspace, path, file.text, ctx);
	const removed = await env.remove(path, { force: true }, ctx);
	if (!removed.ok) throw removed.error;
}

/** Remove watch `name`, as the owner: its file goes from the box and the store, and it never looks again. */
export async function remove(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	now: number,
	ctx: Context = context,
): Promise<void> {
	const removed = await workspace.env().remove(`${workspace.root}/${watchPath(named(name))}`, { force: true }, ctx);
	if (!removed.ok) throw removed.error;
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		if (files[watchPath(name)] === undefined) return;
		delete files[watchPath(name)];
		await log(tx, { at: now, watch: name, what: "You removed it" });
	}, ctx);
	await reconcile(harness, ctx);
}

/** Pause watch `name` (or resume it), as the owner: in effect at once. Whether there is such a watch. */
export async function pause(
	harness: Harness,
	reconcile: Reconcile,
	name: string,
	paused: boolean,
	now: number,
	ctx: Context = context,
): Promise<boolean> {
	const found = await harness.commit(async (tx) => {
		const watch = await acceptedWatch(tx, named(name));
		if (watch === undefined) return false;
		const { watches } = await tx.doc(Watches);
		watches[name] ??= {};
		const record = watches[name] as WatchRecord;
		if (paused) record.paused = "owner";
		else if (record.paused !== undefined) {
			delete record.paused;
			// it looks again at once, and what changed meanwhile comes as one wake that says so
			delete record.next;
			record.resumed = now;
		}
		await log(tx, { at: now, watch: name, what: paused ? "You paused it" : "You resumed it" });
		return true;
	}, ctx);
	if (found) await reconcile(harness, ctx);
	return found;
}

/** What the owner changes in a watch, from its detail: what ends it (null: any of the kind's ends), what matters. */
export type WatchChange = { readonly until?: string | null; readonly ask?: string };

/**
 * Change watch `name` as the owner: what ends it and what matters; `sha` is the version in effect they saw. Only the
 * lines changed are rewritten, every other byte kept. It is the owner's edit, so it takes effect at once: the store
 * accepts the new text and notes that the box still needs it, then the box gets it and the note goes, then the task
 * reads the new file. Refused when the version in effect is not the one shown, when `until` is none of the kind's
 * ends, or when the box holds a change of its own waiting to be allowed: an edit over it would allow what the owner
 * never saw. A restart between the two writes finishes the box's (`finishEdits`).
 */
export async function changeWatch(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	name: string,
	change: WatchChange,
	sha: string,
	now: number,
	ctx: Context = context,
): Promise<void> {
	if (change.ask !== undefined && (change.ask.trim() === "" || change.ask.length > 8000))
		throw new BadRequest("say what matters in a few lines");
	const file = (await harness.snapshot(Accepted, ctx))?.files[watchPath(named(name))];
	if (file === undefined) throw new BadRequest(`there is no watch named ${name}`, 404);
	if (file.sha !== sha) throw new BadRequest("it changed since you saw it: look again", 409);
	const box = (await watchFiles(workspace, ctx)).files.get(name);
	if (box !== undefined && "unreadable" in box)
		throw new BadRequest("it has a change waiting for you to allow it: answer that first", 409);
	const pending = (await harness.snapshot(Watches, ctx))?.watches[name]?.edit;
	// the box holds what is in effect, or what was before an edit of the owner's it does not hold yet
	const base = box === undefined ? null : shaOf(box.text);
	if (base !== sha && !(pending?.sha === sha && pending.base === base))
		throw new BadRequest("it has a change waiting for you to allow it: answer that first", 409);
	let text: string | undefined = file.text;
	if (change.until !== undefined) text = withUntil(text, change.until);
	if (change.ask !== undefined && text !== undefined) text = withAsk(text, change.ask);
	const parsed = text === undefined ? undefined : parseWatch(name, text);
	if (text === undefined || parsed === undefined || "errors" in parsed)
		throw new BadRequest(
			parsed !== undefined && "errors" in parsed ? parsed.errors.join("; ") : "it has no frontmatter",
		);
	const changed = shaOf(text);
	if (changed === sha) return;
	const edited = text;
	const until = change.until;
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		if (files[watchPath(name)]?.sha !== sha) throw new BadRequest("it changed since you saw it: look again", 409);
		if (typeof until === "string") {
			const found = await followed(tx, parsed.watch.object);
			const ends = found === undefined ? [] : Object.keys(found.kind.follow.ends);
			if (!ends.includes(until))
				throw new BadRequest(
					ends.length === 0 ? "no connection you have can follow its link" : `until is one of ${ends.join(", ")}`,
				);
		}
		files[watchPath(name)] = { sha: changed, text: edited, at: now };
		const { watches } = await tx.doc(Watches);
		watches[name] ??= {};
		(watches[name] as WatchRecord).edit = { sha: changed, base };
		await log(tx, { at: now, watch: name, what: "You changed it" });
	}, ctx);
	await finishEdit(harness, workspace, name, ctx);
	await reconcile(harness, ctx);
}

/**
 * Write an owner's edit of watch `name` into the box, if one waits: the box gets the accepted text unless it changed
 * to something else since (then that is a change of the box's own, which waits to be allowed), and the note goes.
 */
async function finishEdit(harness: Harness, workspace: Workspace, name: string, ctx: Context): Promise<void> {
	const records = (await harness.snapshot(Watches, ctx))?.watches ?? {};
	const edit = records[name]?.edit;
	if (edit === undefined) return;
	const file = (await harness.snapshot(Accepted, ctx))?.files[watchPath(name)];
	const box = (await watchFiles(workspace, ctx)).files.get(name);
	const text = box === undefined ? undefined : "unreadable" in box ? null : box.text;
	const held =
		edit.base === null ? text === undefined : text !== undefined && text !== null && shaOf(text) === edit.base;
	if (file?.sha === edit.sha && held) {
		if (edit.base === null) {
			const made = await workspace.env().createDir(`${workspace.root}/watches`, { recursive: true }, ctx);
			if (!made.ok) throw made.error;
		}
		await write(workspace.env(), workspace, `${workspace.root}/${watchPath(name)}`, file.text, ctx);
	}
	await harness.commit(async (tx) => {
		const record = (await tx.doc(Watches)).watches[name];
		if (record?.edit?.sha === edit.sha) delete record.edit;
	}, ctx);
}

/** Finish every owner's edit the box does not hold yet: on start, after a restart cut one short. */
export async function finishEdits(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<void> {
	const records = (await harness.snapshot(Watches, ctx))?.watches ?? {};
	for (const [name, record] of Object.entries(records))
		if (record.edit !== undefined) await finishEdit(harness, workspace, name, ctx);
}

/** What the owner follows from an object's card or the panel: whose watch, what, as whom, until what, and what matters. */
export type NewWatch = {
	readonly agent: string;
	readonly object: string;
	readonly account?: string;
	readonly until?: string;
	readonly ask?: string;
};

/** A watch's name from the object's: its words, lowercase, joined by `-` ("acme/banda #142" is acme-banda-142). */
export function nameFor(object: string): string {
	const name = object
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	if (name === "") return "watch";
	return /^[a-z]/.test(name) ? name : `watch-${name}`;
}

/**
 * Follow an object as the owner, from its card or the panel: a file the daemon writes as the owner's own, in effect at
 * once, for agent `agent`, whose chat it wakes. The first look comes before the watch is live: it is the baseline,
 * and a first look that fails makes no watch, the refusal saying why. Its name.
 */
export async function createWatch(
	harness: Harness,
	workspace: Workspace,
	reconcile: Reconcile,
	look: (harness: Harness, name: string, ctx: Context) => Promise<Looked>,
	made: NewWatch,
	now: number,
	ctx: Context = context,
): Promise<string> {
	const object = made.object.trim();
	if (object === "" || object.length > 500) throw new BadRequest("give the link of what to follow");
	const ask =
		(made.ask ?? "").trim() === "" ? "Tell me what changed, in a line, when it matters." : (made.ask as string);
	if (ask.length > 8000) throw new BadRequest("say what matters in a few lines");
	const accepted = (await harness.snapshot(Accepted, ctx))?.files ?? {};
	if (!activeAgents(accepted).includes(made.agent)) throw new BadRequest(`there is no agent named ${made.agent}`, 404);
	const boxed = (await watchFiles(workspace, ctx)).files;
	const { name, text, sha } = await harness.commit(async (tx) => {
		if (await isArchived(tx, made.agent))
			throw new BadRequest(`${await agentWords(tx, made.agent)} is archived: restore it first`, 409);
		const found = await followed(tx, object);
		if (found === undefined) throw new BadRequest("no connection you have can follow that link", 404);
		const ends = Object.keys(found.kind.follow.ends);
		if (made.until !== undefined && !ends.includes(made.until))
			throw new BadRequest(`until is one of ${ends.join(", ")}`);
		const picked = await accountFor(tx, made.agent, found.connection, made.account);
		if ("refused" in picked) throw new BadRequest(picked.refused, 409);
		const objectName = `${found.ref.connection}:${found.ref.kind}:${Object.values(found.ref.values).join("-")}`;
		const base = nameFor(objectName.replace(/^[a-z0-9_-]+:[a-z0-9_]+:/, ""));
		const files = (await tx.doc(Accepted)).files;
		const { watches } = await tx.doc(Watches);
		let name = base;
		for (let n = 2; files[watchPath(name)] !== undefined || boxed.has(name) || watches[name] !== undefined; n++)
			name = `${base}-${n}`;
		const text = watchText({
			object,
			...(picked.id === undefined ? {} : { account: picked.id }),
			...(made.until === undefined ? {} : { until: made.until }),
			ask,
		});
		const parsed = parseWatch(name, text);
		if ("errors" in parsed) throw new BadRequest(parsed.errors.join("; "));
		const sha = shaOf(text);
		files[watchPath(name)] = { sha, text, at: now };
		watches[name] = { agent: made.agent, edit: { sha, base: null }, since: now, sha };
		await log(tx, { at: now, watch: name, what: "You made it" });
		return { name, text, sha };
	}, ctx);
	// the first look, before the watch is live: its baseline
	const first = await look(harness, name, ctx);
	if (first.outcome === "failed" || first.outcome === "gone") {
		await harness.commit(async (tx) => {
			const files = (await tx.doc(Accepted)).files;
			if (files[watchPath(name)]?.sha === sha) delete files[watchPath(name)];
			delete (await tx.doc(Watches)).watches[name];
		}, ctx);
		throw new BadRequest(first.outcome === "failed" ? `it could not be read: ${first.why}` : "it is gone", 502);
	}
	void text;
	await finishEdit(harness, workspace, name, ctx);
	await reconcile(harness, ctx);
	return name;
}

/** Look now at watch `name`'s object, as the owner; once per click `key`. */
export async function checkNow(
	check: (name: string, key: string) => Promise<Looked | { readonly outcome: "already" }>,
	name: string,
	key: string,
): Promise<Looked | { readonly outcome: "already" }> {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) throw new BadRequest("key names the click: letters, digits and dashes");
	try {
		return await check(named(name), key);
	} catch (error) {
		if (error instanceof WatchRefused) throw new BadRequest(error.message, error.status);
		throw error;
	}
}
