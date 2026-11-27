// Gap E on anvil 1.9.0: does a Base fork (or --optimism, or -n base) charge an L1 fee, and does the receipt say so?
// A fresh key is funded with anvil_setBalance and sends 1 wei to a fresh address; the balance delta is compared with
// value + gasUsed x effectiveGasPrice, and the receipt's l1 fields are listed. Also: eth_getLogs over a numeric range
// and repeated "finalized" reads on the public Sepolia endpoint (are its tags consistent from call to call?).
import { randomBytes } from "node:crypto";
import { addr } from "micro-eth-signer";
import { startAnvil, rpcAt, signTransfer, num, big, hex } from "../lib.mjs";

const SEPOLIA = "https://sepolia.base.org";
const fresh = () => { const key = `0x${randomBytes(32).toString("hex")}`; return { key, address: addr.fromPrivateKey(key) }; };
const until = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

async function transfer(label, extra) {
	const a = await startAnvil(extra);
	try {
		const chainId = num((await a.rpc("eth_chainId")).result);
		const s = fresh();
		await a.rpc("anvil_setBalance", [s.address, hex(10n ** 18n)]);
		const base = big((await a.rpc("eth_getBlockByNumber", ["latest", false])).result.baseFeePerGas);
		const t = signTransfer({ key: s.key, to: fresh().address, value: 1n, nonce: 0, chainId, maxFee: base * 3n + 10n ** 6n, tip: 10n ** 6n });
		const sent = await a.rpc("eth_sendRawTransaction", [t.raw]);
		if (sent.error) return console.log(`  ${label}: send refused ${JSON.stringify(sent.error)}`);
		const rc = await until(async () => (await a.rpc("eth_getTransactionReceipt", [t.hash])).result);
		const after = big((await a.rpc("eth_getBalance", [s.address, "latest"])).result);
		const spent = 10n ** 18n - after;
		const l2 = big(rc.gasUsed) * big(rc.effectiveGasPrice) + 1n;
		const fields = Object.keys(rc).filter((k) => /^l1|operator|daFootprint/i.test(k));
		let gpo = "";
		if (label.includes("fork")) {
			const r = await a.rpc("eth_call", [{ to: "0x420000000000000000000000000000000000000F", data: `0xf1c7a58b${(110).toString(16).padStart(64, "0")}` }, "latest"]);
			gpo = `; GasPriceOracle.getL1FeeUpperBound(110) on the fork = ${r.result ? big(r.result) : JSON.stringify(r.error)}`;
		}
		console.log(`  ${label}: chain ${chainId}, status ${rc.status}, spent - (value + gasUsed x effectiveGasPrice) = ${spent - l2} wei; receipt fee fields ${JSON.stringify(fields)}${rc.l1Fee ? ` l1Fee ${big(rc.l1Fee)}` : ""}${gpo}`);
	} finally {
		a.stop();
	}
}

console.log("## L1 fee on anvil 1.9.0");
const head = num((await rpcAt(SEPOLIA)("eth_blockNumber")).result);
await transfer("plain anvil", ["--chain-id", "31337"]);
await transfer("--optimism", ["--optimism"]);
await transfer("-n base", ["-n", "base"]);
await transfer("fork of Base Sepolia", ["--fork-url", SEPOLIA, "--fork-block-number", String(head - 10)]);
await transfer("fork of Base Sepolia, -n base", ["--fork-url", SEPOLIA, "--fork-block-number", String(head - 10), "-n", "base"]);

console.log("\n## sepolia.base.org: eth_getLogs ranges and the finalized tag from call to call");
const rpc = rpcAt(SEPOLIA);
const fins = [];
for (let i = 0; i < 6; i++) fins.push(num((await rpc("eth_getBlockByNumber", ["finalized", false])).result.number));
console.log(`  six reads of finalized in a row: ${fins.map((f) => f - fins[0]).join(", ")} (relative to the first)`);
const fin = fins.at(-1);
for (const [from, to] of [[fin - 100, fin], [fin - 199, fin], [fin - 200, fin], [fin - 100, "finalized"], [fin - 100, "safe"]]) {
	const g = await rpc("eth_getLogs", [{ address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", fromBlock: hex(from), toBlock: typeof to === "number" ? hex(to) : to }]);
	console.log(`  eth_getLogs USDC fromBlock finalized-${fin - from} toBlock ${typeof to === "number" ? `finalized-${fin - to}` : to}: ${g.error ? `${g.error.code} "${g.error.message}"` : `${g.result.length} logs`}`);
}
