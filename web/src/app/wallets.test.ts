/**
 * The daemon's wallets as the screens draw them: a balance not read is unknown, never zero; a network with no USDC shows
 * ETH alone; the one offline reason comes from the wallet's state, its key's last check, then why agents cannot use
 * any wallet, each by its fixed word; a refusal is told by its code, never its words; an RPC is only ever its masked
 * form, said when it refuses log queries; a saved copy is checked by the SHA-256 the signer compares; the money that
 * came in is listed by day, Received until final.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { keyDigest as signerDigest } from "../../../src/wallet/signer.ts";
import { CODES } from "../../../src/wallet/signer-protocol.ts";
import { OFFLINE, removeWords } from "../chat/Wallets.tsx";
import type { WalletNetworkView, WalletView } from "../lib/api.ts";
import {
	activityRows,
	choices,
	createdReason,
	createdState,
	DESKTOP_WORDS,
	desktopFailure,
	firstReminder,
	firstSaveStep,
	groupedUnits,
	incomingRows,
	incompleteOf,
	keyDigest,
	keyOffline,
	keySaves,
	nameTaken,
	offlineOf,
	REASON_OF_CODE,
	remindsToSave,
	rpcRows,
	savesOnOpen,
	sharedBy,
	shownWallet,
	unswitchable,
	wrongCopy,
} from "./wallets.ts";

const NETWORKS: WalletNetworkView[] = [
	{
		id: "base",
		label: "Base",
		testnet: false,
		rpc: "https://base-rpc.publicnode.com",
		set: false,
		shipped: true,
		usdc: true,
	},
	{ id: "anvil", label: "Local chain", testnet: true, rpc: "http://127.0.0.1:8545/…", set: true, shipped: false },
];

const WALLET: WalletView = {
	address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
	name: "Travel",
	network: "base",
	state: "ready",
	backup: "unsaved",
	disclosed: false,
	version: 3,
	at: 1,
	agents: ["mara"],
};

const who = (id: string) => ({ id, name: id === "mara" ? "Mara" : id, face: defaultAvatarFace() });
// noon where the test runs: the rows a minute before it fall on the same local day in any time zone
const NOW = new Date(2026, 10, 24, 12).getTime();

describe("wallets as shown", () => {
	it("writes base units in plain digits, cut to what a screen shows", () => {
		expect(groupedUnits("1500000", 6)).toBe("1.5");
		expect(groupedUnits("0", 18, 6)).toBe("0");
		expect(groupedUnits("10000000000000000000000", 18, 6)).toBe("10,000");
		expect(groupedUnits("1234567890123456789", 18, 6)).toBe("1.234567");
		expect(groupedUnits("1999999", 6, 2)).toBe("1.99");
	});

	it("never shows a value that is not nothing as 0", () => {
		expect(groupedUnits("000120", 6, 2)).toBe("< 0.01");
		expect(groupedUnits("5000", 6, 2)).toBe("< 0.01");
		expect(groupedUnits("1", 6, 2)).toBe("< 0.01");
		expect(groupedUnits("999999999999", 18, 6)).toBe("< 0.000001");
		expect(groupedUnits("1000000000000", 18, 6)).toBe("0.000001");
		expect(groupedUnits("0", 6, 2)).toBe("0");
		// a wallet holding dust shows it held, so the screen agrees with Remove's "still holds funds"
		const dust = { native: "999999999999", usdc: "5000", block: 1, at: NOW };
		expect(shownWallet({ ...WALLET, balance: dust }, { networks: NETWORKS }, who, NOW)).toMatchObject({
			eth: "< 0.000001",
			usdc: "< 0.01",
		});
		const rows = incomingRows(
			[
				{ id: "a", asset: "usdc", amount: "1", block: 9, confirmed: true },
				{ id: "b", asset: "native", amount: "1", block: 8, confirmed: true },
			],
			NOW,
		);
		expect(rows.map((row) => row.amount)).toEqual(["< 0.01", "< 0.000001"]);
	});

	it("shows a balance not read yet as unknown, never zero", () => {
		const shown = shownWallet(WALLET, { networks: NETWORKS }, who, NOW);
		expect(shown).toMatchObject({ network: "Base", eth: null, usdc: null, agents: [{ name: "Mara" }] });
		// being read while its network's RPC is taken and its last read did not stop short; unknown otherwise
		expect(shown.reading).toBe(true);
		const stopped = NETWORKS.map((network) => ({ ...network, unread: { since: NOW } }));
		expect(shownWallet(WALLET, { networks: stopped }, who, NOW).reading).toBeUndefined();
		const unset = NETWORKS.map(({ rpc: _, ...network }) => network);
		expect(shownWallet(WALLET, { networks: unset }, who, NOW).reading).toBeUndefined();
		const read = { native: "0", block: 1, at: NOW };
		expect(shownWallet({ ...WALLET, balance: read }, { networks: NETWORKS }, who, NOW).reading).toBeUndefined();
	});

	it("dates a balance by its block, keeps an unread USDC unknown, and shows ETH alone with no USDC", () => {
		const read = { native: "2500000000000000000", block: 23145880, at: NOW - 4 * 60_000 };
		expect(
			shownWallet({ ...WALLET, balance: { ...read, usdc: "182400000" } }, { networks: NETWORKS }, who, NOW),
		).toMatchObject({ eth: "2.5", usdc: "182.4", read: "4 min ago, at block 23,145,880" });
		expect(
			shownWallet({ ...WALLET, balance: { ...read, usdc: null } }, { networks: NETWORKS }, who, NOW).usdc,
		).toBeNull();
		// a network banda pins no USDC on has none, read or not: Receive asks for ETH alone
		expect(shownWallet({ ...WALLET, network: "anvil" }, { networks: NETWORKS }, who, NOW).usdc).toBeUndefined();
		const local = shownWallet({ ...WALLET, network: "anvil", balance: read }, { networks: NETWORKS }, who, NOW);
		expect(local.network).toBe("Local chain");
		expect("usdc" in local).toBe(false);
	});

	it("says a balance is unknown while its chain does not answer, and since when, the last figures only dated (H-208)", () => {
		const read = { native: "2500000000000000000", usdc: "182400000", block: 7, at: NOW - 4 * 60_000 };
		const since = new Date(2026, 10, 24, 11, 58).getTime();
		const stopped = NETWORKS.map((network) => ({ ...network, unread: { since } }));
		const shown = shownWallet({ ...WALLET, balance: read }, { networks: stopped }, who, NOW);
		expect(shown).toMatchObject({ eth: null, usdc: null, last: "182.4 USDC, 2.5 ETH, 4 min ago, at block 7" });
		expect(shown.unreachable).toBe(new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
		expect(shown.reading).toBeUndefined();
		// never read: unknown, with no figure to date
		const never = shownWallet(WALLET, { networks: stopped }, who, NOW);
		expect(never).toMatchObject({ eth: null, usdc: null });
		expect(never.last).toBeUndefined();
		// a stop that began on an earlier day is said by its day
		const yesterday = NETWORKS.map((network) => ({ ...network, unread: { since: NOW - 30 * 3_600_000 } }));
		expect(shownWallet(WALLET, { networks: yesterday }, who, NOW).unreachable).toBe(
			new Date(NOW - 30 * 3_600_000).toLocaleDateString([], { day: "numeric", month: "short" }),
		);
		expect(rpcRows(stopped, NOW).every((rpc) => rpc.unreachable === shown.unreachable)).toBe(true);
		expect(rpcRows(NETWORKS, NOW).some((rpc) => "unreachable" in rpc)).toBe(false);
	});

	it("says an RPC of another chain as that, never as a network not answering, its balance unknown (H-187)", () => {
		const read = { native: "2500000000000000000", usdc: "182400000", block: 7, at: NOW - 4 * 60_000 };
		const wrong = NETWORKS.map((network) => ({ ...network, otherChain: true as const }));
		const shown = shownWallet({ ...WALLET, balance: read }, { networks: wrong }, who, NOW);
		expect(shown).toMatchObject({ eth: null, usdc: null, last: "182.4 USDC, 2.5 ETH, 4 min ago, at block 7" });
		expect(shown.unreachable).toBeUndefined();
		expect(shown.reading).toBeUndefined();
		expect(shown.offline).toBe("chain");
		// never read: not "reading", since nothing it serves is read as the network's
		expect(shownWallet(WALLET, { networks: wrong }, who, NOW).reading).toBeUndefined();
		const rows = rpcRows(wrong, NOW);
		expect(rows.every((rpc) => rpc.otherChain === true && rpc.unreachable === undefined)).toBe(true);
		expect(rpcRows(NETWORKS, NOW).some((rpc) => "otherChain" in rpc)).toBe(false);
	});

	it("marks a wallet on a test network, and only there", () => {
		expect(shownWallet({ ...WALLET, network: "anvil" }, { networks: NETWORKS }, who, NOW).testnet).toBe(true);
		expect("testnet" in shownWallet(WALLET, { networks: NETWORKS }, who, NOW)).toBe(false);
	});

	it("says the age of a reading by the time it is drawn at, so a minute-old one is never just now", () => {
		const read = { native: "0", block: 7, at: NOW };
		const at = (now: number) => shownWallet({ ...WALLET, balance: read }, { networks: NETWORKS }, who, now).read;
		expect(at(NOW + 30_000)).toBe("just now, at block 7");
		expect(at(NOW + 70_000)).toBe("1 min ago, at block 7");
	});

	it("tells a name another wallet has, as the daemon keeps it: one plain line, whatever its case, folded", () => {
		const wallets = [
			{ name: "Travel", state: "ready" as const },
			{ name: "Bills gas", state: "archived" as const },
		];
		expect(nameTaken(" travel ", wallets)).toBe(true);
		expect(nameTaken("Bills\u202E gas", wallets)).toBe(true);
		expect(nameTaken("Bills\ngas", wallets)).toBe(true);
		expect(nameTaken("Rent", wallets)).toBe(false);
		// one rule for the same name: `foldKey`'s full case fold, so ß and SS are one name
		expect(nameTaken("STRASSE", [{ name: "Straße", state: "ready" }])).toBe(true);
		expect(nameTaken("  ", [{ name: "", state: "ready" }])).toBe(false);
		// a creation still waiting on the keychain is no wallet yet: often the form's own, just refused
		expect(nameTaken("Rent", [...wallets, { name: "Rent", state: "creating" }])).toBe(false);
	});

	it("says a creation waits on the keychain, or that there is none to wait on, and reads no balance for it", () => {
		const creating = { ...WALLET, state: "creating" as const };
		const reading = { networks: NETWORKS.map((one) => ({ ...one, rpc: "https://rpc.example" })) };
		expect(offlineOf(creating, undefined)).toBe("creating");
		expect(offlineOf(creating, undefined, undefined, "none")).toBe("no_keychain");
		expect(shownWallet(creating, { ...reading, keychain: "none" }, who, NOW).offline).toBe("no_keychain");
		// the indexer reads only a wallet made or archived: a creating or removing one says no reading
		expect(shownWallet(creating, reading, who, NOW).reading).toBeUndefined();
		expect(shownWallet({ ...WALLET, state: "removing" }, reading, who, NOW).reading).toBeUndefined();
		expect(shownWallet(WALLET, reading, who, NOW).reading).toBe(true);
		expect(shownWallet({ ...WALLET, state: "archived" }, reading, who, NOW).reading).toBe(true);
		// nor unknown: it is not made yet, or being removed, which its page says in place of the network's silence
		expect(shownWallet(creating, reading, who, NOW).unmade).toBe("creating");
		expect(shownWallet({ ...WALLET, state: "removing" }, reading, who, NOW).unmade).toBe("removing");
		expect(shownWallet(WALLET, reading, who, NOW).unmade).toBeUndefined();
	});

	it("says agents share one balance only when two or more read the wallet, every one named", () => {
		expect(sharedBy([])).toBeUndefined();
		expect(sharedBy(["Mara"])).toBeUndefined();
		expect(sharedBy(["Mara", "Otto"])).toBe("Mara and Otto read this wallet's one balance.");
		expect(sharedBy(["Mara", "Otto", "Ines"])).toMatch(/^Mara, Otto, and Ines read this wallet's one balance/);
	});

	it("asks before a removal in words that tell a saved key from one never saved (H-043, H-046)", () => {
		expect(removeWords("Trips", "saved").body).toMatch(/only with the copy you saved/);
		for (const backup of ["skipped", "unsaved"] as const) {
			const { body } = removeWords("Trips", backup);
			expect(body, backup).not.toMatch(/copy you saved/);
			expect(body, backup).toMatch(/no copy of it was saved/);
			expect(body, backup).toMatch(/lost for good/);
		}
	});

	it("offers to save, check or show a key only of a ready wallet whose key opens here (H-273, H-317)", () => {
		expect(keySaves(WALLET, undefined)).toBe(true);
		// archived, its key not saved: no save step the daemon refuses; it comes back first, as Not backed up
		for (const backup of ["unsaved", "skipped", "saved"] as const) {
			const archived: WalletView = { ...WALLET, state: "archived", backup };
			expect(keySaves(archived, undefined), backup).toBe(false);
		}
		for (const state of ["creating", "removing"] as const)
			expect(keySaves({ ...WALLET, state }, undefined)).toBe(false);
		expect(keySaves({ ...WALLET, signing: { state: "key_missing" } }, undefined)).toBe(false);
		expect(keySaves(WALLET, "identity")).toBe(false);
	});

	it("reminds to save a key once a ready wallet whose key isn't saved holds more than a little", () => {
		const holding = (native: string, usdc?: string | null) => ({
			...WALLET,
			balance: { native, ...(usdc === undefined ? {} : { usdc }), block: 1, at: NOW },
		});
		expect(remindsToSave(WALLET)).toBe(false);
		expect(remindsToSave(holding("999999999999999", "999999"))).toBe(false);
		expect(remindsToSave(holding("1000000000000000"))).toBe(true);
		expect(remindsToSave(holding("0", "1000000"))).toBe(true);
		expect(remindsToSave(holding("0", null))).toBe(false);
		expect(remindsToSave({ ...holding("0", "1000000"), backup: "skipped" })).toBe(true);
		expect(remindsToSave({ ...holding("0", "1000000"), backup: "saved" })).toBe(false);
		expect(remindsToSave({ ...holding("0", "1000000"), state: "archived" })).toBe(false);
	});

	it("reminds once per wallet, also where the device refuses its storage, however often the page redraws", () => {
		const refused = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		const here = new Set<string>();
		const shown = Array.from({ length: 6 }, () => firstReminder("0xa", refused, here));
		expect(shown.filter(Boolean)).toHaveLength(1);
		expect(firstReminder("0xb", refused, here)).toBe(true);
		expect(firstReminder("0xa", undefined, here)).toBe(false);

		const items = new Map<string, string>();
		const store = {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => void items.set(key, value),
		};
		expect(firstReminder("0xa", store, new Set())).toBe(true);
		// a page opened later on the same device keeps what the storage holds
		expect(firstReminder("0xa", store, new Set())).toBe(false);
		expect(firstReminder("0xc", store, new Set())).toBe(true);
	});

	it("shows a paired device's wallet's save step once on this computer, only while its key here can be shown (H-276)", () => {
		const phone: WalletView = { ...WALLET, device: true };
		expect(savesOnOpen(phone)).toBe(true);
		expect(savesOnOpen(WALLET)).toBe(false);
		expect(savesOnOpen({ ...phone, backup: "skipped" })).toBe(false);
		expect(savesOnOpen({ ...phone, revealed: 2 })).toBe(false);
		expect(savesOnOpen({ ...phone, state: "creating" })).toBe(false);
		for (const state of ["key_missing", "wrong_key", "other_home"] as const) {
			expect(keyOffline({ signing: { state } })).toBe(true);
			expect(savesOnOpen({ ...phone, signing: { state } })).toBe(false);
		}
		expect(keyOffline({ signing: { state: "locked", code: "locked" } })).toBe(false);
		const items = new Map<string, string>();
		const store = {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => void items.set(key, value),
		};
		expect(firstSaveStep("0xa", store, new Set())).toBe(true);
		expect(firstSaveStep("0xa", store, new Set())).toBe(false);
		// kept apart from the money reminder: one does not stand for the other
		expect(firstReminder("0xa", store, new Set())).toBe(true);
		expect(DESKTOP_WORDS.identity).toMatch(/put back the auth\/device-id/);
	});

	it("says one offline reason: the wallet's own state, its key's last check, then why agents can use none", () => {
		expect(offlineOf({ ...WALLET, state: "creating" }, undefined)).toBe("creating");
		expect(offlineOf({ ...WALLET, signing: { state: "locked", code: "locked" } }, undefined)).toBe("locked");
		expect(offlineOf({ ...WALLET, signing: { state: "other_home" } }, undefined)).toBe("other_home");
		expect(offlineOf({ ...WALLET, signing: { state: "offline_host_mode" } }, undefined)).toBe("host_mode");
		expect(offlineOf({ ...WALLET, signing: { state: "online" } }, undefined)).toBeUndefined();
		expect(offlineOf(WALLET, "coding_agent")).toBe("coding_agent");
		expect(offlineOf(WALLET, "host_mode")).toBe("host_mode");
		expect(offlineOf({ ...WALLET, signing: { state: "locked" } }, "coding_agent")).toBe("locked");
		expect(offlineOf({ ...WALLET, state: "archived" }, "host_mode")).toBeUndefined();
		expect(offlineOf({ ...WALLET, state: "removing" }, undefined)).toBeUndefined();
		expect(shownWallet({ ...WALLET, state: "archived" }, { networks: NETWORKS }, who, NOW).archived).toBe(true);
	});

	it("shows each RPC masked, as banda's default or the owner's, with why it cannot be used", () => {
		expect(
			rpcRows([
				...NETWORKS,
				{
					id: "base-sepolia",
					label: "Base Sepolia",
					testnet: true,
					set: true,
					shipped: true,
					problem: "x",
					logs: false,
				},
			]),
		).toEqual([
			{
				id: "base",
				network: "Base",
				url: "https://base-rpc.publicnode.com",
				byDefault: true,
				logs: true,
				shipped: true,
			},
			{
				id: "anvil",
				network: "Local chain",
				url: "http://127.0.0.1:8545/…",
				byDefault: false,
				logs: true,
				shipped: false,
			},
			{ id: "base-sepolia", network: "Base Sepolia", byDefault: false, logs: false, problem: "x", shipped: true },
		]);
	});

	it("offers a wallet only on the networks whose RPC can be used as set", () => {
		const broken: WalletNetworkView = {
			id: "base-sepolia",
			label: "Base Sepolia",
			testnet: true,
			set: true,
			shipped: true,
			problem: "x",
		};
		expect(choices([...NETWORKS, broken]).map((choice) => choice.id)).toEqual(["base", "anvil"]);
	});

	it("says every signer code as a reason with its own words, or as the state it came with, never the code", () => {
		for (const code of CODES) {
			const reason = REASON_OF_CODE[code];
			const shown = offlineOf({ ...WALLET, signing: { state: "locked", code } }, undefined);
			expect(shown).toBe(reason ?? "locked");
			expect(OFFLINE[shown as keyof typeof OFFLINE].title.length).toBeGreaterThan(0);
			expect(DESKTOP_WORDS[code]).toBeDefined();
			expect(desktopFailure(code)).toBe(DESKTOP_WORDS[code]);
		}
		expect(offlineOf({ ...WALLET, signing: { state: "locked", code: "debugging" } }, undefined)).toBe("debugging");
		expect(desktopFailure("something new")).not.toContain("something new");
	});

	it("says a network's RPC that serves another chain, past the key's state and before code at the address (H-187)", () => {
		const other = { otherChain: true as const };
		expect(offlineOf(WALLET, undefined, other)).toBe("chain");
		expect(offlineOf({ ...WALLET, code: true }, "coding_agent", other)).toBe("chain");
		expect(offlineOf({ ...WALLET, signing: { state: "locked" } }, undefined, other)).toBe("locked");
		expect(offlineOf({ ...WALLET, state: "archived" }, undefined, other)).toBeUndefined();
		const shown = shownWallet(WALLET, { networks: NETWORKS.map((one) => ({ ...one, ...other })) }, who, NOW);
		expect(shown.offline).toBe("chain");
		expect(OFFLINE.chain.title).toMatch(/another chain/);
	});

	it("tells the owner the one fix for a connected coding agent: disconnect it, never have it ask (H-065)", () => {
		const { body, action } = OFFLINE.coding_agent;
		expect(`${body} ${action}`).not.toMatch(/\bask(s|ing)?\b/i);
		expect(body).toMatch(/while any coding agent is connected/);
		expect(action).toMatch(/^Disconnect/);
	});

	it("bars a switch for an agent by the wallet's state alone, the same on its page and in the agent's Access (UC-05)", () => {
		expect(unswitchable(WALLET)).toBeUndefined();
		// offline for any reason, the wallet is still switched for an agent
		for (const reason of ["coding_agent", "host_mode"] as const) expect(offlineOf(WALLET, reason)).toBe(reason);
		expect(unswitchable({ ...WALLET, signing: { state: "other_home" } })).toBeUndefined();
		for (const state of ["archived", "removing", "creating"] as const)
			expect(unswitchable({ ...WALLET, state })).toEqual(expect.any(String));
	});

	it("lists each showing of the key in the wallet's activity, among the money by time (UC-02 A2, H-266)", () => {
		const hour = 3_600_000;
		const money = [
			{ id: "a", asset: "native" as const, amount: "1", block: 9, at: NOW - hour, confirmed: true },
			{ id: "b", asset: "native" as const, amount: "1", block: 5, at: NOW - 3 * hour, confirmed: true },
		];
		const reveals = [
			{ at: NOW - 4 * hour, kind: "creation" as const },
			{ at: NOW - 2 * hour, kind: "later" as const },
		];
		const ids = (rows: ReturnType<typeof activityRows>) => rows.map((row) => row.id);
		expect(ids(activityRows(money, reveals, NOW, undefined, false))).toEqual([
			"a",
			`reveal:${NOW - 2 * hour}:1`,
			"b",
			`reveal:${NOW - 4 * hour}:0`,
		]);
		const notes = activityRows([], reveals, NOW, undefined, false);
		expect(notes.map((row) => ("title" in row ? row.title : ""))).toEqual([
			"Key shown on this computer",
			"Key shown as the wallet was made",
		]);
		// older money is still to be read: a showing older than the last row listed waits for it
		expect(ids(activityRows(money, reveals, NOW, undefined, true))).toEqual(["a", `reveal:${NOW - 2 * hour}:1`, "b"]);
		expect(activityRows(money, undefined, NOW, undefined, false)).toHaveLength(2);
	});

	it("lists a nonce moved outside banda as money that left, among what came in by block, with no amount (H-210)", () => {
		const hour = 3_600_000;
		const money = [
			{ id: "a", asset: "native" as const, amount: "1", block: 9, at: NOW - hour, confirmed: true },
			{ id: "b", asset: "native" as const, amount: "1", block: 5, at: NOW - 3 * hour, confirmed: true },
		];
		const outside = [{ id: "outside:7:7", from: 7, block: 7, confirmed: true }];
		const rows = activityRows(money, undefined, NOW, "https://basescan.org", false, outside);
		expect(rows.map((row) => row.id)).toEqual(["a", "outside:7:7", "b"]);
		const left = rows[1];
		expect(left).toMatchObject({
			direction: "out",
			state: "outside",
			token: "ETH",
			time: "block 7",
			explorer: "https://basescan.org/block/7",
		});
		expect(left !== undefined && "amount" in left ? left.amount : undefined).toBeUndefined();
		// never a row of ETH that came in
		expect(rows.filter((row) => "direction" in row && row.direction === "in")).toHaveLength(2);
	});

	it("says code at the address once a check found it, before any home-wide reason", () => {
		expect(offlineOf({ ...WALLET, code: true }, "coding_agent")).toBe("code");
		expect(offlineOf({ ...WALLET, code: true, signing: { state: "locked" } }, undefined)).toBe("locked");
	});

	it("checks a saved copy by the SHA-256 of its 0x and 64 lowercase hex digits, however it was pasted", async () => {
		const key = `0x${"Ab".repeat(32)}`;
		const digest = createHash("sha256").update(key.toLowerCase()).digest("hex");
		expect(await keyDigest(key)).toBe(digest);
		expect(await keyDigest(` 0x ${"ab".repeat(16)} ${"ab".repeat(16)}\n`)).toBe(digest);
		expect(await keyDigest("ab".repeat(32))).toBe(digest);
		expect(await keyDigest(key)).toBe(signerDigest(key));
	});

	it("tells a creation's refusal by its code: waiting on the keychain, no keychain, not on disk yet, or nothing kept", () => {
		const refused = (code: string | undefined, status = 503) => ({ status, code });
		expect(createdState(refused("creating"))).toBe("waiting");
		expect(createdState(refused("no_keychain"))).toBe("no_keychain");
		expect(createdState(refused("unsynced"))).toBe("unsynced");
		expect(createdState(refused("dropped"))).toBe("failed");
		expect(createdState(refused("exists"))).toBe("failed");
		expect(createdState(refused(undefined))).toBe("failed");
		expect(createdState(refused("creating", 400))).toBeUndefined();
		expect(createdState(undefined)).toBeUndefined();
		// the signer refused before anything was kept: said by its reason, another home's lease on its own (UC-21 A1)
		expect([createdState(refused("other_home")), createdReason(refused("other_home"))]).toEqual([
			"refused",
			"other_home",
		]);
		expect([createdState(refused("locked")), createdReason(refused("locked"))]).toEqual(["refused", "locked"]);
		expect(createdReason(refused("denied"))).toBe("denied");
		expect(createdReason(refused("timeout"))).toBe("timeout");
		expect(createdReason(refused("other"))).toBe("keychain");
		for (const code of ["dropped", "exists", "creating", "no_keychain", undefined])
			expect(createdReason(refused(code))).toBeUndefined();
		expect(createdReason(refused("other_home", 409))).toBeUndefined();
		expect(wrongCopy(refused("wrong_copy", 409))).toBe(true);
		expect(wrongCopy({ status: 409 })).toBe(false);
		expect(wrongCopy(refused("locked"))).toBe(false);
	});

	it("keeps a row whose time is not read yet in its place by block, under the day its dated neighbours bound it to", () => {
		const hour = 3_600_000;
		const row = (id: string, block: number, at?: number) => ({
			id,
			asset: "native" as const,
			amount: "1000000000000000000",
			block,
			...(at === undefined ? {} : { at }),
			confirmed: true,
		});
		const yesterday = NOW - 30 * hour;
		// the newest row came in after one dated today: it is today's, at the top, never an Earlier group above Today
		const latest = [row("new", 130), row("old", 129, NOW - hour)];
		const newest = incomingRows(latest, NOW);
		expect(newest.map((each) => [each.id, each.day])).toEqual([
			["new", "Today"],
			["old", "Today"],
		]);
		expect(newest[0]?.time).toBe("block 130");
		// between two rows of one day it is that day's; between two days it is not known, and says so in its place
		const between = incomingRows(
			[row("a", 20, NOW - hour), row("b", 19), row("c", 18, NOW - 2 * hour), row("d", 17), row("e", 16, yesterday)],
			NOW,
		);
		expect(between.map((each) => each.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(between.map((each) => each.day)).toEqual(["Today", "Today", "Today", "Earlier", between[4]?.day]);
		expect(between[4]?.day).not.toBe("Today");
		// a key's showing is placed among them as by the newest time the row could have
		const reveals = [{ at: NOW - 30 * 60_000, kind: "later" as const }];
		expect(activityRows(latest, reveals, NOW, undefined, false).map((each) => each.id)).toEqual([
			"new",
			`reveal:${NOW - 30 * 60_000}:0`,
			"old",
		]);
		// a wallet's first money, its times not read yet, above the showing at its making: today's, never an Earlier
		// group above Today
		const made = [{ at: NOW - 4 * 60_000, kind: "creation" as const }];
		const first = activityRows([row("b", 130), row("a", 1)], made, NOW, undefined, false);
		expect(first.map((each) => [each.id, each.day])).toEqual([
			["b", "Today"],
			["a", "Today"],
			[`reveal:${NOW - 4 * 60_000}:0`, "Today"],
		]);
		const days = [...new Set(first.map((each) => each.day))];
		expect(days.indexOf("Earlier")).toBe(-1);
		// with nothing dated below it, a row not timed yet is still Earlier
		expect(activityRows([row("b", 130)], [], NOW, undefined, false).map((each) => each.day)).toEqual(["Earlier"]);
	});

	it("lists the money that came in by day, newest first, Received until final, and says what it may miss", () => {
		const rows = incomingRows(
			[
				{
					id: "a",
					asset: "usdc",
					amount: "100000000",
					from: WALLET.address,
					block: 9,
					at: NOW - 60_000,
					confirmed: false,
				},
				{ id: "b", asset: "native", amount: "5000000000000000", block: 8, confirmed: true },
			],
			NOW,
		);
		expect(rows).toMatchObject([
			{
				id: "a",
				day: "Today",
				direction: "in",
				counterpart: "0x5aAe…eAed",
				amount: "100",
				token: "USDC",
				state: "received",
			},
			{
				id: "b",
				day: "Earlier",
				counterpart: "another address",
				amount: "0.005",
				token: "ETH",
				state: "confirmed",
				time: "block 8",
			},
		]);
		// no explorer reads a local chain: no link (H-201)
		expect(rows.some((row) => "explorer" in row)).toBe(false);
		const hash = `0x${"ab".repeat(32)}`;
		const linked = incomingRows(
			[
				{ id: `${hash}:3`, asset: "usdc", amount: "1", block: 9, confirmed: true },
				{
					id: "native:8:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
					asset: "native",
					amount: "1",
					block: 8,
					confirmed: true,
				},
			],
			NOW,
			"https://basescan.org",
		);
		expect(linked.map((row) => row.explorer)).toEqual([
			`https://basescan.org/tx/${hash}`,
			"https://basescan.org/block/8",
		]);
		expect(incompleteOf({ incomplete: "logs" }, "mainnet.base.org")).toContain("mainnet.base.org refuses log queries");
		expect(incompleteOf({ incomplete: "gaps", gaps: { again: true } }, undefined)).toBe(
			"Some of the ETH that came in isn't listed yet: banda reads those blocks again.",
		);
		// each kind of gap is said as what it is, and "reads again" only where banda does (H-204)
		const coded = incompleteOf({ incomplete: "gaps", gaps: { code: true } }, undefined);
		expect(coded).toContain("Code ran at this wallet's address");
		expect(coded).not.toContain("reads those blocks again");
		const window = incompleteOf(
			{ incomplete: "gaps", gaps: { pruned: 900, prunedAt: Date.UTC(2026, 10, 2, 12) }, through: { block: 950 } },
			"mainnet.base.org",
		);
		expect(window).toMatch(
			/^ETH that came in up to block 900 \(.*2.*\) isn't listed: mainnet\.base\.org keeps no balances that old\. After it, the list is complete\.$/,
		);
		expect(window).not.toContain("reads those blocks again");
		const both = incompleteOf({ incomplete: "gaps", gaps: { again: true, pruned: 900 } }, undefined);
		expect(both).toContain("banda reads those blocks again");
		expect(both).not.toContain("the list is complete");
		// an RPC of another chain: said as that, never as a network banda can't reach (H-187)
		const chain = incompleteOf({ incomplete: "chain" }, undefined, { name: "Base Sepolia", now: NOW });
		expect(chain).toBe(
			"Base Sepolia's RPC serves another chain: nothing coming in is listed through it. Choose another RPC in Settings → Wallets.",
		);
		expect(incompleteOf({}, undefined)).toBeUndefined();
		// how far back the list is whole, when the RPC refuses log queries (UC-14 E1, H-207)
		const through = incompleteOf(
			{ incomplete: "logs", through: { block: 12345, at: Date.UTC(2026, 10, 2, 12) } },
			"mainnet.base.org",
		);
		expect(through).toMatch(/^Complete to block 12,345 \(.*2.*\): USDC coming in after it isn't listed/);
		expect(through).toContain("mainnet.base.org refuses log queries");
		expect(incompleteOf({ incomplete: "logs", through: { block: 7 } }, undefined)).toContain("Complete to block 7:");
		// a long history keeps its newest rows, and the last page says so
		expect(incompleteOf({ dropped: 4000 }, undefined)).toContain("up to block 4,000 isn't kept here");
		expect(incompleteOf({ incomplete: "gaps", gaps: { again: true }, dropped: 9 }, undefined)).toMatch(
			/listed yet.*up to block 9/,
		);
		// an RPC that stopped answering: what came in after the last read isn't listed (H-207, H-208)
		const now = Date.UTC(2026, 10, 2, 12);
		const down = incompleteOf({ incomplete: "unread", since: now - 60_000, through: { block: 40 } }, undefined, {
			name: "Local chain",
			now,
		});
		expect(down).toMatch(/^banda can't reach Local chain since .+: money that came in after block 40 isn't listed\.$/);
		expect(incompleteOf({ incomplete: "unread" }, undefined)).toBe(
			"banda can't reach this wallet's network: money that came in isn't listed yet.",
		);
		// rows read past the final cursor, or none final yet: said from the head last read, never "isn't listed yet"
		// over a list that shows money (C22, H-207)
		expect(incompleteOf({ incomplete: "unread", head: 3 }, undefined)).toBe(
			"banda can't reach this wallet's network: money that came in after block 3 isn't listed.",
		);
		expect(incompleteOf({ incomplete: "unread", through: { block: 1 }, head: 90 }, undefined)).toContain(
			"after block 90 isn't listed",
		);
		expect(incompleteOf({ incomplete: "unread", rows: [{}] }, undefined)).toBe(
			"banda can't reach this wallet's network: money that came in lately may not be listed.",
		);
	});
});
