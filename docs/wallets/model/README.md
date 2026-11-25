# Wallet model

Formal models of the wallet's state machines, written in TLA+ and checked with TLC. They check the rules of
`../conflicts.md` (C1 to C23) and the owner decisions of `../hazards.md` (OD-n) against crash, power-loss, restore,
reorg, foreign-spend, lying-RPC and race scenarios. `transitions.json` is the deterministic transition table that
every Gherkin scenario is checked against. Every rule the models check has a `*_bug_*.cfg` that switches it off, and
TLC must then find the counterexample the rule exists to prevent; a bug configuration that passes is a failed check.

## Machines

| Module | Machine (table) | What it holds |
|---|---|---|
| `WalletLifecycle.tla` | wallet, signing | Creation (draw, keychain write, read-back fused into the ready commit, reconcile after a crash) and the key-save step (the creation reveal on the creating client only, paste-back confirm, skip). The address is withheld until the key is saved or skipped (`AddressOnlyAfterSaveStep`), and removal is refused once the address left banda while the key was never confirmed saved. Archive and removal, guarded and re-checked at delete; a removal deletes only the wallet's own key (`ForeignKeyKept`). Keychain lock, loss and restore, a planted item, a backup restored beside the home, and the lease with its home secret. |
| `RecipientRule.tla` | recipient, permission | A recipient of the wallet (label, Deny for every agent, OD-1) and each agent's Always on it (a permission), under versioned acts from two devices (C8): the card answers, the list's Ask, Always and Deny, rename and forget. An Always exists only under an Ask recipient (`PermissionUnderRecipient`). |
| `PaymentLane.tla` | payment | One wallet's payments from the call to a terminal state: admission (access > Deny > Always > Ask > the default, C3), the card answers (C9), the FIFO lane (C2), signing in the signer, the fused start commit (C4: the re-check, compare-and-set on the ledger, the version appended and synced), broadcast, fee bumps and the owner's cancel replacement (C6), receipt, a foreign nonce proven from two sources or a lying RPC (C7), revert, reorg and finality (C12). The store is a synced prefix (C21): a crash keeps every commit, a power loss goes back to the last sync. Also switch-off, archive and default changes against the lane (C17), a backup restored over the live home (C16), RPC outages, keychain faults, a rising base fee, funding and the owner's own Send. |
| `NonceAlloc.tla` | nonce | The nonce ledger of one wallet, shared by two agents, the owner and an external spender holding the same key: raised only at finalized (C5), a foreign nonce re-admitted only at finalized (C7), every version synced before it leaves (C21, bumps included), one in flight except after a reorg, compare-and-set at the start commit. |
| `X402.tla` | x402 | An x402 challenge from the proxy's observation through the card, the authorization commit (derived nonce R-5, chain-time window C19), signing and handing the header to the box, each its own step, to settlement, cancellation, expiry at finalized or refusal. It covers chat binding and observed terms (C18), Deny for every agent of the wallet, the wallet's default (Ask or Deny), reservations (C11), crash, power loss and reorg. |
| `SharedBalance.tla` | (none) | The one reservation ledger a lane transfer and a live x402 authorization share (C11, H-240). |

`PaymentLane` composes the payment, nonce and recipient rules in one spec; the smaller modules check each machine at
larger bounds than the composition allows.

## Properties

**Safety (invariants and action properties)**

- `StartBasis` (PaymentLane) and `AuthorizeBasis` (X402): a start commit or an authorization needs Always, or the
  owner's approval of that one payment, or the owner as payer, with the agent's access and the wallet unarchived,
  all checked in that commit against the rules as they are then.
- `RefusedNeverPaid`, `DenyRefusesCall`, `DenyIsPerWallet`, `AckedNeverStarts`, `AckedDenyHolds`: a payment under
  Deny never pays; a refusal or a Deny the owner was told of is never undone by a power loss.
- `AtMostOnePaid`, `AtMostOnce`, `AtMostOncePerObs`: at most one paying transaction per payment, one settlement per
  observation.
- `UniqueNonce`, `NoGap`, `OwnBelowLedger`, `OneInFlight`, `FifoNonces`, `OnChainAtOwnNonce`, `LedgerMonotone`,
  `RaiseOnlyFinal`: no two payments share a nonce except versions of one payment; nonces have no gaps; the ledger
  never moves down and moves up only at finalized.
- `SpentWithinFunded`, `UnderfundedNeverStarts`, `NoUnderfundedAuth`, `WithinBalance`, `CommittedWithinBalance`: a
  start commit or an authorization never takes more than the balance less every reservation, the lane's and x402's
  together.
- `RenameKeepsRule`, `AdmitByIdentity`, `OneIdentityPerAct`, `AlwaysPerAgent`, `NoLostUpdate`,
  `PermissionUnderRecipient`, `UnknownNeverAlways`, `DenyExcludesAlways`: rules are resolved by identity, never by
  label; an act applies only on the version it saw.
- `AlwaysNeverAsks`: an Always payment is never sent to the owner for an answer (no burst pause, OD-12).
- `KeyNeverInStoreOrBox`, `RevealOnlyOnHost`, `RevealOnce`, `NeverSignWithForeignKey`, `OneSigningHome`,
  `NoOrphanItem`, `ReadyOnlyWithKey`, `AddressOnlyAfterSaveStep`, `FundsNeverOrphanedByBanda`: key material never
  enters the store, the box or a log; banda never signs with a key that does not derive the address; one home signs.
- `ForeignKeyKept`: a removal never deletes an item that holds another key (H-045).
- `ReportedIsTrue`, `PaidByObservingChat`, `SignedOnlyObserved`: what the chat is told matches the chain at
  finalized; only the chat that observed a 402 can pay it, and only on the observed terms.
- `ForwardOnly`: the payment's state changes are exactly the edges of `transitions.json`.

**Liveness (weak fairness)**

- `EveryAdmittedEnds` (PaymentLane), `EveryEffectEnds` (NonceAlloc), `EveryCallEnds` (X402), `CreateEnds` and
  `RemoveEnds` (WalletLifecycle): every admitted payment or call reaches a terminal state, provided the RPC recovers,
  the chain keeps mining and finalizing, and faults are bounded. The owner is never assumed to act: Waits and queued
  payments end at their deadline (C10).
- `PaymentLane_live_stuck` is expected to fail: a sent payment priced out by the base fee while the key is lost waits
  for the owner, and without the owner it never ends. `PaymentLane_live_owner` passes when the owner eventually
  unlocks or funds (`OwnerActs`), so the stuck state is a Wait for the owner, never a hang the lane could leave.

## Bounds

Every fault and act has a budget (`Max*` constants), so the state spaces are finite. `gen_cfgs.py` writes the
PaymentLane, NonceAlloc, X402, RecipientRule and SharedBalance configurations from one base each, so a run differs
from its base only in what its name says. No run passes `-deadlock`: a state where nothing but the end of the run is
enabled (`Quiesce`) is a failure.

- `PaymentLane`: 3 payments, paid by agents a1 and a2 and by the owner, to recipients r1, r1 and r2, 1 unit each; the
  external spender moves 1 unit. Every run has 1 crash, 1 power loss and 1 lying RPC answer.
  - `_rules`: owner, rule and label races (2 rule changes, cancel, a keychain fault, funding, 2 labels);
    `_default_deny` the same with the default Deny (OD-13).
  - `_chain`: foreign spend, reorg, bump, revert, a rule change.
  - `_access`: switch-off and on, archive and default changes against the lane.
  - `_cancel`: the owner's cancel replacement with a bump, a rising base fee and a reorg.
  - `_restore`: a backup restored over the live home, with a bump and a rule change.
  - `_decode`: version commits unsynced, own transactions decoded (C21's second line alone).
  - `_pair_{cancel,keyf,outage}_{reorg,foreign,bump}`: the nine pairs of the fault classes too large to combine in
    one run, each with a rule change and a revert. They replace a single run with every class at once, which did not
    finish; a race of three classes at once (for example a cancel, a keychain fault and a reorg) is not checked.
  - Liveness: `_live` (1 agent and the owner, every fault class once), `_live3` (the full cast), `_live_owner`,
    `_live_stuck`.
- `NonceAlloc`: the same three payers plus the external spender; 2 crashes, 2 reorgs, 2 foreign spends, 1 bump and
  1 power loss.
- `WalletLifecycle`: 2 addresses, 2 homes (a backup restored beside), 1 crash, keychain fault, planted item and
  lease move.
- `RecipientRule`: 2 agents, 2 recipients, 2 labels, 2 devices, 4 acts; the default as Ask and as Deny.
- `X402`: 3 observations from 2 chats and 2 agents, the same endpoint seen with 2 payTo addresses; balance 2, window 2
  blocks, height 4; 2 reorgs, 1 crash, 1 power loss, 1 rule change, 1 cancel.
- `SharedBalance`: balance 1, one transfer and one authorization of 1 each, 1 deposit.

## Results

TLC 2.19 (tla2tools.jar of tlaplus v1.7.4) in Docker (eclipse-temurin:21-jre), 1 to 3 workers per run, several runs
at once. Each output is the `*.tlc.txt` beside its `.cfg`; the tables below are generated from those files.

<!-- results:begin -->
Runs with every design rule on:

| Config | What it adds | Result | Distinct states | Depth |
|---|---|---|---|---|
| `PaymentLane_access` | all design rules; access switched off, archive and default changes against the lane | pass | 661,792 | 32 |
| `PaymentLane_cancel` | all design rules; cancel replacement, fee bump, base fee rise, reorg | pass | 4,712,896 | 38 |
| `PaymentLane_chain` | all design rules; chain, nonce and external-spender races | pass | 45,448,292 | 43 |
| `PaymentLane_decode` | version commits unsynced; a decoded own transaction is recognised (second line of C21) | pass | 1,701,368 | 36 |
| `PaymentLane_default_deny` | all design rules; the default for unknown recipients is Deny | pass | 4,865,136 | 36 |
| `PaymentLane_live` | liveness under weak fairness, all design rules | pass | 1,026,912 | 27 |
| `PaymentLane_live3` | liveness under weak fairness, full cast | stopped during the state search (5,806,073 distinct states, no error so far); liveness not checked |  |  |
| `PaymentLane_live_owner` | liveness when the owner eventually unlocks or funds | pass | 6,592 | 19 |
| `PaymentLane_pair_cancel_bump` | all design rules; pairwise: cancel with bump | pass | 15,686,448 | 35 |
| `PaymentLane_pair_cancel_foreign` | all design rules; pairwise: cancel with foreign | pass | 16,929,044 | 40 |
| `PaymentLane_pair_cancel_reorg` | all design rules; pairwise: cancel with reorg | pass | 4,389,040 | 34 |
| `PaymentLane_pair_keyf_bump` | all design rules; pairwise: keyf with bump | pass | 8,777,440 | 35 |
| `PaymentLane_pair_keyf_foreign` | all design rules; pairwise: keyf with foreign | pass | 8,002,800 | 40 |
| `PaymentLane_pair_keyf_reorg` | all design rules; pairwise: keyf with reorg | pass | 2,353,248 | 34 |
| `PaymentLane_pair_outage_bump` | all design rules; pairwise: outage with bump | pass | 6,583,080 | 35 |
| `PaymentLane_pair_outage_foreign` | all design rules; pairwise: outage with foreign | pass | 6,002,100 | 40 |
| `PaymentLane_pair_outage_reorg` | all design rules; pairwise: outage with reorg | pass | 1,764,936 | 34 |
| `PaymentLane_restore` | all design rules; a backup restored over the live home | stopped before the end: no violation in 44,072,628 distinct states |  |  |
| `PaymentLane_rules` | all design rules; owner, rule and label races | pass | 10,977,536 | 36 |
| `NonceAlloc_live` | liveness under weak fairness, all design rules | pass | 737,968 | 39 |
| `NonceAlloc_safety` | all design rules: 2 agents + owner + external spender (2 spends), 2 reorgs, 2 crashes, 1 power loss, 1 bump | pass | 24,937,170 | 51 |
| `WalletLifecycle_live` | Liveness under weak fairness (the keychain eventually answers) | pass | 636,236 | 37 |
| `WalletLifecycle_safety` | All design rules on: two wallets, two homes (a backup restored beside), every fault once | pass | 1,812,796 | 39 |
| `RecipientRule_safety` | versioned acts, default Ask, 4 acts by two devices | pass | 12,982 | 7 |
| `RecipientRule_safety_default_deny` | versioned acts, default Deny, 4 acts by two devices | pass | 12,982 | 7 |
| `X402_default_deny` | all design rules; the default for unknown endpoints is Deny | pass | 51,895,656 | 45 |
| `X402_live` | liveness under weak fairness, all design rules | stopped during the state search (6,786,960 distinct states, no error so far); liveness not checked |  |  |
| `X402_nondurable` | C21 off but R-5 on: a lost authorization commit re-signs the same derived nonce: still once | stopped before the end: no violation in 24,157,509 distinct states |  |  |
| `X402_safety` | all design rules: 3 observations, 2 chats, 2 reorgs, a crash, a power loss, a rule change, a cancel | stopped before the end: no violation in 49,159,011 distinct states |  |  |
| `SharedBalance_safety` | one ledger: a transfer and an x402 authorization | pass | 38 | 7 |

Runs with one rule switched off (or a mutation of a guard); each must fail on the property named:

| Config | Rule off | Result | Distinct states | Depth |
|---|---|---|---|---|
| `PaymentLane_live_stuck` | liveness without the owner when a sent payment is priced out and the key is lost (expected to fail) | fails as intended: temporal | 6,592 |  |
| `PaymentLane_bug_C10` | C10 narrowed: a queued payment never ages out while the keychain is locked | fails as intended: temporal | 832 |  |
| `PaymentLane_bug_C11` | C11 narrowed: an own transaction the balance reading does not reflect is not reserved | fails as intended: UnderfundedNeverStarts | 6,002 | 18 |
| `PaymentLane_bug_C12` | C12 narrowed: status 0 is final at latest | fails as intended: ReportedIsTrue | 2,020 | 10 |
| `PaymentLane_bug_C12pay` | C12 off: an RPC's unverified foreign nonce re-admits a payment still in the pool | fails as intended: AtMostOnePaid | 11,133 | 14 |
| `PaymentLane_bug_C12rpc` | C12 off: an RPC's foreign nonce or status 0 is believed unverified | fails as intended: ReportedIsTrue | 635 | 7 |
| `PaymentLane_bug_C13` | C13 off: cancel or rerun past the burn point reports refused | fails as intended: RefusedNeverPaid | 99,678 | 9 |
| `PaymentLane_bug_C16` | C16 off: a restored backup resumes its unstarted payments | fails as intended: AckedNeverStarts | 71,072 | 9 |
| `PaymentLane_bug_C18` | C18 off: the rule is resolved through the recipient's label | fails as intended: AdmitByIdentity | 1,131 | 6 |
| `PaymentLane_bug_C21` | C21 off: a start commit can be lost to power loss after its bytes left | fails as intended: AtMostOnePaid | 243,532 | 15 |
| `PaymentLane_bug_C21acked` | C21 for effect commits only: an acknowledged refusal or Deny is lost | fails as intended: AckedNeverStarts | 126,691 | 7 |
| `PaymentLane_bug_C21bump` | C21 for start commits only, no decoding: a bump's version commit is lost | fails as intended: AtMostOnePaid | 571,102 | 18 |
| `PaymentLane_bug_C3burst` | C3 negated: a burst of Always calls is paused to ask | fails as intended: AlwaysNeverAsks | 215 | 5 |
| `PaymentLane_bug_C4` | C4 off: the start commit does not re-check | fails as intended: StartBasis | 6,834 | 6 |
| `PaymentLane_bug_C4access` | C4 narrowed: the start commit ignores access, archive and the default | fails as intended: StartBasis | 2,498 | 6 |
| `PaymentLane_bug_C7` | C7 off: re-admit after a foreign nonce at latest | fails as intended: AtMostOnePaid | 173,253 | 15 |
| `PaymentLane_bug_C7gap` | C7 off: the gap it leaves | fails as intended: NoGap | 5,910 | 9 |
| `NonceAlloc_bug_C21` | C21 off: no commit is synced before its bytes leave | fails as intended: AtMostOnce | 6,604 | 14 |
| `NonceAlloc_bug_C21bump` | C21 for start commits only: a fee bump's version commit is lost to power loss | fails as intended: AtMostOnce | 13,236 | 16 |
| `NonceAlloc_bug_C4cas` | C4 narrowed: the start commit takes the signed nonce even if the ledger moved | fails as intended: LedgerMonotone | 13,881 | 11 |
| `NonceAlloc_bug_C5` | C5 off: the ledger is raised to the chain's count at latest | fails as intended: NoGap | 102 | 5 |
| `NonceAlloc_bug_C7` | C7 off: an effect is released at latest when a foreign transaction holds its nonce | fails as intended: AtMostOnce | 4,435 | 15 |
| `WalletLifecycle_bug_C15a` | C15 off: the keychain is written before the store holds the address | fails as intended: NoOrphanItem | 30 | 4 |
| `WalletLifecycle_bug_C15b` | C15 off: ready is committed on the write's word, without reading back | fails as intended: ReadyOnlyWithKey | 17 | 4 |
| `WalletLifecycle_bug_C16lease` | C16 off: no home secret; a backup restored beside its original signs too | fails as intended: OneSigningHome | 22 | 5 |
| `WalletLifecycle_bug_C16proof` | C16 off: the signer does not prove the key derives the address | fails as intended: NeverSignWithForeignKey | 2,778 | 10 |
| `WalletLifecycle_bug_C17` | C17 off: a wallet holding funds can be removed | fails as intended: FundsNeverOrphanedByBanda | 305 | 9 |
| `WalletLifecycle_bug_C17recheck` | C17 narrowed: removal checks the balance only when it begins (the design before the model) | fails as intended: FundsNeverOrphanedByBanda | 4,247 | 9 |
| `WalletLifecycle_bug_C20` | C20 off: the key enters the daemon's durable state | fails as intended: KeyNeverInStoreOrBox | 2 | 2 |
| `WalletLifecycle_bug_H005` | H-005 off: Receive is shown before the key was saved or skipped | fails as intended: AddressOnlyAfterSaveStep | 18 | 5 |
| `WalletLifecycle_bug_OD2` | OD-2 off: a paired device can mint the reveal capability | fails as intended: RevealOnlyOnHost | 51 | 6 |
| `WalletLifecycle_bug_H045` | H-045 off: a removal deletes whatever item is under the wallet's account | fails as intended: ForeignKeyKept | 884 | 8 |
| `RecipientRule_bug_C8` | C8 off: an act applies on a version it did not see | fails as intended: NoLostUpdate | 39 | 3 |
| `RecipientRule_mut_alwaysdeny` | mutation: a card's Always applies under Deny (the guard must fail) | fails as intended: DenyExcludesAlways | 59 | 3 |
| `RecipientRule_mut_forget` | mutation: Forget keeps the permissions (the guard must fail) | fails as intended: UnknownNeverAlways | 97 | 3 |
| `X402_bug_C11` | C11 off: a live authorization is not reserved | fails as intended: NoUnderfundedAuth | 9,144 | 13 |
| `X402_bug_C12` | C12 narrowed: Expired at latest, before the block at validBefore is finalized | fails as intended: ReportedIsTrue | 57,404 | 15 |
| `X402_bug_C18` | C18 off: a chat's agent pays another chat's observation | fails as intended: PaidByObservingChat | 127 | 5 |
| `X402_bug_C21` | C21 off, R-5 on: a lost authorization commit after the header left; the report can be false | fails as intended: ReportedIsTrue | 224,345 | 12 |
| `X402_bug_C3deny` | C3/OD-1 off: Deny binds the endpoint key for one agent only | fails as intended: DenyIsPerWallet | 56 | 4 |
| `X402_bug_C3terms` | C3 off: the pay call carries the agent's terms instead of the observation's | fails as intended: SignedOnlyObserved | 2,554 | 7 |
| `X402_bug_R5` | R-5 and C21 off: a random nonce and a lost commit give the box two authorizations | fails as intended: AtMostOncePerObs | 2,261,587 | 16 |
| `SharedBalance_bug_C11` | C11 off: the lane and x402 each reserve against their own ledger | fails as intended: CommittedWithinBalance | 6 | 3 |
<!-- results:end -->

Five runs were stopped by hand with their queues still growing, so their state spaces are not exhausted:
`PaymentLane_restore` (44.1M distinct states, no violation), `X402_safety` (49.2M, no violation), `X402_nondurable`
(24.2M, no violation), and the liveness runs `PaymentLane_live3` and `X402_live`, whose liveness check runs only after
the state search and so was not reached. Each needs a longer run (an hour or more on 4 or more workers) or a smaller
bound before its row can say "pass". Until then, the restore rests on a partial search plus `_bug_C16` (resuming a
restored payment starts one the chat was told was closed), x402 safety on `X402_default_deny` (the same bounds with the default Deny and 1 reorg
instead of 2, 51.9M states, pass) and the x402 bug configurations, and liveness on `_live`, `_live_owner`, `NonceAlloc_live` and
`WalletLifecycle_live`.

## The transition table

`transitions.json` has one row per `{machine, from, event, guard, to, effects[], hazards[], rules[], tla}`, and a
row may carry `unreachable` with the link that excludes it. A guard is a boolean expression over the machine's
declared atoms. `check_transitions.py` checks the table by brute force:

- It enumerates every valuation of the atoms and proves that, for every (machine, from, event), exactly one guard
  holds. That makes the guards mutually exclusive and exhaustive, so a scenario has one outcome.
- It checks that every state is declared and reached, that every non-terminal state has a way out, and that
  terminal states never change.
- It checks that every hazard id exists in `../hazards.md` and every rule id in `../conflicts.md`, and that every
  `tla` names a definition of the module.
- It checks that the payment rows' state changes equal `PaymentLane.tla`'s `Edges`.

What it does not check: that a row's guard is the TLA+ action's enabling condition. The table and the modules are
linked by edges and names only, and the scenario checker's links (`links` in the table, S10 and S12 in
`../verification/`) keep the machines coherent with each other; a trace-validation run that replays TLC behaviours
through the table is not built.

The table is generated by `build_transitions.py`. A Gherkin scenario names a (machine, from, event) and a valuation;
the row whose guard holds is its expected outcome. Two scenarios conflict only if they give the same (machine,
from, event, valuation) different outcomes, and the check rules that out. Two permission rows (a refusal while the
permission is Always) are marked unreachable: an Always exists only under an Ask recipient, and the scenario checker
proves it (S12).

## Running

```sh
python3 -I gen_cfgs.py            # rewrites the generated *.cfg files
python3 -I build_transitions.py   # rewrites transitions.json
python3 -I check_transitions.py   # checks it
# TLC, one config (MC module, cfg, output); no -deadlock
docker run --rm --name tlc-$RANDOM -v "$PWD":/m:ro -v /path/to/tla2tools.jar:/t.jar:ro -w /m eclipse-temurin:21-jre \
  java -Xmx6g -XX:+UseParallelGC -cp /t.jar tlc2.TLC -workers 2 -cleanup -metadir /tmp/states \
  -config PaymentLane_rules.cfg MC_PaymentLane > PaymentLane_rules.tlc.txt
```

TLC exits 0 when it finds no error, 12 on a violated invariant or action property and 13 on a violated temporal
property; 137 means the container ran out of memory. Get `tla2tools.jar` from the tlaplus v1.7.4 release,
https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4 (released 2024-08-05, checked 2026-11-23; sha256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`). v1.8.0 was still a pre-release on 2026-11-23.

## What is abstracted

- "safe" is not a state: `Finalize` marks blocks final, and Confirmed, Failed, Cancelled and Expired happen only at
  finalized (C12, C19). "Included (safe)" is a display (R-4).
- Amounts are small integers. Fees are a rising base fee (`BaseRise`) that can price a version out and a bump that
  prices it back in; the fee reserve of C11 is folded into the balance check.
- Keychain timing (prompts, the signer's deadline) is a lock or unlock that may happen at any step.
- Approval staleness (C10, 1 h) is not modelled; the 24 h deadlines are the `Deadline` actions.
- The RPC's lies are bounded (`MaxLie`): a claimed foreign nonce or status 0 that the second RPC and the recovered
  signer do not confirm (`LieForeign`).
- x402 reservations and lane transfers share one ledger in `SharedBalance`; `PaymentLane` and `X402` each check
  against their own balance as well.
- Liveness is checked at smaller casts than safety.
