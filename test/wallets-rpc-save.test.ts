/**
 * The owner sets a network's RPC (`PUT /api/wallets/rpc/<network>`, H-195, H-196, UC-04): `walletRpc` takes the URL
 * first; then its host name is resolved once, every answer, and one that is loopback, private or special purpose
 * refuses it, as a literal address would be, while localhost stays allowed. What is saved goes into `config.json`'s
 * `wallets.rpc` alone, the rest of the file kept, owner-only; a keyed RPC never appears unmasked in a response, a
 * refusal, the store or the logs.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { WalletNetworkView } from "../src/server/api.ts";
import { BadRequest } from "../src/server/http.ts";
import type { AreaRequest, Deps } from "../src/server/routes/area.ts";
import { type Resolve, rpcHostProblem, saveRpc, sweepRpcTemporary, wallets } from "../src/server/routes/wallets.ts";
import { maskedRpc } from "../src/wallet/config.ts";
import { networkOf } from "../src/wallet/networks.ts";
import { type Connected as Opened, openConnected } from "./fixtures/connected.ts";
import { tempHome } from "./helpers.ts";

const SEPOLIA = networkOf("base-sepolia")!;
const SECRET = "k3y-0f-th3-rpc";
const KEYED = `https://owner:${SECRET}@rpc.example.com/v2/${SECRET}?token=${SECRET}`;

/** A resolver that answers `answers` for every name, and says which it was asked. */
const faux = (...answers: string[]): Resolve & { asked: string[] } => {
	const asked: string[] = [];
	const resolve = async (host: string) => {
		asked.push(host);
		return answers.map((address) => ({ address }));
	};
	return Object.assign(resolve, { asked });
};

const opened: Opened[] = [];
afterEach(async () => {
	for (const s of opened.splice(0)) await s.close();
});

const refused = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(BadRequest);
	expect((error as Error).message).not.toContain(SECRET);
	return error as BadRequest;
};

/** Every file under `dir` that holds `text`. */
function holding(dir: string, text: string): string[] {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const name of readdirSync(at)) {
			const path = join(at, name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory()) walk(path);
			else if (stat !== undefined && readFileSync(path).toString("latin1").includes(text)) found.push(path);
		}
	};
	walk(dir);
	return found;
}

describe("saving a network's RPC", () => {
	it("refuses a host name that resolves to a private, link-local, special or loopback address", async () => {
		for (const answers of [
			["10.0.0.7"],
			["93.184.216.34", "192.168.1.2"],
			["169.254.169.254"],
			["fd00::1"],
			["127.0.0.1"],
			["::ffff:10.0.0.1"],
		]) {
			const resolve = faux(...answers);
			expect(await rpcHostProblem("https://rpc.example.com/", resolve), answers.join()).toBeDefined();
			expect(resolve.asked).toEqual(["rpc.example.com"]);
		}
		expect(await rpcHostProblem("https://rpc.example.com/", faux())).toBe("its host name could not be resolved");
		expect(
			await rpcHostProblem("https://rpc.example.com/", async () => {
				throw new Error("ENOTFOUND rpc.example.com");
			}),
		).toBe("its host name could not be resolved");
		expect(
			await rpcHostProblem("https://rpc.example.com/", faux("93.184.216.34", "2606:2800:220:1::1")),
		).toBeUndefined();
		// localhost and a literal address are walletRpc's to decide, and nothing is resolved
		const never = faux("10.0.0.1");
		expect(await rpcHostProblem("http://localhost:8545/", never)).toBeUndefined();
		expect(await rpcHostProblem("http://127.0.0.1:8545/", never)).toBeUndefined();
		expect(never.asked).toEqual([]);
	});

	it("keeps the rest of config.json, writes it owner-only, and answers the keyed URL masked", async () => {
		const home = await tempHome();
		const path = join(home, "config.json");
		writeFileSync(path, JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, files: { maxBytes: 1024 } }));
		expect(await saveRpc(home, SEPOLIA, KEYED, faux("93.184.216.34"))).toBe(maskedRpc(KEYED));
		expect(maskedRpc(KEYED)).not.toContain(SECRET);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toEqual({
			model: { provider: "faux", modelId: "faux-1" },
			files: { maxBytes: 1024 },
			wallets: { rpc: { "base-sepolia": KEYED } },
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
		// a private answer leaves the file as it was
		await refused(saveRpc(home, SEPOLIA, "https://intranet.example.com/rpc", faux("10.1.2.3")));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved);
		// what walletRpc refuses is refused in its fixed words, before anything is resolved
		// in words written for the field the owner typed in, never the file and its key, which the owner did not edit
		const unasked = faux("93.184.216.34");
		for (const [url, words] of [
			["ftp://rpc.example.com/", "This RPC is not an http(s) URL"],
			[`http://owner:${SECRET}@rpc.example.com/`, "This RPC is plain http: only localhost is taken over http"],
			["https://10.0.0.1/", "This RPC names a private address: only localhost is taken"],
			["not a url", "This RPC holds a space or a control character"],
			["https://[::1", "This RPC is not a URL"],
		] as const) {
			const error = await refused(saveRpc(home, SEPOLIA, url, unasked));
			expect(error.message).toBe(words);
			expect(error.message).not.toContain("config.json");
		}
		expect(unasked.asked).toEqual([]);
		// null takes the default again, and drops the section when nothing is left in it
		expect(await saveRpc(home, SEPOLIA, null)).toBe(maskedRpc(SEPOLIA.rpc!));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			model: { provider: "faux", modelId: "faux-1" },
			files: { maxBytes: 1024 },
		});
		writeFileSync(path, "{ not json");
		expect((await refused(saveRpc(home, SEPOLIA, KEYED, faux("93.184.216.34")))).status).toBe(409);
	});

	it("runs saves at once one after another, so none fails and none is lost", async () => {
		const home = await tempHome();
		const BASE = networkOf("base")!;
		const urls = Array.from({ length: 6 }, (_, at) => `https://rpc${at}.example.com/`);
		const saved = await Promise.all(
			urls.map((url, at) => saveRpc(home, at % 2 === 0 ? SEPOLIA : BASE, url, faux("93.184.216.34"))),
		);
		expect(saved).toEqual(urls.map((url) => maskedRpc(url)));
		const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
		expect(file.wallets.rpc).toEqual({ "base-sepolia": urls[4], base: urls[5] });
		expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("leaves no keyed URL in a temporary a save killed before its rename left: the next save and the start take it", async () => {
		const home = await tempHome();
		const left = join(home, "config.json.tmp");
		// what a kill between the temporary's write and its rename leaves
		writeFileSync(left, JSON.stringify({ wallets: { rpc: { "base-sepolia": KEYED } } }), { mode: 0o600 });
		await sweepRpcTemporary(home);
		expect(holding(home, SECRET)).toEqual([]);
		writeFileSync(left, JSON.stringify({ wallets: { rpc: { "base-sepolia": KEYED } } }), { mode: 0o600 });
		expect(await saveRpc(home, SEPOLIA, "https://rpc.example.com/", faux("93.184.216.34"))).toBe(
			maskedRpc("https://rpc.example.com/"),
		);
		expect(holding(home, SECRET)).toEqual([]);
		expect(readdirSync(home).filter((name) => name.startsWith("config.json"))).toEqual(["config.json"]);
	});

	it("through the route: localhost is taken, a keyed RPC is never in the response, the store or the logs", async () => {
		const home = await tempHome();
		const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
		opened.push(s);
		const logs: string[] = [];
		const area = wallets.start?.({
			harness: s.harness,
			home,
			box: "container",
			log: (line: string) => logs.push(line),
			changed: () => {},
			connections: s.capabilities,
		} as unknown as Deps);
		try {
			const put = (url: string | null) =>
				area?.route?.({
					method: "PUT",
					path: "/wallets/rpc/base-sepolia",
					url: new URL("http://local/api/wallets/rpc/base-sepolia"),
					json: async () => ({ url }),
					signal: new AbortController().signal,
					connection: {},
				} as AreaRequest);
			const local = `http://owner:${SECRET}@localhost:8545/${SECRET}`;
			const answered = await put(local);
			expect(answered).toMatchObject({ body: { id: "base-sepolia", set: true, rpc: "http://•••@localhost:8545/•••" } });
			expect(JSON.stringify(answered)).not.toContain(SECRET);
			const listed = (await area?.route?.({
				method: "GET",
				path: "/wallets",
				url: new URL("http://local/api/wallets"),
				json: async () => ({}),
				signal: new AbortController().signal,
				connection: {},
			} as AreaRequest)) as { body: { networks: WalletNetworkView[] } };
			expect(JSON.stringify(listed)).not.toContain(SECRET);
			expect(listed.body.networks.find((each) => each.id === "base-sepolia")).toMatchObject({ set: true });
			await refused(put("ftp://rpc.example.com/") as Promise<unknown>);
			expect(logs.join("\n")).toContain("localhost:8545");
			expect(logs.join("\n")).not.toContain(SECRET);
			expect(s.logs.join("\n")).not.toContain(SECRET);
			// config.json holds it, owner-only; nothing else in the home does
			expect(holding(home, SECRET)).toEqual([join(home, "config.json")]);
		} finally {
			await area?.stop?.();
		}
	});
});
