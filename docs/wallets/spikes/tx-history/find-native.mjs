// Helper (not part of the answer): find EOAs on Base Sepolia that send ETH often (faucets) and their recipients.
import { SEPOLIA_RPC, call, hex } from "./lib.mjs";
const head = Number(await call(SEPOLIA_RPC, "eth_blockNumber"));
const senders = new Map(); const recips = new Map();
for (let b = head - 300; b <= head; b += 3) {
	const blk = await call(SEPOLIA_RPC, "eth_getBlockByNumber", [hex(b), true]);
	for (const tx of blk.transactions) {
		if (BigInt(tx.value) > 0n && tx.to && tx.type !== "0x7e") {
			senders.set(tx.from, (senders.get(tx.from) ?? 0) + 1);
			recips.set(tx.to, (recips.get(tx.to) ?? 0) + 1);
		}
	}
}
console.log("senders", [...senders].sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log("recipients", [...recips].sort((a, b) => b[1] - a[1]).slice(0, 8));
