# Research: chain operations for an EOA on Base

Topic: operating an externally owned account on Base (OP Stack) from a daemon. Date of research: 2026-11-23.
Scope: heads and finality, fees, submission errors, fee bumps, dropped transactions, viem nonce handling,
public RPC limits, transaction history options, and anvil features for tests.
Method: official docs and specs first, primary source code (go-ethereum, reth, viem, Foundry), package registry
facts, and read-only probes plus a local anvil 1.9.0 micro-spike. No transactions were sent to any network.
Spike sources: `docs/wallets/research/spikes/chain-operations/`.

Read-only probes against `mainnet.base.org` and `sepolia.base.org` were made on 2026-11-23 (eth_blockNumber, safe and
finalized block reads, eth_getLogs). Blockscout and Etherscan were probed without a key.

## Summary

1. **Flashblocks are gone; the premise changed.** Base's Denim upgrade activated on Base Sepolia on 2026-10-21 and on
   Base Mainnet on 2026-11-05 (18:00 UTC). Base now seals a canonical block every 200 ms, and Flashblocks, their
   WebSocket streams and the `newFlashblocks` family stopped. The Flashblocks WebSocket endpoints were shut down on
   2026-11-19. Any integration that uses Flashblocks must migrate to canonical `newHeads` and `logs` subscriptions.
2. **The `pending` tag no longer sees in-flight transactions on Base.** Base's migration guide says `"pending"` is still
   accepted but resolves to the latest canonical block and exposes no preconfirmation state. A daemon must therefore keep
   its own nonce ledger rather than trust `eth_getTransactionCount(addr, "pending")`. The consequence on Base is an inference
   that a spike must confirm on Base Sepolia (see Open questions).
3. **Finality tiers are concrete.** Official Base docs: L2 inclusion about 200 ms; L1 batch posted about 2 minutes;
   L1 batch finality about 20 minutes. Reorg is practically never observed after inclusion (under 0.00000002% of mainnet
   transactions have ever reorged at L2 inclusion; no batched L2 block has ever reorged). Value-bearing decisions should use
   `safe` or `finalized`, not `latest`.
4. **Total cost is three terms, and `eth_estimateGas` covers only one.** After Isthmus and Jovian the cost is
   `operatorFee + gasUsed * (baseFee + priorityFee) + l1Fee`. The L1 fee comes from the GasPriceOracle predeploy
   (`getL1Fee`, `getL1FeeUpperBound`). Balance checks and budgets must include the L1 and operator terms.
5. **Error handling must match messages, not codes.** Geth returns JSON-RPC `-32000` for transaction-pool rejections, and reth
   does the same for several distinct messages (reth issue 19450). Anvil uses `-32003` and different wording. The message table
   in this report is the contract to code against.
6. **Anvil is not a faithful oracle for pool rules.** In a measured spike anvil accepted a +1% fee bump as a replacement
   (geth's default `PriceBump` is 10%), accepted a transaction whose gas is below intrinsic gas and never included it,
   and reports no `l1Fee` in `--optimism` receipts. Fee-bump, intrinsic-gas and L1-fee tests need explicit rules or a real
   op-geth or base-reth node.
7. **Public RPC is not a production dependency.** `mainnet.base.org` states its endpoints are "free, rate limited, and best
   effort" and "not suitable for production apps". In the 2026-11-23 probe, every `eth_getLogs` call was refused with HTTP 429
   and code `-32011`, including 10-block ranges after 3-second pauses. `sepolia.base.org` enforces a 200-block `eth_getLogs`
   range (`-32614`), which contradicts the "under 2,000 blocks" advice on Base's own `eth_getLogs` page.
8. **No history API without a key or a self-index.** Etherscan refuses keyless calls on chain 8453. Blockscout's multichain
   API returns HTTP 402 without a key or an x402 payment. Base Sepolia's Blockscout instance answers keyless. The mainnet
   Blockscout instance returned a Cloudflare challenge to a non-browser client. Native ETH received from a contract cannot be
   seen in logs, so native history needs a provider with internal transactions or balance-delta reconciliation.
9. **viem's nonce manager is process-local.** It keeps counters in memory, and its docs say a failed send does not prove a
   nonce is unused. Two processes signing for one account will collide. A single daemon-owned nonce allocator stored
   durably is the fit with AGENTS principle 1 (one store).

## Findings with sources

### F1. Block production, flashblocks and the heads

- Denim activation dates and the replacement of Flashblocks by 200 ms canonical blocks: docs.base.org/upgrades/denim/200ms-blocks
  (accessed 2026-11-23). Quote: Denim "activated on Base Sepolia on October 21, 2026 at 18:00 UTC and on Base Mainnet on
  November 5, 2026 at 18:00 UTC... Flashblocks are retired." Each 200 ms block "has its own block number, hash, state root,
  receipts, forkchoice updates, and unsafe, safe, and finalized lifecycle."
- Migration table, including the 2026-11-19 WebSocket shutdown and the `flashblock_index` predicate rejection:
  docs.base.org/upgrades/denim/migrate-from-flashblocks (accessed 2026-11-23). Quote: "The `"pending"` block tag is still
  accepted and resolves to the latest canonical block."
- Sequencing: the builder snapshots the pool when a block starts; a transaction arriving later waits for the next block; a
  finished block is sealed and broadcast at once, or at a 150 ms deadline. docs.base.org/specifications/transactions/transaction-ordering
  and the 200 ms page (accessed 2026-11-23). Ordering inside a block is by priority fee.
- Single sequencer: "Base currently operates a single active sequencer", run as a high-availability cluster
  (docs.base.org/specifications/security/reliability-and-liveness, accessed 2026-11-23). If it censors or halts, a deposit
  through the OptimismPortal on Ethereum is the fallback, with a delay of one sequencing window.
- Node requirement: Base Mainnet nodes need base/base v1.5.1 or later; Base Sepolia needs v1.5.0 or later
  (migration guide). Latest base/base release is v1.5.6, published 2026-11-18 (`gh api repos/base/base/releases/latest`).
- Finality timeline and reorg data: docs.base.org/specifications/transactions/transaction-finality (accessed 2026-11-23):
  "After roughly 200ms, the sequencer has built the transaction into an L2 block"; "After roughly 2 minutes, a Base batch
  containing the transaction has been posted to Ethereum"; "The Ethereum L1 batch containing the transaction is older than 2
  epochs, or 64 L1 blocks" for finality (about 20 minutes per the page's figure). Reorg likelihood: "less than
  0.00000002% of transactions have ever reorged" at L2 inclusion; "There has never been a reorg of L2 blocks that were
  batched to Ethereum L1."
- Third-party articles (chainstack.com, onfinality.io, both 2026) quote 5 to 10 minutes for `safe` and 15 to 20 minutes for
  `finalized`. These disagree with the official page on `safe` timing. This report uses the official figures.
- Base's `safe` and `finalized` tags are served by the public RPC. Probe on 2026-11-23: `eth_getBlockByNumber("safe")` and
  `("finalized")` both returned blocks on mainnet.base.org.

### F2. Fees and total cost

- Base fee mechanics: Base's EIP-1559 denominator is 1000, so the base fee changes by small steps each 200 ms block;
  the minimum number of blocks to double the base fee is 174 (about 35 s). Minimum base fee (Jovian): 5,000,000 wei
  (0.005 gwei) on Base Mainnet. Source: docs.base.org/specifications/transactions/network-fees (accessed 2026-11-23).
- L1 fee query: the GasPriceOracle at `0x420000000000000000000000000000000000000F` exposes `getL1Fee(bytes)` for the exact fee of a
  fully serialized signed transaction, `getL1FeeUpperBound(uint256)` for an estimate from byte length, plus `l1BaseFee`,
  `blobBaseFee`, `baseFeeScalar` and `blobBaseFeeScalar`. Same source.
- Total cost formula after Isthmus (OP Stack, applies to the OP-stack fee rules Base inherits):
  `totalFee = operatorFee + gasUsed * (baseFee + priorityFee) + l1Fee`, with `operatorFee = operatorFeeConstant + gasUsed * operatorFeeScalar * 100`
  after Jovian. docs.optimism.io/op-stack/transactions/fees (accessed 2026-11-23). Deposit transactions pay no operator fee.
- Pool-side check: "Transactions without sufficient balance to cover the worst-case total cost (including operator fee) will
  be rejected." Same OP source. The Base network-fees page describes the two-component cost (L2 execution and L1
  security). Whether Base's current configuration includes the operator fee term needs confirmation against Base's
  configuration changelog (Open questions).
- `eth_estimateGas` returns execution gas only. The L1 and operator terms are added separately. This follows from the formula
  above; the report treats it as a rule to enforce in code, not as an RPC guarantee.

### F3. Submission errors (exact text, source-verified and measured)

Geth (source of truth for op-geth's pool rules, which mirror it) at github.com/ethereum/go-ethereum master, accessed 2026-11-23:

| Condition | Error text (exact) | Source |
|---|---|---|
| Nonce below account nonce | `nonce too low` | `core/error.go` `ErrNonceTooLow`; `ValidateTransactionWithState` |
| Nonce gap (only pools that forbid gaps) | `nonce too high` | `core/error.go` `ErrNonceTooHigh`; set only when `FirstNonceGap` is non-nil. Legacy pool sets it to nil, so gapped nonces are queued |
| Balance below cost | `insufficient funds for gas * price + value` | `core/error.go` `ErrInsufficientFunds` |
| Value transfer with no funds | `insufficient funds for transfer` | `ErrInsufficientFundsForTransfer` |
| Gas below intrinsic cost | `intrinsic gas too low` | `core/error.go` `ErrIntrinsicGas`; checked in pool validation via `CheckIntrinsicGas` |
| Same tx already in pool | `already known` | `core/txpool/errors.go` `ErrAlreadyKnown` |
| Same nonce, fee not bumped enough | `replacement transaction underpriced` | `ErrReplaceUnderpriced` |
| Below pool minimum price | `transaction underpriced` | `ErrUnderpriced` |
| Fee cap below base fee | `max fee per gas less than block base fee` | `ErrFeeCapTooLow` |

JSON-RPC code: geth's default for these is `-32000` (`rpc/errors.go`, `errcodeDefault = -32000`). op-geth is a fork of geth;
its pool rules are expected to match but were not read from op-geth's own source in this research (Open questions 2).

reth: the RPC layer maps `NonceNotConsistent` to `NonceTooLow` (crates/rpc/rpc-eth-types/src/error/mod.rs at 45f40fb).
reth issue #19450 (github.com/paradigmxyz/reth/issues/19450) reports that (op-)reth returns `-32000` for `already known`,
`nonce too low`, `replacement transaction underpriced`, `transaction underpriced`, `intrinsic gas too low` and others, so the
code cannot discriminate. Match on message, with a regex for dynamic suffixes such as `nonce too low: next nonce N, tx nonce M`.

Anvil 1.9.0 measured on 2026-11-23 (spike `errors-spike.mjs`, `spike3.mjs`):

| Case | Anvil response | Difference from geth |
|---|---|---|
| Same raw tx again, not mined | code `-32003`, `transaction already imported` | Wording differs from `already known` |
| Nonce used and mined | `-32003`, `nonce too low` | Code differs |
| Same nonce, same fee | `-32003`, `replacement transaction underpriced` | Matches |
| Same nonce, +1% fee and priority | accepted, replaces the first (pool holds the second hash) | Geth requires +10% (`PriceBump: 10`) |
| Fee cap 1 wei | `-32003`, `max fee per gas less than block base fee` | Matches |
| Insufficient balance | `-32003`, `Insufficient funds for gas * price + value` | Capitalised differently |
| Nonce 3 with latest 0 | accepted into queued | Matches the legacy pool's queueing |
| Gas 21000 with two non-zero data bytes (needs 21032) | accepted into pool, never included, no receipt | Geth rejects at submit with `intrinsic gas too low` |
| Gas 21100 (control) | included, status 1 | Expected |

Anvil's `-32003` also differs from the `-32000` default above, so a client that switches on the code breaks across chains.

### F4. Replacement (fee bump) and dropped or stuck transactions

- Geth legacy pool defaults: `PriceBump: 10` (minimum percentage to replace a same-nonce tx), `Lifetime: 3h` (eviction of
  queued transactions), `AccountQueue: 64`, `GlobalQueue: 1024`, `PriceLimit: 1`. Source: go-ethereum `core/txpool/legacypool/legacypool.go`.
  Whether Base's sequencer pool uses these values is not published (Open questions).
- MetaMask support page (support.metamask.io, accessed 2026-11-23): speed-up and cancel use the same nonce, and the
  replacement's priority fee must be "at least 10% higher" than the pending transaction's. Cancel is a same-nonce
  replacement with no value.
- Rabby support pages (bitbox and ngrave articles, accessed 2026-11-23) say a same-nonce transaction overwrites the pending one
  and that Rabby proposes a speed-up. Rabby's exact bump percentage was not found in primary docs.
- Anvil: `anvil_dropTransaction(hash)` removes a pending transaction from the pool. The measured run returned the hash, and
  `eth_getTransactionByHash` and `txpool_status` then showed it gone. Sources: getfoundry.sh/anvil/rpc-methods (accessed 2026-11-23).
- Replacement detection in a daemon: a submitted transaction is `replaced` or `dropped` when the account's latest nonce
  passes its nonce and its hash is not in the block at that nonce, or when the queue lifetime ends without inclusion.

### F5. viem nonce handling and multi-process limits

- viem 2.58.4 (latest, published 2026-11-21 per `npm view viem time`). `createNonceManager({ source: jsonRpc() })` takes
  `eth_getTransactionCount` as the source of truth and consumes nonces locally. Source: viem.sh/docs/accounts/local/createNonceManager
  (page modified 2026-11-03; accessed 2026-11-23).
- Documented caveats: when a send fails after a nonce is consumed, `reset(nonce)` releases it. "A failed send does not prove the
  nonce is unused. The node may have accepted the transaction before the request failed, for example on a timeout. Check the
  account's pending nonce before reusing a released nonce." Same page.
- Known issues: wevm/viem#4364 (`reset()` did not clear the consumed cache, since fixed); wevm/viem#3142 (nonce still advanced when
  an estimateGas failure meant nothing was sent); wevm/viem discussion #1338 (no built-in efficient handling for parallel sends).
  Issue and discussion facts from search excerpts (accessed 2026-11-23).
- Multi-process limit: the counter lives in one process's memory. Two daemons or a daemon plus a CLI sending from one key
  will read the same `pending` count, consume the same nonce, and produce `replacement transaction underpriced` or
  `nonce too low` from the loser. This is a design limit, not a bug. On Base the `pending` source is additionally unreliable
  for in-flight transactions (F1).

### F6. Public RPC endpoints

- Base docs (docs.base.org/get-started/connect-to-base, accessed 2026-11-23): "The public RPC endpoints are free, rate limited,
  and best effort. They are not suitable for production apps." `mainnet.base.org` and `sepolia.base.org` do not serve `debug`,
  `trace` or `txpool`; Base Mainnet "removed these namespaces and lowered the read-request rate limit on October 8, 2026"
  (status notice at status.base.org/incidents/jrs0dpj60tqz, cited by the page).
- Probe, mainnet.base.org, 2026-11-23: `eth_blockNumber`, `eth_getBlockByNumber` with `safe` and `finalized` returned normally. `eth_getLogs` for
  one token address over 10, 200, 1000 and 2000 blocks, with 3-second pauses, returned HTTP 429 with body
  `{"code":-32011,"message":"request limit reached"}` and headers `x-ratelimit-limit: 5, 5;w=1`, `x-ratelimit-remaining: 0`.
- Probe, sepolia.base.org, same day: 10-block `eth_getLogs` returned an empty array; 2000-block returned HTTP 413 with
  `{"code":-32614,"message":"eth_getLogs is limited to a 200 range"}`.
- Base's `eth_getLogs` page (docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getLogs, accessed 2026-11-23)
  says to keep ranges under 2,000 blocks for reliable results. The measured Sepolia limit of 200 disagrees; treat 200 as the
  safe ceiling until a provider is contracted.
- A third-party measurement (boltrpc.io/blog/public-rpc-endpoint-limits, accessed 2026-11-23) reports the same 429 and
  `-32011` pattern for Base's public endpoint and says the limit appears only in the 429 header (25 requests per second, which
  conflicts with the header value seen here; treat both as unstable).

### F7. Transaction history and incoming native ETH

JSON-RPC has no account history method. Options compared:

| Option | Key needed | Base coverage and limits (measured or cited) | Native and internal transfers | Notes |
|---|---|---|---|---|
| Etherscan API v2 (`chainid=8453`) | Yes | Keyless call returned `Free API access is not supported for this chain` (measured 2026-11-23). Free tier: 3 calls/s and 100,000 calls/day on "selected chains only"; Lite is 5 calls/s (docs.etherscan.io/rate-limits, accessed 2026-11-23). Since 2026-11-03 requests are blocked at the daily limit unless overage is enabled | Endpoint coverage for Base not checked; free-tier membership needs a key test | Multichain, one key |
| Blockscout multichain API (`api.blockscout.com`) | Yes (key or x402 payment) | Keyless returned HTTP 402 `Proceed with API key or make a X402 payment` (measured). Per-key limit cited as 10 requests per second (blog.blockscout.com, accessed 2026-11-23) | Via its REST v2 and txlist endpoints | Pricing and tiers not verified |
| Blockscout Base Sepolia (`base-sepolia.blockscout.com/api/v2/...`) | No (dev only) | Keyless address call returned HTTP 200 with balance and fields (measured) | Yes on its own endpoints | Good for tests, not for production volume |
| Blockscout Base mainnet (`base.blockscout.com`) | Unknown | Non-browser request returned HTTP 403, a Cloudflare challenge (measured). Base docs link this instance for reorg data | Unknown | Do not depend on it for a daemon |
| Alchemy `alchemy_getAssetTransfers` | Yes (key in URL) | Documented for Base, categories `external`, `erc20`, `erc721`, `erc1155`, and `internal` on Base; `fromAddress` and `toAddress` queries; `pageKey`; `maxCount` up to 1000 (alchemy.com docs and rotki issue 13344, accessed 2026-11-23). Compute-unit pricing not verified | Yes, including internal | Most complete single call; vendor lock-in |
| Self-index `Transfer` logs | No (RPC only) | `eth_getLogs` with topic0 `0xddf252ad...` and indexed `from`/`to`; range limits from F6 | ERC-20 only | Needs reorg handling and a backfill cursor |

- Incoming native ETH: a plain transfer from an EOA is visible as `tx.value` on a block. A transfer made by a contract (router,
  x402 facilitator, refund) appears only as an internal call. Logs do not show it. Detection options: (a) provider with internal
  transactions (Alchemy `internal`, Etherscan internal list); (b) balance reconciliation, comparing `eth_getBalance(addr, "latest")`
  between checkpoints and explaining the delta from known transactions. Trace methods are not on the public RPC (F6).
- Volume caution: Base produces five blocks per second, about 432,000 per day. Scanning every block's transactions on a daemon
  is not viable; checkpoint at a fixed cadence or subscribe to `newHeads` on a provider WebSocket.
- Dust and spam: no authoritative source was found in this research. The recommendation (Recommendations section) is a
  design choice, not a verified third-party claim.

### F8. anvil and foundry features for tests

- Installed: anvil 1.9.0 (commit 6056c58). Latest Foundry release: v1.10.0, published 2026-11-19 (`gh api repos/foundry-rs/foundry/releases/latest`).
  The spikes ran on 1.9.0; they must be rerun on the version the repo pins.
- Flags confirmed in `anvil --help` (1.9.0): `--port`, `--chain-id`, `--no-mining`, `--block-time` (seconds), `--optimism`,
  `--hardfork`, `--fork-url`, `--fork-chain-id`, `--fork-block-number`, `--block-base-fee-per-gas`, `--gas-price`,
  `--disable-code-size-limit`. `-n, --network` takes `ethereum`, `base`, `optimism`, `tempo` or `monad` (help text, 1.9.0); `base` is the
  network family to try for Base-specific behaviour, not yet measured.
- `--optimism` receipts (measured) contain no `l1Fee`, `l1GasUsed` or `l1GasPrice` fields. The L1 fee in tests must come
  from a mocked GasPriceOracle or from a fork. Base's own tooling, base-anvil (docs.base.org/sdks/base-anvil, accessed 2026-11-23),
  is Base's Foundry fork; forking Base uses `--fork-url` with `--hardfork base:Cobalt` per that page.
- RPC methods (getfoundry.sh/anvil/rpc-methods, accessed 2026-11-23): `anvil_reorg(depth, [[tx, blockIndex], ...])` rewinds
  `depth` blocks and mines replacements, optionally including given transactions; `anvil_rollback(depth)`; `anvil_dropTransaction(hash)`;
  `anvil_dropAllTransactions`. A probe of `anvil_reorg(1, [])` returned `null` with no error. The `anvil_reorg` shape was not run
  with transactions (open).
- Block time: anvil's `--block-time` is integer seconds per help text. A 200 ms cadence is not reproduced, and Denim notes
  that locally mined anvil blocks do not carry BaseTime metadata.

### F9. Package facts (registry and advisories, accessed 2026-11-23)

- `viem` 2.58.4, last published 2026-11-21T00:59:02Z. OSV query `{"package":{"name":"viem","ecosystem":"npm"}}` returned no
  vulnerabilities. The GitHub advisories query returned none for viem.
- `ethers` 6.17.0, published 2026-06-18. OSV: no vulnerabilities.
- `@noble/curves` and `@noble/hashes`: OSV returned no vulnerabilities (relevant for key derivation and signing).
- `@etherspot/prime-sdk` 1.9.2, last modified 2024-12-23. Stale; not recommended for this purpose.
- Foundry v1.10.0 (2026-11-19). base/base v1.5.6 (2026-11-18).

## Libraries table

| Library or service | Version or date | Purpose | Reputation and maintenance | Advisories | Recommendation |
|---|---|---|---|---|---|
| viem | 2.58.4 (2026-11-21) | Signing, RPC client, nonce helpers | wevm; MIT; actively released | OSV none (2026-11-23) | Use. Pin exact. Use its serializers and `estimateFeesPerGas`; own the nonce ledger |
| ethers | 6.17.0 (2026-06-18) | Alternative client | ethers-io; MIT; mature | OSV none | Not needed if viem is used; keep as fallback only |
| @noble/curves, @noble/hashes | current | Cryptographic primitives under viem | paulmillr; audited | OSV none | Transitive via viem; pin through lockfile |
| Foundry anvil | v1.10.0 (2026-11-19), installed 1.9.0 | Local chain for tests, reorgs and drops | Foundry; industry standard | n/a | Upgrade, rerun spikes, use for unit and fault tests |
| base-anvil | docs.base.org/sdks/base-anvil | Base-specific Foundry fork | Base-maintained | n/a | Evaluate for Base forks |
| op-geth or base-reth (Docker) | base/base v1.5.6 (2026-11-18) | Reference node for pool error strings and fees | Base and OP Labs | n/a | Use in a Docker conformance suite |
| Etherscan API v2 | docs current 2026-11-23 | Tx history with key | Etherscan; commercial | n/a | Evaluate with a key whether Base is on the free tier |
| Blockscout | docs current 2026-11-23 | Tx history, explorer REST | Blockscout; open source | n/a | Keyless on Base Sepolia only; key needed for multichain |
| Alchemy Transfers API | docs current 2026-11-23 | Asset transfers with internal | Alchemy; commercial | n/a | Strongest single-call history; evaluate CU cost |

## Risks and CVEs

| Risk | Severity | Source | Description and mitigation |
|---|---|---|---|
| Flashblocks integration breaks | high | Base migration guide | Streams and pending state return nothing since 2026-11-05 (and WebSocket endpoints shut down 2026-11-19). Remove Flashblocks config. Subscribe to `newHeads` and `logs` |
| Nonce collision on `pending` | high | Base migration guide; viem docs | The `pending` tag does not expose in-flight transactions on Base. Keep a durable nonce ledger in the daemon store; never rely on `pending` alone |
| Two signers, one key | high | viem docs and issues | Each process keeps its own counter. One signing process per account, with a single allocator |
| Fee bump too small | high | Geth source; MetaMask doc | Replacement below +10% is rejected on geth. Bump both fee cap and tip by at least 12.5% when replacing |
| Anvil green but mainnet red | high | Spike 3 | Anvil accepts a +1% bump and an intrinsic-gas-low transaction. Pool tests must assert geth rules, not anvil's |
| Underfunded transaction | medium | OP fee doc | `eth_estimateGas` omits L1 and operator fees. Budget with `getL1FeeUpperBound` plus operator-fee bound before submit |
| Public RPC throttling | high | Base docs; probe | `mainnet.base.org` refused every `eth_getLogs` probe with 429. Use a provider with contracted limits and backoff |
| Log range too wide | medium | Probe; Base docs | Sepolia enforces 200 blocks; the docs say 2,000. Chunk at 200 |
| Premature "confirmed" | medium | Base finality doc | `latest` is reversible in theory. Gate value release on `safe` (about 2 minutes) or `finalized` (about 20 minutes) |
| Missing native history | medium | Provider docs | Contract-originated ETH is invisible in logs. Use internal transactions or balance reconciliation |
| Error-code matching | medium | reth issue 19450; anvil spike | `-32000` is shared across messages on reth and geth; anvil uses `-32003`. Match messages |
| Etherscan daily cap | medium | Etherscan rate-limit doc | Requests are blocked at the daily limit, overage off by default since 2026-11-03 |
| viem nonce reset ambiguity | medium | viem docs | A failed send may still have landed (timeout). Check the pending nonce before reuse |
| CVEs | none found | OSV (2026-11-23) | No advisories for viem, ethers, @noble/curves or @noble/hashes. Re-check before each release |

## Recommendations

1. Target Base Mainnet (post-Denim). Remove all Flashblocks endpoints and subscriptions. Use `newHeads` on a provider WebSocket,
   not on `mainnet.base.org`. For Sepolia dev, use `sepolia.base.org` for reads only.
2. Nonce ownership: the daemon allocates nonces from a durable store, one signing process per account. Each submit records
   `{account, nonce, hash, feeCap, tip, state}` before sending (pi-durable exactly-once submit). Use viem's nonce manager
   only inside one process, if at all.
3. Error mapping (match on message, prefix or regex):
   - `already known` or `transaction already imported`: treat as submitted if the hash equals the stored hash; otherwise an error.
   - `nonce too low`: fetch `latest`; if the stored hash is mined, success; otherwise mark `replaced` and reallocate.
   - `replacement transaction underpriced`: bump both fee values by at least 12.5% and resubmit at the same nonce, or cancel with a self-transfer of zero value.
   - `intrinsic gas too low`: bug in gas estimation; fail the send, do not retry.
   - `insufficient funds for gas * price + value` or `insufficient funds for transfer`: surface to the owner as a balance error; do not retry.
   - `max fee per gas less than block base fee`: refresh fees from the latest block and resubmit once.
   - anything else: retry with exponential backoff only if the nonce is still free.
4. Fee budget: `maxFeePerGas` from `latest` base fee plus headroom; `cost = gasLimit * maxFeePerGas + l1FeeUpperBound + operatorFeeBound`.
   Recompute the exact `l1Fee` with `getL1Fee` on the signed bytes before sending when time allows. Record the actual `l1Fee`
   from receipts for the transaction list.
5. Confirmation state machine (for the formal-validation phase): `Created -> Submitted -> Included(latest) -> Safe -> Finalized`,
   with `Replaced`, `Dropped` and `Failed` as terminal alternatives. `Dropped` fires when the nonce is consumed by another hash,
   or when the queued lifetime (3 hours on geth defaults; Base value unverified) passes without inclusion.
6. Transaction history: MVP uses a keyed provider (Alchemy or Etherscan, whichever key the owner chooses) for asset transfers.
   Self-index ERC-20 `Transfer` logs in chunks of at most 200 blocks as a fallback. Native incoming uses balance checkpoints
   plus the provider's internal list. Show only tokens the owner has added or that pass an allowlist (spam guard: a design
   choice, not verified third-party guidance).
7. Tests: keep anvil for unit and fault flows. Add a pool-conformance suite that asserts the message table in F3 against a
   real op-geth or base-reth node in Docker (the Docker suite is CI-only per AGENTS). Mock the GasPriceOracle for L1-fee tests.
   Use `anvil_dropTransaction` and `anvil_reorg` for drop and reorg injection, and assert `Replaced` and `Dropped` transitions.
8. Upgrade anvil to the pinned v1.10.0 and rerun both spikes before any test depends on them.
9. Pin viem to 2.58.4 exactly, as AGENTS principle 13 requires, and re-check OSV before each release.

## Open questions

1. Does `eth_getTransactionCount(addr, "pending")` on Base Sepolia include the caller's own unmined transactions? (Needs a
   funded throwaway key on Sepolia; this is the key evidence for the nonce design in F1 and F5.)
2. What exact messages and codes do base-reth and op-geth return from the Base sequencer for each row of the F3 table? (Needs a
   Docker run of base/base v1.5.6 or op-geth, not done here.)
3. Does Base's sequencer pool use geth's `PriceBump: 10` and queued `Lifetime: 3h`? Base's configuration changelog and status
   pages were not read in full.
4. Is the operator fee term active on Base Mainnet today? The OP docs describe it; Base's network-fees page describes two components.
5. Does a free Etherscan key cover chain 8453? The keyless response only shows that keyless access is refused.
6. Alchemy compute-unit cost per transfer query on Base, and whether `internal` is metered differently.
7. Rabby's exact speed-up percentage.
8. Whether anvil 1.10.0 changes the replacement, intrinsic-gas and receipt behaviours measured in 1.9.0.
9. Whether anvil `--block-time` can express sub-second intervals for a 200 ms test profile.
10. Who the owner's production RPC provider is, and whether it supports `newHeads` over WebSocket.

## Method notes

- Spike commands and outputs are in `docs/wallets/research/spikes/chain-operations/`. Spike 2 was not kept: its nonce loop reused
  values after mining, so its fee-bump result was not reliable. Spike 3 replaces it.
- Accessed dates are 2026-11-23 for all URLs. Quotes are taken from fetched pages. Search excerpts are noted where used.
- No transaction was broadcast to a live network. All writes were to a local anvil with its public dev key and no funds.
