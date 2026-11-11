import { mkdtempSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Harness } from "@earendil-works/pi-durable";
import type { InlineConfig, ViteDevServer } from "vite";
import { afterEach, onTestFinished } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { BlobStore } from "../src/core/blobs.ts";
import { type Gateway, type Origin, type Outbound, PermanentSendError } from "../src/core/gateway.ts";
import { context } from "../src/core/store.ts";

export { echoModels, FAUX_MODEL } from "./fixtures/models.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/**
 * Wait on state, never on time: poll `check` until it gives a value (anything but undefined, null or false). It has no
 * clock of its own: the test's timeout bounds it, so a loaded machine only makes a test slower, never makes it fail on
 * a deadline a quiet one meets. Once the test ended it stops, so nothing polls a store that was closed under it.
 */
export async function until<T>(
	check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	every = 10,
): Promise<T> {
	let ended = false;
	try {
		onTestFinished(() => {
			ended = true;
		});
	} catch {
		// outside a test (a hook): the hook's own timeout bounds it
	}
	for (;;) {
		const value = await check();
		if (value !== undefined && value !== null && value !== false) return value;
		if (ended) throw new Error("the test ended while waiting");
		await new Promise((resolve) => setTimeout(resolve, every));
	}
}

/** Skip first run's skills step, as the owner's Skip does, for a browser test about something else. */
export async function skipShippedSkills(port: number, token: string): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${port}/api/skills/shipped`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ add: [] }),
	});
	if (!response.ok) throw new Error(`skipping the skills step: ${response.status} ${await response.text()}`);
}

export async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "banda-test-"));
	homes.push(home);
	return home;
}

/** A blob store in a temporary folder of its own, removed after the test. */
export function blobStore(): BlobStore {
	const root = mkdtempSync(join(tmpdir(), "banda-blobs-"));
	homes.push(root);
	return new BlobStore(root);
}

/** Accept the agent `name`'s file as giving it `tools`. */
export async function allowTools(harness: Harness, name: string, tools: readonly string[]): Promise<void> {
	const text = `---\ndescription: ${name}, for a test\ntools: [${tools.join(", ")}]\n---\n`;
	await harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files[agentPath(name)] = { sha: shaOf(text), text, at: 0 };
	}, context);
}

/** A gateway that records what it sends; `fail` decides per attempt whether a send fails, and how. */
export class FakeGateway implements Gateway {
	readonly strength = "bearer";
	readonly can = { buttons: false, files: false, threads: true };
	readonly sent: { to: Origin; out: Outbound; id: string }[] = [];
	attempts = 0;
	fail: (attempt: number, out: Outbound) => "transient" | "permanent" | undefined = () => undefined;
	readonly name: string;
	constructor(name = "fake") {
		this.name = name;
	}
	start() {}
	async send(to: Origin, out: Outbound): Promise<string> {
		const verdict = this.fail(++this.attempts, out);
		if (verdict === "permanent") throw new PermanentSendError("rejected");
		if (verdict === "transient") throw new Error("unreachable");
		const id = `out-${this.attempts}`;
		this.sent.push({ to, out, id });
		return id;
	}
}

/**
 * A dependency cache of its own for a Vite dev server. Servers sharing `node_modules/.vite` deleted it from under each
 * other: one whose config hashes differently (a fixture's plugin) removes the cache and rebuilds it while another serves
 * a page from it, and that page stays blank. Seeded from the shared cache, so a server with the app's config starts warm.
 */
export async function viteCacheDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "banda-vite-"));
	await cp(join(import.meta.dirname, "../node_modules/.vite/deps"), join(dir, "deps"), { recursive: true }).catch(
		() => {},
	);
	return dir;
}

export interface WebServer {
	readonly vite: ViteDevServer;
	readonly origin: string;
	close(): Promise<void>;
}

/**
 * The web app's Vite dev server, on a port the kernel assigns as it binds. Vite takes `port: 0` as "count up from 5173",
 * and a port found free and bound later can be taken in between, so Vite runs as middleware of a server that binds port 0.
 */
export async function webServer(config: InlineConfig = {}): Promise<WebServer> {
	// here and not at the top: every test imports this file and few start a server
	const { createServer } = await import("vite");
	const listener = createHttpServer((req, res) => vite.middlewares(req, res));
	// a WebSocket is no longer the server's connection once upgraded: closeAllConnections does not reach it
	const upgraded = new Set<Duplex>();
	listener.on("upgrade", (_request, socket: Duplex) => {
		upgraded.add(socket);
		socket.once("close", () => upgraded.delete(socket));
	});
	const vite = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		...config,
		cacheDir: await viteCacheDir(),
		// `middlewareMode.server` is what lets a `ws` entry of `server.proxy` see upgrades
		server: { ...config.server, middlewareMode: { server: listener }, hmr: { server: listener }, open: false },
	});
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", resolve);
	});
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("the web server did not listen");
	return {
		vite,
		origin: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await vite.close();
			await new Promise<void>((resolve, reject) => {
				listener.close((error) => (error ? reject(error) : resolve()));
				// a page's open stream would otherwise hold the close; Vite does this for a server of its own
				listener.closeAllConnections();
				for (const socket of upgraded) socket.destroy();
			});
		},
	};
}
