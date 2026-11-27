---------------------------- MODULE NonceAlloc ----------------------------
(***************************************************************************)
(* Nonce allocation for one (wallet, network), shared by every payer of    *)
(* that wallet: the agents, the owner's Send, and an external spender who  *)
(* holds the exported key and sends through another RPC.                   *)
(*                                                                         *)
(* Admission and rules are abstracted away (PaymentLane has them): an      *)
(* effect is already admitted when it enters the lane. What this module    *)
(* checks deeper than PaymentLane is the ledger itself: two external       *)
(* spends, two reorgs, two crashes, a fee bump, and power loss under each *)
(* durability mode (Sync): every wallet commit synced (the design), only   *)
(* effect commits, only start commits, or none.                            *)
(*                                                                         *)
(* Effect states: Queued, Signed, Sent, Included, Final (its block is      *)
(* finalized), Released (a finalized foreign transaction took its nonce:   *)
(* the effect leaves this machine and asks the owner again, C7).           *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Payer,                 \* per effect: "a1", "a2", "owner"
    MaxCrash, MaxReorg, MaxForeign, MaxBump, MaxPowerLoss,
    Sync,                  \* C21: which commits are synced before they return: "all" (the design), "effects"
                           \* (start and version commits), "start" (start commits only) or "none"
    ReadmitAtFinal,        \* C7
    RaiseAtFinal,          \* C5: the ledger is raised to the chain's count only at finalized
    NonceCAS               \* finding F-3: the start commit takes the signed nonce only if it is still the ledger

Effects == 1..Len(Payer)
Foreign == 0
InFlight == {"Signed", "Sent"}
Done == {"Final", "Released"}

VARIABLES st, nonce, nvers, arrival, queue, mem, ledger, chain, pool, seen,
    dur,   \* the store as it is on disk when the last commits are not yet synced (<<>>: on disk = in memory)
    rin,   \* ghost: nonces a reorg put back in flight while a later one was in flight (I8)
    b
vars == <<st, nonce, nvers, arrival, queue, mem, ledger, chain, pool, seen, dur, rin, b>>

\* Durability. A commit of a kind the mode does not sync leaves the disk where it was
\* (WAL: a power loss drops a suffix of commits); a synced commit syncs every commit
\* before it.
Store == [st |-> st, nonce |-> nonce, nvers |-> nvers, queue |-> queue, ledger |-> ledger]
Synced(kind) == \/ Sync = "all"
                \/ Sync = "effects" /\ kind \in {"start", "version"}
                \/ Sync = "start" /\ kind = "start"
Persist(kind) == dur' = IF Synced(kind) THEN <<>> ELSE IF dur = <<>> THEN Store ELSE dur

Remove(q, i) == SelectSeq(q, LAMBDA x : x # i)
BlockOf(i) == chain[nonce[i] + 1]
Versions(i) == {<<nonce[i], i, v>> : v \in 1..nvers[i]}

Init ==
    /\ st = [i \in Effects |-> "Idle"]
    /\ nonce = [i \in Effects |-> -1]
    /\ nvers = [i \in Effects |-> 0]
    /\ arrival = <<>>          \* the order effects entered the lane (ghost, for FIFO)
    /\ queue = <<>>
    /\ mem = <<>>
    /\ ledger = 0
    /\ chain = <<>>
    /\ pool = {}
    /\ seen = {}
    /\ dur = <<>>
    /\ rin = {}
    /\ b = [crash |-> MaxCrash, reorg |-> MaxReorg, foreign |-> MaxForeign, bump |-> MaxBump, readmit |-> MaxForeign + MaxPowerLoss,
            pl |-> MaxPowerLoss]

\* A payer's admitted effect enters the lane, in queue-commit order (C2).
Enqueue(i) ==
    /\ st[i] = "Idle"
    /\ st' = [st EXCEPT ![i] = "Queued"]
    /\ queue' = Append(queue, i)
    /\ arrival' = Append(arrival, i)
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, nvers, mem, ledger, chain, pool, seen, rin, b>>

LaneFree == \A j \in Effects : st[j] \notin InFlight

Sign ==
    /\ queue # <<>> /\ mem = <<>> /\ LaneFree
    /\ Len(chain) <= ledger
    /\ mem' = <<Head(queue), ledger>>
    /\ UNCHANGED <<st, nonce, nvers, arrival, queue, ledger, chain, pool, seen, dur, rin, b>>

StartCommit ==
    /\ mem # <<>>
    /\ LET i == mem[1]
           n == mem[2]
       IN /\ st[i] = "Queued"
          /\ NonceCAS => n = ledger     \* else Redo drops the bytes and the lane signs again
          /\ st' = [st EXCEPT ![i] = "Signed"]
          /\ nonce' = [nonce EXCEPT ![i] = n]
          /\ nvers' = [nvers EXCEPT ![i] = 1]
          /\ ledger' = n + 1
          /\ queue' = Remove(queue, i)
          /\ Persist("start")
    /\ mem' = <<>>
    /\ UNCHANGED <<arrival, chain, pool, seen, rin, b>>

\* The start commit finds the ledger moved since the signer read it (RaiseLedger
\* ran meanwhile): it commits nothing and drops the bytes (F-3).
Redo ==
    /\ NonceCAS /\ mem # <<>> /\ mem[2] # ledger
    /\ mem' = <<>>
    /\ UNCHANGED <<st, nonce, nvers, arrival, queue, ledger, chain, pool, seen, dur, rin, b>>

\* The owner approves again an effect whose nonce a finalized foreign transaction
\* took (C7); it re-enters the lane at its tail. Not fair: the owner may not.
Readmit(i) ==
    /\ st[i] = "Released" /\ b.readmit > 0
    /\ st' = [st EXCEPT ![i] = "Queued"]
    /\ nvers' = [nvers EXCEPT ![i] = 0]
    /\ queue' = Append(queue, i)
    /\ arrival' = Append(Remove(arrival, i), i)
    /\ b' = [b EXCEPT !.readmit = @ - 1]
    /\ Persist("admit")
    /\ UNCHANGED <<nonce, mem, ledger, chain, pool, seen, rin>>

\* Bytes leave only from a commit that returned; with Sync = "all" it is on disk.
Broadcast(i) ==
    /\ st[i] \in InFlight
    /\ \/ st[i] = "Signed"
       \/ (nonce[i] >= Len(chain) /\ ~(Versions(i) \subseteq pool))
    /\ pool' = IF nonce[i] >= Len(chain) THEN pool \cup Versions(i) ELSE pool
    /\ seen' = seen \cup Versions(i)
    /\ st' = [st EXCEPT ![i] = "Sent"]
    /\ UNCHANGED <<nonce, nvers, arrival, queue, mem, ledger, chain, dur, rin, b>>

\* A fee bump is a version commit: the new version is stored before it is sent (C6),
\* synced like every wallet commit (C21).
Bump(i) ==
    /\ st[i] = "Sent" /\ b.bump > 0
    /\ nvers' = [nvers EXCEPT ![i] = @ + 1]
    /\ b' = [b EXCEPT !.bump = @ - 1]
    /\ Persist("version")
    /\ UNCHANGED <<st, nonce, arrival, queue, mem, ledger, chain, pool, seen, rin>>

\* A block at the effect's nonce is its own only if it carries a version the store
\* holds (the hash of a stored version); any other transaction there is foreign.
Own(i, blk) == blk.tag = i /\ blk.ver <= nvers[i]
Track(i) ==
    /\ st[i] = "Sent" /\ nonce[i] < Len(chain)
    /\ LET blk == BlockOf(i) IN
       \/ (Own(i, blk) /\ st' = [st EXCEPT ![i] = "Included"] /\ UNCHANGED nonce)
       \/ /\ ~Own(i, blk) /\ (blk.fin \/ ~ReadmitAtFinal)
          /\ st' = [st EXCEPT ![i] = "Released"]
          /\ nonce' = [nonce EXCEPT ![i] = -1]
    /\ Persist("track")
    /\ UNCHANGED <<nvers, arrival, queue, mem, ledger, chain, pool, seen, rin, b>>

Finish(i) ==
    /\ st[i] = "Included" /\ BlockOf(i).fin
    /\ st' = [st EXCEPT ![i] = "Final"]
    /\ Persist("track")
    /\ UNCHANGED <<nonce, nvers, arrival, queue, mem, ledger, chain, pool, seen, rin, b>>

\* C5: raise the ledger past blocks the store holds no hash for, only once they are
\* finalized (RaiseAtFinal), or at latest (the bug the lane model found: H-171).
RaiseLedger ==
    /\ Len(chain) > ledger
    /\ RaiseAtFinal => \A k \in (ledger + 1)..Len(chain) : chain[k].fin
    /\ ledger' = Len(chain)
    /\ Persist("ledger")
    /\ UNCHANGED <<st, nonce, nvers, arrival, queue, mem, chain, pool, seen, rin, b>>

\* A later checkpoint syncs what an unsynced mode left in memory.
Flush == dur # <<>> /\ dur' = <<>>
         /\ UNCHANGED <<st, nonce, nvers, arrival, queue, mem, ledger, chain, pool, seen, rin, b>>

Mine ==
    \E tx \in pool :
       /\ tx[1] = Len(chain)
       /\ chain' = Append(chain, [tag |-> tx[2], ver |-> tx[3], fin |-> FALSE])
       /\ pool' = {t \in pool : t[1] > tx[1]}
       /\ rin' = rin \ {tx[1]}
       /\ UNCHANGED <<st, nonce, nvers, arrival, queue, mem, ledger, seen, dur, b>>

Finalize ==
    /\ \E k \in 1..Len(chain) : ~chain[k].fin
    /\ LET k == CHOOSE k \in 1..Len(chain) : ~chain[k].fin /\ \A j \in 1..(k - 1) : chain[j].fin
       IN chain' = [chain EXCEPT ![k].fin = TRUE]
    /\ UNCHANGED <<st, nonce, nvers, arrival, queue, mem, ledger, pool, seen, dur, rin, b>>

Reorg ==
    /\ b.reorg > 0 /\ Len(chain) > 0 /\ ~chain[Len(chain)].fin
    /\ LET k == Len(chain) - 1 IN
       \E keepF \in BOOLEAN :
         /\ chain' = SubSeq(chain, 1, k)
         /\ pool' = pool \cup {t \in seen : t[1] = k /\ (t[2] # Foreign \/ keepF)}
         /\ st' = [i \in Effects |-> IF nonce[i] = k /\ st[i] \in {"Sent", "Included"} THEN "Sent" ELSE st[i]]
         /\ rin' = IF \E i \in Effects : nonce[i] = k /\ st[i] \in {"Sent", "Included"} THEN rin \cup {k} ELSE rin
    /\ b' = [b EXCEPT !.reorg = @ - 1]
    /\ UNCHANGED <<nonce, nvers, arrival, queue, mem, ledger, seen, dur>>

\* The external spender sends at the chain's next nonce as its RPC sees it.
ForeignSpend ==
    /\ b.foreign > 0
    /\ LET tx == <<Len(chain), Foreign, b.foreign>> IN
       /\ pool' = pool \cup {tx}
       /\ seen' = seen \cup {tx}
    /\ b' = [b EXCEPT !.foreign = @ - 1]
    /\ UNCHANGED <<st, nonce, nvers, arrival, queue, mem, ledger, chain, dur, rin>>

\* A process crash: memory lost, every commit that returned kept.
Crash ==
    /\ b.crash > 0
    /\ mem' = <<>>
    /\ b' = [b EXCEPT !.crash = @ - 1]
    /\ UNCHANGED <<st, nonce, nvers, arrival, queue, ledger, chain, pool, seen, dur, rin>>

\* Power loss: memory lost and the store goes back to what is on disk. Under the
\* design (Sync = "all") the disk holds every commit that returned, so this is a crash.
PowerLoss ==
    /\ b.pl > 0
    /\ IF dur = <<>>
       THEN UNCHANGED <<st, nonce, nvers, queue, ledger, arrival>>
       ELSE /\ st' = dur.st /\ nonce' = dur.nonce /\ nvers' = dur.nvers
            /\ queue' = dur.queue /\ ledger' = dur.ledger
            /\ arrival' = SelectSeq(arrival, LAMBDA x : dur.st[x] # "Idle")
    /\ mem' = <<>> /\ dur' = <<>>
    /\ b' = [b EXCEPT !.pl = @ - 1]
    /\ UNCHANGED <<chain, pool, seen, rin>>

\* Every effect is done: the run ends here (not a deadlock).
Quiesce == (\A i \in Effects : st[i] \in Done) /\ UNCHANGED vars

Next ==
    \/ \E i \in Effects : Enqueue(i) \/ Broadcast(i) \/ Bump(i) \/ Track(i) \/ Finish(i) \/ Readmit(i)
    \/ Sign \/ StartCommit \/ Redo \/ RaiseLedger \/ Flush
    \/ Mine \/ Finalize \/ Reorg \/ ForeignSpend \/ Crash \/ PowerLoss \/ Quiesce

Fairness ==
    /\ WF_vars(Sign) /\ WF_vars(StartCommit) /\ WF_vars(Redo) /\ WF_vars(RaiseLedger) /\ WF_vars(Flush)
    /\ \A i \in Effects : WF_vars(Broadcast(i)) /\ WF_vars(Track(i)) /\ WF_vars(Finish(i))
    /\ WF_vars(Mine) /\ WF_vars(Finalize)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ st \in [Effects -> {"Idle", "Queued", "Signed", "Sent", "Included"} \cup Done]
          /\ ledger \in 0..20

\* At most one transaction of an effect on chain.
AtMostOnce == \A i \in Effects : Cardinality({k \in 1..Len(chain) : chain[k].tag = i}) <= 1
\* No two effects hold one nonce (versions of one effect share it).
UniqueNonce == \A i, j \in Effects : (i # j /\ nonce[i] >= 0) => nonce[i] # nonce[j]
\* No gap below the ledger.
NoGap == \A k \in 0..(ledger - 1) : (\E i \in Effects : nonce[i] = k) \/ k < Len(chain)
\* Own nonces sit below the ledger; the chain's own transactions sit at their nonce.
OwnBelowLedger == \A i \in Effects : nonce[i] < ledger
OnChainAtOwnNonce == \A k \in 1..Len(chain) : chain[k].tag # Foreign => nonce[chain[k].tag] = k - 1
\* I8: of the in-flight nonces not yet on chain, one at a time, plus one for each
\* nonce a reorg put back while a later one was in flight (rin), and always
\* consecutive from the chain's count (so nothing waits on a gap).
OneInFlight ==
    LET pend == {nonce[i] : i \in {j \in Effects : st[j] \in InFlight}} \ (0..(Len(chain) - 1))
        n == Cardinality(pend)
    IN pend # {} => (pend = Len(chain)..(Len(chain) + n - 1) /\ n <= 1 + Cardinality(pend \cap rin))

\* FIFO: among effects never released, nonces follow arrival order (C2).
Pos(i) == CHOOSE p \in 1..Len(arrival) : arrival[p] = i
FifoNonces == \A i, j \in Effects :
    (nonce[i] >= 0 /\ nonce[j] >= 0 /\ Pos(i) < Pos(j)) => nonce[i] < nonce[j]

LedgerMonotone == [][ledger' >= ledger]_vars

\* The ledger moves past the store's own nonces only at a start commit; past others
\* only when they are finalized.
RaiseOnlyFinal == [][(ledger' > ledger /\ nonce' = nonce) =>
                     \A k \in (ledger + 1)..ledger' : k <= Len(chain) /\ chain[k].fin]_vars

EveryEffectEnds == \A i \in Effects : (st[i] # "Idle") ~> (st[i] \in Done)
=============================================================================
