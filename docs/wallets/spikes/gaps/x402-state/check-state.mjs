// Gap B, step 2 (offline): a plain anvil, chain id 84532, from the fixture, with no fork URL. Does USDC behave as on
// the fork for every x402 scenario fact: domain, settle, events, replay, strict expiry, cancel, and reads at
// finalized? And what chain time does a loaded state give, compared with the wall clock?
import { readFileSync, writeFileSync } from "node:fs";
import { addr } from "micro-eth-signer";
import { startAnvil, num, hex, DEV1, DEV1_ADDR, signTransfer } from "../lib.mjs";
import { USDC, CHAIN_ID, call, data, setUsdc, authorize, randomNonce, TOPIC_USED, keccakHex } from "./common.mjs";

const file = process.argv[2] ?? "usdc-84532.state.json";
const a = await startAnvil(["--chain-id", String(CHAIN_ID), "--load-state", file, "--no-mining", "--slots-in-an-epoch", "1"]);
const { rpc } = a;
const wall = () => Math.floor(Date.now() / 1000);
const latest = async () => (await rpc("eth_getBlockByNumber", ["latest", false])).result;
const L0 = await latest();
console.log(`loaded ${file}: chain id ${num((await rpc("eth_chainId")).result)}, latest block ${num(L0.number)}, its timestamp - wall clock = ${num(L0.timestamp) - wall()} s`);
await rpc("evm_mine", []);
console.log(`first evm_mine after load: timestamp - wall clock = ${num((await latest()).timestamp) - wall()} s`);
for (const fn of ["name", "version", "decimals", "paused", "DOMAIN_SEPARATOR"]) console.log(`  ${fn}() = ${await call(rpc, fn)}`);
console.log(`  DOMAIN_SEPARATOR equals the fork's 0x71f17a3b…c9818: ${(await call(rpc, "DOMAIN_SEPARATOR")) === "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818"}`);

const rndKey = () => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
const payerKey = rndKey();
const payer = addr.fromPrivateKey(payerKey);
const payee = addr.fromPrivateKey(rndKey());
await setUsdc(rpc, payer, 1_000_000n);
await rpc("evm_mine", []);
console.log(`  payer USDC ${await call(rpc, "balanceOf", [payer])}, payer ETH ${num((await rpc("eth_getBalance", [payer, "latest"])).result)}`);
let devNonce = 0;
const submit = async (callData) => {
	const tx = signTransfer({ key: DEV1, to: USDC, value: 0n, nonce: devNonce++, chainId: CHAIN_ID, gasLimit: 200000n, maxFee: 10n ** 10n, tip: 10n ** 9n, data: callData });
	const sent = await rpc("eth_sendRawTransaction", [tx.raw]);
	if (sent.error) return { error: sent.error };
	await rpc("evm_mine", []);
	return (await rpc("eth_getTransactionReceipt", [sent.result])).result;
};
const reason = async (callData) => {
	const r = await rpc("eth_call", [{ from: DEV1_ADDR, to: USDC, data: callData }, "latest"]);
	return r.error ? (r.error.message ?? JSON.stringify(r.error)) : "ok";
};
const tw = (m, sig) => data("transferWithAuthorization", [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, sig]);
const T = () => latest().then((b) => num(b.timestamp));

// settle
const m1 = { from: payer, to: payee, value: 10000n, validAfter: 0n, validBefore: BigInt((await T()) + 60), nonce: randomNonce() };
const r1 = await submit(tw(m1, authorize(payerKey, m1)));
const topics = r1.logs.map((l) => l.topics[0]);
console.log(`settle: status ${r1.status}, gasUsed ${num(r1.gasUsed)}, logs ${r1.logs.length} (Transfer ${topics.includes(keccakHex("Transfer(address,address,uint256)"))}, AuthorizationUsed ${topics.includes(TOPIC_USED)}), payee ${await call(rpc, "balanceOf", [payee])}, payer ETH still ${num((await rpc("eth_getBalance", [payer, "latest"])).result)}`);
const st = async (n) => `latest ${await call(rpc, "authorizationState", [payer, n], "latest")} safe ${await call(rpc, "authorizationState", [payer, n], "safe")} finalized ${await call(rpc, "authorizationState", [payer, n], "finalized")}`;
console.log(`  authorizationState right after: ${await st(m1.nonce)}`);
await rpc("evm_mine", []); console.log(`  +1 block: ${await st(m1.nonce)}`);
await rpc("evm_mine", []); console.log(`  +2 blocks: ${await st(m1.nonce)}`);
const usedLogs = await rpc("eth_getLogs", [{ address: USDC, topics: [TOPIC_USED, `0x${payer.slice(2).toLowerCase().padStart(64, "0")}`], fromBlock: "0x0", toBlock: "finalized" }]);
console.log(`  eth_getLogs(AuthorizationUsed, toBlock: finalized): ${usedLogs.error ? JSON.stringify(usedLogs.error) : `${usedLogs.result.length} log(s)`}`);

// replay and tampering
console.log(`replay (eth_call): ${await reason(tw(m1, authorize(payerKey, m1)))}`);
const r1b = await submit(tw(m1, authorize(payerKey, m1)));
console.log(`replay (mined, fixed gas): status ${r1b.status}; payee ${await call(rpc, "balanceOf", [payee])}`);
const m1f = { ...m1, nonce: randomNonce() };
console.log(`same signature, another to (fresh nonce): ${await reason(tw({ ...m1f, to: DEV1_ADDR }, authorize(payerKey, m1f)))}`);

// strict expiry against block time
const t0 = await T();
const m2 = { from: payer, to: payee, value: 10000n, validAfter: 0n, validBefore: BigInt(t0 + 60), nonce: randomNonce() };
await rpc("evm_setNextBlockTimestamp", [t0 + 59]); await rpc("evm_mine", []);
console.log(`block time = validBefore - 1: ${await reason(tw(m2, authorize(payerKey, m2)))}`);
await rpc("evm_setNextBlockTimestamp", [t0 + 60]); await rpc("evm_mine", []);
console.log(`block time = validBefore:     ${await reason(tw(m2, authorize(payerKey, m2)))}`);
const r2 = await submit(tw(m2, authorize(payerKey, m2)));
console.log(`  mined anyway (fixed gas): status ${r2.status}; authorizationState ${await call(rpc, "authorizationState", [payer, m2.nonce])} (the expired nonce is never burnt)`);

// cancel
const { signTyped } = await import("micro-eth-signer");
const cN = randomNonce();
const cSig = signTyped({ types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] }, primaryType: "CancelAuthorization", domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC }, message: { authorizer: payer, nonce: cN } }, payerKey, false);
const r3 = await submit(data("cancelAuthorization", [payer, cN, cSig]));
console.log(`cancel: status ${r3.status}, AuthorizationCanceled log ${r3.logs.some((l) => l.topics[0] === keccakHex("AuthorizationCanceled(address,bytes32)"))}; authorizationState ${await call(rpc, "authorizationState", [payer, cN])}`);
const m3 = { from: payer, to: payee, value: 1n, validAfter: 0n, validBefore: BigInt((await T()) + 60), nonce: cN };
console.log(`settle after cancel: ${await reason(tw(m3, authorize(payerKey, m3)))}`);
a.stop();

// A fixture made long ago: shift the dumped block timestamps 30 days back and load it.
const st0 = JSON.parse(readFileSync(file, "utf8"));
const shift = 30 * 24 * 3600;
const old = JSON.parse(JSON.stringify(st0));
old.block.timestamp = hex(num(old.block.timestamp) - shift);
for (const b of old.blocks ?? []) if (b.header?.timestamp) b.header.timestamp = hex(num(b.header.timestamp) - shift);
writeFileSync("old.state.json", JSON.stringify(old));
const o = await startAnvil(["--chain-id", String(CHAIN_ID), "--load-state", "old.state.json", "--no-mining"]);
const ol = (await o.rpc("eth_getBlockByNumber", ["latest", false])).result;
await o.rpc("evm_mine", []);
const ol2 = (await o.rpc("eth_getBlockByNumber", ["latest", false])).result;
console.log(`fixture shifted 30 days back: loaded latest ts - wall = ${num(ol.timestamp) - wall()} s; next mined block ts - wall = ${num(ol2.timestamp) - wall()} s`);
const fix = await o.rpc("evm_setNextBlockTimestamp", [wall()]);
await o.rpc("evm_mine", []);
console.log(`  evm_setNextBlockTimestamp(wall clock) -> ${JSON.stringify(fix.error ?? fix.result)}; then ts - wall = ${num((await o.rpc("eth_getBlockByNumber", ["latest", false])).result.timestamp) - wall()} s`);
o.stop();
