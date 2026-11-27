# Spike: key generation, export formats and signing

Date: 2026-11-23. Runtime: Node v24.22.1, npm 11.19.1, darwin-arm64, Foundry anvil and cast 1.9.0.
Input: `docs/wallets/research/signing-libraries.md` (its recommendation and its runner-up).
No keychain, no Docker, no network writes: a throwaway local anvil only, and public development keys.

## Goal

Answer, with code, before a sentence of it reaches DESIGN.md:

1. Do the recommended stack (`@noble/curves`, `@noble/hashes`, `@scure/bip32`, `@scure/bip39` at 2.4.0, plus
   `micro-eth-signer` 0.20.1) and its runner-up (`ox` 1.8.20) generate keys, derive BIP-44 accounts and sign an
   EIP-1559 transaction and EIP-712 typed data correctly, byte for byte, with deterministic (RFC 6979) signatures?
2. How many packages does each bring, and what do `npm audit` and `npm audit signatures` say?
3. One seed with derived accounts, or an independent key per wallet? What is exported at creation: key, phrase, both?
4. Which library does banda ship?

Known answers it checks against: the BIP-39 vectors (trezor/python-mnemonic `vectors.json`), the EIP-155 signed
transaction, the EIP-712 `Mail` example with its signature, the anvil/Hardhat mnemonic (index 0 =
`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`), anvil's own printed keys, and Foundry's `cast` (Rust, alloy), a third
implementation, for the EIP-1559 bytes and the EIP-712 signatures. A transaction is also sent to anvil.

## Commands

Run outside the repo (it installs `node_modules`):

    mkdir spike && cd spike
    cp <repo>/docs/wallets/spikes/keys-and-signing/{package.json,spike.mjs,run.sh} .
    npm install --ignore-scripts --no-fund
    npm run spike          # = ./run.sh: anvil on a free port, node spike.mjs, anvil stopped on exit

Dependency count and audit, each stack alone in its own empty directory:

    npm init -y && npm install --save-exact --ignore-scripts @noble/curves@2.4.0 @noble/hashes@2.4.0 micro-eth-signer@0.20.1
    npm init -y && npm install --save-exact --ignore-scripts @noble/curves@2.4.0 @noble/hashes@2.4.0 \
        @scure/bip32@2.4.0 @scure/bip39@2.4.0 micro-eth-signer@0.20.1
    npm init -y && npm install --save-exact --ignore-scripts ox@1.8.20
    # in each:
    npm ls --all ; npm audit ; npm audit signatures ; du -sk node_modules

## Observed output (`npm run spike`, trimmed only of blank lines)

```
## 1. Key generation and the raw-key export format
PASS  noble randomSecretKey: 2000 keys are 32 bytes in [1, n-1]  (2000/2000)
PASS  address from key: micro-eth-signer == ox for 2000 random keys  (2000/2000)
PASS  raw export 0x+64hex re-imports to the same address  (2000/2000)
PASS  ox randomPrivateKey -> same address in micro-eth-signer
PASS  micro-eth-signer addr.random -> same address in ox
PASS  invalid key (zero) refused by both  (micro-eth-signer=true ox=true)
PASS  invalid key (n) refused by both  (micro-eth-signer=true ox=true)
PASS  invalid key (31 bytes) refused by both  (micro-eth-signer=true ox=true)
## 2. BIP-39 / BIP-32 against the official vectors (trezor/python-mnemonic vectors.json)
PASS  scure entropy->mnemonic, seed, xprv; ox seed: abandon abandon…
PASS  scure entropy->mnemonic, seed, xprv; ox seed: legal winner…
PASS  scure entropy->mnemonic, seed, xprv; ox seed: letter advice…
PASS  scure entropy->mnemonic, seed, xprv; ox seed: zoo zoo…
PASS  a mistyped last word fails the BIP-39 checksum (scure, ox)
## 3. BIP-44 m/44'/60'/0'/0/i from the anvil/Hardhat mnemonic vs anvil's own accounts
PASS  index 0 == 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (scure, ox, anvil)  (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
PASS  indices 0..9: scure == ox == anvil (addresses and private keys)  (10/10)
PASS  index 3 == cast wallet address --mnemonic-index 3  (0x90F79bf6EB2c4f870365E785982E1f101E93b906)
PASS  MetaMask and Ledger Live paths agree at index 0 and differ at index 1  (MM[1]=0x709979… LL[1]=0x8C8d35…)
      phrase -> key derivation: 5.8 ms per key (n=20, this machine)
## 4. EIP-155 legacy transaction vector (eips.ethereum.org/EIPS/eip-155)
PASS  micro-eth-signer reproduces the EIP-155 signed tx
PASS  ox reproduces the EIP-155 signed tx
## 5. EIP-1559 transaction: byte-identical across micro-eth-signer, ox and cast; accepted by anvil
PASS  ox serialize returns MIXED-CASE hex (the checksummed `to` spliced in): strings differ, bytes do not
PASS  micro-eth-signer (extraEntropy=false) == ox (default) byte for byte  (118 bytes)
PASS  == cast mktx (alloy, Rust) byte for byte (and as a lowercase string)
PASS  deterministic: signing twice gives the same bytes (both libraries)
PASS  micro-eth-signer DEFAULT signBy is hedged: two signatures differ
PASS  …and both hedged signatures recover the same sender
PASS  signature is low-s (EIP-2)
PASS  bare noble sign with prehash:false matches (r,s)
PASS  bare noble sign with its DEFAULT prehash:true gives a different, wrong signature
PASS  ox recovers the sender from the signed envelope
PASS  a broken EIP-55 checksum is refused (micro-eth-signer prepare, ox Address.assert)
      note: an all-lowercase address (no checksum to check) is accepted: micro-eth-signer=true ox=true
      note: micro-eth-signer chainId when omitted: 1
      note: ox chainId omitted: from/assert accept it, serialize throws TypeError: Cannot convert undefined to a BigInt
PASS  anvil accepts the raw tx; hash == keccak(raw bytes)  (0x8cb9508b6c582b997ef1fa1a4fbbc80e998bbd07b1211d27bca588c1e8f0166b)
PASS  receipt: status 1, from == derived address  (block 1)
      resend of the same bytes after mining: error "nonce too low"
PASS  hedged re-signature of the same tx: different hash, refused by the nonce once the first is mined  (error "nonce too low")
## 6. EIP-712: the EIP's own Mail vector, and EIP-3009 TransferWithAuthorization (x402 exact, USDC Base Sepolia)
PASS  ox TypedData.getSignPayload == 0xbe609aee…7bd2 (the EIP's signHash)
PASS  micro-eth-signer signTyped(extraEntropy=false) == EIP-712 vector (v=28, r, s)
PASS  ox sign(getSignPayload) == EIP-712 vector
PASS  micro-eth-signer signTyped DEFAULT is hedged (differs from the vector), still verifies
PASS  cast wallet sign --data reproduces the EIP-712 Mail vector
PASS  EIP-3009 authorization: micro-eth-signer == ox == cast  (0x1b37a5d0dda69030…)
PASS  EIP-3009 authorization recovers to the wallet (ox)
PASS  domain name "USD Coin" vs "USDC" changes the signature (pinned per-chain table needed)
ALL PASS
```

Reproduced twice: once on a fresh anvil from the scratch directory, once from a clean install of the files kept here.

### Golden values (offline test vectors banda's tests can pin)

Both verified by three implementations (micro-eth-signer, ox, cast) and the first accepted by anvil.

- EIP-1559, key = anvil account 0, chainId 31337, nonce 0, tip 1 gwei, max fee 3 gwei, gas 21000,
  to `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, value 10^15 wei, no data, empty access list:
  `0x02f873827a6980843b9aca0084b2d05e008252089470997970c51812dc3a010c7d01b50e0d17dc79c887038d7ea4c6800080c080a0dc36905d114979e456e32f5ee4c7843768e568c71278d46b1fdd45685dab3f21a03e3dcf94a4601571e31e9401d8e95482235ed24ef5d7cd608640edad5335efdb`
- EIP-3009 `TransferWithAuthorization`, key = anvil account 0, domain `{ name: "USDC", version: "2", chainId: 84532,
  verifyingContract: 0x036CbD53842c5426634e7929541eC2318f3dCF7e }`, from account 0 to account 1, value 10000,
  validAfter 0, validBefore 1795440000, nonce `0xabab…ab` (32 bytes):
  `0x1b37a5d0dda69030c75cd3205e9fbfd9735168a016253dad3c0917cf701c0e7703ba798cf3b47020ede9361b39a25b68b2e4a63206493107dc50ac6398d9b4521c`

## Dependencies (measured 2026-11-23)

| Stack | `npm ls --all` distinct packages | npm provenance (`npm audit signatures`) | `npm audit` | node_modules |
|---|---|---|---|---|
| A without HD: curves + hashes + micro-eth-signer | 6 (`@noble/curves`, `@noble/hashes`, `@noble/ciphers` 2.4.0, `micro-eth-signer` 0.20.1, `micro-packed` 0.11.1, `@scure/base` 2.4.0) | 6 of 6 attested | 0 vulnerabilities | 6.9 MB, 296 files |
| A with HD: + `@scure/bip32`, `@scure/bip39` | 8 | 8 of 8 attested | 0 vulnerabilities | 7.2 MB, 328 files |
| B: `ox` 1.8.20 | 15, of which `@noble/curves`, `@noble/hashes`, `@noble/ciphers` twice (2.4.0, and 2.2.0 through `@noble/post-quantum` 0.6.1), plus `zod` 4.6.7, `abitype` 1.3.0, `eventemitter3` 5.0.1, `@adraffy/ens-normalize.ts` 1.0.1 | 13 of 15 (no attestation: `eventemitter3`, `@adraffy/ens-normalize.ts`) | 0 vulnerabilities | 42.4 MB, 3699 files |

Release facts from `npm view <pkg> time` (2026-11-23): `ox` 1.8.20 was published 2026-11-23 05:40 UTC, the day of
this spike, and is one of 120 stable `ox` releases in 2026; `micro-eth-signer` had three releases in 2026, the last
0.20.1 on 2026-08-29; the noble and scure packages 2.4.0 on 2026-08-27 and 2026-08-28.

## What the spike found (beyond "it works")

1. **micro-eth-signer hedges by default.** `Transaction#signBy(key, extraEntropy = true)` and `signTyped`
   (through `encoder().sign(…, extraEntropy = true)`) mix random bytes into the RFC 6979 nonce
   (`node_modules/micro-eth-signer/core/tx.js` line 210, `core/message.js` line 22, `utils.js` line 284). Two
   signatures of one transaction differ, and so do their hashes. Passing `false` gives the RFC 6979 result that
   matches ox, cast and the published vectors. ox defaults to deterministic (`internal/entropy.js`:
   `extraEntropy = false`), but through a process-wide mutable setter (`setExtraEntropy`).
2. **The nonce, not the signature, is what pays once.** A hedged re-signature of an already-mined payment was
   refused by anvil with `nonce too low`. Determinism adds that a re-sign after a crash gives the same bytes and the
   same hash, so the hash recorded for a payment never changes (hazard I6 in
   `docs/wallets/analysis/hazards-durability-concurrency.md`).
3. **micro-eth-signer defaults `chainId` to 1 (Ethereum mainnet)** when it is omitted (`core/tx.js` line 12). ox
   accepts a missing `chainId` in `from` and `assert` and only fails at `serialize` with a bare `TypeError`; it also
   refuses a `bigint` chain id (`1n`), wanting a number.
4. **ox's `TxEnvelope*.serialize` returns mixed-case hex**: it splices the checksummed `to` into the string. The
   bytes equal micro-eth-signer's and cast's; a string comparison or a string-keyed lookup does not. ox's
   `Address.fromPublicKey` returns lowercase unless asked for `{ checksum: true }`; ox's error objects report
   `version: 'ox@0.1.1'` (a stale constant in `dist/core/version.js`) although 1.8.20 is installed.
5. **Raw `@noble/curves` signing is a trap for Ethereum.** `secp256k1.sign` defaults to `prehash: true` (SHA-256 of
   the input) in 2.x (`abstract/weierstrass.js` line 825); called on a keccak digest without `prehash: false` it
   returns a valid-looking, wrong signature. Both wrappers pass `prehash: false`; banda should never call noble's
   `sign` directly for an Ethereum digest.
6. **Addresses**: both libraries refuse a mixed-case address whose EIP-55 checksum is wrong, and both accept an
   all-lowercase address, which has no checksum to check.
7. **Paths**: MetaMask's `m/44'/60'/0'/0/i` and Ledger Live's `m/44'/60'/i'/0/0` give the same account at index 0
   and different ones from index 1 on. A phrase restores "the same accounts" only for whoever knows banda's path.
8. **The raw key round-trips**: 2000 random keys, exported as `0x` + 64 lowercase hex and imported back, gave the
   same address every time; zero, the curve order and a 31-byte key are refused by both libraries.
9. micro-eth-signer also exports `authorization.sign` (EIP-7702) and `eip191Signer` (personal_sign) from its root
   entry, and ships `net/`, `uniswap`, `kzg` and `ssz` modules beside it. None of them is needed; the RFC refuses
   7702 and raw message signing.

## Verdict

**An independent random key per wallet, not one seed for the home.**

| | One seed, accounts derived per wallet | Independent key per wallet |
|---|---|---|
| One secret leaks (export screen, clipboard, a backup, a dependency reading memory during a signature) | every wallet, including ones made later | that wallet |
| What requirement 5 exports at a wallet's creation | the seed (then the second wallet's "export" means nothing new), or the derived key (then the real secret, the seed, is never saved) | that wallet's key, and it is complete |
| Signing for wallet A loads | the seed, which is authority over every wallet (or a cache of derived keys: a second copy) | A's key only |
| Deleting a wallet | its key stays derivable | its keychain entry goes, and with it the key (unless exported) |
| Keychain mapping (RFC: an entry named by the home's id and the account) | one entry for all accounts | one entry per wallet |
| Rotation after a leak | every wallet | one wallet |
| Dependencies | + `@scure/bip32`, `@scure/bip39` | none beyond signing |
| Restore | one phrase, if the path is known (finding 7) | one key per wallet |

The seed's one advantage, a single backup, does not survive requirement 5 (an export at each wallet's creation)
and it costs the property the RFC leans on: a wallet's loss is bounded by that wallet.

**Export the raw private key, `0x` + 64 hex, and nothing else by default.** It is what the owner asked for, it is
what `cast wallet address --private-key` and MetaMask's "import private key" take
(support.metamask.io/start/use-an-existing-wallet/, accessed 2026-11-23), and it round-trips exactly (finding 8).
A raw key has no checksum, unlike a phrase (section 2 shows a mistyped word caught by BIP-39's): the export screen
shows the wallet's address beside the key and offers to check a saved copy by pasting it back and comparing the
derived address, so a transcription error is found while the key is still in the keychain. A per-wallet 12-word
phrase at `m/44'/60'/0'/0/0` (the one index both path conventions agree on, finding 7) is a possible later
addition, at two packages and 6 ms per derivation; it is not needed by any requirement, so it is left out.

**Ship `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0 and `micro-eth-signer` 0.20.1, pinned exactly.** Six packages,
all with provenance, no advisory, one maintainer and one version line, and correct on every vector here. `@scure/bip32`
and `@scure/bip39` are not shipped: tests use anvil's known private keys directly. `ox` 1.8.20 stays the fallback: it
is equally correct, but brings 15 packages with a second copy of the curve library, two without provenance, 42 MB,
a release published the day of this spike (120 in 2026), process-wide mutable crypto settings (`Engine.install`,
`setExtraEntropy`) and the string and default quirks in findings 3 and 4.

## What it means for the design

Rules for the one daemon module that imports the signing libraries (nothing else imports them):

1. It exposes two operations only: sign an EIP-1559 transfer or call that banda built, and sign an EIP-3009
   `TransferWithAuthorization` for a domain taken from banda's pinned per-chain table. Not `authorization.sign`
   (EIP-7702), not `eip191Signer`, not arbitrary `signTyped`: the refusals in the RFC's "Keeping the bound true" are
   then structural, there is no code path to them.
2. Every signature passes `extraEntropy: false`. A test pins the EIP-155 vector, the EIP-712 `Mail` vector and the
   two golden values above, so a library default that comes back (or an upgrade that changes one) fails the build.
3. `chainId` is a required field of banda's own type, never left to a library default (finding 3).
4. The stored raw transaction is bytes (or lowercase hex), and its hash is `keccak256` of those bytes, computed once
   (finding 4).
5. A recipient's identity is its 20 bytes on a chain; it is shown EIP-55 checksummed. An all-lowercase address typed
   or pasted carries no checksum (finding 6), so the owner's Send confirms the full address, never a prefix.
6. Key generation is `secp256k1.utils.randomSecretKey()` (from `globalThis.crypto.getRandomValues`), and the key goes
   straight to the keychain; its one export happens in the creation flow.
7. Upgrades of these three packages are reviewed changes that rerun this spike's vectors; the versions move only
   together (principle 13).

Not answered here (other spikes): where the key is stored and whether macOS prompts (os-keychain), the export
screen's clipboard and screenshot handling, and nonce and replacement on Base Sepolia (chain-operations).

## Sources (accessed 2026-11-23)

- BIP-39 vectors: https://github.com/trezor/python-mnemonic/blob/master/vectors.json (raw file read)
- EIP-155 example (fields, key, signed transaction): https://eips.ethereum.org/EIPS/eip-155
- EIP-712 reference example and expected signature: https://github.com/ethereum/EIPs/blob/master/assets/eip-712/Example.js
- USDC EIP-712 domains on Base and Base Sepolia: `docs/wallets/research/x402.md` (on-chain reads of `name()` and `version()`)
- MetaMask import by private key: https://support.metamask.io/start/use-an-existing-wallet/ (search excerpt)
- Library defaults: the installed packages' own code, at the files and lines cited in the findings
- Versions, dates, provenance, audit: npm registry via `npm view`, `npm audit`, `npm audit signatures`

## Cleanup

`run.sh` stops its anvil and removes its temporary directory on exit; no anvil process was left (checked with
`pgrep`). No container, no keychain entry and no network write was made.
