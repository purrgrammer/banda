// Q: could the daemon hide its addresses from the RPC by fetching every USDC Transfer and filtering locally?
// Volume of unfiltered USDC Transfer logs per block, Base mainnet (read-only) and Base Sepolia.
import { TRANSFER, USDC, call, hex, rpc } from "./lib.mjs";
for (const [url, usdc] of [["https://base-rpc.publicnode.com", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], ["https://sepolia.base.org", USDC]]) {
	const head = Number(await call(url, "eth_blockNumber"));
	const span = 50;
	const r = await rpc(url, "eth_getLogs", [{ address: usdc, fromBlock: hex(head - 100 - span + 1), toBlock: hex(head - 100), topics: [TRANSFER] }]);
	const n = r.body.result?.length;
	const bytes = JSON.stringify(r.body).length;
	console.log(`${url}: ${n} USDC Transfer logs in ${span} blocks (${(n / span).toFixed(1)}/block, ~${Math.round((n / span) * 432000).toLocaleString()}/day at 5 blocks/s), ${bytes} bytes, ${r.ms} ms`);
}
