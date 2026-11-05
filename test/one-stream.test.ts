/** The page's one event stream (`web/src/lib/one-stream.ts`): every chat that starts reading hears its `ready`. */
import { describe, expect, it } from "vitest";
import type { ShellEvent } from "../src/server/api.ts";
import { oneStream } from "../web/src/lib/one-stream.ts";

/** As the daemon: a stream that says `ready` for the chat it watches, then stays open until aborted. */
const open = async (path: string, onEvent: (event: ShellEvent) => void, signal: AbortSignal) => {
	const chat = Number(/chat=(\d+)/.exec(path)?.[1]);
	if (!Number.isNaN(chat))
		onEvent({ type: "live", chat, event: { type: "ready", tail: 0, busy: false, partial: [], running: [] } } as never);
	await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
};

describe("the page's one stream", () => {
	it("gives a chat its ready again when it is left and read again", async () => {
		const { events, shellEvents, takeReopen } = oneStream(open);
		const page = new AbortController();
		// as the shell does: reconnect at once when the stream ended to reopen
		void (async () => {
			while (!page.signal.aborted) {
				await shellEvents(() => {}, page.signal);
				if (!takeReopen()) break;
			}
		})();
		const readyOnce = async (chat: number) => {
			const leave = new AbortController();
			const heard = new Promise<string>((resolve) => {
				void events(chat, (event) => resolve(event.type), leave.signal);
			});
			const type = await Promise.race([heard, new Promise((resolve) => setTimeout(() => resolve("nothing"), 200))]);
			leave.abort();
			return type;
		};
		expect(await readyOnce(7)).toBe("ready");
		// left, then back to the same chat
		expect(await readyOnce(7)).toBe("ready");
		expect(await readyOnce(8)).toBe("ready");
		page.abort();
	});
});
