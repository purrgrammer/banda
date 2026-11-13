/**
 * Model tiers (DESIGN.md "The companion"): Quick, Balanced and Deep, the three the owner sees, never a model string. Each
 * provider banda has a preset for maps them to models of pi-ai's built-in catalog (`test/tiers.test.ts` fails when an
 * id leaves it); a provider without one runs the configured model on every tier. Plain data, shared with the web.
 */
import { backendOf } from "./provider-accounts.ts";

export const TIERS = ["quick", "balanced", "deep"] as const;
export type Tier = (typeof TIERS)[number];

/** The tier new chats start on until the owner picks another: speed first. */
export const DEFAULT_TIER: Tier = "quick";

export const isTier = (value: unknown): value is Tier => TIERS.includes(value as Tier);

/** Each tier in the owner's words. */
export const TIER_WORDS: { readonly [T in Tier]: { readonly name: string; readonly about: string } } = {
	quick: { name: "Quick", about: "Answers fast and costs least. Right for most things." },
	balanced: { name: "Balanced", about: "Thinks a little longer, for work with a few steps." },
	deep: { name: "Deep", about: "Takes longer and costs more, for hard problems." },
};

/** A model as the store names it. */
export type ModelId = { readonly provider: string; readonly modelId: string };

/** A provider's models by tier, by pi-ai's ids. */
export type Preset = { readonly provider: string; readonly models: { readonly [T in Tier]: string } };

const by = (provider: string, quick: string, balanced: string, deep: string): Preset => ({
	provider,
	models: { quick, balanced, deep },
});

/**
 * The presets, read from pi-ai's built-in catalog: Quick the cheapest capable model, Balanced the mid one, Deep the
 * most capable at a sane price. A provider with one family shares a model between two tiers. In this order a provider
 * is offered.
 */
export const PRESETS: readonly Preset[] = [
	by("anthropic", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"),
	by("openai", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"),
	by("openai-codex", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"),
	by("azure", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"),
	by("google", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-pro-preview"),
	by("google-vertex", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-pro-preview"),
	by(
		"amazon-bedrock",
		"global.anthropic.claude-haiku-5-5",
		"global.anthropic.claude-sonnet-5-5",
		"global.anthropic.claude-opus-5-5",
	),
	by("github-copilot", "claude-haiku-5.5", "claude-sonnet-5.5", "claude-opus-5.5"),
	by("openrouter", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"),
	by("xai", "grok-4.3", "grok-4.7", "grok-4.7"),
	by("mistral", "mistral-small-2603", "mistral-medium-2604", "mistral-large-4"),
	by("deepseek", "deepseek-flash", "deepseek-flash", "deepseek-v4-pro"),
	by("groq", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"),
	by("cerebras", "gpt-oss-120b", "gpt-oss-120b", "qwen-3.8-27b"),
	by("meta", "muse-spark-1.3", "muse-spark-1.3", "muse-wonder-1.0"),
];

/** The preset of `provider`'s backend: an account (`anthropic@work`) runs its backend's. */
export const presetOf = (provider: string): Preset | undefined =>
	PRESETS.find((preset) => preset.provider === backendOf(provider));

/** What the owner chose of the models: a provider account, and a model of its own for a tier, by account. */
export type ModelChoice = {
	readonly provider?: string;
	readonly overrides?: { readonly [provider: string]: { readonly [T in Tier]?: string } };
};

/** The provider the tiers run on: the one chosen, else the configured model's. */
export const providerOf = (choice: ModelChoice, fallback: ModelId): string => choice.provider ?? fallback.provider;

/**
 * The model `tier` runs on: the provider's preset, or the owner's model for the tier over it. A provider without a
 * preset (most of pi-ai's, and every server of the owner's) runs the model the owner started it on for each tier, the
 * same one on all three until they refine it; the configured model (`fallback`) runs only on its own provider. A tier
 * with none of those names no model (`modelId` empty), so a run on it fails saying so rather than thinking with
 * another provider's model.
 */
export function modelFor(tier: Tier, choice: ModelChoice, fallback: ModelId): ModelId {
	const provider = providerOf(choice, fallback);
	const own = choice.overrides?.[provider]?.[tier];
	const preset = presetOf(provider);
	if (preset !== undefined) return { provider, modelId: own ?? preset.models[tier] };
	if (own !== undefined) return { provider, modelId: own };
	if (provider === fallback.provider) return { provider: fallback.provider, modelId: fallback.modelId };
	return { provider, modelId: "" };
}
