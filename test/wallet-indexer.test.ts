/**
 * The indexer (C22): incoming USDC from the pinned token's `Transfer` logs and native ETH by balance and nonce
 * bisection, kept in `Incoming` with cursors that move only to `finalized`, read from each wallet's creation, and the
 * native stretches left unread kept until a pass reads them. Over a faux RPC, a chain the test
 * writes block by block, for what a public RPC does (a narrow log range, a rate limit, pruned state, an answer with
 * logs it was not asked for); and on anvil, for what a real node gives, as the tx-history spike measured it. The
 * anvil half skips, titled "anvil 1.9.0 not found (mise install)", on a machine without the pinned anvil.
 */
import { randomBytes } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { context, openStore } from "../src/core/store.ts";
import { checksummed } from "../src/wallet/address.ts";
import { Incoming, type IncomingValue, incomingKey, nativeKey, type WalletState, Wallets } from "../src/wallet/docs.ts";
import {
	createIndexer,
	FRESHNESS,
	type IndexerDeps,
	incomingConfirmed,
	TRANSFER,
	topicOf,
} from "../src/wallet/indexer.ts";
import { type Network, networkOf } from "../src/wallet/networks.ts";
import { rpcClients } from "../src/wallet/rpc.ts";
import { type Anvil, DEV0, hasAnvil, NO_ANVIL, startAnvil } from "./helpers/anvil.ts";
import { FauxChain, GENESIS, hex, word } from "./helpers/faux-chain.ts";
import { tempHome, until } from "./helpers.ts";

const TEST = { BANDA_TEST_CHAIN: "1" };
const networkNamed = (id: string): Network => {
	const network = networkOf(id, TEST);
	if (network === undefined) throw new Error(`no ${id} network`);
	return network;
};
const LOCAL_USDC = networkNamed("anvil-usdc");
const TOKEN = LOCAL_USDC.usdc?.address ?? "";
const addressOf = () => checksummed(`0x${randomBytes(20).toString("hex")}`);

const opened: Harness[] = [];
const open = async (home: string) => {
	const store = await openStore(home, { models: createModels(), registry: createRegistry() });
	opened.push(store);
	return store;
};
afterEach(async () => {
	for (const store of opened.splice(0)) await store.close(context).catch(() => {});
});

async function addWallets(
	store: Harness,
	wallets: readonly string[],
	network = LOCAL_USDC,
	state: WalletState = "ready",
	at = 0,
) {
	await store.commit(async (tx) => {
		const doc = await tx.doc(Wallets);
		for (const address of wallets)
			doc.wallets[checksummed(address)] = {
				name: `W ${address.slice(2, 6)}`,
				network: network.id,
				state,
				backup: "saved",
				default: "ask",
				disclosed: true,
				request: `r-${address}`,
				version: 1,
				at,
			};
	}, context);
}

const incoming = async (store: Harness): Promise<Readonly<IncomingValue>> =>
	(await store.snapshot(Incoming, context)) ?? { rows: {}, cursors: {} };

/** The faux chain of the pinned-token network, its logs the pinned token's unless a test names another. */
class Chain extends FauxChain {
	constructor() {
		super(LOCAL_USDC.chainId);
	}
	pay(fields: Omit<Parameters<FauxChain["log"]>[0], "token"> & { address?: string }) {
		return this.log({ token: fields.address ?? TOKEN, ...fields });
	}
}

const RPC = { url: "https://rpc.example/", headers: {} };

function fauxIndexer(chain: Chain, store: Harness, extra: Partial<IndexerDeps> = {}) {
	const clients = rpcClients({ fetch: chain.fetch, retries: 0, sleep: async () => {}, rate: 1e6, burst: 1e6 });
	return createIndexer({
		store,
		rpc: async (network) => clients.client(network, RPC),
		networks: () => [networkNamed("anvil"), LOCAL_USDC],
		...extra,
	});
}

describe("over a faux RPC", () => {
	it("reads every wallet of a network with one log filter, never by sender (H-198, H-210)", async () => {
		const store = await open(await tempHome());
		const wallets = [addressOf(), addressOf(), addressOf()];
		await addWallets(store, wallets);
		const chain = new Chain();
		chain.head = 100;
		chain.final = 90;
		await fauxIndexer(chain, store).pass("anvil-usdc");
		const logs = chain.calls.filter((call) => call.method === "eth_getLogs");
		expect(logs).toHaveLength(1);
		const filter = logs[0]?.params[0] as { address: string; topics: unknown[] };
		expect(filter.address).toBe(TOKEN);
		expect(filter.topics).toEqual([TRANSFER, null, [...wallets].sort().map(topicOf)]);
	});

	it("shows a wallet's first balance as soon as the head is read, before its history is (UC-14)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 100;
		chain.final = 90;
		chain.set(wallet, 95, 7n);
		const told: (string | undefined)[] = [];
		let logs: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			logs = resolve;
		});
		const fetch: typeof chain.fetch = async (url, init) => {
			if (JSON.parse(String(init?.body)).method === "eth_getLogs") await held;
			return chain.fetch(url, init);
		};
		const clients = rpcClients({ fetch, retries: 0, sleep: async () => {}, rate: 1e6, burst: 1e6 });
		const indexer = createIndexer({
			store,
			rpc: async (network) => clients.client(network, RPC),
			networks: () => [LOCAL_USDC],
			onChange: (network) => told.push(indexer.status(network)?.balances[checksummed(wallet)]?.native),
		});
		const pass = indexer.pass("anvil-usdc");
		await until(() => (told.length > 0 ? true : undefined));
		expect(told).toEqual(["7"]);
		logs();
		await pass;
		// then the row the history read found, told again though the balance did not move
		expect(told).toEqual(["7", "7"]);
		expect(Object.values((await incoming(store)).rows).map((row) => row.amount)).toEqual(["7"]);
	});

	it("sends no RPC the address of a wallet whose key is not kept yet, nor of one being removed (H-006)", async () => {
		const store = await open(await tempHome());
		const kept = addressOf();
		const creating = addressOf();
		const removing = addressOf();
		await addWallets(store, [kept]);
		await addWallets(store, [creating], LOCAL_USDC, "creating");
		await addWallets(store, [removing], LOCAL_USDC, "removing");
		const chain = new Chain();
		chain.head = 100;
		chain.final = 90;
		await fauxIndexer(chain, store).pass("anvil-usdc");
		const asked = JSON.stringify(chain.calls).toLowerCase();
		expect(asked).toContain(kept.slice(2).toLowerCase());
		for (const address of [creating, removing]) expect(asked).not.toContain(address.slice(2).toLowerCase());
	});

	it("asks nothing of a network no wallet is on", async () => {
		const store = await open(await tempHome());
		await addWallets(store, [addressOf()]);
		const chain = new Chain();
		chain.head = 10;
		const status = await fauxIndexer(chain, store).pass("anvil");
		expect(chain.calls).toEqual([]);
		expect(status.gaps).toEqual([]);
	});

	it("keeps only real payments into a wallet of the pinned token (H-160, H-205, H-210)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		const other = addressOf();
		const sender = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil-usdc");
		chain.head = 50;
		chain.final = 40;
		const paid = chain.pay({ from: sender, to: wallet, value: 5_000_000n, block: 10, index: 3 });
		chain.pay({ address: addressOf(), from: sender, to: wallet, value: 1n, block: 11 });
		chain.pay({ from: sender, to: wallet, value: 0n, block: 12 });
		chain.pay({ from: wallet, to: wallet, value: 7n, block: 13 });
		chain.pay({ from: sender, to: wallet, value: 9n, block: 14, removed: true });
		chain.pay({ from: wallet, to: other, value: 4n, block: 15 });
		chain.pay({ from: sender, to: other, value: 4n, block: 16 });
		chain.pay({ from: sender, to: wallet, value: 4n, block: 17, topics: [TRANSFER, topicOf(sender)] });
		await indexer.pass("anvil-usdc");
		expect((await incoming(store)).rows).toEqual({
			[incomingKey(paid, 3)]: {
				wallet: checksummed(wallet),
				asset: "usdc",
				amount: "5000000",
				from: sender,
				block: 10,
			},
		});
	});

	it("upserts rows by (hash, log index): a range read again changes nothing (H-212)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil-usdc");
		chain.head = 30;
		chain.final = 25;
		const hash = chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 5, index: 0 });
		chain.pay({ from: addressOf(), to: wallet, value: 2n, block: 5, index: 1 });
		await indexer.pass("anvil-usdc");
		const first = await incoming(store);
		expect(Object.keys(first.rows)).toHaveLength(2);
		expect(first.rows[incomingKey(hash, 0)]?.amount).toBe("1");
		await indexer.pass("anvil-usdc");
		// the cursors set back: the whole range is read again, into the same rows
		await store.commit(async (tx) => {
			const doc = await tx.doc(Incoming);
			doc.cursors["anvil-usdc"] = 0;
			doc.read = { [checksummed(wallet)]: 0 };
		}, context);
		await indexer.pass("anvil-usdc");
		expect((await incoming(store)).rows).toEqual(first.rows);
	});

	it("keeps a wallet's newest final rows alone, however much dust is sent to it, and says what it dropped (C22)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store, { keepRows: 10 });
		await indexer.pass("anvil-usdc");
		const sizes: number[] = [];
		for (let round = 0; round < 4; round++) {
			for (let n = 1; n <= 30; n++)
				chain.pay({ from: addressOf(), to: wallet, value: 1n, block: round * 40 + n, index: 0 });
			chain.head = (round + 1) * 40 + 5;
			chain.final = (round + 1) * 40;
			await indexer.pass("anvil-usdc");
			const value = await incoming(store);
			const kept = Object.values(value.rows).map((row) => row.block);
			// the newest ten final rows, by whole blocks; none above the final cursor is dropped
			expect(kept.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, at) => round * 40 + 21 + at));
			expect(value.dropped?.[checksummed(wallet)]).toBe(round * 40 + 20);
			sizes.push(JSON.stringify(value).length);
		}
		// the doc holds the same bounded history after every round: a write rewrites no more than it
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
		// read again from the start, nothing dropped comes back
		await store.commit(async (tx) => {
			const doc = await tx.doc(Incoming);
			doc.cursors["anvil-usdc"] = 0;
			doc.read = { [checksummed(wallet)]: 0 };
		}, context);
		await indexer.pass("anvil-usdc");
		expect(Object.keys((await incoming(store)).rows)).toHaveLength(10);
	});

	it("keeps a wallet's gaps within what it keeps, however often its key spends outside banda (C22, H-210)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.set(wallet, 0, 1_000_000n);
		const indexer = fauxIndexer(chain, store, { keepRows: 5 });
		await indexer.pass("anvil");
		const sizes: number[] = [];
		let nonce = 0n;
		let balance = 1_000_000n;
		for (let round = 0; round < 4; round++) {
			const base = round * 400;
			// the owner spends with the exported key 30 times, each moving the nonce in a block of its own, then money
			// comes in over 20 blocks
			for (let n = 1; n <= 30; n++) {
				nonce += 1n;
				balance -= 1000n;
				chain.set(wallet, base + n * 10, balance, nonce);
			}
			for (let n = 1; n <= 20; n++) {
				balance += 7n;
				chain.set(wallet, base + 320 + n, balance, nonce);
			}
			chain.head = base + 400;
			chain.final = base + 400;
			await indexer.pass("anvil");
			const value = await incoming(store);
			const dropped = value.dropped?.[checksummed(wallet)] ?? -1;
			const gaps = value.gaps?.[checksummed(wallet)] ?? [];
			expect(Object.keys(value.rows)).toHaveLength(5);
			expect(dropped).toBe(base + 335);
			// no gap at or below what the wallet dropped: no row there is kept again
			expect(gaps.every((gap) => gap.from > dropped)).toBe(true);
			sizes.push(JSON.stringify(value).length);
		}
		// the doc holds the same bounded history after every round
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
	});

	it("moves the cursor only to finalized, and resumes from it after a restart", async () => {
		const home = await tempHome();
		let store = await open(home);
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		await fauxIndexer(chain, store).pass("anvil-usdc");
		chain.head = 100;
		chain.final = 80;
		const settled = chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 70 });
		const fresh = chain.pay({ from: addressOf(), to: wallet, value: 2n, block: 95 });
		const status = await fauxIndexer(chain, store).pass("anvil-usdc");
		expect(status).toMatchObject({ cursor: 80, head: 100 });
		const value = await incoming(store);
		expect(value.cursors).toEqual({ "anvil-usdc": 80 });
		const row = value.rows[incomingKey(fresh, 0)];
		expect(row).toBeDefined();
		expect(incomingConfirmed(row ?? { block: 0 }, value.cursors, "anvil-usdc")).toBe(false);
		expect(incomingConfirmed(value.rows[incomingKey(settled, 0)] ?? { block: 1e9 }, value.cursors, "anvil-usdc")).toBe(
			true,
		);
		await store.close(context);
		opened.splice(opened.indexOf(store), 1);
		store = await open(home);
		chain.calls.length = 0;
		chain.head = 150;
		chain.final = 140;
		await fauxIndexer(chain, store).pass("anvil-usdc");
		expect(chain.ranges()).toEqual([[81, 150]]);
		expect((await incoming(store)).cursors).toEqual({ "anvil-usdc": 140 });
	});

	it("deletes a row above finalized that the chain no longer shows, never one below it (H-213)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil-usdc");
		chain.head = 100;
		chain.final = 90;
		const final = chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 85 });
		chain.pay({ from: addressOf(), to: wallet, value: 2n, block: 95 });
		chain.set(wallet, 96, 10n);
		await indexer.pass("anvil-usdc");
		expect(Object.keys((await incoming(store)).rows)).toHaveLength(3);
		// a reorg: the unfinal blocks are made again without the payments
		chain.logs.splice(1);
		chain.set(wallet, 96, 0n);
		chain.head = 101;
		await indexer.pass("anvil-usdc");
		expect(Object.keys((await incoming(store)).rows)).toEqual([incomingKey(final, 0)]);
	});

	it("keeps the rows above the head of a node a few blocks behind, which has not seen their blocks yet (H-213)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil-usdc");
		chain.head = 100;
		chain.final = 90;
		chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 85 });
		chain.pay({ from: addressOf(), to: wallet, value: 2n, block: 97 });
		chain.set(wallet, 96, 10n);
		await indexer.pass("anvil-usdc");
		const rows = async () => Object.keys((await incoming(store)).rows).sort();
		const seen = await rows();
		expect(seen).toHaveLength(3);
		// a load-balanced RPC answers from a node behind the chain: its head is below the newest rows' blocks
		chain.head = 94;
		await indexer.pass("anvil-usdc");
		expect(await rows()).toEqual(seen);
		chain.head = 95;
		await indexer.pass("anvil-usdc");
		expect(await rows()).toEqual(seen);
		// a node at the head again shows the same rows, so none went and came back
		chain.head = 101;
		await indexer.pass("anvil-usdc");
		expect(await rows()).toEqual(seen);
	});

	it("reads a range the RPC refuses as too wide at the width it names, skipping no block (H-207, H-215)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.maxRange = 200;
		const blocks = [1, 199, 200, 201, 400, 401, 999, 1000];
		for (const block of blocks) chain.pay({ from: addressOf(), to: wallet, value: BigInt(block), block });
		const indexer = fauxIndexer(chain, store, { stepBlocks: 600 });
		await indexer.pass("anvil-usdc");
		chain.head = 1000;
		chain.final = 1000;
		await indexer.pass("anvil-usdc");
		const rows = Object.values((await incoming(store)).rows).map((row) => row.block);
		expect(rows.sort((a, b) => a - b)).toEqual(blocks);
		const served = chain.ranges().filter(([from, to]) => (to ?? 0) - (from ?? 0) + 1 <= 200);
		const covered = new Set(
			served.flatMap(([from = 0, to = 0]) => Array.from({ length: to - from + 1 }, (_, i) => from + i)),
		);
		expect(covered.size).toBe(1000);
		// the width found is kept for the RPC: the next pass asks no wider
		chain.calls.length = 0;
		chain.head = 1300;
		chain.final = 1300;
		await indexer.pass("anvil-usdc");
		expect(chain.ranges()).toEqual([
			[1001, 1200],
			[1201, 1300],
		]);
	});

	it("keeps the cursor and the rows already read when the RPC rate-limits mid-scan (H-183, H-207)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store, { stepBlocks: 100, now: () => 1_000 });
		await indexer.pass("anvil-usdc");
		chain.head = 300;
		chain.final = 300;
		const first = chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 50 });
		chain.pay({ from: addressOf(), to: wallet, value: 2n, block: 150 });
		chain.refuse = (method, params) => {
			const from = Number((params[0] as { fromBlock?: string } | undefined)?.fromBlock);
			return method === "eth_getLogs" && from > 100
				? new Response("{}", { status: 429, headers: { "retry-after": "3600" } })
				: undefined;
		};
		const status = await indexer.pass("anvil-usdc");
		expect(status.failed?.retryAt).toBeGreaterThan(1_000);
		const value = await incoming(store);
		expect(value.cursors).toEqual({ "anvil-usdc": 100 });
		// the status says what the chunks before the failure committed
		expect(status.cursor).toBe(100);
		expect(Object.keys(value.rows)).toEqual([incomingKey(first, 0)]);
	});

	it("finds ETH that arrived with no log, and leaves a gap where the RPC has no state (H-204, H-215)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil");
		chain.head = 1000;
		chain.final = 1000;
		chain.set(wallet, 137, 1_000n);
		chain.set(wallet, 512, 1_500n);
		await indexer.pass("anvil");
		expect((await incoming(store)).rows).toEqual({
			[nativeKey(wallet, 137)]: { wallet: checksummed(wallet), asset: "native", amount: "1000", block: 137 },
			[nativeKey(wallet, 512)]: { wallet: checksummed(wallet), asset: "native", amount: "500", block: 512 },
		});
		// state pruned below the cursor: what arrived below the node's window is not known, and never reported as
		// nothing; what arrived inside it is read
		chain.stateFrom = 1500;
		chain.head = 2000;
		chain.final = 2000;
		chain.set(wallet, 1200, 1_700n);
		chain.set(wallet, 1800, 2_000n);
		const status = await indexer.pass("anvil");
		const gap = { wallet: checksummed(wallet), from: 1001, to: 1500, why: "state" };
		expect(status.gaps).toEqual([gap]);
		expect((await incoming(store)).rows[nativeKey(wallet, 1800)]).toEqual({
			wallet: checksummed(wallet),
			asset: "native",
			amount: "300",
			block: 1800,
		});
		expect(Object.keys((await incoming(store)).rows)).toHaveLength(3);
		// the cursor moved past it, and the gap stays, in a later pass and in another process, until one reads it;
		// this RPC is not asked for it again, since it serves nothing below 1500 (H-198)
		chain.head = 2100;
		chain.final = 2100;
		chain.calls.length = 0;
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		const asked = chain.calls.filter((call) => call.method === "eth_getBalance").map((call) => Number(call.params[1]));
		expect(asked.every((block) => block >= 2000)).toBe(true);
		expect((await fauxIndexer(chain, store).pass("anvil")).gaps).toEqual([gap]);
		expect((await incoming(store)).cursors.anvil).toBe(2100);
		// an RPC that serves the state again: the gap is read, and what arrived in it is listed
		chain.stateFrom = 0;
		expect((await fauxIndexer(chain, store).pass("anvil")).gaps).toEqual([]);
		expect((await incoming(store)).rows[nativeKey(wallet, 1200)]).toEqual({
			wallet: checksummed(wallet),
			asset: "native",
			amount: "200",
			block: 1200,
		});
	});

	it("gaps only the blocks below a pruned node's window, for a wallet first read there (H-204)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 1000;
		chain.final = 1000;
		chain.stateFrom = 900;
		chain.prunedWords = (block) => `state at block #${block} is pruned`;
		chain.set(wallet, 100, 5n);
		chain.set(wallet, 950, 8n);
		const status = await fauxIndexer(chain, store).pass("anvil");
		expect(status.gaps).toEqual([{ wallet: checksummed(wallet), from: 1, to: 900, why: "state" }]);
		// the window's first block is said with the status: the gap ends at it, so it is not asked again (H-198)
		expect(status.stateFrom).toBe(900);
		expect(Object.values((await incoming(store)).rows)).toEqual([
			{ wallet: checksummed(wallet), asset: "native", amount: "3", block: 950 },
		]);
	});

	it("tells what arrived beside the wallet's own spend only where the store says what it spent (H-210)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.set(wallet, 0, 1_000n);
		let indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil");
		chain.head = 100;
		chain.final = 100;
		// block 40: the wallet sent 300 and paid 10 in fees, and 50 arrived from a contract in the same block
		chain.set(wallet, 40, 740n, 1n);
		const status = await indexer.pass("anvil");
		const gap = { wallet: checksummed(wallet), from: 40, to: 40, why: "unexplained" };
		expect(status.gaps).toEqual([gap]);
		expect((await incoming(store)).rows).toEqual({});
		// the nonce's move stays known past the cursor, for what the store learns later (H-210, C7)
		chain.head = 120;
		chain.final = 120;
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		indexer = fauxIndexer(chain, store, {
			spent: async (_wallet, block) => (block === 40 ? { amount: 310n, nonces: 1 } : undefined),
		});
		expect((await indexer.pass("anvil")).gaps).toEqual([]);
		expect((await incoming(store)).rows).toEqual({
			[nativeKey(wallet, 40)]: { wallet: checksummed(wallet), asset: "native", amount: "50", block: 40 },
		});
	});

	it("leaves a block unexplained where the nonce moved by more than the store's transactions there (H-210, C7)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.set(wallet, 0, 1_000n);
		await fauxIndexer(chain, store).pass("anvil");
		chain.head = 100;
		chain.final = 100;
		// block 40: banda's one transaction spent 110, and one signed elsewhere spent 200, so the nonce moved by 2
		chain.set(wallet, 40, 690n, 2n);
		const one = fauxIndexer(chain, store, {
			spent: async (_wallet, block) => (block === 40 ? { amount: 110n, nonces: 1 } : undefined),
		});
		const gap = { wallet: checksummed(wallet), from: 40, to: 40, why: "unexplained" };
		expect((await one.pass("anvil")).gaps).toEqual([gap]);
		expect((await incoming(store)).rows).toEqual({});
		const both = fauxIndexer(chain, store, {
			spent: async (_wallet, block) => (block === 40 ? { amount: 310n, nonces: 2 } : undefined),
		});
		expect((await both.pass("anvil")).gaps).toEqual([]);
		expect((await incoming(store)).rows).toEqual({});
	});

	it("leaves a block unexplained where more left than the store says its own transactions spent (H-204, H-210)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.set(wallet, 0, 1_000n);
		const indexer = fauxIndexer(chain, store, {
			spent: async (_wallet, block) => (block === 40 ? { amount: 100n, nonces: 1 } : undefined),
		});
		await indexer.pass("anvil");
		chain.head = 100;
		chain.final = 100;
		// block 40: one nonce, as the store says, but 310 left where it says its transaction spent 100
		chain.set(wallet, 40, 690n, 1n);
		expect((await indexer.pass("anvil")).gaps).toEqual([
			{ wallet: checksummed(wallet), from: 40, to: 40, why: "unexplained" },
		]);
		expect((await incoming(store)).rows).toEqual({});
	});

	it("asks nothing again of an unexplained block until the store says something else of it (H-198, H-210)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.set(wallet, 0, 1_000n);
		let own = { amount: 110n, nonces: 1 };
		const indexer = fauxIndexer(chain, store, {
			spent: async (_wallet, block) => (block === 40 ? own : undefined),
		});
		await indexer.pass("anvil");
		chain.head = 100;
		chain.final = 100;
		chain.set(wallet, 40, 690n, 2n);
		const gap = { wallet: checksummed(wallet), from: 40, to: 40, why: "unexplained" };
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		const below = () =>
			chain.calls.filter(
				(call) =>
					["eth_getBalance", "eth_getTransactionCount", "eth_getCode"].includes(call.method) &&
					Number(call.params[1]) < 100,
			);
		// once below the cursor it is asked once with what the store says, then never while the store says the same
		for (const head of [110, 120, 130]) {
			chain.head = head;
			chain.final = head;
			expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		}
		chain.calls.length = 0;
		chain.head = 140;
		chain.final = 140;
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		expect(below()).toEqual([]);
		// the store learns the other transaction: the block is read again, in the same process
		own = { amount: 310n, nonces: 2 };
		expect((await indexer.pass("anvil")).gaps).toEqual([]);
		expect(below().length).toBeGreaterThan(0);
	});

	it("gaps only the state a node refuses for a wallet with code whose window starts at the range's top (H-204)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.code.set(wallet.toLowerCase(), `0xef0100${"ab".repeat(20)}`);
		chain.head = 1000;
		chain.final = 1000;
		chain.stateFrom = 1000;
		const status = await fauxIndexer(chain, store).pass("anvil");
		const gap = { wallet: checksummed(wallet), from: 1, to: 1000, why: "state" };
		expect(status.gaps).toEqual([gap]);
		expect((await incoming(store)).gaps).toEqual({ [checksummed(wallet)]: [{ from: 1, to: 1000, why: "state" }] });
		// the head's code alone, read with its balances for the owner's notice (H-157): the history below asks none
		expect(chain.calls.filter((call) => call.method === "eth_getCode").map((call) => call.params[1])).toEqual([
			"0x3e8",
		]);
		expect(status.balances[checksummed(wallet)]?.code).toBe(true);
	});

	it("reads from where a node serves state now when its window moved down, and reads the gaps below the old one (H-204)", async () => {
		const store = await open(await tempHome());
		const first = addressOf();
		await addWallets(store, [first], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 1000;
		chain.final = 1000;
		chain.stateFrom = 900;
		chain.set(first, 600, 6n);
		const indexer = fauxIndexer(chain, store);
		expect((await indexer.pass("anvil")).gaps).toEqual([
			{ wallet: checksummed(first), from: 1, to: 900, why: "state" },
		]);
		// a node behind the URL now serves from 500, and a second wallet is first read from below the start learned
		const second = addressOf();
		await addWallets(store, [second], networkNamed("anvil"));
		chain.stateFrom = 500;
		chain.head = 1100;
		chain.final = 1100;
		chain.set(second, 100, 1n);
		chain.set(second, 700, 4n);
		const status = await indexer.pass("anvil");
		const byWallet = (a: { wallet: string }, b: { wallet: string }) => (a.wallet < b.wallet ? -1 : 1);
		expect([...status.gaps].sort(byWallet)).toEqual(
			[
				{ wallet: checksummed(first), from: 1, to: 500, why: "state" },
				{ wallet: checksummed(second), from: 1, to: 500, why: "state" },
			].sort(byWallet),
		);
		const rows = Object.values((await incoming(store)).rows).sort((a, b) => a.block - b.block);
		expect(rows).toEqual([
			{ wallet: checksummed(first), asset: "native", amount: "6", block: 600 },
			{ wallet: checksummed(second), asset: "native", amount: "3", block: 700 },
		]);
	});

	it("reads the gaps below an old window start again when a block below it is served from inside the new window (H-204)", async () => {
		const store = await open(await tempHome());
		const first = addressOf();
		await addWallets(store, [first], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 1000;
		chain.final = 1000;
		chain.stateFrom = 900;
		chain.set(first, 600, 6n);
		const indexer = fauxIndexer(chain, store);
		expect((await indexer.pass("anvil")).gaps).toEqual([
			{ wallet: checksummed(first), from: 1, to: 900, why: "state" },
		]);
		// a second wallet is first read from block 600: inside the window that now starts at 500, below the old start
		const second = addressOf();
		await addWallets(store, [second], networkNamed("anvil"), "ready", (GENESIS + 600 + 3600) * 1000);
		chain.stateFrom = 500;
		chain.head = 1100;
		chain.final = 1100;
		const status = await indexer.pass("anvil");
		expect(status.gaps).toEqual([{ wallet: checksummed(first), from: 1, to: 500, why: "state" }]);
		expect(Object.values((await incoming(store)).rows)).toEqual([
			{ wallet: checksummed(first), asset: "native", amount: "6", block: 600 },
		]);
	});

	it("reads code once for a stretch whose nonce stood still, however many changes it bisects (H-198)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 1024;
		chain.final = 1024;
		for (let i = 1; i <= 8; i++) chain.set(wallet, i * 113, BigInt(i) * 10n);
		await fauxIndexer(chain, store).pass("anvil");
		expect(Object.keys((await incoming(store)).rows)).toHaveLength(8);
		expect(chain.calls.filter((call) => call.method === "eth_getCode")).toHaveLength(1);
	});

	it("asks nothing again of a state gap below a pruned window that moved past it, after a restart (H-198, H-204)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 1000;
		chain.final = 1000;
		await fauxIndexer(chain, store).pass("anvil");
		chain.stateFrom = 1500;
		chain.head = 2000;
		chain.final = 2000;
		const gap = { wallet: checksummed(wallet), from: 1001, to: 1500, why: "state" };
		expect((await fauxIndexer(chain, store).pass("anvil")).gaps).toEqual([gap]);
		// the window moves above the gap's top, and the daemon restarts: the gap is asked once, then never
		chain.stateFrom = 1900;
		chain.head = 2100;
		chain.final = 2100;
		const indexer = fauxIndexer(chain, store);
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		chain.calls.length = 0;
		chain.head = 2200;
		chain.final = 2200;
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		const below = chain.calls.filter(
			(call) =>
				["eth_getBalance", "eth_getTransactionCount", "eth_getCode"].includes(call.method) &&
				Number(call.params[1]) < 1900,
		);
		expect(below).toEqual([]);
	});

	it("reads an emptied Incoming again from each wallet's creation, into the same rows (C22, H-203)", async () => {
		const home = await tempHome();
		const store = await open(home);
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 2000;
		chain.final = 1990;
		chain.set(wallet, 700, 3n);
		chain.set(wallet, 1500, 10n);
		chain.pay({ from: addressOf(), to: wallet, value: 4n, block: 900 });
		chain.pay({ from: addressOf(), to: wallet, value: 6n, block: 1995 });
		const indexer = fauxIndexer(chain, store, { stepBlocks: 600 });
		// the wallet was paid before this home ever read it
		await indexer.pass("anvil-usdc");
		const first = await incoming(store);
		expect(Object.values(first.rows).map((row) => [row.block, row.amount])).toEqual(
			expect.arrayContaining([
				[700, "3"],
				[900, "4"],
				[1500, "7"],
				[1995, "6"],
			]),
		);
		expect(Object.keys(first.rows)).toHaveLength(4);
		for (const again of [indexer, fauxIndexer(chain, store)]) {
			await store.commit(async (tx) => {
				const doc = await tx.doc(Incoming);
				doc.rows = {};
				doc.cursors = {};
				delete doc.read;
				delete doc.gaps;
			}, context);
			await again.pass("anvil-usdc");
			expect(await incoming(store)).toEqual(first);
		}
	});

	it("reads a wallet from an hour before it was made, never from the chain's start (H-203)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], LOCAL_USDC, "ready", (GENESIS + 5000) * 1000);
		const chain = new Chain();
		chain.head = 6000;
		chain.final = 6000;
		chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 1000 });
		chain.pay({ from: addressOf(), to: wallet, value: 2n, block: 5500 });
		await fauxIndexer(chain, store).pass("anvil-usdc");
		expect(chain.ranges()).toEqual([[1401, 6000]]);
		expect(Object.values((await incoming(store)).rows).map((row) => row.block)).toEqual([5500]);
	});

	it("moves no cursor on an RPC with no finalized block, and says so (H-207)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 50;
		chain.final = undefined;
		chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 10 });
		const indexer = fauxIndexer(chain, store);
		const status = await indexer.pass("anvil-usdc");
		expect(status.failed?.reason).toMatch(/finalized/);
		expect(status.at).toBeUndefined();
		expect((await incoming(store)).cursors).toEqual({});
		chain.final = 40;
		const read = await indexer.pass("anvil-usdc");
		expect(read).toMatchObject({ cursor: 40, head: 50 });
		expect(read.failed).toBeUndefined();
		expect(Object.keys((await incoming(store)).rows)).toHaveLength(1);
	});

	it("checks the chain of every RPC it is given, not only the first (H-187, H-215)", async () => {
		const store = await open(await tempHome());
		await addWallets(store, [addressOf()]);
		const right = new Chain();
		const wrong = new Chain();
		wrong.chainId = 8453;
		for (const chain of [right, wrong]) {
			chain.head = 10;
			chain.final = 10;
		}
		const clients = rpcClients({
			fetch: (url, init) => (String(url).includes("wrong") ? wrong.fetch(url, init) : right.fetch(url, init)),
			retries: 0,
			sleep: async () => {},
		});
		let url = "https://rpc.example/";
		const indexer = createIndexer({
			store,
			rpc: async (network) => clients.client(network, { url, headers: {} }),
			networks: () => [LOCAL_USDC],
		});
		expect((await indexer.pass("anvil-usdc")).failed).toBeUndefined();
		expect((await indexer.pass("anvil-usdc")).failed).toBeUndefined();
		expect(right.calls.filter((call) => call.method === "eth_chainId")).toHaveLength(1);
		url = "https://wrong.example/";
		const status = await indexer.pass("anvil-usdc");
		expect(status.failed?.reason).toMatch(/chain/);
		expect(wrong.calls.map((call) => call.method)).toEqual(["eth_chainId"]);
	});

	it.each([
		["a path", "https://rpc.example/base_sepolia", "https://rpc.example/base"],
		["a query", "https://rpc.example/ogrpc?network=base-sepolia", "https://rpc.example/ogrpc?network=base"],
	])(
		"checks the chain again for an RPC that only %s tells apart, which both show alike (H-187)",
		async (_, good, bad) => {
			const store = await open(await tempHome());
			const wallet = addressOf();
			await addWallets(store, [wallet]);
			const right = new Chain();
			const wrong = new Chain();
			wrong.chainId = 8453;
			for (const chain of [right, wrong]) {
				chain.head = 10;
				chain.final = 10;
			}
			wrong.pay({ from: addressOf(), to: wallet, value: 5n, block: 4 });
			const clients = rpcClients({
				fetch: (url, init) => (String(url) === bad ? wrong.fetch(url, init) : right.fetch(url, init)),
				retries: 0,
				sleep: async () => {},
			});
			let url = good;
			const indexer = createIndexer({
				store,
				rpc: async (network) => clients.client(network, { url, headers: {} }),
				networks: () => [LOCAL_USDC],
			});
			expect((await indexer.pass("anvil-usdc")).failed).toBeUndefined();
			const shown = clients.client(LOCAL_USDC, { url: good, headers: {} }).shown;
			expect(clients.client(LOCAL_USDC, { url: bad, headers: {} }).shown).toBe(shown);
			url = bad;
			const status = await indexer.pass("anvil-usdc");
			expect(status.failed).toMatchObject({ reason: expect.stringMatching(/chain/), otherChain: true });
			// the other chain was asked its id and nothing else: none of its money is kept as this network's
			expect(wrong.calls.map((call) => call.method)).toEqual(["eth_chainId"]);
			expect(Object.values((await incoming(store)).rows)).toEqual([]);
			// back to the right RPC: read again, and the chain no longer said wrong
			url = good;
			expect((await indexer.pass("anvil-usdc")).failed).toBeUndefined();
		},
	);

	it("dates a failure from the first pass through the RPC set now, not one through the RPC before it (H-208)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const wrong = new Chain();
		wrong.chainId = 8453;
		wrong.head = 10;
		wrong.final = 10;
		const clients = rpcClients({
			fetch: (url, init) => {
				if (String(url) === "http://down.test/") throw new TypeError("fetch failed");
				return wrong.fetch(url, init);
			},
			retries: 0,
			sleep: async () => {},
		});
		let url: string | undefined;
		let clock = 1_000;
		const indexer = createIndexer({
			store,
			rpc: async (network) => {
				if (url === undefined) throw new Error("no RPC is set for the network");
				return clients.client(network, { url, headers: {} });
			},
			networks: () => [LOCAL_USDC],
			now: () => clock,
		});
		// no RPC set: the passes stop short from the first
		expect((await indexer.pass("anvil-usdc")).failed?.since).toBe(1_000);
		clock = 2_000;
		expect((await indexer.pass("anvil-usdc")).failed?.since).toBe(1_000);
		// an RPC set since that does not answer: its own since, kept while it is the one asked
		url = "http://down.test/";
		clock = 3_000;
		expect((await indexer.pass("anvil-usdc")).failed?.since).toBe(3_000);
		clock = 4_000;
		expect((await indexer.pass("anvil-usdc")).failed?.since).toBe(3_000);
		// one of another chain: it answers, and what it is said to fail since is no older than it
		url = "http://wrong.test/";
		clock = 5_000;
		expect((await indexer.pass("anvil-usdc")).failed).toMatchObject({ otherChain: true, since: 5_000 });
	});

	it("leaves the blocks a wallet had code in unread, even once its code is gone (H-157)", async () => {
		const home = await tempHome();
		const store = await open(home);
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 100;
		chain.final = 100;
		// an EIP-7702 delegation until block 110, which clears it and so moves the nonce
		chain.codeAt = (address, block) =>
			address === wallet.toLowerCase() && block < 110 ? `0xef0100${"ab".repeat(20)}` : undefined;
		chain.set(wallet, 40, 5n);
		const status = await fauxIndexer(chain, store).pass("anvil");
		expect(status.gaps).toEqual([{ wallet: checksummed(wallet), from: 1, to: 100, why: "code" }]);
		expect((await incoming(store)).rows).toEqual({});
		// the code gone at the head: the blocks it was there in stay unread, and what came after is read
		chain.head = 120;
		chain.final = 120;
		chain.set(wallet, 110, 5n, 1n);
		chain.set(wallet, 115, 9n, 1n);
		const indexer = fauxIndexer(chain, store);
		const gap = { wallet: checksummed(wallet), from: 1, to: 110, why: "code" };
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		expect(Object.values((await incoming(store)).rows)).toEqual([
			{ wallet: checksummed(wallet), asset: "native", amount: "4", block: 115 },
		]);
		// tried again once below the cursor, then not asked again: a final block keeps the code it had (H-198)
		chain.head = 130;
		chain.final = 130;
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		chain.calls.length = 0;
		chain.head = 140;
		chain.final = 140;
		expect((await indexer.pass("anvil")).gaps).toEqual([gap]);
		const below = chain.calls.filter(
			(call) =>
				["eth_getBalance", "eth_getTransactionCount", "eth_getCode"].includes(call.method) &&
				Number(call.params[1]) < 130,
		);
		expect(below).toEqual([]);
	});

	it("leaves unread a stretch a wallet had code in mid-range, with none at either end (H-157)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 100;
		chain.final = 100;
		// delegated in block 30 and cleared in block 60, each moving the nonce; while delegated, 7 arrived and the
		// delegate sent 7 on in block 45, which neither the balance nor the nonce shows. The block that sets the
		// delegation is unread too: its transaction runs the delegate code in it
		chain.codeAt = (address, block) =>
			address === wallet.toLowerCase() && block >= 30 && block < 60 ? `0xef0100${"ab".repeat(20)}` : undefined;
		chain.set(wallet, 20, 10n);
		chain.set(wallet, 30, 10n, 1n);
		chain.set(wallet, 60, 10n, 2n);
		chain.set(wallet, 70, 13n, 2n);
		const status = await fauxIndexer(chain, store).pass("anvil");
		expect(status.gaps).toEqual([{ wallet: checksummed(wallet), from: 30, to: 60, why: "code" }]);
		expect(Object.values((await incoming(store)).rows)).toEqual([
			{ wallet: checksummed(wallet), asset: "native", amount: "10", block: 20 },
			{ wallet: checksummed(wallet), asset: "native", amount: "3", block: 70 },
		]);
	});

	it("takes only a node's word that it keeps no state for a gap: a timeout ends the pass, and the next reads it (H-215)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 1000;
		chain.final = 1000;
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil");
		chain.head = 2000;
		chain.final = 2000;
		chain.set(wallet, 1001, 5n);
		let once = true;
		chain.refuse = (method, params) => {
			if (!once || method !== "eth_getBalance" || Number(params[1]) !== 1000) return undefined;
			once = false;
			return new Response(
				JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "request timed out" } }),
			);
		};
		const short = await indexer.pass("anvil");
		expect(short.failed?.reason).toMatch(/request timed out/);
		expect(short.gaps).toEqual([]);
		expect((await incoming(store)).cursors.anvil).toBe(1000);
		chain.head = 2100;
		chain.final = 2100;
		expect((await indexer.pass("anvil")).gaps).toEqual([]);
		expect(Object.values((await incoming(store)).rows)).toEqual([
			{ wallet: checksummed(wallet), asset: "native", amount: "5", block: 1001 },
		]);
	});

	it("asks the RPC nothing for own spends the store says nothing of, however many (H-198, H-210)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet], networkNamed("anvil"));
		const chain = new Chain();
		chain.chainId = 31337;
		chain.head = 300;
		chain.final = 300;
		chain.set(wallet, 0, 1_000n);
		for (let i = 1; i <= 20; i++) chain.set(wallet, i * 10, 1_000n - BigInt(i) * 10n, BigInt(i));
		const indexer = fauxIndexer(chain, store);
		expect((await indexer.pass("anvil")).gaps).toHaveLength(20);
		chain.calls.length = 0;
		chain.head = 310;
		chain.final = 310;
		expect((await indexer.pass("anvil")).gaps).toHaveLength(20);
		const state = chain.calls.filter(
			(call) => call.method === "eth_getBalance" || call.method === "eth_getTransactionCount",
		);
		expect(state.filter((call) => Number(call.params[1]) < 300)).toEqual([]);
		expect(state.length).toBeLessThanOrEqual(4);
	});

	it("gives each wallet's balances as read at the head, dated (C11, H-198)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 30;
		chain.final = 20;
		chain.set(wallet, 5, 42n, 2n);
		chain.tokens.set(wallet.toLowerCase(), 7_000_000n);
		const indexer = fauxIndexer(chain, store, { now: () => 5_000 });
		const status = await indexer.pass("anvil-usdc");
		expect(status.balances).toEqual({
			[checksummed(wallet)]: { native: "42", usdc: "7000000", nonce: 2, code: false, block: 30, at: 5_000 },
		});
		// a failed pass keeps the reading before it, with its block and time
		chain.refuse = () => new Response("down", { status: 500 });
		expect((await indexer.pass("anvil-usdc")).balances).toEqual(status.balances);
	});

	it("tells the open screens of a moved balance at once, and of a read that only moved its time now and then", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 30;
		chain.final = 20;
		chain.set(wallet, 5, 42n, 2n);
		let clock = 5_000;
		const told: string[] = [];
		const indexer = fauxIndexer(chain, store, { now: () => clock, onChange: (network) => told.push(network) });
		await indexer.pass("anvil-usdc");
		// the first balance at once, then the history read behind it
		expect(told).toEqual(["anvil-usdc", "anvil-usdc"]);
		// the same again, read later: nothing to tell until the screens were last told FRESHNESS ago
		clock += FRESHNESS / 2;
		chain.head = 31;
		await indexer.pass("anvil-usdc");
		expect(told).toHaveLength(2);
		clock += FRESHNESS / 2;
		chain.head = 32;
		await indexer.pass("anvil-usdc");
		expect(told).toHaveLength(3);
		// a pass that fails is told, for why it stopped short; failing again, its time did not move, so it tells nothing
		clock += FRESHNESS;
		chain.refuse = () => new Response("down", { status: 500 });
		await indexer.pass("anvil-usdc");
		expect(told).toHaveLength(4);
		await indexer.pass("anvil-usdc");
		expect(told).toHaveLength(4);
		chain.refuse = undefined;
		// a balance that moved is told at once
		clock += 1;
		chain.head = 33;
		chain.set(wallet, 33, 50n, 2n);
		await indexer.pass("anvil-usdc");
		expect(told).toHaveLength(5);
	});

	it("gives a token balance no contract answered for as unknown, never zero (H-208)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 30;
		chain.final = 20;
		chain.set(wallet, 5, 42n);
		const empty: typeof fetch = async (url, init) => {
			const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
			return method === "eth_call"
				? new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x" }))
				: chain.fetch(url, init);
		};
		const clients = rpcClients({ fetch: empty, retries: 0, sleep: async () => {}, rate: 1e6, burst: 1e6 });
		const status = await createIndexer({
			store,
			rpc: async (network) => clients.client(network, RPC),
			networks: () => [LOCAL_USDC],
			now: () => 5_000,
		}).pass("anvil-usdc");
		expect(status.balances).toEqual({
			[checksummed(wallet)]: { native: "42", usdc: null, nonce: 0, code: false, block: 30, at: 5_000 },
		});
	});

	/**
	 * An indexer over a faux RPC that holds each pass at its head read until the test lets it go, and counts the passes
	 * begun: each begins by reading `Wallets`, at once, so a pass that a microtask begins is counted once the tasks
	 * queued before a macrotask have run.
	 */
	async function heldIndexer() {
		const store = await open(await tempHome());
		await addWallets(store, [addressOf()]);
		const chain = new Chain();
		chain.head = 10;
		chain.final = 10;
		const gates: (() => void)[] = [];
		const held: typeof fetch = async (url, init) => {
			if (JSON.parse(String(init?.body)).method === "eth_blockNumber")
				await new Promise<void>((resolve) => gates.push(resolve));
			return chain.fetch(url, init);
		};
		let begun = 0;
		const counted: Pick<Harness, "commit" | "snapshot"> = {
			commit: store.commit.bind(store),
			snapshot: ((...args: unknown[]) => {
				if (args[0] === (Wallets as unknown)) begun++;
				return (store.snapshot as (...all: unknown[]) => unknown).apply(store, args);
			}) as Harness["snapshot"],
		};
		const clients = rpcClients({ fetch: held, retries: 0, sleep: async () => {} });
		const indexer = createIndexer({
			store: counted,
			rpc: async (network) => clients.client(network, RPC),
			networks: () => [LOCAL_USDC],
		});
		const drained = () => new Promise((resolve) => setImmediate(resolve));
		return { chain, indexer, gates, begun: () => begun, drained };
	}

	it("merges wakes: one more pass after the running one, however many came", async () => {
		const { indexer, gates, begun, drained } = await heldIndexer();
		// a wake before start reads too; the wakes while it runs are one pass after it
		indexer.wake("anvil-usdc");
		await expect.poll(() => gates.length).toBe(1);
		for (let i = 0; i < 10; i++) indexer.wake("anvil-usdc");
		gates[0]?.();
		await expect.poll(() => gates.length).toBe(2);
		expect(begun()).toBe(2);
		// the second pass, still held, is the one a pass asked for now joins
		const second = indexer.pass("anvil-usdc");
		gates[1]?.();
		expect((await second).failed).toBeUndefined();
		await drained();
		expect(begun()).toBe(2);
		await indexer.stop();
		indexer.wake("anvil-usdc");
		await drained();
		expect(begun()).toBe(2);
	});

	it("stops after the passes it saw: a wake just before stop begins none", async () => {
		const { chain, indexer, gates, begun, drained } = await heldIndexer();
		indexer.wake("anvil-usdc");
		await indexer.stop();
		await drained();
		expect(begun()).toBe(0);
		expect(chain.calls).toEqual([]);
		// and a stop while a pass is held resolves only once it has settled
		indexer.start();
		await expect.poll(() => gates.length).toBe(1);
		let stopped = false;
		const stopping = indexer.stop().then(() => {
			stopped = true;
		});
		await drained();
		expect(stopped).toBe(false);
		gates[0]?.();
		await stopping;
		expect(indexer.status("anvil-usdc")?.head).toBe(10);
		const calls = chain.calls.length;
		await drained();
		expect(chain.calls.length).toBe(calls);
		expect(begun()).toBe(1);
	});

	it("drops the rows of a wallet that is gone, and runs one pass at a time", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		const indexer = fauxIndexer(chain, store);
		await indexer.pass("anvil-usdc");
		chain.head = 20;
		chain.final = 20;
		chain.pay({ from: addressOf(), to: wallet, value: 1n, block: 10 });
		const [one, two] = [indexer.pass("anvil-usdc"), indexer.pass("anvil-usdc")];
		expect(one).toBe(two);
		await one;
		expect(Object.keys((await incoming(store)).rows)).toHaveLength(1);
		await store.commit(async (tx) => {
			delete (await tx.doc(Wallets)).wallets[checksummed(wallet)];
		}, context);
		chain.calls.length = 0;
		chain.head = 21;
		await indexer.pass("anvil-usdc");
		expect((await incoming(store)).rows).toEqual({});
		expect(chain.calls).toEqual([]);
	});

	it("keeps what one network's pass read of a wallet made while another network's pass was under way (C22)", async () => {
		const store = await open(await tempHome());
		const LOCAL = networkNamed("anvil");
		const first = addressOf();
		await addWallets(store, [first], LOCAL);
		const local = new FauxChain(LOCAL.chainId);
		local.head = 50;
		local.final = 40;
		const chain = new Chain();
		chain.head = 50;
		chain.final = 40;
		const made = addressOf();
		const hash = chain.pay({ from: addressOf(), to: made, value: 7n, block: 10 });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		const heldLocal: typeof fetch = async (url, init) => {
			if (!held && (JSON.parse(String(init?.body)) as { method: string }).method === "eth_getBalance") {
				held = true;
				await gate;
			}
			return local.fetch(url, init);
		};
		const options = { retries: 0, sleep: async () => {}, rate: 1e6, burst: 1e6 };
		const clients = {
			[LOCAL.id]: rpcClients({ fetch: heldLocal, ...options }),
			[LOCAL_USDC.id]: rpcClients({ fetch: chain.fetch, ...options }),
		};
		const indexer = createIndexer({
			store,
			rpc: async (network) => (clients[network.id] ?? clients[LOCAL_USDC.id]).client(network, RPC),
			networks: () => [LOCAL, LOCAL_USDC],
		});
		// the local network's pass took its snapshot of the wallets, and waits on its RPC
		const passing = indexer.pass(LOCAL.id);
		await until(async () => (held ? true : undefined));
		await addWallets(store, [made]);
		await indexer.pass(LOCAL_USDC.id);
		expect((await incoming(store)).rows[incomingKey(hash, 0)]?.wallet).toBe(checksummed(made));
		const read = (await incoming(store)).read?.[checksummed(made)];
		expect(read).toBeDefined();
		release();
		await passing;
		// the local pass's commits leave the other network's wallet as it was read
		expect((await incoming(store)).rows[incomingKey(hash, 0)]?.wallet).toBe(checksummed(made));
		expect((await incoming(store)).read?.[checksummed(made)]).toBe(read);
	});

	it("says why the head's state was refused, in the node's words, naming no secret of the RPC (H-183, H-207)", async () => {
		const store = await open(await tempHome());
		await addWallets(store, [addressOf()]);
		const chain = new Chain();
		chain.head = 50;
		chain.final = 40;
		chain.stateFrom = 100;
		const clients = rpcClients({ fetch: chain.fetch, retries: 0, sleep: async () => {} });
		const indexer = createIndexer({
			store,
			rpc: async (network) => clients.client(network, { url: "https://rpc.example/key-0123456789abcdef", headers: {} }),
			networks: () => [LOCAL_USDC],
			now: () => 7_000,
		});
		const status = await indexer.pass("anvil-usdc");
		expect(status.failed?.reason).toMatch(/missing trie node/);
		expect(status.failed?.reason).not.toMatch(/0123456789abcdef/);
		expect(status.failed?.at).toBe(7_000);
		expect((await incoming(store)).cursors).toEqual({});
	});

	it("says why a pass stopped, naming no secret of the RPC", async () => {
		const store = await open(await tempHome());
		await addWallets(store, [addressOf()]);
		const chain = new Chain();
		chain.refuse = () => new Response("down", { status: 500 });
		const clients = rpcClients({ fetch: chain.fetch, retries: 0, sleep: async () => {} });
		const indexer = createIndexer({
			store,
			rpc: async (network) => clients.client(network, { url: "https://rpc.example/key-0123456789abcdef", headers: {} }),
			networks: () => [LOCAL_USDC],
		});
		const status = await indexer.pass("anvil-usdc");
		expect(status.failed?.reason).toMatch(/HTTP 500/);
		expect(status.failed?.reason).not.toMatch(/0123456789abcdef/);
	});

	it("runs one timer at a time, however start and stop interleave with a turn (H-198)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { indexer, gates, begun, drained } = await heldIndexer();
			indexer.start();
			await expect.poll(() => gates.length).toBe(1);
			// stopped and started again while the first turn waits on its pass
			const stopping = indexer.stop();
			indexer.start();
			gates[0]?.();
			await stopping;
			await expect.poll(() => gates.length).toBe(2);
			gates[1]?.();
			await expect.poll(() => indexer.status("anvil-usdc")?.head).toBe(10);
			await drained();
			// two timers would both fire now, and the second, finding a pass running, would ask for one more after it
			for (let turn = 2; turn < 4; turn++) {
				await vi.advanceTimersByTimeAsync(40_000);
				await expect.poll(() => gates.length).toBe(turn + 1);
				gates[turn]?.();
				await expect.poll(() => begun()).toBe(turn + 1);
				await drained();
				await vi.advanceTimersByTimeAsync(0);
				expect(gates.length).toBe(turn + 1);
			}
			await indexer.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads every 2 s while a screen looks at a network, and every 40 s again once its look lapses (stack.md section 7)", async () => {
		const store = await open(await tempHome());
		await addWallets(store, [addressOf()]);
		const chain = new Chain();
		chain.head = 10;
		chain.final = 10;
		let busy = 0;
		const track = async <T>(work: Promise<T>): Promise<T> => {
			busy++;
			try {
				return await work;
			} finally {
				busy--;
			}
		};
		let begun = 0;
		const counted: Pick<Harness, "commit" | "snapshot"> = {
			commit: ((...args: unknown[]) =>
				track((store.commit as (...all: unknown[]) => Promise<unknown>).apply(store, args))) as Harness["commit"],
			snapshot: ((...args: unknown[]) => {
				if (args[0] === (Wallets as unknown)) begun++;
				return track((store.snapshot as (...all: unknown[]) => Promise<unknown>).apply(store, args));
			}) as Harness["snapshot"],
		};
		const clients = rpcClients({
			fetch: (url, init) => track(chain.fetch(url, init)),
			retries: 0,
			sleep: async () => {},
			rate: 1e6,
			burst: 1e6,
		});
		let clock = 0;
		const indexer = createIndexer({
			store: counted,
			rpc: async (network) => clients.client(network, RPC),
			networks: () => [LOCAL_USDC],
			now: () => clock,
		});
		const settled = () =>
			expect
				.poll(async () => {
					await new Promise((resolve) => setImmediate(resolve));
					return busy;
				})
				.toBe(0);
		/** `ms` pass on both clocks, a second at a time, each second's passes run to their end. */
		const elapse = async (ms: number) => {
			for (let at = 0; at < ms; at += 1_000) {
				clock += 1_000;
				await vi.advanceTimersByTimeAsync(1_000);
				await settled();
			}
		};
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			indexer.start();
			await settled();
			expect(begun).toBe(1);
			// nobody looks: the next read is the slow one
			await elapse(20_000);
			expect(begun).toBe(1);
			// a wallet's screen opens at 20 s: a read every 2 s for the 15 s its look lasts, at 22 s to 34 s
			indexer.looking("anvil-usdc");
			await elapse(20_000);
			expect(begun).toBe(1 + 7 + 1);
			// the slow read came at 40 s; past the look, none until 80 s
			await elapse(39_000);
			expect(begun).toBe(9);
			await elapse(1_000);
			expect(begun).toBe(10);
			// a screen kept open renews its look: the fast reads go on past the first 15 s
			indexer.looking("anvil-usdc");
			for (let renewed = 0; renewed < 4; renewed++) {
				await elapse(5_000);
				indexer.looking("anvil-usdc");
			}
			expect(begun).toBe(10 + 10);
			await indexer.stop();
			await elapse(10_000);
			expect(begun).toBe(20);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads on its own once started, and again when woken", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const chain = new Chain();
		chain.head = 10;
		chain.final = 10;
		const indexer = fauxIndexer(chain, store, { intervalMs: 60_000 });
		indexer.start();
		await expect.poll(() => indexer.status("anvil-usdc")?.head).toBe(10);
		chain.head = 20;
		chain.final = 20;
		chain.pay({ from: addressOf(), to: wallet, value: 3n, block: 15 });
		indexer.wake("anvil-usdc");
		await expect.poll(async () => Object.keys((await incoming(store)).rows).length).toBe(1);
		await indexer.stop();
	});
});

/**
 * A token that emits `Transfer(calldata[0:32], calldata[32:64], calldata[64:96])` for anyone who calls it, etched at
 * the pinned USDC address and at one that is not: enough for the indexer, which reads logs and never a balance.
 */
const EMITTER = `0x604035600052${"6020356000357f"}${TRANSFER.slice(2)}60206000a300`;
/** Forwards `msg.value` to the address in calldata[0:32]: ETH that arrives by an internal call, with no log. */
const FORWARDER = "0x6000600060006000346000355af100";
/** `SELFDESTRUCT(calldata[0:32])`: ETH that arrives by a contract's self-destruct, with no call and no log. */
const KILLER = "0x600035ff";

const anvilHere = hasAnvil();
if (!anvilHere) it.skip(NO_ANVIL, () => {});

describe.skipIf(!anvilHere)("on anvil", () => {
	let anvil: Anvil;
	const FAKE = addressOf();
	const PIPE = addressOf();
	const KILL = addressOf();
	beforeAll(async () => {
		// finalized is 4 blocks behind the head (docs/wallets/spikes/gaps, A)
		anvil = await startAnvil(["--chain-id", String(LOCAL_USDC.chainId), "--slots-in-an-epoch", "2"]);
		for (const [at, code] of [
			[TOKEN, EMITTER],
			[FAKE, EMITTER],
			[PIPE, FORWARDER],
			[KILL, KILLER],
		] as const) {
			const set = await anvil.raw("anvil_setCode", [at, code]);
			expect(set.error).toBeUndefined();
		}
	});
	afterAll(async () => {
		await anvil?.stop();
	});

	const send = async (tx: { to: string; value?: bigint; data?: string }) => {
		const sent = await anvil.raw("eth_sendTransaction", [
			{
				from: DEV0.address,
				to: tx.to,
				...(tx.value === undefined ? {} : { value: hex(tx.value) }),
				...(tx.data === undefined ? {} : { data: tx.data }),
			},
		]);
		if (sent.error !== undefined) throw new Error(sent.error.message);
		const mined = await until(
			async () =>
				(await anvil.raw("eth_getTransactionReceipt", [sent.result])).result as { blockNumber: string } | null,
		);
		return { hash: String(sent.result), block: Number(mined.blockNumber) };
	};
	const transfer = (token: string, from: string, to: string, value: bigint) =>
		send({ to: token, data: `0x${word(from)}${word(to)}${word(value)}` });
	const mine = (blocks: number) => anvil.raw("anvil_mine", [hex(blocks)]);
	const anvilIndexer = (store: Harness) => {
		const clients = rpcClients();
		return createIndexer({
			store,
			rpc: async (network) => clients.client(network, { url: anvil.url, headers: {} }),
			networks: () => [LOCAL_USDC],
		});
	};

	it("lists USDC and ETH that arrived, dedups a range read twice, and resumes after a restart", async () => {
		const home = await tempHome();
		let store = await open(home);
		const wallet = addressOf();
		const sender = addressOf();
		await addWallets(store, [wallet]);
		await anvilIndexer(store).pass("anvil-usdc");
		await mine(10);
		const usdc = await transfer(TOKEN, sender, wallet, 2_500_000n);
		await transfer(FAKE, sender, wallet, 1_000_000n);
		await transfer(TOKEN, sender, wallet, 0n);
		await transfer(TOKEN, wallet, addressOf(), 7n);
		const direct = await send({ to: wallet, value: 10n ** 18n });
		await mine(20);
		const forwarded = await send({ to: PIPE, value: 10n ** 17n, data: `0x${word(wallet)}` });
		await mine(10);
		const destructed = await send({ to: KILL, value: 10n ** 16n, data: `0x${word(wallet)}` });
		await mine(10);
		const indexer = anvilIndexer(store);
		const status = await indexer.pass("anvil-usdc");
		expect(status.gaps).toEqual([]);
		const expected = {
			[incomingKey(usdc.hash, 0)]: {
				wallet: checksummed(wallet),
				asset: "usdc",
				amount: "2500000",
				from: sender,
				block: usdc.block,
			},
			[nativeKey(wallet, direct.block)]: {
				wallet: checksummed(wallet),
				asset: "native",
				amount: (10n ** 18n).toString(),
				block: direct.block,
			},
			[nativeKey(wallet, forwarded.block)]: {
				wallet: checksummed(wallet),
				asset: "native",
				amount: (10n ** 17n).toString(),
				block: forwarded.block,
			},
			[nativeKey(wallet, destructed.block)]: {
				wallet: checksummed(wallet),
				asset: "native",
				amount: (10n ** 16n).toString(),
				block: destructed.block,
			},
		};
		expect((await incoming(store)).rows).toEqual(expected);
		await indexer.pass("anvil-usdc");
		expect((await incoming(store)).rows).toEqual(expected);
		const cursor = (await incoming(store)).cursors["anvil-usdc"] ?? 0;
		expect(cursor).toBe(status.head === undefined ? -1 : status.head - 4);
		await store.close(context);
		opened.splice(opened.indexOf(store), 1);
		store = await open(home);
		const later = await transfer(TOKEN, sender, wallet, 1n);
		await mine(5);
		await anvilIndexer(store).pass("anvil-usdc");
		const rows = (await incoming(store)).rows;
		expect(Object.keys(rows)).toHaveLength(5);
		expect(rows[incomingKey(later.hash, 0)]?.amount).toBe("1");
	});

	it("deletes a Received row that a reorg took away (H-213)", async () => {
		const store = await open(await tempHome());
		const wallet = addressOf();
		await addWallets(store, [wallet]);
		const indexer = anvilIndexer(store);
		await indexer.pass("anvil-usdc");
		const paid = await transfer(TOKEN, addressOf(), wallet, 9n);
		await indexer.pass("anvil-usdc");
		const before = await incoming(store);
		expect(before.rows[incomingKey(paid.hash, 0)]).toBeDefined();
		expect(incomingConfirmed({ block: paid.block }, before.cursors, "anvil-usdc")).toBe(false);
		const reorg = await anvil.raw("anvil_reorg", [1, []]);
		expect(reorg.error).toBeUndefined();
		await indexer.pass("anvil-usdc");
		expect((await incoming(store)).rows).toEqual({});
	});
});
