/**
 * Artifacts (DESIGN.md "The app"): a file of the box published to the Library with every version it had, the owner's
 * edits and restores as versions of their own, written back into the box and told to the chat as the owner's words,
 * every version restorable byte for byte, and the bytes never served as a page on the daemon's origin.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Artifacts, artifactId, defineArtifacts, publish, Refused, removeArtifact } from "../src/core/artifacts.ts";
import { BlobStore, Blobs } from "../src/core/blobs.ts";
import { context, openStore } from "../src/core/store.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { ArtifactView, ChatRow, Item } from "../src/server/api.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const HOUR = 60 * 60_000;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

type Said = { role: string; content: unknown };
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part: { text?: string }) => part.text ?? "").join("")
			: "";

/** A daemon on a host box whose faux model publishes what each message names: `publish <path> [title] [| change]`. */
async function daemon() {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const web = join(home, "web");
	await mkdir(web, { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	/** Every context the model was asked with: what it read. */
	const contexts: Said[][] = [];
	faux.setResponses(
		Array.from({ length: 200 }, () => (ctx: { messages: readonly Said[] }) => {
			contexts.push([...ctx.messages]);
			const last = ctx.messages.at(-1);
			if (last?.role !== "user") return fauxAssistantMessage("done");
			const said = textOf(last.content);
			const published = /^publish (\S+)(?: ([^|]+))?(?: \| (.+))?$/.exec(said);
			if (published === null) return fauxAssistantMessage("ok");
			const [, path, title, change] = published;
			return fauxAssistantMessage(
				[
					fauxToolCall("message_user", {
						text: "Here it is.",
						artifact: {
							path: path ?? "",
							...(title === undefined ? {} : { title: title.trim() }),
							...(change === undefined ? {} : { change }),
						},
					}),
				],
				{ stopReason: "toolUse" },
			);
		}) as never,
	);
	const running = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home), web });
	const token = (await readDaemonFile(home))!.token!;
	const url = `http://127.0.0.1:${running.port}`;
	const call = (path: string, init: RequestInit = {}) =>
		fetch(`${url}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await call(path, init);
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	const thread = randomUUID();
	let chat: number | undefined;
	/** Say `text` in the one chat and wait for its run to end. */
	const say = async (text: string) => {
		const before = contexts.length;
		const posted = await api<{ chat: number }>("/messages", {
			method: "POST",
			body: JSON.stringify({ id: randomUUID(), text, ...(chat === undefined ? { thread } : { chat }) }),
		});
		chat = posted.chat;
		await until(
			async () =>
				contexts.length > before && (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle",
		);
	};
	const items = async () => (await api<{ items: Item[] }>(`/chats/${chat}/items?after=0`)).items as readonly Item[];
	const library = () => api<ArtifactView[]>("/artifacts");
	const box = (path: string) => join(home, "workspace", path);
	return { home, api, call, say, items, library, box, contexts, close: () => running.close() };
}

describe("artifacts in the daemon", () => {
	it("publishes versions, keeps the same bytes as one, and the owner's edit and restore reach the box and the chat", async () => {
		const d = await daemon();
		try {
			await mkdir(join(d.home, "workspace"), { recursive: true });
			await writeFile(d.box("plan.md"), "# Friday\n\n09:10 Porto → Lisbon\n");
			await d.say("publish plan.md Lisbon trip plan");
			const [first] = await d.library();
			expect(first).toMatchObject({
				id: artifactId(d.box("plan.md")),
				title: "Lisbon trip plan",
				kind: "markdown",
				mimeType: "text/markdown",
				path: d.box("plan.md"),
			});
			expect(first?.versions.map((v) => [v.n, v.by])).toEqual([[1, "companion"]]);
			const id = first!.id;
			// the same bytes again: no new version, and the call still finds the one it published
			await d.say("publish plan.md");
			const again = (await d.library())[0]!;
			expect(again.versions).toHaveLength(1);
			expect(Object.values(again.published)).toEqual([1, 1]);
			// changed bytes: v2, with what changed
			await writeFile(d.box("plan.md"), "# Friday\n\n09:10 Porto → Lisbon\n18:00 back\n");
			await d.say("publish plan.md | added the return train");
			expect((await d.library())[0]?.versions.map((v) => [v.n, v.by, v.change])).toEqual([
				[1, "companion", undefined],
				[2, "companion", "added the return train"],
			]);

			// the owner's edit: v3, theirs, in the box, and told to the chat as their words
			const mine = "# Friday\n\n09:10 Porto → Lisbon\n19:30 back, later\n";
			const edited = await d.api<ArtifactView>(`/artifacts/${id}/versions`, {
				method: "POST",
				body: JSON.stringify({ text: mine, base: 2 }),
			});
			expect(edited.versions.at(-1)).toMatchObject({ n: 3, by: "owner", sha: sha(mine) });
			// the write-back moves the box's file aside for a moment: read past that
			const inBox = () => readFile(d.box("plan.md")).catch(() => Buffer.alloc(0));
			await until(async () => (await inBox()).toString() === mine);
			await until(async () => (await d.library())[0]?.versions[2]?.box === "written");
			const told = await until(async () =>
				(await d.items()).find((item) => item.role === "user" && item.text === "Edited “Lisbon trip plan” (v3)"),
			);
			// the app matches its card to the version by the entry's own {id, n}
			expect(told).toMatchObject({ artifact: { id, n: 3 } });
			// the model reads it, at its next run, as the owner's words
			await d.say("ping");
			const read = d.contexts.at(-1)!.map((m) => (m.role === "user" ? textOf(m.content) : ""));
			expect(
				read.some(
					(text) =>
						text.startsWith('The owner edited the artifact titled "Lisbon trip plan"') &&
						text.split("\n").includes("+ 19:30 back, later") &&
						text.split("\n").includes('- "18:00 back"'),
				),
			).toBe(true);

			// a stale base is refused, and nothing changes
			const stale = await d.call(`/artifacts/${id}/versions`, {
				method: "POST",
				body: JSON.stringify({ text: "lost", base: 2 }),
			});
			expect(stale.status).toBe(409);
			expect((await d.library())[0]?.versions).toHaveLength(3);

			// restore v1: v4 holds v1's bytes, in the box too
			const v1 = (await d.library())[0]!.versions[0]!;
			const restored = await d.api<ArtifactView>(`/artifacts/${id}/restore`, {
				method: "POST",
				body: JSON.stringify({ n: 1, base: 3 }),
			});
			expect(restored.versions.at(-1)).toMatchObject({ n: 4, by: "owner", restored: 1, sha: v1.sha });
			await until(async () => sha(await inBox()) === v1.sha);
			// every version, byte for byte, by its route
			for (const version of restored.versions) {
				const bytes = Buffer.from(await (await d.call(`/artifacts/${id}/versions/${version.n}`)).arrayBuffer());
				expect(sha(bytes)).toBe(version.sha);
			}
			// and its words, as JSON, for the app to show
			expect(await d.api<{ text: string }>(`/artifacts/${id}/versions/3/text`)).toEqual({ text: mine });
		} finally {
			await d.close();
		}
	}, 60_000);

	it("never overwrites a change the box made since: the owner's version stays the Library's, and the chat reads it", async () => {
		const d = await daemon();
		try {
			await mkdir(join(d.home, "workspace"), { recursive: true });
			await writeFile(d.box("notes.txt"), "one\n");
			await d.say("publish notes.txt Notes");
			const id = (await d.library())[0]!.id;
			// the companion changed the file and has not published it
			await writeFile(d.box("notes.txt"), "one\ntwo, the companion's\n");
			await d.api(`/artifacts/${id}/versions`, {
				method: "POST",
				body: JSON.stringify({ text: "one\nmine\n", base: 1 }),
			});
			await until(async () => (await d.library())[0]?.versions[1]?.box === "kept");
			expect(await readFile(d.box("notes.txt"), "utf8")).toBe("one\ntwo, the companion's\n");
			await d.say("ping");
			const read = d.contexts.at(-1)!.map((m) => (m.role === "user" ? textOf(m.content) : ""));
			expect(read.some((text) => text.includes("was left as it is") && text.split("\n").includes("+ mine"))).toBe(true);
		} finally {
			await d.close();
		}
	}, 60_000);

	it("serves a page's bytes only as a download, refuses to edit what is not text, and removes an artifact", async () => {
		const d = await daemon();
		try {
			await mkdir(join(d.home, "workspace"), { recursive: true });
			await writeFile(d.box("budget.html"), "<script>fetch('/api/chats')</script><h1>Budget</h1>");
			await d.say("publish budget.html Budget page");
			const [page] = await d.library();
			expect(page?.kind).toBe("page");
			const response = await d.call(`/artifacts/${page!.id}/versions/1`);
			expect(response.headers.get("content-type")).toBe("application/octet-stream");
			expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
			expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
			const edit = await d.call(`/artifacts/${page!.id}/versions`, {
				method: "POST",
				body: JSON.stringify({ text: "<h1>mine</h1>", base: 1 }),
			});
			expect(edit.status).toBe(400);
			// a link in the box is never followed: the message is refused
			const { symlink } = await import("node:fs/promises");
			await symlink(join(d.home, "config.json"), d.box("sneaky.md"));
			await d.say("publish sneaky.md");
			expect((await d.library()).map((artifact) => artifact.title)).toEqual(["Budget page"]);
			expect((await d.items()).some((item) => item.role === "tool" && item.error && /link/.test(item.text))).toBe(true);
			const removed = await d.call(`/artifacts/${page!.id}`, { method: "DELETE" });
			expect(removed.status).toBe(200);
			expect(await d.library()).toEqual([]);
			expect((await d.call(`/artifacts/${page!.id}/versions/1`)).status).toBe(404);
		} finally {
			await d.close();
		}
	}, 60_000);
});

/** A store with the artifacts' task, never resumed: the owner's versions are committed, their write-backs never run. */
async function store(home?: string) {
	const at = home ?? (await tempHome());
	const blobs = new BlobStore(join(at, "blobs"));
	let opened: Harness | undefined;
	const library = defineArtifacts({ blobs, harness: () => opened });
	const registry = createRegistry();
	registry.install(library.extension);
	const harness = await openStore(at, { models: echoModels().models, registry });
	opened = harness;
	// the chat the artifact is published from
	const chat = Number((await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id);
	return { home: at, blobs, library, harness, chat };
}

const PATH = "/workspace/plan.md";

/** What a `message_user` call publishing `bytes` commits, as the part does: the blob first, then the version. */
async function published(harness: Harness, blobs: BlobStore, bytes: Buffer, call: string, chat: number) {
	return blobs.exclusive(async () => {
		const stored = await blobs.put(bytes);
		return harness.commit(
			(tx) => publish(tx, { path: PATH, sha: stored, size: bytes.length, chat, call, at: Date.now() }),
			context,
		);
	});
}

describe("artifacts in the store", () => {
	it("the sweep keeps every version's blob while the artifact lives, and frees them once it is removed", async () => {
		const { harness, blobs, chat } = await store();
		await published(harness, blobs, Buffer.from("v1"), "a", chat);
		await published(harness, blobs, Buffer.from("v2"), "b", chat);
		expect(await blobs.sweep(harness, Date.now() + 2 * HOUR)).toBe(0);
		const id = artifactId(PATH);
		for (const text of ["v1", "v2"]) expect((await blobs.read(sha(text))).toString()).toBe(text);
		expect(await removeArtifact(harness, id)).toBe(true);
		expect(await blobs.sweep(harness, Date.now() + 2 * HOUR)).toBe(2);
		expect((await harness.snapshot(Blobs, context))?.blobs).toEqual({});
		await harness.close(context);
	});

	it("property: publishes, edits and restores make the versions a model says, each restorable byte for byte after a restart", async () => {
		type Op =
			| { readonly kind: "publish"; readonly text: string }
			| { readonly kind: "edit"; readonly text: string }
			| { readonly kind: "restore"; readonly n: number };
		const text = fc.constantFrom("a", "b", "c", "# plan\n", "ünïcode ✓\n");
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({ kind: fc.constant("publish" as const), text }),
			fc.record({ kind: fc.constant("edit" as const), text }),
			fc.record({ kind: fc.constant("restore" as const), n: fc.integer({ min: 1, max: 8 }) }),
		);
		await fc.assert(
			fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
				let s = await store();
				const id = artifactId(PATH);
				// the model: each version's bytes and who made it
				const model: { text: string; by: "companion" | "owner" }[] = [];
				for (const [i, step] of ops.entries()) {
					const newest = model.at(-1);
					if (step.kind === "publish") {
						await published(s.harness, s.blobs, Buffer.from(step.text), `call-${i}`, s.chat);
						if (newest?.text !== step.text) model.push({ text: step.text, by: "companion" });
						continue;
					}
					const refused = async (run: () => Promise<unknown>) => {
						try {
							await run();
							return false;
						} catch (error) {
							if (!(error instanceof Refused)) throw error;
							return true;
						}
					};
					if (step.kind === "edit") {
						const was = await refused(() => s.library.edit(s.harness, id, step.text, model.length));
						const expected = newest === undefined || newest.text === step.text;
						expect(was).toBe(expected);
						if (!was) model.push({ text: step.text, by: "owner" });
					} else {
						const was = await refused(() => s.library.restore(s.harness, id, step.n, model.length));
						const old = model[step.n - 1];
						expect(was).toBe(old === undefined || old.text === newest?.text);
						if (!was && old !== undefined) model.push({ text: old.text, by: "owner" });
					}
				}
				// a restart: everything is read back from disk
				await s.harness.close(context);
				s = await store(s.home);
				const artifact = (await s.harness.snapshot(Artifacts, context))?.artifacts[id];
				expect(artifact?.versions.map((v) => v.n) ?? []).toEqual(model.map((_, i) => i + 1));
				expect(artifact?.versions.map((v) => v.by) ?? []).toEqual(model.map((v) => v.by));
				for (const [i, version] of (artifact?.versions ?? []).entries()) {
					const bytes = await s.blobs.read(version.sha);
					expect(bytes.toString()).toBe(model[i]?.text);
					expect(sha(bytes)).toBe(version.sha);
				}
				expect(await s.blobs.sweep(s.harness, Date.now() + 2 * HOUR)).toBe(0);
				await s.harness.close(context);
			}),
			{ numRuns: pbtRuns(15) },
		);
	}, 120_000);
});
