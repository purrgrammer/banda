// Part 1: EIP-3009 transferWithAuthorization on an anvil fork of Base Sepolia, viem only, no x402 SDK.
// The payer signs; a separate facilitator account submits. Each case prints what the chain did.
import { domainSeparator, parseSignature, toHex, getAddress } from "viem";
import { startAnvil, clients, setUsdc, usdc, usdcAbi, fmt, revertReason, USDC, CHAIN_ID } from "./lib.mjs";

const node = await startAnvil({ fork: true });
const { pub, test, payer, payee, other, fac } = clients(node.rpc);
const log = (...a) => console.log(...a);
log(`anvil fork of Base Sepolia at block ${node.forkBlock}, chain id ${await pub.getChainId()}`);

const authTypes = {
	TransferWithAuthorization: [
		{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
		{ name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
	],
};
const cancelTypes = { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] };
const domain = (name = "USDC") => ({ name, version: "2", chainId: CHAIN_ID, verifyingContract: USDC });
const randomNonce = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const now = async () => (await pub.getBlock()).timestamp;

async function sign({ to = payee, value, validAfter = 0n, validBefore, nonce = randomNonce(), name }) {
	const message = { from: payer.address, to, value, validAfter, validBefore, nonce };
	const signature = await payer.signTypedData({ domain: domain(name), types: authTypes, primaryType: "TransferWithAuthorization", message });
	return { message, signature };
}
const argsOf = ({ message: m, signature }, override = {}) => {
	const { v, r, s } = parseSignature(signature);
	const x = { ...m, ...override };
	return [x.from, x.to, x.value, x.validAfter, x.validBefore, x.nonce, Number(v), r, s];
};
// Simulate first for the revert reason; on success, the facilitator broadcasts and waits for the receipt.
async function submit(label, auth, override) {
	const args = argsOf(auth, override);
	try {
		await pub.simulateContract({ account: fac.account, address: USDC, abi: usdcAbi, functionName: "transferWithAuthorization", args });
	} catch (e) {
		log(`  ${label}: REVERT "${revertReason(e)}"`);
		return { ok: false, args };
	}
	const hash = await fac.writeContract({ address: USDC, abi: usdcAbi, functionName: "transferWithAuthorization", args });
	const rc = await pub.waitForTransactionReceipt({ hash });
	log(`  ${label}: ${rc.status} tx ${hash} gasUsed ${rc.gasUsed}`);
	return { ok: rc.status === "success", rc, args };
}
const used = (nonce) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: "authorizationState", args: [payer.address, nonce] });
const balances = async (label) => log(`  ${label}: payer ${fmt(await usdc(pub, payer.address))}, payee ${fmt(await usdc(pub, payee))}, payer ETH ${await pub.getBalance({ address: payer.address })} wei`);

// A. The domain: which name makes the separator the token computes?
log("\nA. EIP-712 domain");
const onchain = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "DOMAIN_SEPARATOR" });
log(`  name() "${await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "name" })}" version() "${await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "version" })}"`);
log(`  DOMAIN_SEPARATOR() ${onchain}`);
log(`  computed with name "USDC":     ${domainSeparator({ domain: domain("USDC") })} match=${domainSeparator({ domain: domain("USDC") }) === onchain}`);
log(`  computed with name "USD Coin": ${domainSeparator({ domain: domain("USD Coin") })} match=${domainSeparator({ domain: domain("USD Coin") }) === onchain}`);

// B. Happy path: a payer holding no ETH pays 1 USDC; the facilitator pays the gas.
log("\nB. Happy path");
const slot = await setUsdc(pub, test, payer.address, 10_000_000n);
log(`  funded payer ${payer.address} with fork USDC via anvil_setStorageAt (balance mapping slot ${slot})`);
const facEthBefore = await pub.getBalance({ address: fac.account.address });
await balances("before");
const t0 = await now();
const a1 = await sign({ value: 1_000_000n, validBefore: t0 + 300n });
log(`  signed: to ${a1.message.to} value ${a1.message.value} validBefore now+300 nonce ${a1.message.nonce}`);
const again = await payer.signTypedData({ domain: domain(), types: authTypes, primaryType: "TransferWithAuthorization", message: a1.message });
log(`  signing the same stored message again gives the same bytes (RFC 6979): ${again === a1.signature}`);
log(`  authorizationState before: ${await used(a1.message.nonce)}`);
const r1 = await submit("facilitator submits", a1);
const ev = r1.rc.logs.filter((l) => getAddress(l.address) === getAddress(USDC)).length;
log(`  token logs in receipt: ${ev} (Transfer + AuthorizationUsed)`);
log(`  authorizationState after: ${await used(a1.message.nonce)}`);
await balances("after");
log(`  facilitator ETH spent: ${facEthBefore - (await pub.getBalance({ address: fac.account.address }))} wei`);

// C. Replay of the same authorization.
log("\nC. Replay the same signed authorization");
await submit("replay (simulated)", a1);
const replayHash = await fac.writeContract({ address: USDC, abi: usdcAbi, functionName: "transferWithAuthorization", args: argsOf(a1), gas: 200_000n });
const replayRc = await pub.waitForTransactionReceipt({ hash: replayHash });
log(`  replay forced on chain with fixed gas: status ${replayRc.status}, facilitator paid ${replayRc.gasUsed} gas`);
await balances("after replay");

// D. Validity window.
log("\nD. Validity window");
const t1 = await now();
const a2 = await sign({ value: 1_000_000n, validBefore: t1 + 60n });
await test.increaseTime({ seconds: 120 });
await test.mine({ blocks: 1 });
await submit("validBefore passed while waiting (now+60, then +120 s)", a2);
const t2 = await now();
const a3 = await sign({ value: 1_000_000n, validAfter: t2 + 3600n, validBefore: t2 + 7200n });
await submit("validAfter in the future", a3);
const a3b = await sign({ value: 1_000_000n, validBefore: t2 });
await submit("validBefore = latest block time (expired by inclusion: the check is block.timestamp < validBefore)", a3b);

// E. Tampering by the submitter.
log("\nE. Tampering");
const t3 = await now();
const a4 = await sign({ value: 1_000_000n, validBefore: t3 + 300n });
await submit("same signature, to = another address", a4, { to: other });
await submit("same signature, value = 2 USDC", a4, { value: 2_000_000n });
await submit("same signature, validBefore extended", a4, { validBefore: t3 + 999_999n });
const a5 = await sign({ value: 1_000_000n, validBefore: t3 + 300n, name: "USD Coin" });
await submit('signed with the Base mainnet domain name "USD Coin"', a5);
log(`  a4 still unused after the tampered attempts: authorizationState ${await used(a4.message.nonce)}; it remains settleable as signed:`);
await submit("a4 as signed", a4);

// F. Over the balance, then funded.
log("\nF. Authorization over the balance, settled after a top-up");
const t4 = await now();
const a6 = await sign({ value: 50_000_000n, validBefore: t4 + 600n });
await balances("before");
await submit("50 USDC with less in the wallet", a6);
log(`  authorizationState: ${await used(a6.message.nonce)}`);
await setUsdc(pub, test, payer.address, 100_000_000n);
log("  wallet topped up to 100 USDC");
await submit("same authorization after the top-up", a6);
await balances("after");

// G. Two signatures for one intent: distinct nonces both settle.
log("\nG. Re-signing the same intent with a fresh nonce");
const t5 = await now();
const b1 = await sign({ value: 1_000_000n, validBefore: t5 + 300n });
const b2 = await sign({ value: 1_000_000n, validBefore: t5 + 300n });
const before = await usdc(pub, payee);
await submit("first signature", b1);
await submit("second signature (same to/value, new nonce)", b2);
log(`  payee received ${fmt((await usdc(pub, payee)) - before)} for one intent`);

// H. Cancel: the payer can kill an unsettled authorization before it expires; the chain says which happened.
log("\nH. cancelAuthorization");
const t6 = await now();
const c1 = await sign({ value: 1_000_000n, validBefore: t6 + 300n });
const cancelSig = (nonce) => payer.signTypedData({ domain: domain(), types: cancelTypes, primaryType: "CancelAuthorization", message: { authorizer: payer.address, nonce } });
const cancel = async (label, nonce) => {
	const { v, r, s } = parseSignature(await cancelSig(nonce));
	const args = [payer.address, nonce, Number(v), r, s];
	try {
		await pub.simulateContract({ account: fac.account, address: USDC, abi: usdcAbi, functionName: "cancelAuthorization", args });
	} catch (e) { log(`  ${label}: REVERT "${revertReason(e)}"`); return; }
	const rc = await pub.waitForTransactionReceipt({ hash: await fac.writeContract({ address: USDC, abi: usdcAbi, functionName: "cancelAuthorization", args }) });
	log(`  ${label}: ${rc.status} (submitted by a relayer: the payer holds no ETH)`);
};
await cancel("cancel an unsettled authorization", c1.message.nonce);
log(`  authorizationState after cancel: ${await used(c1.message.nonce)}`);
await submit("settle after cancel", c1);
const c2 = await sign({ value: 1_000_000n, validBefore: t6 + 300n });
await submit("settle first", c2);
await cancel("cancel after settlement", c2.message.nonce);
// authorizationState is true for both outcomes; the indexed events tell paid from cancelled.
for (const [label, n] of [["c1 (cancelled)", c1.message.nonce], ["c2 (settled)", c2.message.nonce]]) {
	const q = (eventName) => pub.getContractEvents({ address: USDC, abi: usdcAbi, eventName, args: { authorizer: payer.address, nonce: n }, fromBlock: node.forkBlock });
	log(`  ${label}: authorizationState ${await used(n)}, AuthorizationUsed logs ${(await q("AuthorizationUsed")).length}, AuthorizationCanceled logs ${(await q("AuthorizationCanceled")).length}`);
}

node.stop();
log("\ndone");
process.exit(0);
