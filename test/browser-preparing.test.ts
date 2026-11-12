import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/box/browser.ts";
import { openBrowsers } from "../src/box/browsers.ts";
import { until } from "./helpers.ts";

const started = vi.hoisted(() => [] as { readonly command: readonly string[]; closed: boolean }[]);
vi.mock("../src/box/cdp.ts", async (original) => ({
	...(await original<typeof import("../src/box/cdp.ts")>()),
	Cdp: class {
		readonly process: { readonly command: readonly string[]; closed: boolean };
		readonly ended = new Promise<string>(() => {});
		constructor(command: readonly string[]) {
			this.process = { command, closed: false };
			started.push(this.process);
		}
		on() {
			return () => {};
		}
		async send(method: string) {
			if (method === "Target.getTargets") return { targetInfos: [{ type: "page", targetId: "T" }] };
			if (method === "Target.createTarget") return { targetId: "T" };
			if (method === "Target.attachToTarget") return { sessionId: "S" };
			if (method === "Storage.getCookies" || method === "Network.getCookies") return { cookies: [] };
			return {};
		}
		close() {
			this.process.closed = true;
		}
	},
}));

function preparation() {
	let ready: (command: readonly string[]) => void = () => {};
	const pending = new Promise<readonly string[]>((resolve) => {
		ready = resolve;
	});
	return { command: vi.fn(() => pending), ready };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanups.splice(0)) close();
	started.length = 0;
});

describe("optional browser preparation", () => {
	it("owner takeover excludes agent actions before waiting for computer recovery", async () => {
		const recovery = preparation();
		let repairing = false;
		const browser = openBrowser({
			setup: { command: async () => ["browser"], login: { username: "u", password: "p" } },
			ensure: async () => {
				if (repairing) await recovery.command();
			},
			tell: async () => {},
			log: () => {},
		});
		cleanups.push(browser.close);
		await browser.forget("example.com");
		repairing = true;
		const takeover = browser.hold(true);
		try {
			await expect(browser.act(0, { type: "navigate", url: "https://example.com/" })).rejects.toThrow(
				"The owner is using the browser",
			);
		} finally {
			recovery.ready([]);
			await takeover;
		}
		expect(browser.view().control).toBe("owner");
	});

	it("owner input does not reach a session closed while computer recovery waited", async () => {
		const recovery = preparation();
		let repairing = false;
		const browser = openBrowser({
			setup: { command: async () => ["browser"], login: { username: "u", password: "p" } },
			ensure: async () => {
				if (repairing) await recovery.command();
			},
			tell: async () => {},
			log: () => {},
		});
		cleanups.push(browser.close);
		await browser.forget("example.com");
		await browser.hold(true);
		repairing = true;
		const input = browser.input({ type: "navigate", url: "https://example.com/" }).catch((error: unknown) => error);
		browser.close();
		recovery.ready([]);
		expect(await input).toMatchObject({ message: "Take the browser first." });
	});

	it("keeps owner pointer movement and scrolling responsive during a recovery", async () => {
		const recovery = preparation();
		let repairing = false;
		const browser = openBrowser({
			setup: { command: async () => ["browser"], login: { username: "u", password: "p" } },
			ensure: async () => {
				if (repairing) await recovery.command();
			},
			tell: async () => {},
			log: () => {},
		});
		cleanups.push(browser.close);
		await browser.forget("example.com");
		await browser.hold(true);
		repairing = true;
		try {
			await browser.input({ type: "mouse", action: "move", x: 10, y: 10 });
			await browser.input({ type: "mouse", action: "wheel", x: 10, y: 10, deltaY: 100 });
		} finally {
			recovery.ready([]);
		}
	});

	it("keeps a later opening intact when an earlier preparation finishes after close", async () => {
		const first = preparation();
		const next = preparation();
		const command = vi.fn().mockImplementationOnce(first.command).mockImplementationOnce(next.command);
		const browser = openBrowser({
			setup: { command, login: { username: "u", password: "p" } },
			ensure: async () => {},
			tell: async () => {},
			log: () => {},
		});
		cleanups.push(browser.close);
		const old = browser.forget("example.com").catch((error: unknown) => error);
		await until(() => first.command.mock.calls.length === 1);
		expect(browser.view()).toMatchObject({ running: false, preparing: true });
		browser.close();
		const reopened = browser.forget("example.com");
		await until(() => next.command.mock.calls.length === 1);
		first.ready(["closed-browser"]);
		expect(await old).toMatchObject({ message: "The browser was closed." });
		expect(started).toHaveLength(0);
		expect(browser.view()).toMatchObject({ running: false, preparing: true });
		next.ready(["current-browser"]);
		await reopened;
		expect(started.map((each) => each.command)).toEqual([["current-browser"]]);
		expect(browser.view()).toMatchObject({ running: true, preparing: false });
	});

	it("retries a failed preparation and clears its pending state and proxy holder", async () => {
		const command = vi.fn().mockRejectedValueOnce(new Error("browser download failed")).mockResolvedValue(["browser"]);
		const tell = vi.fn(async () => {});
		const browser = openBrowser({
			setup: { command, login: { username: "u", password: "p" } },
			ensure: async () => {},
			tell,
			log: () => {},
		});
		cleanups.push(browser.close);
		await expect(browser.forget("example.com")).rejects.toThrow("browser download failed");
		expect(browser.view()).toMatchObject({ running: false, preparing: false });
		expect(tell).toHaveBeenLastCalledWith(undefined);
		await browser.forget("example.com");
		expect(browser.view()).toMatchObject({ running: true, preparing: false });
	});

	it.each(["tab", "all"] as const)(
		"starts no shared process after its last %s closes during preparation",
		async (which) => {
			const prep = preparation();
			const browsers = openBrowsers({
				setup: () => ({ command: prep.command, login: { username: "u", password: "p" } }),
				ensure: async () => {},
				agentOf: async () => "mara",
				tell: async () => {},
				log: () => {},
			});
			cleanups.push(browsers.close);
			const tab = await browsers.for(1);
			const opening = tab.cookies(1, "https://example.com");
			await until(() => prep.command.mock.calls.length === 1);
			if (which === "tab") tab.close();
			else browsers.close();
			prep.ready(["closed-shared-browser"]);
			expect(await opening).toBeNull();
			expect(started).toHaveLength(0);
			expect(tab.view()).toMatchObject({ running: false, preparing: false });
		},
	);

	it("keeps one shared process for another tab still waiting when one closes", async () => {
		const prep = preparation();
		const browsers = openBrowsers({
			setup: () => ({ command: prep.command, login: { username: "u", password: "p" } }),
			ensure: async () => {},
			agentOf: async () => "mara",
			tell: async () => {},
			log: () => {},
		});
		cleanups.push(browsers.close);
		const first = await browsers.for(1);
		const second = await browsers.for(2);
		const openingFirst = first.cookies(1, "https://example.com");
		const openingSecond = second.cookies(2, "https://example.com");
		await until(() => browsers.holders().mara?.tabs["2"] !== undefined && prep.command.mock.calls.length === 1);
		first.close();
		prep.ready(["shared-browser"]);
		expect(await openingFirst).toBeNull();
		expect(await openingSecond).toEqual([]);
		expect(started).toHaveLength(1);
		expect(started[0]?.closed).toBe(false);
		second.close();
		expect(started[0]?.closed).toBe(true);
	});
});
