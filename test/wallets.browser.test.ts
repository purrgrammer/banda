/**
 * Wallets through the app against a throwaway daemon, its keys in the in-memory test keystore and its chain an anvil
 * of the test's own, at a phone's width and a desktop's (UC-01 to UC-05, UC-14 A3).
 *
 * Through the dev server: Settings' tabs say themselves in the address; Settings → Wallets lists none and each
 * network's RPC masked; the owner gives Sancho a wallet from his Access, sees its key once (announced hidden, then read
 * aloud), copies it, sees it hidden again after 30 seconds and gone when the window loses focus, checks a wrong copy
 * and then the right one, and opens Receive; the clipboard clears a minute after the copy though the page is gone, and
 * the key is in no page, storage or file after; money sent from an anvil account shows on the open Settings → Wallets
 * and in the wallet's activity with no reload, pushed once the daemon's read of the chain sees it; Sancho is switched
 * off from his Access and on from the wallet's Agents; the wallet's locked and other-home notices show, and go once its
 * key is checked again; it is archived, once confirmed, and brought back; its removal is refused while it holds funds,
 * the refusal saying why with only Close (C17); Settings → Connections never lists it; and the browser's back goes from
 * the wallet to Settings → Wallets. The dev server passes the API through one daemon connection per browser connection,
 * as a browser on the daemon's own page has: the creation's key is shown with the secret only the creation's answer
 * carries (C16). A name of 64 characters with no space stays inside the window on New wallet and on every step of Save
 * your key. At 375 and 390 pixels, a wallet not backed up offers no copy of its address and draws it whole; its key
 * page after a reload skips (Receive then opens) or checks a copy; the selected Settings tab is in sight; and a key
 * without a wallet is listed.
 *
 * Against the daemon serving the built app on its own origin, as the app ships: a new wallet's key is shown there, on
 * whichever of the browser's own connections its reveal goes, while other requests are in flight (C16); a skipped one
 * opens Receive; a reveal refused, once Show key asks for it, says so; a creation with no keychain
 * to answer says that, and so does Settings → Wallets in place of New wallet until Check again finds one (H-309).
 *
 * On a paired phone, its requests going over Iroh as the Android shell sends them: a new wallet's key is never asked
 * for, the creation says to open banda's desktop app, and the computer's own controls (Save your key, Remove, an RPC's
 * Change) are not offered, an RPC change from it refused.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http, { Agent, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "uqr";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, expect, it, vi } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { DevicesView, InviteView, WalletsView } from "../src/server/api.ts";
import { streamSocket } from "../src/server/remote.ts";
import { emptyState, memoryKeystore } from "../src/wallet/keystore.ts";
import { shortAddress } from "../src/wallet/label.ts";
import { walletRoute } from "../web/src/app/where.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { testDevice } from "./fixtures/iroh-client.ts";
import { type Anvil, DEV0, hasAnvil, NO_ANVIL, startAnvil } from "./helpers/anvil.ts";
import { holdingKey } from "./helpers/home-files.ts";
import { echoModels, skipShippedSkills, tempHome, until, viteCacheDir, webServer } from "./helpers.ts";
import { hasChrome, type Page, withPage } from "./smoke/chrome.ts";

const text = `document.body.innerText`;
const button = (label: string) =>
	`[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)} && !el.disabled)`;
const dialogButton = (label: string) =>
	`[...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
const tab = (label: string) =>
	`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
const labelled = (label: string) =>
	`document.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(label)}]`)})`;

/**
 * Opens Sancho's chat and its Access tab. It waits for the chat to be drawn first, with his panel open (the desktop's
 * width) or its button there to open it. Read before then, an open panel would be taken for a closed one and the
 * click would close it.
 */
async function sanchoAccess(page: Page) {
	await page.run(`location.hash = '#/a/sancho'`);
	await page.until(`Boolean(${tab("Access")}) || Boolean(${labelled("Sancho: open its panel")})`);
	if (!(await page.run<boolean>(`Boolean(${tab("Access")})`))) await page.click(labelled("Sancho: open its panel"));
	await page.click(tab("Access"));
}

/** Moves the page's clock `ms` ahead of the computer's, as time passing would; a reload sets it right. */
const later = (ms: number) =>
	`(() => { window.__now ??= Date.now.bind(Date); window.__ahead = (window.__ahead ?? 0) + ${ms}; Date.now = () => window.__now() + window.__ahead; })()`;

/** A clipboard of the page's own, which the test reads: what was written last, and a read the page may make. */
const FAKE_CLIPBOARD = `(() => {
	window.__clip = "";
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text) => { window.__clip = text; }, readText: async () => window.__clip },
	});
})()`;

/** Everything the page keeps: its document, its storage, and every IndexedDB store's records. */
const KEPT = `(async () => {
	const stores = [];
	for (const { name } of (await indexedDB.databases?.()) ?? []) {
		const db = await new Promise((resolve, reject) => {
			const open = indexedDB.open(name);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		for (const store of db.objectStoreNames) {
			const rows = await new Promise((resolve) => {
				const got = db.transaction(store).objectStore(store).getAll();
				got.onsuccess = () => resolve(got.result);
				got.onerror = () => resolve([]);
			});
			stores.push(JSON.stringify(rows));
		}
		db.close();
	}
	return [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), ...stores].join("\\n");
})()`;

/**
 * The API of the daemon at `target`, passed through one upstream connection per browser connection, and the icons with
 * it, so nothing reaches whatever listens on the dev server's default port.
 */
const pinned = (target: string) => ({
	name: "api-per-connection",
	configResolved(config: { server: { proxy?: unknown } }) {
		delete config.server.proxy;
	},
	configureServer(server: {
		middlewares: { use: (handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
	}) {
		const agents = new WeakMap<object, Agent>();
		server.middlewares.use((req, res, next) => {
			const url = req.url ?? "";
			if (!url.startsWith("/api/") && !/^\/(?:icon[^/]*|apple-touch-icon\.png|manifest\.webmanifest)$/.test(url))
				return next();
			let agent = agents.get(req.socket);
			if (agent === undefined) {
				const made = new Agent({ keepAlive: true, maxSockets: 1 });
				agents.set(req.socket, made);
				req.socket.once("close", () => made.destroy());
				agent = made;
			}
			const upstream = request(
				`${target}${url}`,
				{ method: req.method, headers: { ...req.headers, host: new URL(target).host, origin: target }, agent },
				(answer) => {
					res.writeHead(answer.statusCode ?? 502, answer.headers);
					answer.pipe(res);
				},
			);
			upstream.on("error", () => res.destroy());
			req.pipe(upstream);
		});
	},
});

/** The path QrCode draws for `value`: what the Receive screen's code encodes is read back by drawing it again. */
function qrPath(value: string): string {
	const { data } = encode(value, { ecc: "M", border: 2 });
	return data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
}

/** A key an RPC's URL carries, which nothing but config.json may hold (H-195). */
const RPC_KEY = "s3cret-rpc-key";

let anvil: Anvil | undefined;
/** A second anvil, at Base's chain id, that Base reads in a test of wallets on two networks: no public chain is reached. */
let base: Anvil | undefined;
afterEach(async () => {
	await anvil?.stop();
	await base?.stop();
	anvil = undefined;
	base = undefined;
	vi.unstubAllEnvs();
	memoryKeystore().state = emptyState();
});

/** A daemon on a throwaway home whose wallets' keys are in the test keystore and whose local chain is an anvil. */
async function wallets(web?: string, reach?: "loopback", withBase = false, kind: "container" | "host" = "container") {
	vi.stubEnv("BANDA_TEST_KEYSTORE", "1");
	vi.stubEnv("BANDA_TEST_CHAIN", "1");
	memoryKeystore().state = emptyState();
	anvil = await startAnvil(["--chain-id", "31337"]);
	if (withBase) base = await startAnvil(["--chain-id", "8453"]);
	const home = join(await tempHome(), "home");
	await mkdir(home);
	await writeFile(
		join(home, "config.json"),
		JSON.stringify({
			model: { provider: "faux", modelId: "faux-1" },
			wallets: {
				rpc: { anvil: `${anvil.url}/?key=${RPC_KEY}`, ...(base === undefined ? {} : { base: base.url }) },
			},
		}),
	);
	const lines: string[] = [];
	const daemon = await startDaemon({
		home,
		port: 0,
		models: echoModels().models,
		log: (line) => lines.push(line),
		// a box, not host mode, where agents' commands would run as the owner and keep every wallet offline (H-064),
		// unless the test asks for host mode
		box: { ...hostBox(home), kind },
		...(web === undefined ? {} : { web }),
		...(reach === undefined ? {} : { remote: { reach } }),
	});
	const target = `http://127.0.0.1:${daemon.port}`;
	const token = (await readDaemonFile(home))?.token as string;
	const owner = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	await skipShippedSkills(daemon.port, token);
	await fetch(`${target}/api/bring`, {
		method: "POST",
		headers: owner,
		body: JSON.stringify({ skills: [], agents: [] }),
	});
	return {
		home,
		lines,
		daemon,
		target,
		token,
		chain: anvil,
		view: async () => (await (await fetch(`${target}/api/wallets`, { headers: owner })).json()) as WalletsView,
		check: (address: string) =>
			fetch(`${target}/api/wallets/${address}/check`, { method: "POST", headers: owner, body: "{}" }),
		/** Asks the daemon to read the wallet's chain now, as an open wallet page does, from outside the page. */
		wake: (address: string) => fetch(`${target}/api/wallets/${address}/incoming`, { headers: owner }),
		/** Removes a wallet as the owner's Remove does; answers the daemon's status. */
		remove: async (wallet: { address: string; version: number }) =>
			(
				await fetch(`${target}/api/wallets/${wallet.address}/remove`, {
					method: "POST",
					headers: owner,
					body: JSON.stringify({ version: wallet.version }),
				})
			).status,
		/** Sets a network's RPC, as Settings' Change does. */
		setRpc: (network: string, url: string) =>
			fetch(`${target}/api/wallets/rpc/${network}`, { method: "PUT", headers: owner, body: JSON.stringify({ url }) }),
		/** Archives a wallet as the owner's Archive does; answers the daemon's status. */
		archive: async (wallet: { address: string; version: number }) =>
			(
				await fetch(`${target}/api/wallets/${wallet.address}/archive`, {
					method: "POST",
					headers: owner,
					body: JSON.stringify({ version: wallet.version }),
				})
			).status,
		/** Skips saving a wallet's key, as the owner's Skip for now does. */
		skip: (address: string) =>
			fetch(`${target}/api/wallets/${address}/skip`, { method: "POST", headers: owner, body: "{}" }),
		/** Makes a wallet as the owner's API call does, with no page: no key is asked for. */
		create: async (name: string, network: string) => {
			const answer = await fetch(`${target}/api/wallets`, {
				method: "POST",
				headers: owner,
				body: JSON.stringify({ request: `create-${crypto.randomUUID()}`, name, network }),
			});
			if (!answer.ok) throw new Error(`making ${network}'s wallet: ${answer.status} ${await answer.text()}`);
			return ((await answer.json()) as { wallet: WalletsView["wallets"][number] }).wallet;
		},
	};
}

/** What a test does on a page: waits for words, saying the page's when they never come, and types into a field. */
function acts(page: Page) {
	const see = (words: string, ms?: number) =>
		page.until(`${text}.includes(${JSON.stringify(words)})`, ms).catch(async (error: Error) => {
			throw new Error(
				`${error.message}: ${words}\n${await page.run<string>(`location.hash + ' | ' + ${text}.slice(0, 2000)`)}`,
			);
		});
	const type = async (selector: string, words: string) => {
		await page.click(selector);
		await page.run(`(${selector}).select?.()`);
		await page.input("Input.insertText", { text: words });
	};
	/** Enter, pressed in the field that has the focus. */
	const enter = async () => {
		const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
		await page.input("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
		await page.input("Input.dispatchKeyEvent", { type: "keyUp", ...key });
	};
	/** Makes a wallet on the local chain: by Make wallet, or `byEnter` by Enter in its Name field. */
	const make = async (name: string, byEnter = false) => {
		await see("A wallet stays on the network it's made on.");
		await page.click(
			`[...document.querySelectorAll('[data-choice]')].find(el => el.textContent.includes('Local chain')).querySelector('[role="radio"]')`,
		);
		await type(`document.querySelector('input[placeholder^="Travel"]')`, name);
		if (byEnter) await enter();
		else await page.click(button("Make wallet"));
	};
	return { see, type, make, enter };
}

/** The Android shell's `Banda` plugin, in the page: each call goes to `bridge`, which the test sends over Iroh. */
const plugin = (bridge: string, daemon: string, device: string) => `(() => {
	const bridge = ${JSON.stringify(bridge)};
	const listeners = { chunk: [], end: [], link: [] };
	const emit = (event, value) => listeners[event].forEach((listener) => listener(value));
	const aborts = new Map();
	const base64 = (bytes) => { let text = ""; for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); return btoa(text); };
	const Banda = {
		request: async (options) => (await fetch(bridge + "/request", { method: "POST", body: JSON.stringify(options) })).json(),
		stream: async (options) => {
			const control = new AbortController();
			aborts.set(options.id, control);
			const response = await fetch(bridge + "/stream", { method: "POST", body: JSON.stringify(options), signal: control.signal });
			const head = { status: Number(response.headers.get("x-status")), headers: JSON.parse(response.headers.get("x-headers")) };
			(async () => {
				const reader = response.body.getReader();
				try {
					for (;;) { const { done, value } = await reader.read(); if (done) break; emit("chunk", { id: options.id, data: base64(value) }); }
					emit("end", { id: options.id });
				} catch (error) { emit("end", { id: options.id, error: String(error) }); }
			})();
			return head;
		},
		cancel: async ({ id }) => { aborts.get(id)?.abort(); aborts.delete(id); },
		addListener: async (event, listener) => { listeners[event].push(listener); return { remove: async () => { listeners[event] = listeners[event].filter((each) => each !== listener); } }; },
		state: async () => ({ daemon: ${JSON.stringify(daemon)}, device: ${JSON.stringify(device)}, name: "Pixel 9" }),
		setDaemon: async () => {}, keepDaemon: async () => {}, revertDaemon: async () => {}, forget: async () => {},
	};
	window.Capacitor = { isNativePlatform: () => true, Plugins: { Banda } };
})();`;

/** What the shell's plugin does, over `connection` from the paired device; `carried` keeps every path it sent. */
function irohBridge(connection: Awaited<ReturnType<Awaited<ReturnType<typeof testDevice>>["dial"]>>) {
	const carried: string[] = [];
	const overIroh = (method: string, path: string, headers: Record<string, string>) =>
		http.request({
			method,
			path,
			createConnection: () => streamSocket(connection.openBi()),
			headers: { ...headers, host: "banda.iroh" },
		});
	const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-status, x-headers" };
	const server = http.createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const options = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				method?: string;
				path: string;
				headers: Record<string, string>;
				body?: string;
			};
			carried.push(`${options.method ?? "GET"} ${options.path}`);
			const out = overIroh(options.method ?? "GET", options.path, options.headers);
			out.on("error", () => res.destroy());
			if (req.url === "/stream") {
				res.on("close", () => out.destroy());
				out.on("response", (answer) => {
					res.writeHead(200, {
						...cors,
						"x-status": String(answer.statusCode ?? 0),
						"x-headers": JSON.stringify(answer.headers),
					});
					res.flushHeaders();
					answer.pipe(res);
				});
				out.end();
				return;
			}
			out.on("response", (answer) => {
				const body: Buffer[] = [];
				answer.on("data", (chunk: Buffer) => body.push(chunk));
				answer.on("end", () => {
					res.writeHead(200, { ...cors, "content-type": "application/json" });
					res.end(
						JSON.stringify({
							status: answer.statusCode ?? 0,
							headers: Object.fromEntries(Object.entries(answer.headers).map(([key, value]) => [key, String(value)])),
							body: Buffer.concat(body).toString("base64"),
						}),
					);
				});
			});
			out.end(options.body === undefined ? undefined : Buffer.from(options.body, "base64"));
		})();
	});
	return {
		carried,
		url: async () => {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		},
		close: async () => {
			await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
			server.closeAllConnections();
		},
	};
}

if (!hasAnvil()) it.skip(NO_ANVIL, () => {});

for (const width of [390, 1280] as const)
	it.skipIf(!hasChrome() || !hasAnvil())(
		`gives an agent a wallet, saves its key, receives, and keeps it right through its notices at ${width}px`,
		async () => {
			const { home, lines, daemon, target, token, chain, view, check, wake } = await wallets();
			const server = await webServer({ plugins: [pinned(target)] });
			try {
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page: Page) => {
					const { see, type, make, enter } = acts(page);
					await page.until(`document.body.textContent.includes('Sancho')`);
					// Settings' tab is in the address, so the browser's back returns to it
					await page.run(`location.hash = '#/settings'`);
					await page.click(tab("Wallets"));
					await page.until(`location.hash === '#/settings?tab=wallets'`);
					await see("No wallet yet");
					await see("Any program you run on this computer can use these wallets"); // TA-1 (H-016)
					// each network's RPC, masked: the local chain's is the anvil config.json sets, with a key in its URL
					await see(`${chain.url}/•••`);
					expect(await page.run<string>(text)).not.toContain(RPC_KEY);
					// a new one is typed fresh, refused in words that quote nothing of it, and shown masked once taken
					await page.click(labelled("Change Local chain's RPC"));
					const rpc = `document.querySelector('input[placeholder="https://…"]')`;
					await page.until(`${rpc}.value === ''`);
					// the form takes the button's place, and the focus goes into its field
					await page.until(`document.activeElement === ${rpc}`);
					await type(rpc, "http://10.0.0.1:8545/?key=hidden-one");
					await page.click(button("Save"));
					await see("This RPC names a private address: only localhost is taken");
					expect(await page.run<string>(text)).not.toContain("config.json");
					expect(await page.run<string>(text)).not.toContain("hidden-one");
					expect(await page.run<string>(text)).not.toContain("10.0.0.1");
					await type(rpc, `${chain.url}/?key=other-${RPC_KEY}`);
					await page.click(button("Save"));
					await page.until(`!${rpc}`);
					// closed, the focus is back on the network's Change, never left on the page
					await page.until(
						`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify("Change Local chain's RPC")}`,
					);
					await see(`${chain.url}/•••`);
					expect(await page.run<string>(text)).not.toContain(RPC_KEY);
					expect(JSON.stringify(await view())).not.toContain(RPC_KEY);

					// Sancho has none: his Access gives him one, made with him chosen
					await page.run(`location.hash = '#/a/sancho'`);
					await page.click(labelled("Sancho: open its panel"));
					await page.click(tab("Access"));
					await see("Sancho has no wallet");
					// in the panel's width, the words keep a column at least as wide as the action beneath them
					expect(
						await page.run<boolean>(`(() => {
							const row = document.querySelector('[data-no-wallet]');
							const words = row.querySelector('span').getBoundingClientRect();
							const action = row.querySelector('button').getBoundingClientRect();
							return words.width >= action.width && action.right <= row.getBoundingClientRect().right + 0.5;
						})()`),
					).toBe(true);
					await page.click(button("Give Sancho a wallet"));
					await page.until(`location.hash === '#/wallets/new?agent=sancho'`);
					await see("Sancho may read it");
					// a browser, not the desktop app: before making one, the page says an extension can read the key (H-272)
					await see("An extension in this browser can read the key shown next");
					await see("banda wallet create");
					// Enter in its Name field makes it, as Make wallet does
					await make("Groceries", true);
					await see("Save Groceries's key");
					const [made] = (await view()).wallets;
					// once made, the address bar names the wallet's key page, so a reload never offers a second one
					await page.until(`location.hash === '#/wallets/${walletRoute(made?.address as string)}/key'`);
					expect(made).toMatchObject({
						name: "Groceries",
						network: "anvil",
						state: "ready",
						backup: "unsaved",
						// made on for no agent, though it was made for Sancho: he is switched on once the save step ends (UC-01, H-001)
						agents: [],
					});
					const address = made?.address as string;

					// hidden, the key is announced as hidden and never read; shown, it is read group by group (H-281)
					const box = `document.querySelector('.font-code.blur-sm, [data-key]')`;
					expect(await page.run(`${box}.getAttribute('aria-hidden')`)).toBe("true");
					await page.until(`document.body.textContent.includes("Private key, hidden")`);
					// nothing is fetched before Show key: no showing is listed, and a window that loses focus drops nothing
					expect((await view()).wallets[0]?.revealed).toBeUndefined();
					await page.run(`window.dispatchEvent(new Event('blur'))`);
					await page.click(button("Show key"));
					await page.until(`document.querySelector('[data-key]')`);
					// the shown step takes Show key's place: the focus goes to its Copy key, never to the page
					await page.until(`document.activeElement?.textContent.includes('Copy key')`);
					expect(await page.run(`document.querySelector('[data-key]').getAttribute('aria-hidden')`)).toBeNull();
					expect(await page.run<string>("document.body.textContent")).not.toContain("Private key, hidden");
					// drawn in groups by a gap, with no space in it: a copy selected by hand is the key wallet apps take
					const key = await page.run<string>(`document.querySelector('[data-key]').textContent`);
					expect(key).toMatch(/^0x[0-9a-f]{64}$/);
					// and a copy of any selection in it writes the key whole
					expect(
						await page.run<string>(`(() => {
							const data = new DataTransfer();
							const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
							document.querySelector('[data-key] span:nth-child(3)').dispatchEvent(event);
							return data.getData('text/plain');
						})()`),
					).toBe(key);
					expect(privateKeyToAddress(key as `0x${string}`)).toBe(address);

					// copied, the clipboard holds it and counts down, saying a clipboard manager may keep it (H-271)
					await page.run(FAKE_CLIPBOARD);
					await page.click(button("Copy key"));
					await page.until(`window.__clip === ${JSON.stringify(key)}`);
					await see("Your clipboard clears itself in");
					await see("A clipboard manager");
					// 30 seconds on, the key hides again (H-270), and Show key shows it again
					await page.run(later(31_000));
					await page.until(`!document.querySelector('[data-key]')`);
					expect(await page.run(`${box}.getAttribute('aria-hidden')`)).toBe("true");
					expect(await page.run<string>("window.__clip")).toBe(key);
					await page.click(button("Show key"));
					await page.until(`document.querySelector('[data-key]')`);
					// the window loses focus: the key leaves the page (H-274)
					await page.run(`window.dispatchEvent(new Event('blur'))`);
					await page.until(`!document.querySelector('[data-key]')`);
					await see("The key left this screen");

					// a wrong copy leaves it Not backed up; the right one backs it up
					await page.click(button("I saved it"));
					await see("Check your copy");
					expect(await page.run(button("Show key again"))).toBeFalsy();
					const copy = `document.querySelector('input[placeholder="0x…"]')`;
					// the check takes I saved it's place: the focus goes into its field
					await page.until(`document.activeElement === ${copy}`);
					await type(copy, `${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`);
					await page.click(button("Check"));
					await see("This doesn't open");
					expect((await view()).wallets[0]?.backup).toBe("unsaved");
					// a page that can't take a digest says so, and sends nothing: no copy leaves it whole
					await page.run(`(() => {
						window.__sent = [];
						const sent = window.fetch;
						window.__fetch = sent;
						window.fetch = (url, init) => { window.__sent.push(String(url)); return sent(url, init); };
						Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: () => Promise.reject(new Error("no digest here")) });
					})()`);
					await type(copy, key);
					await page.click(button("Check"));
					await see("Couldn't check your copy");
					expect(await page.run<string[]>("window.__sent")).not.toContainEqual(expect.stringContaining("/saved"));
					await page.run(`(() => { delete crypto.subtle.digest; window.fetch = window.__fetch; })()`);
					expect((await view()).wallets[0]?.backup).toBe("unsaved");
					// a copy kept in groups of four is checked without its spaces, and said so on the step it leads to,
					// never over its buttons
					await type(copy, `0x ${(key.slice(2).match(/.{4}/g) ?? []).join(" ")}`);
					// Enter in the field checks it, as Check does; the step it leads to takes the focus on its heading
					await enter();
					await see("Groceries is backed up");
					await page.until(
						`document.activeElement?.tagName === 'H2' && document.activeElement.textContent.includes('is backed up')`,
					);
					await page.until(`document.querySelector('[data-spaced]')`);
					expect((await view()).wallets[0]?.backup).toBe("saved");

					// the save step ended: Sancho, chosen as it was made, is switched on (UC-01)
					await until(async () => ((await view()).wallets[0]?.agents.includes("sancho") ? true : undefined));
					// Receive gives the address, whole and in groups, and says which network it is on
					await page.click(button("Receive"));
					await see("On Local chain only");
					await until(async () => ((await view()).wallets[0]?.agents.includes("sancho") ? true : undefined));
					const shown = (await page.run<string>(`document.querySelector('[data-address]').textContent`)).replace(
						/\s+/g,
						"",
					);
					expect(shown).toBe(address);
					// its QR code is the plain EIP-55 address alone: no "ethereum:" URI, no chain or amount (H-259)
					expect(
						await page.run<string>(
							`document.querySelector('svg[role="img"][shape-rendering="crispEdges"] path').getAttribute('d')`,
						),
					).toBe(qrPath(address));
					expect((await view()).wallets[0]?.disclosed).toBe(true);
					// a minute after the copy, the clipboard is cleared, though the page that copied it is gone
					expect(await page.run<string>("window.__clip")).toBe(key);
					await page.run(later(30_000));
					await page.until(`window.__clip === ''`);
					// and the key is nowhere the page keeps
					const kept = (await page.run<string>(KEPT)).replace(/\s+/g, "");
					expect(kept).not.toContain(key.slice(2));

					// Settings → Wallets shows its balance as read, and the money sent to it from an anvil account once a read of
					// the chain sees it, on the page already open; the wallet's activity lists it (UC-14 A3)
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("0 ETH", 60_000);
					await chain.raw("eth_sendTransaction", [{ from: DEV0.address, to: address, value: "0xde0b6b3a7640000" }]);
					// blocks on top, so the money is at `safe`, where removal reads the balance (C17)
					await chain.raw("anvil_mine", ["0x80"]);
					await wake(address);
					await see("1 ETH", 60_000);
					// the row's figure is dated by the block it was read at (C22), never a bare figure as if it were now
					await page.until(
						`[...document.querySelectorAll('[data-read]')].some(el => /at block \\d/.test(el.textContent))`,
					);
					await page.run(`location.hash = '#/wallets/${address}'`);
					await see("+1 ETH", 60_000);
					await see("From another address");
					// a row of money that came in opens nothing: it is no button, its explorer link aside
					expect(
						await page.run<boolean>(
							`[...document.querySelectorAll('button')].some((each) => each.textContent.includes('From another address'))`,
						),
					).toBe(false);
					// the key shown at its creation is in the wallet's own activity, beside the money (UC-02 A2, H-266)
					await see("Key shown as the wallet was made");
					await page.until(`document.querySelector('[data-note]')`);
					// a read of the activity that fails says so, and Try again reads it again
					const failing = `(() => {
						window.__fetch = window.fetch;
						window.fetch = (url, init) =>
							String(url).includes('/incoming')
								? Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 503, headers: { 'content-type': 'application/json' } }))
								: window.__fetch(url, init);
					})()`;
					// after a good one, on the page already open: the rows stay, said to be the last read
					await page.run(failing);
					await chain.raw("eth_sendTransaction", [{ from: DEV0.address, to: address, value: "0x6f05b59d3b20000" }]);
					await chain.raw("anvil_mine", ["0x80"]);
					await wake(address);
					await see("1.5 ETH", 60_000);
					await see("What's below is what banda read last");
					await see("+1 ETH");
					expect(await page.run<string>(text)).not.toContain("+0.5 ETH");
					await page.run(`void (window.fetch = window.__fetch)`);
					await page.click(button("Try again"));
					await see("+0.5 ETH");
					await page.until(`!${text}.includes("What's below is what banda read last")`);
					// with none read yet, the failure alone
					await page.run(failing);
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Groceries");
					await page.run(`location.hash = '#/wallets/${address}'`);
					await see("Couldn't read this wallet's activity");
					await page.run(`void (window.fetch = window.__fetch)`);
					await page.click(button("Try again"));
					await see("+1 ETH");
					// money that comes in while the page is open is dated without a reload: its block's time is read behind the
					// list, and the push that follows makes the page read it again (C22, UC-14); never an Earlier above Today
					await chain.raw("eth_sendTransaction", [{ from: DEV0.address, to: address, value: "0x3782dace9d90000" }]);
					await chain.raw("anvil_mine", ["0x80"]);
					await wake(address);
					await see("+0.25 ETH", 60_000);
					await page.until(
						`(() => { const said = ${text}; return said.includes("+0.25 ETH") && !/\\bEarlier\\b/.test(said) && !/·\\s*block \\d/.test(said); })()`,
						60_000,
					);

					// Sancho switched off from his Access, then on from the wallet's Agents
					await sanchoAccess(page);
					await page.click(labelled(`Sancho may read Groceries (${shortAddress(address)})`));
					await until(async () => ((await view()).wallets[0]?.agents.length === 0 ? true : undefined));
					await page.run(`location.hash = '#/wallets/${address}?tab=agents'`);
					await see("Which agents may read this wallet");
					// H-070: what slice 1's tools send, the wallet's address and balance, and nothing they do not
					await see("its address, network and balance, goes to its model provider");
					expect(await page.run<string>(text)).not.toContain("the money that came in, goes");
					await page.click(labelled("Sancho may read it"));
					await until(async () => ((await view()).wallets[0]?.agents.includes("sancho") ? true : undefined));
					await page.until(`${labelled("Sancho may read it")}.getAttribute('aria-checked') === 'true'`);

					// Settings → Connections and the catalogue never list it: a wallet is shown only under Wallets
					await page.run(`location.hash = '#/settings?tab=connections'`);
					await page.until(`document.querySelector('[role="tabpanel"]')`);
					expect(await page.run<string>(`document.querySelector('[role="tabpanel"]').innerText`)).not.toContain(
						"Groceries",
					);
					await page.run(`location.hash = '#/connections'`);
					await see("Add MCP server");
					expect(await page.run<string>(text)).not.toContain("Wallets your agents can pay from");
					expect(await page.run<string>(text)).not.toContain("Groceries");

					// the keychain locked at its last check: the notice, and its Try again checks the key again
					memoryKeystore().state.faults.push({
						point: "keychain:read",
						account: "/wallet/",
						throw: "User interaction is not allowed.",
						times: 1,
					});
					await check(address);
					await page.run(`location.hash = '#/wallets/${address}'`);
					await page.reload();
					await see("Keychain locked");
					await page.click(button("Try again"));
					await page.until(`!${text}.includes("Keychain locked")`);
					// the notice is gone with its button: a toast says the key answers, and the focus is on the page's title
					await see("Groceries's key answers again");
					await page.until(`document.activeElement === document.querySelector('h1[data-page-title]')`);

					// another home holds the lease: the notice, with no move outside the desktop app
					const state = memoryKeystore().state;
					const item = Object.keys(state.items).find((each) => each.includes("/lease")) as string;
					const lease = JSON.parse(state.items[item] as string) as { epoch: number; holder: string };
					state.items[item] = JSON.stringify({ epoch: lease.epoch + 1, holder: "e".repeat(64) });
					await check(address);
					await page.reload();
					await see("Another home signs for this wallet");
					expect(await page.run(button("Move signing here"))).toBeFalsy();
					// offline, the wallet is switched for an agent the same from its page and from the agent's Access (UC-05)
					const sanchoSwitch = (label: string) => `(() => {
						const one = ${labelled(label)};
						return one === null ? "none" : one.disabled ? "disabled" : "enabled";
					})()`;
					await page.run(`location.hash = '#/wallets/${address}?tab=agents'`);
					await see("Which agents may read this wallet");
					const fromPage = await page.run<string>(sanchoSwitch("Sancho may read it"));
					await sanchoAccess(page);
					await page.until(`${labelled(`Sancho may read Groceries (${shortAddress(address)})`)}`);
					expect(await page.run<string>(sanchoSwitch(`Sancho may read Groceries (${shortAddress(address)})`))).toBe(
						fromPage,
					);
					expect(fromPage).toBe("enabled");
					// and the agent's Access says why the agent can't use it now, from the one list of reasons (H-317)
					expect(
						await page.run<string>(
							`${labelled(`Sancho may read Groceries (${shortAddress(address)})`)}.closest('label').querySelector('[data-reason]')?.textContent ?? ""`,
						),
					).toBe("Another home signs for this wallet");
					await page.run(`location.hash = '#/wallets/${address}'`);
					state.items[item] = JSON.stringify({ epoch: lease.epoch + 2, holder: lease.holder });
					await check(address);
					await page.reload();
					await see("Groceries");
					await page.until(`!${text}.includes("Another home signs for this wallet")`);

					// the key's item is gone: outside the desktop app the notice says where it is restored, with no Restore
					const account = Object.keys(state.items).find((each) => each.endsWith(`/wallet/${address}`)) as string;
					const stored = state.items[account] as string;
					delete state.items[account];
					await check(address);
					await page.reload();
					await see("Key missing");
					await see("Restore it in banda's desktop app");
					expect(await page.run(button("Restore key"))).toBeFalsy();
					// in the desktop app on a computer that can't ask who the owner is (no Touch ID), which refuses a Restore
					// and a later reveal (H-266): neither is offered, and the wallet says its key isn't shown again
					const { identifier: cannot } = (await page.input("Page.addScriptToEvaluateOnNewDocument", {
						source: `window.bandaDesktop = {
							chooseFolder: async () => undefined,
							attention: () => {},
							reauthenticates: false,
							revealKey: async () => ({ ok: false, code: "no_reauthentication" }),
							restoreKey: async () => ({ ok: false, code: "no_reauthentication" }),
						};`,
					})) as { identifier: string };
					await page.reload();
					await see("Key missing");
					expect(await page.run(button("Restore key"))).toBeFalsy();
					await page.run(`location.hash = '#/wallets/${address}?tab=wallet'`);
					await see("This computer can't confirm it's you, so banda doesn't show the key again here.");
					await page.until(
						`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Show' && el.disabled)`,
					);
					// its key page, the key gone, says so instead of offering a copy to check or a key to show
					await page.run(`location.hash = '#/wallets/${walletRoute(address)}/key'`);
					await see("Key missing");
					expect(await page.run<string>(text)).not.toContain("Touch ID before banda shows");
					expect(await page.run(button("Check your copy"))).toBeFalsy();
					expect(await page.run(button("Show key"))).toBeFalsy();
					await page.input("Page.removeScriptToEvaluateOnNewDocument", { identifier: cannot });
					await page.run(`location.hash = '#/wallets/${address}'`);
					// in the desktop app that asks, Restore key opens its page, and the pasted copy goes to the app alone (C20)
					const { identifier } = (await page.input("Page.addScriptToEvaluateOnNewDocument", {
						source: `window.bandaDesktop = {
							chooseFolder: async () => undefined,
							attention: () => {},
							reauthenticates: true,
							restoreKey: (address, key) => new Promise((answer) => { window.__restore = { address, key, answer }; }),
						};`,
					})) as { identifier: string };
					await page.reload();
					await see("Key missing");
					await page.click(button("Restore key"));
					await page.until(`location.hash === '#/wallets/${walletRoute(address)}/restore'`);
					await see(`It must open`);
					const saved = `document.querySelector('input[placeholder="0x…"]')`;
					// a key that opens another address changes nothing, and says so
					const another = `0x${"cd".repeat(32)}`;
					await type(saved, another);
					await page.click(button("Restore"));
					await page.until(`window.__restore?.key === ${JSON.stringify(another)}`);
					expect(await page.run<string>(`window.__restore.address`)).toBe(address);
					await page.run(`window.__restore.answer({ ok: false, code: "wrong_key" })`);
					await see("This key doesn't open");
					expect((await view()).wallets[0]?.signing?.state).toBe("key_missing");
					// its own key, kept by the app's signer, brings it back once the daemon checks it again
					await page.run(`window.__restore = undefined`);
					await type(saved, stored);
					await page.click(button("Restore"));
					await page.until(`window.__restore?.key === ${JSON.stringify(stored)}`);
					state.items[account] = stored;
					await check(address);
					await page.run(`window.__restore.answer({ ok: true })`);
					await see("Groceries is back online");
					expect((await page.run<string>(KEPT)).replace(/\s+/g, "")).not.toContain(stored.slice(2));
					await page.click(button("Done"));
					await page.until(`location.hash === '#/wallets/${walletRoute(address)}'`);
					await page.until(`!${text}.includes("Key missing")`);
					await page.input("Page.removeScriptToEvaluateOnNewDocument", { identifier });
					await page.reload();
					await see("Groceries");

					// archived and brought back; removing it is refused while it holds money (C17)
					await page.run(`location.hash = '#/wallets/${address}?tab=wallet'`);
					// archiving asks first; unarchiving does not
					await page.click(button("Archive"));
					await page.until(
						`document.querySelector('[role="alertdialog"]')?.textContent.includes('Archive Groceries?')`,
					);
					await page.click(dialogButton("Archive"));
					await see("Money sent to it still arrives");
					expect((await view()).wallets[0]?.state).toBe("archived");
					// Archive is gone with the archive: the focus goes to the page's title, never to the page
					await page.until(`document.activeElement === document.querySelector('h1[data-page-title]')`);
					// its Receive, reached by a kept link or Back, says it is archived in the address's place and offers
					// Unarchive: it asks the daemon nothing, which refuses an archived wallet's address and no Try again mends
					await page.run(`(() => {
						window.__sent = [];
						window.__fetch = window.fetch;
						window.fetch = (url, init) => { window.__sent.push(String(url)); return window.__fetch(url, init); };
					})()`);
					await page.run(`location.hash = '#/wallets/${address}/receive'`);
					await see("Money sent to it still arrives");
					expect(await page.run<string>(text)).not.toContain("Checking the address");
					expect(await page.run<string>(text)).not.toContain("Couldn't open Receive");
					expect(await page.run<string[]>("window.__sent")).not.toContainEqual(expect.stringContaining("/receive"));
					await page.click(button("Unarchive"));
					// unarchived, the address is asked for then, and shown
					await see("On Local chain only");
					expect((await view()).wallets[0]?.state).toBe("ready");
					await page.run(`void (window.fetch = window.__fetch)`);
					await page.run(`location.hash = '#/wallets/${address}?tab=wallet'`);
					await page.until(`Boolean(${button("Remove")})`);
					expect(await page.run<string>(text)).not.toContain("Money sent to it still arrives");
					await page.click(button("Remove"));
					await page.click(dialogButton("Remove"));
					// refused: the dialog says why, and the same removal again cannot help, so it offers only Close
					await page.until(
						`document.querySelector('[role="alertdialog"]')?.textContent.includes("Groceries can't be removed yet")`,
					);
					await see("The wallet still holds funds");
					expect(
						await page.run<string[]>(
							`[...document.querySelectorAll('[role="alertdialog"] button')].map(el => el.textContent.trim())`,
						),
					).toEqual(["Close"]);
					await page.click(dialogButton("Close"));
					await page.until(`!document.querySelector('[role="alertdialog"]')`);
					expect((await view()).wallets[0]?.state).toBe("ready");

					// from Settings → Wallets to the wallet, and the browser's back returns to Wallets
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Groceries");
					expect(await page.run<string>(text)).not.toContain("Not backed up");
					await page.click(`[...document.querySelectorAll('button')].find(el => el.textContent.includes('Groceries'))`);
					await page.until(`location.hash === '#/wallets/${walletRoute(address)}'`);
					await page.run(`history.back()`);
					await page.until(`location.hash === '#/settings?tab=wallets'`);
					await page.until(`${tab("Wallets")}.getAttribute('aria-selected') === 'true'`);
					expect(page.errors()).toEqual([]);

					// the key is in no file of the home, blob or log
					expect(holdingKey(home, key)).toEqual([]);
					expect(lines.join("\n")).not.toContain(key.slice(2));
					expect(lines.join("\n")).not.toContain(RPC_KEY);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		180_000,
	);

/**
 * Where text holding `words` is drawn outside the window, line by line, as `{ found, out }`: whether any was drawn, and
 * each line past an edge. Text an ellipsis cuts is left out: its full words are in its `title`. Unlike `sideways`, it
 * sees text that runs out of the pane's own scroll container.
 */
const drawnInside = (words: string) => `(() => {
	const words = ${JSON.stringify(words)};
	const cut = (el) => { for (let at = el; at; at = at.parentElement) if (getComputedStyle(at).textOverflow === 'ellipsis') return true; return false; };
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	let found = false;
	const out = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = node.parentElement;
		if (!node.textContent.includes(words) || !parent || parent.getClientRects().length === 0 || cut(parent)) continue;
		found = true;
		const range = document.createRange();
		range.selectNodeContents(node);
		for (const line of range.getClientRects())
			if (line.left < -0.5 || line.right > window.innerWidth + 0.5) out.push(parent.tagName + ':' + Math.round(line.left) + '-' + Math.round(line.right));
	}
	return { found, out };
})()`;

/** Whether the page scrolls sideways: wider than the window it is drawn in. */
const sideways = `document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth`;

for (const width of [375, 390, 1280] as const)
	it.skipIf(!hasChrome() || !hasAnvil())(
		`lists three wallets on two networks, testnets marked and every name one plain line, at ${width}px`,
		async () => {
			const { daemon, target, token, chain, view, wake, create, skip, setRpc } = await wallets(
				undefined,
				undefined,
				true,
			);
			const server = await webServer({ plugins: [pinned(target)] });
			try {
				const travel = await create("Travel", "base");
				const bills = await create("Bills\u202E gas\nmonthly", "anvil");
				// the name is kept as one plain line: no bidi override, no line break (H-041)
				expect(bills.name).toBe("Bills gas monthly");
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page: Page) => {
					const { see, type } = acts(page);
					await page.until(`document.body.textContent.includes('Sancho')`);

					// a name another wallet has is said, and allowed: the two are told apart by address
					await page.run(`location.hash = '#/wallets/new'`);
					await see("A wallet stays on the network it's made on.");
					await type(`document.querySelector('input[placeholder^="Travel"]')`, "travel");
					await see("You already have a wallet named travel");
					await page.click(
						`[...document.querySelectorAll('[data-choice]')].find(el => el.textContent.includes('Local chain')).querySelector('[role="radio"]')`,
					);
					await page.click(button("Make wallet"));
					await see("Save travel's key");
					await page.click(button("Skip for now"));
					await see("Not backed up");
					const local = (await view()).wallets.find((each) => each.name === "travel");
					expect(local?.network).toBe("anvil");
					// skipped with the key never shown: nothing was revealed, so no showing is listed (H-266)
					expect(local?.revealed).toBeUndefined();
					expect(await page.run<string>(text)).not.toContain("Key shown as the wallet was made");
					// the wallet's page says its network is a test one, beside its address
					expect(await page.run<string>(text)).toContain("Testnet");
					expect(await page.run<boolean>(sideways)).toBe(false);

					// Settings → Wallets: one row each, the testnet ones marked, the Base one not
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Bills gas monthly");
					const rows = `[...document.querySelectorAll('button')].filter(el => el.querySelector('.font-code') && el.querySelector('.truncate.font-medium'))`;
					await page.until(`${rows}.length === 3`);
					const marks = await page.run<Record<string, boolean>>(
						`Object.fromEntries(${rows}.map(el => [el.querySelector('.truncate.font-medium').textContent, el.textContent.includes('Testnet')]))`,
					);
					expect(marks).toEqual({ Travel: false, "Bills gas monthly": true, travel: true });
					// no line of a row starts with a separator: a part that starts a line has it in the margin the row clips
					expect(
						await page.run<boolean>(
							`[...document.querySelectorAll('[data-meta]')].every(meta => { const left = meta.getBoundingClientRect().left; const network = meta.querySelector('[data-network]').parentElement.getBoundingClientRect(); const short = meta.querySelector('[data-short]').getBoundingClientRect(); return network.left < left && (Math.abs(short.top - network.top) < 2 || short.left < left); })`,
						),
					).toBe(true);
					// the name as drawn is the plain line: nothing that reorders or breaks it reaches the page
					expect(await page.run<string>(text)).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
					expect(await page.run<boolean>(sideways)).toBe(false);
					expect(travel.address).not.toBe(local?.address);

					// two wallets of one name on one network: Sancho's Access tells them apart by address, and so do their
					// switches (H-041)
					const twin = await create("Travel", "base");
					await sanchoAccess(page);
					for (const one of [travel, twin]) {
						await page.until(`${labelled(`Sancho may read Travel (${shortAddress(one.address)})`)}`);
						expect(
							await page.run<string>(
								`${labelled(`Sancho may read Travel (${shortAddress(one.address)})`)}.closest('label').querySelector('[data-short]').textContent`,
							),
						).toBe(shortAddress(one.address));
					}
					expect(shortAddress(travel.address)).not.toBe(shortAddress(twin.address));
					expect(await page.run<boolean>(sideways)).toBe(false);

					// Receive's caption marks the test network too
					await page.run(`location.hash = '#/wallets/${local?.address}/receive'`);
					await see("On Local chain only");
					await see("It's a test network");
					expect(await page.run<string>(`document.querySelector('[data-address]').parentElement.innerText`)).toContain(
						"Testnet",
					);
					expect(await page.run<boolean>(sideways)).toBe(false);

					// a name of 64 characters with no space stays inside the window, on Receive and on Save your key
					const long = await create("x".repeat(64), "anvil");
					expect((await skip(long.address)).ok).toBe(true);
					await page.run(`location.hash = '#/wallets/${long.address}/receive'`);
					await see("On Local chain only");
					expect(await page.run<boolean>(sideways)).toBe(false);
					const inside = `[...document.querySelectorAll('[data-address]')[0].parentElement.querySelectorAll('*')].every(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth; })`;
					expect(await page.run<boolean>(inside)).toBe(true);
					await page.run(`location.hash = '#/wallets/${long.address}/key'`);
					await see("See the key in banda's desktop app");
					expect(await page.run<boolean>(sideways)).toBe(false);

					// money in a wallet whose key isn't saved: one reminder, and never again on this device (H-273). The owner
					// stays in a chat: the reminder comes there, when the balance passes the threshold, with no wallet screen open
					await page.run(`location.hash = '#/a/sancho'`);
					await chain.raw("eth_sendTransaction", [
						{ from: DEV0.address, to: local?.address, value: "0xde0b6b3a7640000" },
					]);
					await chain.raw("anvil_mine", ["0x1"]);
					await wake(local?.address as string);
					await see("travel holds money, and its key isn't saved", 60_000);
					// two Travels and a travel: the reminder says which one by its short address and network (H-041)
					await see(`${shortAddress(local?.address as string)} on Local chain.`);
					expect(await page.run<string>(`location.hash`)).toBe("#/a/sancho");
					expect(await page.run<boolean>(`Boolean(${button("Save your key")})`)).toBe(true);
					await page.reload();
					// not again on this device: not in the chat, nor on Settings, Wallets, nor on the wallet's page
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("1 ETH", 60_000);
					expect(await page.run<string>(text)).not.toContain("holds money, and its key isn't saved");
					await page.run(`location.hash = '#/wallets/${local?.address}'`);
					await see("+1 ETH", 60_000);
					expect(await page.run<string>(text)).not.toContain("holds money, and its key isn't saved");

					// the chain stops answering: the balance is unknown and says since when, the last figure only dated,
					// never zero, and the network's row says it is not answering (UC-04 E1, H-208)
					const dead = await new Promise<number>((resolve) => {
						const server = http.createServer();
						server.listen(0, "127.0.0.1", () => {
							const { port } = server.address() as AddressInfo;
							server.close(() => resolve(port));
						});
					});
					expect((await setRpc("anvil", `http://127.0.0.1:${dead}/`)).ok).toBe(true);
					await wake(local?.address as string);
					await see("banda can't reach Local chain since", 60_000);
					await see("Last read: 1 ETH,");
					// the money listed is said as listed: what is missing is what came in after the block last read, never
					// "isn't listed yet" above a row that shows it (C22, H-207)
					await see("+1 ETH");
					await see("isn't listed.");
					expect(await page.run<string>(text)).toMatch(/money that came in after block [\d,]+ isn't listed\./);
					expect(await page.run<string>(text)).not.toContain("isn't listed yet");
					expect(
						await page.run<string>(`document.querySelector('[data-unreachable]').closest('section').innerText`),
					).not.toMatch(/^\s*1 ETH/m);
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Local chain not answering since");
					await see("Not answering since");
					await see("Balance unknown");
					expect(await page.run<boolean>(sideways)).toBe(false);
					// the line saying why a wallet can't pay wraps inside its row, never cut at a phone's width
					expect(
						await page.run<string[]>(
							`[...document.querySelectorAll('[data-reason]')].filter(el => { const box = el.getBoundingClientRect(); const row = el.closest('a, button').getBoundingClientRect(); return el.scrollWidth > el.clientWidth + 1 || box.right > row.right + 0.5; }).map(el => el.textContent)`,
						),
					).toEqual([]);
					// beside a balance that says why it is unknown, each row's network and its Testnet mark are drawn
					// whole inside the row's line, never clipped by it
					expect(
						await page.run<string[]>(
							`[...document.querySelectorAll('[data-meta]')].flatMap(meta => { const line = meta.getBoundingClientRect(); return [...meta.querySelectorAll('[data-network], [data-network] *')].filter(el => { const box = el.getBoundingClientRect(); return box.left < line.left - 0.5 || box.right > line.right + 0.5 || box.top < line.top - 0.5 || box.bottom > line.bottom + 0.5; }).map(el => el.textContent); })`,
						),
					).toEqual([]);
					// the since-when line wraps in its own narrow column: the wallet's name keeps the room it needs
					expect(
						await page.run<boolean>(`(() => {
							const said = document.querySelector('[data-unreachable]').parentElement.getBoundingClientRect();
							const row = document.querySelector('[data-unreachable]').closest('a, button').getBoundingClientRect();
							return said.width <= row.width / 2;
						})()`),
					).toBe(true);
					// an agent's Access says it the same way: the balance unknown since when, never a bare word (C22, H-208)
					await sanchoAccess(page);
					await see("Local chain not answering since");
					expect(await page.run<boolean>(sideways)).toBe(false);

					// an RPC of another chain, saved over the one that stopped answering: it answers, so the network is said
					// to serve another chain, never to be not answering, nor since a time before it was set (H-187, H-208)
					expect((await setRpc("anvil", base?.url as string)).ok).toBe(true);
					await wake(local?.address as string);
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Serves another chain: set an RPC of Local chain.", 60_000);
					await see("This network's RPC serves another chain");
					await see("Balance unknown");
					expect(await page.run<string>(text)).not.toContain("Local chain not answering since");
					expect(await page.run<string>(text)).not.toContain("Not answering since");
					expect((await view()).networks.find((each) => each.id === "anvil")?.unread).toBeUndefined();
					expect(await page.run<boolean>(sideways)).toBe(false);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		180_000,
	);

it.skipIf(!hasChrome() || !hasAnvil())(
	"keeps the agent a wallet was made for through a breadcrumb, the browser's Back and a reload, and switches it on once the save step ends, at 390px",
	async () => {
		const { daemon, target, token, view } = await wallets();
		const server = await webServer({ plugins: [pinned(target)] });
		try {
			await withPage(`${server.origin}/#token=${token}`, { width: 390, height: 900 }, async (page: Page) => {
				const { see, make } = acts(page);
				await page.until(`document.body.textContent.includes('Sancho')`);
				await sanchoAccess(page);
				await page.click(button("Give Sancho a wallet"));
				await see("Sancho may read it");
				await make("Groceries");
				await see("Save Groceries's key");
				const address = (await until(async () => (await view()).wallets[0]?.address)) as string;
				// left by the breadcrumb, before the key is saved: still on for no agent
				await page.click(`document.querySelector('nav[aria-label="Breadcrumb"] a')`);
				await page.until(`!location.hash.endsWith('/key')`);
				expect((await view()).wallets[0]?.agents).toEqual([]);
				// the browser's Back lands on its key page, and a reload there keeps the owner's choice too
				await page.run(`history.back()`);
				await page.until(`location.hash === '#/wallets/${walletRoute(address)}/key'`);
				await page.reload();
				await see("See the key in banda's desktop app");
				expect((await view()).wallets[0]?.agents).toEqual([]);
				// the save step ends on the key page: Sancho is switched on
				await page.click(button("Skip for now"));
				await until(async () => ((await view()).wallets[0]?.agents.includes("sancho") ? true : undefined));
				expect((await view()).wallets[0]?.backup).toBe("skipped");
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await server.close();
			await daemon.close();
		}
	},
	120_000,
);

it.skipIf(!hasChrome() || !hasAnvil())(
	"shows Receive's address once the network answers again, with no Try again, and a saved key's page offers no check, at 390px",
	async () => {
		const { daemon, target, token, chain, create, skip, setRpc } = await wallets();
		const server = await webServer({ plugins: [pinned(target)] });
		try {
			const travel = await create("Travel", "anvil");
			expect((await skip(travel.address)).ok).toBe(true);
			const dead = await new Promise<number>((resolve) => {
				const closed = http.createServer();
				closed.listen(0, "127.0.0.1", () => {
					const { port } = closed.address() as AddressInfo;
					closed.close(() => resolve(port));
				});
			});
			expect((await setRpc("anvil", `http://127.0.0.1:${dead}/`)).ok).toBe(true);
			await withPage(`${server.origin}/#token=${token}`, { width: 390, height: 900 }, async (page: Page) => {
				const { see } = acts(page);
				await page.until(`document.body.textContent.includes('Sancho')`);
				await page.run(`location.hash = '#/wallets/${walletRoute(travel.address)}/receive'`);
				await see("The address couldn't be checked", 60_000);
				expect(await page.run<boolean>(`Boolean(document.querySelector('[data-address]'))`)).toBe(false);
				// the network answers again: the address shows on the page already open
				expect((await setRpc("anvil", `${chain.url}/?key=${RPC_KEY}`)).ok).toBe(true);
				await page.until(`Boolean(document.querySelector('[data-address]'))`, 30_000);
				expect(
					(await page.run<string>(`document.querySelector('[data-address]').textContent`)).replace(/\s+/g, ""),
				).toBe(travel.address);

				// a wallet whose key is saved: its key page says nothing of checking a copy it does not offer
				const rent = await create("Rent", "anvil");
				const item = Object.entries(memoryKeystore().state.items).find(([account]) =>
					account.toLowerCase().includes(rent.address.slice(2).toLowerCase()),
				)?.[1] as string;
				const saved = await fetch(`${target}/api/wallets/${rent.address}/saved`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({ digest: createHash("sha256").update(item).digest("hex") }),
				});
				expect(saved.ok).toBe(true);
				await page.run(`location.hash = '#/wallets/${walletRoute(rent.address)}/key'`);
				await see("See the key in banda's desktop app");
				// the page learns the key is saved through the stream, which may land after the page opens
				await page.until(`!(${text}).includes('check it here')`, 30_000);
				expect(await page.run(button("Check your copy"))).toBeFalsy();
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await server.close();
			await daemon.close();
		}
	},
	120_000,
);

for (const width of [390, 1280] as const)
	it.skipIf(!hasChrome() || !hasAnvil())(
		`keeps a wallet's Not backed up mark beside a home-wide reason it can't pay, at ${width}px`,
		async () => {
			// host mode: every wallet is offline for agents, as with a coding agent connected (H-064, H-065)
			const { daemon, target, token, create } = await wallets(undefined, undefined, false, "host");
			const server = await webServer({ plugins: [pinned(target)] });
			try {
				const rent = await create("Rent", "anvil");
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page: Page) => {
					const { see } = acts(page);
					await page.until(`document.body.textContent.includes('Sancho')`);
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Rent");
					const row = `[...document.querySelectorAll('button')].find(el => el.textContent.includes(${JSON.stringify(rent.address.slice(-4))}) && el.querySelector('.truncate.font-medium'))`;
					// both in the row: why it can't pay, and the quiet sign that its key has no saved copy (H-273, H-039)
					await page.until(`Boolean(${row}?.querySelector('[data-reason]'))`);
					expect(await page.run<boolean>(`Boolean(${row}.querySelector('[data-unsaved]'))`)).toBe(true);
					expect(await page.run<string>(`${row}.innerText`)).toContain("Not backed up");
					expect(await page.run<boolean>(sideways)).toBe(false);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		120_000,
	);

for (const width of [375, 390] as const)
	it.skipIf(!hasChrome() || !hasAnvil())(
		`offers no copy of an address before the key is saved, skips or checks from the key page after a reload, and lists a key without a wallet, at ${width}px`,
		async () => {
			const { daemon, target, token, view, create, archive } = await wallets();
			const server = await webServer({ plugins: [pinned(target)] });
			try {
				const first = await create("Rent", "anvil");
				const made = await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page: Page) => {
					const { see, make } = acts(page);
					await page.until(`document.body.textContent.includes('Sancho')`);
					// a reload right after Make wallet lands on that wallet's key page, not a blank form for a second one
					await page.run(`location.hash = '#/wallets/new'`);
					await make("Reload test");
					await see("Save Reload test's key");
					await page.reload();
					await see("See the key in banda's desktop app");
					await see("Reload test");
					expect(await page.run<string>(text)).not.toContain("A wallet stays on the network it's made on.");
					expect((await view()).wallets.filter((each) => each.name === "Reload test")).toHaveLength(1);
					expect(page.errors()).toEqual([]);
					return (await view()).wallets.find((each) => each.name === "Reload test");
				});
				expect(made?.backup).toBe("unsaved");
				const second = await create("Gifts", "anvil");
				// a key the keychain holds under this home that no wallet names: a creation that stopped (H-045)
				const items = memoryKeystore().state.items;
				const account = Object.keys(items).find((each) =>
					each.toLowerCase().includes(first.address.slice(2).toLowerCase()),
				) as string;
				const stray = "0x27b1fdb04752bbc536007a920d24acb045561c26";
				items[account.replace(new RegExp(first.address.slice(2), "i"), stray.slice(2))] = items[account] as string;
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page: Page) => {
					const { see, type } = acts(page);
					await page.until(`document.body.textContent.includes('Sancho')`);

					// not backed up yet: the address is drawn whole in its short form, and nothing offers to copy it (H-005)
					await page.run(`location.hash = '#/wallets/${first.address}'`);
					await see("Rent");
					const drawn = `[...document.querySelectorAll('.font-code')].find(el => el.textContent === ${JSON.stringify(`${first.address.slice(0, 6)}…${first.address.slice(-4)}`)})`;
					await page.until(`Boolean(${drawn})`);
					expect(
						await page.run<boolean>(
							`(() => { const el = ${drawn}; const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth && (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth); })()`,
						),
					).toBe(true);
					expect(await page.run<boolean>(`Boolean(${labelled("Copy the address")})`)).toBe(false);
					expect(await page.run<boolean>(sideways)).toBe(false);

					// the key page again, as after a reload while saving: Skip for now, and Receive opens
					await page.run(`location.hash = '#/wallets/${first.address}/key'`);
					await page.reload();
					await see("See the key in banda's desktop app");
					// at a phone's width the footer's buttons wrap inside the window, and the breadcrumb keeps its parent
					expect(
						await page.run<boolean>(
							`[...document.querySelectorAll('button')].filter(el => el.offsetParent !== null).every(el => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth; })`,
						),
					).toBe(true);
					expect(
						await page.run<number>(
							`document.querySelector('nav[aria-label="Breadcrumb"] a')?.getBoundingClientRect().width ?? 0`,
						),
					).toBeGreaterThan(20);
					await page.click(button("Skip for now"));
					await page.until(`location.hash === '#/wallets/${walletRoute(first.address)}'`);
					await see("Not backed up");
					await until(
						async () => (await view()).wallets.find((w) => w.address === first.address)?.backup === "skipped",
					);
					await page.run(`location.hash = '#/wallets/${first.address}/receive'`);
					await see("On Local chain only");
					// skipped, Receive says there is no saved copy, never a key the owner saved, and offers to save one
					await see("if this computer is lost, so is what you send here");
					expect(await page.run<string>(text)).not.toContain("only the key you saved");
					await page.until(`${button("Save your key")}`);
					expect(await page.run<boolean>(sideways)).toBe(false);

					// or Check your copy: on to pasting one, which a wrong copy does not pass
					await page.run(`location.hash = '#/wallets/${second.address}/key'`);
					await page.reload();
					await see("See the key in banda's desktop app");
					await page.click(button("Check your copy"));
					await page.until(`document.querySelector('input[placeholder="0x…"]')`);
					await type(`document.querySelector('input[placeholder="0x…"]')`, `0x${"1".repeat(64)}`);
					await page.click(button("Check"));
					await see("doesn't open");
					// no key here to copy again: the words ask for the saved copy, and the step keeps its ways out
					await see("Paste the key you saved for this wallet");
					expect(await page.run<string>(text)).not.toContain("Copy the key again");
					expect(await page.run<boolean>(`Boolean(${button("Done")})`)).toBe(true);
					expect(await page.run<boolean>(`Boolean(${button("Skip for now")})`)).toBe(true);
					expect((await view()).wallets.find((w) => w.address === second.address)?.backup).toBe("unsaved");

					// Settings → Wallets: the selected tab is in sight, and the key without a wallet is listed once the owner
					// looks: opening the page lists nothing of the keychain, nor does a wallet made while it is open (H-009, H-037)
					const finds = () => memoryKeystore().state.calls.filter((call) => call.op === "find").length;
					const before = finds();
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await see("Look for keys without a wallet");
					await create("Opened", "anvil");
					await see("Opened");
					expect(finds()).toBe(before);
					await page.click(button("Look"));
					const active = `document.querySelector('[role="tab"][data-state="active"]')`;
					await page.until(`${active}?.textContent.trim() === 'Wallets'`);
					await page.until(
						`(() => { const box = ${active}.getBoundingClientRect(); const list = ${active}.closest('[role="tablist"]').getBoundingClientRect(); return box.left >= Math.max(0, list.left) - 1 && box.right <= Math.min(window.innerWidth, list.right) + 1; })()`,
					);
					await see(`${stray.slice(0, 6)}…${stray.slice(-4)}`);
					// a browser offers neither Export nor Delete: both are the desktop app's, behind the computer's prompt
					await see("Export or delete them in banda's desktop app on this computer.");
					expect(await page.run<boolean>(`Boolean(document.querySelector('[data-orphan-acts]'))`)).toBe(false);
					expect(await page.run<boolean>(sideways)).toBe(false);

					// archived while not backed up: nothing offers to save, check or skip its key, which the daemon would
					// refuse; its key page says it is archived and offers Unarchive, from where the key is saved (H-273)
					const skipped = (await view()).wallets.find((w) => w.address === first.address);
					expect(skipped?.backup).toBe("skipped");
					expect(await archive(skipped as { address: string; version: number })).toBe(200);
					await page.run(`location.hash = '#/wallets/${first.address}?tab=wallet'`);
					await see("Money sent to it still arrives");
					await see("Bring the wallet back to see its key.");
					expect(await page.run<boolean>(`Boolean(${button("Save your key")})`)).toBe(false);
					await page.run(`location.hash = '#/wallets/${first.address}/key'`);
					await page.until(`Boolean(${button("Unarchive")})`);
					for (const label of ["Check your copy", "Skip for now", "Save your key"])
						expect(await page.run<boolean>(`Boolean(${button(label)})`), label).toBe(false);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		180_000,
	);

for (const width of [390, 1280] as const)
	it.skipIf(!hasChrome() || !hasAnvil())(
		`keeps a name of 64 characters with no space inside the window on New wallet and every step of Save your key, at ${width}px`,
		async () => {
			const { daemon, target, token, create } = await wallets(undefined, undefined, true);
			const server = await webServer({ plugins: [pinned(target)] });
			try {
				const long = await create("x".repeat(64), "anvil");
				await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page: Page) => {
					const { see, type } = acts(page);
					await page.until(`document.body.textContent.includes('Sancho')`);
					const inWindow = { found: true, out: [] };
					await page.run(`location.hash = '#/wallets/new'`);
					await see("A wallet stays on the network it's made on.");
					await type(`document.querySelector('input[placeholder^="Travel"]')`, long.name);
					await see(`You already have a wallet named ${long.name}`);
					expect(await page.run(drawnInside(long.name))).toEqual(inWindow);
					await page.click(
						`[...document.querySelectorAll('[data-choice]')].find(el => el.textContent.includes('Local chain')).querySelector('[role="radio"]')`,
					);
					await page.click(button("Make wallet"));
					await see(`Save ${long.name}'s key`);
					expect(await page.run(drawnInside(long.name))).toEqual(inWindow);
					await page.click(button("Show key"));
					await page.until(`document.querySelector('[data-key]')`);
					const longKey = (await page.run<string>(`document.querySelector('[data-key]').textContent`)).replace(
						/\s+/g,
						"",
					);
					await page.click(button("I saved it"));
					await see("Check your copy");
					await type(`document.querySelector('input[placeholder="0x…"]')`, longKey);
					await page.click(button("Check"));
					await see(`${long.name} is backed up`);
					expect(await page.run(drawnInside(long.name))).toEqual(inWindow);
					expect(await page.run<boolean>(sideways)).toBe(false);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await server.close();
				await daemon.close();
			}
		},
		180_000,
	);

it.skipIf(!hasChrome() || !hasAnvil())(
	"shows a new wallet's key on the daemon's own page, opens a skipped one's Receive, and says a refused reveal",
	async () => {
		const root = fileURLToPath(new URL("../web/", import.meta.url));
		// inside the run's own temp folder, removed with it
		const out = join(await tempHome(), "web");
		const { build } = await import("vite");
		await build({
			configFile: join(root, "vite.config.ts"),
			root,
			cacheDir: await viteCacheDir(),
			logLevel: "silent",
			// the build's own plugins join its out directory to the root
			build: { outDir: relative(root, out), emptyOutDir: true },
		});
		const { daemon, target, token, view, remove, check } = await wallets(out);
		try {
			await withPage(`${target}/#token=${token}`, { width: 1280, height: 900 }, async (page: Page) => {
				const { see, make } = acts(page);
				await page.until(`document.body.textContent.includes('Sancho')`);

				// the key, on whichever of the browser's own connections to the daemon its reveal goes, while the page
				// keeps others busy with requests of its own (C16)
				const fresh = async () => {
					await page.run(`location.hash = '#/settings?tab=wallets'`);
					await page.click(button("New wallet"));
				};
				await page.run(`window.__busy = setInterval(() => {
					for (let n = 0; n < 4; n++) fetch('/api/wallets', { headers: { authorization: 'Bearer ${token}' } });
				}, 20)`);
				for (const name of ["Rent", "Rent again", "Rent once more"]) {
					await fresh();
					await make(name);
					await see(`Save ${name}'s key`);
					await page.click(button("Show key"));
					await page.until(`document.querySelector('[data-key]')`);
					const key = (await page.run<string>(`document.querySelector('[data-key]').textContent`)).replace(/\s+/g, "");
					const made = (await view()).wallets.find((each) => each.name === name);
					expect(privateKeyToAddress(key as `0x${string}`)).toBe(made?.address);
				}
				await page.run(`clearInterval(window.__busy)`);

				// a reveal refused for now (the keychain locked: 503) keeps the creation's secret, the only one that shows
				// its key: the page says why, and Try again shows the key (C16, H-263)
				await page.run(`(() => {
					const sent = window.fetch;
					let once = true;
					window.__unpatch = () => { window.fetch = sent; };
					window.fetch = (url, init) => {
						if (once && String(url).endsWith('/reveal')) {
							once = false;
							return Promise.resolve(new Response(JSON.stringify({ error: 'the keychain is locked: unlock it and try again', code: 'locked' }), { status: 503, headers: { 'content-type': 'application/json' } }));
						}
						return sent(url, init);
					};
				})()`);
				await fresh();
				await make("Locked");
				await see("Save Locked's key");
				await page.click(button("Show key"));
				await see("The keychain is locked: unlock it and try again");
				expect(await page.run<string>(text)).not.toContain("The key couldn't be shown here");
				await page.click(button("Try again"));
				await page.until(`document.querySelector('[data-key]')`);
				await page.run(`window.__unpatch()`);
				const locked = (await page.run<string>(`document.querySelector('[data-key]').textContent`)).replace(/\s+/g, "");
				expect(privateKeyToAddress(locked as `0x${string}`)).toBe(
					(await view()).wallets.find((each) => each.name === "Locked")?.address,
				);
				// a wrong copy, then the key shown again: the right copy pasted next is checked alone, never added to the
				// wrong one, and backs the wallet up (H-274, H-275)
				await page.click(button("I saved it"));
				const field = `document.querySelector('input[type=password]')`;
				await page.click(field);
				await page.input("Input.insertText", { text: `0x${"cd".repeat(32)}` });
				await page.click(button("Check"));
				await see("This doesn't open");
				await page.click(button("Show key again"));
				await page.click(button("I saved it"));
				await page.until(`${field}?.value === ''`);
				await page.click(field);
				await page.input("Input.insertText", { text: locked });
				await page.click(button("Check"));
				await see("Locked is backed up");

				// skipped, the wallet opens, and so does its Receive
				await fresh();
				await make("Tips");
				await see("Save Tips's key");
				await page.click(button("Skip for now"));
				await see("Not backed up");
				// the page's copy of the address goes through Receive: the address is marked as left banda first, so
				// the skipped key is never removed after it was handed out (C17, C21)
				expect((await view()).wallets.find((each) => each.name === "Tips")?.disclosed).toBe(false);
				await page.click(labelled("Copy the address"));
				const tips = await until(async () => {
					const found = (await view()).wallets.find((each) => each.name === "Tips");
					return found?.disclosed === true ? found : undefined;
				});
				expect(await remove(tips)).toBe(409);
				await page.click(button("Receive"));
				await see("On Local chain only");
				expect((await view()).wallets.find((each) => each.name === "Tips")?.backup).toBe("skipped");
				// an answer that names another address than the wallet's record is neither shown nor copied (H-261)
				const stranger = "0x000000000000000000000000000000000000dEaD";
				await page.run(`(() => {
					const sent = window.fetch;
					window.__unpatch = () => { window.fetch = sent; };
					window.fetch = async (url, init) => {
						const answer = await sent(url, init);
						if (!String(url).endsWith('/receive')) return answer;
						const body = await answer.json();
						return new Response(JSON.stringify({ ...body, address: ${JSON.stringify(stranger)} }), { status: answer.status, headers: { 'content-type': 'application/json' } });
					};
				})()`);
				await page.run(`location.hash = '#/wallets/${walletRoute(tips.address)}'`);
				await see("Not backed up");
				await page.click(labelled("Copy the address"));
				await see("banda answered an address that isn't this wallet's");
				await page.click(button("Receive"));
				await see("The address didn't match");
				expect(await page.run<string>(text)).not.toContain(stranger);
				expect(await page.run(button("Copy address"))).toBeFalsy();
				await page.run(`window.__unpatch()`);
				// its address given out over a key never saved: Remove says why it can't be, never a loss to agree to (C17)
				await page.run(`location.hash = '#/wallets/${walletRoute(tips.address)}?tab=wallet'`);
				await page.click(button("Remove"));
				await see("Tips can't be removed yet");
				await see("The wallet's address was given out and its key was never saved.");
				expect(await page.run<string>(text)).not.toContain("lost for good");
				await page.click(button("Close"));

				// a reveal the daemon refuses (here, asked under another creation's id, without its secret) says the key
				// wasn't shown, once Show key asked for it
				await page.run(`(() => {
					const sent = window.fetch;
					window.fetch = (url, init) =>
						String(url).endsWith('/reveal') ? sent(url, { ...init, body: JSON.stringify({ request: 'create-not-this-one' }) }) : sent(url, init);
				})()`);
				await fresh();
				await make("Gifts");
				await see("Save Gifts's key");
				await page.click(button("Show key"));
				await see("The key couldn't be shown here");

				// a keychain that does not answer at all: the creation says so, and nothing is made
				const none = { account: "/wallet/", throw: "No keychain is available" };
				memoryKeystore().state.faults.push({ point: "keychain:write", ...none }, { point: "keychain:read", ...none });
				await fresh();
				await make("Savings");
				await see("This computer has no keychain banda can use");
				// a wallet left being made blames neither the network nor a read: nothing is read for it, nor can it be
				// archived or removed yet
				const savings = (await view()).wallets.find((each) => each.name === "Savings");
				expect(savings?.state).toBe("creating");
				if (savings !== undefined) {
					await page.run(`location.hash = '#/wallets/${walletRoute(savings.address)}'`);
					await see("Not made yet");
					await see("This wallet isn't made yet: banda reads nothing for it until it is.");
					const page_ = await page.run<string>(text);
					expect(page_).not.toContain("The network isn't answering");
					expect(page_).not.toContain("still reading this wallet's history");
					await page.run(`location.hash = '#/wallets/${walletRoute(savings.address)}?tab=wallet'`);
					await see("It can be archived or removed once it's made.");
					expect(await page.run(button("Archive"))).toBeFalsy();
					expect(await page.run(button("Remove"))).toBeFalsy();
				}
				// the wallet made before the keychain went is checked under it too, and says it has none
				expect((await check(tips.address)).ok).toBe(true);
				expect((await view()).wallets.find((each) => each.name === "Tips")?.signing?.code).toBe("no_keychain");
				// Settings → Wallets says it too, with the fix, in place of New wallet (H-309, UC-04 A1)
				await page.run(`location.hash = '#/settings?tab=wallets'`);
				await see("Run banda in a desktop session with a keychain");
				expect(await page.run(button("New wallet"))).toBeFalsy();
				memoryKeystore().state.faults.splice(0);
				// once the keychain answers, Check again finds it, New wallet is back, and no wallet says it has no
				// keychain any more: the section and each row say the same (H-317, C22)
				await page.click(button("Check again"));
				await page.until(`Boolean(${button("New wallet")})`);
				expect(await page.run<string>(text)).not.toContain("Run banda in a desktop session with a keychain");
				expect((await view()).keychain).toBeUndefined();
				expect((await view()).wallets.find((each) => each.name === "Tips")?.signing?.code).toBeUndefined();
				await page.until(`!${text}.includes("No keychain")`);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await daemon.close();
		}
	},
	180_000,
);

it.skipIf(!hasChrome() || !hasAnvil())(
	"on a paired phone, never asks for a new wallet's key and offers none of the computer's own controls",
	async () => {
		const { daemon, target, token, chain, view, check } = await wallets(undefined, "loopback");
		const phone = await testDevice();
		const owner = { authorization: `Bearer ${token}`, "content-type": "application/json" };
		const asOwner = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
			const answered = await fetch(`${target}/api${path}`, {
				method,
				headers: owner,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!answered.ok) throw new Error(`${method} ${path}: ${answered.status} ${await answered.text()}`);
			return answered.json() as Promise<T>;
		};
		let bridge: ReturnType<typeof irohBridge> | undefined;
		let server: Awaited<ReturnType<typeof webServer>> | undefined;
		let computer: Awaited<ReturnType<typeof webServer>> | undefined;
		try {
			// the owner pairs the phone, as Settings → Devices does
			const invite = await asOwner<InviteView>("/devices/invites", "POST");
			const connection = await phone.dial(invite.ticket);
			expect(
				(await phone.request("POST", "/api/devices/pair", { invite: invite.secret, name: "Pixel 9" })).status,
			).toBe(202);
			await asOwner(`/devices/requests/${phone.id}/approve`, "POST", { name: "Pixel 9" });
			const daemonId = (await asOwner<DevicesView>("/devices")).endpoint?.id as string;
			bridge = irohBridge(connection);
			const bridgeUrl = await bridge.url();
			// no proxy to the daemon: the page reaches it only through the plugin
			server = await webServer();
			const origin = server.origin;
			await withPage("about:blank", { width: 390, height: 900 }, async (page: Page) => {
				const { see, make } = acts(page);
				await page.input("Page.enable", {});
				await page.input("Page.addScriptToEvaluateOnNewDocument", { source: plugin(bridgeUrl, daemonId, phone.id) });
				await page.goto(`${origin}/#/settings?tab=wallets`);
				await page.until(`window.Capacitor?.isNativePlatform?.() === true`);
				await see("No wallet yet", 30_000);
				// an RPC is the computer's to change: no Change here, and the daemon refuses one from the phone
				await see(`${chain.url}/•••`);
				expect(await page.run(labelled("Change Local chain's RPC"))).toBeFalsy();
				expect((await phone.request("PUT", "/api/wallets/rpc/anvil", { url: null })).status).toBe(403);

				// a creation on the phone: its key is never asked for, and the step says where it shows
				await page.click(button("New wallet"));
				await see("A wallet stays on the network it's made on.");
				// a phone never shows the key, so its creation warns of no extension
				expect(await page.run<string>(text)).not.toContain("An extension in this browser");
				await make("Pocket");
				await see("Open banda's desktop app to see the key");
				expect(await page.run(button("Show key"))).toBeFalsy();
				// nor is its saving skipped here: the computer shows the step at its next open (H-276)
				expect(await page.run(button("Skip for now"))).toBeFalsy();
				expect(
					(await phone.request("POST", `/api/wallets/${(await view()).wallets[0]?.address}/skip`, {})).status,
				).toBe(403);
				expect(await page.run<string>(text)).not.toContain("Save Pocket's key");
				const [made] = (await view()).wallets;
				expect(made).toMatchObject({ name: "Pocket", state: "ready", backup: "unsaved" });
				expect(bridge?.carried).toContain("POST /api/wallets");
				expect(bridge?.carried.some((path) => path.endsWith("/reveal"))).toBe(false);
				expect(await page.run<string>("location.hash")).not.toContain("token=");

				// the wallet says it is not backed up, with no Save your key, and its Remove is the computer's alone
				await page.run(`location.hash = '#/wallets/${made?.address}'`);
				await see("Not backed up");
				expect(await page.run(button("Save your key"))).toBeFalsy();
				await page.run(`location.hash = '#/wallets/${made?.address}?tab=wallet'`);
				await page.until(
					`[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Remove' && el.disabled)`,
				);
				expect(await page.run(button("Remove"))).toBeFalsy();
				expect(await page.run(button("Save your key"))).toBeFalsy();
				expect(page.errors()).toEqual([]);
			});

			// the computer, at its app's next open, shows the save step of the wallet the phone made, with no page opened
			// by hand (UC-01 A3, H-276)
			const [pocket] = (await view()).wallets;
			const address = pocket?.address as string;
			computer = await webServer({ plugins: [pinned(target)] });
			await withPage(`${computer.origin}/#token=${token}`, { width: 1280, height: 900 }, async (page: Page) => {
				const { see } = acts(page);
				await see("Save Pocket's key", 30_000);
				await see(`${shortAddress(address)} on Local chain was made on a paired device`);
				await page.click(button("Save your key"));
				await page.until(`location.hash === '#/wallets/${walletRoute(address)}/key'`);
				await see("See the key in banda's desktop app");

				// its key gone from the keychain: no save step anywhere, the reason and its own act instead
				const items = memoryKeystore().state.items;
				for (const account of Object.keys(items)) if (account.includes("/wallet/")) delete items[account];
				await check(address);
				await page.run(`location.hash = '#/wallets/${walletRoute(address)}?tab=wallet'`);
				await page.until(`${text}.includes('Key') && !${text}.includes('Save your key')`, 30_000);
				expect(await page.run(button("Save your key"))).toBeFalsy();
				await page.run(`location.hash = '#/wallets/${walletRoute(address)}/key'`);
				await see("Don't send anything there");
				expect(await page.run(button("Check your copy"))).toBeFalsy();
				expect(await page.run(button("Show key"))).toBeFalsy();
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await computer?.close();
			await server?.close();
			await bridge?.close();
			await phone.close();
			await daemon.close();
		}
	},
	180_000,
);
