// Two senders, one wallet: the store's ledger vs viem's nonce manager; and a restart under Base's 'pending' semantics.
// usage: node concurrency.mjs
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootAnvil, openStore, requestSend, rpc, walletTxs, freePort, hex } from './lib.mjs'

const run = (args, env = {}) => new Promise((resolve) => {
	const p = spawn(process.execPath, ['--no-warnings', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
	let out = ''; let err = ''
	p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
	p.on('exit', (code) => resolve({ code, out, err }))
})
const lines = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l))
const rcpt = (n) => '0x' + (0x5000 + n).toString(16).padStart(40, '0')

async function storeTwoDaemons(mining, sameSends) {
	const anvil = await bootAnvil(mining === 'interval' ? ['--block-time', '1'] : [])
	const dir = mkdtempSync(join(tmpdir(), 'banda-spike-nonce-')); const dbPath = join(dir, 'store.db')
	try {
		const db = openStore(dbPath)
		for (let i = 0; i < 10; i++) { requestSend(db, `a${i}`, rcpt(i), 2000 + i); requestSend(db, `b${i}`, rcpt(100 + i), 3000 + i) }
		db.close()
		const env = (p) => (sameSends ? {} : { ONLY: p })
		const [x, y] = await Promise.all([run(['pipeline.mjs', dbPath, anvil.url], env('a')), run(['pipeline.mjs', dbPath, anvil.url], env('b'))])
		const txs = await walletTxs(anvil.url)
		const db2 = openStore(dbPath)
		const sends = db2.prepare('SELECT * FROM sends').all(); const ledger = db2.prepare('SELECT next FROM ledger').get().next
		const multi = db2.prepare('SELECT send_id, count(*) c FROM attempts GROUP BY send_id HAVING c > 1').all()
		db2.close()
		const dup = sends.filter((s) => txs.filter((t) => t.to.toLowerCase() === s.to_addr.toLowerCase() && t.value === BigInt(s.value)).length !== 1)
		const nonces = txs.map((t) => t.nonce).sort((p, q) => p - q)
		const contiguous = nonces.every((v, i) => v === i)
		const broadcastErrors = [...lines(x.out), ...lines(y.out)].filter((l) => l[1] === 'broadcast' && l[3] !== 'ok').map((l) => l[3])
		const tally = broadcastErrors.reduce((m, e) => ((m[e] = (m[e] ?? 0) + 1), m), {})
		console.log(`  store, ${sameSends ? 'two drivers on the SAME 20 sends' : 'two processes, 10 sends each'}, ${mining}: exits ${x.code}/${y.code}, wallet txs on chain ${txs.length}, nonces contiguous ${contiguous}, sends not landed exactly once ${dup.length}, all confirmed ${sends.every((s) => s.state === 'confirmed')}, ledger.next ${ledger}, sends with >1 attempt ${multi.length}, non-ok broadcast replies ${JSON.stringify(tally)}`)
	} finally { await anvil.stop(); rmSync(dir, { recursive: true, force: true }) }
}

async function viemTwoProcesses(procs) {
	const anvil = await bootAnvil([])
	try {
		const per = 20 / procs
		const outs = await Promise.all(Array.from({ length: procs }, (_, k) => run(['viem-sender.mjs', anvil.url, `P${k}`, String(per), String(5000 + 100 * k)])))
		const res = outs.flatMap((o) => lines(o.out))
		const txs = await walletTxs(anvil.url)
		const errs = res.filter((r) => !r.ok).reduce((m, r) => ((m[r.error] = (m[r.error] ?? 0) + 1), m), {})
		const landed = res.filter((r) => txs.some((t) => t.value === BigInt(r.value)))
		const claimedOkNotLanded = res.filter((r) => r.ok && !txs.some((t) => t.hash === r.hash))
		console.log(`  viem nonceManager, ${procs} process(es) x ${per} concurrent sends, automine: ok ${res.filter((r) => r.ok).length}/20, landed ${landed.length}/20, reported ok but not on chain ${claimedOkNotLanded.length}, errors ${JSON.stringify(errs)}`)
	} finally { await anvil.stop() }
}

/** A proxy that answers eth_getTransactionCount(addr, 'pending') with 'latest', as Base documents since Denim. */
async function basePendingProxy(target) {
	const port = await freePort()
	const server = http.createServer(async (req, res) => {
		let body = ''; for await (const c of req) body += c
		const msg = JSON.parse(body)
		const fix = (m) => (m.method === 'eth_getTransactionCount' && m.params?.[1] === 'pending' ? { ...m, params: [m.params[0], 'latest'] } : m)
		const out = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Array.isArray(msg) ? msg.map(fix) : fix(msg)) })
		res.writeHead(200, { 'content-type': 'application/json' }); res.end(await out.text())
	})
	await new Promise((r) => server.listen(port, '127.0.0.1', r))
	return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

async function restartUnderBasePending(viaProxy) {
	const anvil = await bootAnvil(['--no-mining'])
	const proxy = viaProxy ? await basePendingProxy(anvil.url) : null
	const url = proxy?.url ?? anvil.url
	try {
		const a = lines((await run(['viem-sender.mjs', url, 'A', '3', '7000'])).out)
		const b = lines((await run(['viem-sender.mjs', url, 'B-same-fee', '1', '7100'])).out)
		const c = lines((await run(['viem-sender.mjs', url, 'C-2x-fee', '1', '7200', '2'])).out)
		const content = (await rpc(anvil.url, 'txpool_content')).result.pending
		const atNonce0 = Object.values(content)[0]?.['0']
		await rpc(anvil.url, 'anvil_mine', [hex(1)])
		const txs = await walletTxs(anvil.url)
		const paid = (v) => txs.some((t) => t.value === BigInt(v))
		console.log(`  restart, pending=${viaProxy ? "'latest' (Base)" : "anvil's own (includes pool)"}: run A 3 sends ok=${a.filter((r) => r.ok).length}; after restart run B (same fee) -> ${b[0].ok ? 'ok' : b[0].error}; run C (2x fee) -> ${c[0].ok ? 'ok' : c[0].error}; pool nonce 0 holds value ${atNonce0 ? Number(BigInt(atNonce0.value)) : '-'}; after mining, landed: A0=${paid(7000)} A1=${paid(7001)} A2=${paid(7002)} B=${paid(7100)} C=${paid(7200)}`)
	} finally { await proxy?.close(); await anvil.stop() }
}

console.log('## two senders, one wallet')
await storeTwoDaemons('auto', false)
await storeTwoDaemons('interval', false)
await storeTwoDaemons('auto', true)
await storeTwoDaemons('interval', true)
await viemTwoProcesses(1)
await viemTwoProcesses(2)
console.log("\n## a restart with viem's nonce manager, Base 'pending' vs anvil 'pending'")
await restartUnderBasePending(false)
await restartUnderBasePending(true)
