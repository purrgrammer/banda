/**
 * One read of an object, shared by every line that names it. A watch's lines in the feed, its row in the panel and
 * the card it proposes all name the same few objects, each drawing it from the daemon's kept reading
 * (`POST /api/objects`): one request serves them all, kept while the watches stand as they did (`moved`: what the
 * watches have done, as `watchesMoved` says it). A followed object that changed moves them, and the next line that
 * asks reads it as it is now. Pure: the read itself is given (`readObject` in the app binds it to the daemon).
 */
import type { ObjectShown } from "../../../src/server/objects.ts";

/** Read object `reference` for `chat`, as `agent` where given: its card, or undefined when it cannot be read. */
export type ReadObject = (
	chat: number,
	reference: string,
	agent: string | undefined,
) => Promise<ObjectShown | undefined>;

/** The most reads kept: the objects named on screen are few; past it the oldest goes. */
const KEPT = 512;

/**
 * `read` shared: the same (chat, reference, agent) asked while `moved` stays is one read, in flight or done; a `moved`
 * that differs drops every read kept, and a read that failed is not kept, so the next line that asks tries again.
 */
export function sharedReads(read: ReadObject) {
	let moved: string | undefined;
	const kept = new Map<string, Promise<ObjectShown | undefined>>();
	return (
		chat: number,
		reference: string,
		agent: string | undefined,
		now: string,
	): Promise<ObjectShown | undefined> => {
		if (now !== moved) {
			moved = now;
			kept.clear();
		}
		const key = JSON.stringify([chat, reference, agent ?? null]);
		const going = kept.get(key);
		if (going !== undefined) return going;
		const started = read(chat, reference, agent).catch((error: unknown) => {
			if (kept.get(key) === started) kept.delete(key);
			throw error;
		});
		kept.set(key, started);
		if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
		return started;
	};
}
