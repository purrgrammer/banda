/**
 * A page's write belongs to the page that made it (DESIGN.md "The box", The browser), whatever order DevTools reports
 * it in, against a scripted DevTools. Chromium pauses a request in its browser process (`Fetch.requestPaused`) while the
 * page's own news (`Page.frameNavigated`, `Network.requestWillBeSent`) comes from its renderer, so a new page's write
 * can be paused before the browser says the page changed: it is that new page's, held and listed, never dropped as the
 * page left behind. A write of a page that is left behind goes with it: failed in Chromium, never kept paused there.
 * Whose a write is comes from the request's own word of its document (its frame, loader and address), never from when
 * that word arrives: one a signed-in page made is never kept as another page's, however late the word comes, if it
 * never comes, across a navigation, a reload or a redirect; one whose maker is not known fails.
 */
import { describe, expect, it } from "vitest";
import { type Browser, openBrowser } from "../src/box/browser.ts";
import type { Cdp, CdpEvent } from "../src/box/cdp.ts";

/** A DevTools that answers every command, keeps what it was sent, and lets the test send events in any order. */
class ScriptedCdp {
	readonly sent: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
	readonly #listeners = new Set<(event: CdpEvent) => void>();
	readonly ended = new Promise<string>(() => {});
	url = "about:blank";
	on(listener: (event: CdpEvent) => void) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async send(method: string, params: Record<string, unknown> = {}) {
		this.sent.push({ method, params });
		if (method === "Target.createTarget") return { targetId: "T" };
		if (method === "Target.attachToTarget") return { sessionId: "S" };
		if (method === "Storage.getCookies" || method === "Network.getCookies") return { cookies: [] };
		// enough of a page for an action to read once it settled: its address, and nothing on it
		if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top", url: this.url } } };
		if (method === "Accessibility.getFullAXTree") return { nodes: [] };
		if (method === "Target.getTargetInfo") return { targetInfo: { title: "Page", url: this.url } };
		return {};
	}
	emit(method: string, params: Record<string, unknown>) {
		for (const listener of this.#listeners) listener({ method, params, sessionId: "S" });
	}
	close() {}
	/** What was done with paused request `id` so far: continued, failed, or nothing. */
	answers(id: string) {
		return this.sent
			.filter((one) => one.params.requestId === id && one.method.startsWith("Fetch."))
			.map((one) => one.method);
	}
}

/** Every event and decision run to its end: a guard's awaits, the browser's own commands. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * `signed`: a host the owner signed in to, allowed for the task; elsewhere every write acts as nobody. `settleMs`: how
 * long a page is waited on after a write is let go.
 */
async function setup(signed?: string, settleMs?: number) {
	const cdp = new ScriptedCdp();
	const browser: Browser = openBrowser({
		setup: { command: async () => [], login: { username: "u", password: "p" } },
		ensure: async () => {},
		tell: async () => {},
		log: () => {},
		process: async () => ({ cdp: cdp as unknown as Cdp, release() {} }),
		sessionAt: async (_chat, url) =>
			signed !== undefined && new URL(url).hostname === signed ? { site: signed, allowed: true } : undefined,
		...(settleMs === undefined ? {} : { settleMs }),
	});
	// a sign-out of nothing starts the tab without driving it
	await browser.forget("nothing.example");
	const committed = (url: string, loader: string) => {
		cdp.url = url;
		cdp.emit("Page.frameNavigated", { frame: { id: "top", loaderId: loader, url } });
	};
	const willSend = (network: string, url: string, method: string, type: string, loader: string, page: string) =>
		cdp.emit("Network.requestWillBeSent", {
			requestId: network,
			loaderId: loader,
			documentURL: page,
			frameId: "top",
			type,
			request: { url, method, headers: {} },
		});
	/** `origin`: the Origin header the browser set, naming the origin that started it. */
	const paused = (
		id: string,
		network: string,
		url: string,
		method: string,
		type: string,
		frame = "top",
		origin?: string,
	) =>
		cdp.emit("Fetch.requestPaused", {
			requestId: id,
			networkId: network,
			resourceType: type,
			frameId: frame,
			request: {
				method,
				url,
				headers: { "Content-Type": "text/plain", ...(origin === undefined ? {} : { Origin: origin }) },
				postDataEntries: [],
			},
		});
	return { cdp, browser, committed, willSend, paused };
}

const BLOG = "http://blog.example";

describe("a page's write, as DevTools reports it", () => {
	it("paused before its page is said to have opened, is the new page's: held and listed, never dropped", async () => {
		const s = await setup();
		s.committed(`${BLOG}/`, "L1");
		// the agent opens the challenge: its document goes on
		s.willSend("N0", `${BLOG}/challenge`, "GET", "Document", "L2", `${BLOG}/challenge`);
		s.paused("d0", "N0", `${BLOG}/challenge`, "GET", "Document");
		await flush();
		expect(s.cdp.answers("d0")).toEqual(["Fetch.continueRequest"]);
		// its script's write, paused by the browser process before the renderer's news of the page arrives
		s.paused("w0", "N1", `${BLOG}/bootstrap`, "POST", "XHR");
		await flush();
		s.committed(`${BLOG}/challenge`, "L2");
		s.willSend("N1", `${BLOG}/bootstrap`, "POST", "Fetch", "L2", `${BLOG}/challenge`);
		await flush();
		const writes = await s.browser.writes(0);
		// its page and frame are the challenge's, as whose write it is is weighed by them (`ownersOf`)
		expect(writes.map((write) => [write.method, write.url, write.page, write.origin])).toEqual([
			["POST", `${BLOG}/bootstrap`, `${BLOG}/challenge`, `${BLOG}/challenge`],
		]);
		// held, as a write the agent's page made is: neither sent nor failed
		expect(s.cdp.answers("w0")).toEqual([]);
	});

	it("of a page left behind goes with it: failed in the browser, never kept paused there", async () => {
		const s = await setup();
		s.committed(`${BLOG}/form`, "L1");
		s.willSend("N1", `${BLOG}/save`, "POST", "Fetch", "L1", `${BLOG}/form`);
		s.paused("w0", "N1", `${BLOG}/save`, "POST", "XHR");
		await flush();
		expect((await s.browser.writes(0)).map((write) => write.page)).toEqual([`${BLOG}/form`]);
		// the page goes elsewhere: its write is gone, and so is the request Chromium held for it
		s.willSend("N2", `${BLOG}/next`, "GET", "Document", "L2", `${BLOG}/next`);
		s.paused("d1", "N2", `${BLOG}/next`, "GET", "Document");
		await flush();
		s.committed(`${BLOG}/next`, "L2");
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
	});

	it("made by a page left while it waited to be heard of goes with that page", async () => {
		const s = await setup();
		s.committed(`${BLOG}/form`, "L1");
		s.paused("w0", "N1", `${BLOG}/save`, "POST", "XHR");
		await flush();
		// the renderer tells of it as the form's, and of the next page, before the pause is decided
		s.willSend("N1", `${BLOG}/save`, "POST", "Fetch", "L1", `${BLOG}/form`);
		s.committed(`${BLOG}/next`, "L2");
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
	});

	it("the renderer never tells of fails in the browser: no request waits for ever, none goes as the page that stands", async () => {
		const s = await setup();
		s.committed(`${BLOG}/challenge`, "L1");
		s.paused("w0", "N1", `${BLOG}/bootstrap`, "POST", "XHR");
		await flush();
		expect(s.cdp.answers("w0")).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
	});

	it("an action is not over while a write its page made is still being decided: what it says lists the write", async () => {
		const s = await setup();
		s.committed(`${BLOG}/`, "L1");
		const said = s.browser.act(0, { type: "navigate", url: `${BLOG}/challenge` });
		await flush();
		s.willSend("N0", `${BLOG}/challenge`, "GET", "Document", "L2", `${BLOG}/challenge`);
		s.paused("d0", "N0", `${BLOG}/challenge`, "GET", "Document");
		s.committed(`${BLOG}/challenge`, "L2");
		s.cdp.emit("Network.loadingFinished", { requestId: "N0" });
		s.cdp.emit("Page.frameStoppedLoading", { frameId: "top" });
		// the script's write is paused, and the renderer tells of it only after the page would have looked quiet
		s.paused("w0", "N1", `${BLOG}/bootstrap`, "POST", "XHR");
		await new Promise((resolve) => setTimeout(resolve, 800));
		s.willSend("N1", `${BLOG}/bootstrap`, "POST", "Fetch", "L2", `${BLOG}/challenge`);
		expect(await said).toContain(`[banda] The page tried to send POST ${BLOG}/bootstrap (write w1)`);
	});
});

const BANK = "http://bank.example";
const EVIL = "http://evil.example";
/** Writes that would go as nobody: neither their page nor their frame is the signed-in bank's (`ownersOf`). */
const asNobody = (writes: readonly { readonly page: string; readonly origin: string }[]) =>
	writes.filter((write) => ![write.page, write.origin].some((address) => address.startsWith(BANK)));
/** Longer than a paused request waits to hear of its document. */
const unheard = () => new Promise((resolve) => setTimeout(resolve, 2_300));

describe("a signed-in page's write, whatever DevTools tells late or never, is never another page's", () => {
	it("its renderer's word comes after another site's page opened: failed, never kept as that page's", async () => {
		const s = await setup("bank.example");
		s.committed(`${BANK}/inbox`, "LA");
		s.paused("w0", "N1", `${EVIL}/beacon`, "POST", "XHR");
		await flush();
		s.committed(`${EVIL}/landing`, "LB");
		// the old renderer's word of its own request, after the new renderer's page
		s.willSend("N1", `${EVIL}/beacon`, "POST", "Fetch", "LA", `${BANK}/inbox`);
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
	});

	it("its renderer never tells of it, and another site's page opens meanwhile: failed, never kept as that page's", async () => {
		const s = await setup("bank.example");
		s.committed(`${BANK}/inbox`, "LA");
		s.paused("w0", "N1", `${EVIL}/beacon`, "POST", "XHR");
		await flush();
		s.committed(`${EVIL}/landing`, "LB");
		await unheard();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
	});

	it("a navigation that writes, paused before its page is said to have opened: never the page before's", async () => {
		const s = await setup("bank.example");
		s.committed(`${BLOG}/`, "L1");
		// the agent opens the bank's form (a navigation's network id is its loader's)
		s.paused("d0", "LB", `${BANK}/form`, "GET", "Document");
		await flush();
		expect(s.cdp.answers("d0")).toEqual(["Fetch.continueRequest"]);
		// its form sends itself elsewhere, paused by the browser before the bank's renderer says its page opened
		s.paused("f0", "LF", `${EVIL}/collect`, "POST", "Document", "top", BANK);
		await flush();
		expect(asNobody(await s.browser.writes(0))).toEqual([]);
		s.committed(`${BANK}/form`, "LB");
		await flush();
		expect((await s.browser.writes(0)).map((write) => [write.url, write.page, write.origin])).toEqual([
			[`${EVIL}/collect`, `${BANK}/form`, `${BANK}/form`],
		]);
	});

	it("a signed-in page's form sent while another site's page is opening, that page then opening: never that page's", async () => {
		const s = await setup("bank.example");
		s.committed(`${BANK}/inbox`, "LA");
		s.paused("d0", "LB", `${EVIL}/landing`, "GET", "Document");
		await flush();
		expect(s.cdp.answers("d0")).toEqual(["Fetch.continueRequest"]);
		// the bank's page, still standing, sends a form elsewhere; then the other page opens
		s.paused("f0", "LF", `${EVIL}/collect`, "POST", "Document", "top", BANK);
		await flush();
		s.committed(`${EVIL}/landing`, "LB");
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		await unheard();
		expect(asNobody(await s.browser.writes(0))).toEqual([]);
	});

	it("a signed-in page's form paused only after another site's page opened: failed, never that page's", async () => {
		const s = await setup("bank.example");
		s.committed(`${BANK}/inbox`, "LA");
		s.paused("d0", "LB", `${EVIL}/landing`, "GET", "Document");
		await flush();
		s.committed(`${EVIL}/landing`, "LB");
		s.paused("f0", "LF", `${EVIL}/collect`, "POST", "Document", "top", BANK);
		await flush();
		expect(asNobody(await s.browser.writes(0))).toEqual([]);
		await unheard();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("f0")).toEqual(["Fetch.failRequest"]);
	});

	it("a form whose origin is hidden or not named fails: nothing says which page sent it", async () => {
		const s = await setup();
		s.committed(`${BLOG}/form`, "L1");
		s.paused("f0", "LF", `${BLOG}/save`, "POST", "Document", "top", "null");
		s.paused("f1", "LG", `${BLOG}/save`, "POST", "Document");
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("f0")).toEqual(["Fetch.failRequest"]);
		expect(s.cdp.answers("f1")).toEqual(["Fetch.failRequest"]);
	});

	it("a form is its standing page's though a navigation it began never ended (a download, a 204)", async () => {
		const s = await setup();
		s.committed(`${BLOG}/form`, "L1");
		s.paused("d0", "LX", `${BLOG}/download`, "GET", "Document");
		await flush();
		s.paused("f0", "LF", `${BLOG}/save`, "POST", "Document", "top", BLOG);
		await flush();
		expect((await s.browser.writes(0)).map((write) => [write.url, write.page])).toEqual([
			[`${BLOG}/save`, `${BLOG}/form`],
		]);
	});

	it("reloaded at the same address, its page's writes go with the document left behind, early or late", async () => {
		const s = await setup("bank.example");
		s.committed(`${BANK}/form`, "L1");
		s.willSend("N1", `${EVIL}/save`, "POST", "Fetch", "L1", `${BANK}/form`);
		s.paused("w0", "N1", `${EVIL}/save`, "POST", "XHR");
		await flush();
		expect((await s.browser.writes(0)).map((write) => write.page)).toEqual([`${BANK}/form`]);
		s.committed(`${BANK}/form`, "L2");
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
		// the old document's next write, told of after the reload
		s.paused("w1", "N2", `${EVIL}/save`, "POST", "XHR");
		s.willSend("N2", `${EVIL}/save`, "POST", "Fetch", "L1", `${BANK}/form`);
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w1")).toEqual(["Fetch.failRequest"]);
	});

	it("a hop of its redirect is its own: held as its page's, or failed once that page is left", async () => {
		const s = await setup("bank.example", 300);
		s.committed(`${BANK}/inbox`, "LA");
		s.willSend("N1", `${BANK}/api`, "POST", "Fetch", "LA", `${BANK}/inbox`);
		s.paused("w0", "N1", `${BANK}/api`, "POST", "XHR");
		await flush();
		const [first] = await s.browser.writes(0);
		expect([first?.page, first?.origin]).toEqual([`${BANK}/inbox`, `${BANK}/inbox`]);
		await s.browser.release(0, first?.id ?? "", async () => {});
		expect(s.cdp.answers("w0")).toEqual(["Fetch.continueRequest"]);
		// it is redirected; the hop is paused before the renderer's word of it: still the bank's
		s.paused("w1", "N1", `${EVIL}/collect`, "POST", "XHR");
		await flush();
		expect((await s.browser.writes(0)).map((write) => [write.url, write.page])).toEqual([
			[`${EVIL}/collect`, `${BANK}/inbox`],
		]);
		// another site's page opens, and the next hop's word comes late: failed, never that page's
		s.committed(`${EVIL}/landing`, "LB");
		s.paused("w2", "N1", `${EVIL}/again`, "POST", "XHR");
		s.willSend("N1", `${EVIL}/again`, "POST", "Fetch", "LA", `${BANK}/inbox`);
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w2")).toEqual(["Fetch.failRequest"]);
	});

	it("made in a frame inside the page, whose page no request names: failed, never held", async () => {
		const s = await setup("bank.example");
		s.committed(`${BANK}/inbox`, "LA");
		s.cdp.emit("Page.frameNavigated", { frame: { id: "child", parentId: "top", loaderId: "LC", url: "about:blank" } });
		s.cdp.emit("Network.requestWillBeSent", {
			requestId: "N1",
			loaderId: "LC",
			documentURL: "about:blank",
			frameId: "child",
			type: "Fetch",
			request: { url: `${EVIL}/beacon`, method: "POST", headers: {} },
		});
		s.paused("w0", "N1", `${EVIL}/beacon`, "POST", "XHR", "child");
		await flush();
		expect(await s.browser.writes(0)).toEqual([]);
		expect(s.cdp.answers("w0")).toEqual(["Fetch.failRequest"]);
	});
});
