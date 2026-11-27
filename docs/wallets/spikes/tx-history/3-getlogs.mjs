// Q: can the daemon index its own USDC history with eth_getLogs on a public Base Sepolia RPC?
// Max block range, rate limits, agreement with Blockscout, zero-value (poisoning) transfers, and matching an
// EIP-3009 (x402) payment to its AuthorizationUsed event.
import { AUTH_USED, SEPOLIA_RPC, TRANSFER, USDC, blockscout, call, hex, rpc, sleep, topicAddr } from "./lib.mjs";

const PAYEE = process.argv[2] ?? "0xA849bbaD82F9edafDf9A5550CC874276138779d9";
const ENDPOINTS = [SEPOLIA_RPC, "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org"];
const head = Number(await call(SEPOLIA_RPC, "eth_blockNumber"));
const logs = (url, from, to, topics, address = USDC) => rpc(url, "eth_getLogs", [{ address, fromBlock: hex(from), toBlock: hex(to), topics }]);

// 1. Largest accepted range per endpoint (narrow filter: transfers to PAYEE), by bisection on to-from.
console.log("## max eth_getLogs range (to - from), narrow filter");
for (const url of ENDPOINTS) {
	let ok = 0;
	let bad = 100_000;
	let lastErr = "";
	const first = await logs(url, head - 100 - bad, head - 100, [TRANSFER, null, topicAddr(PAYEE)]);
	if (first.body.result) {
		console.log(`${url}: accepts ${bad} (HTTP ${first.status}, ${first.body.result.length} logs, ${first.ms} ms)`);
		continue;
	}
	lastErr = JSON.stringify(first.body.error ?? first.body).slice(0, 160);
	while (bad - ok > 1) {
		const mid = Math.floor((ok + bad) / 2);
		const r = await logs(url, head - 100 - mid, head - 100, [TRANSFER, null, topicAddr(PAYEE)]);
		if (r.status === 429) {
			await sleep(1500);
			continue;
		}
		if (r.body.result) ok = mid;
		else {
			bad = mid;
			lastErr = `HTTP ${r.status} ${JSON.stringify(r.body.error ?? r.body).slice(0, 160)}`;
		}
		await sleep(250);
	}
	console.log(`${url}: max range ${ok} (refuses ${bad}: ${lastErr})`);
}

// 2. Rate limit on sepolia.base.org: 40 sequential eth_getLogs, then 20 concurrent.
console.log("\n## rate limit, sepolia.base.org eth_getLogs (200-block narrow ranges)");
const seq = {};
let rl = {};
const t0 = performance.now();
for (let i = 0; i < 40; i++) {
	const r = await logs(SEPOLIA_RPC, head - 300 - i, head - 100 - i, [TRANSFER, null, topicAddr(PAYEE)]);
	const k = r.body.result ? r.status : `${r.status}/${r.body.error?.code}`;
	seq[k] = (seq[k] ?? 0) + 1;
	if (Object.keys(r.rl).length) rl = r.rl;
}
console.log(`  sequential: ${JSON.stringify(seq)} in ${Math.round(performance.now() - t0)} ms, rl headers=${JSON.stringify(rl)}`);
await sleep(3000);
const conc = {};
const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => logs(SEPOLIA_RPC, head - 300 - i, head - 100 - i, [TRANSFER, null, topicAddr(PAYEE)])));
for (const r of rs) {
	const k = r.body.result ? r.status : `${r.status}/${r.body.error?.code}:${r.body.error?.message}`;
	conc[k] = (conc[k] ?? 0) + 1;
	if (Object.keys(r.rl).length) rl = r.rl;
}
console.log(`  20 concurrent: ${JSON.stringify(conc)} rl headers=${JSON.stringify(rl)}`);
await sleep(3000);

// 3. Self-index vs Blockscout: transfers to PAYEE over 2,000 blocks ending 150 blocks behind head.
console.log("\n## self-index vs blockscout (USDC to PAYEE, 2000 blocks, 200-block chunks)");
const to = head - 150;
const from = to - 1999;
const mine = new Map();
let calls = 0;
for (let a = from; a <= to; a += 200) {
	const b = Math.min(a + 199, to);
	const r = await call(SEPOLIA_RPC, "eth_getLogs", [{ address: USDC, fromBlock: hex(a), toBlock: hex(b), topics: [TRANSFER, null, topicAddr(PAYEE)] }]);
	calls++;
	for (const l of r) mine.set(`${l.transactionHash}:${Number(l.logIndex)}`, l);
	await sleep(250);
}
const theirs = new Set();
let q = `/api/v2/addresses/${PAYEE}/token-transfers?type=ERC-20&filter=to&token=${USDC}`;
for (let page = 0; page < 40; page++) {
	const r = await blockscout(q);
	let done = false;
	for (const it of r.body.items) {
		if (it.block_number > to) continue;
		if (it.block_number < from) {
			done = true;
			break;
		}
		theirs.add(`${it.transaction_hash}:${it.log_index}`);
	}
	const np = r.body.next_page_params;
	if (done || !np) break;
	q = `/api/v2/addresses/${PAYEE}/token-transfers?type=ERC-20&filter=to&token=${USDC}&${new URLSearchParams(np)}`;
	await sleep(400);
}
const onlyMine = [...mine.keys()].filter((k) => !theirs.has(k));
const onlyTheirs = [...theirs].filter((k) => !mine.has(k));
console.log(`  rpc logs=${mine.size} (${calls} calls) blockscout=${theirs.size} only-rpc=${onlyMine.length} only-blockscout=${onlyTheirs.length}`);

// 4. Every transfer to PAYEE paid by EIP-3009: is there an AuthorizationUsed(authorizer = Transfer.from) in the same tx?
console.log("\n## x402 matching: Transfer(from=payer) <-> AuthorizationUsed(payer, nonce) in the same tx");
const auth = new Map();
for (let a = from; a <= to; a += 200) {
	const b = Math.min(a + 199, to);
	const r = await call(SEPOLIA_RPC, "eth_getLogs", [{ address: USDC, fromBlock: hex(a), toBlock: hex(b), topics: [AUTH_USED] }]);
	for (const l of r) {
		const k = l.transactionHash;
		if (!auth.has(k)) auth.set(k, []);
		auth.get(k).push(l.topics[1]);
	}
	await sleep(250);
}
let matched = 0;
let unmatched = 0;
let txSenderIsPayer = 0;
const sample = [...mine.values()].slice(0, 5);
for (const l of mine.values()) {
	const payerTopic = l.topics[1];
	if (auth.get(l.transactionHash)?.includes(payerTopic)) matched++;
	else unmatched++;
}
for (const l of sample) {
	const tx = await call(SEPOLIA_RPC, "eth_getTransactionByHash", [l.transactionHash]);
	if (topicAddr(tx.from) === l.topics[1]) txSenderIsPayer++;
}
console.log(`  transfers matched to AuthorizationUsed=${matched} unmatched=${unmatched}; of ${sample.length} sampled, tx.from == payer: ${txSenderIsPayer}`);

// 5. Zero-value USDC transfers (the address-poisoning shape) in the last 1,000 blocks, all senders.
console.log("\n## zero-value USDC Transfer logs, last 1000 blocks (all addresses)");
let total = 0;
let zero = 0;
for (let a = head - 1150; a < head - 150; a += 200) {
	const r = await call(SEPOLIA_RPC, "eth_getLogs", [{ address: USDC, fromBlock: hex(a), toBlock: hex(a + 199), topics: [TRANSFER] }]);
	total += r.length;
	zero += r.filter((l) => BigInt(l.data) === 0n).length;
	await sleep(250);
}
console.log(`  transfers=${total} zero-value=${zero}`);
