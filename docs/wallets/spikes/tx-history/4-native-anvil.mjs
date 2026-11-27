// Q: can the daemon see every incoming native ETH movement without an indexer or traces?
// On a local anvil, make five kinds of native movement into wallet W, padded with empty blocks, plus a forged
// Transfer(from=W) log; then compare what eth_getLogs sees with what balance bisection finds.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { explain, bisector } from "./bisect.mjs";
import { TRANSFER, call, hex, sleep, topicAddr } from "./lib.mjs";

const port = await new Promise((res) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => res(p));
	});
});
const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
const URL = `http://127.0.0.1:${port}`;
const cleanup = () => anvil.kill("SIGTERM");
process.on("exit", cleanup);
for (let i = 0; ; i++) {
	try {
		await call(URL, "eth_chainId", [], 1);
		break;
	} catch {
		if (i > 50) throw new Error("anvil did not start");
		await sleep(100);
	}
}

const [, W, A, B] = await call(URL, "eth_accounts"); // anvil's unlocked dev accounts: W is the wallet watched
const ETH = 10n ** 18n;
const word = (a) => topicAddr(a).slice(2);
const initcode = (runtime) => {
	const L = (runtime.length / 2).toString(16).padStart(2, "0");
	return `0x60${L}600c60003960${L}6000f3${runtime}`; // CODECOPY runtime, RETURN it
};
const send = (tx) => call(URL, "eth_sendTransaction", [tx]);
const receipt = async (h) => {
	for (;;) {
		const r = await call(URL, "eth_getTransactionReceipt", [h]).catch(() => null);
		if (r) return r;
		await sleep(50);
	}
};
const deploy = async (runtime) => (await receipt(await send({ from: A, data: initcode(runtime) }))).contractAddress;
const pad = (n) => call(URL, "anvil_mine", [hex(n)]);

// Runtimes, hand-assembled: forward msg.value to calldata[0:32]; SELFDESTRUCT to calldata[0:32];
// emit Transfer(calldata[0:32], calldata[32:64], 0) from a contract that is no token at all.
const FORWARDER = await deploy("6000600060006000346000355af100");
const DESTRUCT = await deploy("600035ff");
const FAKE = await deploy(`6020356000357f${TRANSFER.slice(2)}60206000a300`);

const start = Number(await call(URL, "eth_blockNumber"));
const expected = [];
const at = async (h, kind, amount) => expected.push({ kind, amount, block: Number((await receipt(h)).blockNumber) });
await pad(500);
await at(await send({ from: A, to: W, value: hex(ETH) }), "direct", ETH);
await pad(700);
await at(await send({ from: A, to: FORWARDER, value: hex(ETH / 2n), data: `0x${word(W)}` }), "internal call", ETH / 2n);
await pad(300);
await at(await send({ from: A, to: DESTRUCT, value: hex(ETH / 4n), data: `0x${word(W)}` }), "selfdestruct", ETH / 4n);
await pad(900);
await at(await send({ from: W, to: B, value: hex(ETH / 10n) }), "own send", -(ETH / 10n));
await pad(200);
// Same block: W sends, and a contract pays W.
await call(URL, "evm_setAutomine", [false]);
const h1 = await send({ from: W, to: B, value: hex(ETH / 20n) });
const h2 = await send({ from: A, to: FORWARDER, value: hex((ETH * 3n) / 10n), data: `0x${word(W)}` });
await call(URL, "evm_mine");
await call(URL, "evm_setAutomine", [true]);
await at(h1, "own send (same block)", -(ETH / 20n));
await at(h2, "internal call (same block)", (ETH * 3n) / 10n);
await pad(400);
// A forged Transfer(from=W, to=B, 0) emitted by a contract that is not a token: costs W nothing.
const poison = await send({ from: A, to: FAKE, data: `0x${word(W)}${word(B)}` });
const poisonBlock = Number((await receipt(poison)).blockNumber);
await pad(600);
const end = Number(await call(URL, "eth_blockNumber"));
console.log(`anvil blocks ${start}..${end} (${end - start} blocks), wallet W=${W}`);
console.log("expected movements:", expected.map((e) => `${e.kind}@${e.block} ${Number(e.amount) / 1e18}`).join("; "));

// What logs show: any Transfer naming W, from any emitter.
const toW = await call(URL, "eth_getLogs", [{ fromBlock: hex(start), toBlock: hex(end), topics: [TRANSFER, null, topicAddr(W)] }]);
const fromW = await call(URL, "eth_getLogs", [{ fromBlock: hex(start), toBlock: hex(end), topics: [TRANSFER, topicAddr(W)] }]);
console.log(`\neth_getLogs Transfer(to=W): ${toW.length} logs; Transfer(from=W): ${fromW.length} logs (emitter ${fromW[0]?.address}, block ${Number(fromW[0]?.blockNumber)}, value ${BigInt(fromW[0]?.data ?? 0)}; the forged one at ${poisonBlock})`);

// What bisection finds.
const bis = bisector(URL);
const t0 = performance.now();
const changes = await bis.changes(W, start, end);
const ms = Math.round(performance.now() - t0);
console.log(`\nbalance bisection over ${end - start} blocks: ${changes.length} change blocks, ${bis.requests} state reads, ${ms} ms`);
for (const c of changes) {
	const e = await explain(URL, W, c);
	console.log(`  block ${e.block}: delta ${Number(e.delta) / 1e18} = own ${Number(e.own) / 1e18} + direct ${Number(e.direct) / 1e18} + other ${Number(e.other) / 1e18}`);
}
const byBlock = new Map();
for (const e of expected) byBlock.set(e.block, (byBlock.get(e.block) ?? []).concat(e.kind));
const found = new Set(changes.map((c) => c.block));
const missed = [...byBlock.keys()].filter((b) => !found.has(b));
const extra = [...found].filter((b) => !byBlock.has(b));
console.log(`\nverdict: expected blocks=${byBlock.size} found=${found.size} missed=${JSON.stringify(missed)} extra=${JSON.stringify(extra)} poison-block-reported=${found.has(poisonBlock)}`);
cleanup();
process.exit(missed.length || extra.length ? 1 : 0);
