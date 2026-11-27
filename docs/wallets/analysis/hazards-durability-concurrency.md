# Wallet hazards: durability and concurrency

Status: analysis input for the wallets RFC (`docs/wallets.md`). Nothing here is a design rule (principle 6). Date:
2026-11-23. Lens: what happens to money and to the store when the process dies, the disk lies, the network lies,
two writers meet, or time moves. Trust-model and UX hazards are covered by the other analyses; they appear here only
where a crash or a race changes them.

Every case has an id (`DUR-nnn`), a kind (best, error, edge, race, security), a trigger, the expected behaviour, the
mitigation (banda's own mechanisms first: store commits, Waits, drafts, permissions, idempotent effects, proxy
observations) and a severity:

- **critical**: money moves twice, moves against the owner's rule, or a key is lost or leaks.
- **high**: money stuck (a nonce blocked), a wallet unusable until a person acts, or the agent or the owner told
  something false about money.
- **medium**: recoverable without loss, but a false alarm, a delay or a confusing state.
- **low**: cosmetic or self-healing.

## 1. The pipeline the cases refer to

The RFC's "Paying exactly once" is four steps. Under this lens it has eleven effect boundaries. The cases name them.

| Boundary | What happens | Where it is stored |
|---|---|---|
| B0 admit | the tool call's start commit: agent's access, owner's switch, recipient rule (Deny refuses, Ask opens a draft, Always admits) | the effect's run doc, the intent |
| B1 queue | the admitted intent joins the wallet's lane for its chain | lane doc |
| B2 key | the daemon reads the key from the OS keychain (outside any commit) | memory only |
| B3 burn-prep | nonce and fee fields fixed: the lane's commit that is the effect's "start" in DESIGN.md's sense | lane doc |
| B4 sign | secp256k1 signature in memory | memory only |
| B5 checkpoint | the signed version (raw bytes, hash, fields) committed; **the nonce is burnt here** | lane doc, append-only |
| B6 broadcast | `eth_sendRawTransaction` of stored bytes | the RPC |
| B7 sent | the broadcast's answer recorded | lane doc |
| B8 included | a receipt at `latest` | lane doc |
| B9 safe | the receipt's block at `safe` (batched to L1, about 2 min on Base) | lane doc |
| B10 told | the tool returns; the chat card and the transaction list update | chat entry, tool result |

x402 has its own shorter chain: X0 observe (the proxy records the 402), X1 admit, X2 key, X3 sign the EIP-3009
authorization, X4 checkpoint it, X5 hand the signature to the box, X6 settlement (by the facilitator, not banda),
X7 reconcile on chain (`authorizationState`).

## 2. Invariants the mitigations rely on

These are proposals for the slice's design, each tied to the cases that need it. They are the deterministic way
to keep the scenarios from conflicting with one another: every pair of concurrent actors is ordered by one of them.

- **I1 One lane per (wallet, chain).** A single durable task owned by the wallet (not by any tool call) allocates
  nonces, signs, broadcasts, bumps and tracks. Agents' payments and the owner's Send enqueue intents; only the lane
  touches the nonce. Order is the order of the B1 commits. (DUR-050..052, 022, 023)
- **I2 One unconfirmed transaction per lane.** The lane signs nonce N+1 only once N is included. With 200 ms blocks
  on Base this costs little and removes nonce gaps, cascading reverts and out-of-order replacement as a class.
  Raise it only with a spike that measures the need. (DUR-057, 066, 100)
- **I3 The burn point is B5.** Before B5 a nonce is reclaimable and every admission check may still refuse. From B5
  on, the money decision is made: no rule, switch or removal undoes it; only an explicit cancel attempt (a
  zero-value self-transfer at the same nonce) can race it. (DUR-110, 111, 120)
- **I4 Admission is re-checked in the B3 commit.** The recipient rule, the agent's access and the owner's switch are
  read again in the commit that fixes the nonce, so the "start" DESIGN.md speaks of is the last moment before money is
  committed. Deny wins over any earlier admission. (DUR-108, 110, 112, 115)
- **I5 Signed versions are append-only.** Every version for nonce N (original, bumps, cancel) is committed at B5
  before its broadcast and never deleted, by the lane or by a migration. The tracker checks all of them. (DUR-020,
  063, 161)
- **I6 Signing is deterministic.** All transaction fields are fixed at B3 and the signer passes
  `extraEntropy: false`: micro-eth-signer 0.20.1 hedges by default and gave two hashes for one transaction
  (spike, section 6). (DUR-014, 030)
- **I7 The EIP-3009 nonce is derived, not random.** `keccak256(walletId, intentId)` (or the observation id), so a
  re-sign after any crash produces the same authorization, which the token contract accepts once. (DUR-031, 140)
- **I8 The ledger never goes down.** Next nonce = max(ledger, chain `latest` count). A chain count above the ledger
  with no stored version to explain it freezes new signing on that lane until reconciled. (DUR-030, 053, 151)
- **I9 A foreign transaction at a burnt nonce frees the intent only at `safe`.** Our versions at N are permanently
  invalid only once another transaction at N is in a batched block; only then may the intent be re-admitted (I4) at
  a new nonce. (DUR-054, 073)
- **I10 The chain judges, the store is the truth of intent, the RPC is a witness.** The RPC never lowers the ledger,
  never supplies the chain id, and never sets a fee above the definition's ceiling. (DUR-084, 087, 058)
- **I11 Keys are checked, never trusted.** The address derived from the key read at B2 must equal the wallet's
  recorded address, or nothing is signed. Keychain entries are deleted only by the owner's removal flow. (DUR-043,
  128, 129)
- **I12 Commits that precede an external effect are on disk before the effect.** B5 and X4 must survive power loss,
  not only a process crash (pi-durable's SQLite runs WAL with `synchronous = NORMAL`). Needs a spike. (DUR-030, 031)

## 3. Intent states (for the formal model)

```
Asking ─approve─▶ Queued ─B3─▶ Prepared ─B5─▶ Signed ─B7─▶ Sent ─B8─▶ Included ─B9─▶ Confirmed
  │ deny/expire     │ refuse(I4)/cancel  │ key fails       │ ▲                 │ reorg      (terminal)
  ▼                 ▼                    ▼ (release nonce) │ └─bump/rebroadcast┘ ▼
Refused          Withdrawn            Queued             ├─status 0 at B8──▶ Reverted (terminal, nonce used)
(terminal)       (terminal)                              ├─foreign tx at N, safe (I9)──▶ Queued (re-admitted)
                                                         └─cancel version mined──▶ Cancelled (terminal, nonce used)
```

Properties to check in the model: a nonce is used by at most one Confirmed or Reverted or Cancelled intent; an
intent reaches Confirmed at most once across any interleaving of crashes, rule changes and foreign transactions; no
intent is Signed while its rule was Deny at its B3 commit; every Signed intent eventually reaches a terminal state
or a Wait that names it (no silent stall).

## 4. Cases

### 4.1 Best cases (what must keep working)

**DUR-001 · best · Always payment, end to end.**
Trigger: an agent with access calls `wallet__send(to, 5 USDC)`; the recipient's rule is Always; the wallet holds
20 USDC and gas. Expected: B0 admits within the permission, B1..B10 run once, one transaction, one card ("Paid
Ana 5 USDC"), the tool returns the hash after B8 and the card turns Confirmed at B9. Mitigation: I1, I3, I6; the
effect is `idempotent` keyed by the tool task. Severity: low.

**DUR-002 · best · First payment to an unknown recipient, owner answers Always.**
Trigger: rule absent, default Ask. Expected: B0 opens a draft Wait; the owner taps "Always pay {name}"; in that
commit the rule becomes Always and the Wait is answered; the lane runs B1..B10. Mitigation: existing draft and
permission machinery (`src/core/ask.ts`), with the Deny/Always rule stored per wallet (DUR-119). Severity: low.

**DUR-003 · best · Owner sends from Settings.**
Trigger: owner fills Send (token, amount, address) and confirms. Expected: an intent with owner authority enters the
same lane, no recipient rule applies (law 1), one transaction. Mitigation: I1; the form's submission carries a
request id (DUR-180). Severity: low.

**DUR-004 · best · x402 to an Always endpoint in a routine.**
Trigger: a routine's code fetches an API through the proxy; it answers 402; the agent calls `wallet__pay_x402(obs)`.
Expected: X1 admits, X3..X5 once, the box retries with the header, X7 later marks it settled. Mitigation: I7,
observation single use (DUR-144). Severity: low.

**DUR-005 · best · Restart with a transaction in flight.**
Trigger: daemon stopped (graceful or kill) while a payment is Sent. Expected: on start the lane resumes from its
stored state, looks up each stored version's receipt, rebroadcasts the stored bytes if none is found and the chain
count is not past N, never re-signs. Mitigation: I1, I5; pi-durable resumes the task at its checkpoint. Severity:
low.

**DUR-006 · best · Start-up reconciliation with nothing in flight.**
Trigger: daemon starts; every lane idle. Expected: for each (wallet, chain), chain `latest` count equals the ledger;
nothing to do. Mitigation: I8 check run by the lane at its start. Severity: low.

### 4.2 Crashes and SIGKILL at each boundary

**DUR-010 · error · Kill after B0 (admitted, not queued).**
Expected: the tool task reruns its start; the intent doc keyed by the tool task id already exists, so it is
enqueued once. Mitigation: B0 and B1 in one commit, or B1 idempotent by intent id. Severity: medium.

**DUR-011 · error · Kill while the Ask draft is open.**
Expected: the Wait survives; the card is still there after restart; answering it later proceeds. Mitigation:
existing Waits ("Flows": a fresh checkpoint per invocation; parked tasks with an open Wait run again on start).
Severity: low.

**DUR-012 · error · Kill during the keychain read (B2).**
Expected: nothing was committed after B1; the lane reads the key again. No nonce is held. Mitigation: B2 is before
B3 and outside any commit. Severity: low.

**DUR-013 · error · Kill after B3 (nonce and fees fixed), before B4.**
Expected: the lane resumes the same intent at the same nonce with the stored fields; no other intent can take N
(I1). If the key is now unavailable, the intent goes back to Queued and N is released, because nothing was signed.
Mitigation: I1, I3. Severity: medium.

**DUR-014 · error · Kill after B4 (signed in memory), before B5.**
Expected: the bytes never left the process; the lane signs again from the stored fields and gets the same bytes.
Mitigation: I6. Without `extraEntropy: false` the second signature has a different hash (measured: two hashes for
one transaction), harmless by itself but fatal combined with DUR-030. Severity: high (as a precondition).

**DUR-015 · error · Kill after B5, before B6.**
Expected: on resume the stored bytes are broadcast. Mitigation: I5; broadcast is idempotent for the same bytes.
Severity: low.

**DUR-016 · error · Kill during B6 (request reached the RPC, answer lost).**
Expected: state stays Signed; the resume broadcasts the same bytes, and answers `already known`, `transaction already
imported` or `nonce too low` are resolved by a receipt lookup, never as failure (peer spike: in-pool rebroadcast
answers `already known`; after inclusion `nonce too low`). Never re-sign. Mitigation: I5, the message table
(DUR-082). Severity: medium.

**DUR-017 · error · Kill after B6's answer, before B7.**
Expected: state stays Signed; the resume broadcasts the same stored bytes again and resolves the answer by a
receipt lookup, as in DUR-016. Severity: low.

**DUR-018 · error · Kill after the receipt is fetched, before B8 is committed.**
Expected: receipt fetched again by hash. Severity: low.

**DUR-019 · error · Kill after B8/B9, before B10 (tool result not committed).**
Expected: the tool task reruns, finds the intent terminal in the lane doc and returns that outcome; no second card,
no second transaction. Mitigation: the tool waits on the lane's intent by id (idempotent read), and the chat's
effect entry is keyed by the tool task. Severity: medium.

**DUR-020 · error · Kill during a fee bump: new version checkpointed, not yet broadcast.**
Expected: both versions are tracked; the resume broadcasts the new one; either may be mined; the outcome is whichever
is in the block at N. Mitigation: I5. Severity: medium.

**DUR-021 · error · The lane crash-loops on a stored state (a bug, an unparsable version).**
Expected: pi-durable parks the task after `restartLimit` (5) restarts. The wallet must show "stuck at nonce N" with
the owner's retry (`retryTask`), and never skip N or drop a version. Mitigation: the app shows parked lanes; the
lane's parse of stored versions is schema-checked (TypeBox) on read. Severity: high.

**DUR-022 · race · Owner cancels the chat's run while its payment is in the lane.**
Trigger: cancel always works ("Flows"); aborting a pi-durable task aborts everything it owns. Expected: before B5 the
intent is Withdrawn; after B5 the payment continues and its tracking survives, the chat says it was already signed.
Mitigation: I1, the lane is owned by the wallet, never a child of the tool task; the tool only awaits it. If tracking
were a child task, cancel would orphan a burnt nonce and block the wallet. Severity: critical.

**DUR-023 · race · A non-replay-safe caller is abandoned on restart.**
Trigger: pi-durable aborts nested calls and child tasks of tools that are not replay-safe (`abandonOnRestart`).
Expected: same as DUR-022: an abandoned tool call never takes a Signed intent down with it. Mitigation: I1.
Severity: critical.

### 4.3 Power loss and storage

**DUR-030 · error · Power loss after B6; the newest commits are lost.**
Trigger: pi-durable's SQLite runs WAL with `synchronous = NORMAL`; per its README "commits survive process crashes;
the newest may be lost on power or host failure". B5 (or even B3 and B0) is gone, the transaction is on chain.
Expected: on start the lane sees chain count > ledger (I8) and freezes new signing. The lost hash cannot be
recomputed (the fees came from the RPC at B3 and that commit is gone), so the lane fetches the transaction at nonce N
from the history provider and matches it to the pending intent by recipient, token and amount: a match marks the
intent Sent under that hash; no match keeps the lane frozen and opens an owner Wait. Mitigation: I12 first (B5 and X4 flushed to disk before the broadcast:
a stricter synchronous mode for the wallet's commits, or a barrier commit; needs a spike), I8 and I6 as the net.
Without I12 the rerun tool task can admit the same payment again at N+1 after `nonce too low`: a double payment.
Severity: critical.

**DUR-031 · error · Power loss after an x402 authorization reached the box.**
Expected: X4 lost; the rerun signs the intent again. With a random EIP-3009 nonce that is a second valid
authorization, and both settle (peer spike G: "payee received 2.000000 USDC for one intent"). Mitigation: I7 (the
same nonce, so the contract rejects the second: "authorization is used or canceled"), I12. Severity: critical.

**DUR-032 · error · Disk full (or any commit failure) at B5.**
Expected: the commit throws, nothing is broadcast; the lane retries with a durable sleep; the wallet shows the
store's error. Mitigation: broadcast only after the B5 commit resolves. Severity: medium.

**DUR-033 · error · Commit failure at B7/B8 after a successful broadcast.**
Expected: state stays Signed; the next attempt broadcasts again (harmless) and records. Severity: low.

### 4.4 Keychain

**DUR-040 · error · Keychain locked at B2 (macOS after sleep or screen lock policy, Linux keyring locked) in a nightly
routine.**
Expected: nothing is burnt; the intent waits; the lane opens one owner Wait ("unlock the keychain to pay") and later
intents queue behind it (they need the same key). Approval deadlines keep running. Mitigation: B2 before B3; one Wait
per lane, not per intent. Severity: medium.

**DUR-041 · error · The keychain call blocks (a macOS access prompt after the Node binary changed in an update).**
Expected: the daemon keeps serving; the call times out and becomes DUR-040. Mitigation: keychain access off the
event loop with a timeout (a worker or child process); spike whether `@napi-rs/keyring` 2.1.2 calls are synchronous
and whether the prompt survives a release's Node upgrade (RFC spike list). Severity: high (a synchronous native call
stalls the whole daemon).

**DUR-042 · error · The keychain entry is gone (deleted in Keychain Access, new machine, reinstalled OS).**
Expected: wallet offline; pre-B5 intents fail with words; Signed and later states keep tracking and rebroadcasting
(they need no key); a stuck transaction cannot be bumped and the owner is told so. Mitigation: post-B5 stages read
only the store; offline state named in Settings. Severity: high.

**DUR-043 · security · The keychain returns a key for another address (entry overwritten, name collision between
homes, wrong service name).**
Expected: nothing is signed; wallet offline with "the key in the keychain is not this wallet's". Mitigation: I11
(derive the address, compare with the record) before every B4 and X3. Severity: critical.

**DUR-044 · error · Keychain write at creation succeeds but the read-back fails or differs.**
Expected: creation fails; no address is shown for funding. Mitigation: write, read back, derive, compare, then
commit the record (DUR-125). Severity: critical (funds sent to an address whose key was never stored).

**DUR-045 · error · No Secret Service (headless Linux, systemd unit, SSH session).**
Expected: creation refused, existing wallets offline, no file fallback (RFC). Severity: medium.

### 4.5 Nonce races

**DUR-050 · race · Two agents pay from one wallet at the same instant.**
Expected: both B1 commits are ordered by pi-durable's single commit line; the lane signs N for the first, N+1 for the
second once N is included (I2). No `nonce too low`, no `replacement transaction underpriced`. Mitigation: I1, I2.
Severity: critical without I1 (viem's nonce manager is per process and its docs say a failed send does not prove a
nonce unused; research/chain-operations F5).

**DUR-051 · race · Owner's Send and an agent's payment at once.**
Expected: same lane, FIFO by B1 commit; the owner sees the queue position on the Send sheet. Mitigation: I1.
Severity: high without I1.

**DUR-052 · race · One agent's tool calls in parallel chats or a group's parallel Turns.**
Expected: each call is its own intent in the same lane. Calls in one round already run sequentially ("Messages"), but
group Turns run in parallel. Mitigation: I1. Severity: high without I1.

**DUR-053 · edge · The exported key was used elsewhere while banda was idle.**
Expected: at the next B3 the chain count exceeds the ledger; no stored version explains it; the lane records a
foreign transaction at those nonces (shown in the list as "sent outside banda" once the history provider finds it),
moves the ledger up (I8) and goes on. Mitigation: I8; nothing of banda's was in flight, so nothing to reconcile.
Severity: medium.

**DUR-054 · race · The exported key sends at the same nonce as banda's in-flight transaction.**
Expected: one of the two is mined at N. If ours: done. If the foreign one: every stored version at N answers `nonce
too low` and has no receipt; the lane waits until the foreign block is `safe` (I9), then re-admits the intent (I4:
rule, access, switch read again) at a new nonce, and says so in the chat. Never re-sign earlier: a reorg of the
foreign transaction could include our old version too (DUR-073). Severity: critical.

**DUR-055 · race · A foreign transaction is pending where banda cannot see it.**
Trigger: on Base the `pending` tag resolves to `latest` (Denim migration guide), so a MetaMask transaction in the
mempool is invisible. Expected: banda signs the same N; whichever has the higher fee replaces the other in the pool;
the owner's own external transaction can be dropped silently. Banda never pays twice (one nonce), and reports the
outcome as in DUR-054. Mitigation: say in the export dialog and in Settings that using the key elsewhere while banda
is on can drop one of the two transactions; flag the wallet "used outside banda" after a foreign nonce event.
Severity: high.

**DUR-056 · race · Two banda homes hold the same key (a backup served from `<home>-backups/`, a restore on a second
machine with the key imported).**
Expected: two lanes with two ledgers collide repeatedly as in DUR-054 and DUR-055. Detection: foreign nonce use while
our version was in flight; after the second event in a window the lane pauses and asks the owner which home should
spend. Mitigation: I8, I9, a per-lane pause after repeated foreign use. Severity: critical (owner confusion; money
safe only if I9 holds).

**DUR-057 · edge · A burnt nonce whose every version the pool rejects (insufficient funds after an L1 fee spike).**
Expected: with I2 nothing is behind it. The lane re-signs the same intent at N with recomputed fees if the balance
allows, else fills N with a zero-value self-transfer (Cancelled) and fails the intent with words. Never skip N.
Severity: high (without I2, every later payment waits forever behind the hole).

**DUR-058 · error · The RPC reports a lower count than the ledger (lagging or load-balanced node).**
Expected: the ledger stays; the lane waits for the RPC to catch up before deciding any version was dropped (I10).
Severity: medium.

**DUR-059 · edge · The same address on Base and Base Sepolia.**
Expected: separate lanes and ledgers per chain id; the chain is fixed in the intent at B0; EIP-155 binds each
signature to its chain. Severity: medium.

### 4.6 Fees and replacement

**DUR-060 · error · Not included because the base fee rose.**
Trigger: Base's base fee can double in 174 blocks, about 35 s (network-fees doc). Expected: after a timeout the lane
signs a bump at the same nonce with both `maxFeePerGas` and `maxPriorityFeePerGas` raised by at least 12.5% (geth's
`PriceBump` is 10%), commits it (I5), broadcasts it. Severity: medium.

**DUR-061 · error · The bump is refused: `replacement transaction underpriced`.**
Expected: bump again by the rule; never treat it as a failure of the payment. Tests use geth's rule, not anvil's
(anvil accepted +1%: research F3; peer spike: also +5% and +9%). Severity: medium.

**DUR-062 · edge · The fee ceiling is reached.**
Expected: the lane stops bumping and opens an owner Wait: raise to a stated fee, keep waiting, or try to cancel.
Mitigation: a per-chain fee ceiling in the shipped definition; I10. Severity: high.

**DUR-063 · race · The original is mined after its bump was broadcast.**
Expected: the tracker checks every version at N; the original's receipt wins; the bump answers `nonce too low`. The
list shows the mined hash. Mitigation: I5. Severity: medium (without I5 the lane would think the payment dropped).

**DUR-064 · race · The owner's cancel attempt loses to the original.**
Expected: the payment happened; the card says "cancel came too late: paid". Cancel is labelled an attempt until the
cancel version is mined. Severity: high (the owner told "cancelled" when it was paid).

**DUR-065 · error · The balance cannot cover a bumped fee.**
Expected: no bump; Wait for a top-up or a cancel at a fee the balance allows. Never drop N. Severity: high.

**DUR-066 · error · The pool rejects a signed version for worst-case cost (the operator fee and L1 fee are not in
`eth_estimateGas`; research F2).**
Expected: the nonce is burnt but nothing is in the pool: the lane re-signs the same intent at N with recomputed fees,
or fills N with a zero-value self-transfer and fails the intent (DUR-057). Mitigation: B3 budgets `gasLimit * maxFeePerGas + l1FeeUpperBound + operatorFeeBound + value`.
Severity: medium.

**DUR-067 · error · Mined with status 0 (USDC paused or the recipient blacklisted after estimation).**
Expected: Reverted, gas spent, nonce used; the agent is told it failed; no automatic retry (a retry is a new call,
admitted again). Severity: medium.

**DUR-068 · edge · Fees paid exceed what the draft card estimated.**
Expected: the card says "plus network fee, about X"; the balance is the cap for value and fees together; the list
records the actual fee from the receipt. Severity: low.

**DUR-069 · edge · "Send all" of ETH, then a bump is needed.**
Expected: a bump never changes the value (the approved order); a send-all keeps fee headroom at B3; if the headroom is
used up the lane waits. Severity: medium.

### 4.7 Dropped and reorged transactions

**DUR-070 · error · Evicted from the pool (sequencer restart, pool lifetime).**
Expected: no receipt, chain count not past N; the lane rebroadcasts the newest stored version with backoff, bumping
if underpriced. Mitigation: I5 (peer spike: the stored bytes re-enter the pool after `anvil_dropTransaction`).
Severity: medium.

**DUR-071 · error · The RPC accepted the transaction but never forwarded it.**
Expected: as DUR-070; optionally rebroadcast through a second configured RPC. Severity: medium.

**DUR-072 · edge · An L2 reorg removes an included transaction.**
Expected: the receipt disappears; anvil puts it back in no pool (measured: no receipt, pool empty, nonce rolled back);
the lane rebroadcasts the stored bytes and the same hash is mined again (measured). The agent was told "included" at
B8, so its words must distinguish included from confirmed; B9 at `safe`. Base reports under 0.00000002% reorged at
inclusion and none after batching (finality doc). Severity: medium.

**DUR-073 · edge · Reorg after the lane re-admitted an intent past a foreign transaction (DUR-054) too early.**
Expected: impossible with I9 (wait for `safe`). Without it: the foreign transaction leaves, our old version lands at N,
the re-admitted one at N+1: a double payment. Severity: critical.

**DUR-074 · edge · The single sequencer halts for minutes or hours.**
Expected: no inclusion; the lane backs off without a rebroadcast storm; approvals keep their deadlines; x402
authorizations expire on their own. The wallet shows "network not producing blocks" from head age. Severity: medium.

### 4.8 RPC flakiness and lying RPCs

**DUR-080 · error · 429 rate limits (measured on `mainnet.base.org`, code `-32011`).**
Expected: durable backoff sleeps honoring `Retry-After` (`src/core/retry-after.ts`); a 429 on a send is "not sent
yet", never a rejection. Severity: medium.

**DUR-081 · error · Timeout on `eth_sendRawTransaction`.**
Expected: unknown outcome; rebroadcast the same bytes; never re-sign. Severity: medium.

**DUR-082 · error · Error codes do not discriminate (`-32000` on geth and reth, `-32003` on anvil, varied wording).**
Expected: classify by message (table in research/chain-operations F3 and its recommendation 3); anything unknown is
"maybe sent": keep the bytes and poll. Severity: medium.

**DUR-083 · edge · `nonce too low` answering our own bytes.**
Expected: look up every version's receipt; one mined: done; none mined and the count past N: a foreign transaction
(DUR-054). Measured on anvil for bytes already mined. Severity: high (treating it as failure would admit the payment
again).

**DUR-084 · security · The RPC serves another chain (Sepolia URL for a mainnet wallet, or the reverse).**
Expected: the lane checks `eth_chainId` at start and before each broadcast and goes offline on a mismatch; signatures
carry the definition's chain id, never the RPC's, so bytes are invalid elsewhere (EIP-155). Severity: high.

**DUR-085 · security · The RPC invents a receipt (status 1) for a transaction never mined.**
Expected: B8 says "included per {rpc}"; B9 confirms by reading the block at `safe` and finding the hash in it; with a
second RPC configured, B9 asks both. Severity: high (a false "paid" leads the agent and the owner on).

**DUR-086 · security · The RPC hides a mined receipt.**
Expected: rebroadcasts answer `nonce too low`; the count is past N; with no receipt for any version the lane flags
"the RPC's answers disagree" instead of re-admitting (I9 needs a foreign transaction it can see at N). Severity: high.

**DUR-087 · security · The RPC inflates the base fee or the gas estimate.**
Expected: B3 refuses fees above the per-chain ceiling and gas limits above the operation's (21,000 for a plain ETH
transfer; a fixed bound for an ERC-20 transfer) (I10). Severity: high (fees are paid from the same balance cap, and
no agent chose them).

**DUR-088 · error · Stale or false balance.**
Expected: the balance only gates B3 ("available" = balance − reserved outflows − gas reserve); the pool and the chain
judge; failures are reported. Severity: medium.

**DUR-089 · race · The owner changes the RPC while transactions are in flight.**
Expected: the lane broadcasts every non-terminal version to the new RPC, checks its chain id, and keeps tracking.
Severity: medium.

**DUR-090 · error · Heads go backwards between load-balanced nodes.**
Expected: the lane keeps the highest head seen; confirmation depth uses the `safe` tag, not arithmetic on `latest`.
Severity: low.

### 4.9 Receipts after restart, and long downtime

**DUR-095 · error · Restart with several versions Sent.**
Expected: tracking state is all in the lane doc; no in-memory subscription is needed to resume. Severity: low.

**DUR-096 · edge · The laptop slept or was off for days.**
Expected: on wake the lane looks up receipts once per version, not once per missed timer; Ask drafts past their
deadline are denied (24 h default, `DEFAULT_DEADLINE`); x402 authorizations past `validBefore` are dead; a fee bump due
long ago runs once. Severity: medium.

**DUR-097 · edge · The tool's chat was archived, or its agent archived, before B10.**
Expected: the lane completes; the outcome goes to the wallet's list and, if the chat exists, as a notice. Severity:
low.

### 4.10 Approvals that wait

**DUR-100 · race · An Ask draft is open while another agent spends the balance.**
Expected: on approval, B3 finds "available" short and the tool returns "not paid: the wallet holds X"; the card
resolves with that reason. Mitigation: I2 and the reserved-outflow ledger. Severity: high (without it the payment is
signed and reverts, paying gas, or blocks the lane: DUR-057).

**DUR-101 · race · The owner sets the recipient to Always in the Recipients list while its ask is open.**
Expected: the open ask is answered in that commit ("Nothing is asked twice") and the payment proceeds. Severity: low.

**DUR-102 · race · The owner sets Deny in the Recipients list while asks for that recipient are open.**
Expected: those asks are answered "refused" in the same commit. Mitigation: the Deny rule check joins the commit that
answers covered asks. Severity: high (a stale card the owner later taps would pay a denied recipient unless I4
refuses it anyway).

**DUR-103 · race · Two open asks for one new recipient (two agents or two chats).**
Expected: "Always pay" on one answers the other (it pays too); "Never pay" refuses both; "Pay" once leaves the other
open. The second card says how it was answered. Severity: medium.

**DUR-104 · race · Phone and desktop answer the same card.**
Expected: first writer wins; the second is refused (existing Waits). Severity: low.

**DUR-105 · edge · An approval expires.**
Expected: denied; nothing burnt. Severity: low.

**DUR-106 · race · Approved, then the wallet goes offline before B3.**
Expected: the intent waits in Queued with the lane's Wait (DUR-040/042); no nonce held. Severity: medium.

**DUR-107 · edge · Approved, then held behind a stuck transaction for hours.**
Expected: I4 re-checks at B3; an approval older than a bound (proposal: 1 hour) asks again, so "Pay" means now, not
whenever. Severity: medium.

**DUR-108 · race · Approved ("Pay"), then the owner sets Deny before B3.**
Expected: refused at B3 (Deny wins before the burn, I4), and the card says so. Severity: critical (otherwise money
moves against the owner's latest rule).

### 4.11 Rule changes, unassignment and removal mid-flight

**DUR-110 · race · Always revoked (back to Ask) while the intent is Queued.**
Expected: at B3 the intent is no longer covered: it opens a draft instead of paying. Severity: high.

**DUR-111 · race · Always revoked or Deny set after B5.**
Expected: the payment completes (the money decision was made); the list says "signed before the rule changed". The
generic interrupted-effect path in `src/core/ask.ts` re-checks the permission on restart and otherwise opens an
"interrupted: retry or skip" Wait; for a wallet effect past B5 "skip" does not unsend, so the wallet must not use that
path after B5: the lane, not the tool, owns the outcome. Severity: high.

**DUR-112 · race · The agent's access to the wallet is switched off while its intent is Queued.**
Expected: refused at B3 (`allowed`, checked in every commit that lets an attempt start). After B5: completes.
Severity: high.

**DUR-113 · race · The owner switches the wallet off while x402 authorizations are outstanding.**
Expected: the switch refuses new signatures; outstanding authorizations stay valid bearer instruments until
`validBefore`; the app offers "cancel outstanding authorizations", which submits `cancelAuthorization` (peer spike H:
works unsettled, refused once settled; costs gas or a relayer). Mitigation: validity of minutes (DUR-148). Severity:
high.

**DUR-114 · race · Wallet removal while anything is in flight.**
Expected: refused while any version is non-terminal or any authorization is valid; the owner is told what is
pending. Severity: critical (removal would orphan a burnt nonce, and deleting the key loses the means to bump).

**DUR-115 · race · Recipient forgotten while an Always payment is Queued.**
Expected: as DUR-110 (falls back to the wallet default, Ask or Deny). Severity: high.

**DUR-116 · edge · Recipient renamed mid-payment.**
Expected: label only; cards re-render with the new name; rules, intents and versions hold the address. Severity: low.

**DUR-117 · race · The default for unknown recipients changes (Ask to Deny) while asks are open.**
Expected (proposal): open asks stay open, since they are already in front of the owner; the default applies to new
calls. Severity: low.

**DUR-118 · race · The owner's tap on Deny and the lane's B3 commit land in the same instant.**
Expected: pi-durable orders the two commits; if B3 is first the payment proceeds (I3), else it is refused. The list
and the card show the order. Severity: medium.

**DUR-119 · race · One wallet shared by agents A and B: whose rule is it?**
Trigger: the RFC says rules belong to one wallet "so to one agent", but requirement 6 lets several agents use one
wallet, and a permission binds one agent. Expected: one recipient list per wallet, read at B0 and B3 for every agent;
Deny set from A's card stops B too. Mitigation: the recipients doc per wallet is the source of truth; Always is a
permission on the wallet account, not a per-agent grant. Severity: critical (B pays a recipient the owner refused from
A's card).

### 4.12 Wallet lifecycle: creation, export, removal

**DUR-125 · error · Kill after the keychain write, before the record commit.**
Expected: the creation is a task keyed by a creation id; the keychain entry is named from it; the resume reads the
entry rather than generating a second key. Severity: high.

**DUR-126 · error · Kill after the record commit, before the owner saw the export.**
Expected: the wallet stays "key not yet saved"; the export is offered again until the owner confirms they saved it or
explicitly skips; Receive (address and QR) is withheld until then. Severity: critical (funds on a key the owner never
saved, then DUR-042).

**DUR-127 · race · Two creations at once (double click, two devices).**
Expected: the request id dedupes; a deliberate second wallet is a second id. Severity: low.

**DUR-128 · error · Removal across two stores (record and keychain), killed in between.**
Expected: order is: mark "removing" (commit), delete the keychain entry, commit removed; a resume finishes it.
Severity: high.

**DUR-129 · security · An orphan keychain entry found at start.**
Expected: listed in Settings as "a key without a wallet" with Export and Delete; never deleted automatically. A store
restored from before the wallet existed would otherwise delete a live key. Severity: critical.

**DUR-130 · edge · Removal of a funded wallet.**
Expected: shows the balance and the export, asks to confirm; removal leaves funds on chain and the key with the owner
only if exported. Severity: high.

### 4.13 x402 durability

**DUR-140 · error · Kill after X4, before X5.**
Expected: the resume returns the stored authorization to the box; never signs a second. Severity: high.

**DUR-141 · race · The box's paid retry fails ambiguously (timeout, 5xx), and the agent asks to pay again.**
Expected: the first authorization may still settle. A new one is signed only when the first is dead:
`authorizationState(from, nonce)` false and chain time past its `validBefore`; settled (state true with an
`AuthorizationUsed` log) means paid. Peer spike G shows two authorizations for one intent both settle. Severity:
critical.

**DUR-142 · edge · The facilitator answers `settlement_pending`.**
Expected: record the hash; X7 reads the chain; never pay again for it. Severity: medium.

**DUR-143 · race · Two parallel requests to one Always endpoint.**
Expected: two observations, two payments (two purchases); one authorization per observation. Severity: medium.

**DUR-144 · race · The agent asks to pay one observation twice.**
Expected: the second call returns the stored authorization (or "already paid"); an observation is single use.
Severity: high.

**DUR-145 · edge · The observation is older than its `maxTimeoutSeconds` when an Ask is approved.**
Expected: refused ("the price expired, request again"); a fresh request makes a fresh observation, now under the rule
the owner set. Severity: medium.

**DUR-146 · race · An authorization refused for balance settles later, after a top-up.**
Trigger: peer spike F: an authorization over the balance reverted, then settled once the wallet was topped up.
Expected: the agent was told "failed"; the authorization stays live until `validBefore`. Mitigation: short validity,
the reservation ledger counts outstanding authorizations, and an authorization is not signed above "available".
Severity: high.

**DUR-147 · race · Authorizations and ERC-20 sends draw on one USDC balance without sharing the account nonce.**
Expected: the reservation ledger includes each valid unsettled authorization's value until X7 settles it or it
expires. Severity: high.

**DUR-148 · edge · Local clock skew and `validBefore`.**
Expected: validity is computed from the chain's latest block time, short (minutes); signing is refused if local and
chain time differ by more than a bound. A local clock ahead by hours would otherwise make a bearer authorization live
for hours. Severity: high.

**DUR-149 · race · `payTo` changes between two observations of one endpoint.**
Expected: each observation is judged on its own `payTo`; the changed one asks again (RFC). Severity: medium.

### 4.14 Homes, backups, forks, restores

**DUR-150 · security · `home:fork` resumes in-flight wallet tasks.**
Expected: the fork has a keychain namespace of its own, so pre-B5 intents fail closed ("no key in this home") and
post-B5 rebroadcasts of the same bytes are harmless. The fork copies `durable.db` whole (`scripts/fork-home.ts`), so
the namespace id must live in a file the fork does not copy (as the Iroh key does), never in the store; otherwise the
fork can sign. Routines are paused in a fork; in-flight tool tasks are not. Severity: critical.

**DUR-151 · race · A backup restored on the same machine (same keychain).**
Expected: the restored store has an older ledger and pre-B5 intents the original home may already have paid. On the
first start after a restore the lane resynchronises (I8), and every non-terminal pre-B5 intent becomes an owner Wait
("this payment may have been made after the backup was taken"), resolved by matching history. Mitigation: the restore
note (`restore.json`) marks the start; I8 catches copies made by hand. Severity: critical.

**DUR-152 · race · The automatic pre-migration backup restored to roll back an upgrade.**
Expected: the same stale ledger and stale pre-B5 intents as DUR-151, handled the same way: resynchronise the
ledger (I8) and turn non-terminal pre-B5 intents into owner Waits. Severity: critical.

**DUR-153 · race · The home moved aside by a restore is served with `--home` at the same time.**
Expected: two daemons (two home locks, one per path) sign with one key: foreign nonce use is detected and the
lane pauses for the owner, as in DUR-056. Severity: critical.

**DUR-154 · edge · A backup taken while a transaction was Signed or Sent.**
Expected: the restored lane tracks the same bytes; a receipt or `nonce too low` resolves it. Severity: low.

**DUR-155 · security · Tests or fault sweeps reach the real keychain.**
Expected: the in-memory keystore is chosen structurally (the test home), never by a check that could be skipped.
Severity: high.

### 4.15 Migrations and upgrades

**DUR-160 · error · A migration step killed midway while intents are non-terminal.**
Expected: the step reruns idempotently and never rewrites a version or lowers a ledger; a fault sweep kills it at
each write. Severity: high.

**DUR-161 · error · A release changes the lane's checkpoint shape.**
Expected: stored versions survive the migration (I5); a kept home with a Sent transaction under
`test/fixtures/homes/`. A dropped version means a lost hash and a false "foreign transaction". Severity: high.

**DUR-162 · edge · A release changes fee policy or gas ceilings while transactions are in flight.**
Expected: existing versions keep their fields; the new policy applies to new versions. Severity: low.

**DUR-163 · edge · A release changes a chain's definition (token address, EIP-712 domain name).**
Expected: intents carry what was resolved at B0; nothing past B5 or X4 is re-resolved. Base mainnet USDC's domain
name is "USD Coin", Sepolia's "USDC" (research/x402). Severity: medium.

### 4.16 Clocks and sleep

**DUR-170 · edge · The wall clock jumps forward.**
Expected: Wait deadlines expire early (approvals denied, nothing burnt); bump timers fire early (one extra bump at
worst, bounded by the ceiling); x402 validity uses chain time. Severity: low.

**DUR-171 · edge · The wall clock jumps backward.**
Expected: deadlines and bumps late; nothing unsafe. Severity: low.

**DUR-172 · edge · Times shown in the list.**
Expected: block timestamps for "confirmed at", local time only for "asked at". Severity: low.

### 4.17 The owner's Send and the list

**DUR-180 · race · The owner submits Send twice (double tap; the phone's request retried over Iroh after a dropped
stream).**
Expected: one intent per form instance's request id. Severity: critical.

**DUR-181 · edge · The owner's Send waits behind an agent's stuck transaction.**
Expected: the Send sheet shows it is queued and offers to bump or cancel the one ahead. Severity: medium.

**DUR-182 · edge · Incoming transfers are derived, outgoing are stored.**
Expected: outgoing rows come from the lane (truth); incoming from the history provider or a log index (derived,
rebuildable, principle 1), keyed by (chain, hash, log index) so a re-index or a reorg does not duplicate rows; native
ETH from contracts appears as an unexplained balance change. Severity: medium.

**DUR-183 · security · Spam and address-poisoning rows in incoming history.**
Expected: `wallet__history` returns only the wallet's own payments from the store (RFC), so an agent never copies a
poisoned address from incoming rows; the owner's list marks unrequested tokens. Severity: high.

**DUR-184 · race · An agent reads the balance and decides while another spends.**
Expected: `wallet__balance` reports "available" (balance less reserved outflows) with the time it was read; B3 decides.
Severity: low.

**DUR-185 · edge · An agent loop enqueues hundreds of Always payments.**
Expected: the lane caps its queue per wallet and refuses beyond it in words; each admitted payment still pays (the
balance is the cap by design). Severity: medium.

**DUR-186 · edge · Many wallets and chains poll one rate-limited RPC.**
Expected: one head follower per chain shared by all lanes; receipts looked up per new head, batched. Severity: medium.

## 5. What this asks of the RFC

1. Say where the nonce is taken: at B3, after approval and after the key is in hand, never when a draft opens. The
   RFC's "In one commit: resolve the rule … take the wallet's next nonce" reads as both.
2. Make the lane (I1) and the one-in-flight rule (I2) the design, and the burn point (I3) the word for when a payment
   can no longer be stopped.
3. Write `extraEntropy: false` into the signing rule, with the measurement.
4. Derive the EIP-3009 nonce (I7); require proof the earlier authorization is dead before a second (DUR-141).
5. Decide recipients per wallet, not per agent (DUR-119).
6. Spike I12: whether pi-durable can make one commit power-safe before an external effect.
7. Keep the keychain namespace out of `durable.db` so `home:fork` cannot sign (DUR-150); treat restores as DUR-151.
8. Keep the wallet effect off the generic interrupted path after B5 (DUR-111) and off any task a cancel can abort
   (DUR-022).

## 6. Evidence

Spikes in this analysis (`docs/wallets/analysis/spikes/hazards-durability/`, run 2026-11-23, anvil 1.9.0,
micro-eth-signer 0.20.1):

- Signing twice with `signBy(key)` gave two different hashes; with `signBy(key, false)` the same bytes.
- `anvil_reorg(1, [])` removed a mined transaction from the chain and from the pool and rolled the nonce back; the
  stored bytes broadcast again were mined under the same hash; broadcasting mined bytes answered `-32003 nonce too
  low`.

Corroborating spikes run in parallel in this workflow (scratch outputs, not yet in the repo):
`spike-nonce-and-crash` (the same determinism and reorg results; rebroadcast answers; anvil accepting +1%, +5% and
+9% fee bumps; SIGKILL at reserve, sign, checkpoint, broadcast and receipt with no double payment) and
`spike-x402-settlement` (on an anvil fork of Base Sepolia: replay refused, expiry by `block.timestamp < validBefore`,
an over-balance authorization settling after a top-up, two signatures for one intent both settling,
`cancelAuthorization` working only before settlement).

Sources (all accessed 2026-11-23):

- banda: `DESIGN.md` ("Messages" drafts and permissions, "Flows" Waits and cancel, "Trust" interrupted effects,
  "Home" backups and restores); `src/core/ask.ts` (effect tools, the interrupted path, `DEFAULT_DEADLINE`);
  `src/core/store.ts`; `src/daemon.ts` (`acquireLock`); `src/core/backups.ts` (`restore.json`); `scripts/fork-home.ts`.
- pi-durable 1.4.0 README (installed copy): SQLite "WAL mode with `synchronous = NORMAL`: commits survive process
  crashes; the newest may be lost on power or host failure"; restart limit and parking; abort of owned tasks;
  `abandonOnRestart`; "One process owns a storage at a time".
- `docs/wallets/research/chain-operations.md`: Base Denim and the `pending` tag
  (https://docs.base.org/upgrades/denim/migrate-from-flashblocks), finality and reorg figures
  (https://docs.base.org/specifications/transactions/transaction-finality), fee formula
  (https://docs.optimism.io/op-stack/transactions/fees, https://docs.base.org/specifications/transactions/network-fees),
  geth pool errors and `PriceBump` (github.com/ethereum/go-ethereum `core/txpool`), reth issue 19450, viem nonce
  manager caveats (https://viem.sh/docs/accounts/local/createNonceManager), public RPC limits.
- `docs/wallets/research/x402.md`: EIP-3009 semantics (https://eips.ethereum.org/EIPS/eip-3009), USDC domains,
  `settlement_pending`, the x402 v2 transport.
- `docs/wallets/research/wallet-security.md`: address poisoning, permit and 7702 refusals.
- `docs/wallets/research/os-keychain.md`: `@napi-rs/keyring` 2.1.2.
- `docs/wallets/research/signing-libraries.md`: micro-eth-signer 0.20.1 and noble 2.4.0.

## 7. Open questions for spikes

1. Can pi-durable flush one commit to disk before an external effect (I12), and at what cost per payment?
2. Are `@napi-rs/keyring` calls synchronous on the event loop, and how long does a macOS prompt block them (DUR-041)?
3. On Base Sepolia, how long until an underpriced transaction is evicted, and does the sequencer re-pool a reorged
   transaction (DUR-070, 072)?
4. Is one in-flight transaction per lane fast enough for the busiest routine we expect (I2)? Measure on Sepolia.
5. Which history provider resolves "the transaction at nonce N from this address" for DUR-030 and DUR-151 reconciliation?
