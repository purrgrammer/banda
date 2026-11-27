# Micro-spikes for the durability and concurrency hazards

Two measurements behind `../../hazards-durability-concurrency.md`. Run on 2026-11-23, darwin-arm64, Node 24,
anvil 1.9.0 (commit 6056c58), micro-eth-signer 0.20.1. Only anvil's public dev key #0 is used; no network, no funds.

Install outside the repo (never node_modules here):

```sh
mkdir -p "$SCRATCH/hazards-dur" && cd "$SCRATCH/hazards-dur"
npm init -y >/dev/null && npm i --save-exact micro-eth-signer@0.20.1
cp <repo>/docs/wallets/analysis/spikes/hazards-durability/*.mjs .
node determinism.mjs
PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
anvil --port "$PORT" --chain-id 84532 --silent & node reorg.mjs "$PORT"; kill %1
```

## determinism.mjs: is a re-signed transaction the same bytes?

`Transaction.signBy(key)` in micro-eth-signer 0.20.1 defaults to `extraEntropy = true` (core/tx.js line 210,
`signBy(privateKey, extraEntropy = true)`), a hedged signature. Measured:

```json
{ "defaultSameBytes": false, "extraEntropyFalseSameBytes": true,
  "defaultHash1": "0x4dda7b29…", "defaultHash2": "0x2201afe2…" }
```

So the RFC's "deterministic, RFC 6979" holds only when the signer passes `false`. The same default is in
`core/message.js` (`sign(message, privateKey, extraEntropy = true)`) for messages and typed data.

## reorg.mjs: what happens to a mined transaction that a reorg removes

```json
{ "receiptBefore": "0x4", "latestNonceBeforeReorg": "0x2",
  "receiptAfterReorg": null, "txAfterReorg": null,
  "poolAfterReorg": { "pending": "0x0", "queued": "0x0" },
  "latestNonceAfterReorg": "0x1",
  "rebroadcast": "0xbe116ba2…  (same hash)", "receiptAfterRebroadcast": "0x5",
  "rebroadcastAfterMined": { "error": { "code": -32003, "message": "nonce too low" } } }
```

- `anvil_reorg(1, [])` removes the transaction entirely: no receipt, not in the pool, the account nonce goes back.
  Anvil does not put a reorged transaction back in its pool; a daemon must not count on any node doing so.
- Broadcasting the stored bytes again re-includes it under the same hash.
- Broadcasting bytes that are already mined answers `nonce too low`, not `already known`: that answer to our own
  bytes means "look the hash up", never "failed".

A parallel spike in the same run (`spike-nonce-and-crash`, probes output) measured the same three facts, plus that
an older replaced version broadcast again answers `replacement transaction underpriced`.
