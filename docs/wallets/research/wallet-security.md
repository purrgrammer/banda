# Research: wallet security for an agent-operated EVM hot wallet

Date of research: 2026-11-23. Topic: `wallet-security`. Status: research input for the RFC in `docs/wallets.md`.
Nothing here is a design rule yet (principle 6: each mechanism needs its spike).

## Summary

- **Export format.** Export the raw private key at creation, as the owner asked, but only as a one-time, explicit
  action with a per-wallet key. A BIP-39 seed is one secret for every account, so one leak drains all of them; the
  independent-key model limits blast radius. Trade-off: a seed is easier to back up and restore. This is the main
  open decision (see Open questions).
- **Address display.** EIP-55 checksum catches typos only. Address poisoning exploits look-alike valid addresses,
  so the defence is full-address comparison, an allowlist of recipients by address (not by label), and a
  "first time seen" gate. Our recipient model (rule per address) already points this way.
- **Approvals and signatures.** Permit (EIP-2612) and Permit2 signatures are off-chain, invisible to transaction
  simulators, and were the largest drainer category in 2025. The RFC already refuses standing approvals and
  `eth_sign`; keep that, and add short deadlines and exact amounts.
- **EIP-7702.** Delegations were abused in 2025 to batch-drain wallets. Refuse any 7702 authorization in the
  signer; a wallet that is only a plain EOA should never sign one.
- **Agents are untrusted.** Real incidents (Freysa 2024, ElizaOS memory injection 2025 research, the May 2026
  Grok/Bankr wallet exploit) show prompt injection and memory poisoning can cause transfers. The bound must be
  enforced outside the model: the daemon's rule check, the balance, and the signing refusals. This matches
  principle 4 and the RFC's "Keeping the bound true".
- **Agent-wallet products** (Coinbase CDP, Privy, Turnkey, Safe Zodiac Roles) all enforce policy in a layer the
  agent cannot edit: TEE or policy engine, or an on-chain module. Copy: per-recipient allowlists and
  deny-by-default. Avoid: stateful daily caps as the only control (Privy's own docs call them "disaster
  prevention, not strict real-time enforcement"), and allowlists that cover a contract but not its functions.
- **Libraries.** Use viem (2.58.4) and @noble/@scure primitives for signing and derivation; use
  @napi-rs/keyring (2.1.2) for the OS keychain. Do not use keytar: the upstream repository is archived (last push
  2022-12-12), though its 7.9.0 release is still on npm.

## Findings with sources

### 1. Export format: raw private key vs BIP-39 mnemonic

- No primary-source study was found in this pass that settles the choice. Analysis: a BIP-39 seed lets one secret
  derive every account, which the RFC's "several EVM accounts" requirement makes attractive for backup, but it
  multiplies blast radius, since any leak of the seed exposes every wallet. An independent random key per wallet
  keeps blast radius to one wallet and maps one wallet to one keychain item.
- Derivation conventions are not uniform. MyEtherWallet uses `m/44'/60'/0'/0`, Ethereum's `m/44'/60'/0'/0/i` indexing
  is a convention, and Ledger uses `m/44'/60'/i'/0/0` (account level), so a seed does not restore the same accounts
  across wallets. EIP-600 notes BIP-44's account hierarchy fits Ethereum's account model poorly.
  Sources: https://ercs.ethereum.org/ERCS/erc-600 ; https://eips.ethereum.org/EIPS/eip-601 ;
  https://github.com/digitalbitbox/bitbox-wallet-app/issues/2125 (accessed 2026-11-23).
- Implication: if a seed is chosen, pin the path (`m/44'/60'/0'/0/i`), document it, and export the seed as the
  wallet's backup; do not rely on other wallets re-deriving our accounts.

### 2. One-time display of secrets

- Clipboard hijacking and screenshots are the usual leak paths; no fresh source was collected in this pass for
  OS-specific guidance. Recommendation (analysis, to be spiked): show the export once, behind an explicit owner
  action, with a copy button that clears the clipboard after a short timer, no logging of the value, no
  inclusion in any store, backup or log, and no secret in a URL or query.
- Source gap: this claim needs a spike and an OS clipboard reference (open question).

### 3. Address poisoning

- A USENIX Security 2025 study tested 53 wallets; only three warned explicitly when a transfer went to a
  look-alike address. The attack builds addresses matching the first and last characters of one the victim has
  used. Source: https://www.usenix.org/conference/usenixsecurity25/presentation/tsuchiya ;
  https://arxiv.org/html/2508.12107v1 ; https://arxiv.org/html/2501.16681v3 (accessed 2026-11-23).
- CMU's tool reported 270 million phishing attempts in its study (January 2026) and a $50M loss on 2025-12-19.
  Source: https://cylab.cmu.edu/news/2026/01/07-blockchain-address-poisoning.html (accessed 2026-11-23).
- EIP-55 mixed-case checksum detects typos, not valid look-alikes. Secondary source (a 2025 blog):
  https://onekey.so/blog/ecosystem/even-wang-chun-wasnt-immune-50m-tuition-and-why-address-poisoning-keeps-succeeding
  (accessed 2026-11-23). Check EIP-55 itself before citing it as more than typo detection.
- Mitigations found: compare the full address, use an allowlist with hardware confirmation, and, for us, bind
  rules to the full checksummed address, never to a label (matches RFC "Recipients").

### 4. ERC-20 approvals, EIP-2612 permit, Permit2

- Permit signatures are off-chain, so the victim sees no transaction and simulators can miss them; the attacker
  redeems later and can wait for the balance to grow. Sources (secondary): https://academy.zealynx.io/blog/permit2-signature-phishing ;
  https://dev.to/ohmygod/the-phantom-approval-how-erc-2612-permit-signatures-are-being-weaponized-to-drain-defi-wallets-31bf
  (accessed 2026-11-23).
- Scam Sniffer's annual report (December 2025) puts signature-phishing losses at about $83.85M in 2025, down from
  about $494M in 2024 (drainer websites only; a lower-bound estimate). Source: https://drops.scamsniffer.io/?p=1115
  (accessed 2026-11-23). Figures are from secondary coverage of a partial extract; verify before citing.
- Mitigations: short `deadline`/`sigDeadline`, exact amounts instead of unlimited approvals, revoke stale approvals,
  and refuse these signatures in the signer (RFC already lists this under "Keeping the bound true").

### 5. EIP-7702 delegation phishing (2025)

- After the Pectra upgrade (May 2025), attackers bundled malicious operations into one EIP-7702 authorization.
  Example: Inferno Drainer, May 2025, roughly $146–150k from one wallet (The Block; CoinStats). Scam Sniffer
  reported August 2025 losses over $12M from more than 15,000 wallets, largely tied to 7702 (BeInCrypto, secondary).
- Wintermute (June 2025): over 80% of observed 7702 delegations pointed at copy-pasted sweep contracts.
  Sources: https://www.theblock.co/news/ecosystems/2025-06-01-wintermute-warns-pectra-upgrade-leaves-ethereum-users-at-risk-of-automated-attacks-356481 ;
  https://arxiv.org/html/2512.12174v1 (accessed 2026-11-23).
- Implication: the signer must refuse EIP-7702 authorizations for our accounts. This is a plain structural refusal
  and needs a test (fault/property) in the signing path.

### 6. Blind signing and clear signing

- EIP-712 alone does not solve nested operations; ERC-7730 adds JSON descriptors for clear-signing. Ledger shipped a
  Generic Parser in 2025; Trezor coverage is registry-based (unlisted contracts still blind-sign). Sources:
  https://blog.trailofbits.com/2025/08/27/implement-eip-7730-today/ ; https://eips.ethereum.org/EIPS/eip-7730 ;
  https://trezor.io/blog/news/clear-signing-comes-to-trezor-our-flagship-security-feature-of-2026 (accessed 2026-11-23).
- Relevance: an agent-signed transaction is never "clear" to a human, so the daemon must present what it will sign
  as structured fields (recipient, amount, token, chain), and refuse calldata it does not decode (RFC "Keeping the bound true").

### 7. x402 and EIP-3009 (the agent's payment path)

- EIP-3009 `transferWithAuthorization` signatures are bearer instruments; anyone holding one can submit it. Replay
  protection is on-chain nonce only, after settlement. A facilitator must check amount, expiry and signature before
  submitting. Sources: https://ercs.ethereum.org/ERCS/erc-3009 ;
  https://arxiv.org/pdf/2607.19545 (preprint, unreviewed) ; https://dev.to/linknpark/elf-hosting-an-x402-facilitator-the-eip-3009-gotchas-that-almost-cost-us-money-443k
  (accessed 2026-11-23).
- Observed weaknesses in preprints: a signature with 10x the asking price passed common checks; replay to many
  grants; settlement front-running. The x402 spec's security section is reported as thin. Verify against the
  official x402 spec before implementation.
- Implication for the RFC: bind the x402 rule to the endpoint the daemon observed (as the RFC does), require the
  signed value to equal the observed challenge value, and cap validity to minutes.

### 8. Agent incidents and research

- Freysa (November 2024): a game agent with a transfer tool was tricked by a fake admin block into an
  `approveTransfer` "for incoming" that released its whole balance (about 13.19 ETH). Sources:
  https://simonwillison.net/b/8335 ; https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/
  (accessed 2026-11-23). Lesson: no defence in the prompt; the tool's authority must be bounded by the daemon.
- ElizaOS memory injection (arXiv 2503.16248, "Real AI Agents with Fake Memories", 2025): poisoned persistent
  memory produced unauthorised transfers on testnet and mainnet demonstrations; prompt-injection detectors gave
  limited protection; fine-tuning-based defences helped more. Source: https://arxiv.org/abs/2503.16248 (accessed 2026-11-23).
  Lesson: memory is data, never authority, and owner-set rules must not live in memory the agent can write.
- Grok/Bankr wallet (March 2025 about $330k; May 4, 2026 about $150–200k, figures vary by source): a prompt
  injection triggered an unauthorised token transfer. Sources: https://cointelegraph.com/news/grok-bankr-wallet-free-nft-prompt-injection ;
  https://oecd.ai/en/incidents/2026-05-04-4a73 (secondary, figures inconsistent). Lesson: a safety block in the
  prompt did not survive a system rewrite; move it into code.
- Research position (May 2026 arXiv "Agent Security is a Systems Problem", cited by secondary coverage): treat agents
  as untrusted in crypto flows. Consistent with banda's principles 4 and 5.

### 9. Standards

- CCSS (C4 CryptoCurrency Security Standard): requirements in 3 levels; version 9.0 announced December 2024; covers
  key management. Source: https://cryptoconsortium.org/ccss/ ; https://cryptoconsortium.org/2025/09/24/ (accessed
  2026-11-23). No CoinFabrik link was found in sources. Use CCSS key-management requirements as a checklist, not a
  certification target, for a single-owner home.

### 10. Agent-wallet products: how they model recipients and limits

- **Coinbase CDP / AgentKit.** Spend permissions are on-chain (Spend Permission Manager on Base) with limits by token,
  period and amount; the spender is a server wallet, and the permission is granted by a smart account. AgentKit
  exposes spend-permission actions. Sources: https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions ;
  https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets (accessed 2026-11-23). Versions:
  @coinbase/agentkit 0.10.4 (2026-02-01), @coinbase/cdp-sdk 1.62.0 (2026-11-10).
- **Privy server wallets.** Policy engine with transfer limits and allow/deny lists of recipients, plus contract
  allowlists and calldata constraints. Its own docs say stateful (daily) policies are for disaster prevention and
  that per-transaction limits belong in the app. Sources: https://docs.privy.io/controls/policies/overview ;
  https://docs.privy.io/recipes/using-stateful-policies (accessed 2026-11-23).
- **Turnkey.** Policies evaluated inside a secure enclave; default implicit deny; a root quorum bypasses policies;
  EVM examples use ABI-aware rules. Sources: https://docs.turnkey.com/concepts/policies/language ;
  https://docs.turnkey.com/concepts/policies/examples/ethereum (accessed 2026-11-23). @turnkey/sdk-server 8.11.0
  (2026-11-21).
- **Safe + Zodiac Roles.** Safe's Allowance Module caps token outflows per address; Zodiac Roles v2 adds role-scoped
  contract and function allowlists with per-token allowances. A contract allowlist alone does not restrict which
  functions are callable. Sources: https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit ;
  https://github.com/gnosisguild/zodiac-modifier-roles/blob/main/README.md (accessed 2026-11-23). @safe-global/protocol-kit 8.0.11 (2026-10-28).

What to copy: deny-by-default; per-recipient (address) allowlists; enforcement outside the agent's code path; a
rule that binds the recipient and not the amount, as the RFC chose, with the balance as the cap.
What to avoid: caps that are stateful-only (windowed) with no per-transaction bound; contract allowlists without
function selectors; any policy the agent can edit.

## Libraries

Versions from `npm view <pkg> version time.modified` on 2026-11-23. "Modified" is the registry metadata date, not the
publish date of that version. OSV query returned 0 vulnerabilities for each listed package; GitHub advisory query
returned none for viem and ethers.

| Library | Latest | Modified (registry) | Role | Notes |
|---|---|---|---|---|
| viem | 2.58.4 | 2026-11-23 | EVM client, signing, typed data, 7702 types | Active; SLSA provenance attached. Pin exact. |
| ethers | 6.17.0 | 2026-06-18 | Alternative EVM library | Maintained; viem preferred for new code. |
| @noble/curves | 2.4.0 | 2026-08-27 | secp256k1 primitives | Maintained by paulmillr; SLSA provenance on npm. Audit reports not checked in this pass (open item). |
| @noble/hashes | 2.4.0 | 2026-08-27 | Keccak, SHA | Same maintainer; SLSA provenance. |
| @scure/bip32 | 2.4.0 | 2026-08-28 | BIP-32 HD derivation | Only if a seed is chosen. |
| @scure/bip39 | 2.4.0 | 2026-08-28 | BIP-39 mnemonic | Only if a seed is chosen. |
| @napi-rs/keyring | 2.1.2 | 2026-10-19 | OS keychain (macOS, Windows, Linux Secret Service) | Native module; SLSA provenance. Preferred over keytar. Needs spike on headless Linux and the daemon's Node build. |
| keytar | 7.9.0 | 2025-07-30 | Old keychain binding | Upstream repo archived; last push 2022-12-12. Avoid. |
| x402 | 1.2.0 | 2026-04-16 | x402 client and types | Official x402 Foundation repo. Verify the spec version before use. |
| @coinbase/agentkit | 0.10.4 | 2026-02-01 | Agent toolkit with CDP wallets | Reference only; do not depend on it for the signer. |
| @coinbase/cdp-sdk | 1.62.0 | 2026-11-10 | CDP server wallets | Vendor-hosted keys: conflicts with requirement 1 (non-custodial). Reference only. |
| @turnkey/sdk-server | 8.11.0 | 2026-11-21 | Turnkey policy engine | Vendor-hosted enclave: conflicts with requirement 1. Reference for policy shape only. |
| @safe-global/protocol-kit | 8.0.11 | 2026-10-28 | Safe smart accounts | Smart-account path, separate from EOA recipients. |

Abandoned or risky: keytar (archived). Custodial or vendor-held keys (CDP, Turnkey, Privy) conflict with the RFC's
non-custodial requirement and are reference only.

## Risks / CVEs

| Risk | Severity | Source |
|---|---|---|
| Address poisoning (look-alike valid addresses) | High | USENIX 2025, CMU 2026 study |
| Permit / Permit2 signature drains, invisible to simulators | High | Scam Sniffer 2025 report (secondary) |
| EIP-7702 batched drain delegations | High | Wintermute 2025, Scam Sniffer Aug 2025 (secondary) |
| Prompt injection draining agent wallets (Freysa, Grok/Bankr) | High | Sources in section 8 |
| Memory injection persisting across sessions (ElizaOS research) | High | arXiv 2503.16248 |
| Bearer EIP-3009 authorizations, amount mismatch, replay | Medium | Preprints (unreviewed); ERC-3009 |
| Keychain library abandonment (keytar) | Medium | GitHub archive status |
| Spend caps that are windowed only (Privy docs) | Medium | Privy docs |
| No CVEs found in OSV for the listed libraries | n/a | OSV query 2026-11-23 |

## Recommendations

1. Key model: independent random key per wallet, stored in the OS keychain via @napi-rs/keyring, with the export
   shown once at creation. Decide the seed question explicitly before implementation (Open questions).
2. Export UX: one explicit owner action, value shown once, clipboard cleared after a timer, never logged or stored
   by banda, never sent to the box. Spike it on macOS and Linux before design.
3. Recipients: bind rules to the full checksummed address or the observed x402 origin and path. Show the full
   address on every card. Treat a first-seen recipient as Ask. Never bind to a label.
4. Signer refusals in code (not prompt): EIP-7702 authorizations, `approve`/`setApprovalForAll` beyond an exact
   amount, Permit/Permit2 signatures, `eth_sign`/`personal_sign`, undecodable calldata, and any value above the
   wallet's balance at signing time.
5. x402: bind payment to the observed challenge; signed value must equal the observed price; validity in minutes;
   a changed `payTo` asks again (matches RFC).
6. Agent boundary: rules and the owner's recipient list live in the daemon's store, never in memory the agent can
   write, and never in the prompt. Rule changes are checked at signing time, not only at draft time (RFC already says so).
7. Fault and property tests (principle 10): signer refusal paths, the nonce commit, rule changed mid-draft, a
   recipient renamed mid-payment (identity unchanged), and an x402 challenge with a changed `payTo`.
8. Copy from Turnkey/Privy/Safe: deny-by-default, a policy layer outside the agent, per-recipient allowlists.
   Avoid their custodial models for the signing key.

## Open questions

1. Seed or independent keys? Needs a decision and a spike on restore across wallets (we do not need a second
   wallet to re-derive our accounts, but the owner may expect a single backup phrase).
2. Is raw-key export safe enough on the owner's machines, given clipboard and screenshot risks? Needs an OS-level
   spike (macOS Keychain prompts, Linux Secret Service behaviour when locked).
3. Does @napi-rs/keyring work in the daemon's bundled Node on each platform, including headless Linux (the RFC
   says the wallet stays offline there)?
4. The official x402 spec's security section: check the current spec version for facilitator trust boundaries
   before implementing `wallet__pay_x402`.
5. EIP-55 and checksum behaviour: confirm against EIP-55 itself (secondary sources only so far).
6. Exact Scam Sniffer 2025 figures: only a partial extract and secondary coverage were read; verify the full report.
7. Is a 7702 refusal enough, or should the signer also reject any account whose code is already delegated?

## Method and limits

- Web searches on 2026-11-23 (WebSearch). Primary sources were preferred; several incident figures come from
  secondary or sponsored coverage and are flagged as such. Preprints (arXiv 2607.19545, 2605.30998) are unreviewed.
- Package facts from `npm view` and OSV (`api.osv.dev`) on 2026-11-23. GitHub advisories were queried for viem and
  ethers and returned none. Keytar repository status from `gh api repos/atom/node-keytar`.
- No code was changed; no keychain, wallet or network transaction was touched.
