// Micro-spike (macOS): the same set/get/delete through `security -i`, commands on stdin so the key is never in argv.
//   node security-i.mjs
// Prints JSON: per-command latency (one `security -i` process per command, spawn included), what a missing item and a
// duplicate add do, and how many processes showed the key in their argv while `security -i` held it.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const svc = `banda-spike-${randomBytes(6).toString('hex')}`
const acct = `home-${randomBytes(4).toString('hex')}/wallet/0`
const key = randomBytes(32).toString('hex')
const fp = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const argvHits = () => execFileSync('ps', ['-axww', '-o', 'pid=,command=']).toString().split('\n').filter((l) => l.includes(key)).length

/** Runs one or more lines through `security -i`; `hold` ms keeps stdin open first (for the argv check). */
function sec(lines, hold = 0) {
	return new Promise((resolve) => {
		const t = performance.now()
		const p = spawn('security', ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] })
		let so = '', se = '', hits
		p.stdout.on('data', (d) => (so += d))
		p.stderr.on('data', (d) => (se += d))
		p.on('exit', (code) => resolve({ code, ms: Math.round((performance.now() - t) * 10) / 10, stdout: so, stderr: se.trim(), hits }))
		p.stdin.write(`${lines.join('\n')}\n`)
		if (!hold) return p.stdin.end()
		setTimeout(() => { hits = argvHits(); p.stdin.end() }, hold)
	})
}
const clean = (s) => s.replaceAll('security> ', '').trim()
const q = (s) => `"${s}"`
const add = (extra = '') => `add-generic-password ${extra}-s ${q(svc)} -a ${q(acct)} -w ${key}`
const find = `find-generic-password -s ${q(svc)} -a ${q(acct)} -w`
const del = `delete-generic-password -s ${q(svc)} -a ${q(acct)}`

const r = {}
const a = await sec([add()], 400)
r.add = { code: a.code, ms: a.ms, stderr: a.stderr, processesWithKeyInArgv: a.hits }
const g = await sec([find])
r.get = { code: g.code, ms: g.ms, matches: clean(g.stdout) === key, fpStored: fp(clean(g.stdout)), fpMade: fp(key) }
const dup = await sec([add()])
r.addAgainWithoutU = { code: dup.code, stderr: dup.stderr }
const up = await sec([add('-U ')])
r.addAgainWithU = { code: up.code, stderr: up.stderr }
const d = await sec([del])
r.delete = { code: d.code, ms: d.ms, stderr: d.stderr.split('\n')[0] }
const gm = await sec([find])
r.getMissing = { code: gm.code, stdout: clean(gm.stdout), stderr: gm.stderr }
const dm = await sec([del])
r.deleteMissing = { code: dm.code, stderr: dm.stderr }
const a2 = await sec([add()])
const d2 = await sec([del])
r.addNoHold = { code: a2.code, ms: a2.ms, thenDeleteCode: d2.code }
// a key with a newline would split into two commands; with a space, tokenization: quote it or keep to hex
r.absentAfter = (() => { try { execFileSync('security', ['find-generic-password', '-s', svc], { stdio: 'ignore' }); return false } catch { return true } })()
console.log(JSON.stringify({ service: svc, account: acct, ...r }, null, 1))
