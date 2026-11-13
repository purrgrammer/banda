/**
 * Adding a provider in the app: any of pi-ai's (`/api/providers`), or a server of the owner's (`/api/custom-providers`).
 * Read when Settings' Model tab shows and after each change. Every request a provider or a server receives is the
 * owner's doing: connecting it, asking a server for its list of models, a check; saving reaches neither, and nothing is
 * used until the owner picks Use.
 */
import { useCallback, useEffect, useState } from "react";
import type { CustomProvider, ServerKind } from "../../../src/core/custom-providers.ts";
import { knowServerKinds } from "../chat/ProviderMark.tsx";
import { api, type Checked, type CustomProvidersView, type ListingView, type ModelsListView } from "../lib/api.ts";
import { changeModels, connectProvider, type ProviderView, readProviders, readTiers } from "./tiers.ts";

export type { Checked, CustomProvidersView, ListingView, ModelsListView };
export type CustomProviderView = CustomProvidersView["providers"][number];

/** What the server form sends: the definition, a key when one was typed, and, for a new one, the model it starts on. */
export type CustomProviderSave = {
	readonly provider: Omit<CustomProvider, "id">;
	readonly key?: string;
	readonly start?: string;
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** The owner's servers; each read also tells their marks which kind each server is. */
export const readCustomProviders = async () => {
	const view = await api<CustomProvidersView>("/custom-providers");
	knowServerKinds(view.providers);
	return view;
};
export const addCustomProvider = (save: CustomProviderSave) =>
	api<{ id: string }>("/custom-providers", json("POST", save));
export const editCustomProvider = (id: string, save: CustomProviderSave) =>
	api<Record<string, never>>(`/custom-providers/${encodeURIComponent(id)}`, json("PUT", save));
export const removeCustomProvider = (id: string) =>
	api<Record<string, never>>(`/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
export const checkCustomProvider = (id: string, model?: string) =>
	api<Checked>(`/custom-providers/${encodeURIComponent(id)}/check`, json("POST", model === undefined ? {} : { model }));
/** Ask a server which models it has: `id` lists with the key kept for it, when the form gives none. */
export const listServerModels = (
	provider: { readonly kind: ServerKind; readonly baseUrl: string; readonly key: "none" | "required" },
	key?: string,
	id?: string,
) =>
	api<ListingView>(
		"/custom-providers/list",
		json("POST", { provider, ...(key === undefined ? {} : { key }), ...(id === undefined ? {} : { id }) }),
	);
export const readCatalog = (provider: string) =>
	api<ModelsListView>(`/providers/${encodeURIComponent(provider)}/models`);
export const refreshCatalog = (provider: string) =>
	api<ModelsListView>(`/providers/${encodeURIComponent(provider)}/refresh`, { method: "POST" });
/** Start a provider without a preset on one model, for all three tiers; it is not used until `use`. */
export const startProvider = (provider: string, model: string) => changeModels({ start: { provider, model } });

/** How a built-in provider is connected from the dialog: a key, a cloud's form, or a sign-in in a tab of its own. */
export type Connecting =
	| {
			readonly type: "api_key";
			readonly key?: string;
			readonly method?: string;
			readonly fields?: Record<string, string>;
	  }
	| { readonly type: "oauth"; readonly method?: string };

/** Connect a built-in provider without using it: the owner picks Use after. A sign-in's link comes back. */
export const connectOnly = (provider: string, how: Connecting) =>
	api<{ url?: string }>(`/providers/${encodeURIComponent(provider)}`, json("POST", { ...how, use: false }));

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Servers changed outside the list (the Add a provider dialog saved one, or the band moved): it reads them again. */
const changes = new EventTarget();
export const serversChanged = () => changes.dispatchEvent(new Event("changed"));

/**
 * The servers, read again whenever the provider the band thinks with (`current`) changes; each action says why it was
 * refused, or nothing, and reads them and the tiers again after.
 */
export function useCustomProviders(current: string) {
	const [view, setView] = useState<CustomProvidersView | undefined>(undefined);
	const [providers, setProviders] = useState<readonly ProviderView[]>([]);
	const [checking, setChecking] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const reload = useCallback(
		() =>
			Promise.all([
				readCustomProviders().then(
					(next) => setView(next),
					() => {},
				),
				readProviders().then(
					(next) => setProviders(next),
					() => {},
				),
			]),
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again when the provider in use changes
	useEffect(() => {
		void reload();
	}, [reload, current]);
	useEffect(() => {
		const again = () => void reload();
		changes.addEventListener("changed", again);
		return () => changes.removeEventListener("changed", again);
	}, [reload]);
	const after = async () => {
		await Promise.all([reload(), readTiers()]);
	};
	/** Run `act`; undefined when it went through, else why not. */
	const attempt = async (act: () => Promise<unknown>): Promise<string | undefined> => {
		try {
			await act();
			await after();
			return undefined;
		} catch (thrown) {
			await reload();
			return reason(thrown);
		}
	};
	return {
		view,
		providers,
		checking,
		error,
		reload,
		add: async (save: CustomProviderSave) => {
			const { id } = await addCustomProvider(save);
			await after();
			return id;
		},
		edit: (id: string, save: CustomProviderSave) => attempt(() => editCustomProvider(id, save)),
		remove: (id: string) => attempt(() => removeCustomProvider(id)),
		use: async (id: string) => {
			const why = await attempt(() => changeModels({ provider: id }));
			setError(why);
			return why;
		},
		check: async (id: string) => {
			setError(undefined);
			setChecking(id);
			const why = await attempt(() => checkCustomProvider(id));
			setChecking(undefined);
			setError(why);
		},
		start: async (provider: string, model: string) => {
			await startProvider(provider, model);
			await after();
		},
		connect: connectProvider,
	};
}
