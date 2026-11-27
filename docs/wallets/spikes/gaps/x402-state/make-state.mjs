// Gap B, step 1 (reads https://sepolia.base.org, never writes to it): fork Base Sepolia, run every USDC path the
// x402 scenarios use (views, settle, replay, cancel), and see what anvil_dumpState keeps. Then build the fixture
// from the prestate tracer instead: the code and every storage slot those paths read, set into a plain anvil with
// chain id 84532 and dumped as a --load-state file. The file holds public contract code and storage only.
import { writeFileSync } from "node:fs";
import { addr } from "micro-eth-signer";
import { startAnvil, rpcAt, num, DEV1, DEV1_ADDR, signTransfer } from "../lib.mjs";
import { USDC, CHAIN_ID, IMPL_SLOT, call, data, decodeDump, setUsdc, authorize, randomNonce, balanceSlot } from "./common.mjs";

const UP = process.env.FORK_URL ?? "https://sepolia.base.org";
const up = rpcAt(UP);
const head = num((await up("eth_blockNumber")).result);
const forkBlock = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : head - 10;
const fork = await startAnvil(["--fork-url", UP, "--fork-block-number", String(forkBlock)]);
const rpc = fork.rpc;
console.log(`fork of ${UP} at block ${forkBlock}, chain id ${num((await rpc("eth_chainId")).result)}`);
const impl = addr.addChecksum(`0x${(await rpc("eth_getStorageAt", [USDC, IMPL_SLOT, "latest"])).result.slice(26)}`);
console.log(`USDC proxy ${USDC}, implementation ${impl} (zos implementation slot)`);
for (const fn of ["name", "version", "symbol", "decimals", "paused", "DOMAIN_SEPARATOR"]) console.log(`  ${fn}() = ${await call(rpc, fn)}`);

const rndKey = () => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
const payerKey = rndKey();
const payer = addr.fromPrivateKey(payerKey);
const payee = addr.fromPrivateKey(rndKey());
await setUsdc(rpc, payer, 5_000_000n);
const t = num((await rpc("eth_getBlockByNumber", ["latest", false])).result.timestamp);
const prestate = new Map(); // address -> Set(slot)
const remember = (pre) => {
	for (const [a, v] of Object.entries(pre ?? {})) {
		const k = a.toLowerCase();
		if (!prestate.has(k)) prestate.set(k, new Set());
		for (const s of Object.keys(v.storage ?? {})) prestate.get(k).add(s);
	}
};
const send = async (callData) => {
	const nonce = num((await rpc("eth_getTransactionCount", [DEV1_ADDR, "latest"])).result);
	const tx = signTransfer({ key: DEV1, to: USDC, value: 0n, nonce, chainId: CHAIN_ID, gasLimit: 200000n, maxFee: 10n ** 11n, tip: 10n ** 9n, data: callData });
	const sent = await rpc("eth_sendRawTransaction", [tx.raw]);
	if (sent.error) return `send error ${JSON.stringify(sent.error)}`;
	for (let i = 0; i < 100; i++) {
		const r = (await rpc("eth_getTransactionReceipt", [sent.result])).result;
		if (r) {
			const tr = await rpc("debug_traceTransaction", [sent.result, { tracer: "prestateTracer" }]);
			if (tr.error) return `${r.status}, trace error ${JSON.stringify(tr.error)}`;
			remember(tr.result);
			return r.status;
		}
		await new Promise((res) => setTimeout(res, 100));
	}
	return "no receipt";
};
const traceCall = async (fn, args) => {
	const tr = await rpc("debug_traceCall", [{ to: USDC, data: data(fn, args) }, "latest", { tracer: "prestateTracer" }]);
	if (tr.error) console.log(`  debug_traceCall ${fn}: ${JSON.stringify(tr.error)}`);
	else remember(tr.result);
};
for (const [fn, args] of [["name", []], ["version", []], ["symbol", []], ["decimals", []], ["paused", []], ["DOMAIN_SEPARATOR", []], ["balanceOf", [payer]], ["authorizationState", [payer, randomNonce()]], ["isBlacklisted", [payee]]]) await traceCall(fn, args);
const m1 = { from: payer, to: payee, value: 10000n, validAfter: 0n, validBefore: BigInt(t + 600), nonce: randomNonce() };
const tw = (m, sig) => data("transferWithAuthorization", [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig]);
console.log(`  settle: status ${await send(tw(m1, authorize(payerKey, m1)))}`);
console.log(`  replay: status ${await send(tw(m1, authorize(payerKey, m1)))}`);
// cancelAuthorization(authorizer, nonce, signature) over CancelAuthorization(authorizer, nonce)
const { signTyped } = await import("micro-eth-signer");
const cNonce = randomNonce();
const cSig = signTyped({ types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, primaryType: "CancelAuthorization", domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC }, message: { authorizer: payer, nonce: cNonce } }, payerKey, false);
console.log(`  cancel: status ${await send(data("cancelAuthorization", [payer, cNonce, cSig]))}`);

const dump = decodeDump((await rpc("anvil_dumpState")).result);
const dk = Object.keys(dump.accounts);
const inDump = (a) => dk.find((k) => k.toLowerCase() === a.toLowerCase());
console.log(`anvil_dumpState on the fork: ${dk.length} accounts; USDC proxy ${inDump(USDC) ? `present with ${Object.keys(dump.accounts[inDump(USDC)].storage).length} slots` : "absent"}; implementation ${inDump(impl) ? "present" : "ABSENT"}`);
console.log(`prestate tracer: ${[...prestate].map(([a, s]) => `${a} ${s.size} slots`).join(", ")}`);

// Build the fixture: proxy and implementation code at the fork block, and every slot the paths read, at the fork
// block (before this spike's writes), except the throwaway payer's and payee's own slots.
const skip = new Set([balanceSlot(payer), balanceSlot(payee)].map((s) => s.toLowerCase()));
const plain = await startAnvil(["--chain-id", String(CHAIN_ID)]);
let slots = 0;
// Every account the paths touched that has code at the fork block: the proxy, the implementation, and any linked
// library (FiatToken v2.2 calls SignatureChecker as an external library). OP predeploys (0x4200…) are left out.
const withCode = [];
for (const a of prestate.keys()) {
	if (a.startsWith("0x42000000000000000000000000000000000000")) continue;
	const code = (await up("eth_getCode", [a, `0x${forkBlock.toString(16)}`])).result;
	if (code && code !== "0x") withCode.push([a, code]);
}
console.log(`accounts with code to copy: ${withCode.map(([a, c]) => `${a} (${(c.length - 2) / 2} B)`).join(", ")}`);
for (const [a, code] of withCode) {
	await plain.rpc("anvil_setCode", [a, code]);
	for (const s of prestate.get(a.toLowerCase()) ?? []) {
		const v = (await up("eth_getStorageAt", [a, s, `0x${forkBlock.toString(16)}`])).result;
		if (skip.has(s.toLowerCase()) || /^0x0*$/.test(v)) continue;
		await plain.rpc("anvil_setStorageAt", [a, s, v]);
		slots++;
	}
}
await plain.rpc("evm_mine", []);
const state = decodeDump((await plain.rpc("anvil_dumpState")).result);
plain.stop();
fork.stop();
state.transactions = [];
const out = process.argv[2] ?? "usdc-84532.state.json";
writeFileSync(out, JSON.stringify(state));
console.log(`wrote ${out}: ${JSON.stringify(state).length} bytes, ${slots} non-zero slots; block env timestamp ${num(state.block.timestamp)} (${new Date(num(state.block.timestamp) * 1000).toISOString()})`);
