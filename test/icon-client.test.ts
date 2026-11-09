import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const publicFile = (name: string) => readFile(new URL(`../web/public/${name}`, import.meta.url), "utf8");

describe("browser icon freshness", () => {
	it("changes icon, touch and manifest links after identity changes without fetching private data", async () => {
		let tag = '"first"';
		const fetch = vi.fn(async () => new Response(null, { headers: { etag: tag } }));
		const links = new Map(["icon", "apple-touch-icon", "manifest"].map((rel) => [rel, { href: "initial" }]));
		const document = {
			visibilityState: "visible",
			querySelector: (selector: string) => links.get(selector.slice(10, -2)),
			addEventListener: vi.fn(),
		};
		const window = { addEventListener: vi.fn() };
		const setInterval = vi.fn();
		runInNewContext(await publicFile("icon-refresh.js"), { document, window, fetch, setInterval });
		await setImmediate();
		expect(links.get("icon")?.href).toBe("/icon.svg?v=first");
		expect(links.get("apple-touch-icon")?.href).toBe("/apple-touch-icon.png?v=first");
		expect(links.get("manifest")?.href).toBe("/manifest.webmanifest?v=first");
		const tick = setInterval.mock.calls[0]?.[0] as () => Promise<void>;
		expect(setInterval.mock.calls[0]?.[1]).toBe(5000);
		tag = '"second"';
		await tick();
		expect(links.get("icon")?.href).toBe("/icon.svg?v=second");
		expect(fetch).toHaveBeenLastCalledWith("/icon.svg", {
			method: "HEAD",
			cache: "no-store",
			credentials: "omit",
			headers: { "if-none-match": '"first"' },
		});
		fetch.mockRejectedValueOnce(new Error("offline"));
		await tick();
		expect(links.get("icon")?.href).toBe("/icon.svg?v=second");
		document.visibilityState = "hidden";
		const count = fetch.mock.calls.length;
		await tick();
		expect(fetch).toHaveBeenCalledTimes(count);
		expect(window.addEventListener.mock.calls.map(([event]) => event)).toEqual(["focus", "pageshow"]);
	});

	it("never puts identity assets into the service-worker cache, even on direct navigation", async () => {
		const listeners = new Map<string, (event: unknown) => void>();
		runInNewContext(await publicFile("sw.js"), {
			self: {
				location: { origin: "http://localhost:1234" },
				addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
			},
			URL,
		});
		for (const path of [
			"icon.svg",
			"icon-maskable.svg",
			"icon-192.png",
			"icon-512.png",
			"icon-maskable-512.png",
			"apple-touch-icon.png",
			"manifest.webmanifest",
		]) {
			const respondWith = vi.fn();
			listeners.get("fetch")?.({
				request: {
					method: "GET",
					headers: new Headers(),
					url: `http://localhost:1234/${path}?v=old`,
					mode: "navigate",
				},
				respondWith,
			});
			expect(respondWith).not.toHaveBeenCalled();
		}
	});
});
