# Spike: exactly-once sends under crashes (nonce and crash)

Date: 2026-11-23. Everything here ran on a local anvil with its public dev key 0. No network was written to, and no
real key or funds were used.

## Goal

Does a send pipeline that owns its nonce ledger in the store pay **exactly once**? It must not send a second
transaction and must not lose one. The pipeline is: reserve the nonce in a commit, sign, checkpoint the raw bytes,
broadcast, then poll for a receipt. The test kills it with SIGKILL at every boundary and at random moments, then
restarts it. The spike also records what the chain answers in each recovery case: identical rebroadcast, two senders,
an external sender using the same key, fee-bump replacement, dropped transactions and reorgs. Each case gets a recovery
rule. This is the "Nonce and replacement" spike that `docs/wallets.md` lists, run locally. Base Sepolia remains open (see
"Open").

## Setup

| Thing | Version |
|---|---|
| Node | v24.22.1, with `node:sqlite` as the store stand-in (WAL, `synchronous=FULL`, `BEGIN IMMEDIATE` per commit) |
| anvil | 1.9.0 (commit 6056c58). `--optimism` still works as a hidden alias; `-n base` reports hard fork `Beryl` |
| micro-eth-signer | 0.20.1 (the signing library recommended in `../../research/signing-libraries.md`), used for the pipeline |
| viem | 2.58.4, used only for its `nonceManager` comparison and as a cross-check of the signed bytes |

## Files

| File | What it does |
|---|---|
| `lib.mjs` | anvil boot on a port the system picks, raw JSON-RPC that keeps the error verbatim, the store, signing, error classification, `drive()` (the pipeline) |
| `pipeline.mjs` | The daemon stand-in, run as a child process. It drives every unconfirmed send in the store. `KILL_AT=<point>:<id>` makes it SIGKILL itself at a boundary; `FUSED=1` selects the one-commit variant; `BUMP_AFTER=n` turns on replacement |
| `crash-sweep.mjs` | `boundary`: one kill at every boundary for every send. `random`: kills at random moments, repeated until the run completes. `bump`: kills at each replacement boundary |
| `probes.mjs` | Chain-side cases: determinism, rebroadcast, fee bump, drop, reorg, nonce hole, the `pending` tag, an external sender, a reorg after the nonce was taken |
| `concurrency.mjs` | Two senders on one wallet, through the store and through viem's `nonceManager`. Also a restart under Base's `pending` semantics, emulated by a proxy that rewrites `pending` to `latest` |
| `viem-sender.mjs` | A sender that relies on viem's `nonceManager` (child process) |
| `out-sweep-all.txt`, `out-probes.txt`, `out-concurrency.txt` | Raw output of the final runs quoted below. Only anvil dev-chain hashes |

## Commands

Run these in a throwaway directory, never in the repo:

    mkdir spike && cd spike && npm init -y >/dev/null
    npm install --ignore-scripts --save-exact viem@2.58.4 micro-eth-signer@0.20.1
    cp <repo>/docs/wallets/spikes/nonce-and-crash/*.mjs .
    node --no-warnings crash-sweep.mjs all 12      # boundary + random (12 runs per variant) + bump; about 3 min
    node --no-warnings probes.mjs                  # about 1 min
    node --no-warnings concurrency.mjs             # about 1 min

Each run starts its own anvil (killed at the end) and a temporary sqlite file under `os.tmpdir()` (removed at the end).
No container and no keychain entry is used.

## The pipeline under test

One `sends` row per payment and one `attempts` row per signed transaction. All attempts of a payment share its nonce.
The ledger has one row per `(wallet, chain)`. A restart re-reads the store at every step, so a killed run continues the
same send and never starts a second one.

```
split:  reserve nonce (commit) -> sign -> checkpoint raw+hash (commit) -> broadcast -> receipt -> confirmed (commit)
fused:  fees (RPC) -> ONE commit { take nonce, sign, store raw+hash } -> broadcast -> receipt -> confirmed (commit)
resume: read the chain nonce, then the receipts of every attempt at this nonce
        - a receipt for any attempt              -> confirmed with that hash
        - nonce consumed and no receipt of ours  -> a foreign tx took it: the payment goes back to "requested"
                                                    and gets a new nonce (only once that is final; see R6)
        - otherwise                              -> rebroadcast the latest attempt's stored bytes
stuck:  no receipt after n broadcasts, or the fee cap is under the base fee
        -> new attempt, SAME nonce, fee cap and tip each at least +12.5% (and at least the current fees)
```

Kill points: `after-reserve`, `after-sign`, `after-checkpoint`, `mid-broadcast`, `after-broadcast` and
`after-receipt` for split. For fused, `after-commit` replaces the first three. The replacement adds
`after-bump-sign`, `after-bump-checkpoint`, `mid-broadcast-bump` and `after-broadcast-bump`. For `mid-broadcast`,
the request goes out through `node:http` and the process kills itself on the request's `finish` event: the bytes have
left the process and no reply has been read.

Invariants, checked against the chain after every run:
- each payment is on chain exactly once (matched by recipient and value);
- the wallet's nonces are contiguous from 0;
- every send in the store is `confirmed`, with the hash that is on chain;
- `ledger.next` equals the chain nonce.

## Results

### 1. Crash sweep: the invariants held in every run (`out-sweep-all.txt`)

| Sweep | Runs | Held |
|---|---|---|
| Boundary: 3 configs (`--optimism` automine, `--optimism` 1 s blocks, `-n base` automine) x {split 6, fused 4} points x 3 victim sends | 90 | 90 |
| Random moments, 5 sends, 1 s blocks, split and fused, 12 runs each, 1 to 4 kills per run | 24 | 24 |
| Replacement: the first attempt is stuck (base fee raised above its cap), killed at each replacement boundary, plus 8 random runs | 13 | 13 |

What the kill left behind, trimmed:

```
optimism/auto       split kill mid-broadcast    s0 | at-kill mined=1 pool=0+0q | resume victim-broadcast=[]                   | OK
optimism/interval1s split kill mid-broadcast    s0 | at-kill mined=0 pool=1+0q | resume victim-broadcast=[known,...,nonce-low] | OK
optimism/interval1s split kill after-sign       s0 | at-kill mined=0 pool=0+0q | resume victim-broadcast=[ok,known,...]      | OK
bump kill mid-broadcast-bump     kills=1 exit=0 attempts=2 landed=attempt 1 | OK
random split run  5 kills=4 exit=0 attempts={"s0":1,...,"s4":1} | OK
127/127 runs held the invariants
```

**A broadcast whose reply was lost still went through.** In every `mid-broadcast` run, the client died before it read
the reply, and anvil had already accepted the transaction: it was mined (automine) or in the pool (1 s blocks). The
restart either found a receipt or got `transaction already imported`. Only the stored bytes make this case safe.

### 2. Rebroadcasting identical bytes (`probes.mjs rebroadcast`)

| State of the tx | anvil reply (verbatim) |
|---|---|
| Pending in the pool | `-32003 "transaction already imported"` |
| Mined | `-32003 "nonce too low"` (its receipt is still there, status `0x1`) |
| After `anvil_dropTransaction` | accepted again, same hash |
| After a reorg removed its block | accepted again, same hash, mined in a new block |

A rebroadcast is harmless in every state, so the broadcast step is `idempotent` in banda's sense.

### 3. Two senders on one wallet (`concurrency.mjs`)

| Setup | Result |
|---|---|
| Store ledger, two processes with 10 sends each (automine and 1 s blocks) | 20 txs on chain, nonces 0..19 contiguous, each payment once, `ledger.next` = 20, no error reply |
| Store ledger, two drivers on the **same** 20 sends | 20 txs on chain, each payment once. Depending on timing, 12 to 20 of the sends got 2 attempts (hedged signatures, so different hashes) at one nonce. The losers got `nonce too low` (automine) or `replacement transaction underpriced` (1 s blocks) |
| viem `nonceManager`, one process, 20 concurrent | 20 of 20 ok |
| viem `nonceManager`, two processes with 10 each | **10 of 20 failed** with `nonce too low`. Both counters started at 0 |

### 4. A restart under Base's `pending` semantics (`concurrency.mjs`)

Base documents that `pending` resolves to the latest canonical block since Denim (`../../research/chain-operations.md`
F1, docs.base.org/upgrades/denim/migrate-from-flashblocks, accessed 2026-11-23). anvil's own `pending` counts its pool
(`probes.mjs pendingTag`: latest 0, pending 1). A proxy rewriting `pending` to `latest` emulates Base:

```
pending = anvil's own: run A sends 3 (ok); restart; B ok; C ok           -> all five landed
pending = 'latest':    run A sends 3 (ok); restart; B (same fee) -> "replacement transaction underpriced";
                       C (2x fee) -> ok, and it REPLACED A0 in the pool  -> A0 never landed, though run A reported it sent
```

viem's manager keeps its counter in memory (`node_modules/viem/_esm/utils/nonceManager.js` in 2.58.4: an `LruMap` plus
`jsonRpc()` reading `blockTag: 'pending'`). Any restart re-seeds it from `pending`. On Base, that value does not include
transactions in flight.

### 5. An external sender using the same key (`probes.mjs external`)

This becomes realistic because of requirement 5: the owner can export the key and import it into another wallet.

| Case | What happened | Payment on chain | External tx |
|---|---|---|---|
| External tx mined while banda was idle, no reconciliation | broadcast `nonce too low`, no receipt of ours, nonce consumed: re-reserved nonce 1 | once | landed |
| Same, with reconciliation (`next = max(ledger.next, chain latest)` at reserve) | reserved nonce 1 directly, no error | once | landed |
| banda's tx pending, external at the same nonce with +50% fee | the external tx replaced banda's in the pool; banda's rebroadcast got `replacement transaction underpriced`; once nonce 0 was mined, banda re-reserved nonce 1 | once | landed |
| External pending first, same fee as banda's | banda got `replacement transaction underpriced`; after nonce 0 was mined, banda re-reserved nonce 1 | once | landed |
| External pending first, fee 50% **lower** than banda's | banda's broadcast was accepted and **replaced the external tx** | once | **never landed** |

### 6. Fee bump and "replacement underpriced" (`probes.mjs feeBump`)

```
other payload, same nonce, same fee            -> -32003 "replacement transaction underpriced"
same payment re-signed +1% / +5% / +9%         -> accepted (anvil's bump rule is laxer than geth's 10%)
then +50% tip only, same fee cap               -> -32003 "replacement transaction underpriced"
attempt 2 (+13% cap and tip)                   -> accepted; attempt 1 by hash: null (evicted)
attempt 1 bytes again (lower than the pool's)  -> -32003 "replacement transaction underpriced"
after mining: receipt(attempt 1) null, receipt(attempt 2) 0x1; attempt 1 again -> -32003 "nonce too low"
fee cap 1 wei                                  -> -32003 "max fee per gas less than block base fee"
```

### 7. Dropped transactions (`probes.mjs drop`)

`anvil_dropTransaction(nonce 0)` returned the hash. It **also removed the nonce-1 transaction**, which had not been
dropped: both hashes read as null afterwards, and the pool went from 2 pending to 0. Rebroadcasting nonce 0 alone brought
back only nonce 0. Nonce 1 landed only after its own stored bytes were rebroadcast.

### 8. Reorgs (`probes.mjs reorg`, `reorgAfterNonceTaken`)

- After `anvil_reorg(3, [])` removed the block holding the tx, its receipt was null, it was unknown by hash, the pool was
  empty and the chain nonce was back to 0. **anvil did not put the tx back in the pool.** Rebroadcasting the stored bytes
  mined it again: same tx hash, new block hash. `anvil_reorg(1, [[raw, 0]])` re-includes a given tx.
- anvil's tags after 105 blocks: latest 105, safe 73, finalized 41. So `safe` is latest - 32 and `finalized` is
  latest - 64.
- **Taking a new nonce at `latest` can pay twice.** A foreign tx took nonce 0 of a pending payment, and the pipeline
  moved the payment to nonce 1 and confirmed it. A 2-block reorg then put banda's **old attempt** (nonce 0, whose signed
  bytes anyone holding them could rebroadcast) on chain in place of the foreign tx: the payment landed **twice**. The same
  run, but treating a nonce as taken only when it is consumed at `finalized`: a 1-block reorg swapped the foreign tx for
  attempt 0 before that point, and the pipeline confirmed attempt 0. It landed **once**, and no second nonce was ever
  signed.

### 9. A nonce that is never filled (`probes.mjs nonceHole`)

```
nonce 0 needs more than the balance -> -32003 "Insufficient funds for gas * price + value"
nonce 1 (small)                     -> accepted into queued (pending=0 queued=1); not mined after 2 blocks
0-value self-send at nonce 0        -> mined, and nonce 1 mined right after it
```

### 10. Signature determinism (`probes.mjs determinism`)

micro-eth-signer's `signBy(key)` is **hedged by default**. `core/tx.js` in 0.20.1 has
`signBy(privateKey, extraEntropy = true)`, and `utils.js` passes `extraEntropy` to noble's `secp256k1.sign`. Signing the
same tx twice gave different hashes. `signBy(key, false)` is plain RFC 6979: equal hashes, and bytes identical to viem's
`signTransaction`.

## Error table and recovery rule

anvil uses code `-32003` for all of these. Geth uses `-32000` for pool errors, and reth cannot tell them apart by code
(`../../research/chain-operations.md` F3). **Match on the message, not the code.**

| Class | Message (anvil 1.9.0, verbatim; geth wording in the research note) | Recovery |
|---|---|---|
| known | `transaction already imported` (geth: `already known`) | Treat as broadcast; keep polling |
| nonce-low | `nonce too low` | Read the chain nonce, then the receipts of every attempt at this nonce. A receipt means confirmed. No receipt means a foreign tx took the nonce: wait until it is consumed at `finalized`, then move the payment to a new nonce (R6) |
| underpriced | `replacement transaction underpriced` | Another tx holds our nonce in the pool, either a foreign tx or an older attempt with a higher fee. Never send a different payload at this nonce. Wait, and let nonce-low settle it once the nonce is mined |
| fee-low | `max fee per gas less than block base fee` | New attempt at the same nonce with fresh fees (at least +12.5% on cap and tip) |
| funds | `Insufficient funds for gas * price + value` (geth: lower-case `insufficient`) | The payment fails. Its nonce must still be filled: a 0-value self-send at that nonce, or every later payment stays queued (R10) |
| other | anything else | Retry the same stored bytes with backoff; never re-sign at a new nonce |

## Verdict

The pipeline pays exactly once in all 127 crash runs: kills at every boundary of both variants, kills at random
moments, and kills during replacement. It needs four conditions:
1. the nonce comes from a ledger in the store, taken under its write lock;
2. the signed bytes are stored before they are first broadcast, and only stored bytes are broadcast;
3. a payment is confirmed by a receipt of **any** of its attempts, and every attempt shares one nonce;
4. a payment moves to a new nonce only when a foreign tx consumed its nonce **at finality**.

viem's process-local `nonceManager` fails under both conditions that banda has:
- two senders on one key: 10 of 20 sends failed;
- a restart on Base's `pending`: a payment reported as sent was silently replaced.

The spike also refutes the RFC's "Sign (deterministic, RFC 6979)": the recommended library hedges by default. The
design does not need determinism, because the checkpoint comes before the broadcast.

## What this means for the design

- **R1. One nonce ledger per (wallet, chain) in the store.** Take the nonce in a commit, under the store's write lock.
  Each step re-checks its precondition inside the commit: a second driver of the same payment must find the nonce
  already taken. This is principle 1, one store. viem's `nonceManager` and `eth_getTransactionCount('pending')` are never
  the source of truth.
- **R2. Take the nonce when the payment starts to run, never while its draft waits.** A nonce held by a draft that
  waits for the owner leaves a gap, and every later payment from that wallet queues behind it (R10). Prefer the **fused**
  commit: fees are read before it, then one commit takes the nonce and stores the signed bytes. That removes the
  "reserved, unsigned" state and leaves 4 fault points instead of 6. The key is read from the keychain just before that
  commit; signing is CPU only.
- **R3. Checkpoint before broadcast; broadcast only stored bytes; rebroadcast freely.** The effect is `idempotent`. A
  reply lost in flight is the normal case, and section 1 shows the tx landed anyway.
- **R4. Do not rely on, or claim, signature determinism.** Delete "deterministic, RFC 6979" from the RFC's step 2. If a
  re-sign ever has to match, pass `extraEntropy = false` explicitly and test for it.
- **R5. A payment is a set of attempts with one nonce.** Replacement (speed-up) is a new attempt of the same payment at
  the same nonce, with fee cap and tip each raised at least 12.5%. Geth requires 10% on both. anvil accepts 1% and rejects
  a tip-only bump, so anvil is not a conformance oracle for this rule. Whichever attempt lands, the payment lands once.
  Even two drivers on one payment paid once (section 3).
- **R6. A foreign tx on our nonce: decide at finality.** Read the nonce first, then the receipts. If the nonce was
  consumed and none of our attempts has a receipt, a foreign tx took it. Move the payment to a new nonce only when
  `eth_getTransactionCount(addr, 'finalized')` passes the old nonce. On Base, finalized is about 20 minutes
  (research F1). Until then the payment is "waiting", not "failed": section 8 paid twice when this check used `latest`.
  Because an external sender is rare, this delay costs little.
- **R7. Reconcile at reserve.** `next = max(ledger.next, chain nonce at latest)`. This absorbs an exported key used
  elsewhere while banda was idle. It cannot see an external tx in flight on Base (`pending` = `latest`), so the in-flight
  collisions in section 5 remain. banda's payment still lands once, but an external pending tx with a lower fee is
  **silently replaced** by banda's. The export screen must say so plainly ("don't send from this key in another wallet
  while banda uses it") and offer a fresh wallet instead.
- **R8. Rebroadcast every unconfirmed attempt of the wallet, in nonce order,** on resume and on a timer, not only the one
  that looks missing. Dropping one tx evicted its successor, and a reorged-out tx did not come back to the pool
  (sections 7 and 8).
- **R9. "Included" and "final" are different states.** A receipt at `latest` is "included" in the transaction list. The
  payment is final at `finalized`. If a receipt disappears in a reorg, the payment returns to "broadcast", and its stored
  bytes are rebroadcast (same hash).
- **R10. A taken nonce is always filled.** A payment that cannot be sent after its nonce was taken (insufficient funds)
  is closed by a 0-value self-send at that nonce. That costs gas: a wallet with no ETH for gas stays blocked until it is
  topped up, and the tools must say so.
- **R11. Classify errors by message regex** (table above), never by code.
- **R12. The fault points for `test/fault/`** are the ones in "The pipeline under test", fused or split, plus the four
  replacement points. `mid-broadcast` (bytes sent, reply lost) is the one that tests idempotency. Each needs the same
  invariants as here: once on chain, contiguous nonces, ledger equal to the chain, and store hash equal to chain hash.

### Scenarios this spike backs (V&V seeds)

```gherkin
Scenario: a crash at any boundary never pays twice and never loses a payment
  Given payments s0..s2 requested from one wallet
  When the daemon is killed at <point> while driving <send> and then restarts
  Then each payment is on chain exactly once, the nonces are contiguous and every payment is confirmed
  # point: after-commit | mid-broadcast | after-broadcast | after-receipt (fused); 90/90 + 24/24 random

Scenario: a broadcast whose reply was lost
  Given a payment whose signed bytes are stored
  When the daemon dies after the bytes left it and before the reply was read
  Then on restart the same bytes are sent again and the node answers "already imported" or "nonce too low" with our receipt

Scenario: a stuck payment is sped up, never duplicated
  Given a payment broadcast at nonce N whose fee cap is under the base fee
  When the daemon replaces it with fees at least 12.5% higher at nonce N and is killed at any replacement boundary
  Then exactly one of its attempts is mined and the payment is confirmed with that attempt's hash

Scenario: the same key used in another wallet while banda is idle
  Given the external wallet sent nonce N
  When banda reserves a nonce for a new payment
  Then it reserves N+1 and the payment lands once

Scenario: a foreign transaction takes the nonce of a pending payment
  Given banda's payment is pending at nonce N and a foreign tx at nonce N is mined
  When nonce N is not yet consumed at finalized depth
  Then the payment stays waiting and no transaction is signed at another nonce
  And when it is consumed at finalized depth with no receipt of ours, the payment is signed again at a new nonce and lands once

Scenario: two daemons on one wallet
  Given two processes driving different payments from the same wallet through the store
  Then every payment gets a distinct nonce, the nonces are contiguous and every payment lands once

Scenario: a dropped or reorged-out payment
  Given banda's payment at nonce N and a later one at N+1 were evicted from the pool
  When the daemon rebroadcasts every unconfirmed attempt of the wallet in nonce order
  Then both land, with the hashes stored for them

Scenario: a payment that cannot be sent still fills its nonce
  Given a payment at nonce N fails with "insufficient funds" and a payment at N+1 is queued
  When the daemon sends a 0-value self-transfer at nonce N
  Then N and N+1 are mined and the failed payment is reported as not sent
```

## Open

1. **Base Sepolia.** Whether `eth_getTransactionCount(addr, 'pending')` counts the caller's own unmined txs, and what the
   sequencer replies with for each row of the error table. The `pending` = `latest` result here is an emulation from
   Base's documentation, not a measurement.
2. **A real pool's rules.** The bump threshold, and whether reorged-out txs re-enter the pool. Run the same probes on
   op-geth or base-reth in Docker, which is a CI-only suite per AGENTS. anvil is laxer (1% bumps) and does not re-inject.
3. anvil 1.10.0 (released 2026-11-19) was not tested; rerun on the version the repo pins.
4. Power loss: SIGKILL loses nothing the OS already has. `synchronous=FULL` is what covers power loss in sqlite.
   pi-durable's own durability setting must be checked for the same guarantee.
5. How long the finality wait for a foreign-taken nonce (R6) looks to the owner, and whether `safe` (about 2 minutes on
   Base) is enough. It is enough only if reorgs past `safe` are treated as out of the model.
