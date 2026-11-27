// Shared helpers for the nonce-and-crash spike: anvil boot, raw JSON-RPC, the store, signing, the send pipeline.
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Transaction, addr } from 'micro-eth-signer'

// anvil's public dev key 0 (no funds anywhere real). Never a real key.
export const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const WALLET = addr.fromPrivateKey(KEY)
export const CHAIN = 31337
export const GWEI = 1_000_000_000n

export const freePort = () => new Promise((res, rej) => {
	const s = net.createServer(); s.unref(); s.on('error', rej)
	s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

/** Raw JSON-RPC: returns the whole reply ({result} or {error}) so error codes and messages are recorded verbatim. */
export async function rpc(url, method, params = []) {
	const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
	return r.json()
}

/** A fresh anvil on a port the system picked. `net` is '--optimism' (default) or e.g. ['-n','base']. */
export async function bootAnvil(extra = [], net = ['--optimism']) {
	const port = await freePort(); const url = `http://127.0.0.1:${port}`
	const proc = spawn('anvil', ['--port', String(port), '--chain-id', String(CHAIN), '--silent', ...net, ...extra], { stdio: 'ignore' })
	for (let i = 0; i < 100; i++) { try { await rpc(url, 'eth_chainId'); break } catch { await sleep(100) } }
	return { url, proc, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL') }) }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const hex = (n) => '0x' + BigInt(n).toString(16)

export function classify(error) {
	if (!error) return 'ok'
	const m = String(error.message).toLowerCase()
	if (/already known|already imported/.test(m)) return 'known'
	if (/nonce too low/.test(m)) return 'nonce-low'
	if (/replacement transaction underpriced/.test(m)) return 'underpriced'
	if (/insufficient funds/.test(m)) return 'funds'
	if (/max fee per gas less than block base fee/.test(m)) return 'fee-low'
	return 'other'
}

/** Signs an EIP-1559 transfer. `hedged` mirrors micro-eth-signer's default (extraEntropy = true). */
export function sign({ to, value, nonce, maxFee, tip, key = KEY, hedged = true }) {
	const tx = Transaction.prepare({ to, value: BigInt(value), nonce: BigInt(nonce), maxFeePerGas: BigInt(maxFee), maxPriorityFeePerGas: BigInt(tip), gasLimit: 21000n, chainId: BigInt(CHAIN) })
	const signed = tx.signBy(key, hedged)
	return { raw: signed.toHex(true), hash: signed.hash }
}

export function openStore(path) {
	const db = new DatabaseSync(path)
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;
	CREATE TABLE IF NOT EXISTS ledger(wallet TEXT, chain INTEGER, next INTEGER NOT NULL, PRIMARY KEY(wallet, chain));
	CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY, wallet TEXT, chain INTEGER, to_addr TEXT, value TEXT, nonce INTEGER,
	  state TEXT NOT NULL, hash TEXT, block INTEGER, note TEXT);
	CREATE TABLE IF NOT EXISTS attempts(send_id TEXT, n INTEGER, nonce INTEGER, max_fee TEXT, tip TEXT, raw TEXT, hash TEXT,
	  PRIMARY KEY(send_id, n));`)
	return db
}

/** One commit: BEGIN IMMEDIATE takes the write lock up front, so two processes reserving never read the same `next`. */
export function commit(db, fn) {
	db.exec('BEGIN IMMEDIATE')
	try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
}

export function requestSend(db, id, to, value) {
	db.prepare(`INSERT OR IGNORE INTO sends(id, wallet, chain, to_addr, value, state) VALUES(?,?,?,?,?, 'requested')`).run(id, WALLET, CHAIN, to, String(value))
}

/** Sends a raw tx over node:http so a kill can land after the bytes left the process but before the reply is read. */
export function sendRaw(url, raw, onFlushed) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
		const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
			let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(JSON.parse(s)))
		})
		req.on('error', reject)
		req.on('finish', () => onFlushed?.())
		req.end(body)
	})
}

async function fees(url) {
	const b = (await rpc(url, 'eth_getBlockByNumber', ['latest', false])).result
	const base = BigInt(b.baseFeePerGas ?? '0x0'); const tip = 1n * GWEI
	return { maxFee: base * 2n + tip, tip }
}

async function receiptOf(url, hash) { return (await rpc(url, 'eth_getTransactionReceipt', [hash])).result }
async function chainNonce(url, tag = 'latest') { return Number(BigInt((await rpc(url, 'eth_getTransactionCount', [WALLET, tag])).result)) }

/**
 * Drives one send to a receipt, resuming from whatever the store says. Every step re-reads the store, so a run killed
 * anywhere and started again continues the same send, never a second one.
 *   fused=false: reserve nonce (commit) -> sign -> checkpoint raw (commit) -> broadcast -> receipt (commit)
 *   fused=true : fetch fees, then ONE commit takes the nonce and stores the signed bytes -> broadcast -> receipt
 * A stuck attempt (no receipt after `bumpAfterPolls` broadcasts) or one under the base fee is replaced by a new attempt
 * of the SAME payment at the SAME nonce, fees >= +12.5%: whichever attempt lands, the payment lands once.
 * `kill(point)` is the fault hook. `log` records what happened.
 */
export async function drive(db, url, id, { kill = () => {}, fused = false, reconcile = true, log = () => {}, pollMs = 100, foreignTag = 'latest', bumpAfterPolls = Infinity } = {}) {
	const polls = new Map() // per attempt hash, in memory: a restart only waits again before bumping
	const get = () => db.prepare('SELECT * FROM sends WHERE id = ?').get(id)
	const lastAttempt = () => db.prepare('SELECT * FROM attempts WHERE send_id = ? ORDER BY n DESC LIMIT 1').get(id)
	const reserve = (chainLatest) => {
		const now = get() // precondition re-checked inside the commit: a second driver of the same send must not take a second nonce
		if (now.nonce !== null) return now.nonce
		db.prepare('INSERT OR IGNORE INTO ledger(wallet, chain, next) VALUES(?,?,?)').run(WALLET, CHAIN, chainLatest)
		const row = db.prepare('SELECT next FROM ledger WHERE wallet = ? AND chain = ?').get(WALLET, CHAIN)
		const nonce = reconcile ? Math.max(row.next, chainLatest) : row.next // a nonce taken behind our back while idle
		db.prepare('UPDATE ledger SET next = ? WHERE wallet = ? AND chain = ?').run(nonce + 1, WALLET, CHAIN)
		db.prepare(`UPDATE sends SET nonce = ?, state = 'reserved' WHERE id = ?`).run(nonce, id)
		return nonce
	}
	const checkpoint = (s, nonce, f, signed) => {
		const n = (lastAttempt()?.n ?? -1) + 1
		db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run(id, n, nonce, String(f.maxFee), String(f.tip), signed.raw, signed.hash)
		db.prepare(`UPDATE sends SET state = 'signed' WHERE id = ?`).run(id)
	}
	for (;;) {
		let s = get()
		if (s.state === 'confirmed') return s
		if (s.nonce === null) {
			const chainLatest = reconcile ? await chainNonce(url) : 0
			if (fused) {
				const f = await fees(url)
				commit(db, () => { const nonce = reserve(chainLatest); checkpoint(get(), nonce, f, sign({ to: s.to_addr, value: s.value, nonce, ...f })) })
				log(id, 'reserved+signed (one commit)'); kill('after-commit'); continue
			}
			commit(db, () => reserve(chainLatest)); log(id, 'reserved', get().nonce); kill('after-reserve'); continue
		}
		let a = lastAttempt()
		if (!a || a.nonce !== s.nonce) {
			const f = await fees(url)
			const signed = sign({ to: s.to_addr, value: s.value, nonce: s.nonce, ...f })
			kill('after-sign')
			commit(db, () => checkpoint(s, s.nonce, f, signed)); log(id, 'checkpointed', signed.hash); kill('after-checkpoint'); continue
		}
		// already landed? (a crash after broadcast, or a broadcast whose reply was lost). The nonce is read BEFORE the
		// receipts: if the nonce was consumed by then and none of our hashes has a receipt after, the consumer is foreign.
		const consumed = (await chainNonce(url, foreignTag)) > s.nonce
		const attempts = db.prepare('SELECT * FROM attempts WHERE send_id = ? AND nonce = ?').all(id, s.nonce)
		for (const at of attempts) {
			const r = await receiptOf(url, at.hash)
			if (r) {
				kill('after-receipt')
				commit(db, () => db.prepare(`UPDATE sends SET state = 'confirmed', hash = ?, block = ? WHERE id = ?`).run(at.hash, Number(BigInt(r.blockNumber)), id))
				log(id, 'confirmed', at.hash, 'block', Number(BigInt(r.blockNumber))); return get()
			}
		}
		// nonce consumed by a transaction that is none of ours -> this nonce can never carry this payment: take a new one
		if (consumed) {
			commit(db, () => db.prepare(`UPDATE sends SET nonce = NULL, state = 'requested', note = coalesce(note,'') || ? WHERE id = ?`).run(`nonce ${s.nonce} taken by a foreign tx; `, id))
			log(id, 'nonce taken by foreign tx, re-reserving'); continue
		}
		const tag = a.n > 0 ? '-bump' : ''
		const reply = await sendRaw(url, a.raw, () => kill('mid-broadcast' + tag))
		kill('after-broadcast' + tag)
		const c = classify(reply.error)
		log(id, 'broadcast', a.hash, c, reply.error ? JSON.stringify(reply.error) : '')
		if (s.state !== 'broadcast' && (c === 'ok' || c === 'known')) commit(db, () => db.prepare(`UPDATE sends SET state = 'broadcast' WHERE id = ?`).run(id))
		if (c === 'funds' || c === 'other') throw new Error(`send ${id}: ${JSON.stringify(reply.error)}`)
		polls.set(a.hash, (polls.get(a.hash) ?? 0) + 1)
		if (c === 'fee-low' || ((c === 'ok' || c === 'known') && polls.get(a.hash) >= bumpAfterPolls)) {
			const now = await fees(url); const up = (x) => (BigInt(x) * 9n) / 8n + 1n
			const f = { maxFee: now.maxFee > up(a.max_fee) ? now.maxFee : up(a.max_fee), tip: now.tip > up(a.tip) ? now.tip : up(a.tip) }
			const signed = sign({ to: s.to_addr, value: s.value, nonce: s.nonce, ...f })
			kill('after-bump-sign')
			commit(db, () => checkpoint(s, s.nonce, f, signed)); log(id, 'bumped', signed.hash, `maxFee ${a.max_fee} -> ${f.maxFee}`); kill('after-bump-checkpoint'); continue
		}
		// ok/known: wait for a receipt; nonce-low: the loop checks receipts, then the foreign-tx rule; underpriced: a foreign
		// pending tx holds our nonce, wait for it to settle (the foreign-tx rule decides once it is mined)
		await sleep(pollMs)
	}
}

/** Every value-bearing tx the wallet sent, read from the chain (the ground truth for the invariants). */
export async function walletTxs(url, from = WALLET) {
	const latest = Number(BigInt((await rpc(url, 'eth_blockNumber')).result))
	const out = []
	for (let b = 0; b <= latest; b++) {
		const blk = (await rpc(url, 'eth_getBlockByNumber', [hex(b), true])).result
		for (const t of blk.transactions) if (t.from.toLowerCase() === from.toLowerCase()) out.push({ block: b, nonce: Number(BigInt(t.nonce)), to: t.to, value: BigInt(t.value), hash: t.hash })
	}
	return out
}
