// Q: does what holds on Base Sepolia hold on Base mainnet's public endpoints? Read-only: getLogs range and
// throttling, historical balance (archive) depth. Mainnet USDC 0x8335…2913; no keys, no transactions.
import { call, hex, rpc, sleep, TRANSFER } from "./lib.mjs";
const USDC_MAIN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
for (const url of ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]) {
	const head = Number(await call(url, "eth_blockNumber"));
	console.log(`## ${url} head=${head}`);
	for (const span of [10, 200, 1000, 10000]) {
		const r = await rpc(url, "eth_getLogs", [{ address: USDC_MAIN, fromBlock: hex(head - 100 - span), toBlock: hex(head - 100), topics: [TRANSFER, null, "0x000000000000000000000000a849bbad82f9edafdf9a5550cc874276138779d9"] }]);
		console.log(`  getLogs span ${span}: HTTP ${r.status} ${r.ms} ms ${r.body.result ? `${r.body.result.length} logs` : JSON.stringify(r.body.error ?? r.body).slice(0, 140)} rl=${JSON.stringify(r.rl)}`);
		await sleep(1500);
	}
	for (const back of [1_000, 1_000_000, 20_000_000]) {
		const r = await rpc(url, "eth_getBalance", [WETH, hex(head - back)]);
		console.log(`  getBalance(WETH, head-${back}): HTTP ${r.status} ${r.body.result ?? JSON.stringify(r.body.error ?? r.body).slice(0, 140)}`);
		await sleep(1500);
	}
}
