/** A 403 on a phone is only a reason to ask the daemon where the phone stands: the pairing route answers that. */
import { afterEach, describe, expect, it, vi } from "vitest";

const answering = (status: number) => async () =>
	new Response(JSON.stringify({ error: "refused" }), { status, headers: { "content-type": "application/json" } });

async function loaded(identified: boolean, status: number) {
	vi.resetModules();
	vi.doMock("./transport.ts", () => ({
		pickTransport: () => ({ identified, request: answering(status), stream: answering(status) }),
	}));
	vi.stubGlobal("location", { hash: identified ? "" : "#token=t", pathname: "/", search: "" });
	vi.stubGlobal("history", { replaceState: () => {} });
	vi.stubGlobal("addEventListener", () => {});
	return await import("./api.ts");
}

afterEach(() => {
	vi.doUnmock("./transport.ts");
	vi.unstubAllGlobals();
});

describe("a request the daemon refused", () => {
	it("tells a device's listeners on 403, and still rejects with the daemon's words", async () => {
		const { api, onDeviceRefused, Refused } = await loaded(true, 403);
		const heard = vi.fn();
		onDeviceRefused(heard);
		await expect(api("/anything")).rejects.toBeInstanceOf(Refused);
		expect(heard).toHaveBeenCalledOnce();
	});

	it("tells no one in a browser, or for any other refusal", async () => {
		const browser = await loaded(false, 403);
		const heard = vi.fn();
		browser.onDeviceRefused(heard);
		await expect(browser.api("/anything")).rejects.toBeInstanceOf(browser.Refused);
		const notFound = await loaded(true, 404);
		notFound.onDeviceRefused(heard);
		await expect(notFound.api("/anything")).rejects.toBeInstanceOf(notFound.Refused);
		expect(heard).not.toHaveBeenCalled();
	});
});
