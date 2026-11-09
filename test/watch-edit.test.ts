import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { Followed, type Looked, Watches, watchPath, withUntil } from "../src/core/watches.ts";
import type { Workspace } from "../src/server/agents.ts";
import { changeWatch, createWatch, watches } from "../src/server/watches.ts";
import { githubObjectDefinition } from "./fixtures/github-objects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { added, definition, shipping } from "./fixtures/shipped.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const NOW = new Date(2026, 10, 2, 9, 0).getTime();
const WATCH =
	"---\nobject: https://github.com/acme/banda/pull/142\naccount: bandarra\nuntil: merged\n---\nTell me when it is approved.\n";

/** A store and a box holding one watch in effect, resolved to GitHub's pull request kind as its task leaves it. */
async function setUp() {
	const home = await tempHome();
	const box = openBox(hostBox(home), () => {});
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(core.extension);
	const harness = await openStore(home, { models: echoModels().models, registry });
	const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
	shipping(definition("github", githubObjectDefinition("https://example.com/mcp")));
	await harness.commit(async (tx) => {
		await added(tx, "github", NOW);
		const files = (await tx.doc(Accepted)).files;
		files[watchPath("banda-142")] = { sha: shaOf(WATCH), text: WATCH, at: NOW };
		(await tx.doc(Watches)).watches["banda-142"] = {
			agent: "sancho",
			since: NOW,
			key: "github/bandarra/pull_request:acme/banda#142",
			ref: "github:pull_request:acme/banda#142",
			name: "acme/banda #142",
			connection: "github",
			service: "GitHub",
		};
		// the reading its looks kept, three versions in
		(await tx.doc(Followed)).objects["github/bandarra/pull_request:acme/banda#142"] = {
			answers: {},
			at: NOW,
			source: "github",
			version: 3,
		};
	}, context);
	await mkdir(join(box.workspace, "watches"), { recursive: true });
	await writeFile(join(box.workspace, watchPath("banda-142")), WATCH);
	const accepted = async () => (await harness.snapshot(Accepted, context))?.files[watchPath("banda-142")]?.text;
	const boxed = () => readFile(join(box.workspace, watchPath("banda-142")), "utf8");
	const close = async () => {
		await harness.close(context);
		box.close();
	};
	return { box, harness, workspace, accepted, boxed, close };
}

const reconcile = async () => {};
/** A first look that must never come: the watch is refused before it. */
const never = (): Promise<Looked> => Promise.reject(new Error("looked"));

describe("the owner's follow of an object", () => {
	it("is refused while a watch of the agent's on that object lives, naming it; the file and the store unchanged", async () => {
		const { harness, workspace, close } = await setUp();
		try {
			const made = { agent: "sancho", object: "https://github.com/acme/banda/pull/142" };
			await expect(createWatch(harness, workspace, reconcile, never, made, NOW)).rejects.toMatchObject({
				status: 409,
				message: "Sancho already follows it (watches/banda-142.md)",
			});
			const store = await harness.snapshot(Watches, context);
			expect(Object.keys(store?.watches ?? {})).toEqual(["banda-142"]);
			const accepted = (await harness.snapshot(Accepted, context))?.files ?? {};
			expect(Object.keys(accepted).filter((path) => path.startsWith("watches/"))).toEqual([watchPath("banda-142")]);
		} finally {
			await close();
		}
	});
});

describe("the owner's edit of a watch", () => {
	it("sets, replaces or drops the until line alone, every other byte kept", () => {
		expect(withUntil(WATCH, "closed")).toBe(WATCH.replace("until: merged", "until: closed"));
		expect(withUntil(WATCH, null)).toBe(WATCH.replace("until: merged\n", ""));
		const none = WATCH.replace("until: merged\n", "");
		expect(withUntil(none, "merged")).toBe(WATCH);
		expect(withUntil("no frontmatter", "merged")).toBeUndefined();
	});

	it("rewrites only the line it changes, in the store and the box; the view offers the kind's ends", async () => {
		const { harness, workspace, accepted, boxed, close } = await setUp();
		try {
			const [view] = await watches(harness, workspace);
			expect(view?.object?.ends).toEqual(["merged", "closed"]);
			// the version of the reading its card draws, which the app reads the card again by
			expect(view?.object?.version).toBe(3);
			await changeWatch(harness, workspace, reconcile, "banda-142", { until: "closed" }, shaOf(WATCH), NOW);
			const closed = WATCH.replace("until: merged", "until: closed");
			expect(await accepted()).toBe(closed);
			expect(await boxed()).toBe(closed);
			expect((await harness.snapshot(Watches, context))?.watches["banda-142"]?.edit).toBeUndefined();
			await changeWatch(harness, workspace, reconcile, "banda-142", { ask: "Only failed checks." }, shaOf(closed), NOW);
			expect(await accepted()).toBe(closed.replace("Tell me when it is approved.", "Only failed checks."));
			const [after] = await watches(harness, workspace);
			expect(after?.change).toBeUndefined();
			expect(after?.accepted?.watch).toMatchObject({ until: "closed", ask: "Only failed checks." });
		} finally {
			await close();
		}
	});

	it("until null clears it: any of the kind's ends ends it", async () => {
		const { harness, workspace, accepted, boxed, close } = await setUp();
		try {
			await changeWatch(harness, workspace, reconcile, "banda-142", { until: null }, shaOf(WATCH), NOW);
			expect(await accepted()).toBe(WATCH.replace("until: merged\n", ""));
			expect(await boxed()).toBe(WATCH.replace("until: merged\n", ""));
		} finally {
			await close();
		}
	});

	it("is refused over a version the owner did not see, over the box's own change, and for an until that is no end", async () => {
		const { harness, workspace, box, accepted, close } = await setUp();
		try {
			await expect(
				changeWatch(harness, workspace, reconcile, "banda-142", { until: "closed" }, shaOf("other"), NOW),
			).rejects.toMatchObject({ status: 409, message: "it changed since you saw it: look again" });
			await expect(
				changeWatch(harness, workspace, reconcile, "banda-142", { until: "approved" }, shaOf(WATCH), NOW),
			).rejects.toMatchObject({ status: 400, message: "until is one of merged, closed" });
			await expect(
				changeWatch(harness, workspace, reconcile, "banda-142", { ask: " " }, shaOf(WATCH), NOW),
			).rejects.toMatchObject({ status: 400 });
			await writeFile(join(box.workspace, watchPath("banda-142")), WATCH.replace("approved", "merged"));
			await expect(
				changeWatch(harness, workspace, reconcile, "banda-142", { until: "closed" }, shaOf(WATCH), NOW),
			).rejects.toMatchObject({
				status: 409,
				message: "it has a change waiting for you to allow it: answer that first",
			});
			expect(await accepted()).toBe(WATCH);
		} finally {
			await close();
		}
	});
});
