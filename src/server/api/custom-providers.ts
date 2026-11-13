/** Custom providers' shapes (`../routes/custom-providers.ts`): `GET /api/custom-providers` and a check's outcome. */
import type { CheckFailure, CustomCompat, CustomModel, Destination, ServerKind } from "../../core/custom-providers.ts";
import type { Listed } from "../../core/model-listing.ts";
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
		readonly kind: ServerKind;
		readonly baseUrl: string;
		/** Whether it charges per token, as the owner said. */
		readonly billing: "none" | "rates";
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

/**
 * A provider's models with what is known of each (`GET /api/providers/:id/models`): pi-ai's catalog for a built-in one
 * (`catalog`, or `refreshed` from the provider's own list), so a fact here is the catalog's word, not the account's.
 */
export type ModelsListView = {
	readonly source: "catalog" | "refreshed";
	readonly at?: number;
	readonly models: readonly {
		readonly id: string;
		readonly name: string;
		readonly contextWindow: number;
		readonly maxTokens: number;
		readonly images: boolean;
		readonly reasoning: boolean;
		readonly cost: { readonly input: number; readonly output: number };
	}[];
};

/** A model of pi-ai's catalog with the same id as one a server listed: its limits, as pi-ai has them, never a price. */
export type CatalogMatch = {
	/** `provider/id` in pi-ai's catalog. */
	readonly ref: string;
	/** The catalog provider's name. */
	readonly provider: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly images: boolean;
	readonly reasoning: boolean;
};

/** `POST /api/custom-providers/list`: what the server listed, with any catalog match; or why it did not. */
export type ListingView =
	| {
			readonly ok: true;
			/** The routes asked, as `GET /models`. */
			readonly routes: readonly string[];
			readonly models: readonly (Listed & { readonly catalog?: CatalogMatch })[];
	  }
	| { readonly ok: false; readonly failure: CheckFailure; readonly status?: number; readonly detail: string };
