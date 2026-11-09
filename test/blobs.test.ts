/**
 * Blobs (DESIGN.md "State"): bytes on disk by sha256, every fact about them in the store. A crash between writing a
 * blob and the commit that refers to it leaves a file nothing refers to, never a reference to nothing; the sweep takes
 * what no chat holds and what a crash left, and nothing else.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type Attachment,
	BlobStore,
	Blobs,
	blobHash,
	hasBlobHash,
	hold,
	release,
	safeName,
} from "../src/core/blobs.ts";
import { context, openStore } from "../src/core/store.ts";
import { echoModels, tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const HOUR = 60 * 60_000;

async function open() {
	const home = await tempHome();
	const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
	return { home, harness, blobs: new BlobStore(join(home, "blobs")) };
}

/** Store `bytes` and hold them in `chat`, as a write does: the file first, then the commit, under the lock. */
async function attach(harness: Harness, blobs: BlobStore, chat: number, bytes: Buffer, crash = false) {
	return blobs.exclusive(async () => {
		const sha = await blobs.put(bytes);
		// a crash between the rename and the commit: the file is there, nothing refers to it
		if (crash) return sha;
		const file: Attachment = { sha, name: "f.txt", mimeType: "text/plain", size: bytes.length };
		await harness.commit((tx) => hold(tx, chat, file, "owner", Date.now()), context);
		return sha;
	});
}

const files = (home: string) =>
	(existsSync(join(home, "blobs")) ? readdirSync(join(home, "blobs")) : [])
		.filter((shard) => /^[0-9a-f]{2}$/.test(shard))
		.flatMap((shard) => readdirSync(join(home, "blobs", shard)));

const rows = async (harness: Harness) => (await harness.snapshot(Blobs, context))?.blobs ?? {};

describe("blobs", () => {
	it("stores bytes once by their sha, and a chat's hold keeps them until it is released", async () => {
		const { home, harness, blobs } = await open();
		const a = await attach(harness, blobs, 1, Buffer.from("same"));
		expect(await attach(harness, blobs, 2, Buffer.from("same"))).toBe(a);
		expect(files(home)).toEqual([a]);
		expect(Object.keys((await rows(harness))[a]?.holders ?? {}).sort()).toEqual(["1", "2"]);
		expect(await blobs.sweep(harness, Date.now() + 2 * HOUR)).toBe(0);
		await harness.commit((tx) => release(tx, 1), context);
		expect(await blobs.sweep(harness, Date.now() + 2 * HOUR)).toBe(0);
		await harness.commit((tx) => release(tx, 2), context);
		expect(await blobs.sweep(harness)).toBe(1);
		expect(files(home)).toEqual([]);
		expect(await rows(harness)).toEqual({});
		await harness.close(context);
	});

	it("a file with no row goes once it is an hour old, and not before: a write may be about to commit it", async () => {
		const { home, harness, blobs } = await open();
		const orphan = await attach(harness, blobs, 1, Buffer.from("crashed"), true);
		expect(await blobs.sweep(harness)).toBe(0);
		expect(files(home)).toEqual([orphan]);
		const path = blobs.path(orphan);
		const old = new Date(Date.now() - 2 * HOUR);
		await utimes(path, old, old);
		expect(await blobs.sweep(harness)).toBe(1);
		expect(existsSync(path)).toBe(false);
		// a stray file that is no blob is left alone
		await writeFile(join(home, "blobs", "README"), "not a blob");
		expect(await blobs.sweep(harness, Date.now() + 2 * HOUR)).toBe(0);
		await harness.close(context);
	});

	it("names are one safe path component", () => {
		expect(safeName("../../etc/passwd")).toBe("passwd");
		expect(safeName("a\\b.txt")).toBe("b.txt");
		expect(safeName('re"port\n.pdf')).toBe("re_port_.pdf");
		expect(safeName("..")).toBe("file");
		expect(safeName("")).toBe("file");
	});

	it("uses the stored hash to detect bytes that changed after they were approved", async () => {
		const bytes = Buffer.from("approved contents");
		const sha = blobHash(bytes);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
		expect(hasBlobHash(sha, bytes)).toBe(true);
		expect(hasBlobHash(sha, Buffer.from("changed contents"))).toBe(false);
	});

	it("property: whatever crashes and sweeps happen, no row refers to a missing file, and a held blob stays", async () => {
		type Op =
			| { kind: "attach"; chat: number; content: number; crash: boolean }
			| { kind: "release"; chat: number }
			| { kind: "sweep"; later: boolean };
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				kind: fc.constant("attach" as const),
				chat: fc.integer({ min: 1, max: 3 }),
				content: fc.integer({ min: 0, max: 4 }),
				crash: fc.boolean(),
			}),
			fc.record({ kind: fc.constant("release" as const), chat: fc.integer({ min: 1, max: 3 }) }),
			fc.record({ kind: fc.constant("sweep" as const), later: fc.boolean() }),
		);
		await fc.assert(
			fc.asyncProperty(fc.array(op, { maxLength: 25 }), async (ops) => {
				const { home, harness, blobs } = await open();
				try {
					for (const step of ops) {
						if (step.kind === "attach")
							await attach(harness, blobs, step.chat, Buffer.from(`content ${step.content}`), step.crash);
						else if (step.kind === "release") await harness.commit((tx) => release(tx, step.chat), context);
						else await blobs.sweep(harness, step.later ? Date.now() + 2 * HOUR : Date.now());
						const known = await rows(harness);
						for (const sha of Object.keys(known)) expect(existsSync(blobs.path(sha)), `row ${sha}`).toBe(true);
					}
					// in the end, what is on disk is exactly what some chat holds
					await blobs.sweep(harness, Date.now() + 2 * HOUR);
					const known = await rows(harness);
					const held = Object.keys(known).filter((sha) => Object.keys(known[sha]?.holders ?? {}).length > 0);
					expect(files(home).sort()).toEqual(held.sort());
					expect(Object.keys(known).sort()).toEqual(held.sort());
				} finally {
					await harness.close(context);
				}
			}),
			{ numRuns: pbtRuns(30) },
		);
	}, 60_000);
});
