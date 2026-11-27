import net from 'node:net'
import { spawn } from 'node:child_process'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { serializeTransaction, parseGwei, numberToHex } from 'viem'

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const port = await freePort()
const url = `http://127.0.0.1:${port}`
const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '31337', '--no-mining', '--silent'], { stdio: 'ignore' })
const rpc = async (method, params = []) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return r.json()
}
for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // anvil public dev key 0
const acct = privateKeyToAccount(key)
const base = { chainId: 31337, type: 'eip1559', maxFeePerGas: parseGwei('10'), maxPriorityFeePerGas: parseGwei('1'), gas: 21000n, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: 1n }
const sign = (over) => acct.signTransaction({ ...base, ...over })
const send = async (raw) => (await rpc('eth_sendRawTransaction', [raw]))
const show = (label, r) => console.log(label, JSON.stringify(r.error ?? { result: r.result }))
const mine = () => rpc('anvil_mine', [numberToHex(1)])
try {
  const nonce0 = await sign({ nonce: 0 })
  show('A0 send nonce0 (first)            ', await send(nonce0))
  show('A1 same raw again, unmined        ', await send(nonce0))
  await mine()
  show('A2 nonce0 after mined (nonce low) ', await send(await sign({ nonce: 0 })))
  show('A3 nonce0 different fee after mined', await send(await sign({ nonce: 0, maxFeePerGas: parseGwei('11') })))
  // replacement: pending nonce 1 then same nonce with higher/lower fee
  show('B0 pending nonce1 fee 10 gwei     ', await send(await sign({ nonce: 1 })))
  show('B1 same nonce1 same fee           ', await send(await sign({ nonce: 1, value: 2n })))
  show('B2 same nonce1 +5% fee            ', await send(await sign({ nonce: 1, value: 3n, maxFeePerGas: parseGwei('10.5'), maxPriorityFeePerGas: parseGwei('1.05') })))
  show('B3 same nonce1 +10% fee           ', await send(await sign({ nonce: 1, value: 4n, maxFeePerGas: parseGwei('11'), maxPriorityFeePerGas: parseGwei('1.1') })))
  show('C0 nonce too high (nonce 50)      ', await send(await sign({ nonce: 50 })))
  show('D0 intrinsic gas too low          ', await send(await sign({ nonce: 2, gas: 21000n, data: '0x1234' })))
  show('E0 gas below base fee (fee cap 0) ', await send(await sign({ nonce: 2, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n })))
  const broke = privateKeyToAccount(generatePrivateKey())
  const brokeRaw = await broke.signTransaction({ ...base, chainId: 31337, nonce: 0, value: 1n })
  show('F0 insufficient funds (value)     ', await send(brokeRaw))
  const brokeRaw2 = await broke.signTransaction({ ...base, chainId: 31337, nonce: 0, value: 0n, gas: 21000n, maxFeePerGas: parseGwei('10') })
  show('F1 insufficient funds (gas only)  ', await send(brokeRaw2))
  // drop: pending nonce 2 then anvil_dropTransaction
  const h = await send(await sign({ nonce: 2 }))
  show('G0 pending nonce2                 ', h)
  show('G1 anvil_dropTransaction          ', await rpc('anvil_dropTransaction', [h.result]))
  show('G2 txpool_status after drop       ', await rpc('txpool_status'))
  show('G3 eth_getTransactionByHash after drop', await rpc('eth_getTransactionByHash', [h.result]))
  show('H0 anvil_reorg method probe       ', await rpc('anvil_reorg', [1, []]))
  show('H1 eth_getTransactionCount pending', await rpc('eth_getTransactionCount', [acct.address, 'pending']))
  show('H2 eth_getTransactionCount latest ', await rpc('eth_getTransactionCount', [acct.address, 'latest']))
} finally {
  anvil.kill()
}
