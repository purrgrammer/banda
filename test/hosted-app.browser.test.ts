/**
 * The app on an origin of its own, as a device in a browser (web/src/lib/browser-shell.ts, hosted-shell.ts): the real
 * web app in Chrome, made as that origin's build is (`__BANDA_HOSTED__`), against a real daemon. A browser's Iroh
 * endpoint reaches a relay alone, and a test reaches no network, so the WebAssembly module is the one thing stood in
 * for: its place is taken by a module that hands each call to this test, which makes it over Iroh on loopback from a
 * device of its own (`./fixtures/iroh-client.ts`). Everything above the endpoint is the app's: the link an address
 * carries, the pairing screens, the key kept in the browser's storage, the framing of each request.
 * `BANDA_HOSTED_SHOTS=<dir>` saves screenshots.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { Connection } from "@number0/iroh";
import { encode } from "uqr";
import { expect, it } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { DevicesView, InviteView } from "../src/server/api.ts";
import { streamSocket } from "../src/server/remote.ts";
import { fingerprint, NOTES } from "../web/src/lib/pairing.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { type Device, testDevice } from "./fixtures/iroh-client.ts";
import { echoModels, tempHome, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const SHOTS = process.env.BANDA_HOSTED_SHOTS;

/**
 * The endpoint's calls, answered over Iroh on loopback. A browser's key is its device here too: the same key bound
 * again is the same endpoint, so a page that kept its key and reloads is the device it was.
 */
async function bridge(daemon: string) {
	const bound = new Map<string, Device>();
	/** The connections dialed, each its dial's own. */
	const links = new Map<string, Connection>();
	const streams = new Map<string, Duplex>();
	/** What the devices asked the daemon for, each as its request's first words: a method and a path. */
	const sent: string[] = [];
	const body = async (req: http.IncomingMessage) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	};
	const server = http.createServer((req, res) => {
		void (async () => {
			res.setHeader("access-control-allow-origin", "*");
			const url = new URL(req.url ?? "/", "http://bridge");
			const asked = await body(req);
			const json = (value: unknown) =>
				void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
			if (url.pathname === "/bind") {
				const secret = asked.toString();
				const device = bound.get(secret) ?? (await testDevice());
				bound.set(secret, device);
				return json({ id: device.id });
			}
			const device = [...bound.values()].find(({ id }) => id === url.searchParams.get("device"));
			if (url.pathname === "/dial" && device !== undefined) {
				const link = randomBytes(8).toString("hex");
				links.set(link, await device.dial(asked.toString()));
				return json({ link });
			}
			const connection = links.get(url.searchParams.get("link") ?? "");
			if (url.pathname === "/close" && connection !== undefined) {
				connection.close(0n, []);
				return json({});
			}
			if (url.pathname === "/open" && connection !== undefined) {
				// a connection that has gone fails here, before anything is written
				const socket = streamSocket(await connection.openBi());
				const id = randomBytes(8).toString("hex");
				streams.set(id, socket);
				return json({ stream: id });
			}
			if (url.pathname === "/send") {
				const socket = streams.get(url.searchParams.get("stream") ?? "");
				if (socket === undefined) return void res.writeHead(404).end();
				streams.delete(url.searchParams.get("stream") ?? "");
				sent.push(asked.subarray(0, asked.indexOf(" HTTP/1.1")).toString());
				res.writeHead(200, { "content-type": "application/octet-stream" });
				socket.pipe(res);
				socket.on("error", () => res.destroy());
				res.on("close", () => socket.destroy());
				return void socket.end(asked);
			}
			res.writeHead(502).end();
		})().catch((error: unknown) => {
			if (!res.headersSent) res.writeHead(502);
			res.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	/** The module that stands where the WebAssembly one would be: the same names, each call made of the bridge. */
	const module = `
		const bridge = ${JSON.stringify(origin)};
		const ask = async (path, body) => {
			const response = await fetch(bridge + path, { method: "POST", body });
			if (!response.ok) throw new Error(await response.text());
			return response;
		};
		const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
		export default async function init() {}
		export const computer = (ticket) => {
			if (!ticket.startsWith("endpoint")) throw new Error("not a ticket");
			return ${JSON.stringify(daemon)};
		};
		export const Device = {
			create: async (secret) => {
				const made = await (await ask("/bind", hex(secret))).json();
				return {
					id: () => made.id,
					dial: async (ticket) => {
						const { link } = await (await ask("/dial?device=" + made.id, ticket)).json();
						return {
							open: async () => {
								const { stream } = await (await ask("/open?link=" + link, "")).json();
								return { send: async (request) => (await ask("/send?stream=" + stream, request)).body };
							},
							close: () => void ask("/close?link=" + link, "").catch(() => {}),
						};
					},
					close: async () => {},
				};
			},
		};`;
	return {
		module,
		asked: () => [...sent],
		close: async () => {
			server.closeAllConnections();
			server.close();
			for (const device of bound.values()) await device.close().catch(() => undefined);
		},
	};
}

/** A daemon reached on loopback, an invite of its owner's, and the app served as its own origin serves it. */
async function start() {
	const home = await tempHome();
	if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	const daemon = await startDaemon({
		home,
		port: 0,
		models: echoModels().models,
		log: () => {},
		box: hostBox(home),
		remote: { reach: "loopback" },
	});
	const token = (await readDaemonFile(home))!.token!;
	const owner = async <T>(path: string, method = "GET", body?: object): Promise<T> => {
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
		return response.json() as Promise<T>;
	};
	// the invite binds the daemon's endpoint; its id is what the phone's screen shows for this computer
	const invite = await owner<InviteView>("/devices/invites", "POST");
	const computer = (await owner<DevicesView>("/devices")).endpoint!.id;
	const endpoint = await bridge(computer);
	const server = await webServer({
		define: { __BANDA_HOSTED__: "true" },
		// the decoder a scan may need is known from the start: found in the middle of one, Vite would reload the page
		optimizeDeps: { include: ["jsqr"] },
		plugins: [
			{
				name: "bridged-endpoint",
				enforce: "pre",
				// the build's own stand-in for a build that is no device, or the module itself: both are this one here
				resolveId: (id) => (/(no-endpoint\.ts|banda_iroh_web\.js)$/.test(id) ? "\0bridged-endpoint" : undefined),
				load: (id) => (id === "\0bridged-endpoint" ? endpoint.module : undefined),
			},
		],
	});
	return {
		owner,
		invite,
		computer,
		server,
		asked: endpoint.asked,
		close: async () => {
			await server.close();
			await endpoint.close();
			await daemon.close();
		},
	};
}

const text = "document.body.innerText";
const button = (label: string) =>
	`[...document.querySelectorAll('button')].find((el) => el.getClientRects().length > 0 && el.textContent.trim() === ${JSON.stringify(label)})`;

for (const width of [390, 1280])
	it.skipIf(!hasChrome())(
		`a browser pairs from a link, is the same device after a reload, and is sent back to pairing once revoked at ${width}px`,
		async () => {
			const { owner, invite, computer, server, close } = await start();
			const shoot = async (page: { shoot(file: string): Promise<void> }, name: string) => {
				if (SHOTS !== undefined) await page.shoot(join(SHOTS, `hosted-${width}-${name}.png`));
			};
			try {
				// the link the desktop's code carries for a browser, opened here on the test's origin
				const link = `${server.origin}/${new URL(invite.browser).hash}`;
				await withPage(link, { width, height: 844 }, async (page) => {
					await page.until(button("Pair with this code"));
					// the invite is out of the address as soon as it is read, and no token is kept: the device is the key
					expect(await page.run("location.hash")).toBe("");
					expect(await page.run("Object.keys(localStorage).length")).toBe(0);
					expect(await page.run<string>(text)).toContain("You opened a pairing code");
					await shoot(page, "1-code");

					await page.click(button("Pair with this code"));
					await page.until(button("The codes match · Pair"));
					expect(await page.run<string>(text)).toContain(fingerprint(computer));
					await shoot(page, "2-computer");
					// nothing was asked of the daemon yet: the owner compares first
					expect((await owner<DevicesView>("/devices")).requests).toEqual([]);

					await page.click(button("The codes match · Pair"));
					await page.until(`${text}.includes('Waiting for approval')`);
					const [request] = (await owner<DevicesView>("/devices")).requests;
					expect(request).toBeDefined();
					expect(await page.run<string>(text)).toContain(fingerprint(request!.id));
					await shoot(page, "3-waiting");

					// the browser drops the page while its owner walks to the computer (a phone does, to a tab left behind):
					// opened again it is the same device and still has the code, which is out of the address all the same
					await page.reload();
					await page.until(button("Pair with this code"));
					expect(await page.run("location.hash")).toBe("");
					await page.click(button("Pair with this code"));
					await page.until(button("The codes match · Pair"));
					await page.click(button("The codes match · Pair"));
					await page.until(`${text}.includes('Waiting for approval')`);
					expect((await owner<DevicesView>("/devices")).requests.map(({ id }) => id)).toEqual([request!.id]);

					await owner(`/devices/requests/${request!.id}/approve`, "POST", { name: "A browser" });
					await page.until(`${text}.includes('Sancho') && !${text}.includes('Waiting for')`);
					await shoot(page, "4-app");
					const paired = (await owner<DevicesView>("/devices")).devices;
					expect(paired).toEqual([expect.objectContaining({ id: request!.id, name: "A browser", connected: true })]);

					// what the browser keeps: the device's key and the daemon that approved it; the code it paired with is gone
					const kept = await page.run<{ key: number; ticket: boolean; code: string | null }>(
						`new Promise((resolve) => { const open = indexedDB.open("banda"); open.onsuccess = () => { const asked = open.result.transaction("device").objectStore("device").get("kept"); asked.onsuccess = () => resolve({ key: asked.result.key.byteLength, ticket: asked.result.ticket === ${JSON.stringify(invite.ticket)}, code: sessionStorage.getItem("banda.pairing") }); }; })`,
					);
					expect(kept).toEqual({ key: 32, ticket: true, code: null });

					// the app works as on a phone: a message goes up and its answer streams back
					if (width >= 768) {
						await page.until("document.querySelector('textarea') !== null");
						await page.run("document.querySelector('textarea').focus()");
						await page.input("Input.insertText", { text: "hello from a browser" });
						await page.input("Input.dispatchKeyEvent", {
							type: "keyDown",
							key: "Enter",
							code: "Enter",
							windowsVirtualKeyCode: 13,
						});
						await page.input("Input.dispatchKeyEvent", {
							type: "keyUp",
							key: "Enter",
							code: "Enter",
							windowsVirtualKeyCode: 13,
						});
						await page.until(`${text}.includes('re: hello from a browser')`);
						await shoot(page, "5-chat");
					}

					// opened again, it is the device it was: no code, no request, the same endpoint
					await page.reload();
					await page.until(`${text}.includes('Sancho') && !${text}.includes('Reaching your computer')`);
					expect(await page.run<string>(text)).not.toContain("Pair this phone");
					expect((await owner<DevicesView>("/devices")).devices.map(({ id }) => id)).toEqual([request!.id]);
					expect((await owner<DevicesView>("/devices")).requests).toEqual([]);

					// revoked on the computer: the daemon says so, the browser forgets its key, and pairing starts over
					await owner(`/devices/${request!.id}/revoke`, "POST");
					await page.until(`${text}.includes('Pair this phone with banda')`, 40_000);
					expect(await page.run<string>(text)).toContain(NOTES.revoked);
					await shoot(page, "6-revoked");
					expect(
						await page.run(
							`new Promise((resolve) => { const open = indexedDB.open("banda"); open.onsuccess = () => { const asked = open.result.transaction("device").objectStore("device").get("kept"); asked.onsuccess = () => resolve(asked.result?.ticket ?? null); }; })`,
						),
					).toBeNull();
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await close();
			}
		},
		120_000,
	);

it.skipIf(!hasChrome())(
	"a device reads the shell once and a chat from the chat's own stream, and asks the daemon for nothing while nothing happens",
	async () => {
		const { owner, invite, server, asked, close } = await start();
		const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		try {
			await withPage(`${server.origin}/${new URL(invite.browser).hash}`, { width: 1280, height: 844 }, async (page) => {
				await page.until(button("Pair with this code"));
				await page.click(button("Pair with this code"));
				await page.until(button("The codes match · Pair"));
				await page.click(button("The codes match · Pair"));
				await page.until(`${text}.includes('Waiting for approval')`);
				const [request] = (await owner<DevicesView>("/devices")).requests;
				await owner(`/devices/requests/${request!.id}/approve`, "POST", { name: "A browser" });
				await page.until("document.querySelector('textarea') !== null");
				await page.run("document.querySelector('textarea').focus()");
				await page.input("Input.insertText", { text: "hello" });
				for (const type of ["keyDown", "keyUp"])
					await page.input("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
				await page.until(`${text}.includes('re: hello')`);
				// the app at rest: nothing new asked for a while
				for (let last = -1; last !== asked().length; ) {
					last = asked().length;
					await pause(2500);
				}
				const before = asked();
				const got = before.filter((line) => line.startsWith("GET ")).map((line) => line.slice(4));
				// its bytes may cross a relay that carries little: the shell, which is megabytes in a home that is lived in,
				// is read once, where a page on the daemon's own origin reopens its one stream for every chat
				expect(got.filter((path) => path.startsWith("/api/events"))).toEqual(["/api/events"]);
				// (asked twice here, of the one chat: this page is the development build, which mounts every reader twice)
				expect(new Set(got.filter((path) => /^\/api\/chats\/\d+\/events$/.test(path))).size).toBe(1);
				// read once, by however many places show it
				expect(got.filter((path) => path === "/api/skills")).toHaveLength(1);
				// longer than any timer the app keeps: on the daemon's own page the skills are read again every 15 s
				await pause(17_000);
				expect(asked().slice(before.length)).toEqual([]);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await close();
		}
	},
	120_000,
);

/**
 * A camera for the page: its picture is `code`, drawn as the computer's screen shows it. The page's own camera call
 * answers with it, and `cameraLetGo` says whether the page has since stopped it.
 */
const camera = (code: string) => {
	const { data } = encode(code, { ecc: "M", border: 2 });
	return `(() => {
		const matrix = ${JSON.stringify(data)};
		const side = 6;
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = matrix.length * side;
		const context = canvas.getContext("2d");
		const draw = () => {
			context.fillStyle = "#fff";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.fillStyle = "#000";
			matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) context.fillRect(x * side, y * side, side, side); }));
		};
		draw();
		// a stream of a canvas has a new frame only when the canvas is drawn
		setInterval(draw, 60);
		// each asking is given a stream of its own, as a camera gives: every one of them is the page's to stop
		const given = [];
		navigator.mediaDevices.getUserMedia = async () => {
			const stream = canvas.captureStream(15);
			given.push(stream);
			return stream;
		};
		window.cameraLetGo = () =>
			given.length > 0 && given.every((stream) => stream.getTracks().every((track) => track.readyState === "ended"));
	})()`;
};

/** What reads the picture, by what the browser has: each is the page's `BarcodeDetector` before the scan starts. */
const DECODERS = {
	"the browser's own detector": undefined,
	"the decoder the page carries, in a browser with no detector": "undefined",
	"the decoder the page carries, when the browser's detector says it reads codes and then cannot": `class {
		static getSupportedFormats = async () => ["qr_code"];
		detect = async () => { throw new DOMException("Barcode detection service unavailable.", "NotSupportedError"); };
	}`,
};

for (const [decoder, detector] of Object.entries(DECODERS))
	it.skipIf(!hasChrome())(
		`a phone's browser scans the code the computer shows, read by ${decoder}`,
		async ({ skip }) => {
			const { owner, invite, computer, server, close } = await start();
			try {
				await withPage(`${server.origin}/`, { width: 390, height: 844 }, async (page) => {
					await page.until(button("Scan the code"));
					// Chrome on Linux ships no detector: there the page's own decoder is all a browser has, as the next
					// cases show; this one is for the browsers that bring theirs (a Mac's, a phone's)
					if (detector === undefined && (await page.run(`typeof BarcodeDetector`)) === "undefined") return skip();
					// the code Settings shows by default, the one the phone's app reads: a page that scans reads it too
					await page.run(camera(invite.pairing));
					if (detector !== undefined)
						await page.run(
							`void Object.defineProperty(window, "BarcodeDetector", { value: ${detector}, configurable: true })`,
						);
					// this Chrome has a detector of its own that reads QR codes, or the first case would prove nothing of it
					else expect(await page.run(`BarcodeDetector.getSupportedFormats()`)).toContain("qr_code");
					await page.click(button("Scan the code"));
					// read, the camera is closed and let go of, and pairing goes on as from a link
					await page.until(button("The codes match · Pair"), 30_000);
					expect(await page.run<string>(text)).toContain(fingerprint(computer));
					expect(await page.run(`document.querySelector('[role="dialog"][aria-label="Scan the code"]') === null`)).toBe(
						true,
					);
					expect(await page.run("window.cameraLetGo()")).toBe(true);
					await page.click(button("The codes match · Pair"));
					await page.until(`${text}.includes('Waiting for approval')`);
					const [request] = (await owner<DevicesView>("/devices")).requests;
					await owner(`/devices/requests/${request!.id}/approve`, "POST", { name: "A phone" });
					await page.until(`${text}.includes('Sancho') && !${text}.includes('Waiting for')`);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await close();
			}
		},
		120_000,
	);

it.skipIf(!hasChrome())(
	"a phone's browser closes the camera without a code, and says so when it may not use one",
	async () => {
		const { server, close } = await start();
		try {
			await withPage(`${server.origin}/`, { width: 390, height: 844 }, async (page) => {
				await page.until(button("Scan the code"));
				// a picture with no code in it: nothing is read until the owner gives up
				await page.run(
					camera("").replace(
						/const matrix = .*?;/,
						"const matrix = Array.from({ length: 40 }, () => Array(40).fill(false));",
					),
				);
				await page.click(button("Scan the code"));
				await page.until(button("Cancel"));
				await page.click(button("Cancel"));
				await page.until(button("Scan the code"));
				expect(await page.run("window.cameraLetGo()")).toBe(true);
				// refused: the screen says what to do instead, and the paste field is still there
				await page.run(
					`navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("no", "NotAllowedError"); }`,
				);
				await page.click(button("Scan the code"));
				await page.until(`${text}.includes('cannot use this phone’s camera')`);
				await page.click(button("Close"));
				await page.until(button("Pair with this link"));
			});
		} finally {
			await close();
		}
	},
	120_000,
);

it.skipIf(!hasChrome())(
	"a browser on a computer has no code to scan: it pairs from the link the owner copied, and says so of anything else",
	async () => {
		const { owner, invite, computer, server, close } = await start();
		try {
			await withPage(`${server.origin}/`, { width: 1280, height: 844 }, async (page) => {
				await page.until(button("Pair with this link"));
				expect(await page.run(`${button("Scan the code")} === undefined`)).toBe(true);
				expect(await page.run<string>(text)).toContain("Copy the link it gives and paste it here");
				const paste = async (value: string) => {
					await page.run(
						`(() => { const el = [...document.querySelectorAll("input")].at(-1); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
					);
					await page.input("Input.insertText", { text: value });
					await page.click(button("Pair with this link"));
				};
				await paste("https://example.com/not-a-pairing");
				await page.until(`${text}.includes(${JSON.stringify(NOTES.notALink)})`);
				// the link Settings gives for a browser, whole, as it was copied
				await paste(invite.browser);
				await page.until(button("The codes match · Pair"), 30_000);
				expect(await page.run<string>(text)).toContain(fingerprint(computer));
				await page.click(button("The codes match · Pair"));
				await page.until(`${text}.includes('Waiting for approval')`);
				const [request] = (await owner<DevicesView>("/devices")).requests;
				await owner(`/devices/requests/${request!.id}/approve`, "POST", { name: "A laptop" });
				await page.until(`${text}.includes('Sancho') && !${text}.includes('Waiting for')`);
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await close();
		}
	},
	120_000,
);
