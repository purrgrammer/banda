/**
 * The JSON-RPC client and the classifier against a real node, anvil (H-185): what it answers for each case the lane
 * meets is classified as the spikes measured, and its blocks, receipts, logs and the GasPriceOracle the runner etches
 * come back typed. Skipped, titled "anvil 1.9.0 not found (mise install)", on a machine without the pinned anvil; CI
 * has it.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Network, networkOf } from "../src/wallet/networks.ts";
import { type Rpc, RpcError, rpcClients } from "../src/wallet/rpc.ts";
import { type Anvil, DEV0, hasAnvil, NO_ANVIL, startAnvil } from "./helpers/anvil.ts";
import { signerOf } from "./helpers/signed.ts";

const GWEI = 1_000_000_000n;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** A key made for this run alone: it holds nothing. */
const EMPTY = generatePrivateKey();

const anvilNetwork = (): Network => {
	const network = networkOf("anvil", { BANDA_TEST_CHAIN: "1" });
	if (network === undefined) throw new Error("no anvil network");
	return network;
};

const sign = (
	key: `0x${string}`,
	fields: { nonce: number; value: bigint; maxFee?: bigint; tip?: bigint; gas?: bigint; data?: `0x${string}` },
) =>
	privateKeyToAccount(key).signTransaction({
		type: "eip1559",
		chainId: 31337,
		nonce: fields.nonce,
		to: TO,
		value: fields.value,
		gas: fields.gas ?? 21_000n,
		maxFeePerGas: fields.maxFee ?? 10n * GWEI,
		maxPriorityFeePerGas: fields.tip ?? GWEI,
		...(fields.data === undefined ? {} : { data: fields.data }),
	});

const failed = (promise: Promise<unknown>) =>
	promise.then(
		() => "accepted",
		(error: unknown) => (error instanceof RpcError && error.kind === "rpc" ? (error.pool ?? "other") : "other"),
	);

const anvilHere = hasAnvil();

if (!anvilHere) it.skip(NO_ANVIL, () => {});

describe.skipIf(!anvilHere)("against anvil", () => {
	let anvil: Anvil;
	let rpc: Rpc;

	beforeAll(async () => {
		anvil = await startAnvil(["--chain-id", "31337", "--no-mining"]);
		rpc = rpcClients().client(anvilNetwork(), { url: anvil.url, headers: {} });
	});
	afterAll(async () => {
		await anvil?.stop();
	});

	const mine = async () => {
		const answer = await anvil.raw("evm_mine");
		if (answer.error !== undefined) throw new Error(answer.error.message);
	};

	it("serves the network's chain, its head and its tags", async () => {
		await rpc.checkChain();
		const head = await rpc.blockNumber();
		const latest = await rpc.getBlock("latest");
		expect(latest?.number).toBe(head);
		expect(latest?.baseFeePerGas).toBeTypeOf("bigint");
		expect((await rpc.getBlock("safe"))?.number).toBeLessThanOrEqual(head);
		expect((await rpc.getBlock("finalized"))?.number).toBeLessThanOrEqual(head);
		expect(await rpc.getBlock(head + 1000n)).toBeNull();
		expect(await rpc.nonce(DEV0.address, "pending")).toBeTypeOf("bigint");
		expect(await rpc.balance(DEV0.address)).toBe(10_000n * 10n ** 18n);
		expect(await rpc.getCode(DEV0.address)).toBe("0x");
	});

	it("classifies each pool answer as the spikes measured, and reads what was mined", async () => {
		const nonce = Number(await rpc.nonce(DEV0.address, "latest"));
		const a = await sign(DEV0.key, { nonce, value: 1n });
		const hash = await rpc.sendRaw(a);
		expect(await rpc.nonce(DEV0.address, "pending")).toBe(BigInt(nonce + 1));
		expect(await rpc.receipt(hash)).toBeNull();
		expect((await rpc.getTransaction(hash))?.blockNumber).toBeNull();

		expect(await failed(rpc.sendRaw(a))).toBe("known");
		expect(await failed(rpc.sendRaw(await sign(DEV0.key, { nonce, value: 2n, tip: GWEI + 1n })))).toBe("underpriced");
		expect(await failed(rpc.sendRaw(await sign(EMPTY, { nonce: 0, value: 1n })))).toBe("funds");
		expect(await failed(rpc.sendRaw(await sign(DEV0.key, { nonce: nonce + 1, value: 1n, maxFee: 1n, tip: 1n })))).toBe(
			"fee_low",
		);

		await mine();
		const receipt = await rpc.receipt(hash);
		expect(receipt?.status).toBe(1n);
		expect(receipt?.gasUsed).toBe(21_000n);
		expect(receipt?.from.toLowerCase()).toBe(DEV0.address.toLowerCase());
		const mined = await rpc.getTransaction(hash);
		expect(mined?.blockNumber).toBe(receipt?.blockNumber);
		expect(mined?.nonce).toBe(BigInt(nonce));
		expect(await rpc.nonce(DEV0.address, mined?.blockNumber ?? 0n)).toBe(BigInt(nonce + 1));
		expect(await rpc.nonce(DEV0.address, (mined?.blockNumber ?? 1n) - 1n)).toBe(BigInt(nonce));
		expect(mined?.value).toBe(1n);

		expect(await failed(rpc.sendRaw(a))).toBe("nonce_low");
		expect(await failed(rpc.sendRaw(await sign(DEV0.key, { nonce, value: 3n, maxFee: 100n * GWEI })))).toBe(
			"nonce_low",
		);
	});

	it("reads a mined transaction whole enough to recover its signer, whatever its type (C7)", async () => {
		const account = privateKeyToAccount(DEV0.key);
		const nonce = Number(await rpc.nonce(DEV0.address, "pending"));
		const common = { chainId: 31337, to: TO, value: 1n, gas: 30_000n } as const;
		const raws = [
			await sign(DEV0.key, { nonce, value: 1n }),
			await account.signTransaction({ ...common, type: "legacy", nonce: nonce + 1, gasPrice: 10n * GWEI }),
			await account.signTransaction({
				...common,
				type: "eip2930",
				nonce: nonce + 2,
				gasPrice: 10n * GWEI,
				accessList: [{ address: TO, storageKeys: [`0x${"00".repeat(32)}`] }],
			}),
		];
		const hashes = [];
		for (const raw of raws) hashes.push(await rpc.sendRaw(raw));
		await mine();
		const types = [];
		for (const hash of hashes) {
			const tx = await rpc.getTransaction(hash);
			if (tx === null) throw new Error(`no transaction ${hash}`);
			expect(tx.blockNumber).not.toBeNull();
			types.push(tx.type);
			expect(await signerOf(tx)).toBe(DEV0.address);
		}
		expect(types).toEqual([2n, 0n, 1n]);
	});

	it("reads logs in chunks across blocks", async () => {
		const topic = `0x${"11".repeat(32)}`;
		// init code that emits LOG1(topic) and deploys nothing
		const emit = `0x7f${"11".repeat(32)}60006000a100` as const;
		const from = (await rpc.blockNumber()) + 1n;
		const hashes: string[] = [];
		for (let i = 0; i < 5; i++) {
			const sent = await anvil.raw("eth_sendTransaction", [{ from: DEV0.address, data: emit, gas: "0x186a0" }]);
			hashes.push(String(sent.result));
			await mine();
		}
		const to = await rpc.blockNumber();
		const got = await rpc.getLogs({ topics: [topic] }, { from, to, span: 2n });
		expect(got.span).toBe(2n);
		expect(got.logs.map((log) => log.transactionHash)).toEqual(hashes);
		expect(got.logs.map((log) => log.blockNumber)).toEqual([from, from + 1n, from + 2n, from + 3n, from + 4n]);
		expect(got.logs.every((log) => log.topics[0] === topic && !log.removed)).toBe(true);
		const receipt = await rpc.receipt(hashes[0] ?? "");
		expect(receipt?.to).toBeNull();
		expect(receipt?.logs).toHaveLength(1);
	});

	it("reads the L1 fee bound from the GasPriceOracle the runner etches", async () => {
		// runtime code that answers 195 to any call
		const stub = `0x7f${195n.toString(16).padStart(64, "0")}60005260206000f3`;
		const set = await anvil.raw("anvil_setCode", [anvilNetwork().gasPriceOracle, stub]);
		expect(set.error).toBeUndefined();
		expect(await rpc.estimateL1Fee(110n)).toBe(195n);
	});

	it("estimates gas and calls at a tag", async () => {
		expect(await rpc.estimateGas({ from: DEV0.address, to: TO, value: 1n })).toBe(21_000n);
		expect(await rpc.call({ to: TO, data: "0x" }, "latest")).toBe("0x");
	});
});
