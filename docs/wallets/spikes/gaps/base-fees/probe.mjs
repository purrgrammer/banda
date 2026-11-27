// Gap C and E, read-only against Base's public endpoints (no transaction is sent to them):
// C. how far safe and finalized trail latest on Base Sepolia and Base mainnet, in blocks and seconds, and how far the
//    latest block's timestamp is from this machine's clock; that eth_getTransactionCount, eth_getBalance, eth_call
//    and eth_getLogs accept the safe and finalized tags.
// E. what an OP-stack fee looks like in a receipt (the l1Fee fields), whether a sender's balance falls by exactly
//    value + gasUsed x effectiveGasPrice + l1Fee (+ operator fee), and what the GasPriceOracle predeploy answers.
// Third-party addresses are never printed: only counts and field names.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { rpcAt, num, big, DEV0_ADDR } from "../lib.mjs";

const NETS = [
	{ name: "Base Sepolia", url: "https://sepolia.base.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
	{ name: "Base mainnet", url: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
];
const GPO = "0x420000000000000000000000000000000000000F";
const gpoAbi = parseAbi([
	"function getL1FeeUpperBound(uint256) view returns (uint256)", "function getL1Fee(bytes) view returns (uint256)",
	"function isEcotone() view returns (bool)", "function isFjord() view returns (bool)", "function isIsthmus() view returns (bool)",
	"function isJovian() view returns (bool)", "function l1BaseFee() view returns (uint256)", "function blobBaseFee() view returns (uint256)",
	"function baseFeeScalar() view returns (uint32)", "function blobBaseFeeScalar() view returns (uint32)",
	"function getOperatorFee(uint256) view returns (uint256)", "function decimals() view returns (uint256)",
]);
const usdcAbi = parseAbi(["function authorizationState(address,bytes32) view returns (bool)"]);
const TOPIC_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const wall = () => Date.now() / 1000;

for (const net of NETS) {
	const rpc = rpcAt(net.url);
	console.log(`## ${net.name} (${net.url}), read ${new Date().toISOString()}`);
	console.log(`  chain id ${num((await rpc("eth_chainId")).result)}`);
	for (let i = 0; i < 3; i++) {
		const [l, s, f] = await Promise.all(["latest", "safe", "finalized"].map((t) => rpc("eth_getBlockByNumber", [t, false])));
		const w = wall();
		const L = { n: num(l.result.number), t: num(l.result.timestamp) }, S = { n: num(s.result.number), t: num(s.result.timestamp) }, F = { n: num(f.result.number), t: num(f.result.timestamp) };
		console.log(`  sample ${i + 1}: latest - safe = ${L.n - S.n} blocks / ${L.t - S.t} s; latest - finalized = ${L.n - F.n} blocks / ${L.t - F.t} s; wall clock - latest timestamp = ${(w - L.t).toFixed(1)} s`);
		await new Promise((r) => setTimeout(r, 2500));
	}
	const tags = {};
	for (const t of ["safe", "finalized"]) {
		tags[`eth_getTransactionCount(${t})`] = (await rpc("eth_getTransactionCount", [DEV0_ADDR, t])).error?.message ?? "accepted";
		tags[`eth_getBalance(${t})`] = (await rpc("eth_getBalance", [DEV0_ADDR, t])).error?.message ?? "accepted";
		const c = await rpc("eth_call", [{ to: net.usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: "authorizationState", args: [DEV0_ADDR, `0x${"00".repeat(32)}`] }) }, t]);
		tags[`eth_call authorizationState(${t})`] = c.error?.message ?? `accepted (${decodeFunctionResult({ abi: usdcAbi, functionName: "authorizationState", data: c.result })})`;
	}
	const fin = num((await rpc("eth_getBlockByNumber", ["finalized", false])).result.number);
	for (const span of [100, 1000, 10000]) {
		const g = await rpc("eth_getLogs", [{ address: net.usdc, topics: [TOPIC_USED], fromBlock: `0x${(fin - span).toString(16)}`, toBlock: "finalized" }]);
		tags[`eth_getLogs AuthorizationUsed, ${span} blocks to finalized`] = g.error ? `${g.error.code} ${g.error.message}` : `accepted, ${g.result.length} logs`;
	}
	for (const [k, v] of Object.entries(tags)) console.log(`  ${k}: ${v}`);

	console.log("  GasPriceOracle:");
	for (const [fn, args] of [["isEcotone", []], ["isFjord", []], ["isIsthmus", []], ["isJovian", []], ["decimals", []], ["l1BaseFee", []], ["blobBaseFee", []], ["baseFeeScalar", []], ["blobBaseFeeScalar", []], ["getL1FeeUpperBound", [110n]], ["getOperatorFee", [21000n]]]) {
		const r = await rpc("eth_call", [{ to: GPO, data: encodeFunctionData({ abi: gpoAbi, functionName: fn, args }) }, "latest"]);
		const v = r.error ? `error ${r.error.message}` : r.result === "0x" ? "no data (no such function)" : String(decodeFunctionResult({ abi: gpoAbi, functionName: fn, data: r.result }));
		console.log(`    ${fn}(${args.join(",")}) = ${v}`);
	}

	// Receipts of plain transactions in a block well behind latest, so the state before it is still served.
	const latest = num((await rpc("eth_blockNumber")).result);
	let checked = 0, exact = 0, withL1 = 0, fieldsSeen = new Set(), notes = [];
	for (let b = latest - 20; b > latest - 60 && checked < 12; b--) {
		const blk = (await rpc("eth_getBlockByNumber", [`0x${b.toString(16)}`, true])).result;
		const counts = {};
		for (const t of blk.transactions) { counts[t.from] = (counts[t.from] ?? 0) + 1; if (t.to) counts[t.to] = (counts[t.to] ?? 0) + 10; }
		for (const t of blk.transactions) {
			if (t.type === "0x7e" || counts[t.from] !== 1 || checked >= 12) continue;
			const rc = (await rpc("eth_getTransactionReceipt", [t.hash])).result;
			for (const k of Object.keys(rc)) if (/^l1|operator|daFootprint|blobGas/i.test(k)) fieldsSeen.add(k);
			const before = big((await rpc("eth_getBalance", [t.from, `0x${(b - 1).toString(16)}`])).result);
			const after = big((await rpc("eth_getBalance", [t.from, `0x${b.toString(16)}`])).result);
			if (before == null || after == null) { notes.push("state before the block not served"); continue; }
			const l2 = big(rc.gasUsed) * big(rc.effectiveGasPrice);
			const l1 = rc.l1Fee ? big(rc.l1Fee) : 0n;
			const op = rc.operatorFeeScalar != null && rc.operatorFeeConstant != null ? (big(rc.gasUsed) * big(rc.operatorFeeScalar)) / 10n ** 6n + big(rc.operatorFeeConstant) : 0n;
			if (rc.l1Fee) withL1++;
			const spent = before - after;
			checked++;
			if (spent === big(t.value) + l2 + l1 + op) exact++;
			else if (spent === big(t.value) + l2) notes.push("one matched value + l2 alone");
			else notes.push(`one differs by ${spent - (big(t.value) + l2 + l1 + op)} wei (status ${rc.status}; internal transfers or calls that move ETH explain it)`);
		}
	}
	console.log(`  receipts: fee fields seen ${JSON.stringify([...fieldsSeen].sort())}; ${withL1} of ${checked} carry l1Fee`);
	console.log(`  balance check: ${exact} of ${checked} senders fell by exactly value + gasUsed x effectiveGasPrice + l1Fee + operator fee`);
	for (const n of [...new Set(notes)].slice(0, 6)) console.log(`    ${n}`);
	console.log("");
}
