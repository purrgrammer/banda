/**
 * How the daemon's config reaches the egress proxy (DESIGN.md "The box", Network): one push at a time, in order, each
 * reading the store when its turn comes, never a snapshot taken before a push still in flight; each with a generation
 * the proxy never goes back from. A push that fails stops the proxy (it sends nothing until it is up again with the
 * store's config): the proxy never runs on a config older than the store's. Only when the proxy can be neither told
 * nor stopped does a push throw.
 */

/** What a push needs of the proxy. */
export type ConfigTarget<C> = {
	/** Whether the proxy runs now: one that does not is told at its bring-up, so there is nothing to push. */
	running(): Promise<boolean>;
	/** What the store says now. */
	read(): Promise<C>;
	/** Send `config` with `generation`; the proxy refuses a generation lower than the one it holds. */
	send(config: C, generation: number): Promise<void>;
	/** Stop the proxy, so it sends nothing. */
	halt(): Promise<void>;
	/** What went wrong, for the daemon's log. */
	log?(line: string): void;
};

/** How a push ended: the proxy has the store's config, was not running, or was stopped because it could not be told. */
export type Pushed = "told" | "not running" | "stopped";

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A pusher: call it to have the proxy told what the store says now; it resolves once the proxy has it or was stopped. */
export function configPusher<C>(target: ConfigTarget<C>, now: () => number = Date.now): () => Promise<Pushed> {
	let generation = 0;
	let queue: Promise<unknown> = Promise.resolve();
	const push = async (): Promise<Pushed> => {
		// not knowing whether it runs is taken as running: then it is told, or stopped
		if (!(await target.running().catch(() => true))) return "not running";
		// a daemon started later counts on from a later moment, so its generations exceed a predecessor's
		generation = Math.max(generation + 1, now());
		try {
			await target.send(await target.read(), generation);
			return "told";
		} catch (error) {
			target.log?.(`egress: the proxy was not told (${words(error)}): stopping it`);
			try {
				await target.halt();
			} catch (stopping) {
				throw new Error(`the proxy could be neither told (${words(error)}) nor stopped (${words(stopping)})`);
			}
			return "stopped";
		}
	};
	return () => {
		const next = queue.then(push);
		queue = next.catch(() => undefined);
		return next;
	};
}
