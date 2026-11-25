/**
 * The daemon's wallets as the screens draw them (`chat/Wallets.tsx`): a network by its label, a balance in ETH and USDC
 * and dated by the block it was read at, unknown and never zero when it was not read or the chain stopped answering, the agents by their faces, and the
 * one reason a wallet cannot pay. Pure, so the tests read it too.
 */

import { normalKey } from "../../../src/wallet/key-text.ts";
import { nameKey, shortAddress, units } from "../../../src/wallet/label.ts";
import type { SignerCode } from "../../../src/wallet/signer-protocol.ts";
import type { Who } from "../chat/Row.tsx";
import type {
	ActivityRowView,
	CreateState,
	NetworkChoice,
	NoteRowView,
	OfflineReason,
	RpcView,
	ShownWallet,
	TxRowView,
} from "../chat/Wallets.tsx";
import type {
	IncomingView,
	OutsideView,
	RevealView,
	WalletErrorCode,
	WalletIncoming,
	WalletNetworkView,
	WalletsView,
	WalletView,
} from "../lib/api.ts";

/**
 * `value` base units, decimal, as a screen shows them: `units` with its thousands grouped, "10,000.5". A value cut to
 * nothing at `shown` places that is not nothing reads as under the least the screen shows, "< 0.01", never "0": the
 * owner is never shown an empty wallet that still holds funds, nor a transfer of nothing.
 */
export function groupedUnits(value: string, decimals: number, shown = decimals): string {
	const amount = BigInt(value);
	const cut = units(amount, decimals, shown);
	if (amount > 0n && /^0(\.0*)?$/.test(cut)) return `< ${shown === 0 ? "1" : `0.${"0".repeat(shown - 1)}1`}`;
	const [whole = "", fraction] = cut.split(".");
	return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** How long ago `at` was, in a few words: "just now", "4 min ago", "2 h ago", or its date. */
export function ago(at: number, now: number): string {
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
	return new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * The reason each of the signer's refusals gives, where it says more than the signing state does (H-317): a keychain
 * `locked` because a debugger is on, its prompt was refused, it did not answer, it holds two items or none at all, or
 * failed some other way; undefined where the state says it already.
 */
export const REASON_OF_CODE: { readonly [code in SignerCode]: OfflineReason | undefined } = {
	locked: undefined,
	missing: undefined,
	wrong_key: undefined,
	other_home: undefined,
	debugging: "debugging",
	denied: "denied",
	timeout: "timeout",
	ambiguous: "ambiguous",
	no_keychain: "no_keychain",
	exists: "keychain",
	refused: "keychain",
	other: "keychain",
};

/**
 * Whether no key on this computer can show or check `wallet`'s: its item gone, holding another key, or its signing
 * another home's. Its Save your key step is then never offered: the reason's own act (Restore, Move signing here)
 * comes first (H-317).
 */
export function keyOffline(wallet: Pick<WalletView, "signing">): boolean {
	const state = wallet.signing?.state;
	return state === "key_missing" || state === "wrong_key" || state === "other_home";
}

/**
 * Whether this computer can show and check `wallet`'s key now: only of a ready wallet, since the daemon saves, skips
 * and shows the key of no other (an archived one comes back first, its Archived notice offering that); not while no key
 * here opens it (gone, another's, or another home's signing), nor while the home's id is not its wallets' (H-317).
 */
export const keySaves = (wallet: Pick<WalletView, "state" | "signing">, offline: string | undefined) =>
	wallet.state === "ready" && !keyOffline(wallet) && offline !== "identity";

/**
 * The one reason `wallet` cannot pay, if it has one, the most specific there is: its own state first, then its key's,
 * said by the signer's code where that tells more, then its network's RPC serving another chain (H-187, which makes
 * any code read there meaningless too), then code at its address, then why agents can use none.
 */
export function offlineOf(
	wallet: WalletView,
	offline: WalletsView["offline"],
	network?: Pick<WalletNetworkView, "otherChain">,
	keychain?: WalletsView["keychain"],
): OfflineReason | undefined {
	// a creation waits on the keychain, unless there is none to wait on: then that is what to fix (H-317)
	if (wallet.state === "creating") return keychain === "none" ? "no_keychain" : "creating";
	if (wallet.state !== "ready") return undefined;
	// nothing of a wallet is checked while the home's id is not its wallets': no reason a check would give is true yet
	if (offline === "identity") return offline;
	const signing = wallet.signing;
	if (signing?.state === "offline_host_mode") return "host_mode";
	if (signing !== undefined && signing.state !== "online")
		return (signing.code === undefined ? undefined : REASON_OF_CODE[signing.code]) ?? signing.state;
	if (network?.otherChain === true) return "chain";
	if (wallet.code === true) return "code";
	return offline;
}

/** A copy that is no key's text, said apart from a key that opens another wallet. */
export const NOT_A_KEY = "That isn't a wallet key: a key is 64 letters and digits, with or without 0x in front.";

/**
 * What banda's desktop app answers when it does not show, restore or move a key, in the owner's words: its own refusals
 * and the signer's codes it passes on. Never the code itself.
 */
export const DESKTOP_WORDS: { readonly [code: string]: string } = {
	denied: "Your computer didn't confirm it's you.",
	identity:
		"This home's identity is missing, and it names every wallet key: put back the auth/device-id this home had, then start banda again.",
	no_reauthentication:
		"This computer can't confirm it's you (on a Mac, that takes Touch ID), so banda shows a wallet's key only as it's made, and doesn't restore or move keys here.",
	not_ready: "The wallet isn't ready: it's being made, removed or archived.",
	unlisted: "banda didn't record that the key was shown, so it wasn't. Try again.",
	not_missing: "The wallet's key is in your keychain already: there's nothing to restore.",
	not_orphan: "A wallet in this home names this key now, or your keychain no longer holds it.",
	no_daemon: "banda isn't running on this computer. Start it, then try again.",
	refused: "banda's desktop app refused that request.",
	wrong_key: "That key doesn't open this wallet.",
	not_a_key: NOT_A_KEY,
	other_home: "Another home signs for this wallet: move signing here first.",
	locked: "Your keychain is locked. Unlock it, then try again.",
	missing: "Your keychain no longer holds this wallet's key.",
	no_keychain: "This computer has no keychain banda can use.",
	timeout: "Your keychain didn't answer in time. Answer its prompt, then try again.",
	exists: "Your keychain already holds an item where the key was to go.",
	ambiguous: "Your keychain holds more than one item for this wallet.",
	debugging: "banda runs with debugging on, so it handles no key.",
	other: "banda couldn't use your keychain. Try again.",
};

/** A desktop app's refusal said in words, whatever its code. */
export const desktopFailure = (code: string): string =>
	Object.hasOwn(DESKTOP_WORDS, code)
		? (DESKTOP_WORDS[code] as string)
		: "Something went wrong in banda's desktop app. Try again.";

/** What the daemon answered when it refused: its status and the fixed word it gave, if any (`Refused`). */
type Refusal = { readonly status: number; readonly code?: string | undefined };

/**
 * Why a creation the daemon refused (503) did not make a wallet, as the page shows it: it waits on the keychain, there
 * is no keychain, it is made but not on disk yet, the signer refused before it kept anything (another home holds the
 * lease, the keychain is locked: `createdReason` says which), or nothing was kept; undefined for any other refusal,
 * which is said as it came.
 */
export function createdState(refused: Refusal | undefined): CreateState | undefined {
	if (refused?.status !== 503) return undefined;
	const code = refused.code as WalletErrorCode | undefined;
	if (code === "no_keychain") return "no_keychain";
	if (code === "creating") return "waiting";
	if (code === "unsynced") return "unsynced";
	return createdReason(refused) === undefined ? "failed" : "refused";
}

/** The signer's reason a creation was refused before anything was kept, as the page says it; undefined for none. */
export function createdReason(refused: Refusal | undefined): OfflineReason | undefined {
	const code = refused?.code;
	if (refused?.status !== 503 || code === undefined || !Object.hasOwn(REASON_OF_CODE, code)) return undefined;
	if (code === "other_home" || code === "locked") return code;
	// no keychain is its own state; an item already there, or a key that is not the wallet's, kept nothing
	if (code === "no_keychain" || code === "missing" || code === "wrong_key" || code === "exists") return undefined;
	return REASON_OF_CODE[code as SignerCode] ?? "keychain";
}

/** Whether the daemon refused a saved copy because it does not open the wallet. */
export const wrongCopy = (refused: Refusal | undefined) => refused?.code === ("wrong_copy" satisfies WalletErrorCode);

/** A network's label, or its id where this build does not offer it. */
export const labelOf = (networks: readonly WalletNetworkView[], id: string) =>
	networks.find((network) => network.id === id)?.label ?? id;

/** The networks a wallet can be made on, in the order banda offers them: those whose RPC can be used as set. */
export const choices = (networks: readonly WalletNetworkView[]): NetworkChoice[] =>
	networks.filter((network) => network.problem === undefined).map(({ id, label, testnet }) => ({ id, label, testnet }));

/** The states whose balances the indexer reads (src/wallet/indexer.ts): a wallet made, in use or archived. */
const READ: ReadonlySet<WalletView["state"]> = new Set(["ready", "archived"]);

/**
 * Whether a network's balances are being read: an RPC set, taken, answering at its last read, and serving the network's
 * own chain (H-187).
 */
const reachable = (network: WalletNetworkView | undefined) =>
	network?.rpc !== undefined &&
	network.problem === undefined &&
	network.unread === undefined &&
	network.otherChain !== true;

/** A time as a line says since when: its hour and minute today, its day before that. */
export function sinceWords(at: number, now: number): string {
	const time = new Date(at);
	return time.toDateString() === new Date(now).toDateString()
		? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: time.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** One wallet as the screens draw it. */
export function shownWallet(
	wallet: WalletView,
	view: Pick<WalletsView, "networks" | "offline" | "keychain">,
	whoOf: (agent: string) => Who,
	now: number,
): ShownWallet {
	const { balance } = wallet;
	const network = view.networks.find((one) => one.id === wallet.network);
	const offline = offlineOf(wallet, view.offline, network, view.keychain);
	const eth = balance === undefined ? null : groupedUnits(balance.native, 18, 6);
	const usdc = balance?.usdc === undefined || balance.usdc === null ? null : groupedUnits(balance.usdc, 6, 2);
	const read =
		balance === undefined ? "not yet" : `${ago(balance.at, now)}, at block ${balance.block.toLocaleString("en-US")}`;
	// the chain is not answering, or its RPC serves another chain (H-187): a figure read before is said dated, never as
	// the balance now (H-208); only the first is said as not answering
	const unread = network?.unread;
	const unknown = unread !== undefined || network?.otherChain === true;
	const figures = [
		...(network?.usdc === true && usdc !== null ? [`${usdc} USDC`] : []),
		...(eth === null ? [] : [`${eth} ETH`]),
	];
	return {
		name: wallet.name,
		network: labelOf(view.networks, wallet.network),
		...(network?.testnet === true ? { testnet: true } : {}),
		address: wallet.address,
		eth: unknown ? null : eth,
		...(network?.usdc !== true ? {} : { usdc: unknown ? null : usdc }),
		read,
		...(unread === undefined ? {} : { unreachable: sinceWords(unread.since, now) }),
		...(!unknown || balance === undefined || figures.length === 0 ? {} : { last: `${figures.join(", ")}, ${read}` }),
		// only a wallet the indexer reads is being read: a creating or removing one is not (C22, H-208)
		...(balance === undefined && READ.has(wallet.state) && reachable(network) ? { reading: true } : {}),
		// nor is it unknown: nothing is read for it until it is made, nor while it is being removed
		...(wallet.state === "creating" || wallet.state === "removing" ? { unmade: wallet.state } : {}),
		backup: wallet.backup,
		agents: wallet.agents.map(whoOf),
		...(offline === undefined ? {} : { offline }),
		...(wallet.state === "archived" ? { archived: true } : {}),
	};
}

/**
 * What a wallet's agents list says when more than one agent is on for it: they share one balance (H-159). Nothing for
 * one agent or none.
 */
export function sharedBy(names: readonly string[]): string | undefined {
	if (names.length < 2) return undefined;
	const listed = new Intl.ListFormat("en", { type: "conjunction" }).format(names);
	return `${listed} read this wallet's one balance.`;
}

/**
 * Whether a wallet listed already has `name`, so a new one would share it. A creation still waiting on the keychain is
 * no wallet yet: most often it is this very form's, refused a moment ago.
 */
export const nameTaken = (name: string, wallets: readonly Pick<WalletView, "name" | "state">[]) =>
	nameKey(name) !== "" &&
	wallets.some((wallet) => wallet.state !== "creating" && nameKey(wallet.name) === nameKey(name));

/** What a wallet holds before the owner is reminded, once, that its key is not saved: 1 USDC, or 0.001 ETH (H-273). */
const SMALL = { usdc: 1_000_000n, native: 10n ** 15n } as const;

/** Whether `wallet` should remind the owner to save its key: ready, its key not saved, and holding more than a little. */
export function remindsToSave(wallet: WalletView): boolean {
	if (wallet.state !== "ready" || wallet.backup === "saved" || wallet.balance === undefined) return false;
	const { native, usdc } = wallet.balance;
	return BigInt(native) >= SMALL.native || (typeof usdc === "string" && BigInt(usdc) >= SMALL.usdc);
}

/** What `firstReminder` reads and writes: this device's storage, which may refuse both. */
export type ReminderStore = Pick<Storage, "getItem" | "setItem">;

/** Where this device remembers the wallets it reminded to save their key. */
const REMINDED = "banda.wallets.reminded";

/** The wallets reminded since the page opened, which hold even when the device's storage refuses a write. */
const remindedHere = new Set<string>();

function kept(store: ReminderStore | undefined, list = REMINDED): string[] {
	try {
		const read: unknown = JSON.parse(store?.getItem(list) ?? "[]");
		return Array.isArray(read) ? read.filter((each): each is string => typeof each === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Whether the reminder for `address` shows now: true once, then never again on this device, or, where its storage is
 * refused, never again while the page is open (H-273: one reminder, never a nag loop).
 */
export function firstReminder(
	address: string,
	store: ReminderStore | undefined,
	here = remindedHere,
	list = REMINDED,
): boolean {
	if (here.has(address)) return false;
	here.add(address);
	const done = kept(store, list);
	if (done.includes(address)) return false;
	try {
		store?.setItem(list, JSON.stringify([...done, address]));
	} catch {}
	return true;
}

/** Where this computer remembers the wallets made on a paired device whose Save your key step it showed (H-276). */
const SAVE_STEPS = "banda.wallets.saveSteps";

/** The save steps shown since the page opened, which hold even when the device's storage refuses a write. */
const saveStepsHere = new Set<string>();

/**
 * Whether the computer shows a wallet's Save your key step at this open: one made on a paired device, which could not
 * show its key, ready, its saving neither done nor skipped, its key never shown since, and a key on this computer to
 * show (UC-01 A3, H-276). Shown once per wallet on this computer, as the reminder is.
 */
export function savesOnOpen(wallet: WalletView): boolean {
	return (
		wallet.device === true &&
		wallet.state === "ready" &&
		wallet.backup === "unsaved" &&
		wallet.revealed === undefined &&
		!keyOffline(wallet)
	);
}

/** Whether the save step for `address` shows now: once per wallet on this computer (H-276). */
export const firstSaveStep = (address: string, store: ReminderStore | undefined, here = saveStepsHere): boolean =>
	firstReminder(address, store, here, SAVE_STEPS);

/**
 * Each network's RPC as Settings shows it: masked, said as banda's default or the owner's, since when it is not
 * answering, and whether it serves another chain.
 */
export const rpcRows = (networks: readonly WalletNetworkView[], now = Date.now()): RpcView[] =>
	networks.map((network) => ({
		id: network.id,
		network: network.label,
		...(network.rpc === undefined ? {} : { url: network.rpc }),
		byDefault: !network.set,
		logs: network.logs !== false,
		...(network.problem === undefined ? {} : { problem: network.problem }),
		...(network.unread === undefined ? {} : { unreachable: sinceWords(network.unread.since, now) }),
		...(network.otherChain === true ? { otherChain: true } : {}),
		shipped: network.shipped,
	}));

/**
 * The SHA-256 a saved copy of a key is checked by: of `0x` and its 64 hex digits in lowercase (`normalKey`), in
 * lowercase hex.
 */
export async function keyDigest(pasted: string): Promise<string> {
	// a copy that is no key's text is hashed as written, so it matches no key
	const key = normalKey(pasted) ?? pasted;
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DAY = { day: "numeric", month: "short" } as const;

/** A block as the list names it: its number, and its day once its time was read. */
const blockWords = (block: number, at: number | undefined) =>
	`block ${block.toLocaleString("en-US")}${at === undefined ? "" : ` (${new Date(at).toLocaleDateString([], DAY)})`}`;

/**
 * Why money coming in may be missing from a wallet's activity, said above it: how far back the list is whole when the
 * RPC refuses log queries (H-207), an RPC of another chain (H-187), the network unread, the native stretches not read
 * each by what banda does with them (read again, code at the address, older than the RPC serves: H-204), a first read
 * under way, and, on the last page, rows of a long history banda no longer keeps (C22); undefined when nothing is.
 */
export function incompleteOf(
	incoming: Pick<WalletIncoming, "incomplete" | "through" | "head" | "dropped" | "since" | "gaps"> & {
		readonly rows?: readonly unknown[];
	},
	rpc: string | undefined,
	network?: { readonly name: string; readonly now: number },
): string | undefined {
	const where = network?.name ?? "this wallet's network";
	const said = (() => {
		switch (incoming.incomplete) {
			case "chain":
				return `${where}'s RPC serves another chain: nothing coming in is listed through it. Choose another RPC in Settings → Wallets.`;
			case "unread": {
				const since =
					incoming.since === undefined || network === undefined
						? ""
						: ` since ${sinceWords(incoming.since, network.now)}`;
				const reached = `banda can't reach ${where}${since}`;
				// the last block read, final or not: what is listed goes to it, and what came in after it is missing
				if (incoming.head !== undefined)
					return `${reached}: money that came in after block ${incoming.head.toLocaleString("en-US")} isn't listed.`;
				if (incoming.through !== undefined)
					return `${reached}: money that came in after ${blockWords(incoming.through.block, incoming.through.at)} isn't listed.`;
				// rows listed with no read to date them: never "isn't listed yet" over money that is
				return (incoming.rows?.length ?? 0) > 0
					? `${reached}: money that came in lately may not be listed.`
					: `${reached}: money that came in isn't listed yet.`;
			}
			case "logs": {
				const refuses = `${rpc ?? "this network's RPC"} refuses log queries. Choose another RPC in Settings → Wallets.`;
				return incoming.through === undefined
					? `USDC coming in isn't listed: ${refuses}`
					: `Complete to ${blockWords(incoming.through.block, incoming.through.at)}: USDC coming in after it isn't listed, as ${refuses}`;
			}
			case "gaps": {
				const gaps = incoming.gaps ?? {};
				const parts: string[] = [];
				// banda asks again only of these: the others stay as they are through this RPC
				if (gaps.again === true)
					parts.push("Some of the ETH that came in isn't listed yet: banda reads those blocks again.");
				if (gaps.code === true)
					parts.push(
						"Code ran at this wallet's address for a while: ETH that came in then can't be told apart, so it isn't listed.",
					);
				if (gaps.pruned !== undefined)
					parts.push(
						`ETH that came in up to ${blockWords(gaps.pruned, gaps.prunedAt)} isn't listed: ${rpc ?? "this network's RPC"} keeps no balances that old.${gaps.again === true || gaps.code === true ? "" : " After it, the list is complete."}`,
					);
				return parts.length === 0 ? "Some of the ETH that came in isn't listed." : parts.join(" ");
			}
			case "reading":
				return "banda is still reading this wallet's history.";
			default:
				return undefined;
		}
	})();
	const dropped =
		incoming.dropped === undefined
			? undefined
			: `Money that came in up to block ${incoming.dropped.toLocaleString("en-US")} isn't kept here: only the newest is. The network still has it all.`;
	return said === undefined ? dropped : dropped === undefined ? said : `${said} ${dropped}`;
}

/**
 * Where a row of money that came in opens on `explorer`: its transaction, or for ETH a balance showed, its block; none
 * where the network has no explorer.
 */
export function explorerOf(row: Pick<IncomingView, "id" | "block">, explorer: string | undefined): string | undefined {
	if (explorer === undefined) return undefined;
	const hash = /^(0x[0-9a-f]{64}):\d+$/.exec(row.id)?.[1];
	return hash === undefined ? `${explorer}/block/${row.block}` : `${explorer}/tx/${hash}`;
}

/**
 * Each row's place in time, the rows newest first by block as the daemon lists them: its own time, or for a row whose
 * block's time is not read yet, the span its dated neighbours bound it to (after the next older one, before the next
 * newer one or now). It is placed at the newest end of that span, and its day is the span's when the span falls on one
 * day; Earlier only when it does not, so a row not timed yet keeps its place by block among the dated ones.
 */
function placed(rows: readonly Pick<IncomingView, "at">[], now: number): { day: string; at: number }[] {
	const newer: number[] = [];
	let bound = now;
	for (const row of rows) {
		if (row.at !== undefined) bound = row.at;
		newer.push(bound);
	}
	const older: (number | undefined)[] = new Array(rows.length);
	let below: number | undefined;
	for (let i = rows.length - 1; i >= 0; i--) {
		const at = rows[i]?.at;
		if (at !== undefined) below = at;
		older[i] = below;
	}
	return rows.map((row, i) => {
		if (row.at !== undefined) return { day: dayOf(new Date(row.at), now), at: row.at };
		const high = newer[i] ?? now;
		const low = older[i];
		const day = dayOf(new Date(high), now);
		return { day: low !== undefined && dayOf(new Date(low), now) === day ? day : "Earlier", at: high };
	});
}

/**
 * The money that came in, as a wallet's activity lists it: by day, newest first; Received until final, then Confirmed;
 * each with its link to the network's explorer, where it has one. A row whose time is not read yet says its block, under
 * the day its neighbours bound it to.
 */
export function incomingRows(rows: readonly IncomingView[], now: number, explorer?: string): TxRowView[] {
	return moneyRows(rows, [], now, explorer);
}

/**
 * The money that came in and what left by a transaction signed outside banda (H-210), merged newest first by block:
 * each placed in time among the others, an outside row linking to its block on the explorer. What left outside banda
 * says no amount: the chain shows the balance, not what one transaction of it spent.
 */
function moneyRows(
	incoming: readonly IncomingView[],
	outside: readonly OutsideView[],
	now: number,
	explorer?: string,
): TxRowView[] {
	const all: (IncomingView | OutsideView)[] = [];
	let m = 0;
	let n = 0;
	while (m < incoming.length || n < outside.length) {
		const a = incoming[m];
		const b = outside[n];
		if (b === undefined || (a !== undefined && a.block >= b.block)) {
			all.push(a as IncomingView);
			m++;
		} else {
			all.push(b);
			n++;
		}
	}
	const places = placed(all, now);
	return all.map((row, index) => {
		const at = row.at === undefined ? undefined : new Date(row.at);
		const day = places[index]?.day ?? "Earlier";
		const time =
			at === undefined
				? `block ${row.block.toLocaleString("en-US")}`
				: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		if (!("asset" in row)) {
			return {
				id: row.id,
				...(explorer === undefined ? {} : { explorer: `${explorer}/block/${row.block}` }),
				day,
				direction: "out",
				counterpart: "Signed with this wallet's key elsewhere",
				token: "ETH",
				state: "outside",
				time,
			};
		}
		const link = explorerOf(row, explorer);
		return {
			id: row.id,
			...(link === undefined ? {} : { explorer: link }),
			day,
			direction: "in",
			counterpart: row.from === undefined ? "another address" : shortAddress(row.from),
			amount: row.asset === "usdc" ? groupedUnits(row.amount, 6, 2) : groupedUnits(row.amount, 18, 6),
			token: row.asset === "usdc" ? "USDC" : "ETH",
			state: row.confirmed ? "confirmed" : "received",
			time,
		};
	});
}

/** The day a row of the activity falls on, as its list heads it: Today or its date. */
const dayOf = (at: Date, now: number) =>
	at.toDateString() === new Date(now).toDateString() ? "Today" : at.toLocaleDateString([], DAY);

/** What each kind of a key's showing says in the wallet's activity. */
const REVEAL_WORDS: { readonly [kind in RevealView["kind"]]: string } = {
	creation: "Key shown as the wallet was made",
	later: "Key shown on this computer",
};

/** Each time a wallet's key was shown, as a row of its activity (UC-02 A2, H-266, OD-2). */
export function revealRows(reveals: readonly RevealView[] | undefined, now: number): NoteRowView[] {
	return (reveals ?? []).map((reveal, index) => {
		const at = new Date(reveal.at);
		return {
			kind: "note",
			id: `reveal:${reveal.at}:${index}`,
			day: dayOf(at, now),
			title: REVEAL_WORDS[reveal.kind],
			time: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
		};
	});
}

/**
 * A wallet's activity, newest first: the money that came in and what left outside banda, as its pages listed them, and
 * each time its key was shown, by their times. A row of money whose time is not read yet stands at the newest end of
 * the span its dated neighbours bound it to, so above the showings in that span (money comes in after the key was
 * shown at the wallet's making), and its day is the span's once a showing below it bounds it: no Earlier above Today.
 * While older pages of money are left (`more`), a showing older than the last row listed waits for them, so no row
 * stands above one older than it.
 */
export function activityRows(
	incoming: readonly IncomingView[],
	reveals: readonly RevealView[] | undefined,
	now: number,
	explorer: string | undefined,
	more: boolean,
	outside: readonly OutsideView[] = [],
): ActivityRowView[] {
	const listed = moneyRows(incoming, outside, now, explorer);
	const byId = new Map<string, Pick<IncomingView, "at">>([...incoming, ...outside].map((row) => [row.id, row]));
	const places = placed(
		listed.map((row) => byId.get(row.id) ?? {}),
		now,
	);
	const money = listed.map((row, index) => ({
		row: row as ActivityRowView,
		at: places[index]?.at ?? Number.NEGATIVE_INFINITY,
	}));
	const oldest = money.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
	const notes = revealRows(reveals, now)
		.map((row, index) => ({ row: row as ActivityRowView, at: reveals?.[index]?.at ?? 0 }))
		.filter(({ at }) => !more || at >= oldest)
		.reverse();
	const merged: { row: ActivityRowView; at: number }[] = [];
	let m = 0;
	let n = 0;
	while (m < money.length || n < notes.length) {
		const a = money[m];
		const b = notes[n];
		if (b === undefined || (a !== undefined && a.at >= b.at)) {
			merged.push(a as { row: ActivityRowView; at: number });
			m++;
		} else {
			merged.push(b);
			n++;
		}
	}
	// a row not timed yet that no dated row of money is below has its span's low end in the showing below it, if any
	let below: number | undefined;
	for (let i = merged.length - 1; i >= 0; i--) {
		const entry = merged[i] as { row: ActivityRowView; at: number };
		const timed = "kind" in entry.row || byId.get(entry.row.id)?.at !== undefined;
		if (timed) {
			below = entry.at;
			continue;
		}
		if (entry.row.day !== "Earlier" || below === undefined) continue;
		const day = dayOf(new Date(entry.at), now);
		if (dayOf(new Date(below), now) === day) entry.row = { ...entry.row, day };
	}
	return merged.map(({ row }) => row);
}

/**
 * Why a wallet cannot be switched on or off for an agent now, if it cannot: its state alone, the one rule for the
 * wallet's Agents tab and the agent's Access (UC-05). An offline wallet (its keychain, another home, a coding agent
 * connected) is still switched: what it may do waits on its signer, not on who it serves.
 */
export function unswitchable(wallet: WalletView): string | undefined {
	switch (wallet.state) {
		case "archived":
			return "Archived wallets serve no agent. Unarchive it first.";
		case "removing":
			return "The wallet is being removed: it serves no agent.";
		case "creating":
			return "The wallet isn't made yet: it serves agents once it is.";
		default:
			return undefined;
	}
}
