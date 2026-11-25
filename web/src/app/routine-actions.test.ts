/**
 * The owner's one-click actions on a routine from the panel and its detail (run now, pause, resume, remove): a
 * refusal is said as a note with the daemon's words, and the shell is not told of a control view it never got, so
 * nothing reads as done that was not; an answer shows the control view and says nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// the request module reads the page's address for its token as it loads
vi.hoisted(() => {
	Object.assign(globalThis, { location: { hash: "#token=t", pathname: "/", search: "" } });
	Object.assign(globalThis, { history: { replaceState: () => {} }, addEventListener: () => {} });
});

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const shown = vi.hoisted(() => vi.fn());
vi.mock("../lib/shell.ts", () => ({ showControl: shown }));
const sent = vi.hoisted(() => [] as { path: string; body: unknown }[]);
vi.mock("../lib/transport.ts", () => ({
	pickTransport: () => ({
		identified: false,
		request: async (path: string, init?: RequestInit) => {
			sent.push({ path, body: JSON.parse(String(init?.body)) });
			// the daemon: a routine gone since answers 404 in its words; `curro/tea` is there and answers
			if (path.includes("/routines/curro/gone/"))
				return new Response(
					JSON.stringify({ error: "there is no routine curro/gone: it is gone from the box and the store" }),
					{
						status: 404,
						headers: { "content-type": "application/json" },
					},
				);
			if (path.endsWith("/run") && path.includes("/busy/"))
				return new Response(JSON.stringify({ error: "its last run still goes" }), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			return new Response(JSON.stringify({ routines: [{ id: "curro/tea" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		stream: async () => new Response(null, { status: 200 }),
	}),
}));

import { pauseRoutine, removeRoutine, runRoutineNow } from "./routines.tsx";

afterEach(() => {
	toast.error.mockClear();
	shown.mockClear();
	sent.length = 0;
});

describe("run now, pause, resume and remove from the panel", () => {
	it("a refusal is said with the daemon's words, and the shell is told nothing", async () => {
		expect(await runRoutineNow("curro/gone")).toBeUndefined();
		expect(await pauseRoutine("curro/gone", true)).toBeUndefined();
		expect(await pauseRoutine("curro/gone", false)).toBeUndefined();
		const done = vi.fn();
		expect(await removeRoutine("curro/gone", done)).toBeUndefined();
		expect(done).not.toHaveBeenCalled();
		expect(shown).not.toHaveBeenCalled();
		const gone = "There is no routine curro/gone: it is gone from the box and the store";
		expect(toast.error.mock.calls.map(([title, options]) => [title, options.description])).toEqual([
			["Couldn't run it now", gone],
			["Couldn't pause it", gone],
			["Couldn't resume it", gone],
			["Couldn't remove it", gone],
		]);
		// each note offers Try again, which asks the daemon again
		const again = toast.error.mock.calls[0]?.[1].action as { label: string; onClick: () => void };
		expect(again.label).toBe("Try again");
		again.onClick();
		await vi.waitFor(() => expect(sent.filter((each) => each.path.endsWith("/run"))).toHaveLength(2));
		// a run still going reads as the daemon says
		expect(await runRoutineNow("curro/busy")).toBeUndefined();
		expect(toast.error.mock.calls.at(-1)?.[1].description).toBe("Its last run still goes");
	});

	it("an answer shows the control view, says nothing, and the request names the routine twice", async () => {
		await runRoutineNow("curro/tea");
		expect(shown).toHaveBeenLastCalledWith({ routines: [{ id: "curro/tea" }] });
		await pauseRoutine("curro/tea", true);
		const done = vi.fn();
		await removeRoutine("curro/tea", done);
		expect(done).toHaveBeenCalledOnce();
		expect(shown).toHaveBeenCalledTimes(3);
		expect(toast.error).not.toHaveBeenCalled();
		expect(sent.map((each) => [each.path, (each.body as { id: string }).id])).toEqual([
			["/api/routines/curro/tea/run", "curro/tea"],
			["/api/routines/curro/tea/pause", "curro/tea"],
			["/api/routines/curro/tea/remove", "curro/tea"],
		]);
	});

	it("against a daemon older than this app, whose rows carry no id, nothing is sent and the note says what to do", async () => {
		expect(await runRoutineNow(undefined as never)).toBeUndefined();
		expect(sent).toEqual([]);
		expect(toast.error.mock.calls[0]?.[1].description).toMatch(/older than this app.*update banda/);
	});
});
