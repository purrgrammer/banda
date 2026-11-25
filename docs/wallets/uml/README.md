# Wallets: UML

Every diagram of the wallets design, as PlantUML sources (`*.puml`) with their rendered SVGs in `svg/`. The words are
the ones [../../wallets.md](../../wallets.md) defines. Rule ids (C1..C23) are in [../conflicts.md](../conflicts.md). Hazard ids
(H-nnn), owner decisions still open (OD-n) and trust assumptions (TA-n) are in [../hazards.md](../hazards.md). The state
machines are in [../model/](../model/).

A note that names a machine row writes it as `from · event [guard] → to`. That is the row of
`../model/transitions.json` with that machine, source state, event, guard and target. `[...]` stands for the guard's
leading conjuncts.

## Index

### Use cases
| Diagram | What it shows |
|---|---|
| [uc-owner.puml](uc-owner.puml) ([svg](svg/uc-owner.svg)) | The owner's use cases and what a paired phone may do: create a wallet and save its key, restore, archive, remove, Send, Receive, the tx list, per-agent access, and recipients and rules. |
| [uc-agent-daemon.puml](uc-agent-daemon.puml) ([svg](svg/uc-agent-daemon.svg)) | Agents' wallet tools, the box's x402 path, the daemon's duties (admit, card, lane, follow, replace, index, resume, observe), and the outside systems they use. |

### Structure
| Diagram | What it shows |
|---|---|
| [component-wallets.puml](component-wallets.puml) ([svg](svg/component-wallets.svg)) | Components and interfaces. Web Settings → Wallets and the card. The daemon's server, admission, permissions, Waits, recipients, lane, ledger, follower, read side, RPC client and egress intake. The signer child, the keychain, the box and its proxy. |
| [deployment-wallets.puml](deployment-wallets.puml) ([svg](svg/deployment-wallets.svg)) | What runs where and what each link carries. The host (desktop shell, daemon, signer child, home, OS keychain holding the keys, the lease and the home secret, box, egress proxy), the phone over Iroh, and the RPC provider, Base, the x402 server and the facilitator. |
| [class-domain.puml](class-domain.puml) ([svg](svg/class-domain.svg)) | The domain classes (Wallet, agent access, recipient identity and Recipient, Deny and Always, payment and signed versions, nonce ledger and lease, reservation, observation, x402 authorization, transaction record), grouped by where each fact is stored: keychain (keys, lease, home secret), signer memory, auth/ (a kind marker only), workspace, pi-durable store, or derived. |

### Sequences
| Diagram | What it shows |
|---|---|
| [seq-01-create-wallet.puml](seq-01-create-wallet.puml) ([svg](svg/seq-01-create-wallet.svg)) | Creation, with the key exported at creation: draw, keychain write and read-back, the creation reveal on the create request's own connection, paste-back confirm, or skip; a later reveal through the desktop app's main process (no daemon route); also the item-exists and keychain-down branches. |
| [seq-02-assign-wallet.puml](seq-02-assign-wallet.puml) ([svg](svg/seq-02-assign-wallet.svg)) | Switching a wallet on for agents (versioned, tools rebuilt, two agents sharing one wallet) and off, which refuses open asks, queued payments and stale calls. |
| [seq-03-pay-always.puml](seq-03-pay-always.puml) ([svg](svg/seq-03-pay-always.svg)) | An agent pays a recipient set to Always: admission commit, lane, signer, fused start commit, broadcast, receipt, Included, Confirmed at finalized. |
| [seq-04-pay-ask-first.puml](seq-04-pay-ask-first.puml) ([svg](svg/seq-04-pay-ask-first.svg)) | The first payment to an unknown recipient raises a card. The owner's answer (Always with a name, Pay, Don't pay, Never pay) sets the rule, or the 24 h deadline ends it. The next payment is already covered. |
| [seq-05-deny.puml](seq-05-deny.puml) ([svg](svg/seq-05-deny.svg)) | Deny refuses without asking. Never pay sets Deny and sweeps the wallet. Deny races the lane, and a crash is followed by Deny. |
| [seq-06-x402.puml](seq-06-x402.puml) ([svg](svg/seq-06-x402.svg)) | x402 from the box. The proxy observes the 402. The agent pays only that observation. Authorization commit with a derived nonce and a chain-time window, the header handed back, settlement followed to finalized. |
| [seq-07-owner-send-concurrent.puml](seq-07-owner-send-concurrent.puml) ([svg](svg/seq-07-owner-send-concurrent.svg)) | The owner's Send concurrent with an agent's payment from the same wallet: commit order, reservations, a double tap, one FIFO lane with one nonce in flight. |
| [seq-08-receive-txlist.puml](seq-08-receive-txlist.puml) ([svg](svg/seq-08-receive-txlist.svg)) | Receive (address and QR). The indexer derives incoming rows from Transfer logs and balance checkpoints and flags "sent outside banda". The tx list merges stored and derived rows. |
| [seq-09-crash-resume.puml](seq-09-crash-resume.puml) ([svg](svg/seq-09-crash-resume.svg)) | Kill points K1 to K7 along the pipeline and what the restart does at each: lane and follower start, chain count against the ledger, resume by state, the tool task's rerun. |
| [seq-10-fee-replacement.puml](seq-10-fee-replacement.puml) ([svg](svg/seq-10-fee-replacement.svg)) | Fee bump: a new version of the same nonce, committed and synced before broadcast, within the reserve. The owner's cancel as a zero-value self-transfer (Cancelled or Confirmed by whichever version is mined), and a foreign transaction taking the nonce, proven from two sources. |
| [seq-11-keychain-unavailable.puml](seq-11-keychain-unavailable.puml) ([svg](svg/seq-11-keychain-unavailable.svg)) | The keychain cannot answer. Each case (unanswered prompt, locked, no Secret Service, missing item, wrong key, another home's lease) takes the wallet offline with a reason. Nothing burns. Then recovery or restore. |

### State machines (generated)
One diagram per machine of `../model/transitions.json`. Each transition is labelled `event [guard] / TLA+ action (rules)`.
A row that keeps its state is a line inside the state. Terminal states are grey.

| Diagram | What it shows |
|---|---|
| [state-wallet.puml](state-wallet.puml) ([svg](svg/state-wallet.svg)) | wallet (WalletLifecycle.tla): 56 rows, 9 states. Creating, saving or skipping the key, archive, remove. |
| [state-signing.puml](state-signing.puml) ([svg](svg/state-signing.svg)) | signing (WalletLifecycle.tla): 38 rows, 6 states. Whether the key can sign now: online, locked, key_missing, wrong_key, other_home, offline_host_mode. |
| [state-recipient.puml](state-recipient.puml) ([svg](svg/state-recipient.svg)) | recipient (RecipientRule.tla): 49 rows, 3 states. A recipient of a wallet, for every agent (OD-1): unknown, ask, deny. |
| [state-permission.puml](state-permission.puml) ([svg](svg/state-permission.svg)) | permission (RecipientRule.tla): 30 rows, 2 states. One agent's Always for a recipient of the wallet: none, always. Two refusal rows are proven unreachable (an Always exists only under an Ask recipient). |
| [state-payment.puml](state-payment.puml) ([svg](svg/state-payment.svg)) | payment (PaymentLane.tla): 75 rows, 12 states. One payment from Idle to Confirmed, Refused, NotPaid, Failed, Cancelled or Restored. |
| [state-nonce.puml](state-nonce.puml) ([svg](svg/state-nonce.svg)) | nonce (NonceAlloc.tla): 21 rows, 4 states. A wallet's nonce lease: free, signing, in_flight, blocked. |
| [state-x402.puml](state-x402.puml) ([svg](svg/state-x402.svg)) | x402 (X402.tla): 40 rows, 11 states. An observed 402 from none to settled, expired, cancelled, refused or not paid. |

### Activity
| Diagram | What it shows |
|---|---|
| [activity-admission.puml](activity-admission.puml) ([svg](svg/activity-admission.svg)) | The admission decision. C3's fixed order of checks in the admitting commit (owner and agent paths), then C4's re-check in the fused start commit, each outcome tied to its payment row. |

## Regenerating

```sh
python3 -I gen_states.py          # rewrites state-*.puml from ../model/transitions.json
python3 -I gen_states.py --check  # reparses them: every row appears exactly once, with its event, guard and target
./render.sh                       # both of the above, then -checkonly and SVG rendering in Docker
```

Never edit the `state-*.puml` files by hand. Change `../model/transitions.json` or `gen_states.py` and regenerate
instead. `render.sh` exits non-zero on any syntax error. It names its containers with a random suffix and removes
them (`--rm`). `style.iuml` holds the skin every diagram includes.

The renderer is the PlantUML image pinned by tag and digest:
`plantuml/plantuml:1.2026.10@sha256:2cf2f097652701319e29b9e6a809e68d4ddb06fbeeb696705c097da8fa6d0507`.
It reports `PlantUML version 1.2026.10 / a00edda [2026-11-11 11:04:35 UTC]`. Tag and digest come from the Docker Hub tags
API, https://hub.docker.com/v2/repositories/plantuml/plantuml/tags (read 2026-11-23).

## Open in the diagrams
These points are drawn as open, because the design has not settled them:
- **Signer error codes.** The codes in seq-11 are illustrative names for C20's fixed codes. The classification is by message prefix.
- **Paid retry.** The pass that lets a paid retry of a held write through the proxy (seq-06).
- **A signed signer helper (OD-11).** Until it ships, the signer is the daemon's child and any connected coding agent takes wallets offline (deployment, component).
