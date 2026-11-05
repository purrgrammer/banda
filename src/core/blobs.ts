/**
 * Blobs (DESIGN.md "State"): an attachment's bytes on disk at `<root>/<ab>/<sha256>`, beside the store, which holds
 * every fact about them. A blob is written (to a temporary file, synced, renamed) before the commit that refers to it,
 * so a crash leaves at most a file nothing refers to, never a reference to nothing. A blob is held by the chats that
 * carry it and by the artifacts whose versions it is. Writes and the sweep take one lock: a sweep never deletes a file
 * a commit is about to refer to.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { context } from "./store.ts";

/** A file a message carries, in either direction: its name, media type and size, and its blob. */
export type Attachment = {
	readonly sha: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
};

/** The scheme a blob is linked by in text, `[name](sha256:<hex>)`: a digest, as OCI and subresource integrity write one. */
export const BLOB_SCHEME = "sha256:";

/** An attachment as a link in markdown, which clients show as the file itself. */
export const blobLink = ({ name, sha }: Pick<Attachment, "name" | "sha">) =>
	`[${name.replace(/[[\]]/g, "_")}](${BLOB_SCHEME}${sha})`;

/** The blob a `sha256:` link names, or undefined when it names none. */
export function linkedBlob(href: string): string | undefined {
	if (!href.startsWith(BLOB_SCHEME)) return undefined;
	const sha = href.slice(BLOB_SCHEME.length);
	return /^[0-9a-f]{64}$/.test(sha) ? sha : undefined;
}

/** A size as people read it. */
export const sizeOf = (size: number) =>
	size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;

/** Why a file is refused for its size: its name, its size, the limit. */
export const tooBig = (name: string, size: number, limit: number) =>
	`${name} is ${sizeOf(size)}; a file may be ${sizeOf(limit)} at most`;

/** An attachment as the model reads it: its link, its media type and its size. */
export const attachmentLine = (file: Attachment) => `${blobLink(file)} (${file.mimeType}, ${sizeOf(file.size)})`;

/** Who put an attachment into a chat: the owner sent it, or an agent did. */
export type From = "owner" | "agent";

/** A hold on a blob, a chat's or an artifact's: the name it knows it by, who brought it, and when. */
export type Hold = { readonly name: string; readonly from: From; readonly at: number };

/** What holds a blob besides a chat (whose key is its number): an artifact, by its id. */
export const artifactHolder = (id: string) => `artifact:${id}`;

/**
 * Every blob: its size and media type, and what holds it: chats by their number, artifacts by `artifactHolder`. A blob
 * nothing holds is the sweep's to delete.
 */
export const Blobs = defineDoc<{
	blobs: {
		[sha: string]: { size: number; mimeType: string; at: number; holders: { [chat: string]: Hold } };
	};
}>({
	kind: "banda.blobs",
	version: 1,
	scope: "session",
	initial: () => ({ blobs: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

/** How long a file with no row is left alone: a write commits well within it, a crash's leftover is older. */
const ORPHAN_AGE_MS = 60 * 60_000;

const SHA = /^[0-9a-f]{64}$/;

/** A name that is safe as one path component and in a header: no separators, no control characters. */
export function safeName(name: string): string {
	const base = name.split(/[/\\]/).at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
	const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "_").trim();
	return clean === "" || clean === "." || clean === ".." ? "file" : clean.slice(0, 120);
}

export class BlobStore {
	readonly #root: string;
	#lock: Promise<unknown> = Promise.resolve();

	constructor(root: string) {
		this.#root = root;
	}

	/** Run `step` alone among writes and sweeps: a write puts its bytes and commits the row that refers to them in it. */
	exclusive<T>(step: () => Promise<T>): Promise<T> {
		const run = this.#lock.then(step);
		this.#lock = run.catch(() => undefined);
		return run;
	}

	path(sha: string): string {
		if (!SHA.test(sha)) throw new Error(`not a blob: ${sha}`);
		return join(this.#root, sha.slice(0, 2), sha);
	}

	/** Store `bytes` (a no-op when they are stored already) and resolve with their sha. Call inside `exclusive`. */
	async put(bytes: Uint8Array): Promise<string> {
		const sha = createHash("sha256").update(bytes).digest("hex");
		const final = this.path(sha);
		if (
			await stat(final).then(
				() => true,
				() => false,
			)
		)
			return sha;
		const tmp = join(this.#root, ".tmp");
		await mkdir(tmp, { recursive: true });
		await mkdir(join(this.#root, sha.slice(0, 2)), { recursive: true });
		const temporary = join(tmp, randomUUID());
		const file = await open(temporary, "w");
		try {
			await file.writeFile(bytes);
			// the bytes reach the disk before any commit that refers to them
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, final);
		return sha;
	}

	read(sha: string): Promise<Buffer> {
		return readFile(this.path(sha));
	}

	/**
	 * Delete the blobs nothing holds, then the files with no row that are older than an hour (a crash's
	 * leftovers). Resolves with how many files went.
	 */
	sweep(harness: Harness, now = Date.now(), ctx: Context = context): Promise<number> {
		return this.exclusive(async () => {
			const unheld = await harness.commit(async (tx) => {
				const { blobs } = await tx.doc(Blobs);
				const gone = Object.keys(blobs).filter((sha) => Object.keys(blobs[sha]?.holders ?? {}).length === 0);
				for (const sha of gone) delete blobs[sha];
				return gone;
			}, ctx);
			// the rows went first: a crash here leaves files with no row, which the next sweep takes once they are old
			for (const sha of unheld) await rm(this.path(sha), { force: true });
			const known = new Set(Object.keys((await harness.snapshot(Blobs, ctx))?.blobs ?? {}));
			let removed = unheld.length;
			for (const shard of await readdir(this.#root).catch(() => [] as string[])) {
				if (!/^[0-9a-f]{2}$/.test(shard)) continue;
				for (const name of await readdir(join(this.#root, shard)).catch(() => [] as string[])) {
					if (!SHA.test(name) || known.has(name)) continue;
					const info = await stat(join(this.#root, shard, name)).catch(() => undefined);
					if (info === undefined || now - info.mtimeMs < ORPHAN_AGE_MS) continue;
					await rm(join(this.#root, shard, name), { force: true });
					removed++;
				}
			}
			await rm(join(this.#root, ".tmp"), { recursive: true, force: true });
			return removed;
		});
	}
}

/**
 * Record that `holder` (a chat, or `artifactHolder(id)`) holds `attachment`, brought by `from`, in the commit that
 * refers to it.
 */
export async function hold(tx: Tx, holder: number | string, attachment: Attachment, from: From, at: number) {
	const { blobs } = await tx.doc(Blobs);
	blobs[attachment.sha] ??= { size: attachment.size, mimeType: attachment.mimeType, at, holders: {} };
	const blob = blobs[attachment.sha];
	if (blob !== undefined) blob.holders[holder] = { name: attachment.name, from, at };
}

/** Release every blob `holder` holds, as its removal does; the sweep deletes those nothing else holds. */
export async function release(tx: Tx, holder: number | string) {
	const { blobs } = await tx.doc(Blobs);
	for (const blob of Object.values(blobs)) delete blob.holders[holder];
}
