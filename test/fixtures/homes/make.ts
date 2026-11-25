/**
 * Makes a home as this build leaves one, to be kept under `test/fixtures/homes/<name>/` for every later build to open
 * (`test/home-upgrade.test.ts` says when one is due): `node test/fixtures/homes/make.ts [name]`, the name by default
 * the version in package.json. A real daemon, on pi-ai's faux provider and the host box, takes two chats from the CLI;
 * then a permission, a device, a wallet (its record, the money that came in to it, and its account of the wallet
 * connection with the credentials that say where its key is) are stored through the build's own definitions, and the
 * config names the owner's RPC for its network. Only shapes a released build stores go in: payments and recipients
 * wait for the build that sends. The daemon is given the in-memory keystore and the home a test home's marker, so it never
 * opens the OS keychain. Beside the home's files, `keychain.json` keeps the keychain items this build writes, in the
 * shapes it writes them (a lease, a home secret, a wallet's key, and a canary a call killed at its deadline left), and
 * the home's root a restore's marker. The wallet is made from `FIXTURE_KEYS`, keys made up for fixtures whose addresses
 * nobody else holds (H-299). All of it is invented: the repository is public, so the daemon runs in UTC on a clock
 * moved to a fixed start, and the store keeps neither the zone nor the hour of the machine that made it, nor its
 * user's folders: the home is a folder of its own under /tmp. A fixture is made once and never again: it refuses a
 * name that exists.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { LEAD } from "../../../src/core/agents.ts";
import { accountKey, Connected, credentialsOf, keepCredentials, WALLET } from "../../../src/core/connections.ts";
import { Devices } from "../../../src/core/devices.ts";
import { Permissions } from "../../../src/core/permissions.ts";
import { RESTORED_MARKER } from "../../../src/core/restored.ts";
import { context, openStore } from "../../../src/core/store.ts";
import { startDaemon } from "../../../src/daemon.ts";
import { type Address, checksummed } from "../../../src/wallet/address.ts";
import { Incoming, incomingKey, nativeKey, Wallets } from "../../../src/wallet/docs.ts";
import {
	canaryAccount,
	homeSecretAccount,
	leaseAccount,
	markTestHome,
	walletAccount,
} from "../../../src/wallet/home-id.ts";
import { addressOf, type Key } from "../../../src/wallet/sign.ts";
import { hostBox } from "../host-box.ts";
import { echoModels } from "../models.ts";

/** What a fixture holds, for the test that opens it: kept beside it as `expected.json`. */
export type Expected = {
	/** What was said in each chat, by the CLI's thread ("" the main one), and what came back. */
	readonly said: { readonly thread: string; readonly text: string; readonly reply: string }[];
	readonly permissions: unknown;
	readonly devices: unknown;
	/**
	 * The wallets doc, from format 5: a ready wallet, its key saved, the code at its address acknowledged, its creation's
	 * reveal never spent and its key shown later; and a ready wallet made from a paired device, its key not saved (no key).
	 */
	readonly wallets?: unknown;
	/**
	 * The wallet's account, from format 5: the connections doc's account and the credentials kept for it (where its key
	 * is, never the key), by account.
	 */
	readonly accounts?: { readonly [account: string]: { readonly account: unknown; readonly credentials: unknown } };
	/**
	 * The money that came in, from format 5: a token's row and a native one, the network's final cursor, how far the
	 * wallet is read, and a gap of each kind.
	 */
	readonly incoming?: unknown;
	/** The wallets' part of `config.json`, from format 5: the owner's RPC for the wallet's network (invented). */
	readonly config?: unknown;
};

/**
 * The home's files a fixture keeps: the store, its format, the config, the definitions the store accepted, the
 * connections' credentials (the wallet's alone: no other is signed in), and the home's id, which names its keychain
 * items and its wallet's credentials.
 */
export const KEPT = [
	"format",
	"durable.db",
	"config.json",
	"workspace/agents",
	"auth/connections",
	"auth/device-id",
] as const;

/** The keychain items a fixture keeps beside its home, by account (`keychain.json`), from format 5. */
export const KEYCHAIN = "keychain.json";

const hex = (of: string) => createHash("sha256").update(`banda fixture ${of}`).digest("hex");

/**
 * The keys a kept home's wallets are made from: invented for fixtures, so every address a fixture names is one a key
 * here derives, never someone's (H-299); test/home-upgrade.test.ts holds every kept home to them.
 */
export const FIXTURE_KEYS: readonly Key[] = [
	`0x${hex("wallet key")}` as Key,
	`0x${hex("device wallet key")}` as Key,
	`0x${hex("archived wallet key")}` as Key,
	`0x${hex("removed wallet key")}` as Key,
];

/** The keys of the wallets a kept home still has, archived ones too: the last fixture key's wallet was removed. */
const KEPT_KEYS = FIXTURE_KEYS.slice(0, 3);

/** The home's id, invented: written before its daemon starts, so the daemon keeps it rather than making one. */
export const FIXTURE_HOME_ID = (() => {
	const h = hex("home id");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
})();

/** Where the fixture's clock starts: the time every invented fact in it is stored at. */
const START = 1_700_000_000_000;

/**
 * The keychain items this build writes for the home `id`, invented and the same on every machine: its home secret, its
 * lease, its wallet's key, and a canary in one of the home's slots, as a call killed at its deadline leaves one.
 */
export function keychainOf(id: string): Record<string, string> {
	const secret = hex("home secret");
	return {
		[homeSecretAccount(id)]: JSON.stringify({ secret, binding: hex("binding") }),
		[leaseAccount(id)]: JSON.stringify({ epoch: 1, holder: createHash("sha256").update(secret).digest("hex") }),
		...Object.fromEntries(KEPT_KEYS.map((key) => [walletAccount(id, addressOf(key)), key])),
		[canaryAccount(id, 3)]: hex("canary value").slice(0, 32),
	};
}

/** The restore's marker a fixture's home keeps at its root, from format 5, as `markRestored` writes one. */
export const restoredMarker = () =>
	`${JSON.stringify({ restored: createHash("sha256").update("banda fixture restore").digest("hex") })}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) await make();

async function make(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const version = (JSON.parse(await readFile(join(here, "../../../package.json"), "utf8")) as { version: string })
		.version;
	const to = join(here, process.argv[2] ?? version);
	if (existsSync(to)) throw new Error(`${to} exists: a fixture is made once`);
	// under /tmp, not the user's temporary folder: the host box's prompt names its workspace, and the store keeps it
	const home = await mkdtemp("/tmp/banda-home-fixture-");
	await markTestHome(home);
	await mkdir(join(home, "auth"), { recursive: true, mode: 0o700 });
	await writeFile(join(home, "auth", "device-id"), `${FIXTURE_HOME_ID}\n`, { mode: 0o600 });
	process.env.BANDA_TEST_KEYSTORE = "1";
	process.env.BANDA_REMOTE = "off";
	process.env.TZ = "UTC";
	const real = Date.now;
	const offset = START - real();
	Date.now = () => real() + offset;
	try {
		const config = { wallets: { rpc: { "base-sepolia": "https://rpc.example/base-sepolia" } } };
		await writeFile(
			join(home, "config.json"),
			JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, ...config }),
		);
		const daemon = await startDaemon({ home, port: 0, models: echoModels().models, log: () => {}, box: hostBox(home) });
		const said: Expected["said"][number][] = [];
		try {
			for (const [thread, text] of [
				["", "is anyone there"],
				["work", "the tide tables for Thursday"],
				["work", "and for Friday"],
			] as const) {
				const args = thread === "" ? [text] : ["--thread", thread, text];
				const { stdout } = await promisify(execFile)(process.execPath, [
					join(here, "../../../src/cli/index.ts"),
					"say",
					...args,
					"--home",
					home,
				]);
				said.push({ thread, text, reply: stdout.trimEnd() });
			}
		} finally {
			await daemon.close();
		}
		const store = await openStore(home, { models: createModels(), registry: createRegistry() });
		let permissions: unknown;
		let devices: unknown;
		let wallets: unknown;
		let accounts: Expected["accounts"];
		let incoming: unknown;
		const address = checksummed(addressOf(FIXTURE_KEYS[0] as Key));
		const account = accountKey(address);
		const credentials = {
			wallet: { account: walletAccount(FIXTURE_HOME_ID, address as Address), address, network: "base-sepolia" },
			generation: "generation-1",
		} as const;
		// a wallet made from a paired device: no reveal, its key not saved yet (H-264, H-276)
		const fromDevice = checksummed(addressOf(FIXTURE_KEYS[1] as Key));
		const deviceAccount = accountKey(fromDevice);
		const deviceCredentials = {
			wallet: {
				account: walletAccount(FIXTURE_HOME_ID, fromDevice as Address),
				address: fromDevice,
				network: "base-sepolia",
			},
			generation: "generation-1",
		} as const;
		// a wallet the owner archived after saving its key: the archive is the act that last moved it (C21)
		const archived = checksummed(addressOf(FIXTURE_KEYS[2] as Key));
		const archivedAccount = accountKey(archived);
		const archivedCredentials = {
			wallet: {
				account: walletAccount(FIXTURE_HOME_ID, archived as Address),
				address: archived,
				network: "base-sepolia",
			},
			generation: "generation-1",
		} as const;
		// a wallet removed, its key item gone with it: its address kept a while, for a retry of the removal (C21)
		const removed = checksummed(addressOf(FIXTURE_KEYS[3] as Key));
		try {
			// kept before the commit that names them, as a sign-in keeps them
			await keepCredentials(home, WALLET, account, credentials);
			await keepCredentials(home, WALLET, deviceAccount, deviceCredentials);
			await keepCredentials(home, WALLET, archivedAccount, archivedCredentials);
			await store.commit(async (tx) => {
				const given = await tx.doc(Permissions);
				given.permissions["1"] = {
					tool: "tides__read",
					match: { port: "Vigo" },
					what: "read the tide tables for Vigo",
					scope: "always",
					agent: LEAD,
					at: 1_700_000_000_000,
					wait: 0,
				};
				given.next = 2;
				const paired = await tx.doc(Devices);
				paired.devices["a".repeat(64)] = { name: "Pixel", paired: 1_700_000_000_000 };
				paired.devices["b".repeat(64)] = { name: "Tablet", paired: 1_700_000_000_000, revoked: 1_700_000_100_000 };
				const connected = await tx.doc(Connected);
				connected.added[WALLET] = { at: 1_700_000_030_000 };
				connected.accounts[WALLET] = {
					[account]: { id: address, at: 1_700_000_030_000, generation: "generation-1" },
					[deviceAccount]: { id: fromDevice, at: 1_700_000_050_000, generation: "generation-1" },
					[archivedAccount]: { id: archived, at: 1_700_000_060_000, generation: "generation-1" },
				};
				connected.epoch++;
				const kept = await tx.doc(Wallets);
				kept.lease = 1;
				kept.wallets[address] = {
					name: "Groceries",
					network: "base-sepolia",
					state: "ready",
					backup: "saved",
					default: "ask",
					disclosed: true,
					request: "create-1",
					// the creation's reveal, never spent and long expired: a record keeps it until an archive or a removal
					reveal: { expires: 1_700_000_600_000, digest: "6".repeat(64) },
					// the key shown again later, in banda's desktop app, by the id its take-back is keyed on
					reveals: [{ at: 1_700_000_020_000, kind: "later", id: "5a1b2c3d-0000-4000-8000-000000000005" }],
					code: { hash: "5".repeat(64), block: 4, acknowledged: 1_700_000_040_000 },
					// the owner's Saved it, the act that last moved its state, at the version its commit gave (C21)
					moved: { act: "confirm_saved", version: 3 },
					version: 4,
					at: 1_700_000_000_000,
				};
				kept.wallets[archived] = {
					name: "Holiday",
					network: "base-sepolia",
					state: "archived",
					backup: "saved",
					default: "deny",
					disclosed: true,
					request: "create-3",
					reveals: [{ at: 1_700_000_061_000, kind: "creation" }],
					moved: { act: "archive", version: 3 },
					version: 3,
					at: 1_700_000_060_000,
				};
				kept.removed = { [removed]: 1_700_000_070_000 };
				kept.wallets[fromDevice] = {
					name: "Pocket money",
					network: "base-sepolia",
					state: "ready",
					backup: "unsaved",
					default: "ask",
					disclosed: false,
					request: "create-2",
					device: true,
					version: 2,
					at: 1_700_000_050_000,
				};
				const came = await tx.doc(Incoming);
				came.rows[incomingKey(`0x${"3".repeat(64)}`, 7)] = {
					wallet: address,
					asset: "usdc",
					amount: "2500000",
					from: `0x${"d".repeat(40)}`,
					block: 101,
				};
				came.rows[nativeKey(address, 104)] = {
					wallet: address,
					asset: "native",
					amount: "1000000000000000",
					block: 104,
				};
				// the indexer writes a range's rows in the commit that moves `read` to its end: no row above it
				came.cursors["base-sepolia"] = 104;
				came.read = { [address]: 104 };
				came.gaps = {
					[address]: [
						{ from: 10, to: 12, why: "state" },
						{ from: 20, to: 20, why: "unexplained" },
						{ from: 30, to: 31, why: "code" },
					],
				};
				came.dropped = { [address]: 100 };
			}, context);
			permissions = await store.snapshot(Permissions, context);
			const connected = await store.snapshot(Connected, context);
			const listed: { [account: string]: { account: unknown; credentials: unknown } } = {};
			for (const each of [account, deviceAccount, archivedAccount])
				listed[each] = {
					account: connected?.accounts?.[WALLET]?.[each],
					credentials: await credentialsOf(home, WALLET, each),
				};
			accounts = listed;
			devices = await store.snapshot(Devices, context);
			wallets = await store.snapshot(Wallets, context);
			incoming = await store.snapshot(Incoming, context);
		} finally {
			await store.close(context);
		}
		if (existsSync(join(home, "durable.db-wal")))
			throw new Error("the store left a write-ahead log: not all in one file");
		await mkdir(to);
		for (const kept of KEPT) await cp(join(home, kept), join(to, kept), { recursive: true });
		// the publications folder under agents is the daemon's work in flight, not a definition
		await rm(join(to, "workspace/agents/.banda-publications"), { recursive: true, force: true });
		await writeFile(join(to, KEYCHAIN), `${JSON.stringify(keychainOf(FIXTURE_HOME_ID), null, "\t")}\n`);
		await writeFile(join(to, RESTORED_MARKER), restoredMarker());
		const expected: Expected = { said, permissions, devices, wallets, accounts, incoming, config };
		await writeFile(join(to, "expected.json"), `${JSON.stringify(expected, null, "\t")}\n`);
		console.log(to);
	} finally {
		Date.now = real;
		await rm(home, { recursive: true, force: true });
	}
}
