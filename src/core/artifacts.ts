/**
 * Artifacts (DESIGN.md "The app", "State"): the work products the companion made (a document, a table, a plan, a page),
 * each a file of the box published to the owner's Library with every version it had. The store holds every fact about
 * them; a version's bytes are a blob the artifact holds, so any version is restorable byte for byte.
 *
 * - **Publishing.** `message_user`'s artifact part reads the file from the box, stores it as a blob and commits it as
 *   the artifact's next version, keyed by the call that published it, so a rerun after a crash finds its version
 *   instead of adding one. The same bytes as the newest version add none.
 * - **The owner's versions.** An edit (markdown and text) or a restore is a version `by: "owner"`, committed with a
 *   write-back task in one commit, refused unless it builds on the newest version. The task writes the bytes into the
 *   box at the artifact's path only while the box's file still holds the version the owner built on (or none), never
 *   over a change the box made since, and never through a link; then it tells the chat, at the next boundary of its
 *   run, what the owner did: what they changed (an edit's lines against the version it built on) as their words, and
 *   everything else (a restored version, the title, the path, the lines they removed) as data, quoted. A crash
 *   anywhere in it reruns it to the same end.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	defineExtension,
	defineTask,
	type Extension,
	type Harness,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { artifactHolder, type BlobStore, hold, release, safeName, sizeOf } from "./blobs.ts";
import { mimeOf } from "./gateway.ts";
import { context } from "./store.ts";
import { hiddenIn } from "./visible.ts";

export type ArtifactKind = "markdown" | "text" | "table" | "page" | "image" | "pdf" | "file";

/** What became of an owner's version in the box: on its way, written there, left out (the box changed it), failed. */
export type WriteBack = "pending" | "written" | "kept" | "failed";

export type Version = {
	readonly n: number;
	readonly sha: string;
	readonly size: number;
	readonly at: number;
	readonly by: "companion" | "owner";
	/** What changed since the version before, in the companion's words. */
	readonly change?: string;
	/** The chat it was published from (the companion's), and the call that published it. */
	readonly chat?: number;
	readonly call?: string;
	/** An owner's restore: the version whose bytes it holds again. */
	readonly restored?: number;
	/** An owner's version: what the chat shows of it, as the owner's words. */
	readonly said?: string;
	box?: WriteBack;
};

export type Artifact = {
	/**
	 * Which artifact of its path it is: removing one and publishing the path again makes another, with the same id and
	 * a new generation, so a write-back made for the one never touches the other.
	 */
	readonly gen: number;
	title: string;
	/** Where it lives in the box: the absolute path it was first published from. */
	readonly path: string;
	readonly mimeType: string;
	readonly kind: ArtifactKind;
	/** The chat that first published it, where the owner's versions are told. */
	readonly chat: number;
	/** When it last changed: the Library lists the newest first. */
	at: number;
	/** Oldest first, numbered 1..n with no gap; the last is the current one. */
	versions: Version[];
	/** `<chat>:<call>` -> the version that call published (a new one, or the newest when its bytes were the same). */
	published: { [call: string]: number };
	/** The newest write-back's task: the next waits for it, so the box gets the owner's versions in their order. */
	writing?: number;
	/**
	 * The bytes the box's file is known to hold (their sha): what a publish read from it, or an owner's version a
	 * write-back wrote there. A write-back replaces the file only while it holds these, never a change made since.
	 */
	held: string;
};

/** Every artifact, by id, and how many were ever made: the next one's generation follows it. */
export const Artifacts = defineDoc<{ artifacts: { [id: string]: Artifact }; made: number }>({
	kind: "banda.artifacts",
	version: 1,
	scope: "session",
	initial: () => ({ artifacts: {}, made: 0 }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** An artifact's id: stable for its path, so publishing the same file again is its next version. */
export const artifactId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 16);

export const ARTIFACT_ID = /^[0-9a-f]{16}$/;

const KINDS: { readonly [mimeType: string]: ArtifactKind } = {
	"text/markdown": "markdown",
	"text/plain": "text",
	"text/csv": "table",
	"text/html": "page",
	"application/pdf": "pdf",
	"image/png": "image",
	"image/jpeg": "image",
	"image/gif": "image",
	"image/webp": "image",
};

export const kindOf = (mimeType: string): ArtifactKind => KINDS[mimeType] ?? "file";

/** Whether the owner may edit a kind as text. */
export const editable = (kind: ArtifactKind) => kind === "markdown" || kind === "text";

/** Every character the shared check (core/visible.ts) refuses, a run of them at a time, for stripping into one line. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]+/gu;

/** Whether `text` holds a character nobody sees: the one shared check, on one line (no newlines in a path). */
export const unseen = (text: string) => hiddenIn(text) !== undefined;

/** `text` as one plain line: NFC, each run of unseen characters or white space one space, trimmed. */
export const plainLine = (text: string) => text.normalize("NFC").replace(UNSEEN, " ").replace(/\s+/g, " ").trim();

/** `text` quoted as data: a JSON string whose unseen characters are escapes, so nothing in it reads as more than it. */
export const quoted = (text: string) =>
	JSON.stringify(text).replace(
		/[\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu,
		(c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
	);

/** A title from a path: its name without the extension, its separators as spaces. */
export function titleOf(path: string): string {
	const name = plainLine(posix.basename(path)).replace(/\.[^.]+$/, "");
	const words = name.replace(/[_-]+/g, " ").trim();
	return words === "" ? "Untitled" : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The key a publishing call is found by: calls are unique within a chat. */
const callKey = (chat: number, call: string) => `${chat}:${call}`;

/** The version the call `call` of `chat` published, if it did. */
export async function publishedBy(tx: Tx, chat: number, call: string) {
	const { artifacts } = await tx.doc(Artifacts);
	for (const [id, artifact] of Object.entries(artifacts)) {
		const n = artifact.published[callKey(chat, call)];
		if (n !== undefined) return { id, n };
	}
	return undefined;
}

/**
 * Commit what the call `call` of `chat` published from `path` (its bytes already a blob): its next version, or the
 * newest when the bytes are the same; what the call published already when it ran before.
 */
export async function publish(
	tx: Tx,
	file: {
		readonly path: string;
		readonly sha: string;
		readonly size: number;
		readonly title?: string;
		readonly change?: string;
		readonly chat: number;
		readonly call: string;
		readonly at: number;
	},
): Promise<{ readonly id: string; readonly n: number }> {
	const found = await publishedBy(tx, file.chat, file.call);
	if (found !== undefined) return found;
	// the path and the words reach the owner, and the chat with the owner's versions: each one plain line
	if (unseen(file.path)) throw new Refused(`${quoted(file.path)}: its name holds a control or invisible character`);
	const title = file.title === undefined ? undefined : plainLine(file.title) || undefined;
	const change = file.change === undefined ? undefined : plainLine(file.change) || undefined;
	const id = artifactId(file.path);
	const doc = await tx.doc(Artifacts);
	const { artifacts } = doc;
	const mimeType = mimeOf(file.path);
	if (artifacts[id] === undefined) doc.made = (doc.made ?? 0) + 1;
	artifacts[id] ??= {
		gen: doc.made,
		title: title ?? titleOf(file.path),
		path: file.path,
		mimeType,
		kind: kindOf(mimeType),
		chat: file.chat,
		at: file.at,
		versions: [],
		published: {},
		held: file.sha,
	};
	const artifact = artifacts[id];
	if (title !== undefined) artifact.title = title;
	const newest = artifact.versions.at(-1);
	let n = newest?.n ?? 0;
	if (newest?.sha !== file.sha) {
		n++;
		artifact.versions.push({
			n,
			sha: file.sha,
			size: file.size,
			at: file.at,
			by: "companion",
			chat: file.chat,
			call: file.call,
			...(change === undefined ? {} : { change }),
		});
		artifact.at = file.at;
		await hold(
			tx,
			artifactHolder(id),
			{ sha: file.sha, name: safeName(file.path), mimeType, size: file.size },
			"agent",
			file.at,
		);
	}
	artifact.published[callKey(file.chat, file.call)] = n;
	// the box held these bytes when the call read them
	artifact.held = file.sha;
	return { id, n };
}

/** Why an owner's change was refused, and the HTTP status it answers. */
export class Refused extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** A box file's sha256, `missing` when there is none, or why it cannot be read (a link, a folder…). */
async function boxSha(
	env: ExecutionEnv,
	path: string,
	ctx: Context,
): Promise<string | { readonly unreadable: string }> {
	const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
	if (!opened.ok) {
		if (opened.error.code === "not_found") return "missing";
		return { unreadable: opened.error.code === "invalid" ? "it is a link, not a file" : opened.error.message };
	}
	const reader = opened.value;
	try {
		const info = await reader.info(ctx);
		if (!info.ok) return { unreadable: info.error.message };
		const hash = createHash("sha256");
		const chunk = 1024 * 1024;
		for (let at = 0; at < info.value.size; at += chunk) {
			const read = await reader.read(at, Math.min(chunk, info.value.size - at), ctx);
			if (!read.ok) return { unreadable: read.error.message };
			hash.update(read.value);
		}
		return hash.digest("hex");
	} finally {
		await reader.close(ctx);
	}
}

/** Read a box file of at most `limit` bytes, never through a link; or why not. */
export async function readBoxFile(
	env: ExecutionEnv,
	path: string,
	limit: number,
	ctx: Context,
): Promise<{ readonly bytes: Uint8Array } | { readonly refused: string }> {
	const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
	if (!opened.ok)
		return {
			refused: `${path}: ${opened.error.code === "invalid" ? "it is a link or not a file" : opened.error.message}`,
		};
	const reader = opened.value;
	try {
		const info = await reader.info(ctx);
		if (!info.ok) return { refused: `${path}: ${info.error.message}` };
		if (info.value.size > limit)
			return { refused: `${path} is ${sizeOf(info.value.size)}; a file may be ${sizeOf(limit)} at most` };
		const read = await reader.read(0, info.value.size, ctx);
		return read.ok ? { bytes: read.value } : { refused: `${path}: ${read.error.message}` };
	} finally {
		await reader.close(ctx);
	}
}

/** What a write-back did in the box: wrote the owner's version, kept the box's change, or could not, and why. */
type Swapped = { readonly box: Exclude<WriteBack, "pending">; readonly why?: string };

/** Fail with a file operation's error. */
function must(result: { readonly ok: true } | { readonly ok: false; readonly error: Error }) {
	if (!result.ok) throw result.error;
}

/**
 * Put `bytes` (sha `sha`) at `path` only while the box's file there holds `held`, or there is none, as one step from
 * the box's side: the file is renamed aside before it is hashed, so a change the box makes to it before that is seen,
 * and one it makes after lands in a new file, which is never replaced. Then the owner's bytes are renamed in (a link
 * there is replaced, never written through) or the file is renamed back. `tag` names the aside and temporary files,
 * so a rerun after a crash finds them where the crash left them.
 */
async function swap(
	env: ExecutionEnv,
	file: { readonly path: string; readonly sha: string; readonly held: string; readonly tag: string },
	bytes: () => Promise<Uint8Array>,
	hit: (point: ArtifactPoint) => void,
	ctx: Context,
): Promise<Swapped> {
	const { path, sha, held } = file;
	const dir = posix.dirname(path);
	const aside = `${dir}/.${posix.basename(path)}.${file.tag}.aside`;
	const temporary = `${dir}/.${posix.basename(path)}.${file.tag}.tmp`;
	must(await env.createDir(dir, { recursive: true }, ctx));
	must(await env.writeFile(temporary, await bytes(), ctx));
	hit("artifact:write");
	// the box's file as it was: aside already when a crash came after it was moved
	let was = await boxSha(env, aside, ctx);
	if (was === "missing") {
		const moved = await env.renameFile(path, aside, ctx);
		if (!moved.ok && moved.error.code !== "not_found") throw moved.error;
		hit("artifact:aside");
		if (moved.ok) was = await boxSha(env, aside, ctx);
	}
	const back = async () => {
		must(await env.renameFile(aside, path, ctx));
		await env.remove(temporary, { force: true }, ctx);
	};
	try {
		if (typeof was !== "string") {
			await back();
			return { box: "failed", why: was.unreadable };
		}
		const known = was === "missing" || was === held || was === sha;
		// a file there again: the box made a new one since its file was moved, or this task's rename ran before a crash
		const now = await boxSha(env, path, ctx);
		if (now !== "missing") {
			await env.remove(temporary, { force: true }, ctx);
			// the moved file is dropped only when its bytes are a version the Library keeps
			if (was !== "missing" && known) await env.remove(aside, { force: true }, ctx);
			return now === sha ? { box: "written" } : { box: "kept" };
		}
		if (!known) {
			await back();
			return { box: "kept" };
		}
		must(await env.renameFile(temporary, path, ctx));
		hit("artifact:written");
		if (was !== "missing") await env.remove(aside, { force: true }, ctx);
		return { box: "written" };
	} catch (error) {
		// thrown, not killed: the box's file goes back where it was before the next try
		if ((await boxSha(env, path, ctx)) === "missing") await env.renameFile(aside, path, ctx);
		throw error;
	}
}

/** How much of an owner's text the chat's model reads in the message telling it; past it, the file is named instead. */
const TOLD_BYTES = 24 * 1024;

/** The entry telling a chat of the owner's version, at the next boundary of its run. */
export const ARTIFACT_EDIT = "banda.artifact-edit";

/** What holds the blobs a write-back writes and tells (`blobs.ts`'s holders) until it ends, removed or not. */
export const writeBackHolder = (task: number) => `task:${task}`;

type WriteBackInput = {
	readonly id: string;
	/** The generation of the artifact it was made for. */
	readonly gen: number;
	readonly n: number;
	readonly chat: number;
	readonly path: string;
	readonly title: string;
	readonly kind: ArtifactKind;
	readonly sha: string;
	/** The version it builds on (its sha): what the owner changed is told against it. */
	readonly base: string;
	readonly restored?: number;
	/** The write-back before it, of the same artifact, which it waits for. */
	readonly after?: number;
};

type WriteBackState =
	| { readonly phase: "after" }
	| { readonly phase: "write"; readonly tries: number }
	| { readonly phase: "tell"; readonly box: Exclude<WriteBack, "pending">; readonly why?: string };

/**
 * A point a fault suite may fire at: before the box's file is moved aside, once it was, and once the owner's version
 * is in its place, before the store says so.
 */
export type ArtifactPoint = "artifact:write" | "artifact:aside" | "artifact:written";

const TRIES = 6;

/** One run of lines an edit changed: the lines it removed and the ones it added, at line `at` of the new text. */
export type LineChange = {
	readonly at: number;
	readonly removed: readonly string[];
	readonly added: readonly string[];
};

/** Past this many line pairs, the lines between the same first and last ones count as one change, not a diff. */
const DIFF_CELLS = 4_000_000;

/** What changed from `before` to `after`, line by line: each run of removed and added lines, in order. */
export function lineChanges(before: string, after: string): LineChange[] {
	const a = before.split("\n");
	const b = after.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let end = 0;
	while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	const from = a.slice(start, a.length - end);
	const to = b.slice(start, b.length - end);
	if (from.length === 0 && to.length === 0) return [];
	if (from.length * to.length > DIFF_CELLS) return [{ at: start + 1, removed: from, added: to }];
	// the longest common lines, from the end: common[i][j] for from[i..] and to[j..]
	const width = to.length + 1;
	const common = new Uint32Array((from.length + 1) * width);
	for (let i = from.length - 1; i >= 0; i--)
		for (let j = to.length - 1; j >= 0; j--)
			common[i * width + j] =
				from[i] === to[j]
					? (common[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
	const changes: LineChange[] = [];
	let run: { at: number; removed: string[]; added: string[] } | undefined;
	const close = () => {
		if (run !== undefined) changes.push(run);
		run = undefined;
	};
	let i = 0;
	let j = 0;
	while (i < from.length || j < to.length) {
		if (i < from.length && j < to.length && from[i] === to[j]) {
			close();
			i++;
			j++;
		} else if (
			j < to.length &&
			(i === from.length || (common[i * width + j + 1] ?? 0) >= (common[(i + 1) * width + j] ?? 0))
		) {
			run ??= { at: start + j + 1, removed: [], added: [] };
			run.added.push(to[j] ?? "");
			j++;
		} else {
			run ??= { at: start + j + 1, removed: [], added: [] };
			run.removed.push(from[i] ?? "");
			i++;
		}
	}
	close();
	return changes;
}

/** An edit's change as the chat's model reads it: its own lines raw, as the owner's words; the removed ones quoted. */
function changeText(changes: readonly LineChange[]): { readonly text: string; readonly cut: boolean } {
	const lines: string[] = [];
	let size = 0;
	for (const change of changes) {
		for (const line of [
			`@@ line ${change.at}`,
			...change.removed.map((line) => `- ${quoted(line)}`),
			...change.added.map((line) => `+ ${line}`),
		]) {
			size += Buffer.byteLength(line) + 1;
			if (size > TOLD_BYTES) return { text: lines.join("\n"), cut: true };
			lines.push(line);
		}
	}
	return { text: lines.join("\n"), cut: false };
}

/**
 * The model's words for an owner's version. What the owner changed (an edit's added lines) reaches it as their words;
 * everything else is data: the title, the path and why a write failed quoted, the lines they removed quoted, and a
 * restored version named, never its bytes (the box wrote them).
 */
function told(
	input: WriteBackInput,
	box: Exclude<WriteBack, "pending">,
	why: string | undefined,
	changes?: readonly LineChange[],
) {
	const title = quoted(input.title);
	const path = quoted(input.path);
	const did =
		input.restored === undefined
			? `The owner edited the artifact titled ${title} in their Library: v${input.n}, theirs, made from v${input.n - 1}, is the current one.`
			: `The owner restored the artifact titled ${title} in their Library to v${input.restored}: v${input.n}, the current one, holds v${input.restored}'s bytes again.`;
	const where =
		box === "written"
			? `Your file ${path} holds v${input.n} now.`
			: box === "kept"
				? `Your file ${path} holds a change of yours not yet published, so it was left as it is: v${input.n} is only in the Library.`
				: `It could not be written to your file ${path}${why === undefined ? "" : ` (${quoted(why)})`}: v${input.n} is only in the Library.`;
	if (changes === undefined) return `${did}\n${where}`;
	const change = changeText(changes);
	return [
		did,
		where,
		`What they changed, line by line: each "+" line is a line they wrote, as their words; each "-" line is a line of v${input.n - 1} they removed, quoted as data.`,
		change.text,
		...(change.cut ? [`[… cut here: the rest of their change is in v${input.n}]`] : []),
	].join("\n");
}

/**
 * The artifacts' extension (the write-back task) and the owner's changes. `hit` fires the write-back's fault points.
 */
export function defineArtifacts(options: {
	readonly blobs: BlobStore;
	/** The store, once it is open: a chat is told through it (a task's own handle submits input only). */
	readonly harness: () => Harness | undefined;
	readonly hit?: (point: ArtifactPoint) => void;
}) {
	const { blobs } = options;
	const hit = options.hit ?? (() => {});

	const WriteBackTask = defineTask<WriteBackInput, WriteBackState, null>({
		name: "banda.artifact-write-back",
		version: 1,
		initial: () => ({ phase: "after" }),
		phases: {
			after: (task, runtime, ctx) =>
				runtime.commit(async (tx) => {
					const before = task.input.after === undefined ? undefined : await tx.task(task.input.after as TaskId);
					if (before !== undefined && before.state.status !== "terminal")
						return { status: "waiting", on: [before.id], policy: "allSettled", checkpoint: { phase: "after" } };
					return { status: "running", checkpoint: { phase: "write", tries: 0 } };
				}, ctx),
			write: async (task, runtime, ctx) => {
				const { input } = task;
				const { tries } = task.state.checkpoint as Extract<WriteBackState, { phase: "write" }>;
				const artifact = (await runtime.snapshot(Artifacts, ctx))?.artifacts[input.id];
				// removed from the Library (and maybe published again since): the box's copy stays as it is, and the chat
				if (artifact?.gen !== input.gen)
					return runtime.commit(async (tx) => {
						await release(tx, writeBackHolder(Number(task.id)));
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}, ctx);
				// what the box is known to hold now, not when the owner made their version: one that failed changed nothing
				const { held } = artifact;
				let box: Exclude<WriteBack, "pending">;
				let why: string | undefined;
				try {
					const env = await runtime.env(ctx);
					if (env === undefined) throw new Error("there is no box");
					({ box, why } = await swap(
						env,
						{ path: input.path, sha: input.sha, held, tag: `${task.id}` },
						() => blobs.read(input.sha),
						hit,
						ctx,
					));
				} catch (error) {
					// the box is down, or the write failed: again a little later, then the owner's version stays the Library's
					if (tries + 1 < TRIES)
						return runtime.commit(
							() => ({
								status: "sleeping",
								until: runtime.now() + 2_000 * 2 ** tries,
								checkpoint: { phase: "write", tries: tries + 1 },
							}),
							ctx,
						);
					box = "failed";
					why = (error as Error).message;
				}
				return runtime.commit(async (tx) => {
					const now = (await tx.doc(Artifacts)).artifacts[input.id];
					if (now?.gen === input.gen) {
						const version = now.versions[input.n - 1];
						if (version !== undefined) version.box = box;
						// the box holds the owner's bytes now, unless a publish read newer ones from it meanwhile
						if (box === "written" && now.held === held) now.held = input.sha;
					}
					return { status: "running", checkpoint: { phase: "tell", box, ...(why === undefined ? {} : { why }) } };
				}, ctx);
			},
			tell: async (task, runtime, ctx) => {
				const { input } = task;
				const { box, why } = task.state.checkpoint as Extract<WriteBackState, { phase: "tell" }>;
				// an edit's change against the version it built on; a restore is named, never its bytes
				let changes: LineChange[] | undefined;
				if (input.restored === undefined && editable(input.kind)) {
					const [before, after] = await Promise.all([blobs.read(input.base), blobs.read(input.sha)]).catch(() => []);
					if (before !== undefined && after !== undefined)
						changes = lineChanges(before.toString("utf8"), after.toString("utf8"));
				}
				const harness = options.harness();
				// resumed before the daemon handed over its store: a moment later
				if (harness === undefined)
					return runtime.commit(
						() => ({ status: "sleeping", until: runtime.now() + 1_000, checkpoint: task.state.checkpoint }),
						ctx,
					);
				const handle = await harness.conversation(input.chat as ConversationId, ctx);
				if (handle !== undefined) {
					const said =
						input.restored === undefined
							? `Edited “${input.title}” (v${input.n})`
							: `Restored “${input.title}” to v${input.restored} (v${input.n})`;
					// a write with model content waits for the run's next boundary; its request id makes a rerun find it
					await handle.submit(
						{
							type: "write",
							requestId: `artifact:${input.id}:v${input.n}`,
							entry: {
								kind: ARTIFACT_EDIT,
								data: { id: input.id, n: input.n, said },
								model: [
									{
										role: "user",
										content: told(input, box, why, changes),
										timestamp: runtime.now(),
									},
								],
							},
						},
						ctx,
					);
				}
				return runtime.commit(async (tx) => {
					await release(tx, writeBackHolder(Number(task.id)));
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		abort: (task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				await release(tx, writeBackHolder(Number(task.id)));
				return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } };
			}, ctx),
	});

	/** Commit the owner's version of `id` (its bytes already a blob) on `base`, with the task writing it back. */
	async function ownerVersion(
		tx: Tx,
		id: string,
		file: { readonly sha: string; readonly size: number; readonly base: number; readonly restored?: number },
		at: number,
	): Promise<Version> {
		const artifact = (await tx.doc(Artifacts)).artifacts[id];
		if (artifact === undefined) throw new Refused("no such artifact", 404);
		const newest = artifact.versions.at(-1);
		if (newest === undefined || newest.n !== file.base)
			throw new Refused(`it changed since you opened it: v${newest?.n ?? 0} is the newest now`, 409);
		if (newest.sha === file.sha) throw new Refused(`it is the same as v${newest.n}`);
		const n = newest.n + 1;
		const version: Version = {
			n,
			sha: file.sha,
			size: file.size,
			at,
			by: "owner",
			...(file.restored === undefined ? {} : { restored: file.restored }),
			said:
				file.restored === undefined
					? `Edited “${artifact.title}” (v${n})`
					: `Restored “${artifact.title}” to v${file.restored} (v${n})`,
			box: "pending",
		};
		artifact.versions.push(version);
		artifact.at = at;
		await hold(
			tx,
			artifactHolder(id),
			{ sha: file.sha, name: safeName(artifact.path), mimeType: artifact.mimeType, size: file.size },
			"owner",
			at,
		);
		const task = await tx.createTask(
			WriteBackTask,
			{
				id,
				gen: artifact.gen,
				n,
				chat: artifact.chat,
				path: artifact.path,
				title: artifact.title,
				kind: artifact.kind,
				sha: file.sha,
				base: newest.sha,
				...(file.restored === undefined ? {} : { restored: file.restored }),
				...(artifact.writing === undefined ? {} : { after: artifact.writing }),
			},
			{ ownership: { kind: "conversation" }, background: true, conversationId: artifact.chat as ConversationId },
		);
		artifact.writing = Number(task);
		// the task holds what it writes, and what it tells the change against, until it ends: a Removal meanwhile
		// releases the artifact's hold, never the task's
		const name = safeName(artifact.path);
		await hold(
			tx,
			writeBackHolder(Number(task)),
			{ sha: file.sha, name, mimeType: artifact.mimeType, size: file.size },
			"owner",
			at,
		);
		if (file.restored === undefined)
			await hold(
				tx,
				writeBackHolder(Number(task)),
				{ sha: newest.sha, name, mimeType: artifact.mimeType, size: newest.size },
				"owner",
				at,
			);
		return version;
	}

	return {
		extension: defineExtension({ name: "banda.artifacts", tasks: [WriteBackTask] }) as Extension,

		/** The owner's edit of `id`'s text, on version `base`: its new version; throws `Refused` with why not. */
		async edit(harness: Harness, id: string, text: string, base: number, ctx: Context = context): Promise<Version> {
			const artifact = (await harness.snapshot(Artifacts, ctx))?.artifacts[id];
			if (artifact === undefined) throw new Refused("no such artifact", 404);
			if (!editable(artifact.kind)) throw new Refused("only a document's text can be edited here");
			const bytes = Buffer.from(text, "utf8");
			return blobs.exclusive(async () => {
				const sha = await blobs.put(bytes);
				return harness.commit((tx) => ownerVersion(tx, id, { sha, size: bytes.length, base }, Date.now()), ctx);
			});
		},

		/** Make version `n` of `id` the current one again, as a new version; throws `Refused` with why not. */
		async restore(harness: Harness, id: string, n: number, base: number | undefined, ctx: Context = context) {
			return blobs.exclusive(() =>
				harness.commit(async (tx) => {
					const artifact = (await tx.doc(Artifacts)).artifacts[id];
					if (artifact === undefined) throw new Refused("no such artifact", 404);
					const old = artifact.versions[n - 1];
					if (old === undefined) throw new Refused(`there is no v${n}`, 404);
					const newest = artifact.versions.length;
					if (base !== undefined && base !== newest)
						throw new Refused(`it changed since you opened it: v${newest} is the newest now`, 409);
					return ownerVersion(tx, id, { sha: old.sha, size: old.size, base: newest, restored: n }, Date.now());
				}, ctx),
			);
		},
	};
}

/** Remove `id` from the Library: its record goes, and its versions' blobs with it unless something else holds them. */
export async function removeArtifact(harness: Harness, id: string, ctx: Context = context): Promise<boolean> {
	return harness.commit(async (tx) => {
		const doc = await tx.doc(Artifacts);
		if (doc.artifacts[id] === undefined) return false;
		delete doc.artifacts[id];
		await release(tx, artifactHolder(id));
		return true;
	}, ctx);
}
