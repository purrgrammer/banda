// Crash sweep: SIGKILL the pipeline at every boundary for every send, resume from the store, check the invariants on
// the chain. Then a random-time sweep (kills at arbitrary instants, repeatedly, until the run completes).
// usage: node crash-sweep.mjs [boundary|random|all] [randomRuns]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootAnvil, openStore, requestSend, rpc, walletTxs, sleep } from './lib.mjs'

const mode = process.argv[2] ?? 'all'
const randomRuns = Number(process.argv[3] ?? 20)
const K = 3
const recipients = Array.from({ length: 8 }, (_, i) => '0x' + (0x1000 + i).toString(16).padStart(40, '0'))

function spawnChild(db, url, env = {}) {
	const p = spawn(process.execPath, ['--no-warnings', 'pipeline.mjs', db, url], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
	let out = ''; let err = ''
	p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
	const done = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal, out: () => out, err: () => err })))
	return { p, done }
}

async function check(url, dbPath, n) {
	const db = openStore(dbPath)
	const sends = db.prepare('SELECT * FROM sends ORDER BY id').all()
	const attempts = db.prepare('SELECT send_id, count(*) c FROM attempts GROUP BY send_id').all()
	const ledger = db.prepare('SELECT next FROM ledger').get()
	db.close()
	const txs = await walletTxs(url)
	const problems = []
	for (const s of sends) {
		const onChain = txs.filter((t) => t.to.toLowerCase() === s.to_addr.toLowerCase() && t.value === BigInt(s.value))
		if (onChain.length !== 1) problems.push(`${s.id}: ${onChain.length} txs on chain`)
		if (s.state !== 'confirmed') problems.push(`${s.id}: state ${s.state}`)
		if (onChain[0] && onChain[0].hash !== s.hash) problems.push(`${s.id}: stored hash differs from chain`)
	}
	if (txs.length !== n) problems.push(`${txs.length} wallet txs on chain, expected ${n}`)
	const nonces = txs.map((t) => t.nonce).sort((a, b) => a - b)
	if (nonces.some((x, i) => x !== i)) problems.push(`nonces ${nonces}`)
	if (ledger?.next !== n) problems.push(`ledger.next ${ledger?.next} != ${n}`)
	return { ok: problems.length === 0, problems, attempts: Object.fromEntries(attempts.map((a) => [a.send_id, a.c])) }
}

async function snapshot(url) {
	const pool = (await rpc(url, 'txpool_status')).result
	const mined = (await walletTxs(url)).length
	return `mined=${mined} pool=${Number(BigInt(pool?.pending ?? 0))}+${Number(BigInt(pool?.queued ?? 0))}q`
}

async function setup(cfg, k) {
	const anvil = await bootAnvil(cfg.mining === 'interval' ? ['--block-time', '1'] : [], cfg.net)
	const dir = mkdtempSync(join(tmpdir(), 'banda-spike-nonce-'))
	const dbPath = join(dir, 'store.db')
	const db = openStore(dbPath)
	for (let i = 0; i < k; i++) requestSend(db, `s${i}`, recipients[i], 1000 + i)
	db.close()
	return { anvil, dir, dbPath }
}

const configs = [
	{ name: 'optimism/auto', net: ['--optimism'], mining: 'auto' },
	{ name: 'optimism/interval1s', net: ['--optimism'], mining: 'interval' },
	{ name: 'base/auto', net: ['-n', 'base'], mining: 'auto' },
]
const POINTS = { split: ['after-reserve', 'after-sign', 'after-checkpoint', 'mid-broadcast', 'after-broadcast', 'after-receipt'], fused: ['after-commit', 'mid-broadcast', 'after-broadcast', 'after-receipt'] }

let total = 0; let failed = 0
if (mode === 'boundary' || mode === 'all') {
	for (const cfg of configs) for (const variant of ['split', 'fused']) for (const point of POINTS[variant]) for (let v = 0; v < K; v++) {
		const { anvil, dir, dbPath } = await setup(cfg, K)
		try {
			const first = await spawnChild(dbPath, anvil.url, { KILL_AT: `${point}:s${v}`, FUSED: variant === 'fused' ? '1' : '0' }).done
			const atKill = await snapshot(anvil.url)
			const second = await spawnChild(dbPath, anvil.url, { FUSED: variant === 'fused' ? '1' : '0' }).done
			const res = await check(anvil.url, dbPath, K)
			const resumeLines = second.out().split('\n').filter((l) => l.includes(`"s${v}"`) && l.includes('broadcast')).map((l) => JSON.parse(l)[3]).join(',')
			total++; if (!res.ok || first.signal !== 'SIGKILL' || second.code !== 0) failed++
			console.log(`${cfg.name.padEnd(20)} ${variant.padEnd(5)} kill ${point.padEnd(16)} s${v} | first=${first.signal ?? first.code} at-kill ${atKill} | resume=${second.code} victim-broadcast=[${resumeLines}] attempts=${JSON.stringify(res.attempts)} | ${res.ok ? 'OK' : 'FAIL ' + res.problems.join('; ')}${second.code ? ' ' + second.err().slice(0, 300) : ''}`)
		} finally { await anvil.stop(); rmSync(dir, { recursive: true, force: true }) }
	}
}

if (mode === 'random' || mode === 'all') {
	const N = 5
	for (const variant of ['split', 'fused']) for (let r = 0; r < randomRuns; r++) {
		const cfg = configs[1] // interval mining: sends wait in the pool, so kills land in every state
		const { anvil, dir, dbPath } = await setup(cfg, N)
		try {
			let kills = 0; let last
			for (;;) {
				const c = spawnChild(dbPath, anvil.url, { FUSED: variant === 'fused' ? '1' : '0' })
				const delay = kills < 8 ? 50 + Math.floor(Math.random() * 700) : 1e9 // a run lasts about 1-2 s
				const t = setTimeout(() => c.p.kill('SIGKILL'), delay)
				last = await c.done; clearTimeout(t)
				if (last.signal === 'SIGKILL') { kills++; continue }
				break
			}
			const res = await check(anvil.url, dbPath, N)
			total++; if (!res.ok || last.code !== 0) failed++
			console.log(`random ${variant.padEnd(5)} run ${String(r).padStart(2)} kills=${kills} exit=${last.code} attempts=${JSON.stringify(res.attempts)} | ${res.ok ? 'OK' : 'FAIL ' + res.problems.join('; ')}${last.code ? ' ' + last.err().slice(0, 300) : ''}`)
		} finally { await anvil.stop(); rmSync(dir, { recursive: true, force: true }) }
	}
}
if (mode === 'bump' || mode === 'all') {
	// one payment whose first attempt gets stuck (the base fee jumps above its fee cap), so the pipeline replaces it at the
	// same nonce; killed at each replacement boundary, and at random instants
	const points = ['after-bump-sign', 'after-bump-checkpoint', 'mid-broadcast-bump', 'after-broadcast-bump', 'after-receipt']
	for (const point of [...points, ...Array(8).fill('random')]) {
		const anvil = await bootAnvil(['--no-mining'], ['--optimism'])
		const dir = mkdtempSync(join(tmpdir(), 'banda-spike-nonce-')); const dbPath = join(dir, 'store.db')
		const db = openStore(dbPath); requestSend(db, 's0', recipients[0], 1000)
		const base0 = BigInt((await rpc(anvil.url, 'eth_getBlockByNumber', ['latest', false])).result.baseFeePerGas)
		const high = base0 * 20n
		let mining = false; let busy = false
		const miner = setInterval(async () => {
			if (busy) return; busy = true
			try {
				if (!mining && db.prepare(`SELECT state FROM sends WHERE id = 's0'`).get().state === 'broadcast') mining = true
				if (mining) { await rpc(anvil.url, 'anvil_setNextBlockBaseFeePerGas', ['0x' + high.toString(16)]); await rpc(anvil.url, 'anvil_mine', ['0x1']) }
			} finally { busy = false }
		}, 250)
		try {
			const env = { BUMP_AFTER: '5' }
			let kills = 0; let last; const firstSignal = []
			for (;;) {
				const c = spawnChild(dbPath, anvil.url, point !== 'random' && kills === 0 ? { ...env, KILL_AT: `${point}:s0` } : env)
				const t = point === 'random' && kills < 8 ? setTimeout(() => c.p.kill('SIGKILL'), 50 + Math.floor(Math.random() * 900)) : null
				last = await c.done; if (t) clearTimeout(t)
				firstSignal.push(last.signal ?? last.code)
				if (last.signal === 'SIGKILL') { kills++; continue }
				break
			}
			const res = await check(anvil.url, dbPath, 1)
			const landed = db.prepare(`SELECT a.n FROM attempts a JOIN sends s ON s.hash = a.hash`).get()
			const ok = res.ok && last.code === 0 && (point === 'random' || kills >= 1)
			total++; if (!ok) failed++
			console.log(`bump kill ${point.padEnd(22)} kills=${kills} exit=${last.code} attempts=${res.attempts.s0} landed=attempt ${landed?.n} | ${ok ? 'OK' : 'FAIL ' + res.problems.join('; ') + (kills ? '' : ' (kill point never reached)')}${last.code ? ' ' + last.err().slice(0, 300) : ''}`)
		} finally { clearInterval(miner); db.close(); await anvil.stop(); rmSync(dir, { recursive: true, force: true }) }
	}
}
console.log(`\n${total - failed}/${total} runs held the invariants (one tx per send on chain, nonces contiguous, store confirmed, ledger == chain nonce)`)
await sleep(10)
process.exit(failed ? 1 : 0)
