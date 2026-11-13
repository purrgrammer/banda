/** Custom providers' shapes (`../routes/custom-providers.ts`): `GET /api/custom-providers` and a check's outcome. */
import type { CheckFailure, CustomCompat, CustomModel, Destination } from "../../core/custom-providers.ts";
import type { Tier } from "../../core/tiers.ts";

/** A check's outcome, kept in memory until the daemon stops or the provider changes. */
export type Checked =
	| { readonly ok: true; readonly at: number; readonly model: string; readonly ms: number; readonly reply: string }
	| {
			readonly ok: false;
			readonly at: number;
			readonly model: string;
			/** Why, from the request itself: the app says it in plain words. */
			readonly failure: CheckFailure;
			/** The HTTP status, when it answered with one. */
			readonly status?: number;
			/** What it or the network said, redacted: details, for whoever wants them. */
			readonly detail: string;
	  };

/** `GET /api/custom-providers`. */
export type CustomProvidersView = {
	readonly providers: readonly {
		readonly id: string;
		readonly name: string;
		readonly baseUrl: string;
		readonly destination: Destination;
		/** `stored`: a key is kept for it; `missing`: it takes one and none is; `none`: it takes none. */
		readonly key: "stored" | "missing" | "none";
		readonly models: readonly CustomModel[];
		readonly compat?: CustomCompat;
		/** The model each tier runs on it, as the owner chose. */
		readonly tiers: { readonly [T in Tier]?: string };
		/** The band thinks with it now. */
		readonly using: boolean;
		readonly checked?: Checked;
	}[];
	/** Why `custom-providers.json` could not be read: none of its providers are registered meanwhile. */
	readonly error?: string;
};
