import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, symlink } from "node:fs/promises";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";
import { Accepted, type AcceptedFile, agentPath, MAX_AGENT_BYTES, shaOf } from "../core/agents.ts";
import { context } from "../core/store.ts";
import type { Workspace } from "./agents.ts";
import type { AgentPublicationHistory, AgentPublicationView, RetainedAgentFile } from "./api.ts";
import { BadRequest } from "./http.ts";

type PublicationState =
	| { kind: "pending" }
	| { kind: "published" }
	| { kind: "conflict"; message: string }
	| { kind: "superseded" };

type Publication = {
	id: number;
	name: string;
	file: AcceptedFile | null;
	base: string | null;
	workingBase: string | null;
	at: number;
	state: PublicationState;
};

export const AGENT_PUBLICATION_POINTS = [
	"agent:directory:before",
	"agent:directory:after",
	"agent:stage:before",
	"agent:stage:after",
	"agent:retain:before",
	"agent:retain:after",
	"agent:insert:before",
	"agent:insert:after",
] as const;
export type AgentPublicationPoint = (typeof AGENT_PUBLICATION_POINTS)[number];

class AgentPublicationIOError extends Error {}

async function io<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		throw new AgentPublicationIOError(
			"Your change is saved. The computer will finish updating its file when available.",
			{ cause },
		);
	}
}

export const AgentPublications = defineDoc<{
	next: number;
	current: { [name: string]: number };
	operations: { [id: string]: Publication };
}>({
	kind: "banda.agent-publications",
	version: 1,
	scope: "session",
	initial: () => ({ next: 1, current: {}, operations: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export async function supersedeAgentPublication(tx: Tx, name: string): Promise<void> {
	const doc = await tx.doc(AgentPublications);
	const operation = doc.operations[String(doc.current[name])];
	if (operation !== undefined) operation.state = { kind: "superseded" };
}

export async function queueAgentPublication(
	tx: Tx,
	edit: {
		name: string;
		file: AcceptedFile | null;
		base: string | null;
		workingBase: string | null;
		expectedId?: string;
	},
): Promise<void> {
	const accepted = (await tx.doc(Accepted)).files[agentPath(edit.name)];
	if ((accepted?.sha ?? null) !== edit.base)
		throw new BadRequest(`agents/${edit.name}.md changed since you opened it: your text is still here`, 409);
	if (edit.expectedId !== undefined) {
		const doc = await tx.doc(AgentPublications);
		const operation = doc.operations[String(doc.current[edit.name])];
		if (
			operation === undefined ||
			String(operation.id) !== edit.expectedId ||
			operation.state.kind === "superseded" ||
			(operation.file?.sha ?? null) !== (accepted?.sha ?? null)
		)
			throw new BadRequest("This change was updated. Review it again.", 409);
	}
	await supersedeAgentPublication(tx, edit.name);
	const doc = await tx.doc(AgentPublications);
	const id = doc.next++;
	doc.current[edit.name] = id;
	const { expectedId: _expectedId, ...operation } = edit;
	doc.operations[String(id)] = { ...operation, id, at: Date.now(), state: { kind: "pending" } };
}

const folder = (workspace: Workspace, id: number) => `${workspace.root}/agents/.banda-publications/${id}`;
const previous = (workspace: Workspace, id: number) => `${folder(workspace, id)}/previous`;

function must(result: { ok: true } | { ok: false; error: Error }) {
	if (!result.ok) throw result.error;
}

async function fileInfo(env: ExecutionEnv, path: string, ctx: Context): Promise<FileInfo | undefined> {
	return io(async () => {
		const result = await env.fileInfo(path, ctx);
		if (result.ok) return result.value;
		if (result.error.code === "not_found") return undefined;
		throw result.error;
	});
}

type File = { kind: "missing" } | { kind: "text"; text: string; sha: string } | { kind: "unreadable"; message: string };

async function read(env: ExecutionEnv, path: string, ctx: Context): Promise<File> {
	const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
	if (!opened.ok)
		return opened.error.code === "not_found"
			? { kind: "missing" }
			: { kind: "unreadable", message: opened.error.message };
	try {
		const info = await opened.value.info(ctx);
		if (!info.ok) throw info.error;
		if (info.value.size > MAX_AGENT_BYTES)
			return { kind: "unreadable", message: "This earlier version is too large to preview." };
		const got = await opened.value.read(0, info.value.size, ctx);
		if (!got.ok) throw got.error;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(got.value);
			return { kind: "text", text, sha: shaOf(text) };
		} catch {
			return { kind: "unreadable", message: "This earlier version is not UTF-8 text." };
		}
	} finally {
		await opened.value.close(ctx);
	}
}

async function retained(workspace: Workspace, operation: Publication, ctx: Context): Promise<RetainedAgentFile[]> {
	const path = previous(workspace, operation.id);
	const file = await Promise.resolve()
		.then(() => read(workspace.env(), path, ctx))
		.catch((): File => ({ kind: "unreadable", message: "This earlier version is temporarily unavailable." }));
	return file.kind === "missing"
		? []
		: file.kind === "text"
			? [{ kind: "text", path, text: file.text, sha: file.sha }]
			: [{ kind: "unreadable", path, message: file.message }];
}

async function insert(env: ExecutionEnv, source: string, target: string, ctx: Context): Promise<boolean> {
	if (env.id === "node:local") {
		try {
			await link(source, target);
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
			throw error;
		}
	}
	const parent = posix.dirname(target);
	const linked = await env.exec(
		["/bin/ln", "-T", "-P", "--", posix.relative(parent, source), posix.basename(target)],
		{ cwd: parent, timeout: 10_000 },
		ctx,
	);
	if (!linked.ok) throw linked.error;
	if (linked.value.exitCode === 0) return true;
	if ((await fileInfo(env, target, ctx)) !== undefined) return false;
	throw new Error("The computer could not preserve both file versions. Your saved version is kept.");
}

async function restore(env: ExecutionEnv, source: string, target: string, ctx: Context): Promise<boolean> {
	const info = await fileInfo(env, source, ctx);
	if (info === undefined) throw new Error("The preserved version is temporarily unavailable.");
	if (info.kind !== "directory") return insert(env, source, target, ctx);
	const parent = posix.dirname(target);
	const relative = posix.relative(parent, source);
	if (env.id === "node:local") {
		try {
			await symlink(relative, target, "dir");
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
			throw error;
		}
	}
	const linked = await env.exec(
		["/bin/ln", "-sT", "--", relative, posix.basename(target)],
		{ cwd: parent, timeout: 10_000 },
		ctx,
	);
	if (!linked.ok) throw linked.error;
	if (linked.value.exitCode === 0) return true;
	if ((await fileInfo(env, target, ctx)) !== undefined) return false;
	throw new Error("The preserved folder could not be restored to its original location.");
}

async function stage(env: ExecutionEnv, path: string, text: string, ctx: Context): Promise<void> {
	if (env.id === "node:local") {
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile(text);
			await file.sync();
		} finally {
			await file.close();
		}
		return;
	}
	const result = await env.exec(
		["/bin/sh", "-c", 'set -C; umask 077; printf %s "$1" > "$2"', "banda-stage", text, posix.basename(path)],
		{ cwd: posix.dirname(path), timeout: 10_000 },
		ctx,
	);
	if (!result.ok) throw result.error;
	if (result.value.exitCode !== 0)
		throw new Error("The computer could not stage your saved file without replacing another file.");
	must(await env.flushFile(path, ctx));
}

async function displace(env: ExecutionEnv, target: string, kept: string, ctx: Context): Promise<"moved" | "directory"> {
	if ((await fileInfo(env, target, ctx))?.kind === "directory") return "directory";
	if (env.id === "node:local") {
		try {
			await lstat(kept);
			return "moved";
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		try {
			await rename(target, kept);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		return "moved";
	}
	const parent = posix.dirname(target);
	const moved = await env.exec(
		["/bin/mv", "-nT", "--", posix.basename(target), posix.relative(parent, kept)],
		{ cwd: parent, timeout: 10_000 },
		ctx,
	);
	if (!moved.ok) throw moved.error;
	if (moved.value.exitCode !== 0) {
		if ((await fileInfo(env, target, ctx)) !== undefined)
			throw new Error("The computer could not retain the earlier file. Your saved version is kept.");
	}
	return "moved";
}

const queues = new WeakMap<Harness, Map<string, Promise<void>>>();

async function serial(harness: Harness, name: string, work: () => Promise<void>) {
	let names = queues.get(harness);
	if (names === undefined) {
		names = new Map();
		queues.set(harness, names);
	}
	const before = names.get(name) ?? Promise.resolve();
	const running = before.catch(() => {}).then(work);
	names.set(name, running);
	try {
		await running;
	} finally {
		if (names.get(name) === running) names.delete(name);
	}
}

export async function finishAgentPublication(
	harness: Harness,
	workspace: Workspace,
	name: string,
	ctx: Context = context,
): Promise<void> {
	await serial(harness, name, async () => {
		const doc = await harness.snapshot(AgentPublications, ctx);
		const operation = doc?.operations[String(doc.current[name])];
		if (operation === undefined || operation.state.kind !== "pending") return;
		const current = async () => {
			const accepted = (await harness.snapshot(Accepted, ctx))?.files[agentPath(name)];
			const state = await harness.snapshot(AgentPublications, ctx);
			return state?.current[name] === operation.id && (accepted?.sha ?? null) === (operation.file?.sha ?? null);
		};
		const done = async (state: PublicationState) => {
			await harness.commit(async (tx) => {
				const doc = await tx.doc(AgentPublications);
				const record = doc.operations[String(operation.id)];
				if (record?.state.kind === "pending") record.state = state;
			}, ctx);
		};
		if (!(await current())) return done({ kind: "superseded" });
		const env = await io(async () => workspace.env());
		const hit = workspace.publicationPoint ?? (() => {});
		const target = `${workspace.root}/${agentPath(name)}`;
		const parent = posix.dirname(target);
		await hit("agent:directory:before");
		await io(async () => must(await env.createDir(parent, { recursive: true }, ctx)));
		await hit("agent:directory:after");
		await hit("agent:directory:before");
		await io(async () => must(await env.createDir(folder(workspace, operation.id), { recursive: true }, ctx)));
		await hit("agent:directory:after");
		for (const directory of [parent, `${parent}/.banda-publications`, folder(workspace, operation.id)]) {
			if ((await fileInfo(env, directory, ctx))?.kind !== "directory")
				return done({ kind: "conflict", message: "The file's folder changed. Your saved version is kept." });
		}
		let staged: string | undefined;
		if (operation.file !== null) {
			const attemptDirectory = `${folder(workspace, operation.id)}/attempt-${randomUUID()}`;
			await hit("agent:directory:before");
			await io(async () => must(await env.createDir(attemptDirectory, { recursive: false }, ctx)));
			await hit("agent:directory:after");
			const stagePath = `${attemptDirectory}/owner`;
			staged = stagePath;
			await hit("agent:stage:before");
			const text = operation.file.text;
			await io(() => stage(env, stagePath, text, ctx));
			await hit("agent:stage:after");
		}
		if (!(await current())) return done({ kind: "superseded" });
		const live = await io(() => read(env, target, ctx));
		if (operation.file !== null && live.kind === "text" && live.sha === operation.file.sha)
			return done({ kind: "published" });
		const held = previous(workspace, operation.id);
		if ((await fileInfo(env, held, ctx)) === undefined) {
			await hit("agent:retain:before");
			const displaced = await io(() => displace(env, target, held, ctx));
			await hit("agent:retain:after");
			if (displaced === "directory")
				return done({
					kind: "conflict",
					message: "A folder now occupies this file's location. It was left in place with its contents.",
				});
		}
		const was = await io(() => read(env, held, ctx));
		const expected = was.kind === "missing" ? null : was.kind === "text" ? was.sha : "unreadable";
		if (!(await current()) || expected !== operation.workingBase) {
			if (was.kind !== "missing") {
				await hit("agent:insert:before");
				await io(() => restore(env, held, target, ctx));
				await hit("agent:insert:after");
			}
			return done({ kind: "conflict", message: "Another edit arrived while saving. Both versions are kept." });
		}
		if (operation.file === null) {
			const exists = await fileInfo(env, target, ctx);
			return done(
				exists !== undefined
					? { kind: "conflict", message: "Another edit arrived. It has been kept for review." }
					: { kind: "published" },
			);
		}
		if (staged === undefined) throw new Error("The saved file has no staged bytes.");
		await hit("agent:insert:before");
		const owner = staged;
		const inserted = await io(() => insert(env, owner, target, ctx));
		await hit("agent:insert:after");
		return done(
			inserted
				? { kind: "published" }
				: { kind: "conflict", message: "Another edit arrived while saving. Both versions are kept." },
		);
	}).catch((error: unknown) => {
		if (!(error instanceof AgentPublicationIOError)) throw error;
	});
}

export async function recoverAgentPublications(harness: Harness, workspace: Workspace, ctx: Context = context) {
	const doc = await harness.snapshot(AgentPublications, ctx);
	for (const [name, id] of Object.entries(doc?.current ?? {}))
		if (doc?.operations[String(id)]?.state.kind === "pending")
			await finishAgentPublication(harness, workspace, name, ctx);
}

export async function agentPublicationView(
	harness: Harness,
	workspace: Workspace,
	name: string,
	ctx: Context = context,
): Promise<AgentPublicationView | undefined> {
	const doc = await harness.snapshot(AgentPublications, ctx);
	const operation = doc?.operations[String(doc.current[name])];
	if (operation === undefined) return undefined;
	const versions = await retained(workspace, operation, ctx);
	const accepted = (await harness.snapshot(Accepted, ctx))?.files[agentPath(name)];
	const hasHistory = Object.values(doc?.operations ?? {}).some(
		(record) =>
			record.name === name &&
			(record.workingBase !== null || (record.file !== null && record.file.sha !== accepted?.sha)),
	);
	if (operation.state.kind === "published" && versions.length === 0 && !hasHistory) return undefined;
	const changed = versions.some((file) => file.kind !== "text" || file.sha !== operation.workingBase);
	const state =
		operation.state.kind === "superseded"
			? "retained"
			: operation.state.kind === "pending"
				? "pending"
				: operation.state.kind === "conflict" || changed
					? "conflict"
					: "retained";
	return {
		id: String(operation.id),
		state,
		message:
			state === "pending"
				? "Your change is saved. Its workspace file is still being updated."
				: state === "conflict"
					? operation.state.kind === "conflict"
						? operation.state.message
						: "Your change is saved. Another version is also kept for review."
					: "Earlier file versions are kept, including edits still arriving from open files.",
		retained: versions,
	};
}

export async function publicationHistory(
	harness: Harness,
	workspace: Workspace,
	name: string,
	before?: number,
	limit = 20,
	ctx: Context = context,
): Promise<AgentPublicationHistory> {
	const doc = await harness.snapshot(AgentPublications, ctx);
	const operations = Object.values(doc?.operations ?? {})
		.filter((operation) => operation.name === name && (before === undefined || operation.id < before))
		.sort((a, b) => b.id - a.id);
	const page = operations.slice(0, Math.min(20, Math.max(1, limit)));
	const items = await Promise.all(
		page.map(async (operation) => ({
			id: String(operation.id),
			at: operation.at,
			state: operation.state.kind,
			saved: operation.file === null ? null : { sha: operation.file.sha, text: operation.file.text },
			retained: await retained(workspace, operation, ctx),
		})),
	);
	const last = page.at(-1);
	return { items, ...(operations.length > page.length && last !== undefined ? { next: last.id } : {}) };
}
