/**
 * The owner's sessions stay theirs (DESIGN.md "The box", The browser), at the browser's own request interception,
 * against a scripted DevTools: a page of a signed-in site this task did not allow never loads (a top page, a frame, a
 * hop of a redirect), and another request there is stopped too, unless its
 * page is of an allowed signed-in site too. What the agent's page reads elsewhere goes as it is.
 */
import { describe, expect, it } from "vitest";
import { type Browser, openBrowser } from "../src/box/browser.ts";
import type { Cdp, CdpEvent } from "../src/box/cdp.ts";
import { until } from "./helpers.ts";

const SIGNED = "accounts.google.com";

/** A DevTools that answers every command, keeps what it was sent, and lets the test send events. */
class ScriptedCdp {
	readonly sent: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
	readonly #listeners = new Set<(event: CdpEvent) => void>();
	readonly ended = new Promise<string>(() => {});
	on(listener: (event: CdpEvent) => void) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async send(method: string, params: Record<string, unknown> = {}) {
		this.sent.push({ method, params });
		if (method === "Target.createTarget") return { targetId: "T" };
		if (method === "Target.attachToTarget") return { sessionId: "S" };
		if (method === "Storage.getCookies") return { cookies: [] };
		if (method === "Network.getCookies") {
			const url = (params.urls as string[])[0] ?? "";
			return { cookies: new URL(url).hostname.endsWith("google.com") ? [{ domain: ".google.com" }] : [] };
		}
		return {};
	}
	emit(method: string, params: Record<string, unknown>) {
		for (const listener of this.#listeners) listener({ method, params, sessionId: "S" });
	}
	close() {}
	/** What was done with request `id`: the command and its parameters, once one came. */
	answered(id: string) {
		return until(() =>
			this.sent.find(
				(one) =>
					one.params.requestId === id &&
					["Fetch.continueRequest", "Fetch.failRequest", "Fetch.continueResponse"].includes(one.method),
			),
		);
	}
}

async function setup(allowed: readonly string[] = []) {
	const cdp = new ScriptedCdp();
	const browser: Browser = openBrowser({
		setup: { command: async () => [], login: { username: "u", password: "p" } },
		ensure: async () => {},
		tell: async () => {},
		log: () => {},
		process: async () => ({ cdp: cdp as unknown as Cdp, release() {} }),
		// signed in to accounts.google.com; its session's cookie is the whole domain's
		sessionAt: async (_chat, url, cookies) => {
			const host = new URL(url).hostname;
			const ofSite = (name: string) => name === SIGNED || SIGNED.endsWith(`.${name}`) || name.endsWith(`.${SIGNED}`);
			if (!ofSite(host) && !(cookies ?? []).some(ofSite)) return undefined;
			return { site: SIGNED, allowed: allowed.includes(SIGNED) };
		},
	});
	// a sign-out of nothing starts the tab without driving it
	await browser.forget("nothing.example");
	let n = 0;
	const request = async (
		url: string,
		over: { method?: string; type?: string; frame?: string; cookie?: boolean; redirectedFrom?: string } = {},
	) => {
		const id = `r${++n}`;
		cdp.emit("Fetch.requestPaused", {
			requestId: id,
			resourceType: over.type ?? "Document",
			frameId: over.frame ?? "top",
			...(over.redirectedFrom === undefined ? {} : { redirectedRequestId: over.redirectedFrom }),
			request: {
				method: over.method ?? "GET",
				url,
				headers: { Accept: "*/*", ...(over.cookie === false ? {} : { Cookie: "SID=owner" }) },
			},
		});
		return { id, done: await cdp.answered(id) };
	};
	const page = (url: string, frame = "top") =>
		cdp.emit("Page.frameNavigated", { frame: { id: frame, url, ...(frame === "top" ? {} : { parentId: "top" }) } });
	return { cdp, browser, request, page };
}

describe("a site the owner signed in to, at the browser", () => {
	it("knows the cookies for an address about to open, in a chat whose tab never opened", async () => {
		const cdp = new ScriptedCdp();
		const browser = openBrowser({
			setup: { command: async () => [], login: { username: "u", password: "p" } },
			ensure: async () => {},
			tell: async () => {},
			log: () => {},
			process: async () => ({ cdp: cdp as unknown as Cdp, release() {} }),
		});
		// unknown cookies would ask as if signed in: a new chat's first page must not
		expect(await browser.cookies(5, "https://blog.example/")).toEqual([]);
		expect(await browser.cookies(5, "https://mail.google.com/")).toEqual(["google.com"]);
	});

	it("a page of it never loads unallowed: a top page, a frame, or a hop of a redirect through it", async () => {
		const s = await setup();
		s.page("https://blog.example/");
		// the agent was sent to a third party's sign-in, which goes through the owner's account
		const first = await s.request("https://thirdparty.example/login/google", { cookie: false });
		expect(first.done.method).toBe("Fetch.continueRequest");
		const hop = await s.request(`https://${SIGNED}/o/oauth2/auth?redirect_uri=https://thirdparty.example/cb`, {
			redirectedFrom: first.id,
		});
		expect(hop.done).toMatchObject({ method: "Fetch.failRequest", params: { errorReason: "BlockedByClient" } });
		// a frame of it inside an anonymous page, and a sibling host its session's cookie goes to
		const frame = await s.request(`https://${SIGNED}/embed`, { frame: "child" });
		expect(frame.done.method).toBe("Fetch.failRequest");
		const sibling = await s.request("https://mail.google.com/");
		expect(sibling.done.method).toBe("Fetch.failRequest");
		// a page of it that writes is stopped the same, never held to be sent later
		const posted = await s.request(`https://${SIGNED}/approve`, { method: "POST" });
		expect(posted.done.method).toBe("Fetch.failRequest");
		expect(await s.browser.writes(0)).toEqual([]);
	});

	it("a request of another kind there from an anonymous page is stopped: the session never goes with it", async () => {
		const s = await setup([SIGNED]);
		s.page("https://blog.example/");
		const image = await s.request(`https://${SIGNED}/pixel.gif`, { type: "Image" });
		expect(image.done).toMatchObject({ method: "Fetch.failRequest", params: { errorReason: "BlockedByClient" } });
		// one sent without a Cookie header in what was paused is stopped as well: Chromium attaches cookies later
		const bare = await s.request(`https://${SIGNED}/pixel2.gif`, { type: "Image", cookie: false });
		expect(bare.done).toMatchObject({ method: "Fetch.failRequest", params: { errorReason: "BlockedByClient" } });
		// a script's read from a frame of an anonymous site inside the page: the same
		s.page("https://ads.example/frame", "child");
		const fetched = await s.request(`https://${SIGNED}/userinfo`, { type: "Fetch", frame: "child" });
		expect(fetched.done).toMatchObject({ method: "Fetch.failRequest" });
		// a request elsewhere goes on as it is
		const other = await s.request("https://cdn.example/lib.js", { type: "Script" });
		expect(other.done).toMatchObject({ method: "Fetch.continueRequest" });
	});

	it("allowed for the task, its pages load and its own requests go as they are; elsewhere nothing changes", async () => {
		const s = await setup([SIGNED]);
		const opened = await s.request(`https://${SIGNED}/`);
		expect(opened.done).toMatchObject({ method: "Fetch.continueRequest" });
		expect(opened.done.params).not.toHaveProperty("headers");
		s.page(`https://${SIGNED}/`);
		const own = await s.request(`https://${SIGNED}/api`, { type: "XHR" });
		expect(own.done.params).not.toHaveProperty("headers");
		expect(own.done.params).not.toHaveProperty("interceptResponse");
		const elsewhere = await s.request("https://cdn.example/app.js", { type: "Script" });
		expect(elsewhere.done.params).not.toHaveProperty("headers");
	});
});
