/**
 * A copied key on the clipboard (H-271): cleared a minute after, whatever page is open by then, and at once when the
 * page goes away; never over something the owner copied since, where it can be read; a clear refused while the page
 * is not in front is tried again when it comes back; the seconds left are counted for the screen.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { type ClipboardDeps, secretClipboard } from "./clipboard.ts";

function harness(readable = true) {
	let now = 1_000_000;
	let holds = "";
	let refuse = false;
	const ticks = new Set<() => Promise<void> | undefined>();
	const events = {
		back: new Set<() => Promise<void> | undefined>(),
		gone: new Set<() => Promise<void> | undefined>(),
	};
	const deps: ClipboardDeps = {
		clip: {
			write: async (text) => {
				if (refuse) throw new Error("Document is not focused.");
				holds = String(text);
			},
			read: async () => (readable ? holds : undefined),
		},
		now: () => now,
		repeat: (run) => {
			ticks.add(run);
			return () => ticks.delete(run);
		},
		on: (event, run) => {
			events[event].add(run);
			return () => events[event].delete(run);
		},
	};
	return {
		board: secretClipboard(deps),
		holds: () => holds,
		copyElsewhere: (text: string) => {
			holds = text;
		},
		refuse: (on: boolean) => {
			refuse = on;
		},
		pass: async (ms: number) => {
			now += ms;
			await Promise.all([...ticks].map((tick) => tick()));
		},
		fire: async (event: "back" | "gone") => {
			await Promise.all([...events[event]].map((run) => run()));
		},
		listening: () => ticks.size + events.back.size + events.gone.size,
	};
}

describe("a key on the clipboard", () => {
	it("is cleared a minute after it was copied, counting down meanwhile, and then stops listening", async () => {
		const at = harness();
		await at.board.copy("0xkey");
		expect(at.holds()).toBe("0xkey");
		expect(at.board.left()).toBe(60);
		await at.pass(8_000);
		expect(at.board.left()).toBe(52);
		await at.pass(52_000);
		expect(at.holds()).toBe("");
		expect(at.board.left()).toBeUndefined();
		expect(at.listening()).toBe(0);
	});

	it("is cleared at once when the page goes away", async () => {
		const at = harness();
		await at.board.copy("0xkey");
		await at.fire("gone");
		expect(at.holds()).toBe("");
		expect(at.board.left()).toBeUndefined();
	});

	it("leaves what the owner copied since, where the page can read it", async () => {
		const at = harness();
		await at.board.copy("0xkey");
		at.copyElsewhere("a shopping list");
		await at.pass(60_000);
		expect(at.holds()).toBe("a shopping list");
		expect(at.board.left()).toBeUndefined();
	});

	it("clears without reading where the page may not read it", async () => {
		const at = harness(false);
		await at.board.copy("0xkey");
		await at.pass(60_000);
		expect(at.holds()).toBe("");
	});

	it("tries a refused clear again when the page comes back", async () => {
		const at = harness();
		await at.board.copy("0xkey");
		at.refuse(true);
		await at.pass(60_000);
		expect(at.holds()).toBe("0xkey");
		expect(at.board.left()).toBe(0);
		at.refuse(false);
		await at.fire("back");
		expect(at.holds()).toBe("");
		expect(at.board.left()).toBeUndefined();
	});

	it("says when the clipboard refused the copy, and has nothing to clear", async () => {
		const at = harness();
		at.refuse(true);
		await expect(at.board.copy("0xkey")).rejects.toThrow();
		expect(at.board.left()).toBeUndefined();
		expect(at.listening()).toBe(0);
	});

	it("keeps nothing of the key once it is copied: only its digest, to tell it on the clipboard (H-274)", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const at = harness();
		let ref: WeakRef<object> | undefined;
		await (async () => {
			// the key as an object, so whether anything still holds it can be seen
			const key = new String("0xkey");
			ref = new WeakRef(key);
			await at.board.copy(key as unknown as string);
		})();
		await at.pass(1_000);
		for (let round = 0; round < 3 && ref?.deref() !== undefined; round++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			gc();
		}
		expect(ref?.deref()).toBeUndefined();
		expect(at.board.left()).toBe(59);
		await at.pass(59_000);
		expect(at.holds()).toBe("");
	});
});
