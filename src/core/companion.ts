/**
 * The companion (DESIGN.md "The companion", "State"): the owner's picks that nothing derives, so a bookkeeping doc: its
 * name and how hard it thinks: the tier new chats start on and the models the tiers
 * run on (a provider, and the owner's own model for a tier). Its personality is not here: it is the lead's agent
 * file's to say. The name reaches the model as the first line of the lead's instructions, set when a chat starts and
 * never after, so a rename never changes a running chat's prompt prefix.
 */
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { DEFAULT_NAME } from "./choices.ts";
import { context } from "./store.ts";
import type { Tier } from "./tiers.ts";

export type CompanionDoc = {
	name?: string;
	/** The tier new chats start on; Quick when unset. */
	tier?: Tier;
	/** The provider the tiers run on; the configured model's when unset. */
	provider?: string;
	/** The owner's own model for a tier, by provider, over the preset. */
	overrides?: { [provider: string]: { [T in Tier]?: string } };
	/** The owner chose from the skills banda ships, or skipped them, at first run: they are not offered again. */
	skillsChosen?: true;
};

export const Companion = defineDoc<CompanionDoc>({
	kind: "banda.companion",
	version: 1,
	scope: "session",
	initial: () => ({}),
	// a few small fields, rarely changed: each change a base
	checkpointWhen: () => true,
});

/** The companion's name, or undefined while the owner has not given one. */
export async function nameOf(tx: Tx): Promise<string | undefined> {
	return (await tx.doc(Companion)).name ?? DEFAULT_NAME;
}

/** The lead's name in its instructions. Avatar geometry is presentation data, never prompt content. */
export const nameLine = (name: string) => `Your name is ${name}. The owner calls you that.`;

/** Set what `picks` gives of the companion, in one commit; the rest stays. The values are the caller's to check. */
export async function setCompanion(
	harness: Harness,
	picks: Readonly<Pick<CompanionDoc, "name" | "tier">>,
	ctx: Context = context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = await tx.doc(Companion);
		if (picks.name !== undefined) doc.name = picks.name;
		if (picks.tier !== undefined) doc.tier = picks.tier;
	}, ctx);
}

/**
 * Run the tiers on `provider`, and set or clear (`null`) the owner's own model for a tier of a provider, in one commit.
 * The caller refreshes existing tier-backed chats in the same commit. The values are the caller's to check.
 */
export async function setModels(
	tx: Tx,
	{
		provider,
		override,
	}: {
		provider?: string;
		override?: { readonly provider: string; readonly tier: Tier; readonly modelId: string | null };
	},
): Promise<void> {
	const doc = await tx.doc(Companion);
	if (provider !== undefined) doc.provider = provider;
	if (override === undefined) return;
	doc.overrides ??= {};
	const own = { ...doc.overrides[override.provider] };
	if (override.modelId === null) delete own[override.tier];
	else own[override.tier] = override.modelId;
	if (Object.keys(own).length === 0) delete doc.overrides[override.provider];
	else doc.overrides[override.provider] = own;
}
