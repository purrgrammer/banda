// Does micro-eth-signer 0.20.1 sign deterministically by default? (anvil's public dev key #0, no funds involved)
import { Transaction } from "micro-eth-signer";
const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const fields = { to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", value: 1000n, nonce: 7n, chainId: 84532n,
  maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, gasLimit: 21000n };
const sig = (e) => Transaction.prepare(fields).signBy(pk, e).toHex();
const d1 = sig(), d2 = sig();
const f1 = sig(false), f2 = sig(false);
console.log(JSON.stringify({ defaultSameBytes: d1 === d2, extraEntropyFalseSameBytes: f1 === f2,
  defaultHash1: Transaction.fromHex(d1).hash, defaultHash2: Transaction.fromHex(d2).hash }, null, 1));
