// Micro-spike: one OS-keychain operation per invocation, through @napi-rs/keyring 2.1.2.
// The secret is made in-process and never passed on argv; processes compare sha256 fingerprints instead.
//   node kc.mjs set   <service> <account>            make a random 32-byte hex key, store it, print its fingerprint
//   node kc.mjs get   <service> <account> [ms]       AsyncEntry get with an AbortSignal timeout and a heartbeat
//   node kc.mjs del   <service> <account>            delete, print true/false
//   node kc.mjs bench <service> <account> [n]        latency (sync + async), missing item, overwrite, raw bytes
//   node kc.mjs race  <service> <account>            set a fresh random key (run many at once)
// Optional env KC_STORE=secret-service|keyutils pins the Linux store (ignored elsewhere).
import { createHash, randomBytes } from 'node:crypto'
import { AsyncEntry, Entry } from '@napi-rs/keyring'

const [cmd, service, account, arg] = process.argv.slice(2)
const opts = process.env.KC_STORE ? { linux: { store: process.env.KC_STORE } } : undefined
const fp = (s) => (s == null ? null : createHash('sha256').update(s).digest('hex').slice(0, 12))
const now = () => performance.now()
const out = (o) => console.log(JSON.stringify({ cmd, pid: process.pid, exe: process.execPath, ...o }))
const err = (e) => ({ name: e?.constructor?.name, code: e?.code, message: String(e?.message ?? e) })
const ms = (t) => Math.round((now() - t) * 100) / 100
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

async function main() {
	if (cmd === 'set' || cmd === 'race') {
		const key = randomBytes(32).toString('hex')
		const t = now()
		try {
			new Entry(service, account, opts).setPassword(key)
			out({ ok: true, fp: fp(key), ms: ms(t) })
		} catch (e) {
			out({ ok: false, ms: ms(t), error: err(e) })
		}
		return
	}
	if (cmd === 'get') {
		const timeout = Number(arg ?? 8000)
		let ticks = 0
		const hb = setInterval(() => ticks++, 100)
		const t = now()
		try {
			const v = await new AsyncEntry(service, account, opts).getPassword(AbortSignal.timeout(timeout))
			out({ ok: true, fp: fp(v), ms: ms(t), heartbeats: ticks })
		} catch (e) {
			out({ ok: false, ms: ms(t), heartbeats: ticks, error: err(e) })
		}
		clearInterval(hb)
		// a native call left blocked keeps a thread busy; report whether the loop would still drain on its own
		const alive = setTimeout(() => {
			out({ note: 'still alive 1s after get settled: exiting explicitly' })
			process.exit(0)
		}, 1000)
		alive.unref()
		return
	}
	if (cmd === 'del') {
		const t = now()
		try {
			out({ ok: true, deleted: new Entry(service, account, opts).deletePassword(), ms: ms(t) })
		} catch (e) {
			out({ ok: false, ms: ms(t), error: err(e) })
		}
		return
	}
	if (cmd === 'bench') {
		const n = Number(arg ?? 20)
		const e = new Entry(service, account, opts)
		const a = new AsyncEntry(service, account, opts)
		const r = { set: [], get: [], del: [], aset: [], aget: [], adel: [] }
		let mismatches = 0
		for (let i = 0; i < n; i++) {
			const key = randomBytes(32).toString('hex')
			let t = now(); e.setPassword(key); r.set.push(ms(t))
			t = now(); if (e.getPassword() !== key) mismatches++; r.get.push(ms(t))
			t = now(); e.deletePassword(); r.del.push(ms(t))
			t = now(); await a.setPassword(key); r.aset.push(ms(t))
			t = now(); if ((await a.getPassword()) !== key) mismatches++; r.aget.push(ms(t))
			t = now(); await a.deletePassword(); r.adel.push(ms(t))
		}
		const latency = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { median: median(v), max: Math.max(...v) }]))
		// missing item
		const missing = {}
		for (const [k, f] of [['getPassword', () => e.getPassword()], ['getSecret', () => e.getSecret()], ['deletePassword', () => e.deletePassword()]]) {
			try { missing[k] = { returned: f() } } catch (x) { missing[k] = { threw: err(x) } }
		}
		// overwrite: a second set on the same entry
		const k1 = randomBytes(32).toString('hex'), k2 = randomBytes(32).toString('hex')
		let overwrite
		try {
			e.setPassword(k1); e.setPassword(k2)
			const got = e.getPassword()
			overwrite = { secondSetThrew: false, holds: got === k2 ? 'second' : got === k1 ? 'first' : 'other' }
		} catch (x) { overwrite = { secondSetThrew: err(x) } }
		e.deletePassword()
		// raw bytes stored with setSecret, read back as a password string
		let raw
		try {
			const bytes = randomBytes(32); bytes[0] = 0xff // never valid UTF-8 as a first byte
			e.setSecret(bytes)
			const back = Buffer.from(e.getSecret())
			try { e.getPassword(); raw = { getSecretRoundTrip: back.equals(bytes), getPassword: 'returned' } }
			catch (x) { raw = { getSecretRoundTrip: back.equals(bytes), getPasswordThrew: err(x) } }
		} catch (x) { raw = { threw: err(x) } }
		e.deletePassword()
		out({ ok: true, n, mismatches, latency, missing, overwrite, raw })
		return
	}
	throw new Error(`unknown command ${cmd}`)
}
main().catch((e) => { out({ ok: false, fatal: err(e) }); process.exitCode = 1 })
