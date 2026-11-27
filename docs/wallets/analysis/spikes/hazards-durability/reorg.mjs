// After anvil_reorg removes the block holding our tx, is the tx back in the pool, or gone? And what does rebroadcast say?
import { Transaction } from "micro-eth-signer";
const url = `http://127.0.0.1:${process.argv[2]}`;
let id = 0;
const rpc = async (method, params = []) => {
  const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  return r.error ? { error: r.error } : r.result;
};
const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil dev key #0
const from = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const nonce = BigInt(await rpc("eth_getTransactionCount", [from, "latest"]));
const block = await rpc("eth_getBlockByNumber", ["latest", false]);
const tx = Transaction.prepare({ to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", value: 1n, nonce, chainId: 84532n,
  maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n, gasLimit: 21000n }).signBy(pk, false);
const raw = tx.toHex(true);
const out = {};
out.send = await rpc("eth_sendRawTransaction", [raw]);
const until = async (f) => { for (let i = 0; i < 50; i++) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
out.receiptBefore = (await until(() => rpc("eth_getTransactionReceipt", [tx.hash])))?.blockNumber ?? null;
out.latestNonceBeforeReorg = await rpc("eth_getTransactionCount", [from, "latest"]);
out.reorg = await rpc("anvil_reorg", [1, []]);
out.receiptAfterReorg = (await rpc("eth_getTransactionReceipt", [tx.hash]))?.blockNumber ?? null;
out.txAfterReorg = await rpc("eth_getTransactionByHash", [tx.hash]);
out.poolAfterReorg = await rpc("txpool_status");
out.latestNonceAfterReorg = await rpc("eth_getTransactionCount", [from, "latest"]);
out.pendingNonceAfterReorg = await rpc("eth_getTransactionCount", [from, "pending"]);
out.rebroadcast = await rpc("eth_sendRawTransaction", [raw]);
await rpc("evm_mine");
out.receiptAfterRebroadcast = (await until(() => rpc("eth_getTransactionReceipt", [tx.hash])))?.blockNumber ?? null;
out.rebroadcastAfterMined = await rpc("eth_sendRawTransaction", [raw]);
console.log(JSON.stringify(out, (k, v) => (k === "txAfterReorg" && v && typeof v === "object" ? { blockNumber: v.blockNumber } : v), 1));
