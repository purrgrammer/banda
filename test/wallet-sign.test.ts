/**
 * The signing module (docs/wallets/stack.md section 1): golden vectors per network (H-155), an EIP-1559 transfer on
 * each of anvil's chain, Base Sepolia and Base and an EIP-3009 authorization on each of Base Sepolia and Base, each
 * cross-checked once with viem and with cast; its exports; and properties checked against viem, a second
 * implementation tests may load (a pinned devDependency, never shipped): what banda signs recovers to the key's
 * address and matches viem byte for byte, a field a caller adds past `Transfer` changes nothing, and a refusal never
 * carries the key.
 */
import fc from "fast-check";
import {
	type Hex,
	keccak256,
	parseTransaction,
	recoverTransactionAddress,
	recoverTypedDataAddress,
	type TransactionSerializedEIP1559,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import type { Address } from "../src/wallet/address.ts";
import { networkOf } from "../src/wallet/networks.ts";
import * as sign from "../src/wallet/sign.ts";
import { addressOf, generateKey, signTransfer, signTransferWithAuthorization } from "../src/wallet/sign.ts";
import { pbtRuns, pbtTimeout } from "./pbt.ts";

/** anvil's public dev accounts 0 and 1. */
const DEV0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEV0_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEV1_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SEPOLIA_USDC = networkOf("base-sepolia")?.usdc as sign.AuthorizedToken & { address: Address };
const GWEI = 10n ** 9n;

const ANVIL_1559 =
	"0x02f873827a6980843b9aca0084b2d05e008252089470997970c51812dc3a010c7d01b50e0d17dc79c887038d7ea4c6800080c080a0dc36905d114979e456e32f5ee4c7843768e568c71278d46b1fdd45685dab3f21a03e3dcf94a4601571e31e9401d8e95482235ed24ef5d7cd608640edad5335efdb";
/** The keys spike's authorization, valid from 0 until 2026-11-23: a window C19 never signs. */
const SPIKE_3009 =
	"0x1b37a5d0dda69030c75cd3205e9fbfd9735168a016253dad3c0917cf701c0e7703ba798cf3b47020ede9361b39a25b68b2e4a63206493107dc50ac6398d9b4521c";
const SEPOLIA_3009 =
	"0x761f1ec41545ef154035655988e5b5e650e90d0ab2e2f8f9b4541ecd6cd30fa75831bf81978e7b0da6043b3bc3453ea078b58cdcaed38cbe53b45bbae95954c81b";
const SEPOLIA_1559 =
	"0x02f8b083014a3480830f42408398968082fde894036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000002710c001a06d6f65c19d3be4b3f136a00fc9cc074b3a574852c43c56c04ae39dc9d89cf7a3a01ce2c4b73afe5954dfac4ff921a240aa912dce79b42c434c2d618dcb2409245e";
const BASE_1559 =
	"0x02f8af82210580830f42408398968082fde894833589fcd6edb6e08f4c7c32d4f71b54bda0291380b844a9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000000002710c080a0c01f3b911db79ca5ae108900844b465d0c946f006330c54fcfddf9a9eb10ab88a04c7005b777811a8b2a6b492a6a1370aec236d2cb55660bac4aaf8bcdd6012871";
const BASE_3009 =
	"0xe50a045f21a66a775056937f496cd8a543aaf5f70e2827f22376751f38f12be92ac48562920783a0db82dbd9a533605aef8f08bbec9016b2e08ecb9aca4bd7661c";
const BASE_USDC = networkOf("base")?.usdc as sign.AuthorizedToken & { address: Address };

/** A USDC transfer of 0.01 to DEV1, the same on Base Sepolia and Base but for the chain and the token. */
const usdcTransfer = (chainId: number, token: Address) =>
	({
		key: DEV0,
		chainId,
		nonce: 0n,
		tip: 1_000_000n,
		maxFee: 10_000_000n,
		gasLimit: 65000n,
		to: DEV1_ADDR,
		value: 10000n,
		token,
	}) as const;

/** What `approve(Permit2, 2^256 - 1)` encodes: the allowance H-151 bars. */
const APPROVE_PERMIT2 =
	`0x095ea7b3${"000000000022d473030f116ddee9f6b43ac78ba3".padStart(64, "0")}${"f".repeat(64)}` as Hex;
/** Fields a caller could add past `Transfer`: calldata, a type-4 transaction, an access list, a delegation, blobs. */
const EXTRA_FIELDS = {
	data: APPROVE_PERMIT2,
	input: APPROVE_PERMIT2,
	type: "eip7702",
	accessList: [{ address: DEV1_ADDR, storageKeys: [`0x${"00".repeat(32)}`] }],
	authorizationList: [{ chainId: 31337, address: DEV1_ADDR, nonce: 0n, r: 1n, s: 1n, yParity: 0 }],
	maxFeePerBlobGas: 1n,
	blobVersionedHashes: [`0x01${"00".repeat(31)}`],
	gasPrice: 1n,
} as const;

/** secp256k1's order n: a key must be in [1, n - 1]. */
const CURVE_ORDER = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";

const golden = {
	key: DEV0,
	chainId: 31337,
	nonce: 0n,
	tip: GWEI,
	maxFee: 3n * GWEI,
	gasLimit: 21000n,
	to: DEV1_ADDR,
	value: 10n ** 15n,
} as const;

const goldenAuthorization = {
	key: DEV0,
	chainId: 84532,
	token: SEPOLIA_USDC,
	to: DEV1_ADDR,
	value: 10000n,
	validAfter: 1795439900n,
	validBefore: 1795440000n,
	nonce: `0x${"ab".repeat(32)}`,
} as const;

const TYPES = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" },
		{ name: "to", type: "address" },
		{ name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" },
		{ name: "validBefore", type: "uint256" },
		{ name: "nonce", type: "bytes32" },
	],
} as const;

describe("the signing module", () => {
	test("exports the two signing operations, the key and address helpers, and nothing else", () => {
		expect(Object.keys(sign).sort()).toEqual([
			"addressOf",
			"generateKey",
			"signTransfer",
			"signTransferWithAuthorization",
		]);
	});

	test("an EIP-1559 transfer matches the golden vector", () => {
		const { raw, hash } = signTransfer(golden);
		expect(raw).toBe(ANVIL_1559);
		expect(hash).toBe(keccak256(ANVIL_1559));
	});

	test("a field a caller adds past a transfer's is not signed: no calldata, type, access list or delegation", () => {
		expect(signTransfer({ ...golden, ...EXTRA_FIELDS } as unknown as sign.Transfer).raw).toBe(ANVIL_1559);
		const token = { ...usdcTransfer(8453, BASE_USDC.address), ...EXTRA_FIELDS } as unknown as sign.Transfer;
		expect(signTransfer(token).raw).toBe(BASE_1559);
	});

	test("an EIP-3009 authorization on Base Sepolia, under its USDC domain, matches the golden vector", () => {
		expect(SEPOLIA_USDC).toMatchObject({
			address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			name: "USDC",
			version: "2",
		});
		expect(signTransferWithAuthorization(goldenAuthorization)).toEqual({ from: DEV0_ADDR, signature: SEPOLIA_3009 });
	});

	test("the keys spike's authorization, valid from 0, is what viem signs and is refused here", async () => {
		const spike = { ...goldenAuthorization, validAfter: 0n };
		const viem = await privateKeyToAccount(DEV0).signTypedData({
			types: TYPES,
			primaryType: "TransferWithAuthorization",
			domain: {
				name: SEPOLIA_USDC.name,
				version: SEPOLIA_USDC.version,
				chainId: 84532,
				verifyingContract: SEPOLIA_USDC.address,
			},
			message: {
				from: DEV0_ADDR,
				to: DEV1_ADDR,
				value: spike.value,
				validAfter: 0n,
				validBefore: spike.validBefore,
				nonce: spike.nonce,
			},
		});
		expect(viem).toBe(SPIKE_3009);
		expect(() => signTransferWithAuthorization(spike)).toThrow("cannot sign: the validity window is longer than 185 s");
	});

	test("a USDC transfer on Base Sepolia matches its golden vector", () => {
		const { raw, hash } = signTransfer(usdcTransfer(84532, SEPOLIA_USDC.address));
		expect(raw).toBe(SEPOLIA_1559);
		expect(hash).toBe(keccak256(SEPOLIA_1559));
	});

	test("a USDC transfer on Base matches its golden vector", () => {
		expect(BASE_USDC).toMatchObject({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" });
		const { raw, hash } = signTransfer(usdcTransfer(8453, BASE_USDC.address));
		expect(raw).toBe(BASE_1559);
		expect(hash).toBe(keccak256(BASE_1559));
	});

	test("an authorization on Base, under its USD Coin domain, matches its golden vector", () => {
		expect(signTransferWithAuthorization({ ...goldenAuthorization, chainId: 8453, token: BASE_USDC })).toEqual({
			from: DEV0_ADDR,
			signature: BASE_3009,
		});
	});

	test("a cancel, a value-0 send to the wallet itself, is signed", async () => {
		const self = addressOf(DEV0);
		const { raw } = signTransfer({ ...golden, to: self, value: 0n });
		const serialized = raw as TransactionSerializedEIP1559;
		const tx = parseTransaction(serialized);
		expect(tx.to).toBe(self.toLowerCase());
		expect(tx.value ?? 0n).toBe(0n);
		expect(tx.data ?? "0x").toBe("0x");
		expect(await recoverTransactionAddress({ serializedTransaction: serialized })).toBe(self);
	});

	test("a token transfer needs its calldata's gas, at EIP-7623's floor, on top of 21,000", () => {
		const token = { ...golden, token: SEPOLIA_USDC.address, value: 10000n };
		const { data } = parseTransaction(signTransfer({ ...token, gasLimit: 65000n }).raw as TransactionSerializedEIP1559);
		const bytes = Buffer.from((data ?? "0x").slice(2), "hex");
		const tokens = bytes.reduce((sum, byte) => sum + (byte === 0 ? 1 : 4), 0);
		const intrinsic = 21000n + 10n * BigInt(tokens);
		expect(intrinsic).toBeGreaterThan(21000n);
		expect(signTransfer({ ...token, gasLimit: intrinsic }).raw).toMatch(/^0x02/);
		expect(() => signTransfer({ ...token, gasLimit: intrinsic - 1n })).toThrow(
			"cannot sign: the gas limit is below a transfer's",
		);
		expect(() => signTransfer({ ...token, gasLimit: 21000n })).toThrow(
			"cannot sign: the gas limit is below a transfer's",
		);
	});

	test("the domain's name is part of what is signed", () => {
		const other = signTransferWithAuthorization({
			...goldenAuthorization,
			token: { ...SEPOLIA_USDC, name: "USD Coin" },
		});
		expect(other.signature).not.toBe(SEPOLIA_3009);
	});

	test("an address checksummed, lowercase or uppercase signs the same bytes", () => {
		const forms = (address: Address) =>
			[address, address.toLowerCase(), `0x${address.slice(2).toUpperCase()}`] as Address[];
		const sepolia = usdcTransfer(84532, SEPOLIA_USDC.address);
		for (const to of forms(DEV1_ADDR)) {
			expect(signTransfer({ ...golden, to }).raw).toBe(ANVIL_1559);
			expect(signTransferWithAuthorization({ ...goldenAuthorization, to }).signature).toBe(SEPOLIA_3009);
			for (const token of forms(SEPOLIA_USDC.address)) {
				expect(signTransfer({ ...sepolia, to, token }).raw).toBe(SEPOLIA_1559);
				const authorization = { ...goldenAuthorization, to, token: { ...SEPOLIA_USDC, address: token } };
				expect(signTransferWithAuthorization(authorization).signature).toBe(SEPOLIA_3009);
			}
		}
	});

	test("a key is checked against the curve's order at its boundary (H-003): n refused, n - 1 kept, 31 bytes refused", () => {
		for (const key of [CURVE_ORDER, `0x${"00".repeat(32)}`])
			expect(() => addressOf(key as sign.Key)).toThrow("cannot sign: the key is not a secp256k1 private key");
		expect(() => addressOf(`0x${"ab".repeat(31)}` as sign.Key)).toThrow(
			"cannot sign: the key is not 0x and 64 hex digits",
		);
		const last = `0x${(BigInt(CURVE_ORDER) - 1n).toString(16)}` as sign.Key;
		expect(addressOf(last)).toBe(privateKeyToAccount(last).address);
		const { raw } = signTransfer({ ...golden, key: last });
		expect(raw).toMatch(/^0x02/);
	});

	test("a key's address carries its checksum", () => {
		expect(addressOf(DEV0)).toBe(DEV0_ADDR);
		expect(addressOf(DEV0.toUpperCase().replace("0X", "0x") as sign.Key)).toBe(DEV0_ADDR);
	});

	test("a generated key is 0x and 64 lowercase hex digits, and fresh each time", () => {
		const keys = new Set(Array.from({ length: 16 }, () => generateKey()));
		expect(keys.size).toBe(16);
		for (const key of keys) expect(key).toMatch(/^0x[0-9a-f]{64}$/);
	});

	test("a token transfer calls transfer(address,uint256) on the token, moving no ETH", () => {
		const { raw } = signTransfer({ ...golden, gasLimit: 65000n, token: SEPOLIA_USDC.address, value: 10000n });
		const tx = parseTransaction(raw as TransactionSerializedEIP1559);
		expect(tx.to).toBe(SEPOLIA_USDC.address.toLowerCase());
		expect(tx.value ?? 0n).toBe(0n);
		expect(tx.data).toBe(
			`0xa9059cbb${DEV1_ADDR.slice(2).toLowerCase().padStart(64, "0")}${10000n.toString(16).padStart(64, "0")}`,
		);
		expect(tx.chainId).toBe(31337);
	});

	test("the last nonce EIP-2681 allows is signed", () => {
		expect(signTransfer({ ...golden, nonce: (1n << 64n) - 2n }).raw).toMatch(/^0x02/);
	});

	test.each([
		["missing", undefined],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["a bigint", 31337n],
	])("a chain id that is %s is refused", (_, chainId) => {
		const message = "cannot sign: the chain id is missing or not a positive integer";
		expect(() => signTransfer({ ...golden, chainId } as unknown as sign.Transfer)).toThrow(message);
		expect(() =>
			signTransferWithAuthorization({ ...goldenAuthorization, chainId } as unknown as sign.TransferAuthorization),
		).toThrow(message);
	});

	test.each([
		["a broken checksum", { to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C9" }, "the recipient is not an address"],
		["a short address", { to: "0x7099" }, "the recipient is not an address"],
		["a negative value", { value: -1n }, "the value is out of range"],
		["a number for a value", { value: 1 }, "the value is out of range"],
		["a tip over the max fee", { tip: 4n * GWEI }, "the tip is out of range"],
		["a gas limit below 21000", { gasLimit: 20999n }, "the gas limit is below a transfer's"],
		[
			"a token transfer at 21000 gas",
			{ token: SEPOLIA_USDC.address, gasLimit: 21000n },
			"the gas limit is below a transfer's",
		],
		["a gas limit over a block's", { gasLimit: 30_000_001n }, "the gas limit is out of range"],
		["no max fee", { maxFee: 0n, tip: 0n }, "the max fee is out of range"],
		["a max fee over 10,000 gwei", { maxFee: 10_001n * GWEI }, "the max fee is out of range"],
		["a nonce of 2^64 - 1", { nonce: (1n << 64n) - 1n }, "the nonce is out of range"],
		["a token that is not an address", { token: "usdc" }, "the token is not an address"],
		["a key of the wrong length", { key: "0x1234" }, "the key is not 0x and 64 hex digits"],
		["the zero key", { key: `0x${"00".repeat(32)}` }, "the key is not a secp256k1 private key"],
		["a key past the curve's order", { key: `0x${"ff".repeat(32)}` }, "the key is not a secp256k1 private key"],
		["a key equal to the curve's order", { key: CURVE_ORDER }, "the key is not a secp256k1 private key"],
		["a key of 31 bytes", { key: `0x${"ab".repeat(31)}` }, "the key is not 0x and 64 hex digits"],
	])("a transfer with %s is refused", (_, change, message) => {
		expect(() => signTransfer({ ...golden, ...change } as unknown as sign.Transfer)).toThrow(`cannot sign: ${message}`);
	});

	test.each([
		["an empty window", { validBefore: 0n }, "the validity window is empty"],
		["a window of 186 s", { validAfter: 1795439814n }, "the validity window is longer than 185 s"],
		["a window valid for ever", { validBefore: (1n << 256n) - 1n }, "the validity window is longer than 185 s"],
		["a short nonce", { nonce: "0xab" }, "the nonce is not 32 bytes"],
		["a bigint for a nonce", { nonce: 1n }, "the nonce is not 32 bytes"],
		["a domain with no name", { token: { ...SEPOLIA_USDC, name: "" } }, "the token's domain has no name"],
		["a domain with no version", { token: { ...SEPOLIA_USDC, version: "" } }, "the token's domain has no version"],
		["no token", { token: undefined }, "the token is not an address"],
		["a short recipient", { to: "0x7099" }, "the recipient is not an address"],
		["a negative value", { value: -1n }, "the value is out of range"],
		["a negative start of validity", { validAfter: -1n }, "the start of validity is out of range"],
		["a number for the end of validity", { validBefore: 1 }, "the end of validity is out of range"],
	])("an authorization with %s is refused", (_, change, message) => {
		expect(() =>
			signTransferWithAuthorization({ ...goldenAuthorization, ...change } as sign.TransferAuthorization),
		).toThrow(`cannot sign: ${message}`);
	});
});

const key = fc
	.uint8Array({ minLength: 32, maxLength: 32 })
	.map((bytes) => `0x${Buffer.from(bytes).toString("hex")}` as sign.Key)
	.filter((candidate) => {
		const n = BigInt(candidate);
		return n > 0n && n < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
	});
const address = fc
	.uint8Array({ minLength: 20, maxLength: 20 })
	.map((b) => `0x${Buffer.from(b).toString("hex")}` as Hex);
const uint = (bits: number) => fc.bigInt({ min: 0n, max: (1n << BigInt(bits)) - 1n });
const chainId = fc.integer({ min: 1, max: 2 ** 32 });

const transfer = fc
	.record({
		key,
		chainId,
		nonce: fc.oneof(uint(40), fc.constant(BigInt(Number.MAX_SAFE_INTEGER))),
		tip: fc.bigInt({ min: 0n, max: 5n * 10n ** 12n }),
		extra: fc.bigInt({ min: 1n, max: 5n * 10n ** 12n }),
		gasLimit: fc.bigInt({ min: 21000n, max: 30_000_000n }),
		/** Above any 68-byte calldata's intrinsic gas, 21,000 + 10 * 4 * 68. */
		tokenGas: fc.bigInt({ min: 23720n, max: 30_000_000n }),
		to: address,
		value: uint(256),
		token: fc.option(address, { nil: undefined }),
		added: fc.subarray(Object.keys(EXTRA_FIELDS) as (keyof typeof EXTRA_FIELDS)[]),
	})
	.map(({ extra, tokenGas, added, ...rest }) => ({
		input: {
			...rest,
			maxFee: rest.tip + extra,
			gasLimit: rest.token === undefined ? rest.gasLimit : tokenGas,
		},
		added: Object.fromEntries(added.map((field) => [field, EXTRA_FIELDS[field]])),
	}));

const authorization = fc
	.record({
		key,
		chainId,
		token: fc.record({
			address,
			name: fc.constantFrom("USD Coin", "USDC"),
			version: fc.constantFrom("1", "2"),
		}),
		to: address,
		value: uint(256),
		validAfter: uint(40),
		window: fc.bigInt({ min: 1n, max: 185n }),
		nonce: fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => `0x${Buffer.from(b).toString("hex")}` as Hex),
	})
	.map(({ window, ...rest }) => ({ ...rest, validBefore: rest.validAfter + window }));

describe("properties of what the module signs", () => {
	test(
		"a transfer recovers to the key's address, is deterministic, ignores added fields, and is what viem signs",
		async () => {
			await fc.assert(
				fc.asyncProperty(transfer, async ({ input, added }) => {
					const signed = signTransfer(input);
					expect(signTransfer(input)).toEqual(signed);
					expect(signTransfer({ ...input, ...added } as sign.Transfer)).toEqual(signed);
					expect(signed.hash).toBe(keccak256(signed.raw));
					const serialized = signed.raw as TransactionSerializedEIP1559;
					expect(await recoverTransactionAddress({ serializedTransaction: serialized })).toBe(addressOf(input.key));
					const parsed = parseTransaction(serialized);
					expect(parsed.chainId).toBe(input.chainId);
					expect(parsed.nonce).toBe(Number(input.nonce));
					const viem = await privateKeyToAccount(input.key).signTransaction({
						type: "eip1559",
						chainId: input.chainId,
						nonce: Number(input.nonce),
						maxFeePerGas: input.maxFee,
						maxPriorityFeePerGas: input.tip,
						gas: input.gasLimit,
						to: parsed.to,
						value: parsed.value ?? 0n,
						data: parsed.data,
					});
					expect(signed.raw).toBe(viem);
				}),
				{ numRuns: pbtRuns(60) },
			);
		},
		pbtTimeout(30_000),
	);

	test(
		"an authorization recovers to the key's address, is deterministic, and is what viem signs",
		async () => {
			await fc.assert(
				fc.asyncProperty(authorization, async (input) => {
					const signed = signTransferWithAuthorization(input);
					expect(signTransferWithAuthorization(input)).toEqual(signed);
					expect(signed.from).toBe(addressOf(input.key));
					const typed = {
						types: TYPES,
						primaryType: "TransferWithAuthorization",
						domain: {
							name: input.token.name,
							version: input.token.version,
							chainId: input.chainId,
							verifyingContract: input.token.address,
						},
						message: {
							from: signed.from,
							to: input.to,
							value: input.value,
							validAfter: input.validAfter,
							validBefore: input.validBefore,
							nonce: input.nonce,
						},
					} as const;
					expect(await recoverTypedDataAddress({ ...typed, signature: signed.signature })).toBe(signed.from);
					expect(signed.signature).toBe(await privateKeyToAccount(input.key).signTypedData(typed));
				}),
				{ numRuns: pbtRuns(60) },
			);
		},
		pbtTimeout(30_000),
	);

	test("no refusal of any operation carries a cause or any 16 hex digits of the key", () => {
		const hex = (secret: sign.Key) => secret.slice(2).toLowerCase();
		const WINDOW = 16;
		const transferChanges = [
			{ to: "0x00" },
			{ value: -1n },
			{ value: 1 },
			{ chainId: 0 },
			{ chainId: 1.5 },
			{ nonce: 1n << 64n },
			{ nonce: 0 },
			{ tip: 2n, maxFee: 1n },
			{ maxFee: 0n, tip: 0n },
			{ gasLimit: 20999n },
			{ gasLimit: 30_000_001n },
			{ token: "0xZZ" },
			{ token: SEPOLIA_USDC.address, gasLimit: 21000n },
		];
		const authorizationChanges = [
			{ to: "0x00" },
			{ value: -1n },
			{ chainId: 0 },
			{ validBefore: 0n },
			{ validAfter: 0n },
			{ nonce: "0xab" },
			{ token: undefined },
			{ token: { ...SEPOLIA_USDC, address: "0x00" } },
			{ token: { ...SEPOLIA_USDC, name: "" } },
			{ token: { ...SEPOLIA_USDC, version: "" } },
		];
		const malformed: readonly ((secret: sign.Key) => string)[] = [
			(secret) => hex(secret),
			(secret) => `0X${hex(secret)}`,
			(secret) => `0x${hex(secret)}00`,
			(secret) => `0x0${hex(secret)}`,
			(secret) => ` ${secret}`,
			(secret) => `${secret}\n`,
			(secret) => `0x${hex(secret).slice(0, 63)}g`,
		];
		const refusals: readonly ((secret: sign.Key) => unknown)[] = [
			...transferChanges.map(
				(change) => (secret: sign.Key) => signTransfer({ ...golden, key: secret, ...change } as sign.Transfer),
			),
			...authorizationChanges.map(
				(change) => (secret: sign.Key) =>
					signTransferWithAuthorization({
						...goldenAuthorization,
						key: secret,
						...change,
					} as sign.TransferAuthorization),
			),
			...malformed.flatMap((make) => [
				(secret: sign.Key) => addressOf(make(secret) as sign.Key),
				(secret: sign.Key) => signTransfer({ ...golden, key: make(secret) as sign.Key }),
				(secret: sign.Key) => signTransferWithAuthorization({ ...goldenAuthorization, key: make(secret) as sign.Key }),
			]),
		];
		expect(refusals).toHaveLength(44);
		fc.assert(
			fc.property(key, (secret) => {
				const windows = Array.from({ length: 64 - WINDOW + 1 }, (_, at) => hex(secret).slice(at, at + WINDOW));
				for (const refusal of refusals) {
					const thrown = (() => {
						try {
							refusal(secret);
						} catch (error) {
							return error as Error;
						}
					})();
					expect(thrown).toBeInstanceOf(Error);
					expect(thrown?.message).toMatch(/^cannot sign: /);
					expect(thrown?.cause).toBeUndefined();
					const text = `${thrown?.message} ${thrown?.stack}`.toLowerCase();
					for (const window of windows) expect(text.includes(window)).toBe(false);
				}
			}),
			{ numRuns: pbtRuns(60) },
		);
	});
});
