// The daemon stand-in, run as a child process: drives every unconfirmed send in the store, concurrently.
// argv: <db> <rpcUrl>. env: KILL_AT=<point>:<sendId> SIGKILLs this process at that boundary; FUSED=1 uses the one-commit variant;
// ONLY=<prefix> limits it to some sends; BUMP_AFTER=<n> replaces an attempt still unmined after n broadcasts.
import { writeSync } from 'node:fs'
import { openStore, drive } from './lib.mjs'

const [db_, url] = process.argv.slice(2)
const db = openStore(db_)
const killAt = process.env.KILL_AT ?? ''
const fused = process.env.FUSED === '1'
const only = process.env.ONLY ?? '' // drive only the sends whose id starts with this (two daemons, each with its own sends)
const ids = db.prepare(`SELECT id FROM sends WHERE state != 'confirmed' ORDER BY id`).all().map((r) => r.id).filter((id) => id.startsWith(only))
const log = (...a) => writeSync(1, JSON.stringify(a) + '\n') // sync: a line written just before SIGKILL is not lost
await Promise.all(ids.map((id) => drive(db, url, id, {
	fused, log, bumpAfterPolls: Number(process.env.BUMP_AFTER ?? Infinity),
	kill: (point) => { if (killAt === `${point}:${id}`) { log(id, 'SIGKILL at', point); process.kill(process.pid, 'SIGKILL') } },
})))
log('done')
