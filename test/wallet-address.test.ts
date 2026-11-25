/**
 * The EIP-55 form the store keys an address by (C18), built on Node's keccak-256 so the store never loads the signing
 * module (C20, H-306): the EIP's own vectors, agreement with the signing module and viem on generated keys, and the
 * import graph of the store's wallet docs.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getAddress } from "viem";
import { describe, expect, test } from "vitest";
import { checksummed } from "../src/wallet/address.ts";
import { addressOf, generateKey } from "../src/wallet/sign.ts";

/** EIP-55's test cases: all caps, all lower, and mixed. */
const VECTORS = [
	"0x52908400098527886E0F7030069857D2E4169EE7",
	"0x8617E340B3D01FA5F11F306F4090FD50E238070D",
	"0xde709f2102306220921060314715629080e2fb77",
	"0x27b1fdb04752bbc536007a920d24acb045561c26",
	"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
	"0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
	"0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
	"0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("an address's EIP-55 form", () => {
	test("Node's keccak-256 is Keccak, not SHA3-256", async () => {
		const { createHash } = await import("node:crypto");
		expect(createHash("keccak-256").update("").digest("hex")).toBe(
			"c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
		);
	});

	test("matches EIP-55's vectors, from every form EIP-55 accepts", () => {
		for (const vector of VECTORS) {
			const digits = vector.slice(2);
			const mixed = digits !== digits.toLowerCase() && digits !== digits.toUpperCase();
			const expected = mixed ? vector : getAddress(vector);
			expect(checksummed(vector)).toBe(expected);
			expect(checksummed(`0x${digits.toLowerCase()}`)).toBe(expected);
			expect(checksummed(`0x${digits.toUpperCase()}`)).toBe(expected);
		}
	});

	test("agrees with the signing module and viem on generated keys", () => {
		for (let i = 0; i < 32; i++) {
			const address = addressOf(generateKey());
			expect(checksummed(address.toLowerCase())).toBe(address);
			expect(checksummed(address)).toBe(getAddress(address));
		}
	});

	test("refuses a mixed case that fails its checksum, and anything not an address, with fixed text", () => {
		const vector = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
		for (const wrong of [vector.replace("aA", "Aa"), "0x1234", `0X${vector.slice(2)}`, `${vector}00`, 42, undefined])
			expect(() => checksummed(wrong)).toThrow(/^not an address$/);
	});

	test("loading the store's wallet docs loads neither the signing module nor its libraries", async () => {
		// at run time, in a child of its own: a side-effect, dynamic or re-exported import counts as much as a named one
		const script = [
			'import { registerHooks } from "node:module";',
			"const loaded = [];",
			"registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); loaded.push(resolved.url); return resolved; } });",
			`await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/wallet/docs.ts")).href)});`,
			"console.log(JSON.stringify(loaded));",
		].join("\n");
		const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
		const loaded = JSON.parse(stdout) as string[];
		expect(loaded.some((url) => url.endsWith("/src/wallet/address.ts"))).toBe(true);
		expect(loaded.filter((url) => /\/src\/wallet\/sign\.ts$|micro-eth-signer|@noble|@scure/.test(url))).toEqual([]);
	});
});
