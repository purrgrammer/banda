// Shared helpers for the gap micro-spikes: anvil on a port the system assigns, raw JSON-RPC that keeps
// errors verbatim. Only anvil's public dev keys and freshly generated keys are used.
import { spawn } from "node:child_process";
import net from "node:net";

export const DEV0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil public dev key 0
export const DEV0_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const DEV1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil public dev key 1
export const DEV1_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export const freePort = () =>
	new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

export const rpcAt = (url) => async (method, params = []) => {
	const r = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await r.text();
	try {
		return JSON.parse(text);
	} catch {
		return { error: { http: r.status, body: text.slice(0, 300) } };
	}
};

const children = new Set();
for (const ev of ["exit", "SIGINT", "SIGTERM"]) process.on(ev, () => { for (const c of children) stop(c); if (ev !== "exit") process.exit(1); });

export async function startAnvil(extra = []) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const port = await freePort();
		const proc = spawn("anvil", ["--port", String(port), "--host", "127.0.0.1", "--silent", ...extra], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		children.add(proc);
		proc.on("exit", () => children.delete(proc));
		let err = "";
		proc.stderr.on("data", (d) => { err += d; });
		const url = `http://127.0.0.1:${port}`;
		const rpc = rpcAt(url);
		for (let i = 0; i < 150; i++) {
			if (proc.exitCode !== null) break;
			try { const r = await rpc("eth_chainId"); if (r.result) return { url, rpc, proc, port, stop: () => stop(proc) }; } catch {}
			await new Promise((r) => setTimeout(r, 100));
		}
		stop(proc);
		if (!/in use/i.test(err)) throw new Error(`anvil did not start: ${err}`);
	}
	throw new Error("no free port for anvil");
}
function stop(proc) { try { proc.kill("SIGTERM"); } catch {} }

export const hex = (n) => `0x${BigInt(n).toString(16)}`;
export const num = (h) => (h == null ? null : Number(BigInt(h)));
export const big = (h) => (h == null ? null : BigInt(h));
export const res = (r) => (r.error ? { error: r.error } : r.result);

// Sign an EIP-1559 transfer with micro-eth-signer, deterministic (extraEntropy false), explicit chain id.
import { Transaction } from "micro-eth-signer";
export function signTransfer({ key, to, value = 1n, nonce, chainId, maxFee = 10n ** 10n, tip = 10n ** 9n, gasLimit = 21000n, data }) {
	const tx = Transaction.prepare({
		to, value: BigInt(value), nonce: BigInt(nonce), chainId: BigInt(chainId),
		maxFeePerGas: BigInt(maxFee), maxPriorityFeePerGas: BigInt(tip), gasLimit: BigInt(gasLimit),
		...(data ? { data } : {}),
	});
	const s = tx.signBy(key, false);
	return { raw: s.toHex(true), hash: s.hash };
}
