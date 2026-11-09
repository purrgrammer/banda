/**
 * A browser for tests that need no Docker: a shop's settings page with a "Create key" button, whose form (a navigation
 * write) the page holds until it is released; released, the page shows a key. What reaches outside (a released write)
 * is appended to `<home>/page-sent.jsonl`, so it outlives a killed process, as the real site would; the browser itself
 * does not (Chromium dies with the daemon's pipe), so a new process starts on a blank page with nothing held. The
 * owner may hold it, and the agent's calls are then refused as `Taken`; each action done is appended to
 * `<home>/page-log.jsonl`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserView, type PageWrite, Refused, Taken, writeHash } from "../../src/box/browser.ts";

/** The key the shop shows once it made one. */
export const SHOP_KEY = "sk_live_FaultKey0123456789AbcXyz";
export const SHOP = "https://shop.example";

export function fakeBrowser(home: string, fault: (point: string) => void = () => {}): Browser {
	let open = false;
	let page: "blank" | "settings" | "key" = "blank";
	let generation = 0;
	let held: PageWrite | undefined;
	let control: BrowserView["control"] = "agent";
	const view = (): BrowserView => ({ running: open, ...(open ? { chat: 1 } : {}), control });
	const take = () => {
		if (control === "owner") throw new Taken();
		if (!open) {
			fault("browser:start");
			open = true;
		}
	};
	const snapshot = () => {
		generation++;
		if (page === "settings") return `Page "Settings" at ${SHOP}/settings\n- button "Create key" [ref=s${generation}e1]`;
		if (page === "key") return `Page "Your key" at ${SHOP}/keys\n- text "Copy it now: [key k1]"`;
		return 'Page "" at about:blank';
	};
	const said = () =>
		held === undefined
			? snapshot()
			: `${snapshot()}\n\n[banda] The page tried to send POST ${held.url} (write ${held.id}). It was not sent.`;
	return {
		snapshot: async () => {
			take();
			return said();
		},
		act: async (_chat, action) => {
			take();
			fault("browser:action");
			appendFileSync(join(home, "page-log.jsonl"), `${JSON.stringify({ pid: process.pid, act: action.type })}\n`);
			if (action.type === "navigate") page = "settings";
			else if (action.type === "click") {
				if (action.ref !== `s${generation}e1` || page !== "settings")
					throw new Refused(`${action.ref} is from an earlier snapshot: take a new snapshot.`);
				const body = Buffer.from("label=banda");
				held = {
					id: "w1",
					chat: 1,
					method: "POST",
					url: `${SHOP}/keys`,
					headers: [["Content-Type", "application/x-www-form-urlencoded"]],
					body: body.toString("base64"),
					hash: writeHash("POST", `${SHOP}/keys`, body),
					page: `${SHOP}/settings`,
					origin: `${SHOP}/settings`,
					secret: false,
					cookies: ["shop.example"],
				};
			}
			return said();
		},
		screenshot: async () => "",
		element: () => "not in this fake",
		site: () => (open ? "shop.example" : undefined),
		cookies: async () => (open ? ["shop.example"] : null),
		writes: async (chat) => (held === undefined ? [] : [{ ...held, chat }]),
		release: async (_chat, id, pass) => {
			if (held === undefined || held.id !== id) throw new Refused("That write is gone: nothing was sent.");
			const write = held;
			await pass(write);
			appendFileSync(join(home, "page-sent.jsonl"), `${JSON.stringify({ hash: write.hash, pid: process.pid })}\n`);
			held = undefined;
			page = "key";
			return said();
		},
		drop: async () => {
			held = undefined;
		},
		key: (_chat, handle) => (open && page === "key" && handle === "k1" ? SHOP_KEY : undefined),
		view,
		watch: (listener) => {
			listener({ type: "state", view: view() });
			return () => {};
		},
		hold: async (owner) => {
			control = owner ? "owner" : "agent";
			return view();
		},
		input: async () => {
			throw new Refused("Take the browser first.");
		},
		forget: async () => {},
		close: () => {
			open = false;
		},
	};
}
