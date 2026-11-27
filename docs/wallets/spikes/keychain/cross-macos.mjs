// Micro-spike driver (macOS): which Node binary can read an item another Node binary wrote, and a set race.
//   node cross-macos.mjs safe     cases expected to need no prompt, plus an 8-process set race
//   node cross-macos.mjs prompt   cases expected to raise a keychain prompt (bounded by a timeout)
// Binaries: the two nvm installs (Developer ID, team HX7739G8FX) and copies under ./bin (see README).
// Every item is banda-spike-<random>, deleted by the binary that wrote it, then checked absent.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const nvm = (v) => join(homedir(), '.nvm/versions/node', v, 'bin/node')
const B = {
	nvm24: nvm('v24.22.1'),
	nvm26: nvm('v26.12.1'),
	copy24: join(here, 'bin/copy24/node'),
	adhocA: join(here, 'bin/adhocA/node'),
	adhocA2: join(here, 'bin/adhocA2/node'),
	adhocB: join(here, 'bin/adhocB/node'),
}
const account = `home-${randomBytes(4).toString('hex')}/wallet/0`
const svc = () => `banda-spike-${randomBytes(6).toString('hex')}`

function run(bin, args, killAfter = 15000) {
	return new Promise((resolve) => {
		const t = performance.now()
		const p = spawn(bin, [join(here, 'kc.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
		let so = '', se = ''
		p.stdout.on('data', (d) => (so += d))
		p.stderr.on('data', (d) => (se += d))
		const k = setTimeout(() => p.kill('SIGKILL'), killAfter)
		p.on('exit', (code, sig) => {
			clearTimeout(k)
			const lines = so.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
			resolve({ code, sig, wallMs: Math.round(performance.now() - t), lines, stderr: se.trim().slice(0, 300) })
		})
	})
}
const absent = (s) => {
	try { execFileSync('security', ['find-generic-password', '-s', s], { stdio: 'ignore' }); return false } catch { return true }
}

async function cross(writer, reader, timeoutMs) {
	const s = svc()
	const w = await run(B[writer], ['set', s, account])
	const r = await run(B[reader], ['get', s, account, String(timeoutMs)], timeoutMs + 7000)
	const d = await run(B[writer], ['del', s, account])
	const wl = w.lines[0], rl = r.lines[0]
	return {
		writer, reader,
		readOk: rl?.ok === true && rl.fp === wl?.fp,
		read: rl ?? { killed: r.sig, wallMs: r.wallMs },
		readerExit: { code: r.code, sig: r.sig, wallMs: r.wallMs, extra: r.lines.slice(1) },
		deleted: d.lines[0]?.deleted, absentAfter: absent(s),
	}
}

async function race(n) {
	const s = svc()
	const rs = await Promise.all(Array.from({ length: n }, () => run(B.nvm24, ['race', s, account])))
	const sets = rs.map((r) => r.lines[0])
	const final = (await run(B.nvm24, ['get', s, account, '5000'])).lines[0]
	const d = await run(B.nvm24, ['del', s, account])
	return {
		writers: n,
		succeeded: sets.filter((x) => x?.ok).length,
		errors: sets.filter((x) => !x?.ok).map((x) => x?.error),
		finalMatchesAWriter: sets.some((x) => x?.ok && x.fp === final?.fp),
		distinctKeysReportedStored: new Set(sets.filter((x) => x?.ok).map((x) => x.fp)).size,
		deleted: d.lines[0]?.deleted, absentAfter: absent(s),
	}
}

const mode = process.argv[2]
const results = []
if (mode === 'safe') {
	for (const [w, r] of [['nvm24', 'nvm24'], ['nvm24', 'nvm26'], ['nvm24', 'copy24'], ['adhocA', 'adhocA2']]) {
		results.push(await cross(w, r, 8000))
	}
	results.push({ race: await race(8) })
} else if (mode === 'prompt') {
	for (const [w, r] of [['adhocA', 'adhocB'], ['nvm24', 'adhocA']]) results.push(await cross(w, r, 6000))
} else throw new Error('mode: safe | prompt')
console.log(JSON.stringify(results, null, 1))
