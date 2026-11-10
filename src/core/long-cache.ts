/**
 * The provider's longer prompt cache by default. pi-ai asks for the short one unless told otherwise, and an owner's
 * pauses often outlast five minutes, which rewrites the whole conversation, so the daemon asks for the long one on the
 * stream it owns between every provider and everything that calls one: runs, inferences and account clones alike.
 * A caller that names a retention keeps it, as compaction does with "none". A provider without a longer cache ignores it.
 */
import type { MutableModels, Provider } from "@earendil-works/pi-ai";

/** Ask every provider for its long cache unless the caller said otherwise, in place. */
export function cacheLong(models: MutableModels): MutableModels {
	for (const provider of models.getProviders()) models.setProvider(long(provider));
	return models;
}

function long(provider: Provider): Provider {
	return new Proxy(provider, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if ((key !== "stream" && key !== "streamSimple") || typeof value !== "function") return value;
			return (model: unknown, context: unknown, options?: { cacheRetention?: unknown }, ...rest: unknown[]) =>
				value.call(
					target,
					model,
					context,
					options?.cacheRetention === undefined ? { ...options, cacheRetention: "long" } : options,
					...rest,
				);
		},
	});
}
