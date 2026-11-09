/**
 * What a chat's events ask for, done one at a time in the order they came. A step that throws ends only itself. A fill
 * (the page that catches a transcript up) is retried in place until it is done or the chat is left: entries held behind
 * it land on a whole transcript, since a later catch-up starts from the newest entry and would never see a hole beneath it.
 */
const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000];

const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

export function orderedWork(
	signal: AbortSignal,
	wait: (tries: number) => Promise<void> = (tries) =>
		pause(RETRY_MS[Math.min(tries, RETRY_MS.length - 1)] as number, signal),
) {
	let tail: Promise<unknown> = Promise.resolve();
	const step = (work: () => unknown) => {
		tail = tail.then(work).catch(() => undefined);
	};
	return {
		step,
		fill(work: () => Promise<unknown>) {
			step(async () => {
				for (let tries = 0; !signal.aborted; tries++) {
					try {
						await work();
						return;
					} catch {
						await wait(tries);
					}
				}
			});
		},
		/** Settles once everything asked so far is done. */
		settled: () => tail,
	};
}
