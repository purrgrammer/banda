/**
 * The process the indexer's fault suite kills (H-212, C22): two wallets on a faux chain every process writes the same,
 * read 100 blocks a commit, with USDC logs, native arrivals and an own spend the store cannot explain at first. Before
 * it reads, each process checks what the last one left: no row the chain does not show, and no cursor ahead of its rows
 * or of its gap. Then it passes until a pass ends with no failure; then the store learns the spend, and it passes again
 * until one ends with no failure, which reads the gap the spend left into its row. Prints a summary as its last line.
 *
 * argv: home, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { context, openStore } from "../../src/core/store.ts";
import { checksummed } from "../../src/wallet/address.ts";
import { Incoming, type IncomingRow, incomingKey, nativeKey, Wallets } from "../../src/wallet/docs.ts";
import { createIndexer } from "../../src/wallet/indexer.ts";
import { networkOf } from "../../src/wallet/networks.ts";
import { rpcClients } from "../../src/wallet/rpc.ts";
import { FauxChain } from "../helpers/faux-chain.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";

const [home, scheduleJson] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
const violations = join(home, "violations.jsonl");
const violated = (what: object) => appendFileSync(violations, `${JSON.stringify(what)}\n`);

const network = networkOf("anvil-usdc", { BANDA_TEST_CHAIN: "1" });
if (network?.usdc === undefined) throw new Error("no anvil-usdc network");
const token = network.usdc.address;
const A = checksummed("0x1111111111111111111111111111111111111111");
const B = checksummed("0x2222222222222222222222222222222222222222");
const SENDER = checksummed("0x3333333333333333333333333333333333333333");

let hashes = 0;
const chain = new FauxChain(network.chainId, () => `0x${(++hashes).toString(16).padStart(64, "0")}`);
chain.head = 600;
chain.final = 550;
const expected: { [key: string]: IncomingRow } = {};
for (const [wallet, block, value] of [
	[A, 40, 1n],
	[B, 140, 2n],
	[A, 333, 3n],
	[B, 499, 4n],
	[A, 580, 5n],
] as const) {
	const hash = chain.log({ token, from: SENDER, to: wallet, value, block });
	expected[incomingKey(hash, 0)] = { wallet, asset: "usdc", amount: String(value), from: SENDER, block };
}
chain.set(A, 120, 10n);
chain.set(B, 260, 7n);
chain.set(B, 470, 9n);
expected[nativeKey(A, 120)] = { wallet: A, asset: "native", amount: "10", block: 120 };
expected[nativeKey(B, 260)] = { wallet: B, asset: "native", amount: "7", block: 260 };
expected[nativeKey(B, 470)] = { wallet: B, asset: "native", amount: "2", block: 470 };
// A spent 8 at 410 and 2 arrived beside it: a gap until the store learns the spend, then a row
chain.set(A, 410, 4n, 1n);
const GAP = { from: 410, to: 410, why: "unexplained" };
const SPENT = nativeKey(A, 410);
expected[SPENT] = { wallet: A, asset: "native", amount: "2", block: 410 };

const store = await openStore(home, {
	models: createModels(),
	registry: createRegistry(),
	wrapStorage: (storage) => faults.storage(storage),
});

// what the process before this one left
{
	const value = await store.snapshot(Incoming, context);
	for (const [key, row] of Object.entries(value?.rows ?? {}))
		if (JSON.stringify(row) !== JSON.stringify(expected[key])) violated({ stray: key, row });
	for (const wallet of [A, B]) {
		const read = value?.read?.[wallet];
		if (read === undefined) continue;
		if (read > (value?.cursors[network.id] ?? -1)) violated({ ahead: wallet, read });
		for (const [key, row] of Object.entries(expected))
			if (key !== SPENT && row.wallet === wallet && row.block <= read && value?.rows[key] === undefined)
				violated({ missing: key, read });
		// past the gap: either it stands and its row is not there, or it was read and its row is
		const gap = value?.gaps?.[A];
		const resolved = gap === undefined && value?.rows[SPENT] !== undefined;
		const standing = JSON.stringify(gap) === JSON.stringify([GAP]) && value?.rows[SPENT] === undefined;
		if (wallet === A && read >= GAP.to && !resolved && !standing) violated({ gap: gap ?? null, read });
	}
}

await store.commit(async (tx) => {
	const doc = await tx.doc(Wallets);
	for (const [wallet, name] of [
		[A, "Groceries"],
		[B, "Travel"],
	] as const)
		doc.wallets[wallet] ??= {
			name,
			network: network.id,
			state: "ready",
			backup: "saved",
			default: "ask",
			disclosed: true,
			request: `r-${name}`,
			version: 1,
			at: 0,
		};
}, context);

const clients = rpcClients({ fetch: chain.fetch, retries: 0, sleep: async () => {}, rate: 1e6, burst: 1e6 });
let learned = false;
const indexer = createIndexer({
	store,
	rpc: async (one) => clients.client(one, { url: "https://rpc.example/", headers: {} }),
	networks: () => [network],
	stepBlocks: 100,
	spent: async (wallet, block) => (learned && wallet === A && block === 410 ? { amount: 8n, nonces: 1 } : undefined),
	hit: (point) => faults.hit(point as FaultPoint),
});
let passes = 0;
for (const phase of [false, true]) {
	learned = phase;
	for (;;) {
		passes++;
		const status = await indexer.pass(network.id);
		if (status.failed === undefined || passes > 40) break;
	}
}
const value = await store.snapshot(Incoming, context);
await store.close(context);
console.log(
	JSON.stringify({
		rows: value?.rows ?? {},
		expected,
		cursors: value?.cursors ?? {},
		read: value?.read ?? {},
		gaps: value?.gaps ?? {},
		violations: existsSync(violations)
			? readFileSync(violations, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as unknown)
			: [],
		points: faults.counts(),
		commits: faults.hits("commit:before"),
	}),
);
