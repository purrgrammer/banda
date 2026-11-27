# Spikes: the outside-world assumptions under the wallet scenarios

Status: analysis for the RFC in [`../../../wallets.md`](../../../wallets.md), run on 2026-11-23. Nothing here is a
DESIGN.md rule (principle 6).

## Goal

Several scenarios in [`../../features/`](../../features/) expect behaviour that comes from outside banda: what anvil
does with `safe`, `finalized` and `anvil_reorg`, what USDC and the x402 facilitator answer, what a pool says to a
rebroadcast or a bump, what Base charges, what the keychain library and Electron offer. Some of these claims had
evidence in an earlier spike. Others rested on a research note, on documentation, or on nothing. These micro-spikes
confirm or refute each claim with the smallest run that can. Every scenario that rests on one of them carries an
`# Evidence: spikes/gaps/README.md §X` comment above its tags.

| § | Claim the scenarios rest on | Verdict |
|---|---|---|
| A | anvil 1.9.0's `safe` and `finalized` follow `--slots-in-an-epoch`; `anvil_reorg` undoes an inclusion | confirmed, with three limits the runner must respect |
| B | x402 scenarios run offline on a state file "taken once from the x402 spike's fork" | **refuted**: a fork's `anvil_dumpState` drops the token's code; a fixture built from the prestate tracer works |
| C | Base serves `safe` and `finalized` for every read the follower makes | confirmed for reads; `eth_getLogs` refuses the `finalized` tag on Sepolia |
| D | pool answers: "already known", "nonce too low", "replacement transaction underpriced"; a bump of +12.5% on both fees | confirmed on geth and reth; **refuted**: a fee cap below the base fee is not an error on either |
| E | the balance falls by gas × price + the L1 fee, and the receipt says how much | confirmed on Base; anvil charges no L1 fee, and a Base fork charges it without saying so |
| F | the facilitator's `settlement_pending` is a claim; windows come from chain time (C19) | confirmed; **refuted in part**: the reference facilitator checks the window against its own wall clock |
| G | the desktop shell can ask for an OS re-authentication before a reveal | macOS only (Touch ID or the password), from source and docs; no Electron API on Linux |
| H | an orphan keychain item can be listed (`findCredentials`) | confirmed; it returns every secret, and a locked Linux collection makes it throw |

## Setup

| | Version |
|---|---|
| Host | darwin-arm64, Darwin 27.2.0; Docker 29.8.2 (OrbStack) |
| Node | v24.22.1 on the host (the repo pins Node 26; these spikes use no Node 26 feature); v24.22.3 in the keychain image |
| anvil | 1.9.0, commit `6056c5845d34205a83cf7108042adb137325c9df` (the version `../../stack.md` pins) |
| npm packages | exact pins in [`package.json`](package.json): `@x402/core`, `@x402/evm`, `@x402/express` 2.32.0, `express` 5.3.0, `viem` 2.58.4, `micro-eth-signer` 0.20.1, `@noble/curves` and `@noble/hashes` 2.4.0, `@napi-rs/keyring` 2.1.2 |
| geth | `ethereum/client-go:v1.17.10`, `sha256:5015dcab74ec5c9ef6584ada930ea353264a1c4e72383f256802e3178e10918c` |
| reth | `ghcr.io/paradigmxyz/reth:v2.10.1`, `sha256:5637e3e2f6a88fb63512dd8837b254aa55a71132e3ac3587bbc797de7609f818` |
| Electron | 45.2.3 (the version `desktop/package.json` pins): typings from the npm tarball, implementation from the `v45.2.3` tag |
| Keychain image | [`../keychain/Dockerfile`](../keychain/Dockerfile) (Debian bookworm, dbus, gnome-keyring), plus two files |

Every anvil binds a port the system assigned (`lib.mjs`), and every container and volume is named
`banda-spike-<random hex>` and removed when the run ends. No transaction reached a public network: Base's endpoints
were only read, and forks ran in a local anvil. Keys are anvil's public development keys or freshly generated ones.

## Files and commands

| File | What it does |
|---|---|
| `lib.mjs` | anvil on a system-assigned port (killed when the process ends), raw JSON-RPC that keeps errors verbatim, a transfer signer (RFC 6979, so a re-signed transfer has the same hash) |
| `anvil-tags/tags.mjs` | §A: the tags against `--slots-in-an-epoch`, state at each tag, `anvil_reorg`, block timestamps |
| `x402-state/make-state.mjs` | §B: forks Base Sepolia (reads only), runs every USDC path, reports what `anvil_dumpState` keeps, and builds the fixture from the prestate tracer |
| `x402-state/check-state.mjs` | §B: offline, on the fixture: domain, settle, events at each tag, replay, strict expiry, cancel, a stale fixture's clock |
| `x402-state/pending.mjs` | §F: the reference facilitator's clock check at each skew, and `settlement_pending` end to end through `@x402/express` |
| `pool-errors/pool.mjs` | §D: geth and reth in Docker, every pool answer the lane can meet |
| `base-fees/probe.mjs` | §C and §E: Base Sepolia and mainnet, read-only: tag lag, tag acceptance, `eth_getLogs` limits, GasPriceOracle, receipts and balances |
| `base-fees/fork.mjs` | §E: does anvil (plain, `--optimism`, `-n base`, a Base fork) charge an L1 fee, and does its receipt say so |
| `base-fees/devcode.mjs` | §B side check: anvil's development accounts on Base |
| `electron-reauth/fetch.sh` | §G: fetches the Electron typings and the macOS implementation; nothing runs, nobody is prompted |
| `keyring-find/find.mjs`, `find-linux.sh`, `run-linux.sh` | §H: `findCredentials` on macOS, and on Linux unlocked and locked |
| `out*.txt` | what each run printed |

```
cp -r docs/wallets/spikes/gaps "$SCRATCH/gaps" && cd "$SCRATCH/gaps" && npm install   # never inside the repo
node anvil-tags/tags.mjs
cd x402-state && node make-state.mjs && node check-state.mjs && node pending.mjs && cd ..   # make-state reads sepolia.base.org once
node pool-errors/pool.mjs                     # pulls the two pinned images; about 3 min
node base-fees/probe.mjs && node base-fees/fork.mjs && node base-fees/devcode.mjs
sh electron-reauth/fetch.sh
node keyring-find/find.mjs                    # macOS: writes and deletes two items under banda-spike-<random>
cd keyring-find && sh run-linux.sh
```

`make-state.mjs` writes `usdc-84532.state.json` (64,647 bytes: public contract code and storage only). The file is not
committed here; the runner commits the fixture it uses, built the same way.

## A. anvil 1.9.0: tags, reorgs and time (`anvil-tags/`)

**Tags.** With `--slots-in-an-epoch N`, `safe` = max(0, latest − N) and `finalized` = max(0, latest − 2N). The default is
N = 32: at latest 64 the tags read 32 and 0, at 100 they read 68 and 36. The same holds with `--optimism` and with
`-n base`.

**State at each tag.** A balance set with `anvil_setBalance` shows at `latest` at once. It shows at `safe` only after
N + 1 mined blocks, and at `finalized` after 2N + 1: the change belongs to the next mined block. A transaction mined in
block b is at `finalized` once latest ≥ b + 2N. `eth_getTransactionCount` at `pending` counts anvil's pool. At `safe` and
`finalized` it follows the tags.

**Reorgs** (`--no-mining`, N = 1, transactions A at block 1, B at block 8, C at block 10):

```
anvil_reorg(1, [])  -> null; C gone; heads 10/9/8 unchanged; pool empty (C is not returned to it)
anvil_reorg(3, [])  -> null; B gone, though block 8 was the finalized head; heads still 10/9/8
anvil_reorg(10, []) -> null; A gone too; heads still 10/9/8
rebroadcast of the stored bytes of A, B and C -> the same hashes; all three mined in block 11
anvil_reorg(2, [[C.raw, 0]]) -> null; A, B and C all gone: C (nonce 2) was dropped silently, because A and B were removed
```

Verdict: confirmed, with three limits:
1. anvil does not protect finality. A reorg of any depth is accepted, even one that rewrites a block at or below
   `finalized`, and the tags still report latest − N and latest − 2N. The runner never reorgs deeper than 2N.
   Otherwise "finalized" stops meaning what the model means by it.
2. A reorged transaction is not returned to the pool. It lands again only when the lane rebroadcasts its stored bytes,
   which is what the scenarios expect (same bytes, same hash).
3. A transaction listed for re-inclusion in `anvil_reorg` is dropped when an earlier nonce of the same sender is not
   included first. A step that re-includes transactions lists every earlier nonce, in nonce order.

**Time.** `evm_setNextBlockTimestamp` works under `--no-mining`, and chain time then stays ahead of the wall clock. Going
back is refused verbatim: `{"code":-32602,"message":"Timestamp error: <t> is lower than previous block's timestamp"}`.
`evm_mine({timestamp, blocks})` works.

## B. The offline USDC fixture (`x402-state/make-state.mjs`, `check-state.mjs`)

The x402 scenarios run on a plain anvil with chain id 84532, loaded from a state file
([`../../features/ISOLATION.md`](../../features/ISOLATION.md) section 3). The file was to be "taken once from the x402
spike's fork".

**Refuted.** On a fork of Base Sepolia at block 62634289, `anvil_dumpState` kept 16 accounts. The USDC proxy was there
with 8 slots, but the FiatTokenV2_2 implementation was not. A fork's dump holds what the fork changed locally, not what
it read from upstream. A state loaded from it has a proxy that delegates to empty code.

**What works.** The fixture is built from `debug_traceTransaction` and `debug_traceCall` with the prestate tracer, over
every path the scenarios use: the views, settle, replay and cancel. It holds the code of every account that has code,
and every non-zero slot read at the fork block (the throwaway payer's and payee's balance slots are skipped). That is
three accounts:
- the proxy `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (1798 B);
- the implementation `0xd74cc5d436923b8ba2c179b4bCA2841D8A52C5B5` (23464 B), read from the proxy's zos implementation
  slot `0x7050c9e0…f8c3`, not the EIP-1967 slot;
- the SignatureChecker library `0xba3b60c21e28c41df4babd90f228e1d368627da6` (1741 B).

The fixture also holds 6 slots, 64,647 bytes in all. The library is easy to miss: without it, settle reverts with a
bare `execution reverted` (an `EXTCODESIZE` check on the library fails).

On the fixture, offline (`--no-mining --slots-in-an-epoch 1`):

```
DOMAIN_SEPARATOR 0x71f17a3b…c9818, equal to the fork's; name "USDC", version "2"
settle: status 0x1, gasUsed 103232, Transfer and AuthorizationUsed logs; payer's ETH still 0
authorizationState: latest true at once; safe true after +1 block; finalized true after +2 blocks
eth_getLogs(AuthorizationUsed, toBlock "finalized"): 1 log
replay: "FiatTokenV2: authorization is used or canceled" (mined: status 0x0)
same signature, another payee: "FiatTokenV2: invalid signature"
block time validBefore - 1: ok; block time validBefore: "FiatTokenV2: authorization is expired";
  mined anyway: status 0x0 and authorizationState stays false (an expired nonce is never burnt)
cancelAuthorization: status 0x1, AuthorizationCanceled log, authorizationState true; settle after it: "used or canceled"
```

**The fixture's clock.** A loaded state keeps the dumped block's timestamp, and chain time continues from it, not from
the wall clock. The fixture made minutes earlier loaded 20 s to 382 s behind. The same fixture shifted 30 days back
loaded 2,592,020 s behind. `evm_setNextBlockTimestamp(<now>)` and one `evm_mine` bring it to 0 s. With the facilitator's
wall-clock check (§F), a window taken from chain time on an unadjusted fixture is refused as expired.

**Side finding** (`base-fees/devcode.mjs`). On Base Sepolia and on Base mainnet, anvil's public development accounts
are not fresh EOAs. Dev accounts 0 and 2 (and on mainnet also 1) carry an EIP-7702 delegation (`0xef0100…`), and all
three have nonces above 0. On a fork they behave as those chains say, not as on a plain anvil.

## C. Base's public endpoints (`base-fees/probe.mjs`, read 2026-11-23 15:57 UTC)

| | Base Sepolia | Base mainnet |
|---|---|---|
| latest − safe | 833 to 860 blocks, 166 to 172 s | 73 to 207 blocks, 15 to 41 s |
| latest − finalized | 5315 to 5342 blocks, 1063 to 1069 s | 5868 to 5894 blocks, 1173 to 1178 s |
| wall clock − latest block's timestamp | 0.2 to 0.9 s | 0.4 to 1.0 s |
| `eth_getTransactionCount`, `eth_getBalance`, `eth_call` at `safe` and `finalized` | accepted | accepted |
| `eth_getLogs` | numeric ranges up to 200 blocks; `toBlock: "finalized"` → `-32602 "invalid block range params"`; 1000 blocks → `-32614 "eth_getLogs is limited to a 200 range"` | every call `-32011 "request limit reached"` |

Three samples 2.5 s apart; six consecutive reads of `finalized` on Sepolia agreed. Both chains make a block every 0.2 s,
so "finalized" is about 18 minutes behind on Sepolia and about 20 on mainnet.

Verdict: the follower's reads (`authorizationState` and the nonce at `finalized`, the balance at `safe`) work as the
scenarios assume. `eth_getLogs` does not take the tag on Sepolia: the follower resolves `finalized` to a number
first, and pages in ranges of at most 200 blocks. anvil accepts the tag, so the scenarios cannot catch this; it is an
implementation note, not a scenario change. Mainnet's public endpoint refuses `eth_getLogs` outright, as the tx-history
spike found.

## D. What a pool answers (`pool-errors/`)

geth 1.17.10 and reth 2.10.1, each in `--dev`, once with a block every 600 s (the pool keeps what it holds) and once
mining on demand. A, B and C are versions of one nonce: A has cap 10 gwei and tip 1 gwei, B is +10% on both, C is
+12.5% on B. Verbatim:

| Case | geth 1.17.10 | reth 2.10.1 | anvil 1.9.0 (`../nonce-and-crash/`) |
|---|---|---|---|
| A again, pending | `-32000 "already known"` | `-32000 "already known"` | `-32003 "transaction already imported"` |
| other payload, same fees / +9% | `-32000 "replacement transaction underpriced"` | same | accepts +1% |
| B: +10% on cap and tip, exactly | accepted | accepted | accepted |
| tip only +100%, or cap only +100% | `"replacement transaction underpriced"` | same | tip only: underpriced |
| C: +12.5% on B | accepted; A no longer known by hash | same | accepted |
| A's bytes after two bumps | `"replacement transaction underpriced"` | same | same |
| nonce gap (nonce + 2) | accepted, `queued: 1` | accepted, `queued: 1` | — |
| A again, after it was mined; or other bytes at that nonce | `-32000 "nonce too low: next nonce 1, tx nonce 0"` | same, verbatim | `-32003 "nonce too low"` |
| cap 1 wei, tip 1 wei | **accepted** (waits in the pool) | `-32000 "transaction underpriced"` | `"max fee per gas less than block base fee"` |
| cap = base fee − 1, tip 0 | `-32000 "transaction gas price below minimum: gas tip cap 0, minimum needed 1"` | **accepted**; included once the base fee fell under it | `"max fee per gas less than block base fee"` |
| too little ETH | `-32000 "insufficient funds for gas * price + value: balance 0, tx cost …, overshot …"` | `-32003 "insufficient funds for gas * price + value: have 0 want …"` | `"Insufficient funds for gas * price + value"` |
| wrong chain id | `-32000 "invalid sender: invalid chain id for signer: have 1 want 1337"` | `-32000 "invalid chain ID"` | — |

Verdict:
- Confirmed: a rebroadcast is answered "already known" while pending (anvil: "transaction already imported") and
  "nonce too low" once mined.
- Confirmed: a replacement needs at least +10% on both fee fields on geth and on reth. A bump of either field alone is
  refused, so C6's +12.5% on both is enough.
- Confirmed: codes do not separate cases (reth gives `-32003` for funds and `-32000` for the rest), so the classifier
  matches messages, case-insensitively.
- Confirmed: the lane's rule "underpriced: never send another payload at this nonce" holds. An older, lower version is
  refused, not resurrected.
- **Refuted**: the nonce-and-crash error table's `fee-low` row (`max fee per gas less than block base fee` → a new
  version with fresh fees) is anvil's behaviour only. Neither geth nor reth refuses a fee cap below the current base
  fee: geth keeps it if the tip is at least 1 wei, and reth if the cap is above its floor. The transaction then waits,
  and no error ever arrives. The bump scenario stands, because its trigger is "the base fee rose", which the lane reads
  from the chain. What changes is how the trigger is realised: the lane compares the stored version's fee cap with the
  latest base fee and bumps after it has waited. It never waits for a pool error. anvil passes a too-small bump (+1%)
  that both real pools refuse, so the bump arithmetic needs a unit test. The op-geth or base-reth box suite
  (ISOLATION section 3) is the end-to-end check.

## E. The L1 fee (`base-fees/probe.mjs`, `fork.mjs`)

**Base.** On both networks, every receipt of a plain transaction in recent blocks carried `l1Fee`, `l1GasPrice`,
`l1GasUsed`, `l1BaseFeeScalar`, `l1BlobBaseFee`, `l1BlobBaseFeeScalar`, `daFootprintGasScalar` and `blobGasUsed`.
The sender's balance fell by exactly `value + gasUsed × effectiveGasPrice + l1Fee` for 23 of the 24 senders checked.
The 24th moved ETH inside its call. The operator fee is 0 today. The GasPriceOracle at `0x4200…000F` answers on both
chains: `isEcotone`, `isFjord`, `isIsthmus` and `isJovian` are all true, and `getOperatorFee(21000)` is 0.
`getL1FeeUpperBound(110)` is 200 wei on Sepolia and 12,584,989,365 wei on mainnet.

**anvil.**

| Run | Spent beyond `value + gasUsed × effectiveGasPrice` | Receipt fee fields |
|---|---|---|
| plain anvil | 0 | none |
| `--optimism` | 0 | none |
| `-n base` (plain) | 1,600,000,000,000 wei | none |
| fork of Base Sepolia, with or without `-n base` | 163 wei (the fork's `getL1FeeUpperBound(110)`: 195) | none |

Verdict: confirmed on Base. The fee a row shows and the reserve's L1 term (C11) come from the receipt's `l1Fee` and
from `getL1FeeUpperBound`. On anvil, plain and `--optimism` charge no L1 fee. `-n base` and a fork charge one that no
receipt field explains. The transfer scenarios therefore run on a plain anvil, never `-n base` or a fork. There, the
balance equals the sum of what the receipts say, and the L1 term of the reserve is tested against a GasPriceOracle
the runner sets (as `../../research/chain-operations.md` says).

## F. The x402 facilitator (`x402-state/pending.mjs`)

Both checks ran on the gap B fixture, with `@x402/express` 2.32.0 in front of an in-process `x402Facilitator`
(`@x402/core` and `@x402/evm` 2.32.0), whose signer is dev account 1.

**The window and the clock.** The window is C19's: `validAfter` = t − 5 and `validBefore` = t + 60, where t is the
latest block's timestamp. The skew is chain time minus the wall clock, set with `evm_setNextBlockTimestamp`:

```
fixture as loaded (-382 s)        -> invalid_exact_evm_payload_authorization_valid_before
skew 0 s, -50 s, +4 s             -> isValid true
skew -60 s, -119 s                -> invalid_exact_evm_payload_authorization_valid_before
skew +10 s, +119 s                -> invalid_exact_evm_payload_authorization_valid_after
```

The source says why (`@x402/evm` 2.32.0, `dist/cjs/exact/facilitator/index.js` lines 1299 to 1318): the facilitator
takes `now = Math.floor(Date.now() / 1e3)`, refuses `validBefore < now + 6` and refuses `validAfter > now`. So C19's
window passes only while chain time is between 54 s behind and 5 s ahead of the facilitator's clock. C19 pauses x402
signing only above 120 s of skew.

Verdict: **refuted in part**. The token checks the window against block time (§B, confirmed), but the reference
facilitator checks it against its own wall clock. When chain time and the facilitator's clock differ by more than that
band (a stalled sequencer, a payee whose clock is off), banda signs a window that verify refuses. The failure is
liveness, not money: verify refuses before any broadcast, nothing moves, and the authorization expires and is released
(H-237). No scenario asserts on the skew, so none changes. C19 anchors the window to both clocks for this reason,
and keeps the 120 s pause to bound the window's length. For the runner, a scenario that runs this facilitator keeps chain time
within that band until the header is handed, and moves block time past `validBefore` only after the header is handed
(the change to ISOLATION section 5).

**`settlement_pending` end to end.** The facilitator's receipt wait is cut to 1.5 s, and the anvil mines nothing.

```
paid request: HTTP 402 after 3016 ms (the server retried settle once), the route's handler ran, the body was withheld ("{}")
  PAYMENT-RESPONSE {"success":false,"errorReason":"settlement_pending","errorMessage":"timed out waiting for the receipt",
                    "transaction":"0xa7fa…b054","network":"eip155:84532","payer":"0x70dF…6Fb7"}
chain: the settlement is in the pool (pending 1), authorizationState false
the same header again, before any block: HTTP 402, the handler ran again, settlement_pending with the SAME transaction,
  pool still 1 (the facilitator's pending store deduplicated it; no second broadcast)
after one block: authorizationState true, payee holds 10000
the same header again: HTTP 402, handler not run, PAYMENT-REQUIRED error "invalid_exact_evm_nonce_already_used"
```

Verdict: confirmed. `settlement_pending` is a claim that names a transaction which is not yet on chain. Only the
chain decides (the scenario "The facilitator says settlement_pending…" holds): `authorizationState` turned true one
block later. The run also shows what the chat must be told. The payment settled, but the resource was never
delivered. Each retry ran the payee's handler without returning its body, and once settled the retry is refused as a
used nonce. "What the chat is told matches the chain" therefore means "paid, the server did not deliver", never "not
paid" (H-236).

## G. OS re-authentication in Electron 45.2.3 (`electron-reauth/`)

Nothing ran and nobody was prompted. From the typings (`electron.d.ts`, `@platform darwin` on both) and the
implementation at the `v45.2.3` tag (`shell/browser/api/electron_api_system_preferences_mac.mm`):
- `systemPreferences.canPromptTouchID()` is true only when the policy `LAPolicyDeviceOwnerAuthenticationWithBiometricsOrWatch`
  can be evaluated and the biometry type is Touch ID.
- `systemPreferences.promptTouchID(reason)` evaluates an access control made with
  `kSecAccessControlUserPresence`. Apple documents that flag as "biometry or passcode", and biometry need not be
  available or enrolled. So the prompt accepts Touch ID, or the login password where there is no Touch ID.
- Both are declared for macOS only, and the typings hold nothing comparable for Linux (no polkit or password prompt).

Verdict: on macOS, UC-02's "Touch ID or password" is available through Electron (from source and documentation, not a
run). On Linux, Electron offers nothing. The reveal capability (C16, the step "the reveal comes from the host's desktop
shell") has no evidenced way to ask for an OS re-authentication on the Linux desktop app: open.

## H. Listing keychain items (`keyring-find/`)

`findCredentials(service)` and `findCredentialsAsync` from `@napi-rs/keyring` 2.1.2, under services named
`banda-spike-<16 random hex>` (and the same with `-other`), on macOS (the login keychain) and on Linux in the keychain
spike's image (gnome-keyring, store pinned to `secret-service`):

```
                                   macOS (8.1 ms)                 Linux (5.0 ms)
2 items under the service          2, each with its secret        2, each with its secret
service + "-other" (1 item)        1                              1
a prefix of the service            0 (exact match)                0 (exact match)
a service never written            0                              0
after an overwrite                 2, the new secret              2, the new secret
after a delete                     1                              1
Linux, login collection locked     -                              throws in 4.3 ms: "zbus error: org.freedesktop.Secret.Error.IsLocked:
                                                                    Cannot get secret of a locked object"
cleanup                            0 items left                   0 items left
```

On Linux an Entry writes the attributes `service` and `username` (the account), which is what `findCredentials` searches
and returns. The source at the `v2.1.2` tag (`src/entry.rs`) explains macOS: the query names the class and the service
(no other item is read), then reads each item's password, and an item whose password cannot be read is silently left out.

Verdict: confirmed, with three consequences for "no keychain item is left without a record" (C15):
1. The listing returns every key of the service in clear. It runs only in the signer child (C20), and only accounts
   leave it.
2. On Linux a locked collection makes the listing throw. The orphan check then reports that it could not list; it
   never reports "no orphan".
3. On macOS an item the process cannot read (another binary's item, a denied prompt) is missing from the list. That
   case was read from source, not run: provoking it would put a prompt in front of the person at the screen.

The match on the service is exact, so the service name decides which homes' items a listing sees.

## Refutations and the fixes made

| § | Assumption | What the spike showed | Fixed in |
|---|---|---|---|
| B | the fixture is "taken once from the x402 spike's fork" | a fork's dump drops the implementation and the library | ISOLATION.md section 3: built with the prestate tracer, chain time set after load |
| A | "whether `finalized` follows `--slots-in-an-epoch` is checked before the runner relies on it" | it does (latest − 2N), but `anvil_reorg` rewrites finalized blocks without complaint, and drops re-included transactions whose predecessors are gone | ISOLATION.md section 3; STEPS.md realisations of the reorg, finalized and funds-at-safe steps |
| D | a fee cap below the base fee comes back as an error (`fee-low`) | only on anvil; geth and reth accept it and it waits | payments.feature's bump comment; this README (the nonce-and-crash table is the spike's record and is not rewritten) |
| E | an anvil fork can stand in for Base's L1 fee | the fork charges it, but no receipt field shows it; `-n base` charges a fee too | ISOLATION.md section 3: plain anvil for transfer scenarios |
| F | windows from chain time are accepted while the skew is under 120 s | the reference facilitator's band is 54 s behind to 5 s ahead | ISOLATION.md section 5; x402.feature's header comment; C19 anchors the window to both clocks |
| H | `findCredentials` lists orphan items | it does, with secrets; it throws on Linux when locked; macOS may omit an item | STEPS.md realisation of `no keychain item is left without a record` |

No `Then` changed: every refutation moves how a step is realised or what the runner does, not what the table decides.

## Open

- macOS with the login keychain locked, a Deny on its prompt, and a session without a GUI. None was run, because each
  needs a prompt in front of the person at the screen, or a change to the keychain search list (a security setting).
  The scenario "The keychain locks…" is evidenced on Linux only (`../keychain/`).
- `promptTouchID` was not run: on a Mac with Touch ID, on one without, or in the packaged app. Linux needs another
  mechanism for the reveal's re-authentication (polkit or a password check), and none is designed.
- op-geth and base-reth themselves (the box suite's nodes) were not run. geth and reth stand in for their pools. Base's
  `pending` tag (latest since Denim, per `../../research/chain-operations.md`) was not re-probed.
- C19's skew threshold against the facilitator's band (§F). Other facilitators (Coinbase's hosted one) were not probed.
- A real Base Sepolia settlement through a hosted facilitator: testnet funds were not used.

## Cleanup

Every anvil the spikes started was stopped. `lib.mjs` kills its children on exit, after an earlier crashed run left
one orphan, which was then killed. The geth and reth containers and the geth volume were removed (`containers left:
none`), and so were the two images pulled for them. The keychain image was removed after its run. The keychain items under the spike's services were deleted and
checked absent on both platforms. Nothing was written to `~/.banda` or to any keychain item outside the spike's
services. `node_modules` and the state file stayed in the scratch folder.

## Sources

- anvil 1.9.0, the installed binary: `anvil --version` (commit `6056c58`), run 2026-11-23.
- `@x402/core`, `@x402/evm`, `@x402/express` 2.32.0: https://www.npmjs.com/package/@x402/evm (read 2026-11-23); the
  tarball's `dist/cjs/exact/facilitator/index.js` (error names lines 401 to 454, the time check lines 1299 to 1318);
  repository https://github.com/x402-foundation/x402 (read 2026-11-23).
- USDC on Base Sepolia: the proxy, implementation, library, domain and storage, read from https://sepolia.base.org at
  block 62634289 on 2026-11-23.
- geth: https://github.com/ethereum/go-ethereum/releases/tag/v1.17.10 (published 2026-10-23, read 2026-11-23);
  image `ethereum/client-go:v1.17.10` at the digest above.
- reth: https://github.com/paradigmxyz/reth/releases/tag/v2.10.1 (published 2026-11-06, read 2026-11-23); image
  `ghcr.io/paradigmxyz/reth:v2.10.1` at the digest above.
- Base: https://sepolia.base.org and https://mainnet.base.org, read-only JSON-RPC on 2026-11-23 between 15:57 and
  16:04 UTC.
- Electron 45.2.3: https://registry.npmjs.org/electron/-/electron-45.2.3.tgz (`electron.d.ts`), and
  https://github.com/electron/electron/blob/v45.2.3/shell/browser/api/electron_api_system_preferences_mac.mm (tag
  object `e60e4ee5`), both read 2026-11-23.
- Apple, `userPresence`: https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/userpresence
  (read 2026-11-23).
- `@napi-rs/keyring` 2.1.2: `index.d.ts` in the npm tarball, and
  https://github.com/Brooooooklyn/keyring-node/blob/v2.1.2/src/entry.rs (tag commit `6700db4e`), read 2026-11-23.
