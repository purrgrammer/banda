/**
 * An act on a wallet's key through the desktop app never fails in silence: a refusal is said in the owner's words, and
 * a call that throws (the bridge refused the page, the signer would not start) says so with Try again, which runs the
 * whole act again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Note = { title: string; description?: string; action?: { label: string; onClick: () => void } };
const notes: Note[] = [];
vi.mock("sonner", () => ({
	toast: { error: (title: string, options: Omit<Note, "title"> = {}) => notes.push({ title, ...options }) },
}));
vi.mock("../lib/transport.ts", () => ({ pickTransport: () => ({ identified: false }) }));
vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });
vi.stubGlobal("history", { replaceState: () => {} });
vi.stubGlobal("addEventListener", () => {});

const { desktopAct } = await import("./desktop-act.ts");
const { DESKTOP_WORDS } = await import("./wallets.ts");

beforeEach(() => {
	notes.length = 0;
});

describe("desktopAct", () => {
	it("says a call that throws, and Try again runs the act again, its answer included", async () => {
		let calls = 0;
		const done = vi.fn();
		const settled = vi.fn();
		await desktopAct({
			what: "move signing here",
			refused: "Signing wasn't moved here",
			run: async () => {
				calls += 1;
				if (calls === 1) throw new Error("Only banda's own page may act on a wallet's key.");
				return { ok: true };
			},
			onDone: done,
			onSettled: settled,
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]?.title).toBe("Couldn't move signing here");
		expect(notes[0]?.description).toMatch(/didn't answer/);
		expect(done).not.toHaveBeenCalled();
		expect(settled).toHaveBeenCalledTimes(1);
		notes[0]?.action?.onClick();
		await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
		expect(calls).toBe(2);
		expect(notes).toHaveLength(1);
	});

	it("says a refusal in the owner's words, unless the page says it itself", async () => {
		await desktopAct({
			what: "show the key",
			refused: "The key wasn't shown",
			run: async () => ({ ok: false, code: "denied" }),
		});
		expect(notes).toEqual([{ title: "The key wasn't shown", description: DESKTOP_WORDS.denied }]);
		notes.length = 0;
		await desktopAct({
			what: "restore the key",
			refused: "The key wasn't restored",
			run: async () => ({ ok: false, code: "wrong_key" }),
			onRefused: (code) => code === "wrong_key",
		});
		expect(notes).toEqual([]);
	});
});
