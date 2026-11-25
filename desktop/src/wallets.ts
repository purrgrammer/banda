/**
 * What the desktop app's main process does for the home's wallets (docs/wallets.md "Keys and the keychain", OD-2,
 * UC-02 A2, UC-21, H-045): the owner's later reveal of a key, the Restore of a key whose item is gone, the move of
 * signing to this home, and the export or deletion of a key the keychain holds that no wallet names. Each runs the release's own host signer (src/wallet/signer-host.ts) from this process, never the
 * daemon's: the key goes from the signer child to this process and a local window, or from the owner's paste to the
 * child, and never through the daemon (C20), which is told only that it happened. Under Electron the signer is run by
 * `node`, the bundled Node.js the daemon runs, so the keychain sees the one code identity its items trust.
 *
 * The decisions live here, with what Electron gives passed in, so they are tested without Electron (main.ts wires
 * them to IPC, gated to the daemon's own page).
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** What a signer call gives: its result, or a fixed code (src/wallet/signer-protocol.ts). */
export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: string };

/** The release's HostSigner, as this process uses it. */
export type HostSigner = {
	leased(): Promise<Outcome<{ lease: { epoch: number; mine: boolean } | null }>>;
	export(lease: number, address: string): Promise<Outcome<{ address: string; key: string }>>;
	restore(lease: number, address: string, key: string): Promise<Outcome<{ address: string }>>;
	move(expected: number | null, addresses: readonly string[], after?: number): Promise<Outcome<{ epoch: number }>>;
	remove(lease: number, address: string): Promise<Outcome<{ removed: boolean }>>;
	stop(): void;
};

/** Loads one of the release's modules by its name under `dist/wallet/`. */
export type Load = (name: "signer-host" | "home-id") => Promise<unknown>;

/** The release's modules, from its built `dist`. */
const releaseModules =
	(dist: string): Load =>
	(name) =>
		import(pathToFileURL(join(dist, "wallet", `${name}.js`)).href);

/**
 * A host signer for `home`, its child run by `node`: the bundled Node.js, since Electron's own binary would start
 * another app and is not the identity the keychain trusts
 * (`signerNode` refuses to start one under Electron without it).
 */
export async function hostSigner(load: Load, home: string, node: string): Promise<HostSigner> {
	const host = (await load("signer-host")) as {
		HostSigner: new (at: unknown, options: { node: string }) => HostSigner;
	};
	const id = (await load("home-id")) as { signerHome: (home: string) => Promise<unknown> };
	return new host.HostSigner(await id.signerHome(home), { node });
}

export type WalletDeps = {
	/** A fresh host signer; stopped once the act ends. */
	readonly signer: () => Promise<HostSigner>;
	/** The OS's re-authentication of the owner (Touch ID); false where this computer offers none (OD-2). */
	readonly reauthenticate: (why: string) => Promise<boolean>;
	/**
	 * Whether this computer re-authenticates the owner at all (`laterReveal`): no later reveal, Restore or move without.
	 */
	readonly reauthenticates: boolean;
	/** The home's wallets as the daemon holds them, read as the owner; undefined when no daemon answers. */
	readonly wallets: () => Promise<readonly HeldWallet[] | undefined>;
	/**
	 * Whether the daemon says this home's id is not its wallets' (GET /wallets' `offline: "identity"`): then no act here
	 * runs, since every keychain item it would read or write is named by the id (H-261).
	 */
	readonly identityLost: () => Promise<boolean>;
	/** The lease epoch the daemon's store last took; undefined when it took none, or no daemon answers. */
	readonly lease: () => Promise<number | undefined>;
	/** POSTs to the daemon's `/api` path, as the owner; whether the daemon took it. */
	readonly tell: (path: string, body?: Record<string, unknown>) => Promise<boolean>;
	/**
	 * Shows the key, beside the address it opens, in a local window. A wallet's reveal gives the address short: a whole
	 * address leaves banda only through Receive, which marks it disclosed first (H-005, C17), so a key window never
	 * hands out the address of a wallet whose save step is open.
	 */
	readonly show: (address: string, key: string) => Promise<void>;
};

/** Of a wallet the daemon holds, what the acts here go by: its state, and how it signs on this computer. */
export type HeldState = { readonly state: string; readonly signing?: { readonly state: string } };

/** A wallet of the home, by its address, as the daemon holds it. */
export type HeldWallet = HeldState & { readonly address: string };

/** What the daemon's page hears back: done, or why not, as a fixed code it puts in words. */
export type WalletAnswer = { readonly ok: true } | { readonly ok: false; readonly code: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** An address as the owner's screens show it beside a key (src/wallet/label.ts `shortAddress`). */
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/**
 * The key a pasted copy writes, as `0x` and 64 lowercase hex digits, or undefined when it is not a key's text: spaces
 * and line breaks dropped, a missing `0x` added, either case. The rule of src/wallet/key-text.ts `normalKey`, which
 * this process cannot import; test/desktop-wallets.test.ts holds the two equal.
 */
export function normalKey(pasted: string): string | undefined {
	const bare = pasted.replace(/\s+/g, "").toLowerCase();
	const key = bare.startsWith("0x") ? bare : `0x${bare}`;
	return /^0x[0-9a-f]{64}$/.test(key) ? key : undefined;
}

/** The wallet the daemon holds at `address`, whatever its letters' case; undefined when none, or no daemon answers. */
async function walletAt(deps: WalletDeps, address: string): Promise<HeldWallet | undefined> {
	return (await deps.wallets())?.find((each) => each.address.toLowerCase() === address.toLowerCase());
}

/**
 * Every host signer an act here made that has not stopped yet: the app's quit stops them all (`stopSigners`), since a
 * child's deadline is a timer in this process that never fires once it exits, and a child parked behind a keychain
 * prompt would outlive the app with the prompt still on screen (H-018, H-034, C20).
 */
const live = new Set<HostSigner>();
/** Set once the app quits: a signer made after it is stopped as it comes, before any call. */
let closing = false;

/** Kills every host signer's children in flight and refuses their later calls: the app's quit and relaunch run it. */
export function stopSigners(): void {
	closing = true;
	for (const signer of live) signer.stop();
	live.clear();
}

/** `made`, kept among the live signers until its act stops it; stopped at once once the app quits. */
function kept(made: HostSigner): HostSigner {
	if (closing) made.stop();
	else live.add(made);
	return made;
}

/**
 * Runs `act` with a fresh signer and the lease it reads for this home, the signer stopped after. A keychain with no
 * lease item for the home gives `act` null: it lost banda's items, or the home came from another computer, and no home
 * on it holds the lease (H-021, H-286).
 */
async function underLease(
	deps: WalletDeps,
	act: (signer: HostSigner, lease: { epoch: number; mine: boolean } | null) => Promise<WalletAnswer>,
): Promise<WalletAnswer> {
	// the daemon may have found the id lost since the act began; the signer reads it again and makes none (H-261)
	if (await deps.identityLost()) return { ok: false, code: "identity" };
	let signer: HostSigner;
	try {
		signer = await deps.signer();
	} catch (error) {
		if ((error as { code?: unknown }).code === "identity") return { ok: false, code: "identity" };
		throw error;
	}
	try {
		const leased = await signer.leased();
		if (!leased.ok) return { ok: false, code: leased.code };
		return await act(signer, leased.lease);
	} finally {
		signer.stop();
		live.delete(signer);
	}
}

/** How many times the desktop tells the daemon of a showing before it shows nothing: one try and two retries. */
const TELL_TRIES = 3;

/** Whether the daemon holds `address` as a ready wallet: a reveal is for a ready wallet alone (C17, H-048). */
const ready = async (deps: WalletDeps, address: string) => (await walletAt(deps, address))?.state === "ready";

/**
 * The owner's later reveal of a wallet's key (OD-2, UC-02 A2): only of a ready wallet, asked of the daemon before the
 * key is exported and again before it is shown, so a wallet archived or being removed meanwhile shows nothing (C17,
 * H-048). The OS re-authenticates the owner, the signer proves and exports the key at this home's lease, the daemon
 * lists the reveal in the wallet's activity, and only once it took that is the key shown in a local window (H-266):
 * a reveal the daemon did not hear of shows nothing.
 */
export async function revealKey(address: unknown, deps: WalletDeps): Promise<WalletAnswer> {
	if (typeof address !== "string" || !ADDRESS.test(address)) return { ok: false, code: "refused" };
	if (!deps.reauthenticates) return { ok: false, code: "no_reauthentication" };
	if (await deps.identityLost()) return { ok: false, code: "identity" };
	if (!(await ready(deps, address))) return { ok: false, code: "not_ready" };
	if (!(await deps.reauthenticate("show a wallet's private key"))) return { ok: false, code: "denied" };
	return underLease(deps, async (signer, lease) => {
		// no lease item: the keychain holds none of the home's keys either
		if (lease === null) return { ok: false, code: "missing" };
		if (!lease.mine) return { ok: false, code: "other_home" };
		const exported = await signer.export(lease.epoch, address);
		if (!exported.ok) return { ok: false, code: exported.code };
		if (!(await ready(deps, exported.address))) return { ok: false, code: "not_ready" };
		// told under one id, and told again while its answer is not yet safe: the daemon lists one showing (C21)
		const id = randomUUID();
		let told = false;
		for (let tries = 0; tries < TELL_TRIES && !told; tries++)
			told = await deps.tell(`/wallets/${exported.address}/revealed`, { id });
		if (!told) return { ok: false, code: "unlisted" };
		await deps.show(short(exported.address), exported.key);
		return { ok: true };
	});
}

/**
 * The owner's Restore of a wallet's key whose item is gone (UC-19, H-014): only for a wallet of this home whose key the
 * daemon found missing, once the OS re-authenticated the owner, and kept only if it derives the wallet's address (UC-19
 * A2); the daemon checks the key again after. On a keychain that lost every banda item, its lease included, the proven
 * key takes the lease back for this home past the epoch the daemon's store last took (H-286).
 */
export async function restoreKey(address: unknown, key: unknown, deps: WalletDeps): Promise<WalletAnswer> {
	if (typeof address !== "string" || !ADDRESS.test(address)) return { ok: false, code: "refused" };
	// a copy that is no key's text is said apart from a key that opens another address (`wrong_key`, from the signer)
	const written = typeof key === "string" ? normalKey(key) : undefined;
	if (written === undefined) return { ok: false, code: "not_a_key" };
	if (!deps.reauthenticates) return { ok: false, code: "no_reauthentication" };
	if (await deps.identityLost()) return { ok: false, code: "identity" };
	if ((await walletAt(deps, address))?.signing?.state !== "key_missing") return { ok: false, code: "not_missing" };
	if (!(await deps.reauthenticate("keep a wallet's private key on this computer")))
		return { ok: false, code: "denied" };
	return underLease(deps, async (signer, lease) => {
		let epoch: number;
		if (lease === null) {
			const stored = await deps.lease();
			if (stored === undefined) return { ok: false, code: "no_daemon" };
			epoch = stored;
		} else if (!lease.mine) return { ok: false, code: "other_home" };
		else epoch = lease.epoch;
		const restored = await signer.restore(epoch, address, written);
		if (!restored.ok) return { ok: false, code: restored.code };
		await deps.tell(`/wallets/${restored.address}/check`);
		return { ok: true };
	});
}

/**
 * Whether no wallet the daemon holds now names `address` (C15, H-045): a wallet's key goes through the wallet's own
 * acts, never these. The keychain is never listed for it: a listing loads every item of the service, every home's keys
 * with them, and may prompt once per item (H-009, H-037). The signer reads that one item instead, and proves it a key
 * that opens `address`, or the act stops.
 */
async function orphaned(deps: WalletDeps, address: string): Promise<boolean> {
	const held = await deps.wallets();
	return held !== undefined && !held.some((each) => each.address.toLowerCase() === address.toLowerCase());
}

/**
 * The owner's export of a key without a wallet (H-045): a wallet whose making stopped, or a backup restored from before
 * one was made, may have left a funded key the home names nowhere. Only of a key no wallet names, asked before
 * and again after the export; the OS re-authenticates the owner, the signer proves the item is a key that opens its
 * address at this home's lease, and the key is shown in a local window, never through the daemon (C16, C20).
 */
export async function exportOrphan(address: unknown, deps: WalletDeps): Promise<WalletAnswer> {
	if (typeof address !== "string" || !ADDRESS.test(address)) return { ok: false, code: "refused" };
	if (!deps.reauthenticates) return { ok: false, code: "no_reauthentication" };
	if (await deps.identityLost()) return { ok: false, code: "identity" };
	if (!(await orphaned(deps, address))) return { ok: false, code: "not_orphan" };
	if (!(await deps.reauthenticate("show the private key of a key without a wallet")))
		return { ok: false, code: "denied" };
	return underLease(deps, async (signer, lease) => {
		if (lease === null) return { ok: false, code: "missing" };
		if (!lease.mine) return { ok: false, code: "other_home" };
		const exported = await signer.export(lease.epoch, address);
		if (!exported.ok) return { ok: false, code: exported.code };
		if (!(await orphaned(deps, exported.address))) return { ok: false, code: "not_orphan" };
		await deps.show(exported.address, exported.key);
		return { ok: true };
	});
}

/**
 * The owner's deletion of a key without a wallet (H-045), once they confirmed on the page that any money at its address
 * is lost unless the key was saved: only of a key no wallet names, asked again just before; the OS
 * re-authenticates the owner, and the signer removes that one item at this home's lease, once it proved it a key that
 * opens its address. Nothing else is deleted, and banda never deletes one on its own.
 */
export async function deleteOrphan(address: unknown, deps: WalletDeps): Promise<WalletAnswer> {
	if (typeof address !== "string" || !ADDRESS.test(address)) return { ok: false, code: "refused" };
	if (!deps.reauthenticates) return { ok: false, code: "no_reauthentication" };
	if (await deps.identityLost()) return { ok: false, code: "identity" };
	if (!(await orphaned(deps, address))) return { ok: false, code: "not_orphan" };
	if (!(await deps.reauthenticate("delete a key without a wallet from this computer")))
		return { ok: false, code: "denied" };
	return underLease(deps, async (signer, lease) => {
		if (lease === null) return { ok: false, code: "missing" };
		if (!lease.mine) return { ok: false, code: "other_home" };
		if (!(await orphaned(deps, address))) return { ok: false, code: "not_orphan" };
		const removed = await signer.remove(lease.epoch, address);
		if (!removed.ok) return { ok: false, code: removed.code };
		return { ok: true };
	});
}

/** The wallets whose keys this home keeps: a move proves each of them, whichever wallet the owner moved it from. */
const KEPT: ReadonlySet<string> = new Set(["ready", "archived"]);

/**
 * Moves signing to this home (UC-21): the lease is the home's, so every wallet whose key the home keeps, as the daemon
 * lists them, has its key proven first, whatever wallet the owner moved it from; then the lease is taken from the home
 * holding it, and the daemon checks each wallet's key again after. A home that keeps no wallet yet (a backup restored
 * from before the first, a copy) moves with nothing to prove, so it can make wallets: the other home then stops signing
 * for this home's wallets, and the daemon checks its keychain again after (UC-21 A1).
 */
export async function moveSigning(deps: WalletDeps): Promise<WalletAnswer> {
	if (!deps.reauthenticates) return { ok: false, code: "no_reauthentication" };
	if (await deps.identityLost()) return { ok: false, code: "identity" };
	const held = await deps.wallets();
	if (held === undefined) return { ok: false, code: "no_daemon" };
	const addresses = held.filter((each) => KEPT.has(each.state)).map((each) => each.address);
	if (!addresses.every((each) => ADDRESS.test(each))) return { ok: false, code: "refused" };
	if (!(await deps.reauthenticate("move a wallet's signing to this computer"))) return { ok: false, code: "denied" };
	return underLease(deps, async (signer, lease) => {
		// the epoch the daemon's store last took: the daemon signs only at or past it (C16), so a move goes past it
		const stored = await deps.lease();
		// this home's lease at or past the store's: there is nothing to move
		if (lease?.mine === true && lease.epoch >= (stored ?? 0)) return { ok: true };
		// otherwise the move always writes: another home's lease; one of this home's the keychain holds behind the
		// store (an item rolled back); or no lease item at all, past the store's epoch once every kept key is proven
		// (H-286), or, where the store never took one, over a home secret a claim stopped short left bound elsewhere,
		// which the daemon's own claim cannot replace (C15, H-287)
		const expected = lease === null ? (stored ?? null) : lease.epoch;
		const moved = await signer.move(expected, addresses, stored);
		if (!moved.ok) return { ok: false, code: moved.code };
		for (const address of addresses) await deps.tell(`/wallets/${address}/check`);
		// what waited on the lease (a creation, a removal) is settled now, and the daemon's store takes the new epoch
		await deps.tell("/wallets/keychain");
		return { ok: true };
	});
}

/**
 * The acts the daemon's own page asks of the main process for the home's wallets, by their IPC channel: what each takes
 * from the page, and the act it runs (main.ts answers each, from that page alone; desktop/src/preload.cts sends them).
 */
export const WALLET_ACTS: Readonly<Record<string, (deps: WalletDeps, ...args: unknown[]) => Promise<WalletAnswer>>> = {
	"banda:reveal-key": (deps, address) => revealKey(address, deps),
	"banda:restore-key": (deps, address, key) => restoreKey(address, key, deps),
	"banda:move-signing": (deps) => moveSigning(deps),
	"banda:export-orphan": (deps, address) => exportOrphan(address, deps),
	"banda:delete-orphan": (deps, address) => deleteOrphan(address, deps),
};

/** What the main process gives the wallets' acts: the release, the daemon it is attached to, Electron's parts. */
export type Shell = {
	/** The release's bundled Node.js and its CLI, whose `dist` the host signer is loaded from. */
	readonly release: () => { readonly node: string; readonly cli: string };
	readonly home: string;
	/** The daemon this app is attached to; undefined while none is. */
	readonly daemon: () => { readonly port: number; readonly token: string } | undefined;
	/** The OS's re-authentication, where this computer has one (macOS's Touch ID); it throws when refused. */
	readonly authenticate?: (why: string) => Promise<void>;
	readonly show: (address: string, key: string) => Promise<void>;
	/** The release's modules; its built `dist` by default. */
	readonly load?: Load;
	readonly fetch?: typeof fetch;
};

/**
 * How a later reveal goes (OD-2, H-266): behind the OS's re-authentication where this computer has one (a Mac with
 * Touch ID), and refused everywhere else, Linux and Windows included, where Electron offers none: until OD-2 settles
 * how they re-authenticate the owner, a key is shown there only as its wallet is made. A Restore and a move of signing
 * go the same way.
 */
export function laterReveal(authenticates: boolean): "reauthenticated" | "refused" {
	return authenticates ? "reauthenticated" : "refused";
}

/**
 * The wallets' acts as the desktop app runs them: the release's host signer run by `release().node`, the bundled
 * Node.js (C20, `signerNode`), the OS's re-authentication where it has one and the acts behind it as `laterReveal`
 * says, and the daemon read and told as the owner over loopback.
 */
export function walletDeps(shell: Shell): WalletDeps {
	const ask = shell.fetch ?? fetch;
	const api = async (
		method: string,
		path: string,
		body: Record<string, unknown> = {},
	): Promise<Response | undefined> => {
		const daemon = shell.daemon();
		if (daemon === undefined) return undefined;
		return ask(`http://127.0.0.1:${daemon.port}/api${path}`, {
			method,
			headers: {
				authorization: `Bearer ${daemon.token}`,
				...(method === "POST" ? { "content-type": "application/json" } : {}),
			},
			...(method === "POST" ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
	};
	return {
		signer: () => {
			const { node, cli } = shell.release();
			return hostSigner(shell.load ?? releaseModules(join(dirname(cli), "..")), shell.home, node).then(kept);
		},
		reauthenticate: async (why) => {
			if (shell.authenticate === undefined) return false;
			try {
				await shell.authenticate(why);
				return true;
			} catch {
				return false;
			}
		},
		wallets: async () => {
			const answered = await api("GET", "/wallets");
			if (answered === undefined || !answered.ok) return undefined;
			const view = (await answered.json().catch(() => undefined)) as
				| { wallets?: { address?: unknown; state?: unknown; signing?: { state?: unknown } }[] }
				| undefined;
			if (!Array.isArray(view?.wallets)) return undefined;
			return view.wallets.flatMap((each) =>
				typeof each.address === "string" && typeof each.state === "string"
					? [
							{
								address: each.address,
								state: each.state,
								...(typeof each.signing?.state === "string" ? { signing: { state: each.signing.state } } : {}),
							},
						]
					: [],
			);
		},
		identityLost: async () => {
			const answered = await api("GET", "/wallets");
			// no daemon to ask: the signer itself refuses a home whose id is missing
			if (answered === undefined || !answered.ok) return false;
			const view = (await answered.json().catch(() => undefined)) as { offline?: unknown } | undefined;
			return view?.offline === "identity";
		},
		lease: async () => {
			const answered = await api("GET", "/wallets");
			if (answered === undefined || !answered.ok) return undefined;
			const view = (await answered.json().catch(() => undefined)) as { lease?: unknown } | undefined;
			return typeof view?.lease === "number" && Number.isInteger(view.lease) && view.lease >= 1
				? view.lease
				: undefined;
		},
		tell: async (path, body) => (await api("POST", path, body))?.ok === true,
		show: shell.show,
		reauthenticates: laterReveal(shell.authenticate !== undefined) === "reauthenticated",
	};
}

/**
 * The local page the key is shown in, bundled with the app (C16): it fetches nothing, allows its one script by hash
 * alone, holds no key in its address or source, and keeps the key hidden until Show is pressed and for 30 s after
 * (H-270).
 */
export const KEY_PAGE = ["assets", "key.html"] as const;

/** How long a copied key stays on the clipboard: the same as the page's own clear holds (web/src/app/clipboard.ts). */
export const CLIPBOARD_CLEAR = 60_000;

/** The part of Electron's clipboard a copied key goes through. */
export type Clipboard = {
	readonly readText: () => string | Promise<string>;
	readonly writeText: (text: string) => void | Promise<void>;
	readonly clear: () => void;
};

/**
 * A key on the clipboard, its clear held by the main process so it outlives the page or window that copied it (H-271):
 * `copy` clears it after `CLIPBOARD_CLEAR`, `clear` with no text clears the key copied last, and each clears only
 * while the clipboard still holds that key, so a later copy of something else is kept.
 */
export function secretClipboard(
	clipboard: Clipboard,
	later: (then: () => void, ms: number) => unknown = setTimeout,
): { readonly copy: (text: string) => Promise<void>; readonly clear: (text?: string) => Promise<void> } {
	let copied: string | undefined;
	const clear = async (text: string | undefined = copied): Promise<void> => {
		if (text === undefined) return;
		if ((await clipboard.readText()) === text) clipboard.clear();
		if (copied === text) copied = undefined;
	};
	return {
		copy: async (text) => {
			await clipboard.writeText(text);
			copied = text;
			later(() => void clear(text).catch(() => {}), CLIPBOARD_CLEAR);
		},
		clear,
	};
}
