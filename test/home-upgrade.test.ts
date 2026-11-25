/**
 * An upgrade keeps the owner's home: every home under `fixtures/homes/` was left by a released build, and this build
 * opens each one, as a daemon would after the upgrade: it brings the home to its own format, lists the chats that were
 * there, goes on in one of them, and reads what was stored back through today's definitions.
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
import { describe, expect, it, vi } from "vitest";
import { isLoopbackHost } from "../src/core/addresses.ts";
import { Connected, credentialsOf, fits, WALLET, walletOf } from "../src/core/connections.ts";
import { shippedDefinition } from "../src/core/definitions.ts";
import { Devices } from "../src/core/devices.ts";
import { FORMAT_FLOOR, HOME_FORMAT } from "../src/core/format.ts";
import { routeKey } from "../src/core/gateway.ts";
import { Permissions } from "../src/core/permissions.ts";
import { RESTORED_MARKER, restoredOf } from "../src/core/restored.ts";
import { context, openStore } from "../src/core/store.ts";
import { Routes } from "../src/core/turn.ts";
import { startDaemon } from "../src/daemon.ts";
import { installationId } from "../src/home.ts";
import { Incoming, Wallets } from "../src/wallet/docs.ts";
import { canaryAccount, homeSecretAccount, leaseOf, walletAccount, walletPrefix } from "../src/wallet/home-id.ts";
import type { Keystore } from "../src/wallet/keystore.ts";
import { addressOf, type Key } from "../src/wallet/sign.ts";
import { CANARY_SLOTS, canary } from "../src/wallet/signer.ts";
import { type Expected, FIXTURE_KEYS, KEYCHAIN } from "./fixtures/homes/make.ts";
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

	it("names no wallet a fixture key does not derive (H-299)", async () => {
		const known = new Set(FIXTURE_KEYS.map((key) => addressOf(key).toLowerCase()));
		for (const { name } of fixtures) {
			const expected = JSON.parse(await readFile(join(HOMES, name, "expected.json"), "utf8")) as Expected;
			const wallets = (expected.wallets ?? { wallets: {} }) as { wallets: Record<string, unknown> };
			const incoming = (expected.incoming ?? { rows: {} }) as { rows: Record<string, { wallet: string }> };
			const named = [
				...Object.keys(wallets.wallets),
				...Object.keys(expected.accounts ?? {}),
				...Object.values(incoming.rows).map((row) => row.wallet),
			];
			if (name === "format-5") expect(named.length).toBeGreaterThan(0);
			for (const address of named) expect(known.has(address.toLowerCase()), `${name}: ${address}`).toBe(true);
		}
	});

	it("keeps no incoming row above its wallet's read, nor its network's cursor: a home no build leaves proves nothing (C22)", async () => {
		for (const { name } of fixtures) {
			const expected = JSON.parse(await readFile(join(HOMES, name, "expected.json"), "utf8")) as Expected;
			if (expected.incoming === undefined) continue;
			const incoming = expected.incoming as {
				rows: Record<string, { wallet: string; block: number }>;
				cursors: Record<string, number>;
				read?: Record<string, number>;
			};
			const network = (wallet: string) =>
				(expected.wallets as { wallets: Record<string, { network: string }> } | undefined)?.wallets[wallet]?.network;
			for (const [id, row] of Object.entries(incoming.rows)) {
				const read = incoming.read?.[row.wallet];
				expect(read, `${name}: ${id} has a wallet read`).toBeDefined();
				expect(row.block, `${name}: ${id} above its wallet's read`).toBeLessThanOrEqual(read as number);
				const cursor = incoming.cursors[network(row.wallet) ?? ""];
				expect(row.block, `${name}: ${id} above its network's cursor`).toBeLessThanOrEqual(cursor as number);
			}
		}
	});

	it.each(fixtures)("opens: $name (format $format)", async ({ name }) => {
		// a copy: the fixture is never opened where it is kept
		const home = await tempHome();
		await cp(join(HOMES, name), home, { recursive: true });
		// the store is the fixture: without it a new home opens, and proves nothing
		expect(existsSync(join(home, "durable.db")), `${name} has no store`).toBe(true);
		const expected = JSON.parse(await readFile(join(home, "expected.json"), "utf8")) as Expected;
		const threads = [...new Set(expected.said.map((said) => said.thread))];
		// the home's id as the released build left it: it names the keychain's items and the wallet's credentials, so
		// this build must read the same one, never make another
		const idFile = join(home, "auth", "device-id");
		const keptId = existsSync(idFile) ? (await readFile(idFile, "utf8")).trim() : undefined;

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
		// a kept home's wallets name public chains: whatever the daemon asks of a host off this computer is refused here,
		// through the fetch it is given and the process's own alike, and the process's own is never asked
		const outside: string[] = [];
		const onlyHere =
			(asked: string[] | undefined): typeof fetch =>
			async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (isLoopbackHost(url.hostname)) return realFetch(input, init);
				asked?.push(url.host);
				throw new TypeError("fetch failed: this test reaches nothing off this computer");
			};
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", onlyHere(outside));
		const daemon = await startDaemon({
			home,
			port: 0,
			models,
			log: () => {},
			box: hostBox(home),
			fetch: onlyHere(undefined),
		});
		try {
			const cli = async (...args: string[]) =>
				(await promisify(execFile)(process.execPath, ["src/cli/index.ts", ...args, "--home", home])).stdout;
			const status = await cli("status");
			for (const thread of threads)
				expect(status).toMatch(new RegExp(`^cli/owner${thread === "" ? "" : `/${thread}`} {2}#\\d+ {2}idle$`, "m"));
			// the chat goes on where it was
			const last = expected.said.at(-1)!;
			const more = last.thread === "" ? ["once more"] : ["--thread", last.thread, "once more"];
			expect(await cli("say", ...more)).toBe("Still here.\n");
			expected.said.push({ thread: last.thread, text: "once more", reply: "Still here." });
		} finally {
			await daemon.close();
			vi.unstubAllGlobals();
		}
		expect(outside).toEqual([]);
		expect(await readFile(join(home, "format"), "utf8")).toBe(`${HOME_FORMAT}\n`);
		if (existsSync(join(HOMES, name, RESTORED_MARKER))) expect(await restoredOf(home)).toMatch(/^[0-9a-f]{64}$/);
		if (existsSync(join(HOMES, name, KEYCHAIN))) {
			// the keychain's items as a released build wrote them, read by this build's own readers
			const items = JSON.parse(await readFile(join(HOMES, name, KEYCHAIN), "utf8")) as Record<string, string>;
			const keystore: Keystore = {
				read: async (account) => items[account] ?? null,
				write: async () => {
					throw new Error("a kept item is only read");
				},
				remove: async () => false,
				find: async (prefix) => Object.keys(items).filter((account) => account.startsWith(prefix)),
			};
			expect(keptId, `${name} keeps keychain items but not the home's id`).toBeDefined();
			const id = await installationId(home);
			expect(id).toBe(keptId);
			const { binding } = JSON.parse(items[homeSecretAccount(id)] ?? "{}") as { binding: string };
			expect(await leaseOf(keystore, { id, binding })).toEqual({ epoch: 1, mine: true });
			const keys = await keystore.find(walletPrefix(id));
			expect(keys.length).toBeGreaterThan(0);
			for (const account of keys)
				expect(walletAccount(id, addressOf((await keystore.read(account)) as Key))).toBe(account);
			// a canary a killed call left, in one of the home's slots: the next call on that slot takes it back, and no
			// call lists the keychain to find it
			const slots = Array.from({ length: CANARY_SLOTS }, (_, slot) => canaryAccount(id, slot));
			const canaries = slots.filter((account) => items[account] !== undefined);
			expect(canaries.length).toBeGreaterThan(0);
			for (const account of Object.keys(items).filter((one) => one.startsWith(`${id}/canary/`)))
				expect(slots).toContain(account);
			const copy = new Map(Object.entries(items));
			const mutable: Keystore = {
				read: async (account) => copy.get(account) ?? null,
				write: async (account, secret) => void copy.set(account, secret),
				remove: async (account) => copy.delete(account),
				find: async (prefix) => [...copy.keys()].filter((account) => account.startsWith(prefix)),
			};
			for (const account of canaries) await canary(mutable, { id, binding }, () => slots.indexOf(account));
			expect([...copy.keys()].filter((account) => account.startsWith(`${id}/canary/`))).toEqual([]);
			expect([...copy.keys()].sort()).toEqual(
				Object.keys(items)
					.filter((a) => !canaries.includes(a))
					.sort(),
			);
		}

		const store = await openStore(home, { models: createModels(), registry: createRegistry() });
		try {
			expect(await store.snapshot(Permissions, context)).toEqual(expected.permissions);
			expect(await store.snapshot(Devices, context)).toEqual(expected.devices);
			if (expected.wallets !== undefined) expect(await store.snapshot(Wallets, context)).toEqual(expected.wallets);
			if (expected.incoming !== undefined) expect(await store.snapshot(Incoming, context)).toEqual(expected.incoming);
			if (expected.config !== undefined) {
				const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { wallets?: unknown };
				expect({ wallets: config.wallets }).toEqual(expected.config);
			}
			for (const [account, kept] of Object.entries(expected.accounts ?? {})) {
				expect((await store.snapshot(Connected, context))?.accounts[WALLET]?.[account]).toEqual(kept.account);
				const credentials = await credentialsOf(home, WALLET, account);
				expect(credentials).toEqual(kept.credentials);
				// read as a whole wallet by this build, against the wallet connection it ships
				expect(walletOf(credentials), `${account} is not a wallet to this build`).toBeDefined();
				if (keptId !== undefined) expect(walletOf(credentials)?.account.startsWith(`${keptId}/wallet/`)).toBe(true);
				const shipped = shippedDefinition(WALLET);
				expect(shipped?.auth).toBe("wallet");
				expect(fits(credentials, shipped!)).toBe(true);
			}
			const { routes } = (await store.snapshot(Routes, context))!;
			for (const thread of threads) {
				const origin = { gateway: "cli", peer: "owner", ...(thread === "" ? {} : { thread }) };
				const chat = routes[routeKey(origin)]?.chat;
				expect(chat, `the chat of ${JSON.stringify(origin)}`).toBeDefined();
				const page = await (await store.conversation(chat as never, context))!.entries({}, 1000, undefined, context);
				const transcript = JSON.stringify(page.items);
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
