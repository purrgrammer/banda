/**
 * Agent files in the box against their accepted versions (DESIGN.md "The workspace"): what the web lists, and the
 * owner's accept, decline and save. The box's bytes are data until accepted: an accept binds the hash the owner saw,
 * and only the store's copy ever starts a chat. Files are read without following a symbolic link.
 */
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Harness, ModelRef, Tx } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	Accepted,
	type AcceptedFile,
	AGENT_NAME,
	activeAgents,
	agentPath,
	LEAD,
	MAX_AGENT_BYTES,
	parseAgent,
	shaOf,
	unaccept,
} from "../core/agents.ts";
import { sizeOf } from "../core/blobs.ts";

import { context } from "../core/store.ts";
import type { AgentView } from "./api.ts";
import { BadRequest } from "./http.ts";

export type Workspace = {
	/** The box, at the workspace. */
	readonly env: () => ExecutionEnv;
	readonly root: string;
	/** Every tool there is, which an agent file may name. */
	readonly tools: () => readonly string[];
	/** Whether the daemon knows a model. */
	readonly known: (model: ModelRef) => boolean;
};

/** Reconcile chats in the same commit that changes which definition is accepted. */
export type AgentChanged = (tx: Tx, name: string) => Promise<void>;

/** A file of the box's, as the daemon read it: its text, or why it cannot be one. */
type Read = { readonly text: string } | { readonly unreadable: string };

const dirOf = (workspace: Workspace, folder = "agents") => `${workspace.root}/${folder}`;

/** A folder of "before" files as the daemon read it: each file's text, by name. */
type Listing = { readonly files: Map<string, Read> };

/**
 * A folder of "before" files in the box (`agents`, `routines`): `<folder>/<name>.md` regular files, none of them through a
 * link, each up to `max` bytes.
 */
export async function boxFiles(
	workspace: Workspace,
	ctx: Context,
	folder = "agents",
	max = MAX_AGENT_BYTES,
): Promise<Listing> {
	const env = workspace.env();
	const listed = await env.listDir(dirOf(workspace, folder), ctx);
	const listing: Listing = { files: new Map() };
	if (!listed.ok) {
		if (listed.error.code === "not_found") return listing;
		throw listed.error;
	}
	for (const entry of listed.value) {
		const [, name = "", extension = ""] = /^(.+)\.([a-z]+)$/.exec(entry.name) ?? [];
		if (!AGENT_NAME.test(name) || entry.kind !== "file" || extension !== "md") continue;
		const read = await readBytes(env, `${dirOf(workspace, folder)}/${entry.name}`, max, ctx);
		listing.files.set(name, "bytes" in read ? textOf(read.bytes) : read);
	}
	return listing;
}

export function textOf(bytes: Uint8Array): Read {
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { unreadable: "it is not UTF-8 text" };
	}
}

/** A box file's bytes, up to `max`, never through a link. */
export async function readBytes(
	env: ExecutionEnv,
	path: string,
	max: number,
	ctx: Context,
): Promise<{ readonly bytes: Uint8Array } | { readonly unreadable: string }> {
	const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
	if (!opened.ok)
		return { unreadable: opened.error.code === "invalid" ? "it is a link, not a file" : opened.error.message };
	const reader = opened.value;
	try {
		const info = await reader.info(ctx);
		if (!info.ok) return { unreadable: info.error.message };
		if (info.value.size > max) return { unreadable: `it is ${sizeOf(info.value.size)}; it may be ${sizeOf(max)}` };
		const bytes = await reader.read(0, info.value.size, ctx);
		return bytes.ok ? { bytes: bytes.value } : { unreadable: bytes.error.message };
	} finally {
		await reader.close(ctx);
	}
}

const check = (workspace: Workspace, name: string, text: string) =>
	parseAgent(name, text, { tools: workspace.tools(), known: workspace.known });

/**
 * Refuse a change that would leave no active agent (`text`: agent `name`'s file after it, undefined once removed): the
 * app opens in a chat, so the last active agent cannot be archived. Read in the commit that makes the change.
 */
async function keepOneActive(tx: Tx, name: string, text: string | undefined): Promise<void> {
	const files = { ...(await tx.doc(Accepted)).files };
	if (text === undefined) delete files[agentPath(name)];
	else files[agentPath(name)] = { sha: shaOf(text), text, at: 0 };
	if (activeAgents(files).length === 0)
		throw new BadRequest(
			"this is the last active agent, and the app opens in a chat: make or restore another first",
			409,
		);
}

/**
 * What was accepted, read as the daemon runs it: a tool name the daemon no longer has does not undo the agent (the
 * strict check is for a change the owner is about to accept, `check`).
 */
const view = (workspace: Workspace, name: string, file: AcceptedFile) => {
	const parsed = parseAgent(name, file.text, { known: workspace.known });
	return {
		sha: file.sha,
		text: file.text,
		at: file.at,
		...("agent" in parsed ? { agent: parsed.agent } : { errors: parsed.errors }),
	};
};

/** Every agent, accepted or only in the box, with the change the box holds for it; the lead first, then by name. */
export async function agents(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<AgentView[]> {
	const doc = await harness.snapshot(Accepted, ctx);
	const accepted = doc?.files ?? {};
	const { files: boxed } = await boxFiles(workspace, ctx);
	const names = new Set([
		...Object.keys(accepted).flatMap((path) => /^agents\/(.+)\.md$/.exec(path)?.slice(1) ?? []),
		...boxed.keys(),
	]);
	const rows = [...names].map((name): AgentView => {
		const file = accepted[agentPath(name)];
		const box = boxed.get(name);
		const change =
			box === undefined
				? file === undefined || doc?.seeded !== true
					? undefined
					: ({ kind: "removed" } as const)
				: "unreadable" in box
					? ({
							kind: file === undefined ? "added" : "changed",
							errors: [`agents/${name}.md: ${box.unreadable}`],
						} as const)
					: shaOf(box.text) === file?.sha
						? undefined
						: (() => {
								const parsed = check(workspace, name, box.text);
								return {
									kind: file === undefined ? ("added" as const) : ("changed" as const),
									sha: shaOf(box.text),
									text: box.text,
									...("errors" in parsed ? { errors: parsed.errors } : { agent: parsed.agent }),
								};
							})();
		return {
			name,
			...(file === undefined ? {} : { accepted: view(workspace, name, file) }),
			...(change === undefined ? {} : { change }),
		};
	});
	return rows.sort((a, b) => (a.name === LEAD ? -1 : b.name === LEAD ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Accept the box's change to agent `name`, as the owner saw it: `sha` is the hash of the text shown, or null for a
 * removal. A file changed since is refused, as is one that does not parse, and the lead's removal.
 */
export async function accept(
	harness: Harness,
	workspace: Workspace,
	name: string,
	sha: string | null,
	changed: AgentChanged,
	ctx: Context = context,
): Promise<AgentView[]> {
	const box = (await boxFiles(workspace, ctx)).files.get(name);
	if (sha === null) {
		if (name === LEAD)
			throw new BadRequest(`${LEAD} is the lead and cannot be removed: decline, and its file is written back`);
		if (box !== undefined) throw new BadRequest(`agents/${name}.md is back in the box: look again`, 409);
		if ((await harness.snapshot(Accepted, ctx))?.seeded !== true)
			throw new BadRequest(`agents/${name}.md is not in the box yet: the daemon writes it there first`, 409);
		await harness.commit(async (tx) => {
			await keepOneActive(tx, name, undefined);
			await unaccept(tx, agentPath(name), Date.now());
			await changed(tx, name);
		}, ctx);
		return agents(harness, workspace, ctx);
	}
	if (box === undefined || "unreadable" in box || shaOf(box.text) !== sha)
		throw new BadRequest(`agents/${name}.md changed since you saw it: look again`, 409);
	const parsed = check(workspace, name, box.text);
	if ("errors" in parsed) throw new BadRequest(parsed.errors.join("\n"));
	await harness.commit(async (tx) => {
		await keepOneActive(tx, name, box.text);
		(await tx.doc(Accepted)).files[agentPath(name)] = { sha, text: box.text, at: Date.now() };
		await changed(tx, name);
	}, ctx);
	return agents(harness, workspace, ctx);
}

/** Decline the box's change to agent `name`: the accepted file is written back, or a new one removed. */
export async function decline(
	harness: Harness,
	workspace: Workspace,
	name: string,
	ctx: Context = context,
): Promise<AgentView[]> {
	if (!AGENT_NAME.test(name)) throw new BadRequest(`"${name}" is not an agent name`);
	const file = (await harness.snapshot(Accepted, ctx))?.files[agentPath(name)];
	const env = workspace.env();
	const path = `${dirOf(workspace)}/${name}.md`;
	if (file === undefined) {
		const removed = await env.remove(path, { force: true }, ctx);
		if (!removed.ok) throw removed.error;
	} else await write(env, workspace, path, file.text, ctx);
	return agents(harness, workspace, ctx);
}

/**
 * Save the owner's own text for agent `name`, in effect at once, as the owner wrote it. `base` is the accepted hash the
 * owner edited (null for a new agent); a file the box or another save changed since is refused, so nothing is lost.
 * A new agent (`base` null) with no accepted file may still supersede an unaccepted proposal the box wrote: the owner
 * reviewed it, and their version, written and accepted together, takes the box file's place.
 */
export async function save(
	harness: Harness,
	workspace: Workspace,
	name: string,
	text: string,
	base: string | null,
	changed: AgentChanged,
	ctx: Context = context,
): Promise<AgentView[]> {
	const bytes = Buffer.byteLength(text);
	if (bytes > MAX_AGENT_BYTES)
		throw new BadRequest(`the file is ${sizeOf(bytes)}; an agent file may be ${sizeOf(MAX_AGENT_BYTES)}`);
	const parsed = check(workspace, name, text);
	if ("errors" in parsed) throw new BadRequest(parsed.errors.join("\n"));
	const accepted = (await harness.snapshot(Accepted, ctx))?.files[agentPath(name)];
	const box = (await boxFiles(workspace, ctx)).files.get(name);
	const boxSha = box === undefined ? null : "text" in box ? shaOf(box.text) : "unreadable";
	if (base === null) {
		if (accepted !== undefined) throw new BadRequest(`there is already an agent named ${name}`, 409);
		// no accepted file: the box may hold an unaccepted proposal, which the owner's reviewed version supersedes
	} else if ((accepted?.sha ?? null) !== base || boxSha !== base)
		throw new BadRequest(`agents/${name}.md changed since you opened it: copy your text, and look again`, 409);
	// refused before the box is written: a file the store would not take never reaches it
	await harness.commit((tx) => keepOneActive(tx, name, text), ctx);
	await write(workspace.env(), workspace, `${dirOf(workspace)}/${name}.md`, text, ctx);
	await harness.commit(async (tx) => {
		await keepOneActive(tx, name, text);
		(await tx.doc(Accepted)).files[agentPath(name)] = { sha: shaOf(text), text, at: Date.now() };
		await changed(tx, name);
	}, ctx);
	return agents(harness, workspace, ctx);
}

/**
 * Write the accepted agent files into the box until the store records it done: a new box starts with the lead. Until
 * then each accepted file the box lacks is written, whatever else made the folder first (an owner's save, a
 * cut seed); once done, a file missing there is the box's own removal. A box made anew, its agents folder gone, is
 * seeded again. Idempotent; a failure is thrown, and the next call goes on.
 */
export async function seed(harness: Harness, workspace: Workspace, ctx: Context = context): Promise<void> {
	const env = workspace.env();
	// The first owner edit can arrive before a chat starts and initializes the accepted definition.
	let doc = await harness.snapshot(Accepted, ctx);
	if (doc === undefined) {
		await harness.commit(async (tx) => {
			await tx.doc(Accepted);
		}, ctx);
		doc = await harness.snapshot(Accepted, ctx);
	}
	const there = await env.exists(dirOf(workspace), ctx);
	if (!there.ok) throw there.error;
	if (doc?.seeded === true && there.value) return;
	// Persist the unfinished restoration before its first write recreates the folder.
	if (doc?.seeded === true)
		await harness.commit(async (tx) => {
			delete (await tx.doc(Accepted)).seeded;
		}, ctx);
	const { files: boxed } = await boxFiles(workspace, ctx);
	for (const [path, file] of Object.entries(doc?.files ?? {})) {
		const name = /^agents\/(.+)\.md$/.exec(path)?.[1];
		if (name !== undefined && !boxed.has(name)) await seedFile(env, workspace, path, file.text, ctx);
	}
	await harness.commit(async (tx) => {
		(await tx.doc(Accepted)).seeded = true;
	}, ctx);
}

async function seedFile(env: ExecutionEnv, workspace: Workspace, path: string, text: string, ctx: Context) {
	const temporary = `${workspace.root}/.banda-seed-${shaOf(`${path}\0${text}`)}.tmp`;
	try {
		await write(env, workspace, temporary, text, ctx);
		const flushed = await env.flushFile(temporary, ctx);
		if (!flushed.ok) throw flushed.error;
		const target = `${workspace.root}/${path}`;
		const made = await env.createDir(posix.dirname(target), { recursive: true }, ctx);
		if (!made.ok) throw made.error;
		const published = await env.renameFile(temporary, target, ctx);
		if (!published.ok) throw published.error;
	} finally {
		await env.remove(temporary, { force: true }, ctx);
	}
}

/** Write a workspace file, its folder made first. */
export async function write(env: ExecutionEnv, _workspace: Workspace, path: string, text: string, ctx: Context) {
	const made = await env.createDir(posix.dirname(path), { recursive: true }, ctx);
	if (!made.ok) throw made.error;
	const written = await env.writeFile(path, text, ctx);
	if (!written.ok) throw written.error;
}
