// Gap A: what anvil 1.9.0's `safe` and `finalized` tags follow, what state a read at those tags sees, and
// what anvil_reorg and timestamps do under --no-mining. Only anvil's public dev keys; no network.
import { startAnvil, hex, num, big, res, signTransfer, DEV0, DEV0_ADDR, DEV1_ADDR } from "../lib.mjs";

const log = (...a) => console.log(...a);
const heads = async (rpc) => {
	const out = {};
	for (const t of ["latest", "safe", "finalized"]) out[t] = num((await rpc("eth_getBlockByNumber", [t, false])).result?.number);
	return out;
};

// 1. --slots-in-an-epoch N vs the tags, at heights 0, N, 2N, 2N+1 and 100
log("## 1. safe and finalized against --slots-in-an-epoch (--no-mining, anvil_mine)");
for (const [label, args] of [
	["default (no flag)", []],
	["--slots-in-an-epoch 1", ["--slots-in-an-epoch", "1"]],
	["--slots-in-an-epoch 4", ["--slots-in-an-epoch", "4"]],
	["--slots-in-an-epoch 32", ["--slots-in-an-epoch", "32"]],
	["--optimism --slots-in-an-epoch 2", ["--optimism", "--slots-in-an-epoch", "2"]],
	["-n base --slots-in-an-epoch 2", ["-n", "base", "--slots-in-an-epoch", "2"]],
]) {
	const a = await startAnvil(["--no-mining", ...args]);
	const rows = [];
	let h = 0;
	for (const target of [0, 1, 2, 4, 5, 8, 9, 64, 65, 100]) {
		if (target > h) { await a.rpc("anvil_mine", [hex(target - h)]); h = target; }
		const x = await heads(a.rpc);
		rows.push(`${x.latest}/${x.safe}/${x.finalized}`);
	}
	log(`  ${label.padEnd(34)} latest/safe/finalized: ${rows.join("  ")}`);
	a.stop();
}

// 2. What a read at safe/finalized sees after anvil_setBalance and after transactions
log("\n## 2. state seen at each tag (--no-mining --slots-in-an-epoch 2)");
{
	const a = await startAnvil(["--no-mining", "--slots-in-an-epoch", "2", "--chain-id", "31337"]);
	const W = "0x00000000000000000000000000000000000Ba1a0";
	await a.rpc("anvil_mine", [hex(10)]);
	const bal = async () => {
		const o = {};
		for (const t of ["latest", "safe", "finalized"]) o[t] = res(await a.rpc("eth_getBalance", [W, t]));
		return JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? big(v).toString() : v])));
	};
	log(`  before setBalance                    ${await bal()}`);
	await a.rpc("anvil_setBalance", [W, hex(10n ** 18n)]);
	log(`  after setBalance, no block mined     ${await bal()}`);
	await a.rpc("evm_mine", []);
	log(`  +1 block                             ${await bal()}`);
	await a.rpc("evm_mine", []); await a.rpc("evm_mine", []);
	log(`  +3 blocks (past safe = latest-2)     ${await bal()}`);
	await a.rpc("anvil_mine", [hex(2)]);
	log(`  +5 blocks (past finalized = latest-4) ${await bal()}`);

	// nonce counts at the tags while dev account 0 sends 3 transactions, one per block
	const counts = async () => {
		const o = [];
		for (const t of ["latest", "pending", "safe", "finalized"]) o.push(`${t}=${num(res(await a.rpc("eth_getTransactionCount", [DEV0_ADDR, t])))}`);
		return o.join(" ");
	};
	for (let n = 0; n < 3; n++) {
		const tx = signTransfer({ key: DEV0, to: DEV1_ADDR, nonce: n, chainId: 31337 });
		const sent = await a.rpc("eth_sendRawTransaction", [tx.raw]);
		log(`  sent nonce ${n}: ${sent.error ? JSON.stringify(sent.error) : "accepted"}; before mining: ${await counts()}`);
		await a.rpc("evm_mine", []);
		log(`    mined: ${await counts()}`);
	}
	for (let i = 0; i < 4; i++) { await a.rpc("evm_mine", []); log(`    +1 empty block: ${await counts()}`); }
	a.stop();
}

// 3. anvil_reorg under --no-mining: depth within and beyond finalized
log("\n## 3. anvil_reorg under --no-mining (--slots-in-an-epoch 1: safe = latest-1, finalized = latest-2)");
{
	const a = await startAnvil(["--no-mining", "--slots-in-an-epoch", "1", "--chain-id", "31337"]);
	const A = signTransfer({ key: DEV0, to: DEV1_ADDR, value: 7n, nonce: 0, chainId: 31337 });
	const B = signTransfer({ key: DEV0, to: DEV1_ADDR, value: 8n, nonce: 1, chainId: 31337 });
	const C = signTransfer({ key: DEV0, to: DEV1_ADDR, value: 9n, nonce: 2, chainId: 31337 });
	const blockOf = async (h) => num((await a.rpc("eth_getTransactionReceipt", [h])).result?.blockNumber);
	const where = async () => `A@${await blockOf(A.hash)} B@${await blockOf(B.hash)} C@${await blockOf(C.hash)}`;
	await a.rpc("eth_sendRawTransaction", [A.raw]); await a.rpc("evm_mine", []);          // block 1
	await a.rpc("anvil_mine", [hex(6)]);                                                    // blocks 2..7
	await a.rpc("eth_sendRawTransaction", [B.raw]); await a.rpc("evm_mine", []);          // block 8
	await a.rpc("anvil_mine", [hex(1)]);                                                    // block 9
	await a.rpc("eth_sendRawTransaction", [C.raw]); await a.rpc("evm_mine", []);          // block 10
	log(`  before: ${await where()}; heads ${JSON.stringify(await heads(a.rpc))}`);
	const r1 = await a.rpc("anvil_reorg", [1, []]);
	log(`  anvil_reorg(1, []) -> ${JSON.stringify(r1.error ?? r1.result)}; ${await where()}; heads ${JSON.stringify(await heads(a.rpc))}; pool ${JSON.stringify(res(await a.rpc("txpool_status")))}`);
	const r2 = await a.rpc("anvil_reorg", [3, []]);
	log(`  anvil_reorg(3, []), reaching block 8 = the finalized head -> ${JSON.stringify(r2.error ?? r2.result)}; ${await where()}; heads ${JSON.stringify(await heads(a.rpc))}`);
	const r3 = await a.rpc("anvil_reorg", [10, []]);
	log(`  anvil_reorg(10, []), reaching block 1 -> ${JSON.stringify(r3.error ?? r3.result)}; ${await where()}; heads ${JSON.stringify(await heads(a.rpc))}`);
	log(`    after: by hash A ${JSON.stringify((await a.rpc("eth_getTransactionByHash", [A.hash])).result?.blockNumber ?? null)}; pool ${JSON.stringify(res(await a.rpc("txpool_status")))}; count latest ${num(res(await a.rpc("eth_getTransactionCount", [DEV0_ADDR, "latest"])))}`);
	for (const t of [A, B, C]) {
		const again = await a.rpc("eth_sendRawTransaction", [t.raw]);
		log(`  rebroadcast stored bytes -> ${JSON.stringify(again.error ?? (again.result === t.hash ? "same hash" : again.result))}`);
	}
	await a.rpc("evm_mine", []);
	log(`  mined: ${await where()}`);
	const r4 = await a.rpc("anvil_reorg", [2, [[C.raw, 0]]]);
	log(`  anvil_reorg(2, [[C.raw, 0]]) -> ${JSON.stringify(r4.error ?? r4.result)}; ${await where()}; heads ${JSON.stringify(await heads(a.rpc))}`);
	a.stop();
}

// 4. Timestamps under --no-mining
log("\n## 4. block timestamps under --no-mining");
{
	const a = await startAnvil(["--no-mining", "--chain-id", "31337"]);
	const ts = async (t = "latest") => num((await a.rpc("eth_getBlockByNumber", [t, false])).result.timestamp);
	const wall = () => Math.floor(Date.now() / 1000);
	await a.rpc("evm_mine", []);
	log(`  latest ts - wall clock after one evm_mine: ${(await ts()) - wall()} s`);
	const target = wall() + 3600;
	const r = await a.rpc("evm_setNextBlockTimestamp", [target]);
	await a.rpc("evm_mine", []);
	log(`  evm_setNextBlockTimestamp(wall+3600) -> ${JSON.stringify(r.error ?? r.result)}; next block ts - target = ${(await ts()) - target}`);
	await a.rpc("evm_mine", []);
	log(`  following evm_mine: ts - previous = ${(await ts()) - target} s (chain time stays ahead of the wall clock)`);
	const back = await a.rpc("evm_setNextBlockTimestamp", [target - 100]);
	log(`  evm_setNextBlockTimestamp(earlier than latest) -> ${JSON.stringify(back.error ?? back.result)}`);
	const m = await a.rpc("evm_mine", [{ timestamp: target + 5000, blocks: 1 }]);
	log(`  evm_mine({timestamp}) -> ${JSON.stringify(m.error ?? m.result)}; ts - target = ${(await ts()) - target}`);
	a.stop();
}
