import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { Control } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { type Looked, watchPath } from "../src/core/watches.ts";
import type { Workspace } from "../src/server/agents.ts";
import { accept } from "../src/server/watches.ts";
import { githubObjectDefinition } from "./fixtures/github-objects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { added, definition, shipping } from "./fixtures/shipped.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const NOW = new Date(2026, 10, 2, 9, 0).getTime();
const WATCH =
	"---\nobject: https://github.com/acme/banda/pull/142\naccount: bandarra\n---\nTell me when it is approved.\n";

/** A store with GitHub accepted and everything paused, and the agent's watch waiting in the box to be allowed. */
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
		(await tx.doc(Control)).paused = NOW;
	}, context);
	await mkdir(join(box.workspace, "watches"), { recursive: true });
	await writeFile(join(box.workspace, watchPath("banda-142")), WATCH);
	const allowed = async () => (await harness.snapshot(Accepted, context))?.files[watchPath("banda-142")]?.sha;
	const close = async () => {
		await harness.close(context);
		box.close();
	};
	return { harness, workspace, allowed, close };
}

const reconcile = async () => {};

describe("allowing the agent's watch", () => {
	it("takes its first look at once, even while everything is paused: its baseline", async () => {
		const s = await setUp();
		const looks: string[] = [];
		const look = async (_h: Harness, name: string, _ctx: Context): Promise<Looked> => {
			looks.push(name);
			return { outcome: "baseline" };
		};
		await accept(s.harness, s.workspace, reconcile, look, "banda-142", shaOf(WATCH), NOW);
		expect(looks).toEqual(["banda-142"]);
		expect(await s.allowed()).toBe(shaOf(WATCH));
		await s.close();
	});

	it("is refused, and nothing allowed, when its first look fails", async () => {
		const s = await setUp();
		const look = async (): Promise<Looked> => ({ outcome: "failed", why: "Not found" });
		await expect(accept(s.harness, s.workspace, reconcile, look, "banda-142", shaOf(WATCH), NOW)).rejects.toThrow(
			/could not be read: Not found/,
		);
		expect(await s.allowed()).toBeUndefined();
		await s.close();
	});
});
