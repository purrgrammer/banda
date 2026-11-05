/**
 * Model tiers in the app: the tier new chats start on, the models the tiers run on (read when a page that shows them
 * opens, and after each change), a chat's own tier, and warming a chat's prompt cache as the owner starts to write.
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

export type ProviderView = {
	readonly id: string;
	readonly name: string;
	readonly apiKey: boolean;
	readonly oauth: boolean;
	readonly connected: boolean;
	readonly connecting: boolean;
	readonly error?: string;
};

export const readProviders = () => api<ProviderView[]>("/providers");

export const connectProvider = (id: string, type: "oauth" | "api_key", key?: string) =>
	api<{ url?: string }>(`/providers/${encodeURIComponent(id)}`, {
		method: "POST",
		body: JSON.stringify({ type, ...(key === undefined ? {} : { key }) }),
	});

/** Sign out of a provider; the daemon moves the band to another still connected if it thought with this one. */
export const disconnectProvider = (id: string) =>
	api<Record<string, never>>(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" });

/**
 * Connecting providers, for first run and Settings alike: the providers as the daemon sees them (read again every two
 * seconds while shown, so a sign-in finished in another tab shows); `pick` opens a provider's sign-in in a tab of its
 * own (opened from the tap, so it is not blocked) or toggles its key form; `key` connects with a key; `use` thinks
 * with a connected one; `signOut` forgets one. A connected provider becomes the band's.
 */
export function useProviderConnect() {
	const [providers, setProviders] = useState<readonly ProviderView[]>([]);
	const [open, setOpen] = useState<string | undefined>(undefined);
	const [waiting, setWaiting] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const pending = useRef<string | undefined>(undefined);
	const refresh = useCallback(
		() =>
			readProviders()
				.then(async (next) => {
					setProviders(next);
					const id = pending.current;
					const picked = next.find((provider) => provider.id === id);
					if (picked?.error !== undefined) {
						pending.current = undefined;
						setWaiting(undefined);
						setError(`${picked.name} didn't finish: ${picked.error}. Try again.`);
					} else if (picked?.connected === true && !picked.connecting) {
						pending.current = undefined;
						setWaiting(undefined);
						await changeModels({ provider: picked.id }).catch(() => {});
						await readTiers();
					}
				})
				.catch(() => {}),
		[],
	);
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
	const pick = async (id: string) => {
		const provider = providers.find((each) => each.id === id);
		if (provider === undefined) return;
		setError(undefined);
		if (provider.connected) return use(id);
		if (!provider.oauth) {
			setOpen((was) => (was === id ? undefined : id));
			return;
		}
		const tab = window.open("about:blank", "_blank");
		if (tab === null) {
			setError("Your browser blocked the sign-in tab. Allow pop-ups for banda, then pick again.");
			return;
		}
		tab.opener = null;
		setWaiting(id);
		try {
			const started = await connectProvider(id, "oauth");
			if (started.url === undefined) throw new Error(`${provider.name} sent no sign-in link. Try again.`);
			pending.current = id;
			tab.location.replace(started.url);
		} catch (reason) {
			tab.close();
			setWaiting(undefined);
			failed(reason);
		}
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
	return { providers, open, waiting, error, pick, key, use, signOut };
}

/** Put a chat on `tier`, from its next run on; rejects with why not. */
export const setChatTier = (chat: number, tier: Tier) =>
	api<{ tier: Tier }>(`/chats/${chat}/tier`, { method: "POST", body: JSON.stringify({ tier }) });

/**
 * The owner is about to write in `chat`: the daemon warms its prompt cache if it went cold, so the reply comes sooner.
 * Best effort: whatever happens, nothing changes but the wait.
 */
export function warmChat(chat: number): void {
	void api(`/chats/${chat}/warm`, { method: "POST" }).catch(() => {});
}
