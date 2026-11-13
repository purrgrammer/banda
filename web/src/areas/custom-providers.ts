/**
 * Custom providers in the app (`src/server/routes/custom-providers.ts`): read when Settings' Model tab shows and after
 * each change; added, edited, removed and checked only when the owner says so. Saving never reaches the provider; a
 * check is the one request the app makes to it, and only from its own button.
 */
import { useCallback, useEffect, useState } from "react";
import type { CustomProvider } from "../../../src/core/custom-providers.ts";
import type { Tier } from "../../../src/core/tiers.ts";
import { api, type Checked, type CustomProvidersView } from "../lib/api.ts";
import { changeModels, readTiers } from "./tiers.ts";

export type { Checked, CustomProvidersView };
export type CustomProviderView = CustomProvidersView["providers"][number];

/** What the form sends: the definition, a key when one was typed, and the model of each tier. */
export type CustomProviderSave = {
	readonly provider: Omit<CustomProvider, "id">;
	readonly key?: string;
	readonly tiers: { readonly [T in Tier]: string };
};

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const readCustomProviders = () => api<CustomProvidersView>("/custom-providers");
export const addCustomProvider = (save: CustomProviderSave) =>
	api<{ id: string }>("/custom-providers", json("POST", save));
export const editCustomProvider = (id: string, save: CustomProviderSave) =>
	api<Record<string, never>>(`/custom-providers/${encodeURIComponent(id)}`, json("PUT", save));
export const removeCustomProvider = (id: string) =>
	api<Record<string, never>>(`/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" });
export const checkCustomProvider = (id: string, model?: string) =>
	api<Checked>(`/custom-providers/${encodeURIComponent(id)}/check`, json("POST", model === undefined ? {} : { model }));

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The custom providers, read again whenever the provider the band thinks with (`current`) changes; each action says
 * why it was refused, or nothing, and reads them and the tiers again after.
 */
export function useCustomProviders(current: string) {
	const [view, setView] = useState<CustomProvidersView | undefined>(undefined);
	const [checking, setChecking] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const reload = useCallback(
		() =>
			readCustomProviders().then(
				(next) => setView(next),
				() => {},
			),
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again when the provider in use changes
	useEffect(() => {
		void reload();
	}, [reload, current]);
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
		checking,
		error,
		add: (save: CustomProviderSave) => attempt(() => addCustomProvider(save)),
		edit: (id: string, save: CustomProviderSave) => attempt(() => editCustomProvider(id, save)),
		remove: (id: string) => attempt(() => removeCustomProvider(id)),
		use: async (id: string) => {
			setError(await attempt(() => changeModels({ provider: id })));
		},
		check: async (id: string) => {
			setError(undefined);
			setChecking(id);
			const why = await attempt(() => checkCustomProvider(id));
			setChecking(undefined);
			setError(why);
		},
	};
}
