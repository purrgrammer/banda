# Wallet stack: libraries, advisories, supply chain, key model, history source

Status: analysis for the RFC in [`../wallets.md`](../wallets.md), dated 2026-11-23. It gathers what the research notes
and spikes under this folder measured into one choice per concern. Nothing here is a DESIGN.md rule (principle 6);
each choice names its evidence, and what is still a recommendation says what would settle it. The hazards it answers
are in [`hazards.md`](hazards.md) (H-ids), the concurrency rules in [`conflicts.md`](conflicts.md) (C-ids).

## 1. What ships in the daemon

The signing path is six npm packages and one native keychain module. Every version is pinned exactly in
`package.json` (principle 13) and moves only together with its siblings.

**The key's trusted computing base is larger than that path.** Under TA-1 (spike K1) any package the daemon loads can
spawn `process.execPath` and read every wallet item silently, and every package bundled into `web/` runs with the
owner's authority over cards and permissions. So the trusted computing base is the daemon's whole production tree,
the desktop shell and every dependency bundled into `web/`, and the controls of section 5 apply to all of it, not
only to the signing closure. OD-11 (a separately signed signer with a keychain access group the bundled Node and
Electron binaries do not satisfy) is the only structural narrowing.

| Package | Exact version | Published | Role in banda | Provenance | Why this one |
|---|---|---|---|---|---|
| `@noble/curves` | 2.4.0 | 2026-08-27 | secp256k1 key generation (`randomSecretKey`) and the curve under every signature | SLSA v1 attested | Audited primitives (Cure53; Trail of Bits 2023 review of noble-curves), one maintainer and one version line with the rest, zero advisories [1][2][3] |
| `@noble/hashes` | 2.4.0 | 2026-08-27 | keccak256, sha2, hmac | attested | Same line; zero runtime dependencies [1] |
| `micro-eth-signer` | 0.20.1 | 2026-08-29 | EIP-1559 transaction encoding and signing, RLP, EIP-55, EIP-712 for EIP-3009, ABI calldata | attested | Byte-identical to `ox` and `cast` on an EIP-1559 transfer, correct on the EIP-155 and EIP-712 `Mail` vectors and on an EIP-3009 authorization verified by USDC's contract on a fork; 6 packages in all [4] |
| `micro-packed` | 0.11.1 | (transitive) | binary encoding under micro-eth-signer | attested | Pulled by micro-eth-signer [4] |
| `@noble/ciphers` | 2.4.0 | (transitive) | pulled by micro-eth-signer; banda calls nothing in it | attested | Same line [4] |
| `@scure/base` | 2.4.0 | (transitive) | base encodings | attested | Same line [4] |
| `@napi-rs/keyring` | 2.1.2 | 2026-10-19 | the OS keychain (macOS Keychain, Linux Secret Service), called only from the signer child (C20) | (native prebuilt per platform: `@napi-rs/keyring-darwin-arm64` 2.1.2, `-linux-arm64-gnu` 2.1.2, and the other targets the release builds) | Prebuilt binaries (no compile at install), async API, works headless on Linux; the alternatives are archived or too new [5][6] |

The keys spike measured the six JavaScript packages: 6 of 6 provenance-attested (`npm audit signatures`),
`npm audit` 0 vulnerabilities, 6.9 MB and 296 files in `node_modules` [4]. The keychain module's prebuilt binaries embed
their Rust crates as cargo-auditable data (macOS: `keyring-core` 1.0.1, `apple-native-keyring-store` 1.0.2,
`security-framework` 3.7.0; Linux: `keyring-core` 1.0.1, `dbus-secret-service-keyring-store` 1.0.1,
`dbus-secret-service` 4.1.0, `libdbus-sys` 0.2.7 with libdbus linked statically, `linux-keyutils-keyring-store` 1.0.0,
`openssl` 0.10.81), so `cargo audit bin <file.node>` can scan them in CI [6].

How each is used, as rules for the one module that imports them (nothing else in the daemon does):

- **Two operations and no third.** `signTransfer` (an EIP-1559 type-2 transaction banda built: an ERC-20
  `transfer(address,uint256)` from a fixed selector, or a plain ETH send) and `signTransferWithAuthorization` (EIP-3009
  with the domain from banda's per-network table). micro-eth-signer's root also exports `authorization.sign`
  (EIP-7702), `eip191Signer` and `signTyped` for any type, and ships `net/`, `uniswap`, `kzg` and `ssz`; none is
  reachable from banda (H-150, H-151, H-152, H-153, H-306) [4].
- **`extraEntropy: false` on every signature.** micro-eth-signer hedges by default (random bytes mixed into the RFC 6979
  nonce), so two signatures of one transaction differ; `false` gives the deterministic result the vectors pin (H-161).
  Safety never rests on it: the signed bytes are committed before any broadcast (R-3, C4, C6) [4].
- **`chainId` always explicit.** micro-eth-signer defaults it to 1 (Ethereum mainnet) when omitted (H-155) [4].
- **Never noble's `sign` on a digest.** `secp256k1.sign` in 2.x hashes its input again by default (`prehash: true`),
  which gives a valid-looking, wrong Ethereum signature (H-162) [4].
- **The stored transaction is bytes, its hash `keccak256` of them, computed once** [4].
- **The keychain only from the signer child**, with every entry built as `{ linux: { store: 'secret-service' } }`
  (the default silently falls back to the kernel keyring, lost at reboot: H-029), through `AsyncEntry`, one operation at
  a time per home, killed by the daemon at its deadline (C20; H-018, H-032, H-036) [6].

## 2. What banda writes itself, and why it is small

| Piece | Why not a library | Size and guard |
|---|---|---|
| JSON-RPC client over `fetch` | viem would ship a second, older curve library and 13 packages; banda needs about ten methods (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBalance`, `eth_call`, `eth_getTransactionCount`, `eth_estimateGas`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`, `eth_getLogs`, `eth_getCode`), and it must keep raw error messages, because classification is by message, not code (geth and reth `-32000`, anvil `-32003`) [1][7][8] | One module; quantities parsed from hex to `bigint`; a token bucket per RPC shared by every wallet on a network (H-198); tests against anvil, and op-geth or base-reth in Docker in CI |
| Error classifier | No library classifies pool errors across geth, reth and anvil [7][8] | A table of message patterns to {already known, nonce too low, underpriced, insufficient funds, other}; "other" is maybe-sent (H-185) |
| x402 payload builder | The official client signed 10-year windows, used the server's EIP-712 domain name, and signed `approve(Permit2, 2^256−1)` in the x402 spike (R-6) [9] | Decode `PAYMENT-REQUIRED` (base64 JSON, v2) with a TypeBox schema; build the EIP-3009 message from banda's own table; derived nonce (R-5); validity at most 60 s past chain time (C19) |
| Per-network table | A constant, not a dependency | Chain id, USDC address, USDC EIP-712 name and version, gas ceilings, finality tags (section 8) |

## 3. What does not ship, and why

| Candidate | Version looked at | Decision | Reason |
|---|---|---|---|
| `@scure/bip32`, `@scure/bip39` | 2.4.0 | Not shipped | No phrase: an independent key per wallet (section 5); tests use anvil's known keys [4] |
| `ox` | 1.8.20 | Fallback only | Equally correct, but 15 packages with a second copy of the curve library, 2 without provenance, 42.4 MB, process-wide mutable crypto settings, and 1.8.20 was published the day of the spike (120 releases in 2026) [4] |
| `viem` | 2.58.4 | Tests only, if at all | Declares `@noble/curves` 1.9.1 and `@scure/bip32` 1.7.0 (a duplicate curve library); its nonce manager failed 10 of 20 two-process runs in the nonce spike [1][10] |
| `ethers` | 6.17.0 | Not used | Pins `@noble/curves` 1.2.0 and `@noble/hashes` 1.3.2, no provenance attestation, one stable release in 2026 [1] |
| `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/express` | 2.32.0 | Test harness only (`devDependencies`) | The client's signing choices above; the server ran the handler once per concurrent copy and accepted cross-resource payments [9][11] |
| `x402`, `x402-fetch`, `x402-express` (v1) | 1.2.0 | Not used | v1 SDK; banda reads v2 headers only (H-232) [11] |
| `keytar`, `@github/keytar` | 7.9.0, 7.10.6 | Not used | Upstream archived 2022-12-15; `@github/keytar` deprecated on npm [5] |
| `cross-keychain` | 2.0.0 | Not used | 15 days old at the research date, single maintainer [5] |
| `security -i` (macOS CLI) | system | Diagnostic only | Sound and dependency-free, but macOS only, and items it writes trust `/usr/bin/security`, which any process of the user can run (H-038) [6] |
| A hosted history API (Etherscan, Blockscout) | n/a | Not a dependency | Etherscan serves Base only on paid tiers; Blockscout's mainnet host challenges scripts and its multichain API wants a key or an x402 payment (section 6) [12] |

Test tooling (never shipped): anvil 1.9.0 (Foundry; 1.10.0, released 2026-11-19, not yet tested, so the repo pins the
version it runs) [7][13], pinned in `mise.toml` as `foundry = "1.9.0"` (mise's `aqua:foundry-rs/foundry` backend,
checksum-verified) beside Node, so `mise install` provisions it; a scenario that starts a chain skips with
"anvil 1.9.0 not found (mise install)" when it is absent, as Docker suites skip, and CI's ordinary job runs `mise
install` first [20]; op-geth or base-reth in Docker for the replacement and eviction rules anvil does not model
(anvil accepts a 1% bump; geth's PriceBump is 10%) [7][10]; `@x402/express` 2.32.0 with `express` 5.3.0 as the
hostile and honest test servers [9].

## 4. Advisories and incidents

Point-in-time facts, queried 2026-11-23; CI re-queries them (section 5).

| Item | What | Bearing on banda |
|---|---|---|
| OSV and GitHub advisories for `@noble/curves`, `@noble/hashes`, `@scure/*`, `micro-eth-signer`, `ox`, `viem`, `ethers` | Zero entries for every package (sanity check: lodash 4.17.15 returned 5) [1] | None today |
| `@napi-rs/keyring` | No advisory found in the research; the prebuilt binaries' crates are listed above for `cargo audit` [5][6] | Scan the embedded crates in CI |
| GHSA-96hv-2xvq-fx4p (`ws`, memory exhaustion DoS) and GHSA-58qx-3vcg-4xpx (`ws` < 8.20.1, uninitialized memory disclosure) | `ws` is a runtime dependency of viem and ethers [1] | Not shipped (viem and ethers are not in the daemon); 8.21.0 is above both ranges |
| GHSA-3j63-5h8p-gf7c (x402 resource servers on SDK versions below 0.5.2, high) | Server-side builders [11] | banda is a payer; the SDK is a test dependency at 2.32.0 |
| CVE-2024-54134, `@solana/web3.js` 1.95.6 and 1.95.7 (December 2024) | Phished publisher; 1.95.7 exfiltrated private keys [1][14] | The class banda's key path must survive: exact pins, cooldown, single importer, golden vectors |
| `@ledgerhq/connect-kit` 1.1.5 to 1.1.7 (December 2023) | A wallet's own package hijacked into a drainer [1] | Same class, through a loader |
| `chalk` 5.6.1, `debug` 4.4.2 and others (September 2025) | Transitive compromise rewriting wallet destinations in browsers [1] | Any transitive package in the daemon's tree is in scope |
| Shai-Hulud and Shai-Hulud 2.0 (September and November 2025) | Install-time worm harvesting tokens and wallet files [1] | `--ignore-scripts`; an allowlist for the packages that need a build step |
| TanStack (May 2026) | 84 malicious versions through a legitimate trusted publisher [1] | Provenance is a signal, not a gate |
| MAL-2026-11297 (`ethers-v6`), `@wrenfield/viem` | Look-alike names [1] | Exact names only; a dependency-set check (section 5) |

No public third-party audit was found for micro-eth-signer's own code (RLP, transactions, EIP-712 glue), ox, viem or
ethers; the primitives micro-eth-signer calls are noble's, which carry the audit record above [1]. The keys spike's
vectors are banda's own check, not an audit.

## 5. Supply-chain risks and their controls

| Risk | Control | Where it is enforced | Status |
|---|---|---|---|
| A malicious version of a signing or keychain package | Exact pins; committed lockfile with integrity hashes; `npm ci` | `package.json`, `package-lock.json`, CI | In place for the repo (AGENTS.md); wallet packages join it |
| An install-time payload | `npm ci --ignore-scripts` with an allowlist of the few packages that need a build step, for the whole tree | CI and release builds | To verify that the repo's current dependencies build without install scripts [1] |
| A fresh compromised release adopted by an upgrade | A release-age cooldown of 14 days for the whole tree (the trusted computing base of section 1), with banda's lockstep packages exempted by name so pi-durable, pi-ai, pi-env, chord and pi-mcp still move together on release day: a decision, since npm's `min-release-age` applies to every package, not one closure | `.npmrc` `min-release-age=14` and `min-release-age-exclude=@earendil-works/*` | npm documents `min-release-age` (days, "only versions that were available more than the given number of days ago will be installed") in npm 11.19.1 on this machine [15]; to confirm both keys in the npm bundled with the repo's Node 26.13.0 before relying on it (H-307); if the exclude key is absent there, a CI test reads the lockfile and the registry's publish times instead |
| A registry-level substitution | `npm audit signatures` (registry signatures and provenance) over the whole tree | CI on every lockfile change | To add |
| A newly published advisory | OSV query for the lockfile, and `cargo audit bin` on the keychain module's `.node` files | CI, nightly with the fault suites | To add |
| A typosquat or scope look-alike | The daemon's, the desktop shell's and `web/`'s production trees must equal an approved set, and the signing module's closure an approved list (the six packages above plus the keychain module and its platform packages); a change to either is a reviewed diff | A test reading the lockfile | To add (H-303) |
| A second curve library slipping in | The same check asserts exactly one `@noble/curves` and one `@noble/hashes` in production | Same test | To add (H-308) |
| A generic signer, 7702 or permits creeping in | One importer module; a lint rule forbids importing the signing libraries elsewhere; a test enumerates the module's exports and fails on any change | Lint and unit test | To add (H-153, H-306) |
| An upgrade that changes signing semantics (hedging, chain id defaults, encoding) | Golden vectors: the EIP-155 example, the EIP-712 `Mail` example, the spike's EIP-1559 transfer and EIP-3009 authorization, signed with `extraEntropy: false` | Unit test | To add from the keys spike (H-304) |
| A swapped native binary | Lockfile integrity for each platform package, verified at install; the binary is code-signed inside the signed desktop app. Process isolation is not the control: a swapped binary runs inside the signer, which holds the key | Release workflow | To add (H-302) |
| The x402 SDK on the payer path | `@x402/*` allowed only in `devDependencies`; the dependency-set check refuses them in production | Same test | To add (H-244) |

**Upgrade ritual** for any package of the signing path: read the changelog and the diff of the files the signer
calls; wait the cooldown; rerun the golden vectors, the anvil suite and the keychain tests; move the three noble and
micro packages together; say what changed and the measured result in the commit message (principles 13 and 14).

## 6. Key model (recommendation; generation and format settled by the keys spike, storage by the keychain spike)

**Generation and format** (keys-and-signing spike [4]):

- An independent random key per wallet, from `secp256k1.utils.randomSecretKey()` over
  `globalThis.crypto.getRandomValues`, never a home seed: one leak loses one wallet, deleting a wallet deletes its key,
  and signing for wallet A loads A's key only.
- Export as the raw private key, `0x` + 64 lowercase hex, beside the address it opens; MetaMask and `cast` import it,
  and 2000 random keys round-tripped exactly. No phrase by default (paths differ between wallets from index 1 on).
- The saved copy is confirmed by pasting it back and comparing the derived address (R-8).

**Storage** (keychain spike [6]):

- One keychain item per wallet: service banda's, account `<home-id>/wallet/<address>` (R-13), secret the key as hex.
- Create is: commit `creating` with the address; read the account (must be `null`); write; read back and derive;
  commit ready (C15). Nothing ever overwrites an item (a sequential write replaces silently on both platforms; eight
  concurrent first writes kept one key on Linux and lost seven).
- Every keychain call runs in a short-lived child started from `process.execPath`, one at a time per home, killed by
  the daemon at its deadline. The child also signs, so the key never enters the daemon process (C20). Reason: a call
  behind an unanswered prompt ignores `AbortSignal`, four of them starve libuv's pool (`fs`, `crypto`, `dns`), and the
  process cannot exit except by SIGKILL.
- `null` alone never means "key missing" or "make a key": a canary account `<home-id>/probe` tells a missing key from a
  keychain that cannot answer (H-037).
- The id in the account name only says which home made the item; which home may sign is the lease of C16 (the item
  `<home-id>/lease`, compare-and-set on its epoch), proven by a home secret kept outside the home directory (the item
  `<home-id>/home-secret`, bound to the home's realpath and inode), so no backup, restore, fork or hand copy carries a
  matching one (R-12). Each wallet has exactly one key item; the home has one lease, one home-secret and one canary
  item besides, and only the lease's epoch is ever rewritten (C15, C16).

**What this protects against, stated plainly** (TA-1): on macOS the item's ACL trusts an executable, not a script, so
anything run by the bundled Node can read it; the released app is signed ad hoc, so each release that changes the
Node binary raises one keychain prompt per wallet; on Linux any process of the user on the session bus reads an
unlocked collection [6]. The balance is the cap.

**Still open before this is a DESIGN.md claim:** a Developer ID-signed bundle across an update (inferred from two
Node.js-signed installs reading each other's items silently, not run on banda's bundle); macOS Deny, a locked login
keychain and a session without a GUI; Linux on a real desktop (GNOME, KDE) and x64; the `findCredentials` listing for
the orphan sweep; Windows; OD-11 (a separate signed signer with a keychain access group) [6].

## 7. Transaction history source (recommendation from the tx-history spike)

| Row | Source | State from |
|---|---|---|
| Outgoing transfer (owner or agent) | the wallet's ledger doc in the store, written in the start commit | receipt of the stored hash: Sent, Included, then Confirmed, Failed or Cancelled at `finalized` (C12) |
| Outgoing x402 payment | the stored authorization (payer, nonce, `validBefore`) | `authorizationState(wallet, nonce)` true means settled (when banda issued no cancel), still false after `validBefore` means expired, final |
| USDC received | `eth_getLogs` for `Transfer(to ∈ the home's wallets)` on the pinned token contracts, one filter per network for every wallet, in chunks of the RPC's probed range, with a stored cursor | derived, rebuildable |
| ETH received | balance and nonce checkpoints at each poll; an unexplained change starts a bisection between checkpoints | derived, rebuildable within the RPC's state window |
| Sent outside banda | a nonce move with no effect in the store, found by the same bisection | shown as such; feeds C7 |

Evidence [12]: Etherscan refuses keyless calls and serves Base only on paid tiers; Blockscout's Base Sepolia host
answers keyless (useful for cross-checks in tests) but its internal-transaction feed was incomplete 15 minutes after
the block; self-indexed USDC transfers matched Blockscout 118 of 118 over 2,000 blocks; bisection found every native
change, 5 of 5 on anvil (including contract payments and SELFDESTRUCT) and 22 of 22 on a real Base Sepolia account,
two of which Blockscout missed. `Transfer(from = wallet)` logs are never read (forged zero-value `transferFrom` shapes
exist; outgoing comes from the store). Spam rules are structural: pinned token addresses, zero-value transfers
dropped, no incoming row ever becomes a recipient (H-205).

Freshness: a `logs` subscription where the RPC offers one (publicnode: median 288 ms, n=8), otherwise a 2 s poll while
a wallet screen is open or a payment awaited (median about 1.1 s), 40 s when idle [12].

Ranges and limits measured: `sepolia.base.org` caps `eth_getLogs` at 200 blocks; publicnode accepted 50,000;
`mainnet.base.org` answered 429 to every `eth_getLogs`, so it cannot back the list and Settings must say so when the
owner picks it (H-207) [12].

**Still open:** which mainnet RPC banda proposes by default for logs (publicnode worked keyless; its terms for sustained
use were not checked); whether Base mainnet receipts now carry the operator fee fields; Blockscout's keyless window
length [12].

## 8. Base constants the per-network table holds

| | Base | Base Sepolia |
|---|---|---|
| Chain id | 8453 | 84532 |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| USDC EIP-712 domain | name "USD Coin", version "2" | name "USDC", version "2" |
| Blocks | 200 ms since Denim (mainnet 2026-11-05); `pending` resolves to `latest` | same |
| Finality used | inclusion about 200 ms (`latest`); `safe` about 2 min ("Confirmed"); `finalized` about 20 min (re-admission after a foreign nonce, R-4) | same |
| Fee | operator fee + gasUsed × (base fee + priority) + L1 fee; the reserve uses `getL1FeeUpperBound` on the GasPriceOracle at `0x420000000000000000000000000000000000000F` | same |
| Replacement | both fee fields +12.5% at least (covers geth's 10% PriceBump and reth) | same |

Sources: [11][16][17][18][19]. The USDC domain names were read on chain (`name()`, `version()`) in the x402 research;
banda re-reads them before signing and goes offline for x402 on a mismatch (H-250).

## Sources

All accessed 2026-11-23 unless stated.

1. Signing-libraries research, `research/signing-libraries.md` (npm registry `npm view`, attestation endpoint
   https://registry.npmjs.org/-/npm/v1/attestations/, OSV https://api.osv.dev/v1/query, GitHub advisories
   https://github.com/advisories/GHSA-96hv-2xvq-fx4p, https://osv.dev/vulnerability/MAL-2026-11297,
   https://socket.dev/blog/npm-trusted-publishing).
2. noble audits: https://paulmillr.com/noble/ and https://www.trailofbits.com/library/noble-curves-library/ (as cited in [1]).
3. SLSA provenance v1: https://slsa.dev/provenance/v1.
4. Keys-and-signing spike, `spikes/keys-and-signing/README.md` (EIP-155 https://eips.ethereum.org/EIPS/eip-155; EIP-712
   example https://github.com/ethereum/EIPs/blob/master/assets/eip-712/Example.js; MetaMask import
   https://support.metamask.io/start/use-an-existing-wallet/).
5. OS-keychain research, `research/os-keychain.md` (https://github.com/Brooooooklyn/keyring-node; keytar archive
   https://github.com/atom/node-keytar; https://github.com/magarcia/cross-keychain).
6. Keychain spike, `spikes/keychain/README.md` (https://github.com/Brooooooklyn/keyring-node;
   https://napi.rs/docs/concepts/async-task; https://github.com/libuv/libuv/blob/v1.x/src/uv-common.c;
   https://github.com/libuv/libuv/blob/v1.x/src/threadpool.c; https://docs.docker.com/engine/security/seccomp/).
7. Chain-operations research, `research/chain-operations.md` (https://github.com/ethereum/go-ethereum;
   https://github.com/paradigmxyz/reth/issues/19450; getfoundry.sh anvil RPC methods).
8. Nonce-and-crash spike, `spikes/nonce-and-crash/README.md` (anvil 1.9.0 messages; geth wording).
9. x402-settlement spike, `spikes/x402-settlement/README.md` (exact pins `@x402/core`, `@x402/evm`, `@x402/express`
   2.32.0, `express` 5.3.0, `viem` 2.58.4).
10. viem nonce manager: https://viem.sh/docs/accounts/local/createNonceManager; the nonce spike's two-process runs [8].
11. x402 research, `research/x402.md` (https://raw.githubusercontent.com/coinbase/x402/main/specs/transports-v2/http.md;
    https://raw.githubusercontent.com/coinbase/x402/main/specs/schemes/exact/scheme_exact_evm.md;
    https://github.com/x402-foundation/x402; GHSA-3j63-5h8p-gf7c in the GitHub advisory database;
    https://developers.circle.com/stablecoins/usdc-contract-addresses).
12. Tx-history spike, `spikes/tx-history/README.md` (https://docs.etherscan.io/supported-chains;
    https://docs.blockscout.com/best-practices; https://docs.blockscout.com/rate-limits;
    https://specs.optimism.io/protocol/deposits.html).
13. Foundry releases: `gh api repos/foundry-rs/foundry/releases/latest` (v1.10.0, 2026-11-19), as cited in [7].
14. CVE-2024-54134: https://nvd.nist.gov/vuln/detail/CVE-2024-54134 (as cited in [1]).
15. npm `min-release-age`: the npm 11.19.1 documentation installed with Node 24.22.1 on this machine,
    `docs/content/using-npm/config.md`, section "min-release-age" (read 2026-11-23); `npm config ls -l` shows the key
    with default null.
16. Base Denim upgrade: https://docs.base.org/upgrades/denim/migrate-from-flashblocks.
17. Base finality: https://docs.base.org/specifications/transactions/transaction-finality.
18. Base fees: https://docs.base.org/specifications/transactions/network-fees and
    https://docs.optimism.io/op-stack/transactions/fees.
19. EIP-3009: https://eips.ethereum.org/EIPS/eip-3009.
20. mise's registry entry `registry/foundry.toml` (https://github.com/jdx/mise/blob/main/registry/foundry.toml) names
    the backend `aqua:foundry-rs/foundry`; mise-versions (https://mise-versions.jdx.dev/tools/foundry) lists a sha256
    checksum for its releases (both read 2026-11-23). To confirm `mise install foundry@1.9.0` on darwin-arm64 and
    linux-x64 before relying on it.
