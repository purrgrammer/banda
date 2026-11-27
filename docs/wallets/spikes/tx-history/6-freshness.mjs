// Q: how fresh can incoming USDC be seen? (a) eth_subscribe("logs") over a public WebSocket, (b) polling
// eth_getLogs, (c) Blockscout. Measures arrival time minus block timestamp for transfers to a busy payee.
import { SEPOLIA_RPC, TRANSFER, USDC, blockscout, call, hex, sleep, topicAddr } from "./lib.mjs";

const PAYEE = process.argv[2] ?? "0xA849bbaD82F9edafDf9A5550CC874276138779d9";
const SECONDS = Number(process.argv[3] ?? 30);
const filter = { address: USDC, topics: [TRANSFER, null, topicAddr(PAYEE)] };
const blockTime = new Map();
const tsOf = async (url, n) => {
	if (!blockTime.has(n)) blockTime.set(n, Number((await call(url, "eth_getBlockByNumber", [hex(n), false])).timestamp) * 1000);
	return blockTime.get(n);
};
const stats = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? `n=${s.length} median=${s[Math.floor(s.length / 2)]} ms max=${s.at(-1)} ms` : "n=0";
};

// (a) WebSocket subscriptions.
for (const wss of ["wss://sepolia.base.org", "wss://base-sepolia-rpc.publicnode.com"]) {
	const lat = [];
	const outcome = await new Promise((resolve) => {
		let ws;
		try {
			ws = new WebSocket(wss);
		} catch (e) {
			resolve(`constructor failed: ${e.message}`);
			return;
		}
		const timer = setTimeout(() => {
			ws.close();
			resolve("ok");
		}, SECONDS * 1000);
		ws.onerror = (e) => {
			clearTimeout(timer);
			resolve(`error: ${e.message ?? e.type}`);
		};
		ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", filter] }));
		ws.onmessage = async (m) => {
			const now = Date.now();
			const d = JSON.parse(m.data);
			if (d.id === 1 && d.error) {
				clearTimeout(timer);
				ws.close();
				resolve(`subscribe refused: ${JSON.stringify(d.error)}`);
			}
			const log = d.params?.result;
			if (log?.blockNumber) lat.push(now - (await tsOf("https://base-sepolia-rpc.publicnode.com", Number(log.blockNumber))));
		};
	});
	console.log(`${wss} logs subscription (${SECONDS} s): ${outcome}; latency ${stats(lat)}`);
}

// (b) Polling eth_getLogs every 2 s from the last seen block; latency = first seen - block timestamp.
const lat = [];
let from = Number(await call(SEPOLIA_RPC, "eth_blockNumber"));
const until = Date.now() + SECONDS * 1000;
let polls = 0;
while (Date.now() < until) {
	const head = Number(await call(SEPOLIA_RPC, "eth_blockNumber"));
	if (head >= from) {
		const r = await call(SEPOLIA_RPC, "eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(Math.min(head, from + 200)) }]);
		polls++;
		const now = Date.now();
		for (const l of r) lat.push(now - (await tsOf(SEPOLIA_RPC, Number(l.blockNumber))));
		from = Math.min(head, from + 200) + 1;
	}
	await sleep(2000);
}
console.log(`poll eth_getLogs every 2 s (${polls} polls x 2 requests): latency ${stats(lat)}`);

// (c) Blockscout: how far behind the chain head its newest transfer to PAYEE is, sampled now.
const head = Number(await call(SEPOLIA_RPC, "eth_blockNumber"));
const r = await blockscout(`/api/v2/addresses/${PAYEE}/token-transfers?type=ERC-20&filter=to&token=${USDC}`);
const newest = r.body.items[0];
console.log(`blockscout newest transfer to payee: block ${newest.block_number}, rpc head ${head}, ${((Date.now() - Date.parse(newest.timestamp)) / 1000).toFixed(1)} s old`);
