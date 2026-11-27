# Spike: a wallet's transaction list

Date: 2026-11-23. Requirement 7 (docs/wallets.md): each wallet has Send, Receive and a transaction list, as in an
ordinary wallet app. JSON-RPC has no "history of an address" method, so the list needs a source. Everything here is
read-only against public Base Sepolia endpoints and a local anvil. Base mainnet was only read, never written to.
No keys, no transactions on any network except the local anvil, no keychain.

## Goal

1. Can Blockscout's REST API serve the list without a key? Which feeds, fields, pagination, how fresh, what limits?
2. What does Etherscan API v2 do without a key?
3. Can the daemon index the list itself with `eth_getLogs`? What block range and rate limits does a public RPC
   allow, and does the result match Blockscout's?
4. How can the daemon see incoming native ETH without an indexer, including ETH sent by a contract?
5. The design: own sends from the store plus a chosen source for incoming, with what freshness, spam filtering and
   privacy (whoever answers the query learns the address).

## Setup and commands

Node 24.22.1 (global `fetch` and `WebSocket`), Foundry anvil and cast 1.9.0. No npm dependencies, so there is no
lockfile. The addresses are public Base Sepolia addresses, picked because they are busy:

- `PAYEE` `0xA849…79d9` is an EOA paid by x402: 0 transactions of its own and 1,274,766 USDC transfers in.
- `EOA` `0xd244…20e4` is an EOA with native ETH coming in and going out (two plain receipts, 20 sends, and ETH paid
  back to it by contracts). It was found with `find-native.mjs`.
- USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

```sh
node 1-etherscan.mjs                 # Etherscan v2 and Blockscout's Etherscan-style API, no key
node 2-blockscout.mjs                # Blockscout REST v2: freshness, feeds, pagination, rate limit
node 3-getlogs.mjs                   # eth_getLogs: range per endpoint, rate, compared with Blockscout, x402 matching, zero-value transfers
node 3b-mainnet-readonly.mjs         # the same questions on Base mainnet's public endpoints (read-only)
node 3c-archive-depth.mjs https://base-rpc.publicnode.com https://base-sepolia-rpc.publicnode.com https://sepolia.base.org
node 4-native-anvil.mjs              # native ETH: logs vs balance bisection, five kinds of movement (local anvil, free port)
node 5-native-sepolia.mjs            # balance bisection on a real EOA vs Blockscout's feeds
cast run 0x55a4a4c4a2dfbd46591a324b6e8de2347bd15d66c994eddb409059396ef6fd70 --rpc-url https://sepolia.base.org
node 6-freshness.mjs                 # latency: WebSocket subscription vs polling vs Blockscout
node 7-mainnet-sources.mjs           # which history APIs answer for Base mainnet without a key
node 8-authorization-state.mjs       # USDC authorizationState(): did an x402 payment settle?
node 9-unfiltered-volume.mjs         # how many USDC Transfer logs per block (privacy option: fetch all, filter locally)
```

`4-native-anvil.mjs` starts its own anvil on a port the OS assigns and kills it when it ends. No other process,
container or keychain entry was created.

## Observations (trimmed)

### 1. Etherscan API v2 without a key: refused; Base is paid-tier only even with a key

```
etherscan v2 txlist 8453:  {"status":"0","message":"NOTOK","result":"Free API access is not supported for this chain. Please upgrade your api plan ..."}
etherscan v2 txlist 84532: {"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}
etherscan v1 basescan sepolia: "You are using a deprecated V1 endpoint, switch to Etherscan API V2 ..."
```

Etherscan's chain list marks both "Base Mainnet ... Paid Tier Only 8453" and "Base Sepolia Testnet ... Paid Tier
Only 84532" (docs.etherscan.io/supported-chains, accessed 2026-11-23). So a free Etherscan key does not cover Base.
This answers open question 5 in research/chain-operations.md.

### 2. Blockscout REST v2 on Base Sepolia: answers without a key, but its internal feed is incomplete

```
rpc=62585882 blockscout=62585863 lag=19 blocks (3.8 s) newest-block-age=4.6 s       (5 samples: lag 16–28 blocks, 3.2–5.6 s)
indexing-status: {"finished_indexing":false,"finished_indexing_blocks":true,"indexed_blocks_ratio":"1.00","indexed_internal_transactions_ratio":"1.00"}
token-transfers (payee, to, USDC): HTTP 200 items=50 next={"index":14,"filter":"to","token":"0x036C…","block_number":62584835}
  e.g. {"from_scam":false,"rep":"ok","value":"1000","method":"0xe3ee160e", ...}       0xe3ee160e = transferWithAuthorization (EIP-3009, x402)
transactions (eoa): items=22   internal-transactions (eoa): items=4   coin-balance-history (eoa): items=16
pagination: 3 pages x 50, unique=150, descending=true (cursor = block_number + index, not page numbers)
rate limit: 60 requests (20 concurrent) all 200; headers x-ratelimit-limit 150, remaining 61, reset ~38–178 s
```

- Three separate feeds make a wallet's history (transactions, internal transactions, token transfers), joined by
  transaction hash, as Blockscout's own guide says (docs.blockscout.com/best-practices, accessed 2026-11-23).
- Its token endpoints hide "known scam airdrops" by default; the `show-scam-tokens` header turns that off (same page).
  Every address carries `is_scam` and `reputation` fields.
- Without a key the per-instance limit was 150 requests per window, with the window reset at most about 3 minutes
  away (x-ratelimit-reset is in milliseconds: github.com/blockscout/blockscout `apps/block_scout_web/rate_limits.md`,
  accessed 2026-11-23). The Etherscan-style `/api` route on the same host reported `x-ratelimit-limit: 10` with a reset
  about an hour away.
- **The internal-transactions feed missed ETH.** Balance bisection (section 4) found six blocks where contracts paid
  `EOA`; Blockscout's internal feed listed four. For the missing two it still answered, about 15 minutes after the
  blocks (12:59 UTC, checked at 13:14 UTC):
  `{"items":[],"meta":{"message":"Some internal transactions within this block range have not yet been processed","status":2}}`,
  while the indexing status said `indexed_internal_transactions_ratio: "1.00"`. `cast run` on one of those
  transactions shows the payment: `0xD2448C6C…::receive{value: 1274130000000000}()`, the exact amount bisection
  computed.
- **`coin-balance-history` is a sample, not a change log.** It skipped 6 of the 22 blocks where the balance changed
  (each skipped change shows up folded into the next point's delta). Where it has a point, its value matched chain
  state (0 disagreements).
- The `counters` endpoint still said `"transactions_count":"0"` for `EOA` after it had 22 transactions.
- Base mainnet (`7-mainnet-sources.mjs`): `base.blockscout.com` returned HTTP 403 with a Cloudflare challenge
  (`cf-mitigated: challenge`); the multichain `api.blockscout.com` returned HTTP 402
  `{"error":"Proceed with API key or make a X402 payment to continue"}` for 8453 and 84532. With a free key:
  100K credits a day at 5 requests per second; address token-transfers cost 30 credits, internal-transactions 40,
  coin-balance-history 50, others 20 (docs.blockscout.com/rate-limits, accessed 2026-11-23). Polling three feeds is
  90 credits, so about 1,100 polls a day for one wallet: one every 78 s.

### 3. Self-indexing with `eth_getLogs`

```
https://sepolia.base.org: max range 200 (refuses 201: HTTP 413 {"code":-32614,"message":"eth_getLogs is limited to a 200 range"})
https://base-sepolia-rpc.publicnode.com: max range 50000 (refuses 50001: {"code":-32701,"message":"exceed maximum block range: 50000"})
https://base-sepolia.drpc.org: answers up to 12 blocks, then HTTP 408 {"message":"Request timeout on the free plan, please upgrade to paid plan","code":30}
sepolia.base.org rate: 40 sequential eth_getLogs all 200 in 5608 ms; 20 concurrent all 200; no rate-limit headers
self-index vs blockscout (USDC to PAYEE, 2000 blocks, 200-block chunks): rpc logs=118 (10 calls) blockscout=118 only-rpc=0 only-blockscout=0
x402 matching: transfers matched to AuthorizationUsed=118 unmatched=0; of 5 sampled, tx.from == payer: 0
zero-value USDC Transfer logs, last 1000 blocks: transfers=155 zero-value=0
```

Base mainnet, read-only (`3b-mainnet-readonly.mjs`, `3c-archive-depth.mjs`):

```
mainnet.base.org eth_getLogs (10, 200, 1000, 10000 blocks): HTTP 429 {"code":-32011,"message":"request limit reached"} x-ratelimit-limit "5, 5;w=1", every time
mainnet.base.org eth_getBalance at head-1,000 / -1,000,000 / -20,000,000: all answered
base-rpc.publicnode.com eth_getLogs up to 10,000 blocks: 200; state served back to block 51477980 (2026-09-18),
    older: {"code":-32602,"message":"Archive requests require a personal token. ..."}
base-sepolia-rpc.publicnode.com: state back to 2026-10-23, older {"message":"state at block #49187730 is pruned"}
sepolia.base.org: state served 40,000,000 blocks back
```

- The range limit is per endpoint and differs by 250x, so the daemon must find it rather than assume it. The 200 on
  `sepolia.base.org` disagrees with Base's own advice of "under 2,000 blocks" (research/chain-operations.md F6).
- Base's own mainnet endpoint is unusable for logs; another endpoint (the owner's, or a public one such as
  publicnode) must serve them.
- **The agent's x402 payments are not its transactions.** Every one of the 118 USDC payments to `PAYEE` sits in a
  transaction sent by someone else (the facilitator), so a wallet's own x402 payments never appear in a "transactions
  of this address" feed. Each is paired with `AuthorizationUsed(payer, nonce)` in the same transaction (118 of 118).
  And `authorizationState(payer, nonce)` on USDC answers whether a given authorization was used
  (`8-authorization-state.mjs`): `1` for a used nonce, `0` for a fresh one, `0` for the used nonce one block before it
  was used. It is a single `eth_call`, needs no log scan, and only flips once, from 0 to 1.
- Unfiltered scanning, which would hide the addresses from the RPC, costs: 337 USDC Transfer logs in 50 mainnet blocks
  (6.7 a block, about 2.9 million a day, 225 KB of JSON per 50 blocks, so roughly 1.9 GB a day for USDC alone).
  Base Sepolia had 0.1 a block.

### 4. Incoming native ETH without an indexer: balance bisection

Logs cannot show native ETH. A plain transfer is visible as `tx.value` in its block, but scanning every block's
transactions means 432,000 blocks a day. ETH paid by a contract (a refund, a router, a SELFDESTRUCT, a bridge
deposit's mint) appears only in traces, and public endpoints refuse them: `debug_traceTransaction` on
`sepolia.base.org` gave `-32611 rejected due to request filter settings`, publicnode gave `-32601 ... does not
exist`, and drpc gave `Temporary internal error`.

Balance bisection uses only `eth_getBalance` and `eth_getTransactionCount` at past blocks (`bisect.mjs`). An EOA's
balance can only go down through a transaction it signs, and that moves its nonce. So over a range where the nonce did
not move, the balance never decreases, and equal balances at both ends mean nothing changed inside. Where the nonce
moved, the range is split whatever the balances. This holds for OP Stack deposits too: "we still increment the nonce
of the from account when a deposit transaction is executed" (specs.optimism.io/protocol/deposits.html, accessed
2026-11-23). EIP-7702 delegation, which could let code spend without a nonce move, needs the EOA's own signature, and
banda refuses to sign one (docs/wallets.md "Keeping the bound true"). Each change block is then explained from that
block's transactions: own sends (value + fee), direct receipts (`tx.to == W`), and the rest, which is native value
that arrived some other way.

Local anvil, five kinds of movement padded with empty blocks, plus a forged `Transfer(from=W, 0)` from a contract
that is not a token:

```
expected movements: direct@504 1; internal call@1205 0.5; selfdestruct@1506 0.25; own send@2407 -0.1; own send (same block)@2608 -0.05; internal call (same block)@2608 0.3
eth_getLogs Transfer(to=W): 0 logs; Transfer(from=W): 1 logs (... block 3009, value 0; the forged one at 3009)
balance bisection over 3606 blocks: 5 change blocks, 104 state reads, 20 ms
  block 504:  delta 1     = own 0     + direct 1 + other 0
  block 1205: delta 0.5   = own 0     + direct 0 + other 0.5
  block 1506: delta 0.25  = own 0     + direct 0 + other 0.25
  block 2407: delta -0.100021000000147 = own -0.100021000000147 + direct 0 + other 0
  block 2608: delta 0.249978999999853  = own -0.050021000000147 + direct 0 + other 0.3
verdict: expected blocks=5 found=5 missed=[] extra=[] poison-block-reported=false
```

Real EOA on Base Sepolia, public RPC:

```
bisection https://sepolia.base.org over 1300 blocks: 22 change blocks, 306 state reads, 20884 ms
  62583827: delta 50000000000000000 own 0 (0 tx) direct 50000000000000000 other 0
  62583997: delta -622638678000230 own -622638678000230 (1 tx) direct 0 other 0
  62584419: delta 1272722909999874 own -1407090000126 (1 tx) direct 0 other 1274130000000000   <- missing from Blockscout's internal feed
  62584652: delta 3442383773118808 own -1211238000125 (1 tx) direct 0 other 3443595011118933   <- missing from Blockscout's internal feed
  ... (22 rows)
  fully explained by own+direct: 16/22
blockscout: transactions=22 internal=4 coin-balance-history points=16
  blocks in tx+internal feeds=22; bisection-only=[] feeds-only=[]
  change blocks missing from coin-balance-history: 6
  coin-balance-history values disagreeing with chain state: 0
```

- Bisection found every change, including ETH from contracts and a receipt in the same block as an own send. Logs saw
  none of the native movements and one forged event.
- The fee rule `gasUsed * effectiveGasPrice + l1Fee` (plus the operator fee when the receipt carries
  `operatorFeeScalar`/`operatorFeeConstant`; no Base Sepolia receipt did) reproduced all 16 own sends to the wei.
- Cost: about `2 * log2(span)` state reads per change, and 2 reads per poll when nothing changed. A poll every 40 s
  (200 blocks) costs about 16 reads for a change.
- It needs state at past blocks. `sepolia.base.org` serves it 40M blocks back, `mainnet.base.org` served it 20M
  blocks back, and publicnode serves a rolling window (about 66 days on mainnet). A daemon offline for longer than its
  RPC's window can only bisect from the oldest block it can still read, and will say so.
- What it cannot give: the sender of ETH paid by a contract. It gives the block and the amount, and the transaction
  only when it is the block's sole candidate.

### 5. Freshness

```
wss://sepolia.base.org logs subscription: error   (HTTP upgrade answered 405 Method not allowed)
wss://base-sepolia-rpc.publicnode.com logs subscription (30 s): ok; latency n=8 median=288 ms max=683 ms
poll eth_getLogs every 2 s (13 polls x 2 requests): latency n=5 median=1085 ms max=2429 ms
blockscout newest transfer to payee: block 62588240, rpc head 62588264, 6.0 s old
```

Latency is arrival time minus block timestamp. Base block timestamps are whole seconds while blocks come every
200 ms (blocks 62586881 and 62586885 share a timestamp), so each figure is uncertain by up to 1 s.

## Verdict

- **No keyless third party can serve Base mainnet history.** Etherscan is paid-only for Base; Blockscout's mainnet
  host challenges scripts, and its multichain API wants a key or an x402 payment. Blockscout's Base Sepolia host
  answers keyless and is useful for cross-checks in tests, but its internal-transaction feed was incomplete 15 minutes
  after the block, and its balance history is sampled.
- **Self-indexing through the owner's RPC is complete and exact.** USDC transfers in: 118 of 118, identical to
  Blockscout over 2,000 blocks. Native ETH in, by balance bisection: every change found, on anvil (5 of 5, including
  ETH from contracts and SELFDESTRUCT) and on a real EOA (22 of 22, including two contract payments Blockscout missed),
  confirmed by `cast run`.
- **Outgoing never needs an indexer.** Own transactions come from the store, followed by receipt. Own x402 payments
  are not the wallet's transactions at all, and their state comes from `authorizationState(wallet, nonce)` and the
  authorization's `validBefore`.

## What it means for the design

**Sources.** Each row of the transaction list comes from one of three places, and only the first two are truth:

| Row | Source | State from |
|---|---|---|
| Send (owner or agent), contract call | the payment's effect in the store, written in its start commit | receipt of the stored transaction hash: pending, confirmed (`safe`), failed, replaced |
| x402 payment | the payment's effect in the store (authorizer, nonce, validBefore) | `authorizationState(wallet, nonce)`: 1 means settled; still 0 after `validBefore` means expired, which is final. The settling transaction is `AuthorizationUsed(wallet, nonce)`, looked up in the block where the state flipped (it flips once, so bisection finds that block) |
| Token received | `eth_getLogs` for `Transfer(to ∈ the home's wallets)` on the pinned token contracts of each chain, through the RPC the owner named, in chunks of that RPC's range, with a cursor | derived, rebuildable from the chain |
| ETH received | balance and nonce checkpoints at each poll; an unexplained change starts a bisection between the two checkpoints | derived, rebuildable within the RPC's state window |
| Sent outside banda | bisection finds a nonce move with no effect in the store (the key was exported and used elsewhere, requirement 5) | shown as such; the nonce ledger must reconcile to it (research/chain-operations.md) |

The incoming rows and cursors are derived data, kept so the list opens instantly and rebuilt by rescanning (principle
1: anything that is not the store's truth is derived and rebuildable). A row found above the `safe` head shows as
confirming and is checked once, by receipt and block hash, when `safe` passes it. That costs one call per row, not per
poll; Base reorgs after inclusion are practically never seen (research/chain-operations.md F1).

**One query shape per chain, whatever the number of wallets.** Topics allow a list in one position, so one filter
`{address: [pinned tokens], topics: [Transfer, null, [w1, w2, …]]}` covers every wallet of the home. No `from` filter is
needed: outgoing comes from the store. The range limit is found when the RPC is chosen (bisect it like
`3-getlogs.mjs`) and stored with the choice, not assumed. If an RPC answers 429 on `eth_getLogs`, as `mainnet.base.org`
always did, it cannot back the list, and Settings must say so when the owner picks it.

**Freshness.** While a wallet screen is open or a payment is awaited: a `logs` subscription where the RPC offers one
(publicnode: median 0.3 s), otherwise poll every 2 s (median 1.1 s). Idle: poll every 40 s, so each poll is one chunk
of 200 blocks at the strictest range seen. At that cadence one chain costs about 2,160 polls a day, each with one
`eth_getLogs`, one head read and two state reads per wallet (batchable), plus bisection only when ETH arrives. The
owner's own sends appear at once from the store and never wait for an indexer.

**Spam and poisoning.** These are rules on what enters the list, so none of them depends on a third party's scam
list:

- Tokens are matched by pinned contract address per chain, never by symbol or name. A transfer of any other token is
  not ingested.
- Zero-value transfers are dropped.
- `Transfer(from = wallet)` logs are never read. Outgoing comes from the store, so the forged or zero-value
  `transferFrom` shape (shown on anvil) cannot enter the list as a payment the wallet made.
- An incoming row never becomes a recipient, never fills Send's address field, and never appears in
  `wallet__recipients`. Recipients come only from the owner's rules (docs/wallets.md), so dust from a look-alike
  address is harmless.
- Blockscout's default scam filter is a third party's opinion. banda does not need it, and its absence is not a gap.

**Privacy.** Whoever answers the history query learns the addresses, the IP and how often they are polled.
Self-indexing through the RPC the owner already named adds no new party: that RPC already sees the balance reads and
the broadcasts. Blockscout or Etherscan would add a second party, so they appear only as an explorer link the owner
opens. The single filter over all wallets links them in one request, but the same IP links them anyway. Fetching
every token Transfer and filtering locally would hide the addresses from the RPC, at about 2.9 million logs a day for
mainnet USDC, while balance reads and broadcasts would still name the address. It is not the default. Settings says
plainly what the chosen RPC learns (docs/wallets.md "Chains, RPC and privacy").

**For the fault suite and scenarios.** Points to test:

- the cursor commit after an `eth_getLogs` chunk;
- the checkpoint commit before and after a bisection;
- a kill during a bisection, which reruns from the stored checkpoints and gives the same rows;
- an RPC whose range is smaller than the stored one (`-32614`, `-32701`): re-probe, never skip blocks;
- a 429 mid-scan: back off, keep the cursor;
- a checkpoint older than the RPC's state window: say how far back the list is complete;
- an x402 authorization that expires unused: final state "expired", never "pending" forever;
- a nonce move with no effect in the store: a "sent outside banda" row.

Anvil reproduces every native case offline: `anvil_mine` for gaps, `evm_setAutomine false` for same-block cases,
hand-assembled forwarder, SELFDESTRUCT and forged-Transfer contracts (`4-native-anvil.mjs`).

## Open questions

1. Which mainnet RPC banda proposes by default for logs, since `mainnet.base.org` refuses `eth_getLogs`. publicnode
   worked keyless here, but its terms and limits for sustained use were not checked.
2. Whether Base mainnet receipts carry `operatorFeeScalar`/`operatorFeeConstant` now. Base Sepolia receipts did not,
   and the fee rule above needs those fields when they exist.
3. Blockscout's keyless per-instance window length. The headers show a limit of 150 and a reset of at most about 178 s,
   but the period itself is configured per instance and not published.

## Sources (accessed 2026-11-23)

- Etherscan supported chains and tiers: https://docs.etherscan.io/supported-chains
- Blockscout best practices (feeds, scam filter, headers): https://docs.blockscout.com/best-practices
- Blockscout API rate limits and credit costs: https://docs.blockscout.com/rate-limits
- Blockscout rate-limit headers: https://github.com/blockscout/blockscout/blob/master/apps/block_scout_web/rate_limits.md
- OP Stack deposits (nonce increment): https://specs.optimism.io/protocol/deposits.html
- Prior research this builds on: ../../research/chain-operations.md (F6 public RPC limits, F7 history options)
- Measurements: the scripts in this folder, run on 2026-11-23 between 12:57 and 13:15 UTC.
