# Research: signing libraries for an EVM wallet in banda's daemon

Date of research: 2026-11-23. Runtime: Node 24 (TypeScript daemon). Scope: key generation, HD derivation, RLP and
transaction encoding, signing, EIP-712, and the npm supply-chain posture of each candidate.

Method: `npm view` for versions, times, dependencies, maintainers and provenance attestations; `npm install
--package-lock-only` in a scratch directory for transitive counts; OSV (api.osv.dev) and GitHub Advisory Database
(`gh api /advisories?ecosystem=npm&affects=...`) for advisories; web search for audits and incidents. Each external
claim carries its source and access date. Facts marked UNVERIFIED were not confirmed against a primary source.

## Summary

- The noble/scure family is the right base. All four of `@noble/curves`, `@noble/hashes`, `@scure/bip32`,
  `@scure/bip39` are at 2.4.0 (published 2026-08-27 to 2026-08-28), share one maintainer, publish with npm provenance,
  and have no OSV or GHSA advisories at query time. They cover key generation, BIP-32/39 derivation and secp256k1
  signing without hand-rolled crypto.
- RLP, transaction encoding and EIP-712 must come from a library, not hand-written code. Two candidates keep the
  dependency tree small and use the same 2.x noble/scure line: `micro-eth-signer` 0.20.1 (6 transitive packages) and
  `ox` 1.8.20 (15 transitive packages). `viem` 2.58.4 (13 transitive) builds on `ox`, but its own dependency tree
  pins the old `@noble/curves` 1.9.1, which would put two curve copies in the lockfile.
- `ethers` 6.17.0 is maintained but has a slow cadence (one stable release in 2026, dated 2026-06-18) and pins old
  noble versions (`@noble/curves` 1.2.0, `@noble/hashes` 1.3.2). It is a weaker fit for a lockstep stack.
- No external audit of `viem`, `ox`, `ethers` or `micro-eth-signer` was found in public sources. The noble libraries
  have public audit records (Cure53, Trail of Bits). This is a gap to close with a spike plus test vectors, not a
  blocker.
- Supply-chain incidents against wallet code are real and recent (Solana web3.js 2024, Ledger Connect Kit 2023,
  chalk/debug 2025 wallet-interception payload, Shai-Hulud worm 2025 to 2026 including a Trust Wallet loss). The
  defences that matter are: exact version pins, a committed lockfile, `npm ci --ignore-scripts`, `npm audit
  signatures` in CI, a verified publisher (provenance), and a check that the package name is the genuine one.
- Recommended stack (Findings 5 and 6): exact pins of `@noble/curves@2.4.0`, `@noble/hashes@2.4.0`,
  `@scure/bip32@2.4.0`, `@scure/bip39@2.4.0`, plus `micro-eth-signer@0.20.1` for RLP, transactions and EIP-712.
  Fallback: `ox@1.8.20`. A spike must validate the choice against published test vectors before a DESIGN.md claim.

## Findings with sources

### 1. Versions, dates, maintainers (npm registry, 2026-11-23)

| Package | Latest | Published | Maintainers (npm) | Repo |
|---|---|---|---|---|
| viem | 2.58.4 | 2026-11-21 (dist-tag latest; registry modified 2026-11-23) | awkweb, jmoxey | github.com/wevm/viem |
| ox | 1.8.20 | 2026-11-23 | jmoxey, awkweb | github.com/wevm/ox |
| ethers | 6.17.0 | 2026-06-18 | ricmoo | github.com/ethers-io/ethers.js |
| @noble/curves | 2.4.0 | 2026-08-27 | paulmillr | github.com/paulmillr/noble-curves |
| @noble/hashes | 2.4.0 | 2026-08-27 | paulmillr | github.com/paulmillr/noble-hashes |
| @scure/bip32 | 2.4.0 | 2026-08-28 | paulmillr | github.com/paulmillr/scure-bip32 |
| @scure/bip39 | 2.4.0 | 2026-08-28 | paulmillr | github.com/paulmillr/scure-bip39 |
| micro-eth-signer | 0.20.1 | 2026-08-29 | paulmillr | github.com/paulmillr/micro-eth-signer |

Source: `npm view <pkg> version time --json` and `npm view <pkg> maintainers repository.url`, run 2026-11-23.

Release cadence in calendar 2026 (stable releases, from `npm view <pkg> time`):
- viem: 104 stable releases in 2026 to date (very high cadence, mostly patch releases).
- ox: 120 stable releases in 2026 to date.
- ethers: 1 stable release in 2026 (6.17.0).
- noble and scure (each of the four): 3 stable releases in 2026 (2.2.0 in April, 2.3.0 in August, 2.4.0 in late August).
- micro-eth-signer: 3 stable releases in 2026 (0.19.0 June, 0.20.0 August, 0.20.1 August 29).

Observation: viem and ox ship many releases, which means a larger upgrade surface. Pinned exact versions and a
lockfile neutralise this.

### 2. Provenance and attestations (npm registry, 2026-11-23)

`npm view <pkg> dist.attestations` returned a SLSA provenance v1 attestation (`predicateType
https://slsa.dev/provenance/v1`) for: viem@2.58.4, ox@1.8.20, @noble/curves@2.4.0, @noble/hashes@2.4.0,
@scure/bip32@2.4.0, @scure/bip39@2.4.0, micro-eth-signer@0.20.1. No attestation was returned for ethers 6.17.0.

Sources: npm registry attestation endpoint, e.g. `https://registry.npmjs.org/-/npm/v1/attestations/viem@2.58.4`
(queried 2026-11-23). npm provenance background: GitHub blog, "Introducing npm package provenance", and
the npm documentation "Generating provenance statements" (docs.npmjs.com/generating-provenance-statements), accessed
2026-11-23 via search excerpts only; primary page not fully read (UNVERIFIED wording).

npm trusted publishing: GitHub changelog "npm trusted publishing with OIDC is generally available", dated
2025-07-31 (github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/). Per the
search excerpt of docs.npmjs.com/trusted-publishers (accessed 2026-11-23): the npm CLI publishes provenance by
default under trusted publishing; configurations created before 2026-05-20 allow `npm publish` only.
UNVERIFIED in full: exact configuration defaults and dates.

Caveat from Socket (socket.dev/blog/npm-trusted-publishing, accessed 2026-11-23): in May 2026 a compromise published
84 malicious versions of a project through that project's legitimate trusted publisher, with no npm token stolen.
Provenance proves where a build ran, not that the source was clean. Provenance is therefore a signal, not a gate.

### 3. Transitive dependency counts (npm install --package-lock-only, 2026-11-23)

Counts of packages in each latest version's resolved lockfile (excluding the root):

| Package | Transitive packages | Direct deps (latest) |
|---|---|---|
| @scure/bip39 2.4.0 | 2 | @noble/hashes 2.4.0 |
| @noble/hashes 2.4.0 | 1 (itself only) | none |
| @noble/curves 2.4.0 | 2 | @noble/hashes 2.4.0 |
| @scure/bip32 2.4.0 | 4 | @scure/base 2.4.0, @noble/curves 2.4.0, @noble/hashes 2.4.0 |
| micro-eth-signer 0.20.1 | 6 | micro-packed 0.11.1, @noble/curves, @noble/hashes, @noble/ciphers (all 2.4.0) |
| ethers 6.17.0 | 9 | @adraffy/ens-normalize 1.11.1, @noble/curves 1.2.0, @noble/hashes 1.3.2, @types/node 22.7.5, aes-js 4.0.0-beta.5, tslib 2.7.0, ws 8.21.0 |
| ox 1.8.20 | 15 | zod ^4.4.3, abitype ^1.3.0, @scure/bip32 ^2.0.0, @scure/bip39 ^2.0.0, @noble/curves ^2.2.0, @noble/hashes ^2.2.0, eventemitter3 5.0.1, @noble/ciphers ^2.2.0, @noble/post-quantum ^0.6.1, @adraffy/ens-normalize.ts ^1.0.0 |
| viem 2.58.4 | 13 | ox 0.14.67, ws 8.21.0, isows 1.0.7, abitype 1.2.3, @scure/bip32 1.7.0, @scure/bip39 1.6.0, @noble/curves 1.9.1, @noble/hashes 1.8.0 |

Observations:
- viem's dependency declarations are old for the scure and noble pieces (`@scure/bip32` 1.7.0, `@noble/curves` 1.9.1)
  and it depends on `ox` 0.14.67, not the current `ox` 1.8.20. Installing viem alongside the 2.x stack would
  produce duplicate copies of the curve and hash libraries. Each duplicate is a second code path for key handling.
- `ox` declares the 2.x noble/scure line directly, which is consistent with the recommended stack.
- `ethers` carries `@noble/curves` 1.2.0 (2022-era) and `@types/node` as a runtime dependency.
- `micro-eth-signer` and the noble/scure set share one maintainer and one version line.

### 4. Advisories (OSV and GitHub Advisory Database, queried 2026-11-23)

- OSV `POST https://api.osv.dev/v1/query` with the package name and ecosystem npm returned **zero** vulnerabilities for:
  viem (checked at 2.0.0 and at latest), ethers (checked at 5.0.0), ox, @noble/curves, @noble/hashes, @scure/bip32,
  @scure/bip39, micro-eth-signer. Method sanity check: the same query for lodash at 4.17.15 returned 5 advisories,
  so the endpoint works.
- GitHub Advisory Database (`gh api "/advisories?ecosystem=npm&affects=<pkg>"`) returned **no** advisories for the same
  packages, with the same sanity check (the endpoint returned advisories for `ws`).
- Transitive exposure: `ws` is a runtime dependency of both `viem` (8.21.0) and `ethers` (8.21.0). GHSA-96hv-2xvq-fx4p
  (published 2026-06-15, "memory exhaustion DoS from tiny fragments and data chunks") lists `ws` ranges up to, but not
  including, 8.21.0 for the 8.x line, and GHSA-58qx-3vcg-4xpx (published 2026-05-18, "uninitialized memory disclosure")
  lists `ws` `>= 8.0.0, < 8.20.1`. OSV returns no vulnerability for `ws` 8.21.0. Both pinned `ws` versions are above the
  affected ranges. Source: GitHub advisories, accessed 2026-11-23 (github.com/advisories/GHSA-96hv-2xvq-fx4p).
- Limitation: a clean query is a point-in-time fact. It is not a promise. Re-run the advisory query in CI.

Malicious look-alike packages seen in the search results (to be treated as threats, not alternatives):
- `ethers-v6` on npm: OSV entry MAL-2026-11297 (dated 2026-07-30 per search excerpt) describes malicious code in that
  package name, not the official `ethers`. Source: osv.dev/vulnerability/MAL-2026-11297 (search excerpt, accessed
  2026-11-23; primary page not fully read).
- `@wrenfield/viem`: impersonates `viem` and credits its maintainers while publishing under a different scope. Source:
  a Hacktron/OSV entry (search excerpt, accessed 2026-11-23). Defence: depend on the exact name `viem` only.

### 5. Audits (public records found, 2026-11-23)

- noble libraries (Paul Miller's noble page, paulmillr.com/noble/, accessed 2026-11-23): states seven external audits in
  total. Public reports found on cure53.de: "audit report noble crypto libs"; "pentest report noble lib"; "pentest report
  hashing libs"; "pentest report ed25519"; and an audit of nip44 implementations. Trail of Bits has a public library entry
  for noble-curves (trailofbits.com/library/noble-curves-library/), a January 2023 review that reported one informational
  finding (a timing item). The noble page also lists an Aug 2026 curves audit by Trail of Bits with OpenAI support:
  UNVERIFIED (only on the maintainer's page, not on a Trail of Bits page found in search).
- viem: no published third-party audit found. The wevm/viem security policy names dev@wevm.dev and supports only the
  2.x line for security patches (github.com/wevm/viem/security, accessed 2026-11-23). Result: UNAUDITED in public sources.
- ox: no published audit found. Same maintainers as viem. UNAUDITED in public sources.
- ethers v6: no audit report from Trail of Bits, Cure53 or the maintainers found. UNAUDITED in public sources.
- micro-eth-signer: no dedicated audit found. It is built on the noble libraries, which carry the audit record above
  for the primitives it calls. The library's own code (RLP, transactions, EIP-712 glue) is UNAUDITED in public sources.

These are "no record found" findings, not "not audited": the search surface is limited. Ask the maintainers before
relying on a claim either way.

### 6. ESM, types and runtime

- viem: ESM and CJS conditional exports, `types` per entry (package exports, npm registry 2026-11-23).
- ox: `"type": "module"`, `types` per entry (ESM only, with `src` condition for source).
- ethers: dual ESM/CJS exports, `engines.node >= 14`.
- @noble/curves, @noble/hashes, micro-eth-signer: `"type": "module"`, `engines.node >= 20.19.0`. Node 24 satisfies this.
- @scure/bip32, @scure/bip39: `"type": "module"`, ESM only.

Sources: `npm view <pkg> exports type module engines --json`, 2026-11-23.

### 7. Supply-chain incidents against wallet or crypto code (web search, accessed 2026-11-23)

1. **@solana/web3.js, December 2024 (CVE-2024-54134).** Malicious versions 1.95.6 and 1.95.7 were published after a
   spear-phishing attack on a member of the @solana npm org with publish rights. The 1.95.7 version added a function
   that exfiltrated private keys disguised as Cloudflare headers. Fixed in 1.95.8. The window was about five hours on
   2024-12-03 (sources differ by a day). Private keys in backend bots were at risk; wallets that did not expose keys
   were largely unaffected. Sources: thehackernews.com/2024/12/researchers-uncover-backdoor-in-solanas.html;
   nvd.nist.gov/vuln/detail/CVE-2024-54134; socket.dev/blog/supply-chain-attack-solana-web3-js-library;
   tag-security.cncf.io catalog entry for solana_web3js. Lesson: a key-handling library is the highest-value target;
   exact pins plus a reviewed upgrade path matter most there.

2. **Ledger Connect Kit, December 2023.** Versions 1.1.5 to 1.1.7 of `@ledgerhq/connect-kit` were malicious; they pulled a
   secondary npm package that acted as a drainer (Angel Drainer-linked). About $600,000 was stolen. Initial access: a former
   Ledger employee was phished, and the attacker's account access bypassed 2FA on the npm account. Ledger removed the
   versions and published 1.1.8. Delivery was also through a loader used by dApps. Sources:
   bleepingcomputer.com/news/security/ledger-dapp-supply-chain-attack-steals-600k-from-crypto-wallets/;
   theregister.com/2023/12/16/ledger_crypto_conect_kit/; security.snyk.io/vuln/SNYK-JS-LEDGERHQCONNECTKIT-6127404;
   ledger.com/blog/security-incident-report. Lesson: a wallet's own package being hijacked is a live threat; a
   loader or transitive pull matters as much as a direct dependency.

3. **chalk and debug, September 2025.** An attacker phished a maintainer's npm account and published malicious versions
   of 18 to 27 widely used packages (chalk@5.6.1, debug@4.4.2 named). The payload ran in the browser and intercepted
   crypto and web3 activity, rewriting detected addresses and wrapping RPC methods; it targeted MetaMask-style wallets. The
   search turned up no link to a "crypto-js" payload (the premise in the request was not supported). Sources:
   aikido.dev/blog/npm-debug-and-chalk-packages-compromised (reported 2025-09-08 per search excerpt);
   thehackernews.com/2025/09/20-popular-npm-packages-with-2-billion.html; csoonline.com/article/4053725.
   Lesson: a compromise of a deep transitive package in a web3 app can rewrite destinations without touching keys.
   Banda's daemon is not a browser, but the same class applies to any transitive package in its tree.

4. **Shai-Hulud worm, September 2025, and Shai-Hulud 2.0, late November 2025.** A self-replicating npm worm that
   harvested credentials (cloud, npm and GitHub tokens) and published leaked data to auto-created GitHub repositories.
   Shai-Hulud 2.0 led to a Trust Wallet loss of about $8.5 million (2,520 addresses) through leaked credentials used to
   publish a malicious Chrome extension version. A February 2026 campaign (at least 19 malicious npm packages) targeted
   crypto keys. An August 2026 report says the malware also searches for cryptocurrency wallet files. Sources (secondary
   coverage; primary vendor reports not read): trendmicro.com research 25/i npm-supply-chain-attack; securityweek.com
   "shai-hulud-supply-chain-attack-led-to-8-5-million-trust-wallet-heist"; thehackernews.com/2026/02/malicious-npm-packages-harvest-crypto.html.
   Lesson: the blast radius of an install-time script is the whole machine. Installs with `--ignore-scripts` plus a
   reviewed allowlist of build scripts are a structural defence.

5. **TanStack, May 2026** (Socket, per the trusted-publishing search excerpt): 84 malicious versions published through
   a legitimate trusted publisher. Sources: socket.dev/blog/npm-trusted-publishing (accessed 2026-11-23; excerpt).

### 8. Library notes (what each does for banda)

- **@noble/curves 2.4.0** (ESM, depends only on @noble/hashes 2.4.0): secp256k1 ECDSA, recovery, and the curves an EVM
  wallet needs. Pure JS, constant-time claims per the README (UNVERIFIED in detail).
- **@noble/hashes 2.4.0**: keccak256 (sha3), sha256, sha512, hmac, pbkdf2 (BIP-39 seed). Zero runtime dependencies.
- **@scure/bip32 2.4.0**: HD derivation (BIP-32), used for `m/44'/60'/0'/0/n`.
- **@scure/bip39 2.4.0**: mnemonic generation and validation with English wordlist; note it gives the mnemonic
  export path that the owner's requirement ("export at creation") would need.
- **micro-eth-signer 0.20.1**: transactions (legacy, EIP-1559 and others), RLP, address checksum, EIP-712 typed data.
  Depends on micro-packed plus the noble stack. Its README/test-vector coverage is the spike's input (UNVERIFIED).
- **ox 1.8.20**: typed Ethereum utilities (Rlp, TransactionEnvelope, TypedData, Address, Hex), used by viem; ESM only;
  depends on zod (runtime) and abitype. Larger surface than micro-eth-signer.
- **viem 2.58.4**: full client (RPC, ABI, actions) built on ox. Recommended only as an RPC client if the spike shows it
  is needed for the wallet's reads; its declared noble/scure versions would need a resolution override to avoid duplicates.
- **ethers 6.17.0**: complete library (wallet, provider, ABI, EIP-712). Lower cadence and older pinned noble versions.
  Not recommended for lockstep with the 2.x stack unless overrides are accepted.

### 9. Defences (concrete, with status)

- **Exact pins, no ranges.** Pin every direct and transitive version the daemon ships. Pinning in `package.json` as
  `"2.4.0"` without `^`/`~` (AGENTS.md principle 13 says the same). Verified by reading the registry; no
  tool run needed.
- **Committed lockfile and `npm ci`.** Standard; AGENTS.md already requires `npm ci`.
- **Install without lifecycle scripts for dependencies.** `npm ci --ignore-scripts`, then an explicit allowlist of
  packages that need build steps. Blocks the install-time payload class used by Shai-Hulud. (Verify that the banda
  repo does not depend on dependency install scripts; UNVERIFIED for this repo.)
- **Signature and provenance check in CI.** `npm audit signatures` verifies registry signatures and provenance for
  installed packages. Source: npm documentation (docs.npmjs.com, accessed via search, UNVERIFIED in full).
- **Minimum release age.** A cooldown before adopting a fresh version (e.g. skip versions younger than N days) would
  have blocked the Solana and chalk windows. The mechanism available in the installed npm version was NOT verified in
  this research; a spike is needed before naming a flag.
- **Advisory query in CI.** OSV or `npm audit` on each lockfile change (a query returned zero results on 2026-11-23).
- **Look-alike names.** Use only exact names (`viem`, `ethers`, `micro-eth-signer`); compare against the registry
  before adding a dependency.
- **Key isolation.** The daemon keeps private keys only in the OS keychain and never passes them to dependencies beyond
  the signing call (an architecture rule for banda, not a library property).

## Libraries table

| Library | Version (pin) | Released | Role | Transitive pkgs | ESM | Audit found (public) | Advisories (2026-11-23) | Verdict |
|---|---|---|---|---|---|---|---|---|
| @noble/curves | 2.4.0 | 2026-08-27 | secp256k1 sign/recover | 2 | yes | Cure53 (curves, 2024); Trail of Bits (2023, curves) | none | Use |
| @noble/hashes | 2.4.0 | 2026-08-27 | keccak, sha2, hmac, pbkdf2 | 1 | yes | Cure53 (hashing, 2021) | none | Use |
| @scure/bip32 | 2.4.0 | 2026-08-28 | BIP-32 HD keys | 4 | yes | none found | none | Use |
| @scure/bip39 | 2.4.0 | 2026-08-28 | BIP-39 mnemonic | 2 | yes | none found | none | Use |
| micro-eth-signer | 0.20.1 | 2026-08-29 | RLP, tx, EIP-712 | 6 | yes | none found (own code) | none | Recommended for encoding (spike first) |
| ox | 1.8.20 | 2026-11-23 | typed eth utils | 15 | yes | none found | none | Fallback |
| viem | 2.58.4 | 2026-11-21 | RPC client and actions | 13 | yes | none found | none | Only if RPC client is needed; watch duplicate noble copies |
| ethers | 6.17.0 | 2026-06-18 | full library | 9 | yes (dual) | none found | none | Not recommended (old pinned noble) |

## Risks / CVEs

| Risk | Severity | Source |
|---|---|---|
| Key-exfiltrating compromise of a wallet library on npm (Solana web3.js) | High | CVE-2024-54134 |
| Drainer published through a wallet's own package (Ledger Connect Kit) | High | Ledger incident report; Bleeping Computer |
| Transitive compromise rewriting wallet destinations (chalk/debug) | High | Aikido, Sept 2025 |
| Self-replicating install-time worm harvesting keys and tokens (Shai-Hulud, 2.0) | High | Trend Micro; SecurityWeek |
| Maintainer-account takeover, including via trusted publisher (TanStack, May 2026) | Medium | Socket |
| ws DoS and memory disclosure in transitive dependency (viem, ethers) | Low, since 8.21.0 is above affected ranges | GHSA-96hv-2xvq-fx4p; GHSA-58qx-3vcg-4xpx |
| Look-alike packages (`ethers-v6`, `@wrenfield/viem`) | High if installed | MAL-2026-11297; Hacktron/OSV |
| Duplicate noble/scure copies from viem's declared old versions | Medium (two code paths for key handling) | npm dependency declarations, 2026-11-23 |
| No public audit for encoding libraries (viem, ox, ethers, micro-eth-signer) | Medium | Search results; "not found" |

## Recommendations

1. Adopt the noble/scure stack at exact versions: `@noble/curves@2.4.0`, `@noble/hashes@2.4.0`, `@scure/bip32@2.4.0`,
   `@scure/bip39@2.4.0`. Reason: one maintainer, one line, audited primitives, zero advisories, provenance attested.
2. For RLP, transactions and EIP-712, adopt `micro-eth-signer@0.20.1` (6 transitive packages, same line). Spike it
   against published vectors (EIP-712 examples, a known legacy and EIP-1559 transaction signature, RLP test vectors)
   and against anvil (`eth_sendRawTransaction`) before any DESIGN.md claim. Fallback: `ox@1.8.20`.
3. Use `viem` only if the RPC client is required. If used, resolve its declared `@noble/*` and `@scure/*` to the 2.x line
   with an explicit override, and check the lockfile for a single copy. Do not let viem bring a second curve library
   silently.
4. Do not use `ethers` for signing in this stack (old pinned noble versions; slow cadence).
5. Pin exact versions in `package.json`, keep the lockfile, install with `npm ci --ignore-scripts`, and run `npm audit
   signatures` plus an advisory query in CI. Re-verify the zero-advisory result before each release.
6. Add a version-age cooldown for new dependency versions, after a spike confirms the npm mechanism in the installed npm.
7. Keep private-key handling inside one module that is the only importer of the signing libraries; this bounds
   exposure to any compromise of the libraries above.
8. Track the noble audit record (cure53.de, Trail of Bits) and request a written statement on micro-eth-signer's
   own review from the maintainer before listing it as audited.

## Open questions

- Does micro-eth-signer 0.20.1 have test vectors covering EIP-1559 typed transactions and EIP-712 v4 with real
  signatures? (Spike.)
- Does the repo's existing toolchain (Node 24, npm version in mise) support the npm flag for version-age cooldowns?
  Not verified.
- Is there a primary audit for micro-eth-signer, ox or viem published after the search index, or an audit commissioned
  by the maintainers? Ask the maintainers directly.
- Exact text and dates of npm's trusted-publisher configuration defaults (docs.npmjs.com/trusted-publishers) were
  taken from search excerpts; read the primary page before a DESIGN.md claim.
- Full Shai-Hulud and Trust Wallet primary post-mortems were not read; figures are from secondary coverage.
- The August 2026 Trail of Bits and OpenAI audit of noble-curves is listed only on the maintainer's page; confirm with
  Trail of Bits before citing.
