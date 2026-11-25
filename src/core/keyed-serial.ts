/**
 * Lines of work, one per key: a piece runs once every earlier piece of its key ended, whatever that answered, and a
 * key whose last piece ended holds nothing. `ended` says when a piece's effects are done, where that is after its
 * answer (a signer call whose child still writes), so the next piece waits on that instead.
 */
export function keyedSerial(): <T>(
	key: string,
	work: () => Promise<T>,
	ended?: (answer: T) => Promise<unknown>,
) => Promise<T> {
	const tails = new Map<string, Promise<unknown>>();
	return (key, work, ended) => {
		const run = (tails.get(key) ?? Promise.resolve()).then(work);
		const tail = run.then(ended ?? (() => undefined)).then(
			() => {},
			() => {},
		);
		tails.set(key, tail);
		void tail.then(() => {
			if (tails.get(key) === tail) tails.delete(key);
		});
		return run;
	};
}
