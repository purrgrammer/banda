// Micro-spike: what an unanswered keychain prompt does to a Node process.
//   node hang.mjs <service> <account> <n>
// Starts n AsyncEntry.getPassword calls with AbortSignal.timeout(2000) against an item behind an unanswered prompt,
// then asks the libuv threadpool for other work (fs.readFile, crypto.pbkdf2) and measures when everything settles.
import { pbkdf2 } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { AsyncEntry } from '@napi-rs/keyring'

const [service, account, n] = process.argv.slice(2)
const t0 = performance.now()
const at = () => Math.round(performance.now() - t0)
const log = {}
let ticks = 0
setInterval(() => ticks++, 100).unref()
for (let i = 0; i < Number(n); i++) {
	new AsyncEntry(service, account, { linux: { store: 'secret-service' } })
		.getPassword(AbortSignal.timeout(2000))
		.then((v) => (log[`get${i}`] = { settledAt: at(), ok: true, value: v === null ? null : 'present' }))
		.catch((e) => (log[`get${i}`] = { settledAt: at(), ok: false, error: String(e.message ?? e) }))
}
setTimeout(() => {
	readFile('/etc/hostname').then(() => (log.fsReadFile = { settledAt: at() }))
	promisify(pbkdf2)('x', 'y', 1, 32, 'sha256').then(() => (log.pbkdf2 = { settledAt: at() }))
}, 500)
setTimeout(() => {
	console.log(JSON.stringify({ n: Number(n), threadpool: process.env.UV_THREADPOOL_SIZE ?? '4 (default)', at: at(), heartbeats: ticks, log }))
	process.exit(0)
}, 8000)
