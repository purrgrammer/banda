// Q: can Blockscout's REST v2 on Base Sepolia serve a wallet's tx list keyless? Which feeds, fields, pagination,
// freshness (lag behind the chain head) and rate limits?
import { SEPOLIA_RPC, USDC, blockscout, call, sleep, trim } from "./lib.mjs";

const PAYEE = process.argv[2] ?? "0xA849bbaD82F9edafDf9A5550CC874276138779d9"; // EOA paid by x402 (EIP-3009)
const EOA = process.argv[3] ?? "0xd2448c6c7d183c4c04cd1f40705ff323954820e4"; // EOA with native in/out

// 1. Freshness: Blockscout's newest block vs the RPC head, sampled five times.
console.log("## freshness (rpc head vs blockscout newest block)");
for (let i = 0; i < 5; i++) {
	const [head, bs] = await Promise.all([call(SEPOLIA_RPC, "eth_blockNumber"), blockscout("/api/v2/blocks?type=block")]);
	const top = bs.body.items?.[0];
	const lagBlocks = Number(head) - top.height;
	const ageS = (Date.now() - Date.parse(top.timestamp)) / 1000;
	console.log(`rpc=${Number(head)} blockscout=${top.height} lag=${lagBlocks} blocks (${(lagBlocks * 0.2).toFixed(1)} s) newest-block-age=${ageS.toFixed(1)} s`);
	await sleep(2000);
}
const st = await blockscout("/api/v2/main-page/indexing-status");
console.log("indexing-status:", trim(st.body, 200));

// 2. The three feeds a wallet needs, for one address each.
console.log("\n## feeds");
const feeds = [
	[`token-transfers (payee, to, USDC)`, `/api/v2/addresses/${PAYEE}/token-transfers?type=ERC-20&filter=to&token=${USDC}`],
	[`transactions (eoa)`, `/api/v2/addresses/${EOA}/transactions`],
	[`internal-transactions (eoa)`, `/api/v2/addresses/${EOA}/internal-transactions`],
	[`coin-balance-history (eoa)`, `/api/v2/addresses/${EOA}/coin-balance-history`],
];
for (const [name, path] of feeds) {
	const r = await blockscout(path);
	const items = r.body.items ?? [];
	console.log(`${name}: HTTP ${r.status} ${r.ms} ms rl=${JSON.stringify(r.rl)} items=${items.length} next=${JSON.stringify(r.body.next_page_params)}`);
	if (items[0]) console.log(`  first item keys: ${Object.keys(items[0]).sort().join(",")}`);
	if (name.startsWith("transactions") && items[0])
		console.log(`  e.g. ${trim({ hash: items[0].hash, from: items[0].from.hash, to: items[0].to?.hash, value: items[0].value, fee: items[0].fee, status: items[0].status, result: items[0].result, types: items[0].transaction_types, method: items[0].method, block: items[0].block_number }, 400)}`);
	if (name.startsWith("token") && items[0])
		console.log(`  e.g. ${trim({ tx: items[0].transaction_hash, from: items[0].from.hash, from_scam: items[0].from.is_scam, rep: items[0].token.reputation, value: items[0].total.value, method: items[0].method, block: items[0].block_number, log_index: items[0].log_index }, 400)}`);
	await sleep(400);
}

// 3. Pagination: walk three pages of the payee's USDC transfers, check no duplicates and descending order.
console.log("\n## pagination (3 pages of payee USDC transfers)");
let q = `/api/v2/addresses/${PAYEE}/token-transfers?type=ERC-20&filter=to&token=${USDC}`;
const seen = new Set();
let last = Infinity;
let ordered = true;
for (let p = 0; p < 3; p++) {
	const r = await blockscout(q);
	for (const it of r.body.items) {
		const k = `${it.transaction_hash}:${it.log_index}`;
		if (seen.has(k)) console.log("  duplicate", k);
		seen.add(k);
		if (it.block_number > last) ordered = false;
		last = it.block_number;
	}
	const np = r.body.next_page_params;
	console.log(`  page ${p}: ${r.body.items.length} items, next=${JSON.stringify(np)}`);
	if (!np) break;
	q = `/api/v2/addresses/${PAYEE}/token-transfers?type=ERC-20&filter=to&token=${USDC}&${new URLSearchParams(np)}`;
	await sleep(400);
}
console.log(`  unique=${seen.size} descending=${ordered}`);

// 4. Rate limit: 60 requests, 20 at a time, to one cheap endpoint.
console.log("\n## rate limit (60 requests, 20 concurrent)");
const codes = {};
let lastRl = {};
for (let w = 0; w < 3; w++) {
	const rs = await Promise.all(Array.from({ length: 20 }, () => blockscout(`/api/v2/addresses/${EOA}/counters`)));
	for (const r of rs) {
		codes[r.status] = (codes[r.status] ?? 0) + 1;
		lastRl = r.rl;
	}
}
console.log(`  statuses=${JSON.stringify(codes)} last headers=${JSON.stringify(lastRl)}`);
