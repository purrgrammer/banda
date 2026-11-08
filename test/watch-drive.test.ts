import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/follow.ts";
import { REST_APIS } from "../src/core/rest.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

/** Google Drive as banda ships it, signed in as me@example.com. */
const DRIVE = {
	name: "drive",
	file: readFileSync(new URL("../shipped/connections/drive.md", import.meta.url), "utf8"),
	tools: REST_APIS.drive.tools,
	account: "me@example.com",
};

type File = { [key: string]: Json };

/** A Doc as `get_file` answers it: last changed by the account, in one folder, shared with Mira, its owner. */
const plan = (): File => ({
	ref: "drive/1aBc",
	name: "Plan",
	kind: "doc",
	mimeType: "application/vnd.google-apps.document",
	owner: "Mira",
	modified: "2026-11-02T08:00:00.000Z",
	size: null,
	description: "",
	url: "https://docs.google.com/document/d/1aBc/edit",
	modifier: { name: "Me", email: "me@example.com" },
	parents: ["0Work"],
	trashed: false,
	shared: [{ id: "p1", who: "Mira", role: "owner" }],
});

const ana = { name: "Ana", email: "ana@example.com" };
const me = { name: "Me", email: "me@example.com" };

/** The file's life: each step's answer is the one before, changed by that step's change. */
const life =
	(...steps: ((file: File) => void)[]): Answer =>
	(tool, args, step) => {
		if (tool !== "get_file" || args.file_id !== "1aBc") return failure(`no ${tool}`);
		const file = plan();
		for (const change of steps.slice(0, step)) change(file);
		return file;
	};

const follow = async (answer: Answer, clicks: string[], object = "drive/1aBc") => {
	const summary = await watchScenario(await tempHome(), new Faults(), {
		connection: DRIVE,
		object,
		answer,
		clicks,
	});
	expect(watchInvariants(summary)).toEqual([]);
	expect(summary.record.failed).toBeUndefined();
	return summary;
};

describe("a watch on a Drive file", () => {
	it("another's edit wakes in their name; the account's own edit is nothing", async () => {
		const summary = await follow(
			life(
				(file) => Object.assign(file, { modified: "2026-11-02T09:10:00.000Z", modifier: ana, size: null }),
				(file) => Object.assign(file, { modified: "2026-11-02T09:20:00.000Z", modifier: me }),
			),
			["k1", "k2"],
		);
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended ?? null])).toEqual([[["Ana edited it"], null]]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "1aBc", service: "Google Drive" });
		expect(summary.record.done).toBeUndefined();
	}, 60_000);

	it("renamed, moved and shared with someone new each only tell", async () => {
		const summary = await follow(
			life(
				(file) => Object.assign(file, { name: "Plan 2027", modifier: ana }),
				(file) => Object.assign(file, { parents: ["0Archive"] }),
				(file) => {
					(file.shared as Json[]).push({ id: "p2", who: "Bo", role: "writer" });
				},
			),
			["k1", "k2", "k3"],
		);
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => tell.changes)).toEqual([["renamed: Plan 2027"], ["moved"], ["shared with Bo"]]);
		expect(summary.turns).toEqual([]);
		expect(summary.unread).toBe(0);
	}, 60_000);

	it("trashed wakes and ends it", async () => {
		const summary = await follow(
			life((file) => Object.assign(file, { trashed: true, modifier: ana })),
			["k1", "k2"],
		);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended])).toEqual([[["trashed"], "trashed"]]);
		expect(summary.record.done?.why).toBe("trashed");
		expect(summary.turns.every((turn) => turn?.status === "completed")).toBe(true);
	}, 60_000);

	it("the account's own trashing still ends it, saying so", async () => {
		const summary = await follow(
			life((file) => Object.assign(file, { trashed: true })),
			["k1"],
		);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended])).toEqual([[["trashed"], "trashed"]]);
		expect(summary.record.done?.why).toBe("trashed");
	}, 60_000);
});

/** A folder as `get_file` answers it, last changed by the account. */
const work = (): File => ({
	...plan(),
	ref: "drive/0Work",
	name: "Work",
	kind: "folder",
	mimeType: "application/vnd.google-apps.folder",
	url: "https://drive.google.com/drive/folders/0Work",
	parents: ["0Root"],
});

type Listed = { ref: string; name: string; kind: string; modified: string; owner: string };

/**
 * The folder's life, as `get_file` and `search_files` ("'0Work' in parents", newest made first) answer it: Plan in it;
 * then Ana adds Budget while Plan is edited; then Plan leaves the folder; then the folder is trashed.
 */
const folder: Answer = (tool, args, step) => {
	if (tool === "get_file" && args.file_id === "0Work")
		return step >= 3 ? { ...work(), trashed: true, modifier: ana } : work();
	if (tool !== "search_files" || args.query !== "'0Work' in parents" || args.order !== "created")
		return failure(`no ${tool}`);
	const files: Listed[] = [];
	if (step >= 1)
		files.push({ ref: "drive/2Bud", name: "Budget", kind: "sheet", modified: "2026-11-02T09:10:00Z", owner: "Ana" });
	if (step < 2)
		files.push({
			ref: "drive/1aBc",
			name: "Plan",
			kind: "doc",
			modified: step >= 1 ? "2026-11-02T09:11:00Z" : "2026-11-02T08:00:00Z",
			owner: "Mira",
		});
	return { files } as unknown as Json;
};

describe("a watch on a Drive folder", () => {
	it("a new file in it wakes; a file edited or gone from it is nothing; trashed wakes and ends it", async () => {
		const summary = await follow(folder, ["k1", "k2", "k3"], "https://drive.google.com/drive/folders/0Work");
		expect(summary.tells).toEqual([]);
		expect(summary.wakes.map((wake) => [wake.changes, wake.ended ?? null])).toEqual([
			[["new file: Budget"], null],
			[["trashed"], "trashed"],
		]);
		expect(summary.wakes[0]?.object).toMatchObject({ name: "folder 0Work", service: "Google Drive" });
		expect(summary.record.done?.why).toBe("trashed");
	}, 60_000);

	it("its ref, drive/folder/<id>, names it as its link does", async () => {
		const summary = await follow(folder, ["k1"], "drive/folder/0Work");
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["new file: Budget"]]);
	}, 60_000);
});
