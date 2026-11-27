// Balance bisection: every block in (lo, hi] where an address's native balance changed, from eth_getBalance and
// eth_getTransactionCount at past blocks only (needs state for those blocks; no indexer, no traces).
//
// Soundness: an EOA's balance can only go down through a transaction it signs, and each one moves its nonce
// (EIP-7702 delegation, which could let code spend without a nonce move, needs the EOA's own signature and banda
// refuses to sign it). So over a range where the nonce did not move, the balance is non-decreasing, and equal
// balances at both ends mean no change inside. Where the nonce moved, split regardless of the balances.
import { call, hex } from "./lib.mjs";

export function bisector(url) {
	let requests = 0;
	const state = async (addr, b) => {
		requests += 2;
		const [bal, nonce] = await Promise.all([call(url, "eth_getBalance", [addr, hex(b)]), call(url, "eth_getTransactionCount", [addr, hex(b)])]);
		return { bal: BigInt(bal), nonce: Number(nonce) };
	};
	async function walk(addr, lo, hi, sLo, sHi, out) {
		if (sLo.bal === sHi.bal && sLo.nonce === sHi.nonce) return;
		if (hi - lo === 1) {
			out.push({ block: hi, delta: sHi.bal - sLo.bal, ownTxs: sHi.nonce - sLo.nonce, balance: sHi.bal });
			return;
		}
		const mid = lo + Math.floor((hi - lo) / 2);
		const sMid = await state(addr, mid);
		await walk(addr, lo, mid, sLo, sMid, out);
		await walk(addr, mid, hi, sMid, sHi, out);
	}
	return {
		get requests() {
			return requests;
		},
		state,
		/** Change points in (lo, hi], oldest first. */
		async changes(addr, lo, hi) {
			const out = [];
			await walk(addr, lo, hi, await state(addr, lo), await state(addr, hi), out);
			return out;
		},
	};
}

/**
 * Explain one change block from the block's own transactions: own sends (value + fee), direct receipts
 * (tx.to == addr). What is left is native value that arrived some other way (a contract's internal call,
 * SELFDESTRUCT, a deposit's mint): known by block and amount, not by sender.
 */
export async function explain(url, addr, change) {
	const a = addr.toLowerCase();
	const blk = await call(url, "eth_getBlockByNumber", [hex(change.block), true]);
	let own = 0n;
	let direct = 0n;
	const ownTx = [];
	const directTx = [];
	for (const tx of blk.transactions) {
		if (tx.from.toLowerCase() === a) {
			const rc = await call(url, "eth_getTransactionReceipt", [tx.hash]);
			// OP Stack receipts carry l1Fee, and operatorFeeScalar/Constant when the operator fee is on (Jovian:
			// constant + gasUsed * scalar * 100); a plain anvil chain has none of them.
			const operator = rc.operatorFeeConstant != null ? BigInt(rc.operatorFeeConstant) + BigInt(rc.gasUsed) * BigInt(rc.operatorFeeScalar ?? 0) * 100n : 0n;
			const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) + BigInt(rc.l1Fee ?? 0) + operator;
			own -= (rc.status === "0x1" ? BigInt(tx.value) : 0n) + fee;
			ownTx.push(tx.hash);
			if (tx.to?.toLowerCase() === a) own += BigInt(tx.value); // self-send
		} else if (tx.to?.toLowerCase() === a) {
			const rc = await call(url, "eth_getTransactionReceipt", [tx.hash]);
			if (rc.status === "0x1") direct += BigInt(tx.value);
			directTx.push(tx.hash);
		}
	}
	return { ...change, own, direct, other: change.delta - own - direct, ownTx, directTx };
}
