// A sender that trusts viem's nonce manager (process-local counter seeded from eth_getTransactionCount 'pending').
// argv: <rpcUrl> <label> <count> <valueBase> [feeMultiplier]. Prints one JSON line per send.
import { writeSync } from 'node:fs'
import { createWalletClient, http, defineChain } from 'viem'
import { privateKeyToAccount, nonceManager } from 'viem/accounts'
const [url, label, n, valueBase, mult = '1'] = process.argv.slice(2)
const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } })
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', { nonceManager })
const client = createWalletClient({ account, chain, transport: http(url) })
const to = '0x' + '44'.repeat(20)
const fee = mult === '1' ? {} : { maxFeePerGas: 3_000_000_000n * BigInt(mult), maxPriorityFeePerGas: 1_000_000_000n * BigInt(mult) }
const results = await Promise.allSettled(Array.from({ length: Number(n) }, (_, i) =>
	client.sendTransaction({ to, value: BigInt(Number(valueBase) + i), gas: 21000n, ...fee })))
results.forEach((r, i) => writeSync(1, JSON.stringify({ label, i, value: Number(valueBase) + i, ok: r.status === 'fulfilled', hash: r.value, error: r.reason?.details ?? r.reason?.shortMessage }) + '\n'))
