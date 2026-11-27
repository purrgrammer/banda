/**
 * Which routine an action lands on (DESIGN.md "Routines", issue #154): a request names its routine by id in its path
 * and again in its body; a bare name without that is an older app's, which may mean the shared routine or an agent's
 * own of that name, so it is refused and told to update, never resolved to whichever exists. A shared routine and an
 * agent's own of one name are two: an action on one leaves the other byte for byte as it was. An action on a routine
 * that is in neither the store nor the box is an error, 404, and does nothing: never a decline that removed nothing.
 * A stale card (a hash the box no longer holds) is refused apart, 409, so the owner reads which it was.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { ActivityLog } from "../src/core/activity.ts";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { type RoutineRecord, Routines, routinePath } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import type { Workspace } from "../src/server/agents.ts";
import { BadRequest } from "../src/server/http.ts";
import { accept, decline, remove, requested, routines } from "../src/server/routines.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome } from "./helpers.ts";

const CURRO_FILE = "---\nname: Curro\ndescription: Drafts summaries\n---\nCurro.\n";
const SHARED = "---\ndescription: Shared tea\nevery: 1d\n---\nSHARED ASK.\n";
const OWN = "---\ndescription: Curro's tea\nevery: 2h\n---\nCURRO ASK.\n";
const OWN_V2 = OWN.replace("CURRO ASK.", "CURRO ASK, again.");
const NOTHING = "0".repeat(64);

/** The status a refusal carries, and its words. */
async function refused(run: () => Promise<unknown>): Promise<{ status: number; message: string }> {
	try {
		await run();
	} catch (error) {
		if (error instanceof BadRequest) return { status: error.status, message: error.message };
		throw error;
	}
	throw new Error("not refused");
}

describe("which routine a request means", () => {
	it("is its id, in the path and again in the body; a bare name alone is an older app's, refused, never guessed", () => {
		// an app of this build: both agree, in either form
		expect(requested("curro/tea", "curro/tea")).toBe("curro/tea");
		expect(requested("tea", "tea")).toBe("tea");
		// `<agent>/<name>` is a form only an app of this build sends: it stands on its own
		expect(requested("curro/tea", undefined)).toBe("curro/tea");
		// a bare name with nothing in the body: it may mean the shared routine or an agent's own, so neither is picked
		const bare = (() => {
			try {
				requested("tea", undefined);
			} catch (error) {
				return error as BadRequest;
			}
			return undefined;
		})();
		expect(bare).toBeInstanceOf(BadRequest);
		expect(bare?.status).toBe(400);
		expect(bare?.message).toMatch(/names a routine by its name alone, tea.*update the app/);
		// a body that names another routine than the path: neither is acted on
		expect(() => requested("tea", "curro/tea")).toThrow(/id names the routine as the path does, tea/);
		expect(() => requested("curro/tea", "tea")).toThrow(/id names the routine as the path does, curro\/tea/);
		expect(() => requested("curro/tea", 7)).toThrow(/id names the routine as the path does/);
		// what is no id at all
		for (const id of ["a/b/c", "Tea", "../tea", "tea/"])
			expect(() => requested(id, id), id).toThrow(/not a routine's id/);
	});
});

describe("an action on a routine", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.close(context);
		harness = undefined;
	});

	/** A store and a box on a throwaway home, Curro in effect; the box's routine files written as given. */
	async function opened(files: { [path: string]: string } = {}) {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		await harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files["agents/curro.md"] = { sha: shaOf(CURRO_FILE), text: CURRO_FILE, at: 0 };
		}, context);
		for (const [path, text] of Object.entries(files)) {
			await mkdir(join(box.workspace, path, ".."), { recursive: true });
			await writeFile(join(box.workspace, path), text);
		}
		const reconcile = async () => {};
		const store = async () => ({
			accepted: Object.fromEntries(
				Object.entries((await harness!.snapshot(Accepted, context))?.files ?? {}).filter(
					([path]) => path.includes("/routines/") || path.startsWith("routines/"),
				),
			),
			records: (await harness!.snapshot(Routines, context))?.routines ?? {},
			activity: (await harness!.snapshot(ActivityLog, context))?.events ?? [],
		});
		const boxText = async (path: string) =>
			existsSync(join(box.workspace, path)) ? await readFile(join(box.workspace, path), "utf8") : undefined;
		return { home, box, workspace, reconcile, store, boxText };
	}

	it("that is nowhere is refused, 404, and does nothing: no file made or removed, nothing accepted or logged", async () => {
		const s = await opened({ [routinePath("curro/tea")]: OWN });
		const before = { ...(await s.store()), own: await s.boxText(routinePath("curro/tea")) };
		for (const id of ["curro/ghost", "ghost", "sancho/tea", "tea"]) {
			// allow a change, allow a removal, decline, remove: each names a routine that is in neither place
			const sha = id === "tea" || id === "sancho/tea" ? shaOf(OWN) : NOTHING;
			for (const run of [
				() => accept(harness!, s.workspace, s.reconcile, id, sha, 1),
				() => accept(harness!, s.workspace, s.reconcile, id, null, 1),
				() => decline(harness!, s.workspace, id),
				() => remove(harness!, s.workspace, s.reconcile, id, 1),
			]) {
				const why = await refused(run);
				expect(why.status, id).toBe(404);
				expect(why.message, id).toMatch(new RegExp(`there is no routine ${id}`));
			}
		}
		// the box as it was: no folder made for a routine there is none of, Curro's file untouched
		expect(existsSync(join(s.box.workspace, "routines"))).toBe(false);
		expect(existsSync(join(s.box.workspace, "agents", "sancho"))).toBe(false);
		expect(await s.boxText(routinePath("curro/tea"))).toBe(OWN);
		expect({ ...(await s.store()), own: await s.boxText(routinePath("curro/tea")) }).toEqual(before);
		// the one routine there is still waits, as it did
		expect(await routines(harness!, s.workspace, 1)).toEqual([
			expect.objectContaining({ id: "curro/tea", state: "allow", change: expect.objectContaining({ kind: "added" }) }),
		]);
	});

	it("a shared routine and an agent's own of one name: each action lands on the one named, the other as it was", async () => {
		const s = await opened({ [routinePath("tea")]: SHARED, [routinePath("curro/tea")]: OWN });
		const ids = async () => (await routines(harness!, s.workspace, 1)).map((each) => [each.id, each.state]);
		expect(await ids()).toEqual([
			["curro/tea", "allow"],
			["tea", "allow"],
		]);
		// an app of this build declines the shared one, named twice: its file goes, Curro's is byte for byte as it was
		await decline(harness!, s.workspace, requested("tea", "tea"));
		expect(await s.boxText(routinePath("tea"))).toBeUndefined();
		expect(await s.boxText(routinePath("curro/tea"))).toBe(OWN);
		expect(await ids()).toEqual([["curro/tea", "allow"]]);
		// declined again: there is nothing to decline, and nothing is removed
		expect((await refused(() => decline(harness!, s.workspace, requested("tea", "tea")))).status).toBe(404);
		expect(await s.boxText(routinePath("curro/tea"))).toBe(OWN);
		// the shared one is back; allowing Curro's allows Curro's alone
		await writeFile(join(s.box.workspace, routinePath("tea")), SHARED);
		await accept(harness!, s.workspace, s.reconcile, "curro/tea", shaOf(OWN), 2);
		const { accepted } = await s.store();
		expect(Object.keys(accepted)).toEqual([routinePath("curro/tea")]);
		expect(await s.boxText(routinePath("tea"))).toBe(SHARED);
		expect(await ids()).toEqual([
			["curro/tea", "active"],
			["tea", "allow"],
		]);
		// removing Curro's removes Curro's alone: the shared one still waits, its file untouched
		await remove(harness!, s.workspace, s.reconcile, "curro/tea", 3);
		expect(await s.boxText(routinePath("curro/tea"))).toBeUndefined();
		expect(Object.keys((await s.store()).accepted)).toEqual([]);
		expect(await s.boxText(routinePath("tea"))).toBe(SHARED);
		expect(await ids()).toEqual([["tea", "allow"]]);
	});

	it("stale: a hash the box no longer holds is refused, 409, apart from a routine that is gone, 404", async () => {
		const s = await opened({ [routinePath("curro/tea")]: OWN });
		// the card showed the first version; the box holds the second by the time Allow arrives
		await writeFile(join(s.box.workspace, routinePath("curro/tea")), OWN_V2);
		const stale = await refused(() => accept(harness!, s.workspace, s.reconcile, "curro/tea", shaOf(OWN), 1));
		expect(stale).toEqual({ status: 409, message: `${routinePath("curro/tea")} changed since you saw it: look again` });
		expect(Object.keys((await s.store()).accepted)).toEqual([]);
		// allowed as it is now
		await accept(harness!, s.workspace, s.reconcile, "curro/tea", shaOf(OWN_V2), 2);
		expect((await s.store()).accepted[routinePath("curro/tea")]?.text).toBe(OWN_V2);
		// a later change declined: the version in effect is written back, whatever the box held
		await writeFile(join(s.box.workspace, routinePath("curro/tea")), OWN);
		await decline(harness!, s.workspace, "curro/tea");
		expect(await s.boxText(routinePath("curro/tea"))).toBe(OWN_V2);
		// the box's removal, allowed by null: its version in effect goes; then nothing is anywhere, and every action says so
		await s.box.env().remove(`${s.box.workspace}/${routinePath("curro/tea")}`, { force: true }, context);
		await accept(harness!, s.workspace, s.reconcile, "curro/tea", null, 3);
		expect(Object.keys((await s.store()).accepted)).toEqual([]);
		expect((await refused(() => accept(harness!, s.workspace, s.reconcile, "curro/tea", null, 4))).status).toBe(404);
		expect((await refused(() => decline(harness!, s.workspace, "curro/tea"))).status).toBe(404);
		expect((await refused(() => remove(harness!, s.workspace, s.reconcile, "curro/tea", 4))).status).toBe(404);
	});

	it("a one-time routine that ran, with a change waiting: the change is allowed as any other, its record kept", async () => {
		const once = "---\ndescription: Once\nat: 2099-01-02 09:00\n---\nONCE ASK.\n";
		const changed = once.replace("ONCE ASK.", "ONCE ASK, edited by Curro.");
		const s = await opened({ [routinePath("curro/once")]: changed });
		await harness!.commit(async (tx) => {
			(await tx.doc(Accepted)).files[routinePath("curro/once")] = { sha: shaOf(once), text: once, at: 1 };
			(await tx.doc(Routines)).routines["curro/once"] = { agent: "curro", sha: shaOf(once), done: 5, last: 5 };
		}, context);
		const [view] = await routines(harness!, s.workspace, 6);
		expect(view).toMatchObject({ id: "curro/once", state: "allow", done: 5, change: { kind: "changed" } });
		// a stale hash is stale, not gone
		expect((await refused(() => accept(harness!, s.workspace, s.reconcile, "curro/once", NOTHING, 7))).status).toBe(
			409,
		);
		await accept(harness!, s.workspace, s.reconcile, "curro/once", shaOf(changed), 7);
		const { accepted, records } = await s.store();
		expect(accepted[routinePath("curro/once")]?.text).toBe(changed);
		const record = records["curro/once"] as RoutineRecord;
		expect(record.allowed).toEqual([shaOf(changed)]);
		expect(record).toMatchObject({ agent: "curro", done: 5, last: 5 });
		// declining the next change writes the allowed version back, 404 for none
		await writeFile(join(s.box.workspace, routinePath("curro/once")), once);
		await decline(harness!, s.workspace, "curro/once");
		expect(await s.boxText(routinePath("curro/once"))).toBe(changed);
	});
});
