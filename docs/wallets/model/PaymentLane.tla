---------------------------- MODULE PaymentLane ----------------------------
(***************************************************************************)
(* The composed payment machine of one wallet on one network.              *)
(*                                                                         *)
(* Actors: two agents and the owner (each one payment, fixed by the        *)
(* configuration), the wallet's lane (a durable task, conflicts.md C2),    *)
(* the chain (mining, a rising base fee, finalizing, a reorg), an external *)
(* spender using the exported key (C7), the RPC (outages, and claims a     *)
(* second RPC and the recovered signer must confirm), the OS keychain      *)
(* (lock, loss), the system (crash, power loss) and a restored backup.     *)
(*                                                                         *)
(* A payment goes from a tool call (or the owner's Send) through admission *)
(* (C3: access > Deny > Always > Ask > default), the owner's card (Pay,    *)
(* Always pay, Don't pay, Never pay), the fused start commit (C4: re-check *)
(* everything admission checked, take the nonce, store the signed bytes),  *)
(* broadcast, a fee bump or a cancel replacement (C6), receipt, reorg, the *)
(* foreign-nonce re-admission (C7) and a crash or power loss at every      *)
(* boundary, to a terminal state.                                          *)
(*                                                                         *)
(* Each toggle switches one design rule off; the configurations named      *)
(* *_bug_*.cfg do that and must produce the counterexample the rule exists *)
(* to prevent (README.md lists them).                                      *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Agents,            \* the agents that may use this wallet, e.g. {"a1","a2"}
    Recipients,        \* recipient identities (chain + EIP-55 address), e.g. {"r1","r2"}
    Labels,            \* the owner's names for recipients; "none" means unknown
    Payer, Rcpt, Amt,  \* per-payment tuples: who pays, to whom, how much
    ForeignAmt,        \* what the external spender moves with the exported key
    DefaultRule,       \* the wallet's default for unknown recipients at start: "Ask" or "Deny"
    InitFunds, MaxFund,
    MaxCrash, MaxPowerLoss, MaxReorg, MaxForeign, MaxBump, MaxRuleChange, MaxOutage, MaxKeyFault, MaxCancel,
    MaxRevert, MaxLie, MaxCancelReplace, MaxBaseRise, MaxRestore, MaxAccess,
    \* design rules that the bug configurations switch off
    RecheckAtStart,       \* C4: the start commit re-checks payment state, Deny, Always/approval, balance
    RecheckAccess,        \* C4: ... and the agent's access, the wallet's archive and the default rule
    ReadmitAtFinal,       \* C7: a foreign nonce re-admits only once the foreign tx is finalized
    Sync,                 \* C21: synced commits: "all" (the design), "effects", "start" or "none"
    DecodeForeign,        \* C7: a tx at the payment's nonce whose fields decode to the payment is its own
    LaneOwnsOutcome,      \* C13: past the burn point no cancel or rerun reports "refused"
    PreBurnDeadline,      \* C10: a queued, unstarted payment ages out too
    ResolveByLabel,       \* C18 negated when TRUE: the rule is looked up by label, not identity
    FailAtFinal,          \* C12: a status-0 receipt is final only at finalized
    VerifyRpc,            \* C12: a foreign nonce or a status 0 counts only once the signer is recovered
                          \* from the foreign tx and a second RPC agrees
    ReserveIncluded,      \* C11: an own tx in a block the balance reading does not reflect stays reserved
    ResumeRestored,       \* C16 negated when TRUE: a restored backup resumes its unstarted payments
    BurstPause,           \* C3 negated when TRUE: a burst of Always calls is paused to ask
    OwnerActs             \* liveness assumption: the owner eventually unlocks, funds a stuck payment, unfreezes

Owner == "owner"
None  == "none"
Foreign == 0   \* the tag of a transaction the external spender made (payments are 1..n)
Intents == 1..Len(Payer)
Terminal == {"Refused", "NotPaid", "Confirmed", "Failed", "Cancelled", "Restored"}
InFlight == {"Signed", "Sent"}
States == {"Idle", "Waiting", "Queued", "Signed", "Sent", "Included"} \cup Terminal

VARIABLES
    st,       \* payment -> state
    nonce,    \* payment -> nonce held (-1: none)
    nvers,    \* payment -> number of signed versions committed (C6)
    cx,       \* payment -> the version that cancels it (0: none)
    appr,     \* payment -> the owner approved this one payment
    label,    \* recipient -> label ("none": unknown)
    deny,     \* recipient -> Deny, per wallet (OD-1)
    always,   \* recipient -> agents with Always, per (wallet, agent) (OD-1)
    dflt,     \* the wallet's default rule for unknown recipients (a host act changes it)
    on,       \* agent -> this agent may use this wallet (the owner's assignment)
    archived, \* the wallet is archived: it pays nothing more
    queue,    \* the lane's FIFO of Queued payments, in queue-commit order (C2)
    ledger,   \* the store's nonce ledger (C5)
    mem,      \* signer memory: <<payment, nonce>> or <<>> (bytes signed, not committed)
    chain,    \* mined blocks, index k holds nonce k-1: [tag, ver, kind, ok, fin]
    pool,     \* transactions some node holds: <<nonce, tag, version, kind>>; version v pays fee v
    seen,     \* every transaction ever broadcast (a reorg can bring any back)
    base,     \* the network's base fee: version v is minable only if v >= base
    rin,      \* ghost: nonces a reorg put back in flight while a later one was in flight (I8)
    dur,      \* the store as on disk while commits are unsynced (<<>>: on disk = in memory)
    bak,      \* a backup of the store (<<>>: none taken)
    frozen,   \* the lane is frozen after a restore until the owner reviews it
    funded,   \* total ever deposited into the wallet
    rpcUp, key,
    told,     \* ghost: payments whose refusal or Not paid was returned to the caller
    toldDeny, \* ghost: recipients whose Deny the owner saw committed and has not lifted
    b         \* fault and act budgets

storeVars == <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger>>
vars == <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
          seen, base, rin, dur, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

-----------------------------------------------------------------------------
\* Durability (C21). A commit of a kind the mode does not sync leaves the disk where
\* it was (WAL: a power loss drops a suffix of commits); a synced commit syncs every
\* commit before it. The design syncs every wallet commit before it returns.

Store == [st |-> st, nonce |-> nonce, nvers |-> nvers, cx |-> cx, appr |-> appr, label |-> label,
          deny |-> deny, always |-> always, dflt |-> dflt, on |-> on, archived |-> archived,
          queue |-> queue, ledger |-> ledger]
Synced(kind) == \/ Sync = "all"
                \/ Sync = "effects" /\ kind \in {"start", "version"}
                \/ Sync = "start" /\ kind = "start"
Persist(kind) == dur' = IF Synced(kind) THEN <<>> ELSE IF dur = <<>> THEN Store ELSE dur

-----------------------------------------------------------------------------
\* Helpers

TxAmt(tag, kind) == IF tag = Foreign THEN ForeignAmt ELSE IF kind = "cancel" THEN 0 ELSE Amt[tag]

RECURSIVE SumOk(_, _)
SumOk(c, n) == IF n = 0 THEN 0 ELSE (IF c[n].ok THEN TxAmt(c[n].tag, c[n].kind) ELSE 0) + SumOk(c, n - 1)

Spent == SumOk(chain, Len(chain))
Balance == funded - Spent
BalAt(k) == funded - SumOk(chain, k)          \* the balance an RPC reports at block k

RECURSIVE SumSet(_)
SumSet(S) == IF S = {} THEN 0 ELSE LET i == CHOOSE x \in S : TRUE IN Amt[i] + SumSet(S \ {i})

\* An RPC's balance reading is at some block from the finalized one to the head.
FinHeight == CHOOSE h \in 0..Len(chain) : (\A j \in 1..h : chain[j].fin) /\ (h = Len(chain) \/ ~chain[h + 1].fin)
Readings == FinHeight..Len(chain)

\* C11: available = the reading - every other payment the reading does not reflect.
Reserved(j, k) == \/ st[j] \in {"Waiting", "Queued", "Signed", "Sent"}
                  \/ ReserveIncluded /\ st[j] = "Included" /\ nonce[j] + 1 > k
AvailAt(i, k) == BalAt(k) - SumSet({j \in Intents \ {i} : Reserved(j, k)})

OnChain(i) == \E k \in 1..Len(chain) : chain[k].tag = i
BlockOf(i) == chain[nonce[i] + 1]
Remove(q, i) == SelectSeq(q, LAMBDA x : x # i)
Max(x, y) == IF x > y THEN x ELSE y

\* The rule an agent's payment meets (C3 step 7). With ResolveByLabel the rule is
\* looked up through the recipient's name: the bug C18 forbids.
Same(r) == IF ResolveByLabel /\ label[r] # None
           THEN {r2 \in Recipients : label[r2] = label[r]}
           ELSE {r}
EffRule(a, r) ==
    IF \E r2 \in Same(r) : deny[r2] THEN "Deny"
    ELSE IF \E r2 \in Same(r) : a \in always[r2] THEN "Always"
    ELSE IF label[r] # None THEN "Ask"
    ELSE dflt
\* The same by identity alone: what the properties hold the lane to.
EffRuleId(a, r) ==
    IF deny[r] THEN "Deny" ELSE IF a \in always[r] THEN "Always" ELSE IF label[r] # None THEN "Ask" ELSE dflt

Access(a) == IF a = Owner THEN ~archived ELSE on[a] /\ ~archived

\* What a start commit may accept (C4): the owner's own Send from a live wallet, or an
\* agent payment of an agent with access whose recipient is not denied (by rule or by
\* default) and is Always for that agent or approved once.
StartOK(i) ==
    IF Payer[i] = Owner THEN ~archived
    ELSE /\ Access(Payer[i])
         /\ EffRuleId(Payer[i], Rcpt[i]) # "Deny"
         /\ (Payer[i] \in always[Rcpt[i]] \/ appr[i])

Refuse(S) == /\ st' = [j \in Intents |-> IF j \in S THEN "Refused" ELSE st[j]]
             /\ told' = told \cup S

-----------------------------------------------------------------------------
Init ==
    /\ st = [i \in Intents |-> "Idle"]
    /\ nonce = [i \in Intents |-> -1]
    /\ nvers = [i \in Intents |-> 0]
    /\ cx = [i \in Intents |-> 0]
    /\ appr = [i \in Intents |-> FALSE]
    /\ label = [r \in Recipients |-> None]
    /\ deny = [r \in Recipients |-> FALSE]
    /\ always = [r \in Recipients |-> {}]
    /\ dflt = DefaultRule
    /\ on = [a \in Agents |-> TRUE]
    /\ archived = FALSE
    /\ queue = <<>>
    /\ ledger = 0
    /\ mem = <<>>
    /\ chain = <<>>
    /\ pool = {}
    /\ seen = {}
    /\ base = 1
    /\ rin = {}
    /\ dur = <<>>
    /\ bak = <<>>
    /\ frozen = FALSE
    /\ funded = InitFunds
    /\ rpcUp = TRUE
    /\ key = "ok"
    /\ told = {}
    /\ toldDeny = {}
    /\ b = [crash |-> MaxCrash, pl |-> MaxPowerLoss, reorg |-> MaxReorg, foreign |-> MaxForeign, bump |-> MaxBump,
            rule |-> MaxRuleChange, outage |-> MaxOutage, keyf |-> MaxKeyFault, cancel |-> MaxCancel,
            fund |-> MaxFund, revert |-> MaxRevert, lie |-> MaxLie, cancelr |-> MaxCancelReplace,
            base |-> MaxBaseRise, restore |-> MaxRestore, access |-> MaxAccess]

-----------------------------------------------------------------------------
\* Admission (C3), one commit. A tool call of an agent, or the owner's Send. The
\* balance is read at some block (Readings).

Call(i) ==
    /\ st[i] = "Idle"
    /\ LET a == Payer[i]
           rule == IF a = Owner THEN "Owner" ELSE EffRule(a, Rcpt[i])
       IN \E k \in Readings :
          CASE ~Access(a) \/ rule = "Deny" \/ AvailAt(i, k) < Amt[i] ->
                    Refuse({i}) /\ UNCHANGED queue
            [] rule \in {"Owner", "Always"} ->
                    \/ st' = [st EXCEPT ![i] = "Queued"] /\ queue' = Append(queue, i) /\ UNCHANGED told
                    \/ BurstPause /\ rule = "Always" /\ st' = [st EXCEPT ![i] = "Waiting"] /\ UNCHANGED <<queue, told>>
            [] rule = "Ask" ->
                    st' = [st EXCEPT ![i] = "Waiting"] /\ UNCHANGED <<queue, told>>
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, ledger, mem, chain, pool, seen,
                   base, rin, bak, frozen, funded, rpcUp, key, toldDeny, b>>

-----------------------------------------------------------------------------
\* The owner's card on a Waiting payment (C8, C9: the first commit wins).
\* Answering names an unknown recipient (the card's name field).

NameIfUnknown(r) == label' = [label EXCEPT ![r] = IF label[r] = None THEN "L1" ELSE label[r]]

Pay(i) ==
    /\ st[i] = "Waiting"
    /\ IF Payer[i] # Owner /\ deny[Rcpt[i]]
       THEN Refuse({i}) /\ UNCHANGED <<queue, appr>>
       ELSE /\ st' = [st EXCEPT ![i] = "Queued"]
            /\ appr' = [appr EXCEPT ![i] = TRUE]
            /\ queue' = Append(queue, i)
            /\ UNCHANGED told
    /\ NameIfUnknown(Rcpt[i])
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, nvers, cx, deny, always, dflt, on, archived, ledger, mem, chain, pool, seen, base, rin,
                   bak, frozen, funded, rpcUp, key, toldDeny, b>>

DontPay(i) ==
    /\ st[i] = "Waiting"
    /\ Refuse({i})
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, toldDeny, b>>

\* Always for (wallet, agent, recipient), in one commit with the answer it covers (C9):
\* every Waiting payment of that agent to that recipient is approved with it. It is
\* never granted over a Deny: the owner lifts the Deny first (recipient machine).
Covered(a, r) == {j \in Intents : st[j] = "Waiting" /\ Payer[j] = a /\ Rcpt[j] = r}

RECURSIVE AppendAll(_, _)
AppendAll(q, S) == IF S = {} THEN q
                   ELSE LET j == CHOOSE x \in S : \A y \in S : x <= y IN AppendAll(Append(q, j), S \ {j})

GrantAlways(a, r) ==
    /\ always' = [always EXCEPT ![r] = @ \cup {a}]
    /\ st' = [j \in Intents |-> IF j \in Covered(a, r) THEN "Queued" ELSE st[j]]
    /\ appr' = [j \in Intents |-> IF j \in Covered(a, r) THEN TRUE ELSE appr[j]]
    /\ queue' = AppendAll(queue, Covered(a, r))

AlwaysPay(i) ==
    /\ st[i] = "Waiting" /\ Payer[i] # Owner /\ b.rule > 0 /\ ~deny[Rcpt[i]]
    /\ GrantAlways(Payer[i], Rcpt[i])
    /\ NameIfUnknown(Rcpt[i])
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, deny, dflt, on, archived, ledger, mem, chain, pool, seen, base, rin, bak,
                   frozen, funded, rpcUp, key, told, toldDeny>>

\* Deny, per wallet, sweeps every agent payment to that recipient not yet past the
\* burn point (C9). The owner's own Send is owner authority and is not swept (H-106).
Swept(r) == {j \in Intents : Rcpt[j] = r /\ Payer[j] # Owner /\ st[j] \in {"Waiting", "Queued"}}

SetDeny(r) ==
    /\ deny' = [deny EXCEPT ![r] = TRUE]
    /\ always' = [always EXCEPT ![r] = {}]
    /\ Refuse(Swept(r))
    /\ queue' = SelectSeq(queue, LAMBDA x : x \notin Swept(r))
    /\ toldDeny' = toldDeny \cup {r}

NeverPay(i) ==
    /\ st[i] = "Waiting" /\ Payer[i] # Owner /\ b.rule > 0
    /\ SetDeny(Rcpt[i])
    /\ NameIfUnknown(Rcpt[i])
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, appr, dflt, on, archived, ledger, mem, chain, pool, seen, base, rin, bak,
                   frozen, funded, rpcUp, key>>

-----------------------------------------------------------------------------
\* The owner's Recipients list and the wallet's settings (versioned acts, C8, are
\* atomic commits here).

ListDeny(r) ==
    /\ b.rule > 0 /\ ~deny[r]
    /\ SetDeny(r)
    /\ label' = [label EXCEPT ![r] = IF @ = None THEN "L1" ELSE @]
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, appr, dflt, on, archived, ledger, mem, chain, pool, seen, base, rin, bak,
                   frozen, funded, rpcUp, key>>

ListAlways(r, a) ==
    /\ b.rule > 0 /\ a \notin always[r] /\ ~deny[r]
    /\ GrantAlways(a, r)
    /\ label' = [label EXCEPT ![r] = IF @ = None THEN "L1" ELSE @]
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, deny, dflt, on, archived, ledger, mem, chain, pool, seen, base, rin, bak,
                   frozen, funded, rpcUp, key, told, toldDeny>>

\* Back to Ask: Always and Deny cleared; a queued Always payment meets Ask at its start commit.
ListAsk(r) ==
    /\ b.rule > 0 /\ label[r] # None /\ (deny[r] \/ always[r] # {})
    /\ deny' = [deny EXCEPT ![r] = FALSE]
    /\ always' = [always EXCEPT ![r] = {}]
    /\ toldDeny' = toldDeny \ {r}
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, dflt, on, archived, queue, ledger, mem, chain, pool, seen,
                   base, rin, bak, frozen, funded, rpcUp, key, told>>

\* Forget: the recipient is unknown again; its rules go (H-088).
Forget(r) ==
    /\ b.rule > 0 /\ label[r] # None
    /\ label' = [label EXCEPT ![r] = None]
    /\ deny' = [deny EXCEPT ![r] = FALSE]
    /\ always' = [always EXCEPT ![r] = {}]
    /\ toldDeny' = toldDeny \ {r}
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, dflt, on, archived, queue, ledger, mem, chain, pool, seen, base,
                   rin, bak, frozen, funded, rpcUp, key, told>>

\* Rename: a label only, never the identity a rule binds (requirement 4).
Rename(r, l) ==
    /\ label[r] # None /\ l # label[r] /\ l # None
    /\ label' = [label EXCEPT ![r] = l]
    /\ Persist("rule")
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

\* The default for unknown recipients (a host-only act). It applies from the next
\* admission and at every start commit; it never refuses a card already shown.
\* The wallet's default for unknown recipients (OD-13). Turning it to Deny refuses, in
\* its commit, every open ask of an agent to a recipient nobody named (C9); a queued
\* one meets the default at its start commit (C4).
SetDefault ==
    /\ b.rule > 0
    /\ dflt' = IF dflt = "Ask" THEN "Deny" ELSE "Ask"
    /\ IF dflt = "Ask"
       THEN Refuse({j \in Intents : Payer[j] # Owner /\ st[j] = "Waiting" /\ label[Rcpt[j]] = None})
       ELSE UNCHANGED <<st, told>>
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, toldDeny>>

\* The owner takes the wallet away from an agent: its cards are answered Not paid
\* at once; what it has queued is refused by the start commit (C4).
SwitchOff(a) ==
    /\ b.access > 0 /\ on[a]
    /\ on' = [on EXCEPT ![a] = FALSE]
    /\ Refuse({j \in Intents : Payer[j] = a /\ st[j] = "Waiting"})
    /\ b' = [b EXCEPT !.access = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, toldDeny>>

SwitchOn(a) ==
    /\ b.access > 0 /\ ~on[a] /\ ~archived
    /\ on' = [on EXCEPT ![a] = TRUE]
    /\ b' = [b EXCEPT !.access = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny>>

\* Archive: the wallet pays nothing more; what is past the burn point finishes.
Archive ==
    /\ b.access > 0 /\ ~archived
    /\ archived' = TRUE
    /\ Refuse({j \in Intents : st[j] = "Waiting"})
    /\ b' = [b EXCEPT !.access = @ - 1]
    /\ Persist("rule")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, queue, ledger, mem, chain, pool, seen,
                   base, rin, bak, frozen, funded, rpcUp, key, toldDeny>>

\* The owner cancels the chat's run (C13). Before the burn point it refuses; past it,
\* only the bug configuration lets it report "refused".
Cancel(i) ==
    /\ b.cancel > 0
    /\ \/ st[i] \in {"Waiting", "Queued"}
       \/ (~LaneOwnsOutcome /\ st[i] \in InFlight)
    /\ Refuse({i})
    /\ queue' = Remove(queue, i)
    /\ b' = [b EXCEPT !.cancel = @ - 1]
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, ledger, mem, chain, pool, seen,
                   base, rin, bak, frozen, funded, rpcUp, key, toldDeny>>

\* Deadline (C10, OD-10): a Waiting payment nobody answers is Not paid, and so is a
\* Queued one the lane cannot start (keychain locked, lease lost).
Deadline(i) ==
    /\ \/ st[i] = "Waiting"
       \/ (PreBurnDeadline /\ st[i] = "Queued")
    /\ st' = [st EXCEPT ![i] = "NotPaid"]
    /\ told' = told \cup {i}
    /\ queue' = Remove(queue, i)
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, ledger, mem, chain, pool, seen,
                   base, rin, bak, frozen, funded, rpcUp, key, toldDeny, b>>

Fund ==
    /\ b.fund > 0
    /\ funded' = funded + 1
    /\ b' = [b EXCEPT !.fund = @ - 1]
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   pool, seen, base, rin, dur, bak, frozen, rpcUp, key, told, toldDeny>>

\* Liveness assumption only (OwnerActs): the owner tops up a payment stuck for funds.
OwnerTopUp ==
    /\ OwnerActs
    /\ \E i \in Intents :
         /\ st[i] = "Sent" /\ nonce[i] = Len(chain) /\ cx[i] = 0 /\ Balance < Amt[i]
         /\ funded' = funded + (Amt[i] - Balance)
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   pool, seen, base, rin, dur, bak, frozen, rpcUp, key, told, toldDeny, b>>

-----------------------------------------------------------------------------
\* The lane (C2, C4, C5, C6). One payment in flight until Included (C5).

LaneFree == \A j \in Intents : st[j] \notin InFlight

\* The signer reads and proves the key and signs in its own memory. Nothing is
\* committed. Blocked while the chain's count is above the ledger (C5) until
\* RaiseLedger explains it at finalized, and while a restored lane is frozen.
Sign ==
    /\ queue # <<>> /\ mem = <<>> /\ LaneFree /\ ~frozen
    /\ key = "ok" /\ rpcUp
    /\ Len(chain) <= ledger
    /\ LET i == Head(queue) IN
         /\ st[i] = "Queued"
         /\ mem' = <<i, ledger>>
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, chain, pool,
                   seen, base, rin, dur, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

Commit(i, n) ==
    /\ st' = [st EXCEPT ![i] = "Signed"]
    /\ nonce' = [nonce EXCEPT ![i] = n]
    /\ nvers' = [nvers EXCEPT ![i] = 1]
    /\ cx' = [cx EXCEPT ![i] = 0]
    /\ ledger' = n + 1
    /\ queue' = Remove(queue, i)
    /\ Persist("start")
    /\ UNCHANGED told

RefuseAtStart(i) ==
    /\ Refuse({i}) /\ queue' = Remove(queue, i)
    /\ Persist("start")
    /\ UNCHANGED <<nonce, nvers, cx, ledger>>

\* What the start commit re-checks. Without RecheckAccess it re-checks only the
\* recipient's Deny and Always by identity (the design before finding 23).
AccessAtStart(i) == ~RecheckAccess \/ Access(Payer[i])
DenyAtStart(i) == IF RecheckAccess THEN EffRule(Payer[i], Rcpt[i]) = "Deny" ELSE deny[Rcpt[i]]
BasisAtStart(i) == \/ Payer[i] = Owner \/ appr[i]
                   \/ IF RecheckAccess THEN EffRule(Payer[i], Rcpt[i]) = "Always" ELSE Payer[i] \in always[Rcpt[i]]

\* The fused start commit: the burn point (C4).
StartCommit ==
    /\ mem # <<>>
    /\ LET i == mem[1]
           n == mem[2]
       IN
       /\ mem' = <<>>
       /\ IF ~RecheckAtStart
          THEN Commit(i, n)
          ELSE CASE st[i] # "Queued" \/ n # ledger ->     \* refused or aged out meanwhile, or the ledger
                      UNCHANGED <<st, nonce, nvers, cx, ledger, queue, dur, told>>  \* moved (F-3): drop the bytes
                 [] ~AccessAtStart(i) -> RefuseAtStart(i)     \* switched off or archived meanwhile
                 [] Payer[i] # Owner /\ DenyAtStart(i) -> RefuseAtStart(i)   \* a Deny (or default Deny) meanwhile
                 [] ~BasisAtStart(i) ->                  \* Always revoked or forgotten: ask again
                      /\ st' = [st EXCEPT ![i] = "Waiting"] /\ queue' = Remove(queue, i)
                      /\ Persist("start")
                      /\ UNCHANGED <<nonce, nvers, cx, ledger, told>>
                 [] OTHER -> \E k \in Readings :         \* the balance at the block read (C11)
                      IF AvailAt(i, k) >= Amt[i] THEN Commit(i, n) ELSE RefuseAtStart(i)
    /\ UNCHANGED <<appr, label, deny, always, dflt, on, archived, chain, pool, seen, base, rin, bak, frozen,
                   funded, rpcUp, key, toldDeny, b>>

Versions(i) == {<<nonce[i], i, v, IF v = cx[i] THEN "cancel" ELSE "pay">> : v \in 1..nvers[i]}

\* Broadcast only committed bytes, every version of the in-flight nonce (C6).
Broadcast(i) ==
    /\ st[i] \in InFlight /\ rpcUp
    /\ \/ st[i] = "Signed"
       \/ (nonce[i] >= Len(chain) /\ ~(Versions(i) \subseteq pool))
    /\ pool' = IF nonce[i] >= Len(chain) THEN pool \cup Versions(i) ELSE pool
    /\ seen' = seen \cup Versions(i)
    /\ st' = [st EXCEPT ![i] = "Sent"]
    /\ Persist("track")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, base,
                   rin, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

\* A fee bump appends a version of the same nonce at a higher fee, committed (a
\* version commit) before it is sent (C6). It needs the key.
Bump(i) ==
    /\ st[i] = "Sent" /\ b.bump > 0 /\ key = "ok" /\ cx[i] = 0
    /\ nvers' = [nvers EXCEPT ![i] = @ + 1]
    /\ b' = [b EXCEPT !.bump = @ - 1]
    /\ Persist("version")
    /\ UNCHANGED <<st, nonce, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny>>

\* The owner cancels a sent payment: a replacement at the same nonce that pays
\* nothing (to the wallet itself) at a higher fee, a version commit like a bump.
CancelReplace(i) ==
    /\ st[i] = "Sent" /\ b.cancelr > 0 /\ key = "ok" /\ cx[i] = 0
    /\ nvers' = [nvers EXCEPT ![i] = @ + 1]
    /\ cx' = [cx EXCEPT ![i] = nvers[i] + 1]
    /\ b' = [b EXCEPT !.cancelr = @ - 1]
    /\ Persist("version")
    /\ UNCHANGED <<st, nonce, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny>>

\* A block at the payment's nonce is its own if it carries a version the store holds
\* (the hash of a stored version), or, with DecodeForeign, if it decodes to this
\* payment (same signer, recipient, value, data). Anything else there is foreign.
Own(i, blk) == blk.tag = i /\ (blk.ver <= nvers[i] \/ DecodeForeign)

Readmit(i) ==
    /\ st' = [st EXCEPT ![i] = "Waiting"]      \* the owner approves again, told what happened
    /\ nonce' = [nonce EXCEPT ![i] = -1]
    /\ nvers' = [nvers EXCEPT ![i] = 0]
    /\ cx' = [cx EXCEPT ![i] = 0]
    /\ appr' = [appr EXCEPT ![i] = FALSE]

\* Receipt tracking by the follower (C12, C13), or the foreign use of the nonce (C7).
Track(i) ==
    /\ st[i] = "Sent" /\ rpcUp /\ nonce[i] < Len(chain)
    /\ LET blk == BlockOf(i) IN
       \/ /\ Own(i, blk)
          /\ st' = [st EXCEPT ![i] = "Included"]
          /\ nvers' = [nvers EXCEPT ![i] = Max(@, blk.ver)]
          /\ cx' = [cx EXCEPT ![i] = IF blk.kind = "cancel" THEN blk.ver ELSE @]
          /\ UNCHANGED <<nonce, appr>>
       \/ /\ ~Own(i, blk) /\ (blk.fin \/ ~ReadmitAtFinal)
          /\ Readmit(i)
    /\ Persist("track")
    /\ UNCHANGED <<label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool, seen, base, rin, bak,
                   frozen, funded, rpcUp, key, told, toldDeny, b>>

\* What an RPC claims without the check of VerifyRpc: a foreign tx at the nonce, or a
\* status 0, that the chain does not hold.
LieForeign(i) ==
    /\ ~VerifyRpc /\ b.lie > 0 /\ st[i] = "Sent"
    /\ Readmit(i)
    /\ b' = [b EXCEPT !.lie = @ - 1]
    /\ Persist("track")
    /\ UNCHANGED <<label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool, seen, base, rin, bak,
                   frozen, funded, rpcUp, key, told, toldDeny>>

LieStatus0(i) ==
    /\ ~VerifyRpc /\ b.lie > 0 /\ st[i] \in {"Sent", "Included"}
    /\ st' = [st EXCEPT ![i] = "Failed"]
    /\ b' = [b EXCEPT !.lie = @ - 1]
    /\ Persist("track")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny>>

\* Confirmed and Cancelled only at finalized; Failed only at finalized (FailAtFinal).
Settle(i) ==
    /\ st[i] = "Included" /\ rpcUp
    /\ LET blk == BlockOf(i) IN
       \/ (blk.kind = "pay" /\ blk.ok /\ blk.fin /\ st' = [st EXCEPT ![i] = "Confirmed"])
       \/ (blk.kind = "pay" /\ ~blk.ok /\ (blk.fin \/ ~FailAtFinal) /\ st' = [st EXCEPT ![i] = "Failed"])
       \/ (blk.kind = "cancel" /\ blk.fin /\ st' = [st EXCEPT ![i] = "Cancelled"])
    /\ Persist("track")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

\* C5: the ledger is raised to the chain's count only once every block above it is
\* finalized (the store holds no hash for them, so they are foreign).
RaiseLedger ==
    /\ Len(chain) > ledger
    /\ \A k \in (ledger + 1)..Len(chain) : chain[k].fin
    /\ ledger' = Len(chain)
    /\ Persist("ledger")
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, mem, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

\* A later checkpoint syncs what an unsynced mode left in memory.
Flush ==
    /\ dur # <<>> /\ dur' = <<>>
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   pool, seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

-----------------------------------------------------------------------------
\* The chain and the external spender.

\* A transaction is included only if the balance covers it and, for an own one, its
\* fee meets the base fee; an underfunded or underpriced one stays in the pool. A
\* payment may revert (status 0: a paused token, a blacklisted recipient).
Minable(tx) == /\ Balance >= TxAmt(tx[2], tx[4])
               /\ tx[2] = Foreign \/ tx[3] >= base

Mine ==
    \E tx \in pool :
       /\ tx[1] = Len(chain) /\ Minable(tx)
       /\ \E rev \in (IF b.revert > 0 /\ tx[2] # Foreign /\ tx[4] = "pay" THEN BOOLEAN ELSE {FALSE}) :
            /\ chain' = Append(chain, [tag |-> tx[2], ver |-> tx[3], kind |-> tx[4], ok |-> ~rev, fin |-> FALSE])
            /\ b' = IF rev THEN [b EXCEPT !.revert = @ - 1] ELSE b
       /\ pool' = {t \in pool : t[1] > tx[1]}
       /\ rin' = rin \ {tx[1]}
       /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, seen,
                      base, dur, bak, frozen, funded, rpcUp, key, told, toldDeny>>

BaseRise ==
    /\ b.base > 0
    /\ base' = base + 1
    /\ b' = [b EXCEPT !.base = @ - 1]
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   pool, seen, rin, dur, bak, frozen, funded, rpcUp, key, told, toldDeny>>

Finalize ==
    /\ \E k \in 1..Len(chain) : ~chain[k].fin
    /\ LET k == CHOOSE k \in 1..Len(chain) : ~chain[k].fin /\ \A j \in 1..(k - 1) : chain[j].fin
       IN chain' = [chain EXCEPT ![k].fin = TRUE]
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, pool,
                   seen, base, rin, dur, bak, frozen, funded, rpcUp, key, told, toldDeny, b>>

\* A reorg drops the newest unfinalized block. Every version ever broadcast at that
\* nonce is still in some peer's pool (worst case); the foreign one may or may not be.
Reorg ==
    /\ b.reorg > 0 /\ Len(chain) > 0 /\ ~chain[Len(chain)].fin
    /\ LET k == Len(chain) - 1
           back == {i \in Intents : nonce[i] = k /\ st[i] \in {"Sent", "Included"}}
       IN \E keepF \in BOOLEAN :
         /\ chain' = SubSeq(chain, 1, k)
         /\ pool' = pool \cup {t \in seen : t[1] = k /\ (t[2] # Foreign \/ keepF)}
         /\ st' = [i \in Intents |-> IF i \in back THEN "Sent" ELSE st[i]]
         /\ rin' = IF back # {} THEN rin \cup {k} ELSE rin
    /\ b' = [b EXCEPT !.reorg = @ - 1]
    /\ Persist("track")
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, seen, base,
                   bak, frozen, funded, rpcUp, key, told, toldDeny>>

\* The exported key spends once, at the chain's next nonce, through another RPC.
ForeignSpend ==
    /\ b.foreign > 0
    /\ LET tx == <<Len(chain), Foreign, 1, "pay">> IN
       /\ pool' = pool \cup {tx}
       /\ seen' = seen \cup {tx}
    /\ b' = [b EXCEPT !.foreign = @ - 1]
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   base, rin, dur, bak, frozen, funded, rpcUp, key, told, toldDeny>>

-----------------------------------------------------------------------------
\* Environment faults.

Outage == b.outage > 0 /\ rpcUp /\ rpcUp' = FALSE /\ b' = [b EXCEPT !.outage = @ - 1]
          /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem,
                         chain, pool, seen, base, rin, dur, bak, frozen, funded, key, told, toldDeny>>
Recover == ~rpcUp /\ rpcUp' = TRUE
          /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem,
                         chain, pool, seen, base, rin, dur, bak, frozen, funded, key, told, toldDeny, b>>

\* The keychain locks (sleep, auto-lock) or loses the item (reset, migration).
KeyFault == b.keyf > 0 /\ key = "ok" /\ key' \in {"locked", "missing"} /\ b' = [b EXCEPT !.keyf = @ - 1]
          /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem,
                         chain, pool, seen, base, rin, dur, bak, frozen, funded, rpcUp, told, toldDeny>>
\* The owner unlocks, or restores the key that derives this address (C16).
KeyBack == key # "ok" /\ key' = "ok"
          /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem,
                         chain, pool, seen, base, rin, dur, bak, frozen, funded, rpcUp, told, toldDeny, b>>

\* A process crash: memory lost (the signer's bytes), every commit that returned kept.
\* With LaneOwnsOutcome off, the tool's rerun reports "did not run" for a payment whose
\* recipient was denied meanwhile (the banda-integration spike's bug).
Crash ==
    /\ b.crash > 0
    /\ mem' = <<>>
    /\ LET bad == IF LaneOwnsOutcome THEN {}
                  ELSE {i \in Intents : st[i] \in InFlight /\ Payer[i] # Owner /\ deny[Rcpt[i]]}
       IN /\ Refuse(bad)
          /\ IF bad = {} THEN UNCHANGED dur ELSE Persist("admit")
    /\ b' = [b EXCEPT !.crash = @ - 1]
    /\ UNCHANGED <<nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, chain, pool,
                   seen, base, rin, bak, frozen, funded, rpcUp, key, toldDeny>>

\* Power loss: memory lost and the store goes back to what is on disk. Under the
\* design (Sync = "all") the disk holds every commit that returned: a crash.
PowerLoss ==
    /\ b.pl > 0
    /\ IF dur = <<>>
       THEN UNCHANGED storeVars
       ELSE /\ st' = dur.st /\ nonce' = dur.nonce /\ nvers' = dur.nvers /\ cx' = dur.cx /\ appr' = dur.appr
            /\ label' = dur.label /\ deny' = dur.deny /\ always' = dur.always /\ dflt' = dur.dflt
            /\ on' = dur.on /\ archived' = dur.archived /\ queue' = dur.queue /\ ledger' = dur.ledger
    /\ mem' = <<>> /\ dur' = <<>>
    /\ b' = [b EXCEPT !.pl = @ - 1]
    /\ UNCHANGED <<chain, pool, seen, base, rin, bak, frozen, funded, rpcUp, key, told, toldDeny>>

\* A backup of the home (a copy of the store), restored later over the live one (C16).
\* Unstarted payments of the backup are Restored, never resumed: they may have been
\* paid since. Started ones are tracked again against the chain. The lane is frozen
\* until the owner has reviewed the restored rules and the chain's history.
Backup ==
    /\ b.restore > 0 /\ bak = <<>>
    /\ bak' = Store
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   pool, seen, base, rin, dur, frozen, funded, rpcUp, key, told, toldDeny, b>>

RestoredSt(i) ==
    LET s == bak.st[i] IN
    IF s = "Idle" THEN (IF st[i] = "Idle" THEN "Idle" ELSE "Restored")
    ELSE IF s \in {"Waiting", "Queued"} THEN (IF ResumeRestored THEN s ELSE "Restored")
    ELSE IF s = "Included" THEN "Sent"
    ELSE s

Restore ==
    /\ b.restore > 0 /\ bak # <<>>
    /\ st' = [i \in Intents |-> RestoredSt(i)]
    /\ nonce' = bak.nonce /\ nvers' = bak.nvers /\ cx' = bak.cx /\ appr' = bak.appr
    /\ label' = bak.label /\ deny' = bak.deny /\ always' = bak.always /\ dflt' = bak.dflt
    /\ on' = bak.on /\ archived' = bak.archived /\ ledger' = bak.ledger
    /\ queue' = IF ResumeRestored THEN bak.queue ELSE <<>>
    /\ frozen' = TRUE
    /\ mem' = <<>> /\ dur' = <<>>
    /\ toldDeny' = {r \in Recipients : bak.deny[r]}   \* the owner reviews the restored rules
    /\ b' = [b EXCEPT !.restore = @ - 1]
    /\ UNCHANGED <<chain, pool, seen, base, rin, bak, funded, rpcUp, key, told>>

Unfreeze ==
    /\ frozen /\ frozen' = FALSE
    /\ UNCHANGED <<st, nonce, nvers, cx, appr, label, deny, always, dflt, on, archived, queue, ledger, mem, chain,
                   pool, seen, base, rin, dur, bak, funded, rpcUp, key, told, toldDeny, b>>

\* The run ends here (not a deadlock): every payment is terminal, or the lane waits
\* on the owner (a sent payment no block can include until the owner funds it).
LaneStuck == \E i \in Intents : st[i] = "Sent" /\ nonce[i] >= Len(chain)
                                /\ ~\E tx \in pool : tx[1] = Len(chain) /\ Minable(tx)
Quiesce == ((\A i \in Intents : st[i] \in Terminal) \/ LaneStuck) /\ UNCHANGED vars

-----------------------------------------------------------------------------
Owners ==
    \/ \E i \in Intents : Pay(i) \/ DontPay(i) \/ AlwaysPay(i) \/ NeverPay(i) \/ Cancel(i) \/ CancelReplace(i)
    \/ \E r \in Recipients : ListDeny(r) \/ ListAsk(r) \/ Forget(r)
    \/ \E r \in Recipients, a \in Agents : ListAlways(r, a)
    \/ \E r \in Recipients, l \in Labels : Rename(r, l)
    \/ \E a \in Agents : SwitchOff(a) \/ SwitchOn(a)
    \/ SetDefault \/ Archive \/ Fund \/ KeyBack \/ OwnerTopUp \/ Backup \/ Restore \/ Unfreeze

Lane ==
    \/ Sign \/ StartCommit \/ RaiseLedger \/ Flush
    \/ \E i \in Intents : Broadcast(i) \/ Bump(i) \/ Track(i) \/ Settle(i) \/ LieForeign(i) \/ LieStatus0(i)

Env == Mine \/ BaseRise \/ Finalize \/ Reorg \/ ForeignSpend \/ Outage \/ Recover \/ KeyFault \/ Crash
       \/ PowerLoss \/ Quiesce

Next ==
    \/ \E i \in Intents : Call(i) \/ Deadline(i)
    \/ Owners \/ Lane \/ Env

\* The lane bumps a payment the base fee has priced out.
FeeBump(i) == Bump(i) /\ nvers[i] < base

Fairness ==
    /\ WF_vars(Sign) /\ WF_vars(StartCommit) /\ WF_vars(RaiseLedger) /\ WF_vars(Flush)
    /\ \A i \in Intents : WF_vars(Broadcast(i)) /\ WF_vars(Track(i)) /\ WF_vars(Settle(i)) /\ WF_vars(Deadline(i))
                          /\ WF_vars(FeeBump(i))
    /\ WF_vars(Mine) /\ WF_vars(Finalize) /\ WF_vars(Recover)
    /\ IF OwnerActs THEN WF_vars(KeyBack) /\ WF_vars(OwnerTopUp) /\ WF_vars(Unfreeze) ELSE TRUE

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
\* Safety invariants (state).

TypeOK ==
    /\ st \in [Intents -> States]
    /\ nonce \in [Intents -> -1..10]
    /\ ledger \in 0..10
    /\ dflt \in {"Ask", "Deny"}
    /\ \A r \in Recipients : always[r] \subseteq Agents
    /\ told \subseteq Intents /\ toldDeny \subseteq Recipients

\* I1: at most one transaction of a payment is ever on chain.
AtMostOnePaid == \A i \in Intents : Cardinality({k \in 1..Len(chain) : chain[k].tag = i}) <= 1

\* I3: nothing reported refused or not paid is on chain.
RefusedNeverPaid == \A i \in Intents : st[i] \in {"Refused", "NotPaid"} => ~OnChain(i)

\* A refusal or Not paid the caller was told is never undone: that payment is never
\* started (power loss may not take back an answer that was given).
AckedNeverStarts == \A i \in told : ~OnChain(i) /\ st[i] \notin InFlight

\* I4: what is reported is what the chain says.
ReportedIsTrue ==
    \A i \in Intents :
        LET here == nonce[i] >= 0 /\ nonce[i] < Len(chain) /\ BlockOf(i).tag = i IN
        /\ st[i] = "Included" => here
        /\ st[i] = "Confirmed" => (here /\ BlockOf(i).kind = "pay" /\ BlockOf(i).ok /\ BlockOf(i).fin)
        /\ st[i] = "Failed" => (here /\ BlockOf(i).kind = "pay" /\ ~BlockOf(i).ok)
        /\ st[i] = "Cancelled" => (here /\ BlockOf(i).kind = "cancel" /\ BlockOf(i).fin)

\* I7: no two payments hold one (wallet, network, nonce); versions of one share it.
UniqueNonce == \A i, j \in Intents : (i # j /\ nonce[i] >= 0) => nonce[i] # nonce[j]

\* I5: no nonce below the ledger is neither held by a stored payment nor used on chain.
NoGap == \A k \in 0..(ledger - 1) : (\E i \in Intents : nonce[i] = k) \/ k < Len(chain)

\* Own nonces sit below the ledger.
OwnBelowLedger == \A i \in Intents : nonce[i] < ledger

\* I8: of the in-flight nonces not yet on chain, one at a time, plus one for each
\* nonce a reorg put back while a later one was in flight (rin), and always
\* consecutive from the chain's count (so nothing waits on a gap).
OneInFlight ==
    LET pend == {nonce[i] : i \in {j \in Intents : st[j] \in InFlight}} \ (0..(Len(chain) - 1))
        n == Cardinality(pend)
    IN pend # {} => (pend = Len(chain)..(Len(chain) + n - 1) /\ n <= 1 + Cardinality(pend \cap rin))

\* Total spent never exceeds total funded (the chain's rule, kept as a sanity check).
SpentWithinFunded == Spent <= funded

Safety == TypeOK /\ AtMostOnePaid /\ RefusedNeverPaid /\ AckedNeverStarts /\ ReportedIsTrue /\ UniqueNonce
          /\ NoGap /\ OwnBelowLedger /\ OneInFlight /\ SpentWithinFunded

-----------------------------------------------------------------------------
\* Safety properties (actions): checked on every step. Steps of a power loss or a
\* restore move the store back by design and are exempt where they would trip.

Rewind == b'.pl # b.pl \/ b'.restore # b.restore
Started(i) == ~Rewind /\ st[i] # "Signed" /\ st'[i] = "Signed"

\* No payment is started (signed, committed, so broadcastable) unless the owner sent
\* it from a live wallet, or its agent has access and its recipient's rule was Always
\* for that agent or the owner approved it, and never while the recipient is denied
\* (by its rule or by the default): all checked in the start commit.
StartBasis == [][\A i \in Intents : Started(i) => StartOK(i)]_vars

\* A Deny the owner saw committed holds: nothing to that recipient starts while it stands.
AckedDenyHolds == [][\A i \in Intents : (Started(i) /\ Payer[i] # Owner) => Rcpt[i] \notin toldDeny]_vars

\* C11: without an external spend no payment starts that the balance, less what is
\* in flight and not yet on chain, cannot cover.
TrueAvail(i) == Balance - SumSet({j \in Intents \ {i} : st[j] \in InFlight /\ ~OnChain(j)})
UnderfundedNeverStarts == [][\A i \in Intents :
    (Started(i) /\ b.foreign = MaxForeign) => TrueAvail(i) >= Amt[i]]_vars

\* Deny never pays: a call to a denied recipient is refused at admission, and nothing
\* is started while the recipient is denied (StartBasis). A Deny set after the burn
\* point lets that one payment finish (C13); it applies from the next one.
DenyRefusesCall == [][Rewind \/ \A i \in Intents :
    (st[i] = "Idle" /\ st'[i] # "Idle" /\ Payer[i] # Owner /\ deny[Rcpt[i]]) => st'[i] = "Refused"]_vars

\* An agent payment is admitted without asking only under its recipient's own Always
\* (identity, never label: C18, H-077, H-091 for the per-agent scope), with access.
AdmitByIdentity == [][Rewind \/ \A i \in Intents :
    (st[i] = "Idle" /\ st'[i] = "Queued" /\ Payer[i] # Owner) =>
        (Payer[i] \in always[Rcpt[i]] /\ ~deny[Rcpt[i]] /\ Access(Payer[i]))]_vars

\* The converse (C3): Always never asks. A call under Always is queued or refused,
\* never shown as a card, and a queued payment goes back to asking only when its
\* Always (and any approval) is gone.
AlwaysNeverAsks == [][Rewind \/ \A i \in Intents :
    /\ (st[i] = "Idle" /\ st'[i] = "Waiting" /\ Payer[i] # Owner) => EffRuleId(Payer[i], Rcpt[i]) # "Always"
    /\ (st[i] = "Queued" /\ st'[i] = "Waiting") =>
           ~appr[i] /\ ~(Payer[i] \in always[Rcpt[i]] /\ ~deny[Rcpt[i]])]_vars

\* A renamed recipient keeps its rule.
RenameKeepsRule == [][\A r \in Recipients :
    (label[r] # None /\ label'[r] # None /\ label'[r] # label[r]) => (deny'[r] = deny[r] /\ always'[r] = always[r])]_vars

\* The ledger never goes down (C5).
LedgerMonotone == [][Rewind \/ ledger' >= ledger]_vars

\* States move forward only along the table's edges (transitions.json, machine "payment").
Edges == {<<"Idle", "Refused">>, <<"Idle", "Waiting">>, <<"Idle", "Queued">>,
          <<"Waiting", "Queued">>, <<"Waiting", "Refused">>, <<"Waiting", "NotPaid">>,
          <<"Queued", "Waiting">>, <<"Queued", "Refused">>, <<"Queued", "NotPaid">>, <<"Queued", "Signed">>,
          <<"Signed", "Sent">>, <<"Sent", "Included">>, <<"Sent", "Waiting">>,
          <<"Included", "Sent">>, <<"Included", "Confirmed">>, <<"Included", "Failed">>,
          <<"Included", "Cancelled">>}
ForwardOnly == [][Rewind \/ \A i \in Intents : st'[i] # st[i] => <<st[i], st'[i]>> \in Edges]_vars

-----------------------------------------------------------------------------
\* Liveness: every admitted payment reaches a terminal state, given the RPC is
\* eventually available (bounded outages, Recover weakly fair), the chain keeps
\* mining and finalizing, the lane bumps a priced-out payment, and the faults are
\* bounded. The owner is not assumed to act unless OwnerActs: Waits end at their
\* deadline; a payment an external spend left underfunded waits on the owner.
Admitted(i) == st[i] # "Idle"
EveryAdmittedEnds == \A i \in Intents : Admitted(i) ~> (st[i] \in Terminal)

=============================================================================
