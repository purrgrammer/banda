// Reads the cargo-auditable crate list embedded in a .node binary (zlib JSON at a known offset/size).
// usage: node audit-deps.mjs <file> <offset> <size>
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
const [file, off, size] = process.argv.slice(2)
const buf = readFileSync(file).subarray(Number(off), Number(off) + Number(size))
const { packages } = JSON.parse(inflateSync(buf).toString())
for (const p of packages) if (p.kind !== 'build') console.log(`${p.name} ${p.version}`)
