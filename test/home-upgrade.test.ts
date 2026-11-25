/**
 * An upgrade keeps the owner's home: every home under `fixtures/homes/` was left by a released build, and this build
 * opens each one, as a daemon would after the upgrade: it brings the home to its own format, lists the chats that were
 * there, takes one more message, and reads what was stored back through today's definitions. A chat of the CLI's own
 * (`cli/owner`, `cli/owner/<thread>`), from before the CLI wrote to an agent's one chat, is kept and listed with its
 * history; the CLI writes to the first agent's chat, which such a home gets with that message.
 *
 * A fixture is made once, by the build it is named after, and never edited or made again: later builds change, the
 * home an owner already has does not. When one is due:
 * - The format moves (a step joins `MIGRATIONS` in `src/core/format.ts`). In the commit that adds the step, run
 *   `node test/fixtures/homes/make.ts format-<the new format>` and commit the folder with it: the first test below
 *   fails until every format since the floor has a home. The earlier fixtures stay, and now pass through the new step:
 *   what the step converts is asserted here, on them.
 * - A release. `node test/fixtures/homes/make.ts` names the folder by package.json's version; a home of the same
 *   format as the one before still differs in what the build stored (a new doc, a newer pi-durable).
 * - `make.ts` grows when a build stores something no fixture holds; what it adds to `expected.json` is optional in
 *   `Expected`, since the earlier fixtures lack it.
 *
 * A fixture that stops opening is never fixed by changing the fixture: the build is missing a migration.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Devices } from "../src/core/devices.ts";
import { FORMAT_FLOOR, HOME_FORMAT } from "../src/core/format.ts";
import { MAIN_THREAD, OWNER, routeKey } from "../src/core/gateway.ts";
import { Permissions } from "../src/core/permissions.ts";
import { context, openStore } from "../src/core/store.ts";
import { Routes } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import type { Expected } from "./fixtures/homes/make.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { tempHome } from "./helpers.ts";

const HOMES = join(import.meta.dirname, "fixtures/homes");
const fixtures = readdirSync(HOMES, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => ({ name: entry.name, format: Number(readFileSync(join(HOMES, entry.name, "format"), "utf8")) }));

describe("a home an earlier build left", () => {
	it("is kept for every format since the floor", () => {
		const kept = new Set(fixtures.map((fixture) => fixture.format));
		for (let format = FORMAT_FLOOR; format <= HOME_FORMAT; format++)
			expect(kept.has(format), `no home in format ${format} under test/fixtures/homes`).toBe(true);
	});

	it.each(fixtures)("opens: $name (format $format)", async ({ name }) => {
		// a copy: the fixture is never opened where it is kept
		const home = await tempHome();
		await cp(join(HOMES, name), home, { recursive: true });
		// the store is the fixture: without it a new home opens, and proves nothing
		expect(existsSync(join(home, "durable.db")), `${name} has no store`).toBe(true);
		const expected = JSON.parse(await readFile(join(home, "expected.json"), "utf8")) as Expected;
		const threads = [...new Set(expected.said.map((said) => said.thread))];

		// the fixture's chats ran on the faux provider's first model; here it answers one more message, whatever the
		// request holds (the home has moved, so the prompt's paths have: the echo fixture would take that for a reply)
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("message_user", { text: "Still here." }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Told them."),
		]);
		const daemon = await startDaemon({ home, port: 0, models, log: () => {}, box: hostBox(home) });
		try {
			const cli = async (...args: string[]) =>
				(await promisify(execFile)(process.execPath, ["src/cli/index.ts", ...args, "--home", home])).stdout;
			const status = await cli("status");
			for (const thread of threads)
				expect(status).toMatch(
					new RegExp(`^(cli/owner${thread === "" ? "|web/owner/main" : `/${thread}`}) {2}#\\d+ {2}idle$`, "m"),
				);
			// the first agent's chat takes the next message
			expect(await cli("say", "once more")).toBe("Still here.\n");
		} finally {
			await daemon.close();
		}
		expect(await readFile(join(home, "format"), "utf8")).toBe(`${HOME_FORMAT}\n`);

		const store = await openStore(home, { models: createModels(), registry: createRegistry() });
		try {
			expect(await store.snapshot(Permissions, context)).toEqual(expected.permissions);
			expect(await store.snapshot(Devices, context)).toEqual(expected.devices);
			const { routes } = (await store.snapshot(Routes, context))!;
			const transcriptOf = async (chat: number | undefined) =>
				JSON.stringify(
					(await (await store.conversation(chat as never, context))!.entries({}, 1000, undefined, context)).items,
				);
			const main = routes[routeKey({ gateway: "web", peer: OWNER, thread: MAIN_THREAD })]?.chat;
			expect(main, "the first agent's chat").toBeDefined();
			const latest = await transcriptOf(main);
			expect(latest).toContain("once more");
			expect(latest).toContain("Still here.");
			for (const thread of threads) {
				// a chat of the CLI's own where the home kept one, else the first agent's
				const origin = { gateway: "cli", peer: "owner", ...(thread === "" ? {} : { thread }) };
				const chat = routes[routeKey(origin)]?.chat ?? (thread === "" ? main : undefined);
				expect(chat, `the chat of ${JSON.stringify(origin)}`).toBeDefined();
				const transcript = await transcriptOf(chat);
				for (const said of expected.said.filter((said) => said.thread === thread)) {
					expect(transcript).toContain(said.text);
					expect(transcript).toContain(said.reply);
				}
			}
		} finally {
			await store.close(context);
		}
	});
});
