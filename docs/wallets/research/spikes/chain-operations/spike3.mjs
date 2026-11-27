import net from 'node:net'
import { spawn } from 'node:child_process'
import { privateKeyToAccount } from 'viem/accounts'
import { parseGwei, numberToHex } from 'viem'
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const acct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
async function boot(extra = []) {
  const port = await freePort(); const url = `http://127.0.0.1:${port}`
  const proc = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--no-mining', '--silent', ...extra], { stdio: 'ignore' })
  const rpc = async (method, params = []) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
  return { proc, rpc }
}
const base = { chainId: 31337, type: 'eip1559', maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1'), gas: 21000n, to: TO, value: 1n }
const show = (l, v) => console.log(l, JSON.stringify(v).slice(0, 400))
// 1. Fee bump sweep, fresh pool each time
for (const p of [1, 5, 9, 10, 12.5]) {
  const { proc, rpc } = await boot()
  try {
    const f = (x) => BigInt(Math.round(Number(x) * (1 + p / 100)))
    const a = await rpc('eth_sendRawTransaction', [await acct.signTransaction({ ...base, nonce: 0, value: 1n })])
    const b = await rpc('eth_sendRawTransaction', [await acct.signTransaction({ ...base, nonce: 0, value: 2n, maxFeePerGas: f(parseGwei('10')), maxPriorityFeePerGas: f(parseGwei('1')) })])
    const content = await rpc('txpool_content')
    const pend = content.result?.pending?.[acct.address]?.['0'] ?? content.result?.queued?.[acct.address]?.['0']
    show(`BUMP +${p}%: A ok=${!a.error} B=${b.error ? b.error.message : 'accepted'} ; pool nonce0 hash==B? ${pend?.hash === b.result}`, {})
  } finally { proc.kill() }
}
// 2. Intrinsic gas: invalid (gas 21000, 2 nonzero data bytes) vs control (gas 21100)
for (const gas of [21000n, 21100n]) {
  const { proc, rpc } = await boot()
  try {
    const s = await rpc('eth_sendRawTransaction', [await acct.signTransaction({ ...base, nonce: 0, gas, data: '0x1234' })])
    await rpc('anvil_mine', [numberToHex(1)])
    const r = s.result ? await rpc('eth_getTransactionReceipt', [s.result]) : null
    show(`INTRINSIC gas=${gas}: send=${s.error ? s.error.message : 'accepted'} receipt=${r?.result ? 'status ' + r.result.status : 'none'} blockTxCount=${(await rpc('eth_getBlockByNumber', ['latest', false])).result.transactions.length}`, {})
  } finally { proc.kill() }
}
// 3. Nonce gap: nonce 3 with latest 0
{
  const { proc, rpc } = await boot()
  try {
    const s = await rpc('eth_sendRawTransaction', [await acct.signTransaction({ ...base, nonce: 3 })])
    await rpc('anvil_mine', [numberToHex(1)])
    show(`GAP nonce3: send=${s.error ? s.error.message : 'accepted'} txpool=${JSON.stringify((await rpc('txpool_status')).result)} pendingNonce=${(await rpc('eth_getTransactionCount', [acct.address, 'pending'])).result}`, {})
  } finally { proc.kill() }
}
// 4. Optimism receipt fields
{
  const { proc, rpc } = await boot(['--optimism'])
  try {
    const s = await rpc('eth_sendRawTransaction', [await acct.signTransaction({ ...base, nonce: 0, value: 5n })])
    await rpc('anvil_mine', [numberToHex(1)])
    const r = await rpc('eth_getTransactionReceipt', [s.result])
    show('OP receipt keys', Object.keys(r.result ?? {}))
    show('OP receipt sample', { l1Fee: r.result?.l1Fee, l1GasUsed: r.result?.l1GasUsed, l1GasPrice: r.result?.l1GasPrice, gasUsed: r.result?.gasUsed })
    const gp = await rpc('eth_getBlockByNumber', ['latest', false])
    show('OP block keys', Object.keys(gp.result ?? {}))
  } finally { proc.kill() }
}
