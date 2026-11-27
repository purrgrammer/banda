# Spike: x402 settlement on a Base Sepolia fork

Recorded 2026-11-23 on darwin-arm64, Node v24.22.1, anvil 1.9.0. It used an anvil fork of Base Sepolia (chain 84532)
read from the public RPC `https://sepolia.base.org`, fork USDC written with `anvil_setStorageAt`, and keys generated for
each run. There were no funds, no testnet writes and no mainnet.

## Goal

Answer three questions before the RFC's x402 section (docs/wallets.md, "x402: the endpoint is what the daemon saw")
turns into design:

1. What does the token itself enforce on an EIP-3009 `transferWithAuthorization`: replay, expiry, a changed recipient,
   the domain, an amount over the balance, cancellation?
2. What goes over the wire between an x402 v2 client, a resource server and a facilitator, exactly, and what happens
   when the same payment arrives twice or at another resource?
3. What must the daemon check before it signs, and why does the authorization's random nonce make an x402 payment
   idempotent?

## Files

| File | What it does |
|---|---|
| `lib.mjs` | Starts anvil on a free port (port 0 bound first), as a fork of Base Sepolia at `latest - 10` (or `FORK_BLOCK`), or plain with chain id 84532. Sets up viem clients and finds USDC's balance slot by probing. |
| `eip3009.mjs` | Part 1: the token's own rules, viem only. A payer holding no ETH signs and a separate facilitator account submits (anvil's public dev account 1). |
| `roundtrip.mjs` | Part 2: the official v2 packages end to end. An Express server with `paymentMiddleware`, an in-process `x402Facilitator` settling on the fork, and an `x402Client`. Then replay, concurrent duplicates, a cross-resource attempt, and signing done the daemon's way without the SDK client. |
| `sdk-trust.mjs` | Part 3: what the official client (2.32.0) signs when the 402 is hostile. Uses a plain local anvil only for the RPC reads the SDK makes. Nothing is broadcast. |
| `package.json` | Exact pins: `viem` 2.58.4, `@x402/core` 2.32.0, `@x402/evm` 2.32.0, `@x402/express` 2.32.0, `express` 5.3.0. |

## Commands

Run it in a scratch directory, never in the repo:

```sh
mkdir spike && cd spike
cp <repo>/docs/wallets/spikes/x402-settlement/{lib,eip3009,roundtrip,sdk-trust}.mjs <repo>/docs/wallets/spikes/x402-settlement/package.json .
npm install --ignore-scripts          # 95 packages in the tree, "found 0 vulnerabilities" on 2026-11-23
node eip3009.mjs                      # needs anvil on PATH and https://sepolia.base.org reachable
node roundtrip.mjs
node sdk-trust.mjs                    # offline: plain anvil, no fork
```

Each script starts its own anvil on a free port and stops it on exit. Set `FORK_BLOCK=<n>` to rerun at a fixed block.
Set `FORK_URL` to use another Base Sepolia RPC.

Integrity of the tarballs used (`npm view <pkg>@<v> dist.integrity`, 2026-11-23): `@x402/core`
`sha512-HyS8vbaR…ZcQIA==`, `@x402/evm` `sha512-dgsBYsUG…kRZ7Q==`, `@x402/express` `sha512-aPZDcDsS…70AGw==`,
`viem` `sha512-zeYi2Pli…2j8MQ==`.

## Observed (trimmed)

### Part 1: the token's rules (`node eip3009.mjs`, fork block 62585872)

```
A. EIP-712 domain
  name() "USDC" version() "2"
  DOMAIN_SEPARATOR() 0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818
  computed with name "USDC":     0x71f17a3b…c9818 match=true
  computed with name "USD Coin": 0x2f5ab5ee…f068b match=false
B. Happy path
  funded payer … with fork USDC via anvil_setStorageAt (balance mapping slot 9)
  before: payer 10.000000 USDC, payee 0.000000 USDC, payer ETH 0 wei
  signing the same stored message again gives the same bytes (RFC 6979): true
  authorizationState before: false
  facilitator submits: success … gasUsed 102808
  token logs in receipt: 2 (Transfer + AuthorizationUsed)
  authorizationState after: true
  after: payer 9.000000 USDC, payee 1.000000 USDC, payer ETH 0 wei
C. Replay the same signed authorization
  replay (simulated): REVERT "FiatTokenV2: authorization is used or canceled"
  replay forced on chain with fixed gas: status reverted, facilitator paid 40883 gas
  after replay: payer 9.000000 USDC, payee 1.000000 USDC, payer ETH 0 wei
D. Validity window
  validBefore passed while waiting (now+60, then +120 s): REVERT "FiatTokenV2: authorization is expired"
  validAfter in the future: REVERT "FiatTokenV2: authorization is not yet valid"
  validBefore = latest block time (expired by inclusion …): REVERT "FiatTokenV2: authorization is expired"
E. Tampering
  same signature, to = another address: REVERT "FiatTokenV2: invalid signature"
  same signature, value = 2 USDC: REVERT "FiatTokenV2: invalid signature"
  same signature, validBefore extended: REVERT "FiatTokenV2: invalid signature"
  signed with the Base mainnet domain name "USD Coin": REVERT "FiatTokenV2: invalid signature"
  a4 still unused after the tampered attempts: authorizationState false; it remains settleable as signed:
  a4 as signed: success … gasUsed 85752
F. Authorization over the balance, settled after a top-up
  50 USDC with less in the wallet: REVERT "ERC20: transfer amount exceeds balance"
  authorizationState: false
  wallet topped up to 100 USDC
  same authorization after the top-up: success … gasUsed 85744
G. Re-signing the same intent with a fresh nonce
  first signature: success …
  second signature (same to/value, new nonce): success …
  payee received 2.000000 USDC for one intent
H. cancelAuthorization
  cancel an unsettled authorization: success (submitted by a relayer: the payer holds no ETH)
  authorizationState after cancel: true
  settle after cancel: REVERT "FiatTokenV2: authorization is used or canceled"
  settle first: success …
  cancel after settlement: REVERT "FiatTokenV2: authorization is used or canceled"
  c1 (cancelled): authorizationState true, AuthorizationUsed logs 0, AuthorizationCanceled logs 1
  c2 (settled): authorizationState true, AuthorizationUsed logs 1, AuthorizationCanceled logs 0
```

### Part 2: the v2 wire format and duplicates (`node roundtrip.mjs`, fork block 62586361)

```
1. GET /weather without payment
  status 402
  headers {"cache-control":"no-store","content-type":"application/json; charset=utf-8","payment-required":"<base64, 528 chars>"}
  body (28 bytes): {"error":"Payment required"}
  PAYMENT-REQUIRED decodes to:
    { "x402Version": 2, "error": "Payment required",
      "resource": { "url": "http://127.0.0.1:<port>/weather", "description": "Weather now", "mimeType": "application/json" },
      "accepts": [ { "scheme": "exact", "network": "eip155:84532", "amount": "10000",
                     "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "payTo": "0x…",
                     "maxTimeoutSeconds": 120, "extra": { "name": "USDC", "version": "2" } } ] }
2. Client builds the payment
  request headers: {"PAYMENT-SIGNATURE":"<base64, 1044 chars, standard alphabet: true>"}
  PAYMENT-SIGNATURE decodes to:
    { "x402Version": 2,
      "payload": { "authorization": { "from": "0x…", "to": "0x…", "value": "10000", "validAfter": "0",
                                      "validBefore": "1795439268", "nonce": "0xaf3f…4119" },
                   "signature": "0x8c5f…a41c" },
      "resource": { …the same object as in the 402… },
      "accepted": { …the accepts[0] entry, verbatim… } }
  validBefore - now = 120 s (maxTimeoutSeconds 120)
3. GET /weather with PAYMENT-SIGNATURE
  status 200 body {"temp":21}
  headers {"cache-control":"private","content-type":"application/json; charset=utf-8","payment-response":"<base64, 236 chars>"}
  PAYMENT-RESPONSE decodes to: {"success":true,"transaction":"0xdde6…3a80","network":"eip155:84532","payer":"0x…"}
  on chain: success, from 0x7099…79c8 (the facilitator), payee +0.010000 USDC
4. Replay the same PAYMENT-SIGNATURE (sequential)
  status 402, handler ran 0 time(s), payee +0.000000 USDC
  error in PAYMENT-REQUIRED: invalid_exact_evm_nonce_already_used
5. One fresh payment, the same header sent 3 times concurrently
  status 402 settle success=false errorReason=invalid_exact_evm_transaction_failed body={}
  status 402 settle success=false errorReason=invalid_exact_evm_transaction_failed body={}
  status 200 settle success=true body={"temp":21}
  handler ran 3 time(s), facilitator txs sent 1, payee +0.010000 USDC
6. Payment built for /weather sent to /forecast (same price and payTo)
  status 200, /forecast handler ran 1 time(s), payee +0.010000 USDC
  what the payer signed binds: from, to, value, validAfter, validBefore, nonce + domain(name, version, chainId,
  verifyingContract); payload.resource is {"url":"…/weather",…} and is not signed
7. Daemon-style signing (no SDK client), shorter window than the server asked
  window 60 s (server asked 120); status 200 body {"temp":21}; payee +0.010000 USDC
  permit2 transfer method: refused: transfer method is not EIP-3009
  10-year timeout: accepted, window 60 s
  other asset: refused: asset is not the pinned USDC
  mainnet domain name: refused: domain name/version differ from the pinned table
  resource for another path: refused: resource differs from the observed URL
  gas-sponsoring extension: refused: extensions erc20ApprovalGasSponsoring
```

Each of the three headers is the standard-alphabet base64 (with padding, not base64url) of UTF-8 JSON. This matches
`encodePaymentSignatureHeader` = `safeBase64Encode(JSON.stringify(payload))` and the decoder's regex
`/^[A-Za-z0-9+/]*={0,2}$/` in `@x402/core` 2.32.0. Node's `fetch` shows response header names in lower case, and the
SDK reads `payment-signature` or `PAYMENT-SIGNATURE`. For `x402Version: 1` the same client sends `X-PAYMENT` and reads
`X-PAYMENT-RESPONSE` (from the `@x402/core` 2.32.0 source; v1 was not run here).

### Part 3: what the official client signs for a hostile 402 (`node sdk-trust.mjs`)

```
a. maxTimeoutSeconds = 10 years
  default x402Client: SIGNED
     validBefore - now = 315360000 s (~10.0 years)
b. amount = 1000 USDC
  default x402Client (spendControls default): REFUSED (… spendControls.maxAmountPerPayment ($1, including USDC) …)
  x402Client with spendControls: false: SIGNED
c. asset = a token that is not the default USDC
  default x402Client: REFUSED (… only default assets or entries in spendControls.allowedAssets are allowed …)
  x402Client with spendControls: false: SIGNED
d. extra.name = "USD Coin" on eip155:84532 (the token says "USDC")
  default x402Client: SIGNED  (server-supplied name; no check against the token or the SDK's own default-asset table)
e. extra.assetTransferMethod = permit2 and the server declares erc20ApprovalGasSponsoring
  default x402Client, documented signer (local account + publicClient): SIGNED
     Permit2 PermitWitnessTransferFrom: token 0x036C…CF7e amount 10000 spender 0x4020…0001 witness.to 0x…
     plus a SIGNED RAW TRANSACTION: to 0x036c…cf7e (the token) approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, 2^256-1) chainId 84532 nonce 0
  default x402Client, minimal signer (address + signTypedData only): SIGNED
     approval transaction present: false; Permit2 witness signature present: true
f. a policy that refuses everything but EIP-3009 on the pinned USDC, short validity
  hostile permit2 challenge: REFUSED
  10-year validity: REFUSED
  ordinary challenge: SIGNED
```

The source agrees with these results. The citations are to the `@x402/evm` and `@x402/core` 2.32.0 tarballs, with
the paths taken from their source maps, in https://github.com/x402-foundation/x402, read 2026-11-23:
- `typescript/packages/mechanisms/evm/src/exact/client/eip3009.ts`: `validAfter: "0"`, `validBefore: now +
  paymentRequirements.maxTimeoutSeconds`. The domain's `name` and `version` come from `requirements.extra`.
- `typescript/packages/mechanisms/evm/src/exact/client/erc20approval.ts`: signs a transaction calling
  `approve(PERMIT2_ADDRESS, maxUint256)`.
- `typescript/packages/core/src/client/x402Client.ts`: `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"`, plus a default-asset
  allowlist, both applied in `selectPaymentRequirements`.
- `typescript/packages/mechanisms/evm/src/exact/facilitator/eip3009.ts`: refuses `to != payTo`,
  `validBefore < now + 6`, `validAfter > now` and `value != amount`, then simulates. It sets no upper bound on
  `validBefore`, which is why a window the payer chooses below `maxTimeoutSeconds` is accepted (step 7).

## Verdict

1. **The token enforces at most one transfer per (payer, nonce), whoever submits it and however often.** A replay
   reverts with "authorization is used or canceled", both simulated and mined. A changed recipient, amount or window
   reverts with "invalid signature", and the tampered attempt does not burn the nonce. Expiry and not-yet-valid are
   checked against block time with strict inequalities. The payer spends no gas: its ETH stayed at 0 wei throughout.
2. **The official v2 packages work end to end on a fork with an in-process facilitator.** The wire format is three
   base64 JSON headers: `PAYMENT-REQUIRED` on the 402, `PAYMENT-SIGNATURE` on the retry, `PAYMENT-RESPONSE` on the
   answer. A sequential replay gets 402 `invalid_exact_evm_nonce_already_used`. Three concurrent copies of one payment
   produced one transfer and one 200, but the handler ran three times.
3. **A header built by the daemon's own code, without the SDK client, is accepted by the official server and
   facilitator.** That holds with a 60 s window where the server asked for 120 s. The daemon can therefore choose the
   window and pin the domain.
4. **The official client must not be the daemon's signer.** The 402 controls the validity (10 years was accepted),
   the domain name, and the transfer method. With the signer composition the SDK documents for a local key
   (`toClientEvmSigner(account, publicClient)`), a server that asks for Permit2 with gas sponsoring gets a signed raw
   `approve(Permit2, 2^256-1)` on the wallet's USDC. Its default spend controls cap the amount ($1) and the asset, but
   nothing else.
5. **The nonce is the idempotency key, and the chain is the oracle.** Re-sending the same signed bytes is harmless.
   Signing the same intent again with a fresh nonce pays twice (G). A signed authorization stays live until it is
   used, cancelled or expired, even when the balance was short at signing time (F).

## What it means for the design

### What the daemon checks before it signs (in the start commit)

`daemonSign` in `roundtrip.mjs` step 7 is the executable sketch. Together with the RFC's rule and observation, the
checks are:

1. **Provenance.** The challenge is a proxy observation of the box's request, named by the tool, never content the
   agent passes. The endpoint is the observed origin and path. The challenge's `resource.url`, which is unsigned, must
   match it, or the daemon refuses.
2. **Version and scheme.** `x402Version` 2 (v1 only behind a flag), `scheme` `exact`, and `network` a CAIP-2 id in the
   wallet's chains.
3. **Asset and domain from a pinned table, never from `extra`.** `asset` must equal the pinned USDC for that chain.
   `extra.name` and `extra.version` must equal the table's values (Base Sepolia `"USDC"`/`"2"`, Base `"USD Coin"`/`"2"`;
   the SDK's own `defaultAssets.ts` agrees), or the daemon refuses. A wrong name only produces a signature the token
   rejects (E), but a mismatch means the server is broken or hostile.
4. **EIP-3009 only.** Refuse `assetTransferMethod` other than `eip3009`, and refuse any extension that asks the payer
   to sign (`erc20ApprovalGasSponsoring`, `eip2612GasSponsoring`). This is the RFC's "Keeping the bound true" applied
   to x402.
5. **Recipient.** `payTo` must be a valid address. It must not be the zero address, the token or the wallet itself.
   The rule is resolved on (endpoint, `payTo`): Always on an endpoint covers only the `payTo` it was granted with, and
   a changed `payTo` asks.
6. **Amount.** A positive integer in atomic units, at most the spendable balance (see "Reservation"), shown to the
   owner with the pinned decimals.
7. **Window chosen by the daemon.** `validAfter` 0. `validBefore` = now + min(`maxTimeoutSeconds`, a cap such as
   60 s), and refuse a `maxTimeoutSeconds` too short to settle (the official facilitator needs at least 6 s).
8. **Nonce.** 32 bytes from the CSPRNG. The message `{from, to, value, validAfter, validBefore, nonce}` is committed
   with the effect before any signature exists. Signing is deterministic (RFC 6979, B), so a crash after the commit
   re-derives the identical signature, never a second one.

### Why the nonce makes the payment idempotent, and the rule that keeps it so

- Every delivery of the same signed authorization moves money at most once: retries, crash-resends, concurrent copies,
  the server or a third party submitting it directly (C, steps 4 and 5). The box may resend the stored header freely.
  Money is safe, though the server's handler may run again (step 5).
- A fresh nonce for the same intent is a second payment (G). So the daemon never re-signs an intent while an earlier
  authorization can still settle. The earlier one is dead only when the chain shows one of three things:
  `AuthorizationUsed` (paid, so done), `AuthorizationCanceled`, or a block time at or past `validBefore` with
  `authorizationState` still false (expired). A short window bounds this wait to about a minute.
- **A facilitator's `PAYMENT-RESPONSE` is a claim, not the outcome.** The outcome is
  `authorizationState(from, nonce)` plus the indexed events. The state flag is true for both paid and cancelled (H),
  so only the events tell them apart. A missing or failed response before `validBefore` leaves the payment pending,
  and the daemon reconciles it from the chain.
- `cancelAuthorization` can end an outstanding authorization early. It is itself a transaction (relayed here, or
  self-submitted with ETH), and it races settlement; the chain decides which lands (H). It is optional for slice 3,
  because the short window makes it rarely worth the gas.

### Reservation: "the balance is the cap" needs outstanding authorizations counted

An authorization signed for more than the wallet holds fails now and settles after a top-up, as long as it is still
valid (F). So the daemon's spendable balance is the chain balance minus the sum of its own unexpired, unconsumed
authorizations, computed in the same commit that takes the nonce. Without this, two concurrent payments can each fit
the balance while together they do not. An old authorization signed over the balance would also take the next
deposit. Short windows keep the reservations short.

### State of one x402 payment (input to the state-machine work)

```
observed ─rule─▶ denied | asked ─owner─▶ admitted ─commit(message, nonce, reservation)─▶ signed
signed ─header to box─▶ sent
sent ─chain: AuthorizationUsed──────────────────────▶ paid       (terminal)
sent ─chain: AuthorizationCanceled──────────────────▶ cancelled  (terminal)
sent ─chain: block.timestamp ≥ validBefore ∧ ¬used─▶ expired    (terminal; reservation released; a retry is a new intent)
```

The facilitator's answer moves nothing: only the chain does. Fault points to add for x402: after the commit and before
signing, after signing and before the header reaches the box, after the server received it and before it answered, a
facilitator that answers failure but settled, and one that answers success but did not.

### Libraries

- Do not put `@x402/fetch` or the `x402Client` in the daemon's signing path. The daemon builds the payload itself:
  about 20 lines of typed data plus base64 JSON. This narrows the research report's recommendation to pin the SDK
  client. If the SDK is kept at all, keep it for its types or for decoding, at exact 2.32.0. It is a server-side
  dependency in the test harness (`@x402/express`, `x402Facilitator`), where it makes a good local 402 endpoint for
  slice 3's walkthrough and fault tests.
- The typed-data signing here used viem 2.58.4. The signing-libraries report's choice (micro-eth-signer on noble 2.x)
  needs only EIP-712 for this one struct. Check it against the same fork transcript (domain separator match, A) when
  that choice is made.

### Payee-side issues that do not cost the payer more

The SDK resource server accepted a payment built for `/weather` at `/forecast` with the same price and `payTo`
(step 6). It also ran the handler for each concurrent copy (step 5). These are the arXiv 2605.30998 classes "cross-
resource substitution" and "service duplication", still present in 2.32.0. Neither moves more than the approved amount
to the approved `payTo`, once. The signature does not bind the endpoint, so the endpoint stays a daemon-side
observation, and the rule must bind (endpoint, `payTo`).

## Surprises

- The official client signs a raw `approve(Permit2, 2^256-1)` transaction when a 402 asks for Permit2 with
  `erc20ApprovalGasSponsoring` and the signer can sign transactions. That is the case for the SDK's documented
  `toClientEvmSigner(privateKeyToAccount(…), publicClient)`.
- The client's `validBefore` is `now + maxTimeoutSeconds`, unbounded, and a 10-year window was signed. The EIP-712
  domain name is taken from the server unchecked, even though the SDK ships a table with the right one.
- `@x402/core` 2.32.0 has default spend controls (a $1 cap per payment and a default-asset allowlist). The x402
  research report does not mention them.
- `authorizationState` is true after a cancel as well as after a payment.
- An authorization that failed for lack of funds is not dead: it settled after a top-up.
- The official facilitator sets no upper bound on `validBefore`, so a payer may sign a shorter window than the server
  asked for.

## Cleanup

Each script stops its own anvil on exit. No containers and no keychain entries were created. Afterwards
`pgrep -fl "anvil.*--silent"` showed no process with this spike's arguments (two other anvil processes running on the
machine belonged to other spikes and were left alone).

## Sources (all read 2026-11-23)

- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009, as summarized in `../../research/x402.md`.
- x402 v2 HTTP transport spec: https://raw.githubusercontent.com/coinbase/x402/main/specs/transports-v2/http.md, via
  `../../research/x402.md`.
- x402 source: https://github.com/x402-foundation/x402. Files `typescript/packages/core/src/client/x402Client.ts`,
  `typescript/packages/mechanisms/evm/src/exact/client/eip3009.ts`, `…/exact/client/erc20approval.ts` and
  `…/exact/facilitator/eip3009.ts`, read from the npm 2.32.0 tarballs (published 2026-11-20).
- npm registry (`npm view`): `@x402/core`, `@x402/evm`, `@x402/express` 2.32.0; `viem` 2.58.4 (published
  2026-11-21); `express` 5.3.0; `@x402/facilitator` returns 404.
- Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`:
  https://developers.circle.com/stablecoins/usdc-contract-addresses, via `../../research/x402.md`. Its `name()`,
  `version()` and `DOMAIN_SEPARATOR()` were read on the fork in this spike (A).
- arXiv 2605.30998, "Free-Riding in the AI Economy": https://arxiv.org/html/2605.30998v1, via
  `../../research/x402.md`.
