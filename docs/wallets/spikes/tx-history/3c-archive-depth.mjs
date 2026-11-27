// Q: how far back does each public endpoint serve eth_getBalance (state depth bounds balance bisection)?
import { call, hex, rpc, sleep } from "./lib.mjs";
const WETH = "0x4200000000000000000000000000000000000006";
for (const url of process.argv.slice(2)) {
	const head = Number(await call(url, "eth_blockNumber"));
	let ok = 1000, bad = 40_000_000;
	const far = await rpc(url, "eth_getBalance", [WETH, hex(head - bad)]);
	if (far.body.result) { console.log(`${url}: serves head-${bad}`); continue; }
	let err = JSON.stringify(far.body.error).slice(0, 120);
	while (bad - ok > 50_000) {
		const mid = Math.floor((ok + bad) / 2);
		const r = await rpc(url, "eth_getBalance", [WETH, hex(head - mid)]);
		if (r.body.result) ok = mid; else { bad = mid; err = JSON.stringify(r.body.error).slice(0, 120); }
		await sleep(400);
	}
	console.log(`${url}: state served to ~head-${ok} (${(ok * 0.2 / 3600).toFixed(1)} h at 200 ms), refused at head-${bad}: ${err}`);
}
