/**
 * The JSON-RPC client and the pool error classifier (docs/wallets/stack.md; H-183, H-184, H-185, H-187, H-195, H-198)
 * over a faux `fetch`: quantities come back as bigint, a node's message is kept as written, one RPC's requests share
 * one bucket whichever wallet asks, a rate limit holds every caller, signed bytes go out once, a too-wide log range is
 * narrowed, an answer is read to a fixed size, and nothing thrown names the RPC's key, even when the node echoes it.
 */
import fc from "fast-check";
import { keccak256, parseTransaction, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../src/home.ts";
import { type WalletRpc, walletRpc } from "../src/wallet/config.ts";
import { type Network, networkOf } from "../src/wallet/networks.ts";
import { classifyMessage } from "../src/wallet/pool.ts";
import { RpcError, rpcClients } from "../src/wallet/rpc.ts";
import { DEV0 } from "./helpers/anvil.ts";
import { signerOf } from "./helpers/signed.ts";
import { pbtRuns } from "./pbt.ts";

const network = (id: string): Network => {
	const found = networkOf(id, { BANDA_TEST_CHAIN: "1" });
	if (found === undefined) throw new Error(`no network ${id}`);
	return found;
};
/** What a refused send means for the pool: the node's answer read, or other for anything that may have been sent. */
const poolOf = (error: unknown) =>
	error instanceof RpcError && error.kind === "rpc" ? (error.pool ?? "other") : "other";

const BASE = network("base");
const SEPOLIA = network("base-sepolia");
/** A second network on Base's chain: another client of the same RPC, which serves one chain (H-187), for H-198. */
const TWIN: Network = { ...network("anvil"), chainId: BASE.chainId };

const KEY = "k3yS3cr3tN0tF0rLogs";
const RPC: WalletRpc = { url: `https://rpc.example/v2/${KEY}`, headers: { authorization: `Basic ${KEY}` } };

type Call = { method: string; params: unknown[]; init: RequestInit };
type Answer = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;

/**
 * A faux `fetch` answering each JSON-RPC method by `answer`, and recording every call. `eth_chainId`, which a client
 * asks once before its first read (H-187), is answered apart, with `served.chain` (Base's unless a test sets another),
 * and kept in `checks`, not `calls`; `served.chain` undefined hands it to `answer` like any other call.
 */
function faux(answer: (call: Call, n: number) => Answer) {
	const calls: Call[] = [];
	const checks: Call[] = [];
	const served: { chain?: number } = { chain: BASE.chainId };
	const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => {
		const request = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
		const call = { method: request.method, params: request.params, init };
		if (request.method === "eth_chainId" && served.chain !== undefined) {
			checks.push(call);
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `0x${served.chain.toString(16)}` }));
		}
		calls.push(call);
		const got = answer(call, calls.length);
		if (got instanceof Error) throw got;
		const text = got.text ?? JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(got.body as object) });
		return new Response(text, { status: got.status ?? 200, headers: got.headers ?? {} });
	}) as typeof fetch;
	return { fetcher, calls, checks, served };
}

/** The `n`th call, which the test expects to have been made. */
function nth(calls: readonly Call[], n: number): Call {
	const call = calls[n];
	if (call === undefined) throw new Error(`no call ${n}`);
	return call;
}

/** A clock that `sleep` moves on at once. */
function clock() {
	let t = 1_000_000;
	const sleep = async (ms: number) => {
		t += ms;
	};
	return { now: () => t, sleep, elapsed: (from: number) => t - from };
}

const result = (value: unknown) => ({ body: { result: value } });
const failure = (code: number, message: string, status = 200) => ({ status, body: { error: { code, message } } });

const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;
const ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("quantities and shapes", () => {
	it("reads quantities as bigint, past 2^53", async () => {
		const { fetcher } = faux(({ method }) =>
			method === "eth_getBalance" ? result("0x1fffffffffffffffffff") : result("0x2105"),
		);
		const rpc = rpcClients({ fetch: fetcher }).client(BASE, RPC);
		expect(await rpc.balance(ADDR)).toBe(0x1fffffffffffffffffffn);
		expect(await rpc.chainId()).toBe(8453n);
		await rpc.checkChain();
	});

	it("sends the URL's userinfo header, a JSON-RPC body, and never follows a redirect (H-196)", async () => {
		const { fetcher, calls } = faux(() => result("0x5"));
		const rpc = rpcClients({ fetch: fetcher }).client(BASE, RPC);
		expect(await rpc.nonce(ADDR, "pending")).toBe(5n);
		expect(calls[0]?.method).toBe("eth_getTransactionCount");
		expect(calls[0]?.params).toEqual([ADDR, "pending"]);
		expect(calls[0]?.init.redirect).toBe("manual");
		expect((nth(calls, 0).init.headers as Record<string, string>).authorization).toBe(`Basic ${KEY}`);
		expect(await rpc.nonce(ADDR, 16n)).toBe(5n);
		expect(nth(calls, 1).params).toEqual([ADDR, "0x10"]);

		const moved = faux(() => ({ status: 302, text: "", headers: { location: "https://elsewhere.example/" } }));
		const error = (await rpcClients({ fetch: moved.fetcher, ...clock() })
			.client(BASE, RPC)
			.blockNumber()
			.catch((e: unknown) => e)) as RpcError;
		expect(error).toMatchObject({ kind: "http", status: 302 });
		expect(error.detail).toBe("the RPC answered a redirect, which banda does not follow");
		expect(moved.calls).toHaveLength(1);
	});

	it("reads blocks, receipts, transactions and logs", async () => {
		const log = {
			address: ADDR,
			topics: [HASH],
			data: "0x",
			blockNumber: "0x10",
			blockHash: HASH2,
			transactionHash: HASH,
			logIndex: "0x0",
			removed: false,
		};
		const { fetcher, calls } = faux(({ method, params }) => {
			if (method === "eth_getBlockByNumber")
				return params[0] === "finalized"
					? result(null)
					: result({ number: "0x10", hash: HASH, parentHash: HASH2, timestamp: "0x64", baseFeePerGas: "0x3b9aca00" });
			if (method === "eth_getTransactionReceipt")
				return result({
					transactionHash: HASH,
					blockNumber: "0x10",
					blockHash: HASH2,
					from: ADDR,
					to: null,
					status: "0x1",
					gasUsed: "0x5208",
					effectiveGasPrice: "0x1",
					l1Fee: "0xc3",
					logs: [log],
				});
			if (method === "eth_getTransactionByHash" && params[0] === HASH)
				return result({
					hash: HASH,
					from: ADDR,
					to: ADDR,
					nonce: "0x0",
					value: "0x1",
					input: "0x",
					gas: "0x5208",
					maxFeePerGas: "0x2",
					maxPriorityFeePerGas: "0x1",
					blockNumber: null,
					blockHash: null,
				});
			return result(null);
		});
		const rpc = rpcClients({ fetch: fetcher }).client(BASE, RPC);
		expect(await rpc.getBlock("safe")).toEqual({
			number: 16n,
			hash: HASH,
			parentHash: HASH2,
			timestamp: 100n,
			baseFeePerGas: 1_000_000_000n,
		});
		expect(calls.at(-1)?.params).toEqual(["safe", false]);
		expect(await rpc.getBlock("finalized")).toBeNull();
		await rpc.getBlock(16n);
		expect(calls.at(-1)?.params).toEqual(["0x10", false]);
		const receipt = await rpc.receipt(HASH);
		expect(receipt?.status).toBe(1n);
		expect(receipt?.l1Fee).toBe(195n);
		expect(receipt?.logs[0]?.blockNumber).toBe(16n);
		const tx = await rpc.getTransaction(HASH);
		expect(tx?.blockNumber).toBeNull();
		expect(tx?.maxFeePerGas).toBe(2n);
		expect(await rpc.getTransaction(HASH2)).toBeNull();
	});

	it("keeps what a transaction signed, so its signer is recovered and a forged `from` is caught (C7)", async () => {
		const forged = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
		const serialized = await privateKeyToAccount(DEV0.key).signTransaction({
			type: "eip1559",
			chainId: 8453,
			nonce: 7,
			to: forged,
			value: 5n,
			gas: 21_000n,
			maxFeePerGas: 3n,
			maxPriorityFeePerGas: 2n,
			accessList: [{ address: forged, storageKeys: [HASH as `0x${string}`] }],
		});
		const parsed = parseTransaction(serialized);
		const answer = {
			hash: keccak256(serialized),
			type: "0x2",
			chainId: "0x2105",
			from: forged,
			to: forged,
			nonce: "0x7",
			value: "0x5",
			input: "0x",
			gas: "0x5208",
			gasPrice: "0x3",
			maxFeePerGas: "0x3",
			maxPriorityFeePerGas: "0x2",
			accessList: [{ address: forged, storageKeys: [HASH] }],
			v: `0x${(parsed.yParity ?? 0).toString(16)}`,
			yParity: `0x${(parsed.yParity ?? 0).toString(16)}`,
			r: parsed.r,
			s: parsed.s,
			blockNumber: "0x10",
			blockHash: HASH2,
		};
		const rpcOf = (body: object) => rpcClients({ fetch: faux(() => result(body)).fetcher }).client(BASE, RPC);
		const tx = await rpcOf(answer).getTransaction(answer.hash);
		if (tx === null) throw new Error("no transaction");
		expect(tx).toMatchObject({ type: 2n, chainId: 8453n, nonce: 7n, from: forged });
		expect(tx.accessList).toEqual([{ address: forged, storageKeys: [HASH] }]);
		expect(await signerOf(tx)).toBe(DEV0.address);
		expect((await signerOf(tx)).toLowerCase()).not.toBe(tx.from.toLowerCase());

		const altered = await rpcOf({ ...answer, value: "0x6" }).getTransaction(answer.hash);
		if (altered === null) throw new Error("no transaction");
		await expect(signerOf(altered)).rejects.toThrow("not the transaction's");
		const unsigned = await rpcOf({
			...answer,
			r: undefined,
			s: undefined,
			v: undefined,
			yParity: undefined,
		}).getTransaction(answer.hash);
		expect(unsigned).not.toHaveProperty("r");
		if (unsigned === null) throw new Error("no transaction");
		await expect(signerOf(unsigned)).rejects.toThrow("no signature");
	});

	it("refuses an answer that is not what the method returns", async () => {
		const answers: Answer[] = [
			result("12"),
			result(12),
			result("0xzz"),
			{ text: "<html>gateway</html>" },
			{ body: { jsonrpc: "2.0" } },
		];
		for (const answer of answers) {
			const rpc = rpcClients({ fetch: faux(() => answer).fetcher }).client(BASE, RPC);
			const error = await rpc.blockNumber().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(RpcError);
			expect((error as RpcError).kind).toBe("shape");
		}
		const rpc = rpcClients({ fetch: faux(() => result({ number: "0x1" })).fetcher }).client(BASE, RPC);
		await expect(rpc.getBlock("latest")).rejects.toMatchObject({ kind: "shape" });
	});

	it("reads a safe or finalized block the chain has not set as none, and never a pending block", async () => {
		const { fetcher } = faux(({ params }) => failure(-32000, `${String(params[0])} block not found`));
		const rpc = rpcClients({ fetch: fetcher }).client(BASE, RPC);
		expect(await rpc.getBlock("safe")).toBeNull();
		expect(await rpc.getBlock("finalized")).toBeNull();
		await expect(rpc.getBlock("latest")).rejects.toMatchObject({ kind: "rpc" });
		// @ts-expect-error: geth answers a pending block with no hash
		await expect(rpc.getBlock("pending")).rejects.toThrow(RangeError);
	});

	it("reads an answer to a fixed size, larger for logs", async () => {
		const big = { body: { result: `0x${"0".repeat(2_000)}` } };
		const options = { fetch: faux(() => big).fetcher, maxReplyBytes: 1_000, maxLogsBytes: 1_000_000 };
		const rpc = rpcClients(options).client(BASE, RPC);
		await expect(rpc.getCode(ADDR)).rejects.toMatchObject({ kind: "shape" });
		const logs = rpcClients({
			...options,
			fetch: faux(() => ({ body: { result: [] }, text: `{"result":[]${" ".repeat(5_000)}}` })).fetcher,
		});
		expect((await logs.client(BASE, RPC).getLogs({}, { from: 0n, to: 0n, span: 1n })).logs).toEqual([]);
	});

	it("takes the RPC for another chain offline (H-187)", async () => {
		const sepolia = faux(() => result("0x1"));
		sepolia.served.chain = SEPOLIA.chainId;
		const rpc = rpcClients({ fetch: sepolia.fetcher }).client(BASE, RPC);
		await expect(rpc.checkChain()).rejects.toMatchObject({ kind: "chain" });
		// no read reaches an RPC that serves another chain, and the check is asked again next time
		await expect(rpc.blockNumber()).rejects.toMatchObject({ kind: "chain" });
		expect(sepolia.calls).toEqual([]);
		expect(sepolia.checks).toHaveLength(2);
		await rpcClients({ fetch: sepolia.fetcher }).client(SEPOLIA, RPC).checkChain();
	});
});

describe("errors", () => {
	it("keeps the node's message and code as written", async () => {
		const message = "nonce too low: next nonce 1, tx nonce 0";
		const rpc = rpcClients({ fetch: faux(() => failure(-32000, message)).fetcher }).client(BASE, RPC);
		const error = (await rpc.sendRaw("0x02f8").catch((e: unknown) => e)) as RpcError;
		expect(error.kind).toBe("rpc");
		expect(error.detail).toBe(message);
		expect(error.code).toBe(-32000);
		expect(error.pool).toBe("nonce_low");
	});

	it("reads a node's word that it keeps no state there, and only that, as pruned (H-204, H-215)", async () => {
		const cases: [string, true | undefined][] = [
			[`missing trie node ${"ab".repeat(32)} (path )`, true],
			[`historical state 0x${"cd".repeat(32)} is not available`, true],
			["state at block #49187730 is pruned", true],
			["header not found", undefined],
			["request timed out", undefined],
			["execution reverted", undefined],
			["finalized block not found", undefined],
		];
		for (const [message, pruned] of cases) {
			const rpc = rpcClients({ fetch: faux(() => failure(-32000, message)).fetcher, ...clock(), retries: 0 }).client(
				BASE,
				RPC,
			);
			const error = (await rpc.balance(ADDR, 10n).catch((e: unknown) => e)) as RpcError;
			expect(error).toBeInstanceOf(RpcError);
			expect([message, error.pruned]).toEqual([message, pruned]);
		}
	});

	it("reads a JSON-RPC error carried by an HTTP error status", async () => {
		const rpc = rpcClients({
			fetch: faux(() => failure(-32614, "eth_getLogs is limited to a 200 range", 413)).fetcher,
		}).client(BASE, RPC);
		await expect(rpc.blockNumber()).rejects.toMatchObject({ kind: "rpc", status: 413, code: -32614 });
	});

	it("never names the RPC's key, whatever fails and whatever the node echoes (H-195)", async () => {
		const timeout = Object.assign(new Error(`The operation was aborted: ${RPC.url}`), { name: "TimeoutError" });
		const answers: Answer[] = [
			new TypeError(`fetch failed ${RPC.url}`),
			timeout,
			{ status: 502, text: `bad gateway ${RPC.url}` },
			{ status: 401, text: `invalid api key ${KEY}` },
			{ status: 429, text: "slow down" },
			{ text: RPC.url },
			failure(-32000, "execution reverted"),
			failure(-32000, `invalid api key ${KEY}`),
			failure(-32000, `no route for ${RPC.url}`),
			failure(-32001, `unauthorized: Basic ${KEY}`, 401),
			failure(-32005, `rate limit exceeded for /v2/${KEY}`, 429),
		];
		const time = clock();
		for (const answer of answers) {
			const rpc = rpcClients({ fetch: faux(() => answer).fetcher, ...time, retries: 0 }).client(BASE, RPC);
			const error = (await rpc.blockNumber().catch((e: unknown) => e)) as RpcError;
			expect(error).toBeInstanceOf(RpcError);
			expect(`${error.message} ${error.detail} ${error.stack}`).not.toContain(KEY);
			// its credential, moved into the header, is said to be there, as the URL the owner set has it (H-195)
			expect(error.message).toContain("https://•••@rpc.example/•••");
			expect(error.cause).toBeUndefined();
		}
	});

	it("scrubs a short key in the path or the query that the node echoes alone (H-195)", async () => {
		const cases = [
			{ url: "https://rpc.example/v1/abcdefghij", key: "abcdefghij" },
			{ url: "https://rpc.example/?key=abcdefg", key: "abcdefg" },
			{ url: "https://rpc.example/base-mainnet/abc", key: "abc" },
		];
		for (const { url, key } of cases) {
			const error = (await rpcClients({ fetch: faux(() => failure(-32001, `bad key ${key}`, 401)).fetcher })
				.client(BASE, { url, headers: {} })
				.sendRaw("0x02")
				.catch((e: unknown) => e)) as RpcError;
			expect(error.detail).toBe("bad key •••");
			expect(error.message).not.toContain(key);
		}
		const words = (await rpcClients({
			fetch: faux(() => failure(-32000, "base fee too low on mainnet v1 (Bearer)")).fetcher,
		})
			.client(BASE, { url: "https://rpc.example/v1/base-mainnet?network=base", headers: { authorization: "Bearer k" } })
			.sendRaw("0x02")
			.catch((e: unknown) => e)) as RpcError;
		expect(words.detail).toBe("base fee too low on mainnet v1 (Bearer)");
	});

	it("scrubs the query, the password and a Basic payload from a node's message, and keeps a plain user", async () => {
		const user = "aliceTheOwner";
		const password = "pa55wordHidden";
		const token = "t0kenInTheQuery";
		const basic = Buffer.from(`${user}:${password}`).toString("base64");
		const rpc: WalletRpc = {
			url: `https://${user}:${password}@rpc.example/?apikey=${token}`,
			headers: { authorization: `Basic ${basic}`, "x-api-key": "headerKeyValue" },
		};
		const echo = `bad key ${token} for ${user} (${password}) via ${basic} and headerKeyValue; nonce too low`;
		const error = (await rpcClients({ fetch: faux(() => failure(-32000, echo)).fetcher })
			.client(BASE, rpc)
			.sendRaw("0x02")
			.catch((e: unknown) => e)) as RpcError;
		for (const secret of [password, token, basic, "headerKeyValue"]) {
			expect(error.message).not.toContain(secret);
			expect(error.detail).not.toContain(secret);
		}
		expect(error.detail).toBe(`bad key ••• for ${user} (•••) via ••• and •••; nonce too low`);
		expect(error.pool).toBe("nonce_low");
	});

	it("scrubs a short Basic payload the node echoes alone, and a user that is a key", async () => {
		const basic = Buffer.from("user:pass").toString("base64");
		const short = (await rpcClients({ fetch: faux(() => failure(-32001, `bad credentials ${basic}`, 401)).fetcher })
			.client(BASE, { url: "https://rpc.example/", headers: { authorization: `Basic ${basic}` } })
			.sendRaw("0x02")
			.catch((e: unknown) => e)) as RpcError;
		expect(basic).toBe("dXNlcjpwYXNz");
		expect(short.detail).toBe("bad credentials •••");
		expect(short.message).not.toContain(basic);

		const key = "9f86d081884c7d659a2feaa0c55ad015";
		const keyed = Buffer.from(`${key}:`).toString("base64");
		const asUser = (await rpcClients({ fetch: faux(() => failure(-32001, `no project ${key}`, 401)).fetcher })
			.client(BASE, { url: `https://${key}@rpc.example/`, headers: { authorization: `Basic ${keyed}` } })
			.sendRaw("0x02")
			.catch((e: unknown) => e)) as RpcError;
		expect(asUser.detail).toBe("no project •••");
	});

	it("scrubs a password in any script walletRpc puts in the header, and a Basic payload sent unpadded", async () => {
		const rpcOf = (url: string) => walletRpc({ model: DEFAULT_MODEL, wallets: { rpc: { base: url } } }, BASE);
		const cases = [
			{ url: "https://user:s3cr%C3%A9tpassword@rpc.example/", password: "s3crétpassword" },
			{ url: "https://u:p%C3%A4@rpc.example/", password: "pä" },
			{ url: "https://u:%01ctrl@rpc.example/", password: "\u0001ctrl" },
		];
		for (const { url, password } of cases) {
			const rpc = rpcOf(url);
			const error = (await rpcClients({ fetch: faux(() => failure(-32001, `bad pw ${password}`, 401)).fetcher })
				.client(BASE, rpc)
				.sendRaw("0x02")
				.catch((e: unknown) => e)) as RpcError;
			expect(error.detail).toBe("bad pw •••");
			expect(error.message).not.toContain(password);
		}

		const padded = Buffer.from("ab:cdef").toString("base64");
		expect(padded).toBe("YWI6Y2RlZg==");
		const unpadded = (await rpcClients({
			fetch: faux(() => failure(-32001, "bad credentials YWI6Y2RlZg", 401)).fetcher,
		})
			.client(BASE, { url: "https://rpc.example/", headers: { authorization: `Basic ${padded}` } })
			.sendRaw("0x02")
			.catch((e: unknown) => e)) as RpcError;
		expect(unpadded.detail).toBe("bad credentials •••");
	});

	it("leaves a node's words when a Basic user is one letter", async () => {
		const password = "s3cretKeyValue99";
		const basic = Buffer.from(`x:${password}`).toString("base64");
		const message = "nonce too low at 0xabc max fee";
		const error = (await rpcClients({ fetch: faux(() => failure(-32000, `${message} (${password})`)).fetcher })
			.client(BASE, { url: `https://x:${password}@rpc.example/`, headers: { authorization: `Basic ${basic}` } })
			.sendRaw("0x02")
			.catch((e: unknown) => e)) as RpcError;
		expect(error.detail).toBe(`${message} (•••)`);
		expect(error.pool).toBe("nonce_low");
	});

	it("reads a node's message before scrubbing it, so a key's URL words never change what it means", async () => {
		const key = "9f86d081884c7d659a2feaa0c55ad015";
		const urls = [
			`https://rpc.ankr.com/base/${key}`,
			`https://lb.drpc.org/ogrpc?network=base&dkey=${key}`,
			`https://rpc.example/nonce/${key}`,
			`https://rpc.example/funds/${key}`,
			`https://rpc.example/known/already/imported/${key}`,
		];
		const messages = [
			"max fee per gas less than block base fee",
			"nonce too low: next nonce 1, tx nonce 0",
			"insufficient funds for gas * price + value: balance 0",
			"transaction already imported",
			"replacement transaction underpriced",
		];
		for (const url of urls)
			for (const message of messages) {
				const error = (await rpcClients({ fetch: faux(() => failure(-32003, message)).fetcher })
					.client(BASE, { url, headers: {} })
					.sendRaw("0x02")
					.catch((e: unknown) => e)) as RpcError;
				expect(error.detail).not.toContain(key);
				expect(poolOf(error)).toBe(classifyMessage(message));
			}

		const safe = rpcClients({ fetch: faux(() => failure(-39001, "safe block not found")).fetcher }).client(BASE, {
			url: `https://rpc.example/safe/block/found/${key}`,
			headers: {},
		});
		expect(await safe.getBlock("safe")).toBeNull();

		const { fetcher, calls } = faux(({ params }) => {
			const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
			return BigInt(toBlock) - BigInt(fromBlock) + 1n > 100n
				? failure(-32600, "exceed maximum block range: 100")
				: result([]);
		});
		const got = await rpcClients({ fetch: fetcher })
			.client(BASE, { url: `https://rpc.example/block/range/maximum/${key}`, headers: {} })
			.getLogs({}, { from: 0n, to: 199n, span: 1000n });
		expect(got.span).toBe(100n);
		expect(calls).toHaveLength(3);
	});

	it("scrubs the key from a node's message and leaves the URL's words", async () => {
		const key = "9f86d081884c7d659a2feaa0c55ad015";
		const message = "network busy: max fee per gas less than block base fee";
		for (const url of [`https://rpc.ankr.com/base/${key}`, `https://lb.drpc.org/ogrpc?network=base&dkey=${key}`]) {
			const echo = `${message} (${url})`;
			const error = (await rpcClients({ fetch: faux(() => failure(-32003, echo)).fetcher })
				.client(BASE, { url, headers: {} })
				.sendRaw("0x02")
				.catch((e: unknown) => e)) as RpcError;
			expect(error.detail).not.toContain(key);
			expect(error.detail.startsWith(`${message} (`)).toBe(true);
			expect(poolOf(error)).toBe("fee_low");
		}
	});

	it("tells a timeout, a lost connection and an HTTP error apart", async () => {
		const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
		const kinds: [Answer, string][] = [
			[timeout, "timeout"],
			[new TypeError("fetch failed"), "transport"],
			[{ status: 503, text: "" }, "http"],
		];
		for (const [answer, kind] of kinds) {
			const rpc = rpcClients({ fetch: faux(() => answer).fetcher, ...clock(), retries: 0 }).client(BASE, RPC);
			const error = await rpc.sendRaw("0x02").catch((e: unknown) => e);
			expect(error).toMatchObject({ kind });
			expect(poolOf(error)).toBe("other");
		}
	});
});

describe("the bucket and backoff", () => {
	it("one RPC's requests share one bucket, whichever network's client asks (H-198)", async () => {
		const time = clock();
		const { fetcher, calls } = faux(() => result("0x1"));
		const clients = rpcClients({ fetch: fetcher, rate: 5, burst: 10, ...time });
		const a = clients.client(BASE, RPC);
		const b = clients.client(TWIN, RPC);
		expect(clients.client(BASE, RPC)).toBe(a);
		const start = time.now();
		await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? a : b).blockNumber()));
		expect(calls).toHaveLength(30);
		// ten at once, then the other twenty at five a second
		expect(time.elapsed(start)).toBeGreaterThanOrEqual(4_000);
		expect(time.elapsed(start)).toBeLessThan(4_500);

		const other = clients.client(BASE, { url: "https://other.example/", headers: {} });
		const before = time.now();
		// its own bucket's ten: the chain check and nine reads
		await Promise.all(Array.from({ length: 9 }, () => other.blockNumber()));
		expect(time.elapsed(before)).toBe(0);
	});

	it("a rate limit is waited out until the time it names, then the read is asked again", async () => {
		const time = clock();
		let limited = true;
		const { fetcher, calls } = faux(() => {
			if (!limited) return result("0x7");
			limited = false;
			return { status: 429, text: "", headers: { "retry-after": "3" } };
		});
		const clients = rpcClients({ fetch: fetcher, ...time, random: () => 0 });
		const start = time.now();
		expect(await clients.client(BASE, RPC).blockNumber()).toBe(7n);
		expect(calls).toHaveLength(2);
		expect(time.elapsed(start)).toBeGreaterThanOrEqual(3_000);
	});

	it("a rate limit holds every other client on that RPC until the time it names (H-183)", async () => {
		const time = clock();
		const sent: { url: string; at: number }[] = [];
		let first = true;
		const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
			sent.push({ url: String(url), at: time.now() });
			const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string };
			if (method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x2105" }));
			if (first) {
				first = false;
				return new Response("", { status: 429, headers: { "retry-after": "3" } });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
		}) as typeof fetch;
		const clients = rpcClients({ fetch: fetcher, ...time, retries: 0 });
		const other: WalletRpc = { url: "https://other.example/", headers: {} };
		const start = time.now();
		const error = (await clients
			.client(BASE, RPC)
			.blockNumber()
			.catch((e: unknown) => e)) as RpcError;
		expect(error).toMatchObject({ kind: "limited", retryAt: start + 3_000 });
		await clients.client(BASE, other).blockNumber();
		expect(sent.at(-1)).toEqual({ url: other.url, at: start });
		await clients.client(TWIN, RPC).blockNumber();
		const held = sent.at(-1);
		expect(held?.url).toBe(RPC.url);
		expect(held?.at).toBeGreaterThanOrEqual(start + 3_000);
	});

	it("reads a Retry-After given as an HTTP-date, and a 503 that carries one as a limit", async () => {
		for (const status of [429, 503]) {
			const time = clock();
			const at = new Date(time.now() + 5_000).toUTCString();
			let limited = true;
			const { fetcher, calls } = faux(() => {
				if (!limited) return result("0x7");
				limited = false;
				return { status, text: "", headers: { "retry-after": at } };
			});
			const start = time.now();
			const rpc = rpcClients({ fetch: fetcher, ...time, random: () => 0 }).client(BASE, RPC);
			expect(await rpc.blockNumber()).toBe(7n);
			expect(calls).toHaveLength(2);
			expect(time.elapsed(start)).toBeGreaterThanOrEqual(5_000);
		}
		const time = clock();
		const rpc = rpcClients({
			fetch: faux(() => ({ status: 503, text: "", headers: { "retry-after": "2" } })).fetcher,
			...time,
			retries: 0,
		}).client(BASE, RPC);
		await expect(rpc.blockNumber()).rejects.toMatchObject({
			kind: "limited",
			status: 503,
			retryAt: time.now() + 2_000,
		});
	});

	it("holds the RPC past the backoff for as long as it names, and hands that time back at once", async () => {
		const time = clock();
		const { fetcher, calls } = faux(() => ({ status: 429, text: "", headers: { "retry-after": "86400" } }));
		const clients = rpcClients({ fetch: fetcher, ...time });
		const start = time.now();
		const error = (await clients
			.client(BASE, RPC)
			.blockNumber()
			.catch((e: unknown) => e)) as RpcError;
		// a day is cut to an hour (MAX_RETRY_AFTER_MS), and the read is not slept through
		expect(error).toMatchObject({ kind: "limited", retryAt: start + 60 * 60_000 });
		expect(time.elapsed(start)).toBe(0);
		const next = (await clients
			.client(TWIN, RPC)
			.blockNumber()
			.catch((e: unknown) => e)) as RpcError;
		expect(next).toMatchObject({ kind: "limited", retryAt: start + 60 * 60_000 });
		expect(calls).toHaveLength(1);
	});

	it("hands a long hold back at once to a read already waiting in the bucket, without sleeping it out", async () => {
		let t = 1_000_000;
		const start = t;
		const sleeps: number[] = [];
		let first: Promise<unknown> = Promise.resolve();
		const sleep = async (ms: number) => {
			sleeps.push(ms);
			if (ms > 60_000) throw new Error("slept out the hold");
			await first;
			t += ms;
		};
		const { fetcher, calls } = faux(() => ({ status: 429, text: "", headers: { "retry-after": "3600" } }));
		const rpc = rpcClients({ fetch: fetcher, rate: 1, burst: 2, now: () => t, sleep }).client(BASE, RPC);
		first = rpc.blockNumber().catch((e: unknown) => e);
		const second = rpc.blockNumber().catch((e: unknown) => e);
		expect(await first).toMatchObject({ kind: "limited", retryAt: start + 3_600_000 });
		expect(await second).toMatchObject({ kind: "limited", retryAt: start + 3_600_000 });
		expect(sleeps).toEqual([1000]);
		expect(calls).toHaveLength(1);
	});

	it("a rate limit that names no time closes the RPC for a wait that grows each time, for every caller", async () => {
		const time = clock();
		const { fetcher } = faux(() => failure(-32011, "request limit reached"));
		const clients = rpcClients({ fetch: fetcher, ...time, retries: 0, backoffMs: 100 });
		const holds: number[] = [];
		// each client checks its chain once (H-187), before the limits start
		for (const network of [BASE, TWIN]) await clients.client(network, RPC).checkChain();
		for (const network of [BASE, TWIN, BASE, TWIN]) {
			const error = (await clients
				.client(network, RPC)
				.blockNumber()
				.catch((e: unknown) => e)) as RpcError;
			holds.push((error.retryAt ?? 0) - time.now());
		}
		expect(holds).toEqual([100, 200, 400, 800]);
	});

	it("asks a read again after a 5xx, and takes the answer that follows", async () => {
		const time = clock();
		const { fetcher, calls } = faux((_call, n) => (n === 1 ? { status: 502, text: "bad gateway" } : result("0x9")));
		expect(
			await rpcClients({ fetch: fetcher, ...time })
				.client(BASE, RPC)
				.blockNumber(),
		).toBe(9n);
		expect(calls).toHaveLength(2);
	});

	it("times a request out through its signal when the RPC never answers", async () => {
		let aborted = false;
		const fetcher = ((_url: string | URL | Request, init: RequestInit = {}) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(init.signal?.reason);
				});
			})) as typeof fetch;
		const rpc = rpcClients({ fetch: fetcher, timeoutMs: 50, retries: 0 }).client(BASE, RPC);
		const error = (await rpc.blockNumber().catch((e: unknown) => e)) as RpcError;
		expect(aborted).toBe(true);
		expect(error).toMatchObject({ kind: "timeout", detail: "no answer in 50 ms" });
		expect(error.message).not.toContain(KEY);
	});

	it("reads `-32011` and 'rate limit' wording as a limit, with a retryAt", async () => {
		for (const answer of [failure(-32011, "request limit reached"), failure(-32005, "daily rate limit exceeded")]) {
			const time = clock();
			const rpc = rpcClients({ fetch: faux(() => answer).fetcher, ...time, retries: 0 }).client(BASE, RPC);
			const error = (await rpc.blockNumber().catch((e: unknown) => e)) as RpcError;
			expect(error.kind).toBe("limited");
			expect(error.retryAt).toBeGreaterThan(time.now() - 1);
		}
	});

	it("reads a revert as the node's answer, whatever words the contract chose (H-183)", async () => {
		for (const answer of [
			failure(3, "execution reverted: rate limit exceeded"),
			failure(-32000, "execution reverted: too many requests"),
		]) {
			const time = clock();
			const { fetcher, calls } = faux(({ method }) => (method === "eth_estimateGas" ? answer : result("0x1")));
			const clients = rpcClients({ fetch: fetcher, ...time });
			const start = time.now();
			const error = (await clients
				.client(BASE, RPC)
				.estimateGas({ to: ADDR })
				.catch((e: unknown) => e)) as RpcError;
			expect(error).toMatchObject({ kind: "rpc", code: answer.body.error.code });
			expect(error.retryAt).toBeUndefined();
			expect(calls).toHaveLength(1);
			expect(await clients.client(TWIN, RPC).blockNumber()).toBe(1n);
			expect(time.elapsed(start)).toBe(0);
		}
	});

	it("gives up a read after its retries, with growing waits", async () => {
		const time = clock();
		const { fetcher, calls } = faux(() => new TypeError("fetch failed"));
		const rpc = rpcClients({ fetch: fetcher, ...time, retries: 3, backoffMs: 100, random: () => 1 }).client(BASE, RPC);
		const start = time.now();
		await expect(rpc.blockNumber()).rejects.toMatchObject({ kind: "transport" });
		expect(calls).toHaveLength(4);
		expect(time.elapsed(start)).toBe(100 + 200 + 400);
	});

	it("does not ask again after a node's error", async () => {
		const { fetcher, calls } = faux(() => failure(-32000, "execution reverted"));
		await expect(rpcClients({ fetch: fetcher }).client(BASE, RPC).call({ to: ADDR })).rejects.toMatchObject({
			kind: "rpc",
		});
		expect(calls).toHaveLength(1);
	});

	it("hands signed bytes over once, whatever the answer (H-184)", async () => {
		for (const answer of [
			new TypeError("fetch failed"),
			{ status: 429, text: "" },
			{ status: 502, text: "" },
		] satisfies Answer[]) {
			const { fetcher, calls } = faux(() => answer);
			const rpc = rpcClients({ fetch: fetcher, ...clock() }).client(BASE, RPC);
			const error = await rpc.sendRaw("0x02f8").catch((e: unknown) => e);
			expect(calls).toHaveLength(1);
			expect(poolOf(error)).toBe("other");
		}
		const { fetcher } = faux(() => result(HASH));
		expect(await rpcClients({ fetch: fetcher }).client(BASE, RPC).sendRaw("0x02f8")).toBe(HASH);
		await expect(rpcClients({ fetch: fetcher }).client(BASE, RPC).sendRaw("02f8")).rejects.toThrow(RangeError);
	});
});

describe("getLogs", () => {
	const log = (block: bigint) => ({
		address: ADDR,
		topics: [HASH],
		data: "0x",
		blockNumber: `0x${block.toString(16)}`,
		blockHash: HASH2,
		transactionHash: HASH,
		logIndex: "0x0",
	});
	const ranges = (calls: Call[]) =>
		calls.map((call) => {
			const { fromBlock, toBlock } = call.params[0] as { fromBlock: string; toBlock: string };
			return [BigInt(fromBlock), BigInt(toBlock)] as const;
		});

	it("reads the range in chunks of `span`, inclusive at both ends", async () => {
		const { fetcher, calls } = faux(({ params }) =>
			result([log(BigInt((params[0] as { fromBlock: string }).fromBlock))]),
		);
		const rpc = rpcClients({ fetch: fetcher }).client(BASE, RPC);
		const got = await rpc.getLogs({ address: ADDR, topics: [HASH, null] }, { from: 10n, to: 34n, span: 10n });
		expect(ranges(calls)).toEqual([
			[10n, 19n],
			[20n, 29n],
			[30n, 34n],
		]);
		expect(got.span).toBe(10n);
		expect(got.logs.map((l) => l.blockNumber)).toEqual([10n, 20n, 30n]);
		expect((nth(calls, 0).params[0] as { topics: unknown }).topics).toEqual([HASH, null]);
	});

	it("narrows to the width a refusal names, then keeps it", async () => {
		const { fetcher, calls } = faux(({ params }) => {
			const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
			return BigInt(toBlock) - BigInt(fromBlock) + 1n > 200n
				? failure(-32614, "eth_getLogs is limited to a 200 range", 413)
				: result([]);
		});
		const got = await rpcClients({ fetch: fetcher })
			.client(BASE, RPC)
			.getLogs({}, { from: 0n, to: 499n, span: 50_000n });
		expect(got.span).toBe(200n);
		expect(ranges(calls)).toEqual([
			[0n, 499n],
			[0n, 199n],
			[200n, 399n],
			[400n, 499n],
		]);
	});

	it("narrows to a width a refusal writes with a thousands separator", async () => {
		const { fetcher, calls } = faux(({ params }) => {
			const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
			return BigInt(toBlock) - BigInt(fromBlock) + 1n > 10_000n
				? failure(-32614, "eth_getLogs is limited to a 10,000 range", 413)
				: result([]);
		});
		const got = await rpcClients({ fetch: fetcher })
			.client(BASE, RPC)
			.getLogs({}, { from: 0n, to: 24_999n, span: 50_000n });
		expect(got.span).toBe(10_000n);
		expect(ranges(calls)).toEqual([
			[0n, 24_999n],
			[0n, 9_999n],
			[10_000n, 19_999n],
			[20_000n, 24_999n],
		]);
	});

	it("halves a range refused without a width, and stops at one block", async () => {
		const { fetcher } = faux(({ params }) => {
			const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
			return BigInt(toBlock) - BigInt(fromBlock) + 1n > 30n
				? failure(-32005, "query returned more than 10000 results")
				: result([]);
		});
		const got = await rpcClients({ fetch: fetcher }).client(BASE, RPC).getLogs({}, { from: 0n, to: 99n, span: 100n });
		expect(got.span).toBe(25n);

		const always = faux(() => failure(-32005, "query returned more than 10000 results"));
		await expect(
			rpcClients({ fetch: always.fetcher }).client(BASE, RPC).getLogs({}, { from: 0n, to: 9n, span: 8n }),
		).rejects.toMatchObject({ kind: "rpc" });
		expect(ranges(always.calls).at(-1)).toEqual([0n, 0n]);
	});

	it("throws at once on a refusal that names a block range but not its width", async () => {
		for (const message of ["invalid block range params", "block range extends beyond current head block"]) {
			const { fetcher, calls } = faux(() => failure(-32602, message));
			await expect(
				rpcClients({ fetch: fetcher }).client(BASE, RPC).getLogs({}, { from: 0n, to: 199n, span: 1000n }),
			).rejects.toMatchObject({ kind: "rpc", detail: message });
			expect(calls).toHaveLength(1);
		}
	});

	it("narrows on a bare HTTP 413 or 408, with no JSON-RPC body", async () => {
		for (const status of [413, 408]) {
			const { fetcher } = faux(({ params }) => {
				const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
				return BigInt(toBlock) - BigInt(fromBlock) + 1n > 25n ? { status, text: "" } : result([]);
			});
			const got = await rpcClients({ fetch: fetcher, ...clock() })
				.client(BASE, RPC)
				.getLogs({}, { from: 0n, to: 99n, span: 100n });
			expect(got.span).toBe(25n);
		}
	});

	it("narrows at once on a timeout, without asking the same range again", async () => {
		const timeout = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
		const { fetcher, calls } = faux(({ params }) => {
			const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
			return BigInt(toBlock) - BigInt(fromBlock) + 1n > 50n ? timeout() : result([]);
		});
		const time = clock();
		const start = time.now();
		const got = await rpcClients({ fetch: fetcher, ...time, retries: 3 })
			.client(BASE, RPC)
			.getLogs({}, { from: 0n, to: 99n, span: 100n });
		expect(got.span).toBe(50n);
		expect(ranges(calls)).toEqual([
			[0n, 99n],
			[0n, 49n],
			[50n, 99n],
		]);
		expect(time.elapsed(start)).toBe(0);
	});

	it("narrows a range whose answer is larger than banda reads, as a refusal", async () => {
		const { fetcher, calls } = faux(({ params }) => {
			const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
			const width = Number(BigInt(toBlock) - BigInt(fromBlock) + 1n);
			return result(Array.from({ length: width }, (_, i) => log(BigInt(fromBlock) + BigInt(i))));
		});
		const one = JSON.stringify({ jsonrpc: "2.0", id: 1, result: [log(0n)] }).length;
		const got = await rpcClients({ fetch: fetcher, maxLogsBytes: one * 30 })
			.client(BASE, RPC)
			.getLogs({}, { from: 0n, to: 99n, span: 100n });
		expect(got.span).toBe(25n);
		expect(got.logs.map((l) => l.blockNumber)).toEqual(Array.from({ length: 100 }, (_, i) => BigInt(i)));
		expect(ranges(calls).slice(0, 3)).toEqual([
			[0n, 99n],
			[0n, 49n],
			[0n, 24n],
		]);

		const huge = faux(() => ({ text: `{"result":[]${" ".repeat(5_000)}}` }));
		await expect(
			rpcClients({ fetch: huge.fetcher, maxLogsBytes: 1_000 })
				.client(BASE, RPC)
				.getLogs({}, { from: 0n, to: 3n, span: 4n }),
		).rejects.toMatchObject({ kind: "shape", tooLarge: true });
		expect(ranges(huge.calls).at(-1)).toEqual([0n, 0n]);
	});

	it("does not narrow for an error that is not about the range", async () => {
		const { fetcher, calls } = faux(() => failure(-32602, "invalid params"));
		await expect(
			rpcClients({ fetch: fetcher }).client(BASE, RPC).getLogs({}, { from: 0n, to: 99n, span: 100n }),
		).rejects.toMatchObject({ kind: "rpc" });
		expect(calls).toHaveLength(1);
	});
});

describe("estimateL1Fee", () => {
	it("asks the network's GasPriceOracle for getL1FeeUpperBound(size)", async () => {
		const { fetcher, calls } = faux(() => result(`0x${195n.toString(16).padStart(64, "0")}`));
		const fee = await rpcClients({ fetch: fetcher }).client(BASE, RPC).estimateL1Fee(110n);
		expect(fee).toBe(195n);
		const [request, tag] = nth(calls, 0).params as [{ to: string; data: string }, string];
		expect(request.to).toBe(BASE.gasPriceOracle);
		expect(request.data.slice(0, 10)).toBe(toFunctionSelector("function getL1FeeUpperBound(uint256)"));
		expect(BigInt(`0x${request.data.slice(10)}`)).toBe(110n);
		expect(tag).toBe("latest");
	});

	it("refuses an answer that is not one uint256", async () => {
		const { fetcher } = faux(() => result("0x"));
		await expect(rpcClients({ fetch: fetcher }).client(BASE, RPC).estimateL1Fee(110n)).rejects.toMatchObject({
			kind: "shape",
		});
	});
});

describe("classify", () => {
	/** Every pool answer the spikes recorded, verbatim (docs/wallets/spikes/gaps/README.md section D). */
	const MEASURED: [string, string][] = [
		["already known", "known"],
		["transaction already imported", "known"],
		["known transaction: 0x1acd106a8268ca4d", "known"],
		["nonce too low: next nonce 1, tx nonce 0", "nonce_low"],
		["nonce too low", "nonce_low"],
		["replacement transaction underpriced", "underpriced"],
		[
			"insufficient funds for gas * price + value: balance 0, tx cost 210000000000001, overshot 210000000000001",
			"funds",
		],
		["insufficient funds for gas * price + value: have 0 want 210000000000001", "funds"],
		["Insufficient funds for gas * price + value", "funds"],
		["max fee per gas less than block base fee", "fee_low"],
		["transaction underpriced", "fee_low"],
		["transaction gas price below minimum: gas tip cap 0, minimum needed 1", "fee_low"],
		["invalid sender: invalid chain id for signer: have 1 want 1337", "other"],
		["invalid chain ID", "other"],
		["unknown transaction type", "other"],
		["unknown transaction", "other"],
		["transaction type not supported", "other"],
		["execution reverted", "other"],
		["", "other"],
	];

	it.each(MEASURED)("%j is %s", (message, kind) => {
		expect(classifyMessage(message)).toBe(kind);
		expect(classifyMessage(message.toUpperCase())).toBe(kind);
		expect(poolOf(new RpcError("x", "eth_sendRawTransaction", "rpc", message))).toBe(kind);
	});

	it("reads only a node's answer: anything else may have been sent", () => {
		for (const kind of ["limited", "http", "transport", "timeout", "shape", "chain"] as const)
			expect(poolOf(new RpcError("x", "m", kind, "nonce too low"))).toBe("other");
		expect(poolOf(new Error("nonce too low"))).toBe("other");
		expect(poolOf("nonce too low")).toBe("other");
	});

	it("a message with none of the table's phrases is other, however close its words come", () => {
		const phrases = new RegExp(
			[
				"\\balready known\\b",
				"\\balready imported\\b",
				"\\bknown transaction\\b",
				"nonce too low",
				"replacement transaction underpriced",
				"insufficient funds",
				"max fee per gas less than block base fee",
				"transaction underpriced",
				"gas price below minimum",
			].join("|"),
			"i",
		);
		const words = fc.constantFrom(
			"unknown",
			"known",
			"already",
			"imported",
			"transaction",
			"type",
			"nonce",
			"too",
			"low",
			"high",
			"underpriced",
			"replacement",
			"insufficient",
			"funds",
			"gas",
			"price",
			"below",
			"minimum",
			"base",
			"fee",
			":",
		);
		const message = fc.oneof(
			fc.string(),
			fc.array(words, { maxLength: 6 }).map((all) => all.join(" ")),
			fc.array(words, { maxLength: 6 }).map((all) => all.join("")),
		);
		fc.assert(
			fc.property(
				message.filter((s) => !phrases.test(s)),
				(text) => classifyMessage(text) === "other",
			),
			{ numRuns: pbtRuns(500) },
		);
	});
});
