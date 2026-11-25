/**
 * Wallets in the app (docs/wallets.md): the home's wallets and the networks' RPCs, masked, read when a page that shows
 * them opens and kept live by the `wallets` shell event; the money that came in to one; and the owner's calls: make
 * one, see its key once right after, confirm the saved copy or skip saving it, open Receive, archive, bring back and
 * remove it, switch it on or off for an agent, have its key checked again, and set a network's RPC. Each call answers
 * the wallets as they are after.
 *
 * A key is never kept here: the creation's reveal answers it to the page that made the wallet, which holds it while
 * it shows it, and a saved copy goes back as its SHA-256 alone.
 */
import { useEffect, useSyncExternalStore } from "react";
import { LOOK_RENEW_MS } from "../../../src/wallet/cadence.ts";
import {
	api,
	type WalletAct,
	type WalletCreate,
	type WalletIncoming,
	type WalletMade,
	type WalletNetworkView,
	type WalletOrphans,
	type WalletReceive,
	type WalletReveal,
	type WalletRevealed,
	type WalletRpcSet,
	type WalletSaved,
	type WalletSwitch,
	type WalletsView,
	type WalletView,
} from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import type { ShellHandlers } from "../lib/shell.ts";

let wallets: WalletsView | undefined;
const listeners = new Set<() => void>();

/** Take the wallets as an answer or the stream says them. */
function showWallets(next: WalletsView): void {
	wallets = next;
	for (const listener of listeners) listener();
	switchPending(next);
}

/**
 * The agent each new wallet was made for, by its address, while its key's save step is open: a wallet is made on for
 * no agent (UC-01), and the agent the owner chose is switched on once the save step ends (the key saved or the save
 * skipped), however the owner gets there: from the page that made it, the key page a reload lands on, or Receive later.
 * Kept for the tab, so a reload, the browser's Back or a breadcrumb does not drop the owner's choice.
 */
const PENDING = "banda.wallets.forAgent";
const pending = new Map<string, string>(readPending());

function readPending(): [string, string][] {
	try {
		const raw: unknown = JSON.parse(sessionStorage.getItem(PENDING) ?? "{}");
		if (typeof raw !== "object" || raw === null) return [];
		return Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	} catch {
		return [];
	}
}

function keepPending(): void {
	try {
		if (pending.size === 0) sessionStorage.removeItem(PENDING);
		else sessionStorage.setItem(PENDING, JSON.stringify(Object.fromEntries(pending)));
	} catch {
		// a tab that keeps nothing still switches the agent on from this page
	}
}

/** The agent the wallet at `address` was made for, switched on once its save step ends (UC-01). */
export function forAgentOnceSaved(address: string, agent: string, name: string): void {
	pending.set(address.toLowerCase(), JSON.stringify({ agent, name }));
	keepPending();
}

function switchPending(view: WalletsView): void {
	for (const [address, held] of [...pending]) {
		// a wallet the view does not list yet (it was just made), or one still being made, waits
		const wallet = view.wallets.find((each) => each.address.toLowerCase() === address);
		if (wallet === undefined || wallet.state === "creating") continue;
		// one archived or being removed takes no agent; a ready one, once its save step ended
		if (wallet.state === "ready" && wallet.backup === "unsaved") continue;
		pending.delete(address);
		keepPending();
		if (wallet.state !== "ready") continue;
		let chosen: { agent: string; name: string };
		try {
			chosen = JSON.parse(held) as { agent: string; name: string };
		} catch {
			continue;
		}
		if (wallet.agents.includes(chosen.agent)) continue;
		void attempt(`let ${chosen.name} read ${wallet.name}`, () => switchWalletAgent(wallet.address, chosen.agent, true));
	}
}

export const shell: ShellHandlers = {
	wallets: (event) => {
		showWallets(event.wallets);
		return {};
	},
};

/** Read the wallets again: what a call that answers something else changed. */
export const readWallets = () => api<WalletsView>("/wallets").then(showWallets, () => {});

function subscribe(listener: () => void) {
	listeners.add(listener);
	// read when something shows them: the stream says them on every change, and this covers the first look
	if (listeners.size === 1) void readWallets();
	return () => listeners.delete(listener);
}

/** The wallets and the networks, once read. */
export function useWallets(): WalletsView | undefined {
	return useSyncExternalStore(subscribe, () => wallets);
}

const answered = async (call: Promise<WalletsView>) => {
	const view = await call;
	showWallets(view);
	return view;
};

const post = (path: string, body: unknown = {}) =>
	api<WalletsView>(path, { method: "POST", body: JSON.stringify(body) });

const at = (address: string) => `/wallets/${encodeURIComponent(address)}`;

/** A fresh id for one creation: the same id again is the same wallet, so a creation retried makes no second one (C14). */
export const creationId = () => `create-${crypto.randomUUID()}`;

/**
 * Make a wallet. The answer carries the creation's reveal, to this call alone: the page asks for the key next with its
 * secret (`revealCreated`), which no other answer carries.
 */
export const createWallet = (request: string, name: string, network: WalletCreate["network"]) =>
	api<WalletMade>("/wallets", {
		method: "POST",
		body: JSON.stringify({ request, name, network } satisfies WalletCreate),
	});

/** The new wallet's key, once, to the page that made it: refused `spent` (403) once used, expired or never this page's. */
export const revealCreated = (address: string, request: string, secret: string) =>
	api<WalletRevealed>(`${at(address)}/reveal`, {
		method: "POST",
		body: JSON.stringify({ request, secret } satisfies WalletReveal),
	});

/** The owner's saved copy, by its SHA-256: a copy that is not the key leaves the wallet Not backed up. */
export const confirmSaved = (address: string, digest: string) =>
	answered(post(`${at(address)}/saved`, { digest } satisfies WalletSaved));

export const skipSaving = (address: string) => answered(post(`${at(address)}/skip`));

/** An open wallet screen renews its look at the wallet's network: it is read about every 2 s meanwhile. */
export const lookingAt = (address: string) =>
	api<Record<string, never>>(`${at(address)}/looking`, { method: "POST", body: "{}" });

/**
 * While a screen showing `address` is open and in sight, its network is read at the fast cadence (stack.md section 7):
 * the screen's first read looks at it, and this renews the look every `LOOK_RENEW_MS`. A renewal that fails only
 * leaves the slow cadence, so it says nothing; a hidden page renews none, and its look lapses.
 */
export function useLooking(address: string | undefined): void {
	useEffect(() => {
		if (address === undefined) return;
		const renew = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			void lookingAt(address).catch(() => {});
		}, LOOK_RENEW_MS);
		return () => clearInterval(renew);
	}, [address]);
}

/** Where to be paid, or why not yet; telling it marks the address as left banda. */
export const openReceive = (address: string) =>
	api<WalletReceive>(`${at(address)}/receive`, { method: "POST", body: "{}" });

/** Acknowledge the code at the wallet's address, on the computer banda runs on (H-157): Receive keeps its warning. */
export const acknowledgeCode = (address: string) => answered(post(`${at(address)}/acknowledge-code`));

/**
 * A page of the money that came in to the wallet, newest first, as the chain showed it, and why it may not be all of
 * it; `before` is the `more` of the page before. `wake` asks the daemon to read the wallet's chain now as well: a page's
 * first read does, a read again after a push need not.
 */
export const readIncoming = (address: string, wake = true, before?: string) => {
	const query = new URLSearchParams();
	if (!wake) query.set("wake", "false");
	if (before !== undefined) query.set("before", before);
	const search = query.toString();
	return api<WalletIncoming>(`${at(address)}/incoming${search === "" ? "" : `?${search}`}`);
};

/** The keys this computer's keychain holds that no wallet names (H-045); null where it cannot list them. */
export const readOrphans = () => api<WalletOrphans>("/wallets/orphans");

/** Archive the wallet, or bring it back, at the version the owner's view showed (C8). */
export const archiveWallet = (wallet: Pick<WalletView, "address" | "version">, archived: boolean) =>
	answered(
		post(`${at(wallet.address)}/${archived ? "archive" : "unarchive"}`, {
			version: wallet.version,
		} satisfies WalletAct),
	);

/** Remove the wallet and its key; refused while removing could lose anything (C17). */
export const removeWallet = (wallet: Pick<WalletView, "address" | "version">) =>
	answered(post(`${at(wallet.address)}/remove`, { version: wallet.version } satisfies WalletAct));

/** Check the wallet's key again: what a keychain unlocked, or a key restored, needs to be seen. */
export const checkWallet = (address: string) => answered(post(`${at(address)}/check`));

/** Check again whether this computer has a keychain banda can use, as Settings asks where it found none (H-309). */
export const checkKeychain = () => answered(post("/wallets/keychain"));

/** Switch the wallet on or off for an agent (OD-1). */
export const switchWalletAgent = (address: string, agent: string, on: boolean) =>
	answered(post(`${at(address)}/agents/${encodeURIComponent(agent)}`, { on } satisfies WalletSwitch));

/** Set a network's RPC, or (null) go back to banda's default; answers the network with its RPC masked. */
export async function setRpc(network: string, url: string | null): Promise<WalletNetworkView> {
	const after = await api<WalletNetworkView>(`/wallets/rpc/${encodeURIComponent(network)}`, {
		method: "PUT",
		body: JSON.stringify({ url } satisfies WalletRpcSet),
	});
	await readWallets();
	return after;
}
