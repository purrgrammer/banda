// Q: does balance bisection work against the public Base Sepolia RPC for a real EOA, and does it agree with
// Blockscout's feeds (transactions, internal transactions, coin balance history)?
import { explain, bisector } from "./bisect.mjs";
import { SEPOLIA_RPC, blockscout } from "./lib.mjs";

const EOA = (process.argv[2] ?? "0xd2448c6c7d183c4c04cd1f40705ff323954820e4").toLowerCase();
const LO = Number(process.argv[3] ?? 62583800);
const HI = Number(process.argv[4] ?? 62585100);
const URL = process.argv[5] ?? SEPOLIA_RPC;

const bis = bisector(URL);
const t0 = performance.now();
const changes = await bis.changes(EOA, LO, HI);
console.log(`bisection ${URL} over ${HI - LO} blocks: ${changes.length} change blocks, ${bis.requests} state reads, ${Math.round(performance.now() - t0)} ms`);
let explained = 0;
for (const c of changes) {
	const e = await explain(URL, EOA, c);
	if (e.other === 0n) explained++;
	console.log(`  ${e.block}: delta ${e.delta} own ${e.own} (${e.ownTx.length} tx) direct ${e.direct} other ${e.other}`);
}
console.log(`  fully explained by own+direct: ${explained}/${changes.length}`);

// Blockscout, for comparison.
const inRange = (b) => b > LO && b <= HI;
const txs = (await blockscout(`/api/v2/addresses/${EOA}/transactions`)).body.items.filter((t) => inRange(t.block_number));
const itx = (await blockscout(`/api/v2/addresses/${EOA}/internal-transactions`)).body.items.filter((t) => inRange(t.block_number));
const cbh = (await blockscout(`/api/v2/addresses/${EOA}/coin-balance-history`)).body.items.filter((t) => inRange(t.block_number));
const bsBlocks = new Set([...txs.map((t) => t.block_number), ...itx.map((t) => t.block_number)]);
const ours = new Set(changes.map((c) => c.block));
console.log(`\nblockscout: transactions=${txs.length} internal=${itx.length} coin-balance-history points=${cbh.length}`);
console.log(`  blocks in tx+internal feeds=${bsBlocks.size}; bisection-only=${JSON.stringify([...ours].filter((b) => !bsBlocks.has(b)))} feeds-only=${JSON.stringify([...bsBlocks].filter((b) => !ours.has(b)))}`);
const cbhSkipped = [...ours].filter((b) => !cbh.some((p) => p.block_number === b));
console.log(`  change blocks missing from coin-balance-history: ${cbhSkipped.length} ${JSON.stringify(cbhSkipped)}`);
// Each coin-balance-history point's value must equal the bisection's balance at that block.
const balAt = new Map(changes.map((c) => [c.block, c.balance]));
const mism = cbh.filter((p) => balAt.has(p.block_number) && balAt.get(p.block_number) !== BigInt(p.value));
console.log(`  coin-balance-history values disagreeing with chain state: ${mism.length}`);
