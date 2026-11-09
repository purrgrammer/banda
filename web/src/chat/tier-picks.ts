/**
 * The owner's picks of a chat's tier, on their way to the store. A pick shows at once and fails back to the stored tier;
 * picks made while one is being saved collapse into the newest, sent when that one is answered, so the store ends on
 * the owner's last pick whatever order the answers would have come in.
 */
import type { Tier } from "../../../src/core/tiers.ts";

export type TierPicksView = {
	/** The tier to show instead of the stored one; none once a save failed. */
	readonly pick: Tier | undefined;
	readonly saving: boolean;
	/** What the store held when the last save was answered: the saved pick holds until the store says something else. */
	readonly over: Tier | undefined;
};

const NONE: TierPicksView = { pick: undefined, saving: false, over: undefined };

/** The tier the selector shows, given what the store holds now. */
export const shownTier = (view: TierPicksView, stored: Tier | undefined): Tier | undefined =>
	view.pick !== undefined && (view.saving || stored === view.over) ? view.pick : stored;

export function tierPicks({
	save,
	failed,
	stored,
}: {
	/** Rejects when the store did not take it. */
	readonly save: (tier: Tier) => Promise<unknown>;
	/** The last pick failed and was taken back; `retry` picks it again. */
	readonly failed: (error: unknown, retry: () => void) => void;
	/** What the store holds now. */
	readonly stored: () => Tier | undefined;
}) {
	let view = NONE;
	let sending: Tier | undefined;
	let newer: Tier | undefined;
	const listeners = new Set<() => void>();
	const show = (next: TierPicksView) => {
		view = next;
		for (const listener of listeners) listener();
	};

	async function send(first: Tier) {
		for (let tier = first; ; ) {
			sending = tier;
			let failure: { readonly error: unknown } | undefined;
			try {
				await save(tier);
			} catch (error) {
				failure = { error };
			}
			if (newer !== undefined) {
				// a failure here is moot: the owner has already asked for something else
				tier = newer;
				newer = undefined;
				continue;
			}
			sending = undefined;
			if (failure === undefined) {
				show({ pick: tier, saving: false, over: stored() });
				return;
			}
			show(NONE);
			const lost = tier;
			failed(failure.error, () => pick(lost));
			return;
		}
	}

	function pick(tier: Tier) {
		show({ pick: tier, saving: true, over: undefined });
		if (sending === undefined) void send(tier);
		else newer = tier === sending ? undefined : tier;
	}

	return {
		pick,
		view: () => view,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
