# Final verification run

Status: analysis for the RFC in [`../../wallets.md`](../../wallets.md), run on 2026-11-23 (mechanical finishing pass, no
design change). How to re-run each check is in [`../README.md`](../README.md) and [`README.md`](README.md).

## Results

| Check | Result |
|---|---|
| UML render, `uml/render.sh` (PlantUML `1.2026.10` pinned by digest, Docker) | exit 0. The state diagrams were regenerated from `transitions.json` and checked (297 of 297 rows emitted exactly once, 7 machines). `-checkonly` reported no syntax error, and 24 SVGs were written to `uml/svg/`. |
| Scenario checker, `check-scenarios.mjs --coverage` | exit 0. Output identical to [`check-scenarios.out.txt`](check-scenarios.out.txt) (`diff` empty). |
| Mutation check, `mutations.mjs` | exit 0. Output identical to [`mutations.out.txt`](mutations.out.txt): 29 of 29 mutations caught. |
| `features/check_features.py` (second, independent gate) | OK: 12 feature files, 315 scenarios (outline rows counted), 231 of 231 phrases used, 295 of 297 rows exercised, 29 of 29 use cases, 145 of 317 hazards tagged (all 317 traced). |
| `model/check_transitions.py` | OK: 297 rows, 163 groups, 7 machines; guards mutually exclusive and exhaustive. |
| TLC 2.19 spot re-run (`SharedBalance_safety`, `RecipientRule_safety`) | No error; 38 and 12,982 distinct states, the same counts as the stored `*.tlc.txt`. The large runs were not repeated (hours); their stored outputs stand, with the five unfinished runs listed in [`../model/README.md`](../model/README.md). |

## Checker output summary (`--coverage`, final run)

```
@cucumber/gherkin 43.0.0; 12 feature files, 162 scenarios, 315 pickles (outline rows counted)
table: 297 rows in 163 groups; 1158618 valuations checked for overlap and gaps (selection sha256 833894278b3cae25)
steps: 231 phrases (231 used); 406 events replayed, 0 without a Then
rows exercised: 295 of 297; 2 proven unreachable by a link (S12)
cross-scenario: 744 pairs of asserted events at the same (machine, from, event) compared
use cases with scenarios: 29 of 29 in scope
hazards (317): 145 tagged on a scenario, 20 named only by an exercised row, 146 under "V&V outside the scenarios", 6 accepted out of scope, 0 not covered
use-case hazard gaps: 0 (a hazard a use case lists that none of its scenarios, exercised rows or V&V-outside notes cover)
OK: guards exclusive and exhaustive; every step maps; every event enabled and determined; every Then is the table's; every @t tag exercised; no two scenarios conflict; every link holds; no hazard or use-case gap
```

Mutations: `OK: baseline passes, evaluator agrees, 29 of 29 mutations caught`.

## Hygiene scan of `docs/wallets/`

- No `node_modules`, `package-lock.json`, other lockfile, `.env*`, `.pem` or PEM private key block.
- No personal data: no user name, email or home path (one `/Users/` hit is a Gmail API URL in a spike output, not a path).
- The only mnemonic is the public anvil one (`test test ... junk`), in `features/ISOLATION.md` and
  `spikes/keys-and-signing/spike.mjs`.
- No keychain entry was left behind: no `banda-spike-` item exists in the login keychain after the runs.

### Every 0x-prefixed 64-hex string

| Hit | What it is |
|---|---|
| `0xac0974bec39a...2ff80` (spikes, research spikes, analysis spikes) | Anvil's default account 0 private key, published in the Foundry docs. It derives `0xf39Fd6e5...92266`, checked with `cast wallet address`. Test only, no real funds. |
| `0x59c6995e998f...8690d` (`spikes/gaps/lib.mjs`, `spikes/x402-settlement/lib.mjs`) | Anvil's default account 1 key, public. It derives `0x70997970...79C8`, checked with `cast wallet address`. |
| `0xddf252ad...523b3ef` | The `Transfer(address,address,uint256)` event topic (`cast keccak`). |
| `0x98de5035...b10a5` | The `AuthorizationUsed(address,bytes32)` event topic (`cast keccak`). |
| `0x7c7c6cdb...a2267` | The EIP-3009 `TransferWithAuthorization` typehash (`cast keccak`, and in the EIP text). |
| `0x7050c9e0...3c8c3` | The ERC-1967 style implementation slot of Circle's FiatTokenProxy (`keccak256("org.zeppelinos.proxy.implementation")`). |
| `0x71f17a3b...c9818`, `0x02fa7265...7834f` | USDC `DOMAIN_SEPARATOR()` values read from public contracts (Base Sepolia fork, Base mainnet). Public chain data. |
| `0x4355c47d...5621c`, `0xbe609aee...57bd2` | The EIP-712 "Mail" example signature and sign hash, from the EIP's own test vector (private key is `keccak("cow")`, a public example). |
| `0xf86c0985...3535`, `0x02f87382...`, `0x8cb9508b...6b`, `0x1b37a5d0...` | Raw-transaction and signature outputs of the signing spike on anvil: the EIP-155 example transaction, and hashes of transactions or authorizations made with the anvil key. |
| `0x865fc8bc...`, `0x4613e3e4...`, `0x0f4db629...`, `0xf626dcc9...`, `0xcf16ded6...` (`out-probes.txt`) | Transaction hashes from anvil runs. |
| `0xa7fa6186...` (`out-pending.txt`) | A transaction hash from a local anvil fork run. |
| `0x55a4a4c4...` (`tx-history/README.md`) | A transaction hash on Base Sepolia, used as a `cast run` example. Public testnet data. |
| `0x00..0a849bbad...` (`3b-mainnet-readonly.mjs`) | A public address left-padded to a 32-byte topic, used for a read-only `eth_getLogs`. Not a key. |

None is a secret: every key hit is a published anvil or EIP test key, and the rest are hashes, topics, selectors or
public chain data.
