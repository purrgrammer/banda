/**
 * An account's pi-ai provider (`./provider-accounts.ts`): its backend's provider under the account's id. It thinks only
 * with the credential stored under that id: an ambient one (ANTHROPIC_API_KEY and its kind) is the backend's, so its
 * api-key auth resolves nothing without a stored credential. Every message it streams names the account as its
 * provider, whatever its backend's API writes there, so the usage ledger (keyed `provider/model`) counts it apart.
 */
import {
	type ApiKeyAuth,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type MutableModels,
	type Provider,
	type ProviderAuth,
} from "@earendil-works/pi-ai";
import { backendOf, isClone, parseAccount } from "./provider-accounts.ts";

/** `auth` that resolves only a stored credential: no ambient fallback. */
function storedOnly(auth: ProviderAuth): ProviderAuth {
	const apiKey = auth.apiKey;
	if (apiKey === undefined) return auth;
	const own = new Proxy(apiKey, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if ((key !== "resolve" && key !== "check") || typeof value !== "function") return value;
			return (input: Parameters<ApiKeyAuth["resolve"]>[0]) =>
				input.credential === undefined ? Promise.resolve(undefined) : value.call(target, input);
		},
	});
	return { ...auth, apiKey: own };
}

/** `base` under the account id `id`: its models named as the account's, its auth only the account's own. */
export function accountProvider(base: Provider, id: string): Provider {
	const { provider, account } = parseAccount(id);
	if (account === undefined || provider !== base.id) throw new Error(`${id} is not an account of ${base.id}`);
	const auth = storedOnly(base.auth);
	const own = <T extends { readonly provider: string }>(models: readonly T[]): T[] =>
		models.map((model) => ({ ...model, provider: id }));
	return new Proxy(base, {
		get(target, key, receiver) {
			if (key === "id") return id;
			if (key === "auth") return auth;
			if (key === "getModels") return () => own(target.getModels());
			if (key === "getAllModels") {
				const all = target.getAllModels;
				return all === undefined ? undefined : () => own(all.call(target));
			}
			const value = Reflect.get(target, key, receiver);
			if ((key !== "stream" && key !== "streamSimple" && key !== "fetchDeferred") || typeof value !== "function")
				return value;
			return (...args: unknown[]) => named(id, value.apply(target, args) as AssistantMessageEventStream);
		},
	});
}

/** `inner` with every message it carries naming `provider`. */
function named(provider: string, inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of inner) outer.push(renamed(event, provider));
		} finally {
			outer.end();
		}
	})();
	return outer;
}

function renamed(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: { ...event.message, provider } };
	if (event.type === "error") return { ...event, error: { ...event.error, provider } };
	return { ...event, partial: { ...event.partial, provider } };
}

/** Register the account `id` (a clone) beside its backend; false when its backend is not known here. */
export function registerAccount(models: MutableModels, id: string): boolean {
	const { provider, account } = parseAccount(id);
	if (account === undefined) return models.getProvider(id) !== undefined;
	const base = models.getProvider(provider);
	if (base === undefined) return false;
	if (models.getProvider(id) === undefined) models.setProvider(accountProvider(base, id));
	return true;
}

/** The accounts of `backend` registered in `models`, its plain id first when known. */
export const accountsOf = (models: Pick<MutableModels, "getProviders">, backend: string): string[] =>
	models
		.getProviders()
		.map((provider) => provider.id)
		.filter((id) => backendOf(id) === backend)
		.sort((a, b) => Number(isClone(a)) - Number(isClone(b)));
