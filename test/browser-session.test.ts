import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BrowserView } from "../src/server/api.ts";
import { BrowserSession } from "../web/src/lib/browser-session.ts";
import { pbtRuns } from "./pbt.ts";

const watching: BrowserView = { running: true, preparing: false, control: "agent", chat: 3 };
const held: BrowserView = { ...watching, control: "owner" };
const deferred = () => {
	let resolve!: (view: BrowserView) => void;
	const promise = new Promise<BrowserView>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const setup = (initial = held) => {
	let current = initial;
	const hold = vi.fn(
		async (owner: boolean): Promise<BrowserView> => ({ ...watching, control: owner ? "owner" : "agent" }),
	);
	const hide = vi.fn();
	const session = new BrowserSession({
		current: () => current,
		hold,
		show: (view) => {
			current = view;
		},
		hide,
	});
	return { session, hold, hide };
};

describe("closing the enlarged browser", () => {
	it("gives back a take-over whose response was lost, even if the screen still says the agent has control", async () => {
		const { session, hold, hide } = setup(watching);
		hold.mockRejectedValueOnce(new Error("lost take-over response"));
		await expect(session.control(true)).rejects.toThrow("lost");
		await session.close();
		expect(hold.mock.calls).toEqual([[true], [false]]);
		expect(hide).toHaveBeenCalledOnce();
	});
	it("property: queued controls, thrown faults and lost responses never hide a browser still held by the owner", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ owner: fc.boolean(), failure: fc.constantFrom("none", "before", "after") }), {
					maxLength: 12,
				}),
				async (actions) => {
					let actual: BrowserView = watching;
					let shown = watching;
					let next = 0;
					let hidden = false;
					const session = new BrowserSession({
						current: () => shown,
						hold: async (owner) => {
							const failure = actions[next++]?.failure ?? "none";
							await Promise.resolve();
							if (failure === "before") throw new Error("before effect");
							actual = { ...watching, control: owner ? "owner" : "agent" };
							if (failure === "after") throw new Error("lost response");
							return actual;
						},
						show: (view) => {
							shown = view;
						},
						hide: () => {
							expect(actual.control).toBe("agent");
							hidden = true;
						},
					});
					const controls = actions.map(({ owner }) => session.control(owner).catch(() => {}));
					const close = session.close();
					await Promise.all(controls);
					await close;
					expect(hidden).toBe(true);
				},
			),
			{ numRuns: pbtRuns(100) },
		);
	});
	it("does not hide an owner-controlled page before the daemon acknowledges hand-back", async () => {
		const { session, hold, hide } = setup();
		const release = deferred();
		hold.mockImplementation(() => release.promise);
		const close = session.close();
		await Promise.resolve();
		expect(hold).toHaveBeenCalledWith(false);
		expect(hide).not.toHaveBeenCalled();
		release.resolve(watching);
		await close;
		expect(hide).toHaveBeenCalledOnce();
	});
	it("queues close behind a pending take-over, then gives it back; repeated close is one action", async () => {
		const { session, hold, hide } = setup(watching);
		const take = deferred();
		hold.mockImplementationOnce(() => take.promise);
		const control = session.control(true);
		const close = session.close();
		expect(session.close()).toBe(close);
		await expect(session.control(true)).rejects.toThrow("closing");
		take.resolve(held);
		await control;
		await close;
		expect(hold.mock.calls).toEqual([[true], [false]]);
		expect(hide).toHaveBeenCalledOnce();
	});
	it("keeps the view and controls available after a failed hand-back so Close can be retried", async () => {
		const { session, hold, hide } = setup();
		hold.mockRejectedValueOnce(new Error("offline"));
		await expect(session.close()).rejects.toThrow("offline");
		expect(hide).not.toHaveBeenCalled();
		await session.close();
		expect(hold.mock.calls).toEqual([[false], [false]]);
		expect(hide).toHaveBeenCalledOnce();
	});
	it("closing while only watching neither takes nor releases the browser, and cannot reopen control", async () => {
		const { session, hold, hide } = setup(watching);
		await session.close();
		expect(hold).not.toHaveBeenCalled();
		expect(hide).toHaveBeenCalledOnce();
		await expect(session.control(true)).rejects.toThrow("closing");
	});
});
