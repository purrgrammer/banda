// Shared helpers for the tx-history spike. No dependencies: Node 24's fetch and WebSocket.
export const SEPOLIA_RPC = "https://sepolia.base.org";
export const BLOCKSCOUT = "https://base-sepolia.blockscout.com";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (Circle)
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5"; // AuthorizationUsed(address,bytes32)

export const hex = (n) => `0x${BigInt(n).toString(16)}`;
export const topicAddr = (a) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RL = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"];
export const rlHeaders = (h) => Object.fromEntries(RL.filter((k) => h.get(k) != null).map((k) => [k, h.get(k)]));

let id = 0;
/** One JSON-RPC call; never throws on HTTP or RPC errors, returns what came back. */
export async function rpc(url, method, params = []) {
	const t0 = performance.now();
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 200) };
	}
	return { status: res.status, ms: Math.round(performance.now() - t0), rl: rlHeaders(res.headers), body };
}

/** JSON-RPC result or throw, with a short retry on 429. */
export async function call(url, method, params = [], tries = 4) {
	for (let i = 0; ; i++) {
		const r = await rpc(url, method, params);
		if (r.body?.result !== undefined) return r.body.result;
		if (i + 1 < tries && (r.status === 429 || r.body?.error?.code === -32011)) {
			await sleep(1000 * (i + 1));
			continue;
		}
		throw new Error(`${method} -> HTTP ${r.status} ${JSON.stringify(r.body?.error ?? r.body)}`);
	}
}

export async function blockscout(path) {
	const t0 = performance.now();
	const res = await fetch(BLOCKSCOUT + path, { headers: { accept: "application/json" } });
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 200) };
	}
	return { status: res.status, ms: Math.round(performance.now() - t0), rl: rlHeaders(res.headers), body };
}

export const trim = (o, n = 300) => {
	const s = JSON.stringify(o);
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
