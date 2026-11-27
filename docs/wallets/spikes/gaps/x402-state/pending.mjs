// Gap F (offline, on the gap B fixture): (1) what the official facilitator does with a window taken from chain
// time when chain time and the wall clock disagree; (2) what a payer sees when the facilitator broadcast the
// settlement but could not confirm it (`settlement_pending`), and what the chain says afterwards.
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme as ServerExact } from "@x402/evm/exact/server";
import { registerExactEvmScheme as registerFacilitatorExact } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { x402Facilitator } from "@x402/core/facilitator";
import { createWalletClient, http, publicActions, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addr } from "micro-eth-signer";
import { startAnvil, num, DEV1 } from "../lib.mjs";
import { USDC, CHAIN_ID, call, setUsdc, authorize, randomNonce } from "./common.mjs";

const chain = defineChain({ id: CHAIN_ID, name: "anvil-84532", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1"] } } });
const wall = () => Math.floor(Date.now() / 1000);
const rndKey = () => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const unb64 = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

async function setup(stateFile, { receiptTimeoutMs } = {}) {
	const a = await startAnvil(["--chain-id", String(CHAIN_ID), "--load-state", stateFile, "--no-mining"]);
	const fac = createWalletClient({ chain, transport: http(a.url), account: privateKeyToAccount(DEV1) }).extend(publicActions);
	const facilitator = new x402Facilitator();
	const signer = toFacilitatorEvmSigner({
		...fac,
		address: fac.account.address,
		waitForTransactionReceipt: (args) =>
			receiptTimeoutMs
				? Promise.race([fac.waitForTransactionReceipt(args), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for the receipt")), receiptTimeoutMs))])
				: fac.waitForTransactionReceipt(args),
	});
	registerFacilitatorExact(facilitator, { signer, networks: `eip155:${CHAIN_ID}` });
	return { a, facilitator, fac };
}
const requirements = (payTo) => ({ scheme: "exact", network: `eip155:${CHAIN_ID}`, amount: "10000", asset: USDC, payTo, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } });
function payload(payerKey, payTo, validBefore, resourceUrl, validAfter = 0) {
	const from = addr.fromPrivateKey(payerKey);
	const m = { from, to: payTo, value: 10000n, validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: randomNonce() };
	return {
		x402Version: 2,
		payload: { authorization: { from, to: payTo, value: "10000", validAfter: String(validAfter), validBefore: String(validBefore), nonce: m.nonce }, signature: authorize(payerKey, m) },
		resource: { url: resourceUrl, description: "Weather now", mimeType: "application/json" },
		accepted: requirements(payTo),
	};
}

// (1) Clock. C19's window (validAfter = t - 5, validBefore = t + 60, t = the latest block's timestamp), checked by the
// official facilitator's verify at several skews between chain time and the wall clock. A skew is set with
// evm_setNextBlockTimestamp(wall + skew) on the gap B fixture; "as loaded" leaves the fixture's own clock.
console.log("## 1. the official facilitator's verify of C19's window (validAfter t-5, validBefore t+60) at each skew");
for (const [label, file, skew] of [["fresh fixture, as loaded", "usdc-84532.state.json", null], ["fixture 30 days old, as loaded", "old.state.json", null],
	["skew 0 s", "old.state.json", 0], ["skew -50 s", "old.state.json", -50], ["skew -60 s", "old.state.json", -60], ["skew -119 s (under the 120 s pause)", "old.state.json", -119],
	["skew +4 s", "old.state.json", 4], ["skew +10 s", "old.state.json", 10], ["skew +119 s (under the 120 s pause)", "old.state.json", 119]]) {
	const { a, facilitator } = await setup(file);
	if (skew !== null) await a.rpc("evm_setNextBlockTimestamp", [wall() + skew]);
	await a.rpc("evm_mine", []);
	const chainT = num((await a.rpc("eth_getBlockByNumber", ["latest", false])).result.timestamp);
	const payerKey = rndKey();
	const payTo = addr.fromPrivateKey(rndKey());
	await setUsdc(a.rpc, addr.fromPrivateKey(payerKey), 1_000_000n);
	const p = payload(payerKey, payTo, chainT + 60, "http://127.0.0.1/weather", chainT - 5);
	const v = await facilitator.verify(p, requirements(payTo));
	console.log(`  ${label.padEnd(38)} chain time - wall = ${String(chainT - wall()).padStart(9)} s -> verify ${JSON.stringify({ isValid: v.isValid, invalidReason: v.invalidReason })}`);
	a.stop();
}

// (2) settlement_pending: the facilitator broadcasts, the receipt does not come within its wait (no block mined).
console.log("\n## 2. settlement_pending seen by the payer (anvil --no-mining; the facilitator waits 1.5 s for a receipt)");
{
	const { a, facilitator } = await setup("usdc-84532.state.json", { receiptTimeoutMs: 1500 });
	await a.rpc("evm_setNextBlockTimestamp", [wall()]);
	await a.rpc("evm_mine", []);
	const payerKey = rndKey();
	const payer = addr.fromPrivateKey(payerKey);
	const payTo = addr.fromPrivateKey(rndKey());
	await setUsdc(a.rpc, payer, 1_000_000n);
	await a.rpc("evm_mine", []);
	const resourceServer = new x402ResourceServer(facilitator).register(`eip155:${CHAIN_ID}`, new ServerExact());
	let served = 0;
	const app = express();
	app.use(paymentMiddleware({ "GET /weather": { accepts: { scheme: "exact", price: "$0.01", network: `eip155:${CHAIN_ID}`, payTo, maxTimeoutSeconds: 120 }, description: "Weather now", mimeType: "application/json" } }, resourceServer));
	app.get("/weather", (_q, r) => { served++; r.json({ temp: 21 }); });
	const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
	const url = `http://127.0.0.1:${server.address().port}/weather`;
	const r0 = await fetch(url);
	const pr = unb64(r0.headers.get("payment-required"));
	const chainT = num((await a.rpc("eth_getBlockByNumber", ["latest", false])).result.timestamp);
	const p = payload(payerKey, payTo, chainT + 60, pr.resource.url);
	p.accepted = pr.accepts[0];
	const hdr = { "PAYMENT-SIGNATURE": b64(p) };
	const t0 = Date.now();
	const r1 = await fetch(url, { headers: hdr });
	const body1 = await r1.text();
	const resp1 = r1.headers.get("payment-response") ? unb64(r1.headers.get("payment-response")) : null;
	const req1 = r1.headers.get("payment-required") ? unb64(r1.headers.get("payment-required")) : null;
	console.log(`  paid request: HTTP ${r1.status} after ${Date.now() - t0} ms, handler ran ${served}x, body ${JSON.stringify(body1.slice(0, 80))}`);
	console.log(`    PAYMENT-RESPONSE: ${JSON.stringify(resp1)}`);
	if (req1) console.log(`    PAYMENT-REQUIRED error: ${JSON.stringify(req1.error)}`);
	const pool = await a.rpc("txpool_status");
	console.log(`  chain now: pool ${JSON.stringify(pool.result)}, authorizationState ${await call(a.rpc, "authorizationState", [payer, p.payload.authorization.nonce])}`);
	const r1b = await fetch(url, { headers: hdr });
	const resp1b = r1b.headers.get("payment-response") ? unb64(r1b.headers.get("payment-response")) : null;
	const pool1b = await a.rpc("txpool_status");
	console.log(`  the same header again before any block: HTTP ${r1b.status}, handler ran ${served}x in all, PAYMENT-RESPONSE ${JSON.stringify(resp1b && { success: resp1b.success, errorReason: resp1b.errorReason, transaction: resp1b.transaction, sameTx: resp1b.transaction === resp1?.transaction })}, pool ${JSON.stringify(pool1b.result)}`);
	await a.rpc("evm_mine", []);
	console.log(`  after one block: authorizationState ${await call(a.rpc, "authorizationState", [payer, p.payload.authorization.nonce])}, payTo USDC ${await call(a.rpc, "balanceOf", [payTo])}`);
	const r2 = await fetch(url, { headers: hdr });
	const resp2 = r2.headers.get("payment-response") ? unb64(r2.headers.get("payment-response")) : null;
	const req2 = r2.headers.get("payment-required") ? unb64(r2.headers.get("payment-required")) : null;
	console.log(`  the same header sent again: HTTP ${r2.status}, handler ran ${served}x in all, PAYMENT-RESPONSE ${JSON.stringify(resp2)}, payTo USDC ${await call(a.rpc, "balanceOf", [payTo])}`);
	if (req2) console.log(`    PAYMENT-REQUIRED error: ${JSON.stringify(req2.error)}`);
	server.close();
	a.stop();
}
process.exit(0);
