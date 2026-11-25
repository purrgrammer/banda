/**
 * The network table and each network's RPC (docs/wallets.md "Chains, RPC and privacy"): the table is stack.md's section
 * 8, the local chains exist only where a test asks for them, one per chain id ISOLATION.md fixes, a replacement's fees
 * rise at least 12.5%, and an RPC the owner set is used or refused, never silently swapped for the public default.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import fc from "fast-check";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { addressRefusal, isLoopback } from "../src/core/addresses.ts";
import { type Config, DEFAULT_MODEL } from "../src/home.ts";
import { maskedRpc, shownRpc, walletRpc } from "../src/wallet/config.ts";
import * as networksModule from "../src/wallet/networks.ts";
import {
	GAS_PRICE_ORACLE,
	type Network,
	NetworkId,
	networkOf,
	networks,
	offersTestChain,
	TEST_CHAIN_ENV,
} from "../src/wallet/networks.ts";
import { pbtRuns } from "./pbt.ts";

const shipped = (id: string): Network => {
	const network = networkOf(id, {});
	if (network === undefined) throw new Error(`no network ${id}`);
	return network;
};
const config = (wallets?: unknown): Config =>
	({ model: DEFAULT_MODEL, ...(wallets === undefined ? {} : { wallets }) }) as Config;

/** EIP-55: a hex letter is upper case where the keccak-256 of the lower-case address has a nibble of 8 or more. */
const checksummed = (address: string) => {
	const lower = address.slice(2).toLowerCase();
	const hash = createHash("keccak-256").update(lower).digest();
	const nibble = (i: number) => ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 15;
	return `0x${[...lower].map((char, i) => (nibble(i) >= 8 ? char.toUpperCase() : char)).join("")}`;
};

describe("the network table", () => {
	it("holds stack.md's section 8, column by column", () => {
		const doc = readFileSync(join(import.meta.dirname, "..", "docs", "wallets", "stack.md"), "utf8");
		const section = doc.slice(doc.indexOf("## 8."), doc.indexOf("## Sources"));
		const row = (name: string) => {
			const line = section.split("\n").find((one) => one.startsWith(`| ${name} |`));
			if (line === undefined) throw new Error(`no row ${name}`);
			return line
				.split("|")
				.slice(2, 4)
				.map((cell) => cell.trim());
		};
		const columns = [shipped("base"), shipped("base-sepolia")];
		expect(row("Chain id")).toEqual(columns.map((one) => String(one.chainId)));
		expect(row("USDC")).toEqual(columns.map((one) => `\`${one.usdc?.address}\``));
		expect(row("USDC EIP-712 domain")).toEqual(
			columns.map((one) => `name "${one.usdc?.name}", version "${one.usdc?.version}"`),
		);
		expect(section).toContain(GAS_PRICE_ORACLE);
		expect(row("Replacement")[0]).toContain("12.5%");
	});

	it("names each network once, by an id its schema accepts, with a CAIP-2 id of its chain", () => {
		const all = networks({ [TEST_CHAIN_ENV]: "1" });
		expect(new Set(all.map((one) => one.id)).size).toBe(all.length);
		const released = networks({});
		expect(new Set(released.map((one) => one.chainId)).size).toBe(released.length);
		for (const one of all) {
			expect(Value.Check(NetworkId, one.id)).toBe(true);
			expect(one.caip2).toBe(`eip155:${one.chainId}`);
			if (one.usdc !== undefined) expect(one.usdc.address).toBe(checksummed(one.usdc.address));
		}
		expect(all.filter((one) => one.usdc === undefined).map((one) => one.id)).toEqual(["anvil"]);
		expect(shipped("base").testnet).toBe(false);
		expect(shipped("base-sepolia").testnet).toBe(true);
	});

	it("shares a chain only between Base Sepolia and anvil-usdc, and offers no lookup by chain to pick between them", () => {
		const all = networks({ [TEST_CHAIN_ENV]: "1" });
		const shared = all.flatMap((one, i) =>
			all.slice(i + 1).flatMap((other) => (other.caip2 === one.caip2 ? [[one.id, other.id]] : [])),
		);
		expect(shared).toEqual([["base-sepolia", "anvil-usdc"]]);
		expect(Object.keys(networksModule).sort()).toEqual([
			"GAS_PRICE_ORACLE",
			"NetworkId",
			"TEST_CHAIN_ENV",
			"networkOf",
			"networks",
			"offersTestChain",
		]);
	});

	it("checks an address's EIP-55 checksum, so a mistyped letter in the table fails", () => {
		expect(checksummed("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
			"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
		);
		const usdc = shipped("base").usdc?.address ?? "";
		const flipped = `${usdc.slice(0, -1)}${usdc.at(-1) === "3" ? "4" : "3"}`;
		expect(checksummed(flipped)).not.toBe(flipped);
	});

	it("ships Base and Base Sepolia over https, with the default RPCs the RFC names", () => {
		expect(networks({}).map((one) => one.id)).toEqual(["base", "base-sepolia"]);
		expect(shipped("base").rpc).toBe("https://base-rpc.publicnode.com");
		for (const one of networks({})) expect(new URL(one.rpc ?? "").protocol).toBe("https:");
		expect(shipped("base-sepolia").rpc).toBe("https://sepolia.base.org");
	});

	it("names the GasPriceOracle on every network the reserve runs on, the local chains included", () => {
		for (const one of networks({ [TEST_CHAIN_ENV]: "1" })) expect(one.gasPriceOracle).toBe(GAS_PRICE_ORACLE);
	});

	it("offers the local chains only where a test asks for them", () => {
		for (const id of ["anvil", "anvil-usdc"]) {
			expect(networkOf(id, {})).toBeUndefined();
			expect(networkOf(id, { [TEST_CHAIN_ENV]: "0" })).toBeUndefined();
			const local = networkOf(id, { [TEST_CHAIN_ENV]: "1" });
			expect(local?.testnet).toBe(true);
			expect(local?.rpc).toBeUndefined();
		}
		expect(networkOf("mainnet", { [TEST_CHAIN_ENV]: "1" })).toBeUndefined();
	});

	it("puts the local chains at exactly the chain ids ISOLATION.md section 3 fixes", () => {
		const doc = readFileSync(join(import.meta.dirname, "..", "docs", "wallets", "features", "ISOLATION.md"), "utf8");
		const section = doc.slice(doc.indexOf("## 3."), doc.indexOf("## 4."));
		const fixed = [...section.matchAll(/^ {2}- (\d+) for (transfer|x402) scenarios/gm)].map((match) => [
			match[2],
			Number(match[1]),
		]);
		expect(fixed).toEqual([
			["transfer", 31337],
			["x402", 84532],
		]);
		const released = new Set(networks({}).map((one) => one.id));
		const local = networks({ [TEST_CHAIN_ENV]: "1" }).filter((one) => !released.has(one.id));
		expect(local.map((one) => [one.id, one.chainId])).toEqual([
			["anvil", 31337],
			["anvil-usdc", 84532],
		]);
	});

	it("refuses the local chain in a build, which every release runs", () => {
		const asked = { [TEST_CHAIN_ENV]: "1" };
		expect(offersTestChain(asked, "file:///checkout/src/wallet/networks.ts")).toBe(true);
		for (const built of [
			"file:///checkout/dist/wallet/networks.js",
			"file:///checkout/release/banda/app/dist/wallet/networks.js",
		]) {
			expect(() => offersTestChain(asked, built)).toThrow(TEST_CHAIN_ENV);
			expect(offersTestChain({}, built)).toBe(false);
		}
	});

	it("puts anvil-usdc on the chain the USDC state fixture was proven on, at the fixture's USDC", () => {
		const fixture = readFileSync(
			join(import.meta.dirname, "..", "docs", "wallets", "spikes", "gaps", "x402-state", "common.mjs"),
			"utf8",
		);
		const local = networkOf("anvil-usdc", { [TEST_CHAIN_ENV]: "1" });
		expect(fixture).toContain(`export const CHAIN_ID = ${local?.chainId};`);
		expect(fixture).toContain(`export const USDC = "${local?.usdc?.address}";`);
	});
});

describe("each network's RPC", () => {
	const base = shipped("base");
	const anvil = networkOf("anvil", { [TEST_CHAIN_ENV]: "1" }) as Network;
	const quiet = (call: () => unknown, secret: string) => {
		expect(call).toThrow(/wallets/);
		try {
			call();
		} catch (error) {
			expect((error as Error).message).not.toContain(secret);
		}
	};

	const url = (wallets: unknown, network: Network = base) => walletRpc(config(wallets), network).url;

	it("takes the shipped default when config.json sets none", () => {
		expect(walletRpc(config(), base)).toEqual({ url: base.rpc, headers: {} });
		expect(url({})).toBe(base.rpc);
		expect(url({ rpc: { "base-sepolia": "https://sepolia.example" } })).toBe(base.rpc);
	});

	it("takes an RPC for every network NetworkId names, and refuses a key it names not", () => {
		// the keys config.json may set are NetworkId's own: no second list to fall out of step with it
		const every = Object.fromEntries(NetworkId.anyOf.map((id) => [id.const, "http://127.0.0.1:51234"]));
		expect(Object.keys(every).sort()).toEqual(["anvil", "anvil-usdc", "base", "base-sepolia"]);
		expect(url({ rpc: every }, anvil)).toBe("http://127.0.0.1:51234/");
		quiet(() => url({ rpc: { ...every, "base-mainnet": "http://127.0.0.1:1" } }), "base-mainnet");
	});

	it("has no default for a local chain: a test sets the port the system assigned", () => {
		const usdc = networkOf("anvil-usdc", { [TEST_CHAIN_ENV]: "1" }) as Network;
		quiet(() => walletRpc(config(), anvil), "127.0.0.1");
		quiet(() => walletRpc(config(), usdc), "127.0.0.1");
		const both = { rpc: { anvil: "http://127.0.0.1:51234", "anvil-usdc": "http://127.0.0.1:51235" } };
		expect(url(both, anvil)).toBe("http://127.0.0.1:51234/");
		expect(url(both, usdc)).toBe("http://127.0.0.1:51235/");
	});

	it("takes the owner's over https, normalised, key and all", () => {
		expect(walletRpc(config({ rpc: { base: "https://rpc.example/v2/k" } }), base)).toEqual({
			url: "https://rpc.example/v2/k",
			headers: {},
		});
		expect(url({ rpc: { base: "HTTPS://RPC.example" } })).toBe("https://rpc.example/");
		expect(url({ rpc: { base: "https://rpc.example/?key=secret" } })).toBe("https://rpc.example/?key=secret");
	});

	it("moves a URL's userinfo, which fetch refuses, into a Basic Authorization header", () => {
		const rpc = walletRpc(config({ rpc: { base: "https://u%40x:se%3Acret@rpc.example/v2?k=1" } }), base);
		expect(rpc.url).toBe("https://rpc.example/v2?k=1");
		expect(rpc.headers).toEqual({ authorization: `Basic ${Buffer.from("u@x:se:cret").toString("base64")}` });
		expect(() => new Request(rpc.url)).not.toThrow();
		expect(walletRpc(config({ rpc: { base: "https://u@rpc.example" } }), base).headers).toEqual({
			authorization: `Basic ${Buffer.from("u:").toString("base64")}`,
		});
		quiet(() => walletRpc(config({ rpc: { base: "https://u:secret%zz@rpc.example" } }), base), "secret");
	});

	it("takes plain http only from localhost (H-196)", () => {
		for (const local of [
			"http://localhost:8545",
			"http://127.0.0.1:8545",
			"http://127.9.9.9",
			"http://[::1]:8545",
			"http://[::ffff:127.0.0.1]:8545",
		])
			expect(url({ rpc: { base: local } })).toBe(new URL(local).href);
		expect(url({ rpc: { base: "https://localhost:8545" } })).toBe("https://localhost:8545/");
		for (const plain of ["http://rpc.example/secret", "http://8.8.8.8/secret"]) {
			quiet(() => walletRpc(config({ rpc: { base: plain } }), base), "secret");
			expect(() => walletRpc(config({ rpc: { base: plain } }), base)).toThrow(
				new Error("config.json's wallets.rpc.base is plain http: only localhost is taken over http"),
			);
		}
	});

	it("refuses a private address, over http or https (H-196)", () => {
		for (const host of [
			"192.168.1.4:8545",
			"10.0.0.1",
			"172.16.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"[fd00::1]",
			"[fe80::1]",
			"[::ffff:192.168.1.4]",
			"0xc0.0xa8.1.4",
			"[::192.168.1.4]",
			"[::ffff:0:c0a8:104]",
			"[64:ff9b::c0a8:104]",
			"[64:ff9b:1::c0a8:104]",
			"[2002:c0a8:104::]",
			"[2001::1]",
			"[2001:2::1]",
			"[2001:10::1]",
			"[2001:20::1]",
			"[2001:db8::1]",
			"[3fff::1]",
			"[5f00::1]",
			"[fec0::1]",
			"[100::1]",
			"[100:0:0:1::1]",
			"[4000::1]",
			"[1::1]",
			"[e000::1]",
			"192.0.0.8",
			"192.0.2.1",
			"192.88.99.1",
			"198.18.0.1",
			"198.19.255.1",
			"198.51.100.1",
			"203.0.113.1",
			"240.0.0.1",
		]) {
			quiet(() => walletRpc(config({ rpc: { base: `http://${host}/secret` } }), base), "secret");
			expect(() => walletRpc(config({ rpc: { base: `https://${host}/secret` } }), base)).toThrow(
				new Error("config.json's wallets.rpc.base names a private address: only localhost is taken"),
			);
		}
	});

	it("refuses loopback that an IPv6 form other than the mapped one embeds, which names a translator or tunnel", () => {
		for (const host of ["[::7f00:1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]"])
			for (const scheme of ["http", "https"])
				expect(() => walletRpc(config({ rpc: { base: `${scheme}://${host}/secret` } }), base)).toThrow(
					new Error(
						"config.json's wallets.rpc.base names loopback inside another IPv6 address: only localhost is taken",
					),
				);
	});

	it("takes a public address, written plainly or embedded in IPv6", () => {
		for (const host of ["8.8.8.8", "[2606:4700::1111]", "[::ffff:8.8.8.8]", "[64:ff9b::808:808]", "[2002:808:808::]"])
			expect(url({ rpc: { base: `https://${host}/` } })).toBe(
				`https://${host.replace("::ffff:8.8.8.8", "::ffff:808:808")}/`,
			);
	});

	it("refuses one that is not an http(s) URL, without falling back or repeating it", () => {
		for (const bad of [
			"wss://rpc.example/secret",
			"file:///etc/passwd/secret",
			"rpc.example/secret",
			"http://[::1/secret",
			"https://rpc.example/secret\u0000",
			" https://rpc.example/secret",
			"https://rpc.example/se cret",
			"http://",
			42,
			"",
		])
			quiet(() => walletRpc(config({ rpc: { base: bad } }), base), "secret");
		expect(() => walletRpc(config({ rpc: { base: "http://[::1" } }), base)).toThrow(/is not a URL/);
		expect(() => walletRpc(config({ rpc: "https://rpc.example" }), base)).toThrow(/wallets/);
		expect(() => walletRpc(config([]), base)).toThrow(/wallets/);
	});

	it("refuses a key that names no network, rather than falling back to the public default", () => {
		for (const key of ["Base", "", "base-mainnet"])
			quiet(() => walletRpc(config({ rpc: { [key]: "https://my.node/secret" } }), base), "secret");
	});

	it("never repeats a key the owner wrote, which may be a keyed URL pasted in the wrong place", () => {
		for (const key of ["https://u:SECRETKEY@rpc.example", "SECRETKEY", "base/SECRETKEY"]) {
			quiet(() => walletRpc(config({ rpc: { [key]: "https://rpc.example" } }), base), "SECRETKEY");
			quiet(() => walletRpc(config({ [key]: { base: "x" }, rpc: { [key]: 1 } }), base), "SECRETKEY");
		}
		expect(() => walletRpc(config({ rpc: { SECRETKEY: "x" } }), base)).toThrow(
			"config.json's wallets.rpc has a key that names no network",
		);
		expect(() => walletRpc(config({ rpc: { base: 7 } }), base)).toThrow(
			"config.json's wallets.rpc.base is not a string",
		);
		expect(() => walletRpc(config("SECRETKEY"), base)).toThrow("config.json's wallets is not an object");
		expect(() => walletRpc(config({ rpc: "SECRETKEY" }), base)).toThrow("config.json's wallets.rpc is not an object");
	});

	it("refuses the whole section for every network when one entry is malformed", () => {
		quiet(() => walletRpc(config({ rpc: { base: "https://rpc.example", "base-sepolia": 7 } }), base), "rpc.example");
	});

	it("refuses a misspelt section under wallets, rather than falling back to the public default", () => {
		for (const key of ["rcp", "RPC"])
			expect(() => walletRpc(config({ [key]: { base: "https://my.private.node/secret" } }), base)).toThrow(
				new Error("config.json's wallets has a key this build does not read"),
			);
	});

	it("leaves the rest of config.json alone", () => {
		const rest = {
			...config({ rpc: { base: "https://rpc.example" } }),
			later: true,
			egress: { git: ["git.example"] },
		};
		expect(walletRpc(rest as Config, base).url).toBe("https://rpc.example/");
	});
});

describe("a literal address, as a resolver answers it", () => {
	const base = shipped("base");

	it("gets the verdict walletRpc gives that address written in a URL", () => {
		fc.assert(
			fc.property(fc.oneof(fc.ipV4(), fc.ipV6()), (ip) => {
				const host = isIP(ip) === 6 ? `[${ip}]` : ip;
				const verdict = (() => {
					try {
						walletRpc(config({ rpc: { base: `https://${host}/` } }), base);
						return "taken";
					} catch {
						return "refused";
					}
				})();
				const expected = isLoopback(ip) || addressRefusal(ip) === undefined ? "taken" : "refused";
				expect(verdict).toBe(expected);
			}),
			{ numRuns: pbtRuns(200) },
		);
	});
});

describe("an RPC URL as the owner and the logs see it (H-195)", () => {
	it("shows the scheme, host and port, and masks userinfo, path, query and fragment", () => {
		expect(maskedRpc("https://base-rpc.publicnode.com")).toBe("https://base-rpc.publicnode.com");
		expect(maskedRpc("http://127.0.0.1:8545/")).toBe("http://127.0.0.1:8545");
		expect(maskedRpc("https://base-mainnet.g.alchemy.com/v2/SECRET")).toBe("https://base-mainnet.g.alchemy.com/•••");
		expect(maskedRpc("https://u:SECRET@rpc.example:8443/?key=SECRET#SECRET")).toBe("https://•••@rpc.example:8443/•••");
		expect(maskedRpc("https://rpc.example/?key=SECRET")).toBe("https://rpc.example/•••");
		expect(maskedRpc("https://rpc.example/#SECRET")).toBe("https://rpc.example/•••");
		for (const bad of ["SECRET", "wss://rpc.example/SECRET", "https://[SECRET"]) expect(maskedRpc(bad)).toBe("•••");
	});

	it("shows the RPC walletRpc gave as the URL the owner set: a credential moved into its header is still •••@", () => {
		const shown = (rpc: string) => shownRpc(walletRpc(config({ rpc: { base: rpc } }), shipped("base")));
		expect(shown("https://u:SECRET@rpc.example:8443/v2/SECRET")).toBe("https://•••@rpc.example:8443/•••");
		expect(shown("https://u:SECRET@rpc.example:8443/v2/SECRET")).toBe(
			maskedRpc("https://u:SECRET@rpc.example:8443/v2/SECRET"),
		);
		expect(shown("https://:SECRET@rpc.example/")).toBe("https://•••@rpc.example");
		expect(shown("https://rpc.example/?key=SECRET")).toBe("https://rpc.example/•••");
		expect(shown("https://rpc.example")).toBe("https://rpc.example");
	});

	it("never shows a byte of userinfo, path, query or fragment", () => {
		const word = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/);
		fc.assert(
			fc.property(word, word, word, word, (user, path, query, fragment) => {
				const masked = maskedRpc(`https://${user}:${user}@rpc.example/${path}?k=${query}#${fragment}`);
				for (const secret of [user, path, query, fragment]) expect(masked).not.toContain(secret);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});
