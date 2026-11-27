// Probes: what anvil answers, verbatim, for each chain-side case the send pipeline must recover from.
// usage: node probes.mjs [name ...]   (default: all)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { addr } from 'micro-eth-signer'
import { KEY, WALLET, CHAIN, GWEI, bootAnvil, rpc, sign, sendRaw, hex, sleep, openStore, requestSend, drive, walletTxs, classify } from './lib.mjs'

const only = process.argv.slice(2)
const TO = '0x' + '22'.repeat(20)
const show = (label, v) => console.log(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
const reply = (r) => (r.error ? `error ${r.error.code} "${r.error.message}"` : `ok ${String(r.result).slice(0, 18)}…`)
const F = { maxFee: 3n * GWEI, tip: 1n * GWEI }
const bump = (f, pct) => ({ maxFee: (f.maxFee * BigInt(100 + pct)) / 100n, tip: (f.tip * BigInt(100 + pct)) / 100n })
const mine = (url, n = 1) => rpc(url, 'anvil_mine', [hex(n)])
const receipt = async (url, h) => (await rpc(url, 'eth_getTransactionReceipt', [h])).result
const byHash = async (url, h) => (await rpc(url, 'eth_getTransactionByHash', [h])).result
const count = async (url, tag, who = WALLET) => Number(BigInt((await rpc(url, 'eth_getTransactionCount', [who, tag])).result))
const pool = async (url) => { const s = (await rpc(url, 'txpool_status')).result; return `pending=${Number(BigInt(s.pending))} queued=${Number(BigInt(s.queued))}` }
const blockNo = async (url) => Number(BigInt((await rpc(url, 'eth_blockNumber')).result))
const tmpStore = () => { const d = mkdtempSync(join(tmpdir(), 'banda-spike-nonce-')); return { db: openStore(join(d, 's.db')), d } }

const probes = {
	async determinism() {
		const tx = { to: TO, value: 1, nonce: 0, ...F }
		const h1 = sign({ ...tx }).hash; const h2 = sign({ ...tx }).hash
		show('micro-eth-signer signBy(key) twice, same hash', h1 === h2)
		const d1 = sign({ ...tx, hedged: false }); const d2 = sign({ ...tx, hedged: false })
		show('micro-eth-signer signBy(key, false) twice, same hash', d1.hash === d2.hash)
		const acct = privateKeyToAccount(KEY)
		const v = { chainId: CHAIN, type: 'eip1559', to: TO, value: 1n, nonce: 0, gas: 21000n, maxFeePerGas: F.maxFee, maxPriorityFeePerGas: F.tip }
		const v1 = await acct.signTransaction(v); const v2 = await acct.signTransaction(v)
		show('viem signTransaction twice, same bytes', v1 === v2)
		show('viem bytes == micro-eth-signer deterministic bytes', v1 === d1.raw)
	},

	async rebroadcast() {
		{
			const a = await bootAnvil(['--no-mining'])
			try {
				const s = sign({ to: TO, value: 1, nonce: 0, ...F })
				show('no-mining, first send', reply(await rpc(a.url, 'eth_sendRawTransaction', [s.raw])))
				show('no-mining, same bytes while pending', reply(await rpc(a.url, 'eth_sendRawTransaction', [s.raw])))
				await mine(a.url)
				show('same bytes after mined', reply(await rpc(a.url, 'eth_sendRawTransaction', [s.raw])))
				show('receipt still there, status', (await receipt(a.url, s.hash))?.status)
			} finally { await a.stop() }
		}
		{
			const a = await bootAnvil([])
			try {
				const s = sign({ to: TO, value: 1, nonce: 0, ...F })
				show('automine, first send', reply(await rpc(a.url, 'eth_sendRawTransaction', [s.raw])))
				show('automine, same bytes again', reply(await rpc(a.url, 'eth_sendRawTransaction', [s.raw])))
			} finally { await a.stop() }
		}
	},

	async feeBump() {
		const a = await bootAnvil(['--no-mining'])
		try {
			const p1 = sign({ to: TO, value: 1, nonce: 0, ...F })
			show('attempt 1 (fee F)', reply(await rpc(a.url, 'eth_sendRawTransaction', [p1.raw])))
			const other = sign({ to: TO, value: 2, nonce: 0, ...F })
			show('other payload, same nonce, same fee', reply(await rpc(a.url, 'eth_sendRawTransaction', [other.raw])))
			for (const pct of [1, 5, 9]) {
				const a2 = await bootAnvil(['--no-mining'])
				try {
					await rpc(a2.url, 'eth_sendRawTransaction', [p1.raw])
					const b = sign({ to: TO, value: 1, nonce: 0, ...bump(F, pct) })
					show(`fresh pool: same payment re-signed +${pct}% (fee cap and tip)`, reply(await rpc(a2.url, 'eth_sendRawTransaction', [b.raw])))
					const tipOnly = sign({ to: TO, value: 1, nonce: 0, maxFee: F.maxFee, tip: (F.tip * BigInt(100 + 50)) / 100n })
					show(`  then +50% tip only, same fee cap`, reply(await rpc(a2.url, 'eth_sendRawTransaction', [tipOnly.raw])))
				} finally { await a2.stop() }
			}
			const p2 = sign({ to: TO, value: 1, nonce: 0, ...bump(F, 13) })
			show('attempt 2: same payment, +13% fee cap and tip', reply(await rpc(a.url, 'eth_sendRawTransaction', [p2.raw])))
			const c = (await rpc(a.url, 'txpool_content')).result
			show('pool holds at nonce 0', (c.pending?.[WALLET]?.['0']?.hash ?? c.pending?.[WALLET.toLowerCase()]?.['0']?.hash) === p2.hash ? 'attempt 2' : 'attempt 1')
			show('attempt 1 by hash after replacement', (await byHash(a.url, p1.hash)) ? 'still known' : 'null (evicted)')
			show('attempt 1 bytes again (now lower than pool)', reply(await rpc(a.url, 'eth_sendRawTransaction', [p1.raw])))
			await mine(a.url)
			show('after mining: receipt(attempt 1)', (await receipt(a.url, p1.hash)) ? 'exists' : 'null')
			show('after mining: receipt(attempt 2) status', (await receipt(a.url, p2.hash))?.status)
			show('attempt 1 bytes after attempt 2 mined', reply(await rpc(a.url, 'eth_sendRawTransaction', [p1.raw])))
			const f = sign({ to: TO, value: 1, nonce: 1, maxFee: 1n, tip: 1n })
			show('fee cap 1 wei (below base fee)', reply(await rpc(a.url, 'eth_sendRawTransaction', [f.raw])))
		} finally { await a.stop() }
	},

	async drop() {
		const a = await bootAnvil(['--no-mining'])
		try {
			const s0 = sign({ to: TO, value: 1, nonce: 0, ...F }); const s1 = sign({ to: TO, value: 2, nonce: 1, ...F })
			await rpc(a.url, 'eth_sendRawTransaction', [s0.raw]); await rpc(a.url, 'eth_sendRawTransaction', [s1.raw])
			show('two pending', await pool(a.url))
			show('anvil_dropTransaction(nonce 0)', reply(await rpc(a.url, 'anvil_dropTransaction', [s0.hash])))
			show('after drop: tx by hash nonce 0 / nonce 1 (not dropped by us)', `${(await byHash(a.url, s0.hash)) ? 'known' : 'null'} / ${(await byHash(a.url, s1.hash)) ? 'known' : 'null'}`)
			show('after drop: pool', await pool(a.url))
			show('after drop: count latest / pending', `${await count(a.url, 'latest')} / ${await count(a.url, 'pending')}`)
			await mine(a.url)
			show('mine with nonce 0 missing: wallet txs mined', (await walletTxs(a.url)).length)
			show('rebroadcast stored bytes of nonce 0', reply(await rpc(a.url, 'eth_sendRawTransaction', [s0.raw])))
			show('pool', await pool(a.url))
			await mine(a.url)
			show('after mine: receipts nonce0/nonce1', `${(await receipt(a.url, s0.hash))?.status} / ${(await receipt(a.url, s1.hash))?.status ?? 'null'}`)
			show('rebroadcast stored bytes of nonce 1 too', reply(await rpc(a.url, 'eth_sendRawTransaction', [s1.raw])))
			await mine(a.url)
			show('after mine: receipt nonce1', (await receipt(a.url, s1.hash))?.status)
		} finally { await a.stop() }
	},

	async reorg() {
		const a = await bootAnvil(['--no-mining'])
		try {
			const s = sign({ to: TO, value: 1, nonce: 0, ...F })
			await rpc(a.url, 'eth_sendRawTransaction', [s.raw]); await mine(a.url); await mine(a.url, 2)
			const r1 = await receipt(a.url, s.hash)
			show('mined: block / head', `${Number(BigInt(r1.blockNumber))} / ${await blockNo(a.url)}`)
			show('tags latest/safe/finalized', `${await blockNo(a.url)} / ${Number(BigInt((await rpc(a.url, 'eth_getBlockByNumber', ['safe', false])).result?.number ?? '0x0'))} / ${Number(BigInt((await rpc(a.url, 'eth_getBlockByNumber', ['finalized', false])).result?.number ?? '0x0'))}`)
			show('anvil_reorg(3, []) (removes the block with the tx)', reply(await rpc(a.url, 'anvil_reorg', [3, []])))
			show('after reorg: head', await blockNo(a.url))
			show('after reorg: receipt', (await receipt(a.url, s.hash)) ? 'exists' : 'null')
			show('after reorg: tx by hash', (await byHash(a.url, s.hash)) ? 'known' : 'null')
			show('after reorg: pool', await pool(a.url))
			show('after reorg: count latest', await count(a.url, 'latest'))
			show('rebroadcast stored bytes', reply(await rpc(a.url, 'eth_sendRawTransaction', [s.raw])))
			await mine(a.url)
			const r2 = await receipt(a.url, s.hash)
			show('after re-mine: receipt block, same hash as before?', `${Number(BigInt(r2.blockNumber))}, tx hash same=${r2.transactionHash === s.hash}, block hash same=${r2.blockHash === r1.blockHash}`)
			// reorg that re-includes the tx in the replacement block
			const t = sign({ to: TO, value: 2, nonce: 1, ...F })
			await rpc(a.url, 'eth_sendRawTransaction', [t.raw]); await mine(a.url)
			const rt1 = await receipt(a.url, t.hash)
			show('anvil_reorg(1, [[raw, 0]]) (re-includes it)', reply(await rpc(a.url, 'anvil_reorg', [1, [[t.raw, 0]]])))
			const rt2 = await receipt(a.url, t.hash)
			show('receipt after re-inclusion: block number same, block hash same', rt2 ? `${rt2.blockNumber === rt1.blockNumber}, ${rt2.blockHash === rt1.blockHash}` : 'null')
			await mine(a.url, 100)
			const tag = async (t) => Number(BigInt((await rpc(a.url, 'eth_getBlockByNumber', [t, false])).result.number))
			show('after 100 more blocks: latest / safe / finalized', `${await tag('latest')} / ${await tag('safe')} / ${await tag('finalized')}`)
		} finally { await a.stop() }
	},

	async nonceHole() {
		const a = await bootAnvil(['--no-mining'])
		try {
			const key = addr.random().privateKey; const who = addr.fromPrivateKey(key)
			const fund = 21000n * F.maxFee * 3n // gas for three transfers, almost no value
			await rpc(a.url, 'anvil_setBalance', [who, hex(fund)])
			const big = sign({ key, to: TO, value: 10n ** 18n, nonce: 0, ...F })
			show('nonce 0 needs more than the balance', reply(await rpc(a.url, 'eth_sendRawTransaction', [big.raw])))
			const small = sign({ key, to: TO, value: 1, nonce: 1, ...F })
			show('nonce 1 (small) after the hole', reply(await rpc(a.url, 'eth_sendRawTransaction', [small.raw])))
			show('pool', await pool(a.url))
			await mine(a.url, 2)
			show('after mining 2 blocks: nonce 1 receipt', (await receipt(a.url, small.hash)) ? 'mined' : 'null (stuck behind the hole)')
			const filler = sign({ key, to: who, value: 0, nonce: 0, ...F })
			show('fill nonce 0 with a 0-value self-send', reply(await rpc(a.url, 'eth_sendRawTransaction', [filler.raw])))
			await mine(a.url)
			show('after mine: filler / nonce 1', `${(await receipt(a.url, filler.hash))?.status} / ${(await receipt(a.url, small.hash))?.status}`)
		} finally { await a.stop() }
	},

	async pendingTag() {
		const a = await bootAnvil(['--no-mining'])
		try {
			await rpc(a.url, 'eth_sendRawTransaction', [sign({ to: TO, value: 1, nonce: 0, ...F }).raw])
			show('anvil count latest / pending with one tx in pool', `${await count(a.url, 'latest')} / ${await count(a.url, 'pending')}`)
		} finally { await a.stop() }
	},

	async external() {
		const ext = (url, nonce, f, value = 777) => rpc(url, 'eth_sendRawTransaction', [sign({ to: '0x' + '33'.repeat(20), value, nonce, ...f }).raw])
		const recv = async (url, to, value) => (await walletTxs(url)).filter((t) => t.to.toLowerCase() === to.toLowerCase() && t.value === BigInt(value)).length
		for (const reconcile of [false, true]) {
			const a = await bootAnvil([]); const { db, d } = tmpStore()
			try {
				db.prepare('INSERT INTO ledger VALUES(?,?,0)').run(WALLET, CHAIN) // ledger made when the wallet was made
				show(`[idle external, reconcile=${reconcile}] external tx at nonce 0`, reply(await ext(a.url, 0, F)))
				requestSend(db, 'p', TO, 4242)
				const steps = []
				const s = await drive(db, a.url, 'p', { reconcile, log: (...x) => steps.push(x.slice(1).map((y) => String(y).slice(0, 60)).join(' ')) })
				show('  pipeline steps', steps.join(' | '))
				show('  payment nonce, on chain count', `${s.nonce}, ${await recv(a.url, TO, 4242)}`)
			} finally { await a.stop(); rmSync(d, { recursive: true, force: true }) }
		}
		// racing: banda's tx pending at nonce 0, the same key elsewhere sends at nonce 0 with a higher fee
		{
			const a = await bootAnvil(['--no-mining']); const { db, d } = tmpStore()
			const ticker = setInterval(() => {}, 1000)
			try {
				requestSend(db, 'p', TO, 4343)
				const steps = []
				const run = drive(db, a.url, 'p', { log: (...x) => steps.push(x.slice(1).map((y) => String(y).slice(0, 70)).join(' ')), pollMs: 150 })
				while (db.prepare('SELECT state FROM sends WHERE id = ?').get('p').state !== 'broadcast') await sleep(20)
				const fees = db.prepare('SELECT max_fee, tip FROM attempts WHERE send_id = ?').get('p')
				const r = await ext(a.url, 0, bump({ maxFee: BigInt(fees.max_fee), tip: BigInt(fees.tip) }, 50))
				show('[racing, external +50% fee] external send at banda\'s pending nonce 0', reply(r))
				show('  pool now', await pool(a.url))
				const miner = setInterval(() => mine(a.url), 300)
				const s = await run; clearInterval(miner)
				show('  pipeline steps', steps.filter((x, i, arr) => arr.indexOf(x) === i).join(' | '))
				show('  payment confirmed at nonce, on-chain count of the payment, external landed', `${s.nonce}, ${await recv(a.url, TO, 4343)}, ${await recv(a.url, '0x' + '33'.repeat(20), 777)}`)
			} finally { clearInterval(ticker); await a.stop(); rmSync(d, { recursive: true, force: true }) }
		}
		// racing the other way: an external tx pending at nonce 0 with a LOWER fee, banda's ledger also says 0
		for (const extPct of [-50, 0]) {
			const a = await bootAnvil(['--no-mining']); const { db, d } = tmpStore()
			try {
				const b = (await rpc(a.url, 'eth_getBlockByNumber', ['latest', false])).result
				const bandaFee = { maxFee: BigInt(b.baseFeePerGas) * 2n + GWEI, tip: GWEI }
				const extFee = extPct === 0 ? bandaFee : bump(bandaFee, extPct)
				show(`[external pending first, fee ${extPct >= 0 ? '+' : ''}${extPct}% vs banda] external at nonce 0`, reply(await ext(a.url, 0, extFee)))
				requestSend(db, 'p', TO, 4444)
				const steps = []
				const run = drive(db, a.url, 'p', { log: (...x) => steps.push(x.slice(1).map((y) => String(y).slice(0, 90)).join(' ')), pollMs: 150 })
				await sleep(400)
				const miner = setInterval(() => mine(a.url), 300)
				const s = await run; clearInterval(miner)
				show('  pipeline steps', steps.filter((x, i, arr) => arr.indexOf(x) === i).join(' | '))
				show('  payment nonce, on-chain count of the payment, external landed', `${s.nonce}, ${await recv(a.url, TO, 4444)}, ${await recv(a.url, '0x' + '33'.repeat(20), 777)}`)
			} finally { await a.stop(); rmSync(d, { recursive: true, force: true }) }
		}
	},
	// A foreign tx takes the nonce of banda's pending payment; banda moves the payment to a new nonce. Then a reorg puts
	// banda's OLD attempt on chain instead of the foreign tx (anyone holding its signed bytes can rebroadcast them).
	// foreignTag decides when a nonce counts as taken: 'latest' (at once) or 'finalized' (anvil: 64 blocks deep).
	async reorgAfterNonceTaken() {
		for (const foreignTag of ['latest', 'finalized']) {
			const a = await bootAnvil(['--no-mining']); const { db, d } = tmpStore()
			try {
				requestSend(db, 'p', TO, 4545)
				const steps = []
				const run = drive(db, a.url, 'p', { foreignTag, pollMs: 50, log: (...x) => steps.push(x.slice(1, 3).map((y) => String(y).slice(0, 12)).join(' ')) })
				while (db.prepare('SELECT state FROM sends WHERE id = ?').get('p').state !== 'broadcast') await sleep(10)
				const A = db.prepare('SELECT * FROM attempts WHERE send_id = ? AND n = 0').get('p')
				await rpc(a.url, 'eth_sendRawTransaction', [sign({ to: '0x' + '33'.repeat(20), value: 777, nonce: 0, ...bump({ maxFee: BigInt(A.max_fee), tip: BigInt(A.tip) }, 50) }).raw])
				await mine(a.url) // the foreign tx is mined at nonce 0
				let reorged = false
				for (let i = 0; i < 40; i++) {
					await sleep(60)
					const st = db.prepare('SELECT state, nonce FROM sends WHERE id = ?').get('p')
					if (st.nonce === 1 || st.state === 'confirmed') break
					if (foreignTag === 'finalized' && i === 10 && !reorged) {
						// a reorg 1 block deep, before the payment moved on: the foreign tx is replaced by banda's attempt 0
						show(`[${foreignTag}] reorg replaces the foreign tx with attempt 0`, reply(await rpc(a.url, 'anvil_reorg', [1, [[A.raw, 0]]])))
						reorged = true
					}
				}
				if (foreignTag === 'latest') {
					const miner = setInterval(() => mine(a.url), 100)
					await run; clearInterval(miner)
					const head = await blockNo(a.url)
					const B = db.prepare('SELECT * FROM attempts WHERE send_id = ? ORDER BY n DESC LIMIT 1').get('p')
					show(`[${foreignTag}] payment moved to nonce ${B.nonce} and confirmed; now a reorg of ${head} blocks puts attempt 0 and the new attempt on chain`, reply(await rpc(a.url, 'anvil_reorg', [head, [[A.raw, 0], [B.raw, 0]]])))
				} else {
					await run
				}
				const paid = (await walletTxs(a.url)).filter((t) => t.to.toLowerCase() === TO.toLowerCase() && t.value === 4545n).length
				show(`[${foreignTag}] pipeline`, steps.filter((x, i, arr) => arr.indexOf(x) === i).join(' | '))
				show(`[${foreignTag}] times the payment landed on chain`, paid)
			} finally { await a.stop(); rmSync(d, { recursive: true, force: true }) }
		}
	},
}

for (const [name, fn] of Object.entries(probes)) {
	if (only.length && !only.includes(name)) continue
	console.log(`\n## ${name}`)
	await fn()
}
