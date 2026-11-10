/**
 * Model tiers in the app: the tier new chats start on, the models the tiers run on (read when a page that shows them
 * opens, and after each change), and a chat's own tier.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Tier } from "../../../src/core/tiers.ts";
import { api, type CompanionView, type TiersChange, type TiersView } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

export const shell: ShellHandlers = {};

let tiers: TiersView | undefined;
let reading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function show(next: TiersView) {
	tiers = next;
	for (const listener of listeners) listener();
}

/** Read the models again; one read at a time. A failed read leaves what was shown. */
export function readTiers(): Promise<void> {
	reading ??= api<TiersView>("/tiers")
		.then(show, () => {})
		.finally(() => {
			reading = undefined;
		});
	return reading;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	// read again whenever something shows them after nothing did: the keys may have changed since
	if (listeners.size === 1) void readTiers();
	return () => listeners.delete(listener);
}

/** The models the tiers run on, once read. */
export function useTiers(): TiersView | undefined {
	return useSyncExternalStore(subscribe, () => tiers);
}

/** The tier new chats start on; the companion as it is after, or rejects with why not. */
export const setDefaultTier = (tier: Tier) =>
	api<CompanionView>("/companion", { method: "PUT", body: JSON.stringify({ tier }) });

/** Change the provider, or one tier's model; rejects with why not. */
export async function changeModels(change: TiersChange): Promise<void> {
	show(await api<TiersView>("/tiers", { method: "PUT", body: JSON.stringify(change) }));
}

/** One account of a provider: its first is the provider's own id, another `<provider>@<account>`. */
export type ProviderAccountView = {
	readonly id: string;
	/** The owner's name for it; the provider's name for its first, until the owner names that one. */
	readonly label: string;
	readonly connected: boolean;
	/** Connected by a credential from around the daemon, not one connected here: unverified, and not ours to forget. */
	readonly ambient?: boolean;
	/** What that credential came from ("ANTHROPIC_API_KEY"), as pi-ai names it. */
	readonly source?: string;
	readonly connecting: boolean;
	/** While a sign-in takes a pasted code or address: what the provider asks. */
	readonly question?: string;
	/** The provider's ways to sign in, and the one the attempt under way takes. */
	readonly methods?: readonly { readonly id: string; readonly label: string }[];
	readonly method?: string;
	readonly error?: string;
};

/** A provider (`GET /api/providers`): how it connects, and its accounts, its first always listed. */
export type ProviderView = {
	readonly id: string;
	readonly name: string;
	readonly apiKey: boolean;
	readonly oauth: boolean;
	readonly accounts: readonly ProviderAccountView[];
};

/** The account `id` and the provider it belongs to. */
export function accountIn(providers: readonly ProviderView[], id: string | undefined) {
	for (const provider of providers)
		for (const account of provider.accounts) if (account.id === id) return { provider, account };
	return undefined;
}

export const readProviders = () => api<ProviderView[]>("/providers");

/** Connect with a key, or start a sign-in (`method` one of the provider's ways); a sign-in replaces one under way. */
export const connectProvider = (id: string, type: "oauth" | "api_key", key?: string, method?: string) =>
	api<{ url?: string }>(`/providers/${encodeURIComponent(id)}`, {
		method: "POST",
		body: JSON.stringify({ type, ...(key === undefined ? {} : { key }), ...(method === undefined ? {} : { method }) }),
	});

/** Add another account to `provider`, named `label`: with a key, or a sign-in whose link comes back. */
export const addProviderAccount = (provider: string, label: string, type: "oauth" | "api_key", key?: string) =>
	api<{ id: string; url?: string }>(`/providers/${encodeURIComponent(provider)}/accounts`, {
		method: "POST",
		body: JSON.stringify({ label, type, ...(key === undefined ? {} : { key }) }),
	});

/** Name a provider account in the owner's words; unique among its provider's accounts. */
export const renameProviderAccount = (id: string, label: string) =>
	api<Record<string, never>>(`/providers/${encodeURIComponent(id)}/label`, {
		method: "PUT",
		body: JSON.stringify({ label }),
	});

/** End a sign-in under way; its link no longer finishes anything. */
export const cancelSignIn = (id: string) =>
	api<Record<string, never>>(`/providers/${encodeURIComponent(id)}/sign-in`, { method: "DELETE" });

/** Finish a sign-in with the code or the address the provider's page showed. */
export const answerSignIn = (id: string, value: string) =>
	api<Record<string, never>>(`/providers/${encodeURIComponent(id)}/answer`, {
		method: "POST",
		body: JSON.stringify({ value }),
	});

/** pi-ai's words for a provider's ways to sign in, as the app says them. */
const WAYS: Readonly<Record<string, string>> = { browser: "Sign in in the browser", copy_code: "Sign in with a code" };
export const wayLabel = (way: { readonly id: string; readonly label: string }) => WAYS[way.id] ?? way.label;

/**
 * Sign out of a provider account (an added one is forgotten with it); the daemon moves the band to another still
 * connected if it thought with this one.
 */
export const disconnectProvider = (id: string) =>
	api<Record<string, never>>(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * Connecting providers, for first run and Settings alike: the providers as the daemon sees them (read again every two
 * seconds while shown, so a sign-in finished in another tab shows); `pick` opens a provider's sign-in in a tab of its
 * own (opened from the tap, so it is not blocked; picked again, or another `method`, it replaces the one under way) or
 * toggles its key form; `answer` finishes a sign-in with a pasted code; `cancel` ends one; `key` connects with a key;
 * `use` thinks with a connected one; `signOut` forgets one; `rename` names one; `add` adds another account to a provider, named by the
 * owner, with a key or a sign-in. Each takes an account's id. A connected account becomes the band's.
 */
export function useProviderConnect() {
	const [providers, setProviders] = useState<readonly ProviderView[]>([]);
	const [open, setOpen] = useState<string | undefined>(undefined);
	const [waiting, setWaiting] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const pending = useRef<string | undefined>(undefined);
	// reads are numbered: one that left before a sign-in started says nothing about how that sign-in ended
	const reads = useRef(0);
	const started = useRef(0);
	const refresh = useCallback(() => {
		const read = ++reads.current;
		return readProviders()
			.then(async (next) => {
				setProviders(next);
				if (read <= started.current) return;
				const found = accountIn(next, pending.current);
				if (found === undefined) return;
				const picked = found.account;
				if (picked.error !== undefined) {
					pending.current = undefined;
					setWaiting(undefined);
					setError(`${found.provider.name} didn't finish: ${picked.error}. Try again.`);
				} else if (picked.connected && !picked.connecting) {
					pending.current = undefined;
					setWaiting(undefined);
					await changeModels({ provider: picked.id }).catch(() => {});
					await readTiers();
				} else if (!picked.connecting) {
					// ended without failing: cancelled, from here or another tab, or the daemon restarted
					pending.current = undefined;
					setWaiting(undefined);
				}
			})
			.catch(() => {});
	}, []);
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 2000);
		return () => clearInterval(timer);
	}, [refresh]);
	const failed = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
	const use = async (id: string) => {
		setError(undefined);
		await changeModels({ provider: id }).catch(failed);
		await readTiers();
	};
	/** A sign-in's tab, opened from the tap so it is not blocked; undefined, said why, when the browser blocked it. */
	const signInTab = () => {
		const tab = window.open("about:blank", "_blank");
		if (tab === null) {
			setError("Your browser blocked the sign-in tab. Allow pop-ups for banda, then pick again.");
			return undefined;
		}
		tab.opener = null;
		return tab;
	};
	const pick = async (id: string, method?: string) => {
		const found = accountIn(providers, id);
		if (found === undefined) return;
		const { provider, account } = found;
		setError(undefined);
		// an ambient credential is already usable, so Use still works; Connect means connect over it, and must not
		// fall through to using the very credential the owner is trying to replace
		if (account.connected && account.ambient !== true) return use(id);
		if (!provider.oauth) {
			setOpen((was) => (was === id ? undefined : id));
			return;
		}
		const tab = signInTab();
		if (tab === undefined) return;
		setWaiting(id);
		try {
			const link = await connectProvider(id, "oauth", undefined, method);
			if (link.url === undefined) throw new Error(`${provider.name} sent no sign-in link. Try again.`);
			pending.current = id;
			started.current = reads.current;
			tab.location.replace(link.url);
			await refresh();
		} catch (reason) {
			tab.close();
			setWaiting(undefined);
			failed(reason);
		}
	};
	const answer = async (id: string, value: string) => {
		setError(undefined);
		await answerSignIn(id, value).catch(failed);
		await refresh();
	};
	const cancel = async (id: string) => {
		setError(undefined);
		if (pending.current === id) pending.current = undefined;
		setWaiting((was) => (was === id ? undefined : was));
		await cancelSignIn(id).catch(failed);
		await refresh();
	};
	const key = async (id: string, value: string) => {
		setError(undefined);
		setWaiting(id);
		try {
			await connectProvider(id, "api_key", value);
			await changeModels({ provider: id });
			setOpen(undefined);
			await readTiers();
			await refresh();
		} catch (reason) {
			failed(reason);
		} finally {
			setWaiting(undefined);
		}
	};
	const signOut = async (id: string) => {
		setError(undefined);
		await disconnectProvider(id).catch(failed);
		await readTiers();
		await refresh();
	};
	const rename = async (id: string, label: string) => {
		setError(undefined);
		await renameProviderAccount(id, label).catch(failed);
		await readTiers();
		await refresh();
	};
	const add = async (provider: string, label: string, value?: string) => {
		const found = providers.find((each) => each.id === provider);
		if (found === undefined) return;
		setError(undefined);
		if (value !== undefined) {
			setWaiting(provider);
			try {
				const { id } = await addProviderAccount(provider, label, "api_key", value);
				await changeModels({ provider: id });
				await readTiers();
				await refresh();
			} catch (reason) {
				failed(reason);
				await refresh();
			} finally {
				setWaiting(undefined);
			}
			return;
		}
		const tab = signInTab();
		if (tab === undefined) return;
		setWaiting(provider);
		try {
			const link = await addProviderAccount(provider, label, "oauth");
			if (link.url === undefined) throw new Error(`${found.name} sent no sign-in link. Try again.`);
			pending.current = link.id;
			started.current = reads.current;
			setWaiting(link.id);
			tab.location.replace(link.url);
			await refresh();
		} catch (reason) {
			tab.close();
			setWaiting(undefined);
			failed(reason);
		}
	};
	return { providers, open, waiting, error, pick, answer, cancel, key, use, signOut, add, rename };
}

/** Put a chat on `tier`, from its next run on; rejects with why not. */
export const setChatTier = (chat: number, tier: Tier) =>
	api<{ tier: Tier }>(`/chats/${chat}/tier`, { method: "POST", body: JSON.stringify({ tier }) });
