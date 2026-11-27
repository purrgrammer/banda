// Gap D: the pool's answers on geth and reth (dev mode, in Docker), verbatim, for what the lane does:
// a rebroadcast of pending and of mined bytes, a fee bump of +9 %, +10 %, +12.5 %, a tip-only bump, the
// original bytes after a bump, a fee cap below the base fee, too little ETH, and a nonce gap.
// Each client runs twice: blocks only every 10 minutes (the pool keeps what it holds) and mining on demand.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { addr } from "micro-eth-signer";
import { freePort, rpcAt, signTransfer, num, hex, DEV0, DEV0_ADDR } from "../lib.mjs";

const GETH = "ethereum/client-go:v1.17.10";
const RETH = "ghcr.io/paradigmxyz/reth:v2.10.1";
const sh = (args) => spawnSync("docker", args, { encoding: "utf8" });
const started = [];
const volumes = [];
const cleanup = () => { for (const n of started) sh(["rm", "-f", n]); for (const v of volumes) sh(["volume", "rm", "-f", v]); started.length = 0; volumes.length = 0; };
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(1));

async function startNode(kind, mode, volume) {
	const name = `banda-spike-${randomBytes(6).toString("hex")}`;
	const port = await freePort();
	const geth = ["--dev", "--dev.period", mode === "pool" ? "600" : "0", ...(volume ? ["--datadir", "/data"] : []), "--http", "--http.addr", "0.0.0.0", "--http.port", "8545", "--http.api", "eth,net,web3,txpool", "--http.vhosts", "*", "--verbosity", "1"];
	const reth = ["node", "--dev", ...(mode === "pool" ? ["--dev.block-time", "600s"] : []), "--http", "--http.addr", "0.0.0.0", "--http.port", "8545", "--http.api", "eth,net,web3,txpool", "--datadir", "/tmp/reth", "--log.stdout.filter", "error"];
	const r = sh(["run", "-d", "--rm", "--name", name, ...(volume ? ["-v", `${volume}:/data`] : []), "-p", `127.0.0.1:${port}:8545`, kind === "geth" ? GETH : RETH, ...(kind === "geth" ? geth : reth)]);
	if (r.status !== 0) throw new Error(r.stderr);
	started.push(name);
	const rpc = rpcAt(`http://127.0.0.1:${port}`);
	for (let i = 0; i < 300; i++) {
		try { const c = await rpc("eth_chainId"); if (c.result) return { name, rpc, chainId: num(c.result) }; } catch {}
		await new Promise((res) => setTimeout(res, 200));
	}
	throw new Error(`${kind} did not start: ${sh(["logs", name]).stderr.slice(-500)}`);
}
const until = async (f, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
const said = (r) => (r.error ? `${r.error.code} "${r.error.message}"` : `ok ${String(r.result).slice(0, 18)}…`);

// Funds a fresh key. reth's dev chain funds the public dev accounts; geth's funds only its own unlocked account.
async function fund(n, kind, to, wei) {
	if (kind === "geth") {
		const [dev] = (await n.rpc("eth_accounts")).result;
		const r = await n.rpc("eth_sendTransaction", [{ from: dev, to, value: hex(wei) }]);
		if (r.error) throw new Error(`fund: ${said(r)}`);
		return r.result;
	}
	const nonce = num((await n.rpc("eth_getTransactionCount", [DEV0_ADDR, "pending"])).result);
	const t = signTransfer({ key: DEV0, to, value: wei, nonce, chainId: n.chainId, maxFee: 50n * 10n ** 9n, tip: 2n * 10n ** 9n });
	const r = await n.rpc("eth_sendRawTransaction", [t.raw]);
	if (r.error) throw new Error(`fund: ${said(r)}`);
	return r.result;
}
const fresh = () => { const key = `0x${randomBytes(32).toString("hex")}`; return { key, address: addr.fromPrivateKey(key) }; };
const G9 = 10n ** 9n;

async function poolCases(kind) {
	let key = DEV0;
	let n;
	if (kind === "geth") {
		// geth --dev funds only its own unlocked account, and with --dev.period 600 seals nothing for 600 s. So a
		// mine-on-demand run funds a fresh key, stops, and the same datadir restarts with blocks every 600 s.
		const volume = `banda-spike-${randomBytes(6).toString("hex")}`;
		volumes.push(volume);
		const f = fresh();
		const m = await startNode(kind, "mined", volume);
		await fund(m, kind, f.address, 10n ** 18n);
		await until(async () => BigInt((await m.rpc("eth_getBalance", [f.address, "latest"])).result ?? "0x0") > 0n);
		sh(["stop", "-t", "20", m.name]);
		n = await startNode(kind, "pool", volume);
		key = f.key;
	} else n = await startNode(kind, "pool");
	const out = [`### ${kind} (${kind === "geth" ? GETH : RETH}), blocks every 600 s, chain id ${n.chainId}`];
	const from = addr.fromPrivateKey(key);
	const base = BigInt((await n.rpc("eth_getBlockByNumber", ["latest", false])).result.baseFeePerGas);
	const nonce = num((await n.rpc("eth_getTransactionCount", [from, "latest"])).result);
	out.push(`  base fee ${base} wei; sender nonce ${nonce}`);
	const to = fresh().address;
	const F = 10n * G9, T = 1n * G9;
	const A = signTransfer({ key, to, value: 1n, nonce, chainId: n.chainId, maxFee: F, tip: T });
	const rows = [];
	const send = async (label, raw) => { const r = await n.rpc("eth_sendRawTransaction", [raw]); rows.push(`  ${label.padEnd(58)} -> ${said(r)}`); return r; };
	await send("A: value 1, cap 10 gwei, tip 1 gwei", A.raw);
	await send("A again, same bytes (pending)", A.raw);
	const other = (v, cap, tip) => signTransfer({ key, to, value: v, nonce, chainId: n.chainId, maxFee: cap, tip });
	await send("other payload, same fees", other(2n, F, T).raw);
	await send("other payload, cap and tip +9 %", other(3n, (F * 109n) / 100n, (T * 109n) / 100n).raw);
	const B = other(4n, (F * 110n) / 100n, (T * 110n) / 100n);
	await send("B: other payload, cap and tip +10 % exactly", B.raw);
	await send("tip only +100 % over B, same cap", other(5n, (F * 110n) / 100n, (T * 220n) / 100n).raw);
	await send("cap only +100 % over B, same tip", other(6n, (F * 220n) / 100n, (T * 110n) / 100n).raw);
	const C = other(7n, (F * 110n * 1125n) / 100000n, (T * 110n * 1125n) / 100000n);
	await send("C: cap and tip +12.5 % over B", C.raw);
	await send("A's bytes again, after two bumps", A.raw);
	const content = await n.rpc("txpool_content");
	const pend = content.result?.pending?.[from] ?? content.result?.pending?.[from.toLowerCase()] ?? Object.values(content.result?.pending ?? {})[0];
	const held = pend ? Object.values(pend).map((t) => t.hash) : [];
	rows.push(`  pool holds at nonce ${nonce}: ${held.length} tx, ${held[0] === C.hash ? "C" : held[0] === B.hash ? "B" : held[0] === A.hash ? "A" : held[0]}`);
	rows.push(`  eth_getTransactionByHash(A): ${JSON.stringify((await n.rpc("eth_getTransactionByHash", [A.hash])).result?.hash ?? null)}`);
	await send("nonce gap: nonce + 2, cap 10 gwei", signTransfer({ key, to, value: 1n, nonce: nonce + 2, chainId: n.chainId, maxFee: F, tip: T }).raw);
	rows.push(`  txpool_status: ${JSON.stringify((await n.rpc("txpool_status")).result)}`);
	await send("fee cap 1 wei below the base fee (nonce + 1)", signTransfer({ key, to, value: 1n, nonce: nonce + 1, chainId: n.chainId, maxFee: 1n, tip: 1n }).raw);
	await send(`fee cap base fee - 1 (${base - 1n} wei), tip 0, nonce + 1`, signTransfer({ key, to, value: 1n, nonce: nonce + 1, chainId: n.chainId, maxFee: base - 1n, tip: 0n }).raw);
	const poor = fresh();
	await send("a key with no ETH", signTransfer({ key: poor.key, to, value: 1n, nonce: 0, chainId: n.chainId, maxFee: F, tip: T }).raw);
	await send("wrong chain id (1)", signTransfer({ key, to, value: 1n, nonce: nonce + 1, chainId: 1, maxFee: F, tip: T }).raw);
	out.push(...rows);
	return out;
}

async function minedCases(kind) {
	const n = await startNode(kind, "mined");
	const out = [`### ${kind}, mining on demand, chain id ${n.chainId}`];
	let key = DEV0;
	if (kind === "geth") {
		const f = fresh();
		await fund(n, kind, f.address, 10n ** 18n);
		await until(async () => BigInt((await n.rpc("eth_getBalance", [f.address, "latest"])).result ?? "0x0") > 0n);
		key = f.key;
	}
	const from = addr.fromPrivateKey(key);
	const nonce = num((await n.rpc("eth_getTransactionCount", [from, "latest"])).result);
	const to = fresh().address;
	const A = signTransfer({ key, to, value: 1n, nonce, chainId: n.chainId, maxFee: 10n * G9, tip: G9 });
	const r = await n.rpc("eth_sendRawTransaction", [A.raw]);
	out.push(`  A sent: ${said(r)}`);
	const rc = await until(async () => (await n.rpc("eth_getTransactionReceipt", [A.hash])).result);
	out.push(`  A mined: status ${rc?.status} in block ${num(rc?.blockNumber)}`);
	const again = await n.rpc("eth_sendRawTransaction", [A.raw]);
	out.push(`  A's bytes again, after it was mined -> ${said(again)}`);
	const B = signTransfer({ key, to, value: 2n, nonce, chainId: n.chainId, maxFee: 20n * G9, tip: 2n * G9 });
	out.push(`  other bytes at the mined nonce, +100 % fees -> ${said(await n.rpc("eth_sendRawTransaction", [B.raw]))}`);
	const bal = BigInt((await n.rpc("eth_getBalance", [from, "latest"])).result);
	const big = signTransfer({ key, to, value: bal, nonce: nonce + 1, chainId: n.chainId, maxFee: 10n * G9, tip: G9 });
	out.push(`  value = the whole balance, so gas is not covered -> ${said(await n.rpc("eth_sendRawTransaction", [big.raw]))}`);
	const low = signTransfer({ key, to, value: 1n, nonce: nonce + 1, chainId: n.chainId, maxFee: 1n, tip: 0n });
	out.push(`  fee cap 1 wei -> ${said(await n.rpc("eth_sendRawTransaction", [low.raw]))}`);
	const base = BigInt((await n.rpc("eth_getBlockByNumber", ["latest", false])).result.baseFeePerGas);
	const under = signTransfer({ key, to, value: 1n, nonce: nonce + 1, chainId: n.chainId, maxFee: base - 1n, tip: 0n });
	const ru = await n.rpc("eth_sendRawTransaction", [under.raw]);
	out.push(`  fee cap base fee - 1 (${base - 1n} wei) at the next nonce -> ${said(ru)}`);
	if (!ru.error) {
		const seen = await until(async () => (await n.rpc("eth_getTransactionReceipt", [under.hash])).result, 6000);
		out.push(`    after 6 s: receipt ${seen ? `status ${seen.status}` : "none"}; txpool_status ${JSON.stringify((await n.rpc("txpool_status")).result)}; by hash ${(await n.rpc("eth_getTransactionByHash", [under.hash])).result ? "known" : "unknown"}`);
		const bumped = signTransfer({ key, to, value: 1n, nonce: nonce + 1, chainId: n.chainId, maxFee: 10n * G9, tip: G9 });
		out.push(`    then the same nonce with cap 10 gwei, tip 1 gwei -> ${said(await n.rpc("eth_sendRawTransaction", [bumped.raw]))}; receipt ${(await until(async () => (await n.rpc("eth_getTransactionReceipt", [bumped.hash])).result, 10000))?.status ?? "none"}`);
	}
	return out;
}

const lines = [];
try {
	for (const kind of ["geth", "reth"]) {
		lines.push(...(await poolCases(kind)), "");
		lines.push(...(await minedCases(kind)), "");
	}
} finally {
	console.log(lines.join("\n"));
	cleanup();
	const left = sh(["ps", "-a", "--filter", "name=banda-spike-", "--format", "{{.Names}}"]).stdout.trim();
	console.log(`containers left: ${left || "none"}`);
}
