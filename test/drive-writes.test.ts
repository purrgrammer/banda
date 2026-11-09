/**
 * An agent's Drive change through the capabilities, against a fake Google: it becomes a draft in the owner's words with
 * nothing to edit; approving runs it once, exactly as drafted; denying runs nothing. A "don't ask again" permission
 * binds every argument, because no argument is edited.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { openConnected } from "./fixtures/connected.ts";
import { fakeDrive } from "./fixtures/google-drive.ts";
import { answerNudge } from "./fixtures/models.ts";
import { tempHome } from "./helpers.ts";

const READ = "https://www.googleapis.com/auth/drive.readonly";
const FILE = "https://www.googleapis.com/auth/drive.file";
const web = { gateway: "web", peer: OWNER };

const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
afterEach(async () => {
	for (const connected of opened.splice(0)) await connected.close();
});

const CELLS = "https://www.googleapis.com/auth/spreadsheets";
const TEXT = "https://www.googleapis.com/auth/documents";
/** A Doc the owner already has, with a comment on it. */
const PLAN = {
	d1: {
		id: "d1",
		name: "Q1 plan",
		mimeType: "application/vnd.google-apps.document",
		trashed: false,
		modifiedTime: "2026-11-05T16:42:10.000Z",
		text: "# Q1 plan\nPlatform moves first",
		comments: [{ id: "c1", content: "Dates?", resolved: false, author: { displayName: "Ana" }, replies: [] }],
	},
};
/** A Sheet the owner already has, with a budget tab: the fake Google starts with it. */
const BUDGET = {
	s1: {
		id: "s1",
		name: "Economía",
		mimeType: "application/vnd.google-apps.spreadsheet",
		trashed: false,
		modifiedTime: "2026-11-01T09:47:37.699Z",
		tabs: ["🏠", "2027"],
		cells: {
			"🏠": [
				["ingresos", "", "gastos"],
				["6385", "", "30"],
			],
			"2027": [],
		},
	},
};

async function connectedWith(
	call: { tool: string; args: JsonObject },
	scopes = [READ, FILE],
	seed?: typeof BUDGET | typeof PLAN,
) {
	const home = await tempHome();
	const shipped = join(home, "shipped");
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "drive.md"),
		readFileSync(new URL("../shipped/connections/drive.md", import.meta.url), "utf8"),
	);
	const google = fakeDrive(seed === undefined ? {} : { seed });
	const s = await openConnected({
		home,
		shipped,
		fetch: google.fetch,
		respond: ((ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const heed = answerNudge(ctx.messages);
			if (heed !== undefined) return heed;
			const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
			if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
			return fauxAssistantMessage([fauxToolCall(`drive__${call.tool}`, call.args, { id: "c1" })], {
				stopReason: "toolUse",
			});
		}) as never,
	});
	opened.push(s);
	await s.capabilities.addShipped("drive");
	const started = await s.capabilities.signIn("drive", context, LEAD, { scopes });
	if (!("url" in started)) throw new Error("a Google sign-in opens a page");
	const state = new URL(started.url).searchParams.get("state") ?? "";
	expect(await s.capabilities.callback({ state, code: "fake-code" })).toMatchObject({ ok: true });
	return { s, google, call };
}

async function drafted(connected: Awaited<ReturnType<typeof connectedWith>>) {
	const { s } = connected;
	expect(s.offered()).toContain(`drive__${connected.call.tool}`);
	const received = await s.core.receive(s.harness, {
		id: "m1",
		origin: { gateway: "fake", peer: OWNER },
		text: "please",
	});
	if (!("turn" in received)) throw new Error(JSON.stringify(received));
	const turn = received.turn as TaskId<TurnResult>;
	while (true) {
		const open = (await openWaits(s.harness)).find((wait) => wait.ask.type === "approval");
		if (open !== undefined) return { wait: open, turn };
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("Drive changes as drafts", () => {
	it("a created Doc is a draft in the owner's words with nothing to edit; approved, it runs once as drafted", async () => {
		const connected = await connectedWith({
			tool: "create_doc",
			args: { title: "Q1 plan", markdown: "# Plan\n\n- one" },
		});
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			tool: "drive__create_doc",
			label: "Create the Doc “Q1 plan”",
			verb: "Create",
			args: { title: "Q1 plan", markdown: "# Plan\n\n- one" },
		});
		expect(wait.ask.editable ?? []).toEqual([]);
		// not on a floor: a permission may be offered, and it binds every argument
		expect(wait.ask.floor).toBeUndefined();
		expect(wait.ask).toHaveProperty("permission");
		expect(google.writes).toEqual([]);
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toHaveLength(1);
		const files = Object.values(google.files());
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			name: "Q1 plan",
			mimeType: "application/vnd.google-apps.document",
			text: "# Plan\n\n- one",
		});
		expect(JSON.stringify(await s.harness.getTask(turn, context))).not.toContain("fake-drive-access-token");
	});

	it("edits the owner sends are not taken: the file is made as drafted", async () => {
		const connected = await connectedWith({ tool: "create_sheet", args: { title: "Budget", csv: "a,b\n1,2" } });
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({ label: "Create the Sheet “Budget”" });
		const refused = await answer(s.harness, wait.key, "approve", web, "bearer", {
			type: "approval",
			approving: { edits: { title: "Other", csv: "evil" } },
		});
		// an edit to a field nothing edits is refused; the draft stays open and is approved as it is
		expect(refused).toHaveProperty("refused");
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(Object.values(google.files()).map((file) => [file.name, file.text])).toEqual([["Budget", "a,b\n1,2"]]);
	});

	it("cells written into a Sheet are a draft naming the tab and range; approved with Change your spreadsheets alone, they land once", async () => {
		const connected = await connectedWith(
			{ tool: "update_range", args: { file_id: "drive/s1", range: "🏠!C2", rows: "95" } },
			[READ, CELLS],
			BUDGET,
		);
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			tool: "drive__update_range",
			label: "Write “🏠!C2” of this Sheet",
			verb: "Write",
			// the draft shows the file's id as its card names it, without the reference's drive/
			args: { file_id: "s1", range: "🏠!C2", rows: "95" },
		});
		expect(wait.ask.editable ?? []).toEqual([]);
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toEqual([{ method: "PUT", path: "sheets/s1/values/🏠!C2", body: [["95"]] }]);
		expect(google.files().s1?.cells).toEqual({
			"🏠": [
				["ingresos", "", "gastos"],
				["6385", "", "95"],
			],
			"2027": [],
		});
	});

	it("rows added to a tab are a draft; approved, they follow the last row", async () => {
		const connected = await connectedWith(
			{ tool: "append_rows", args: { file_id: "drive/s1", sheet: "2027", rows: "a,b\n1,2" } },
			[READ, CELLS],
			BUDGET,
		);
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		expect(wait.ask).toMatchObject({ label: "Add 2 rows to the tab “2027” of this Sheet", verb: "Add" });
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.files().s1?.cells).toMatchObject({
			"2027": [
				["a", "b"],
				["1", "2"],
			],
		});
	});

	it("text added to a Doc is a draft; approved with Change your documents alone, it follows the last paragraph", async () => {
		const connected = await connectedWith(
			{ tool: "append_doc_text", args: { file_id: "drive/d1", markdown: "## Decisions\n- Payments next" } },
			[READ, TEXT],
			PLAN,
		);
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		expect(wait.ask).toMatchObject({ label: "Add text at the end of this Doc", verb: "Add" });
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.files().d1?.text).toBe("# Q1 plan\nPlatform moves first\nDecisions\nPayments next");
		expect(google.writes).toHaveLength(1);
	});

	it("a reply to a comment is a draft; approved, it is posted in the owner's name and resolves the comment when asked", async () => {
		const connected = await connectedWith(
			{ tool: "reply_comment", args: { file_id: "drive/d1", comment_id: "c1", text: "Added them.", resolve: true } },
			[READ, FILE],
			PLAN,
		);
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		expect(wait.ask).toMatchObject({ label: "Reply to a comment on this file and resolve it", verb: "Reply" });
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		const comment = (
			google.files().d1?.comments as { resolved: boolean; replies: { content: string }[] }[] | undefined
		)?.[0];
		expect(comment).toMatchObject({ resolved: true, replies: [{ content: "Added them.", action: "resolve" }] });
	});

	it("a denied trash runs nothing", async () => {
		const connected = await connectedWith({ tool: "trash_file", args: { file_id: "f1" } });
		const { s, google } = connected;
		const { wait, turn } = await drafted(connected);
		expect(wait.ask).toMatchObject({ label: "Move this file to the trash", verb: "Trash" });
		await answer(s.harness, wait.key, "deny", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toEqual([]);
	});
});
