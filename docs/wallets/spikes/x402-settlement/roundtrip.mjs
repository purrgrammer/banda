// Part 2: the official x402 v2 packages, end to end on the fork: an Express resource server with
// paymentMiddleware, an in-process facilitator (x402Facilitator + the exact EVM scheme) settling on the
// anvil fork, and a client that pays. Prints the exact wire headers, then replays and duplicates.
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme as ServerExact } from "@x402/evm/exact/server";
import { registerExactEvmScheme as registerFacilitatorExact } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ClientExact } from "@x402/evm/exact/client";
import { toFacilitatorEvmSigner, toClientEvmSigner } from "@x402/evm";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { getAddress, toHex, zeroAddress } from "viem";
import { startAnvil, clients, setUsdc, usdc, fmt, USDC } from "./lib.mjs";

const log = (...a) => console.log(...a);
const node = await startAnvil({ fork: true });
const { pub, test, payer, payee, fac } = clients(node.rpc);
log(`anvil fork of Base Sepolia at block ${node.forkBlock}`);
await setUsdc(pub, test, payer.address, 5_000_000n);

// Facilitator, in process, settling with anvil dev account 1.
const facilitator = new x402Facilitator();
registerFacilitatorExact(facilitator, {
	signer: toFacilitatorEvmSigner({ ...fac, address: fac.account.address }),
	networks: "eip155:84532",
});
let settles = 0;
let settleFailures = 0;
facilitator.onAfterSettle(async () => { settles++; });
facilitator.onSettleFailure(async () => { settleFailures++; });

// Resource server: two routes with the same price and payTo, and one with a different payTo.
const resourceServer = new x402ResourceServer(facilitator).register("eip155:84532", new ServerExact());
const route = (payTo, description) => ({
	accepts: { scheme: "exact", price: "$0.01", network: "eip155:84532", payTo, maxTimeoutSeconds: 120 },
	description, mimeType: "application/json",
});
const served = { weather: 0, forecast: 0 };
const app = express();
app.use(paymentMiddleware({
	"GET /weather": route(payee, "Weather now"),
	"GET /forecast": route(payee, "Forecast"),
}, resourceServer));
app.get("/weather", (_q, r) => { served.weather++; r.json({ temp: 21 }); });
app.get("/forecast", (_q, r) => { served.forecast++; r.json({ tomorrow: 23 }); });
const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const b64json = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const headersOf = (r) => Object.fromEntries([...r.headers].filter(([k]) => /payment|x-payment|cache-control|content-type/i.test(k)).map(([k, v]) => [k, /payment/i.test(k) ? `<base64, ${v.length} chars>` : v]));

// The client signer is only { address, signTypedData }: no transaction signing, no RPC.
const minimalSigner = toClientEvmSigner({ address: payer.address, signTypedData: (m) => payer.signTypedData(m) });
const http402 = new x402HTTPClient(new x402Client().register("eip155:*", new ClientExact(minimalSigner)));

// 1. Unpaid request.
log("\n1. GET /weather without payment");
const r0 = await fetch(`${base}/weather`);
const body0 = await r0.text();
log(`  status ${r0.status}`);
log(`  headers ${JSON.stringify(headersOf(r0))}`);
log(`  body (${body0.length} bytes): ${body0.slice(0, 200)}`);
const pr = b64json(r0.headers.get("payment-required"));
log(`  PAYMENT-REQUIRED (base64 of UTF-8 JSON, ${r0.headers.get("payment-required").length} chars) decodes to:`);
log(JSON.stringify(pr, null, 2).replace(/^/gm, "    "));

// 2. Sign.
log("\n2. Client builds the payment");
const paymentRequired = http402.getPaymentRequiredResponse((n) => r0.headers.get(n), body0 ? JSON.parse(body0) : undefined);
const payload = await http402.createPaymentPayload(paymentRequired);
const hdr = http402.encodePaymentSignatureHeader(payload);
log(`  request headers: ${JSON.stringify(Object.fromEntries(Object.entries(hdr).map(([k, v]) => [k, `<base64, ${v.length} chars, standard alphabet: ${/^[A-Za-z0-9+/]*={0,2}$/.test(v)}>`])))}`);
const decoded = b64json(Object.values(hdr)[0]);
log("  PAYMENT-SIGNATURE decodes to:");
log(JSON.stringify(decoded, null, 2).replace(/^/gm, "    "));
const nowS = Math.floor(Date.now() / 1000);
log(`  validBefore - now = ${Number(decoded.payload.authorization.validBefore) - nowS} s (maxTimeoutSeconds ${pr.accepts[0].maxTimeoutSeconds})`);

// 3. Paid request.
log("\n3. GET /weather with PAYMENT-SIGNATURE");
const p0 = await usdc(pub, payee);
const r1 = await fetch(`${base}/weather`, { headers: hdr });
log(`  status ${r1.status} body ${await r1.text()}`);
log(`  headers ${JSON.stringify(headersOf(r1))}`);
const settle = b64json(r1.headers.get("payment-response"));
log(`  PAYMENT-RESPONSE decodes to: ${JSON.stringify(settle)}`);
const rc = await pub.getTransactionReceipt({ hash: settle.transaction });
log(`  on chain: ${rc.status}, from ${rc.from} (the facilitator), payee +${fmt((await usdc(pub, payee)) - p0)}`);

// 4. Replay the same header later.
log("\n4. Replay the same PAYMENT-SIGNATURE (sequential)");
const p1 = await usdc(pub, payee);
const w1 = served.weather;
const r2 = await fetch(`${base}/weather`, { headers: hdr });
const body2 = await r2.text();
log(`  status ${r2.status}, handler ran ${served.weather - w1} time(s), payee +${fmt((await usdc(pub, payee)) - p1)}`);
if (r2.headers.get("payment-required")) log(`  error in PAYMENT-REQUIRED: ${b64json(r2.headers.get("payment-required")).error}`);
if (r2.headers.get("payment-response")) log(`  PAYMENT-RESPONSE: ${JSON.stringify(b64json(r2.headers.get("payment-response")))}`);
if (body2 && !r2.headers.get("payment-required")) log(`  body ${body2.slice(0, 200)}`);

// 5. One fresh payment sent three times at once.
log("\n5. One fresh payment, the same header sent 3 times concurrently");
const payload2 = await http402.createPaymentPayload(paymentRequired);
const hdr2 = http402.encodePaymentSignatureHeader(payload2);
const p2 = await usdc(pub, payee);
const w2 = served.weather;
const s2 = settles;
const f2 = settleFailures;
const n2 = await pub.getTransactionCount({ address: fac.account.address });
const rs = await Promise.all([1, 2, 3].map(() => fetch(`${base}/weather`, { headers: hdr2 })));
for (const r of rs) {
	const pr2 = r.headers.get("payment-response") ? b64json(r.headers.get("payment-response")) : undefined;
	const err = r.headers.get("payment-required") ? b64json(r.headers.get("payment-required")).error : undefined;
	const text = await r.text();
	log(`  status ${r.status} ${pr2 ? `settle success=${pr2.success} tx=${pr2.transaction?.slice(0, 12) || "-"} errorReason=${pr2.errorReason ?? "-"}` : ""}${err ? `error=${err}` : ""} body=${text.slice(0, 60)}`);
}
log(`  handler ran ${served.weather - w2} time(s), facilitator onAfterSettle ${settles - s2}, onSettleFailure ${settleFailures - f2}, facilitator txs sent ${(await pub.getTransactionCount({ address: fac.account.address })) - n2}, payee +${fmt((await usdc(pub, payee)) - p2)}`);

// 6. A payment built for /weather, presented at /forecast (same price, same payTo).
log("\n6. Payment built for /weather sent to /forecast (same price and payTo)");
const payload3 = await http402.createPaymentPayload(paymentRequired);
const hdr3 = http402.encodePaymentSignatureHeader(payload3);
const p3 = await usdc(pub, payee);
const f3 = served.forecast;
const r6 = await fetch(`${base}/forecast`, { headers: hdr3 });
const body6 = await r6.text();
log(`  status ${r6.status}, /forecast handler ran ${served.forecast - f3} time(s), payee +${fmt((await usdc(pub, payee)) - p3)}`);
if (r6.headers.get("payment-required")) log(`  error: ${b64json(r6.headers.get("payment-required")).error}`);
else log(`  body ${body6.slice(0, 120)}`);
log(`  what the payer signed binds: ${Object.keys(payload3.payload.authorization).join(", ")} + domain(name, version, chainId, verifyingContract); payload.resource is ${JSON.stringify(payload3.resource)} and is not signed`);

// 7. The daemon signs without the SDK client: its own checks, a pinned domain table, a window it chooses.
log("\n7. Daemon-style signing (no SDK client), shorter window than the server asked");
const PINNED = { "eip155:84532": { chainId: 84532, asset: USDC, name: "USDC", version: "2", decimals: 6 } };
const MAX_WINDOW_S = 60;
function daemonSign(challenge, observedUrl, wallet, spendable) {
	const why = (m) => { throw new Error(`refused: ${m}`); };
	if (challenge.x402Version !== 2) why("x402Version");
	if (challenge.accepts.length < 1) why("no accepts");
	const r = challenge.accepts.find((a) => a.scheme === "exact" && PINNED[a.network]) ?? why("no exact accept on a pinned chain");
	const t = PINNED[r.network];
	if (getAddress(r.asset) !== getAddress(t.asset)) why("asset is not the pinned USDC");
	if ((r.extra?.assetTransferMethod ?? "eip3009") !== "eip3009") why("transfer method is not EIP-3009");
	if (r.extra?.name !== t.name || r.extra?.version !== t.version) why("domain name/version differ from the pinned table");
	if (challenge.extensions && Object.keys(challenge.extensions).length) why(`extensions ${Object.keys(challenge.extensions)}`);
	if (!/^[0-9]{1,78}$/.test(r.amount) || BigInt(r.amount) <= 0n) why("amount");
	if (BigInt(r.amount) > spendable) why("amount over the spendable balance");
	const payTo = getAddress(r.payTo);
	if (payTo === zeroAddress || payTo === getAddress(t.asset) || payTo === wallet.address) why("payTo");
	if (challenge.resource?.url && new URL(challenge.resource.url).origin + new URL(challenge.resource.url).pathname !== observedUrl) why("resource differs from the observed URL");
	if (!(r.maxTimeoutSeconds >= 10)) why("maxTimeoutSeconds");
	const now = Math.floor(Date.now() / 1000);
	const message = { from: wallet.address, to: payTo, value: BigInt(r.amount), validAfter: 0n, validBefore: BigInt(now + Math.min(r.maxTimeoutSeconds, MAX_WINDOW_S)), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
	// (the store commit of { endpoint, payTo, message } happens here, before any signature exists)
	return { r, message };
}
const authTypes = { TransferWithAuthorization: [
	{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
	{ name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const r7 = await fetch(`${base}/weather`);
const ch7 = b64json(r7.headers.get("payment-required"));
await r7.text();
const { r: acc7, message: m7 } = daemonSign(ch7, `${base}/weather`, payer, await usdc(pub, payer.address));
const t7 = PINNED[acc7.network];
const sig7 = await payer.signTypedData({ domain: { name: t7.name, version: t7.version, chainId: t7.chainId, verifyingContract: t7.asset }, types: authTypes, primaryType: "TransferWithAuthorization", message: m7 });
const payload7 = { x402Version: 2, payload: { authorization: Object.fromEntries(Object.entries(m7).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])), signature: sig7 }, resource: ch7.resource, accepted: acc7 };
const hdr7 = { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload7), "utf8").toString("base64") };
const p7 = await usdc(pub, payee);
const r7b = await fetch(`${base}/weather`, { headers: hdr7 });
log(`  window ${Number(m7.validBefore) - Math.floor(Date.now() / 1000)} s (server asked ${acc7.maxTimeoutSeconds}); status ${r7b.status} body ${await r7b.text()}; payee +${fmt((await usdc(pub, payee)) - p7)}`);
for (const [label, mutate] of [
	["permit2 transfer method", (c) => { c.accepts[0].extra.assetTransferMethod = "permit2"; }],
	["10-year timeout", (c) => { c.accepts[0].maxTimeoutSeconds = 315_360_000; }],
	["other asset", (c) => { c.accepts[0].asset = "0x1111111111111111111111111111111111111111"; }],
	["mainnet domain name", (c) => { c.accepts[0].extra.name = "USD Coin"; }],
	["resource for another path", (c) => { c.resource.url = `${base}/forecast`; }],
	["gas-sponsoring extension", (c) => { c.extensions = { erc20ApprovalGasSponsoring: {} }; }],
]) {
	const c = structuredClone(ch7);
	mutate(c);
	try {
		const { message } = daemonSign(c, `${base}/weather`, payer, await usdc(pub, payer.address));
		log(`  ${label}: accepted, window ${Number(message.validBefore) - Math.floor(Date.now() / 1000)} s`);
	} catch (e) { log(`  ${label}: ${e.message}`); }
}

server.close();
node.stop();
log("\ndone");
process.exit(0);
