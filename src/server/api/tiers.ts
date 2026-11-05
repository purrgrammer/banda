/** The API's shapes for model tiers: Quick, Balanced and Deep, the companion's and each chat's, and stepping up for a task. Re-exported by `../api.ts`. */
import type { Tier } from "../../core/tiers.ts";

export type { Tier };

/** A model as the owner reads it: its catalog name, and pi-ai's id behind details. */
export type ModelView = { readonly id: string; readonly name: string };

/**
 * The models the tiers run on (`GET /api/tiers`), never a model string on its own: the provider in plain words, and
 * whether it runs on this computer; per tier the model in effect, `own` when the owner chose it over the preset. A
 * provider without presets (`presets: false`) runs one model, the configured one, on every tier. `providers` are those
 * with credentials, which the owner may pick; `catalog` the provider's models, which one tier may run instead.
 * `PUT /api/tiers` changes them (`TiersChange`), answered with the view as it is after.
 */
export type TiersView = {
	readonly provider: { readonly id: string; readonly name: string; readonly local: boolean };
	readonly presets: boolean;
	readonly models: { readonly [T in Tier]: ModelView & { readonly own?: true } };
	readonly providers: readonly { readonly id: string; readonly name: string }[];
	readonly catalog: readonly ModelView[];
};

/**
 * What the owner changes of the models: the provider the tiers run on (one with credentials and presets, or the
 * configured model's), and one tier's own model (`modelId: null` back to the preset), of the provider in effect after.
 */
export type TiersChange = {
	readonly provider?: string;
	readonly override?: { readonly tier: Tier; readonly modelId: string | null };
};
