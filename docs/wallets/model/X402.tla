-------------------------------- MODULE X402 --------------------------------
(***************************************************************************)
(* An x402 payment from the proxy's observation of a 402 to settlement or  *)
(* expiry (wallets.md "x402"; hazards H-216 to H-251; conflicts.md C3,     *)
(* C11, C12, C14, C18, C19, C21; R-5, R-9).                                *)
(*                                                                         *)
(* The proxy records each 402 it saw as an observation bound to the chat   *)
(* whose box made the request, with its terms as received (endpoint and    *)
(* payTo: the rule key; the amount). The agent's tool names an observation *)
(* id, nothing else. Admission applies the rule: Deny per wallet on the    *)
(* endpoint key, Always per (agent, endpoint key), Ask for a known key and *)
(* the wallet's default for an unknown one. The authorization commit       *)
(* re-checks it and stores the EIP-3009 nonce (derived from the            *)
(* observation: R-5) and the message with a short window from chain time  *)
(* (C19); the signer signs in its memory, the header is given to the box  *)
(* and a commit records it was handed. The box (untrusted) may submit it   *)
(* any number of times; a facilitator includes it if the token has not     *)
(* seen the nonce, the block's time is before validBefore and the wallet   *)
(* holds the amount. The owner may cancel an authorization on chain, which *)
(* races the settlement. Reorgs, crashes and power loss under each         *)
(* durability mode.                                                        *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Chats, ChatAgent,      \* chats and the agent each belongs to
    ObsChat, ObsKey,       \* per observation: the chat whose box saw it; its endpoint key (endpoint + payTo)
    Amt,                   \* per observation: the amount required
    DefaultRule,           \* "Ask" or "Deny" for an endpoint key the owner has not answered
    InitBalance, W,        \* USDC in the wallet; the validity window in blocks (C19: at most 60 s)
    MaxHeight, MaxCrash, MaxPowerLoss, MaxReorg, MaxRuleChange, MaxCancel,
    DerivedNonce,          \* R-5: nonce = keccak256("banda/x402" || wallet || observation id)
    Sync,                  \* C21: "all" (every commit synced before it returns, the design) or "none"
    BindChat,              \* C18: an observation is paid only by the chat whose box saw it
    ExpireAtFinal,         \* C12: Expired only once the block at validBefore is finalized
    ObservedTerms,         \* C3/H-217: what is signed are the observation's terms, never the agent's
    ReserveLive,           \* C11: a live authorization is reserved until its event or expiry
    DenyPerWallet          \* C3/OD-1: Deny binds the endpoint key for every agent of the wallet

Obs == 1..Len(ObsChat)
EKeys == {ObsKey[o] : o \in Obs}
Agents == {ChatAgent[c] : c \in Chats}
Terminal == {"settled", "expired", "refused", "notpaid", "cancelled"}
Live == {"authorized", "handed"}
AgentOf(o) == ChatAgent[ObsChat[o]]
Observed(o) == <<ObsKey[o], Amt[o]>>
TermSpace == {<<k, a>> : k \in EKeys, a \in 1..2}

VARIABLES
    ost,       \* observation -> state
    onc,       \* observation -> the nonce its authorization carries (0: none)
    vb,        \* observation -> validBefore (block time)
    appr,      \* observation -> approved once by the owner
    terms,     \* observation -> the terms the pay call carries (<<>> until called)
    always,    \* set of <<agent, endpoint key>>
    deny,      \* set of <<"*", endpoint key>> (per wallet), or <<agent, key>> when DenyPerWallet is off
    known,     \* endpoint keys the owner has answered or listed
    dflt,      \* the default rule
    caller,    \* observation -> the chat whose agent called the pay tool ("none")
    nextN,     \* the next random nonce (DerivedNonce = FALSE): fresh randomness, never restored
    sig,       \* signer memory: observations signed and not yet given to the box
    box,       \* signed authorizations the box holds: <<o, nonce, vb, terms>> (survive any daemon crash)
    pending,   \* what facilitators were handed and not yet included: <<kind, o, nonce, vb, amount>>
    chain,     \* blocks: [ev: <<>> or <<kind, o, nonce, vb, amount>>, fin]; a block's time is its height
    dur,       \* the store as on disk while commits are unsynced (<<>>: on disk = in memory)
    b

storeVars == <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller>>
vars == <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, dur, b>>

Store == [ost |-> ost, onc |-> onc, vb |-> vb, appr |-> appr, terms |-> terms, always |-> always, deny |-> deny,
          known |-> known, dflt |-> dflt, caller |-> caller]
Persist == dur' = IF Sync = "all" THEN <<>> ELSE IF dur = <<>> THEN Store ELSE dur

Now == Len(chain)
Events == {chain[k].ev : k \in {j \in 1..Len(chain) : chain[j].ev # <<>>}}
UsedNonces == {e[3] : e \in Events}
Settled(o) == \E e \in Events : e[1] = "pay" /\ e[2] = o
SettledFor(o) == {k \in 1..Len(chain) : chain[k].ev # <<>> /\ chain[k].ev[1] = "pay" /\ chain[k].ev[2] = o}
CancelledOnChain(o) == \E e \in Events : e[1] = "cancel" /\ e[3] = onc[o]

RECURSIVE PaidIn(_, _)
PaidIn(c, n) == IF n = 0 THEN 0
                ELSE (IF c[n].ev # <<>> /\ c[n].ev[1] = "pay" THEN c[n].ev[5] ELSE 0) + PaidIn(c, n - 1)
Paid == PaidIn(chain, Len(chain))
Balance == InitBalance - Paid

RECURSIVE SumAmt(_)
SumAmt(S) == IF S = {} THEN 0 ELSE LET o == CHOOSE x \in S : TRUE IN terms[o][2] + SumAmt(S \ {o})
\* C11: a live authorization is a reservation until its event or its expiry.
LiveSet(except) == {o \in Obs \ {except} : ost[o] \in Live /\ ~Settled(o) /\ Now < vb[o]}
Reserved(except) == IF ReserveLive THEN SumAmt(LiveSet(except)) ELSE 0
Fits(o) == terms[o][2] <= Balance - Reserved(o)

DenyKey(o) == IF DenyPerWallet THEN <<"*", ObsKey[o]>> ELSE <<AgentOf(o), ObsKey[o]>>
EffRule(o) ==
    IF DenyKey(o) \in deny THEN "Deny"
    ELSE IF <<AgentOf(o), ObsKey[o]>> \in always THEN "Always"
    ELSE IF ObsKey[o] \in known THEN "Ask"
    ELSE dflt
\* The rule as the properties hold it: Deny binds the endpoint key for every agent.
Denied(o) == \E d \in deny : d[2] = ObsKey[o]
EffRuleSpec(o) ==
    IF Denied(o) THEN "Deny"
    ELSE IF <<AgentOf(o), ObsKey[o]>> \in always THEN "Always"
    ELSE IF ObsKey[o] \in known THEN "Ask"
    ELSE dflt
WindowLeft == Now + W <= MaxHeight

Init ==
    /\ ost = [o \in Obs |-> "none"]
    /\ onc = [o \in Obs |-> 0]
    /\ vb = [o \in Obs |-> 0]
    /\ appr = [o \in Obs |-> FALSE]
    /\ terms = [o \in Obs |-> <<>>]
    /\ always = {} /\ deny = {} /\ known = {}
    /\ dflt = DefaultRule
    /\ caller = [o \in Obs |-> "none"]
    /\ nextN = 100
    /\ sig = {} /\ box = {} /\ pending = {}
    /\ chain = <<>>
    /\ dur = <<>>
    /\ b = [crash |-> MaxCrash, pl |-> MaxPowerLoss, reorg |-> MaxReorg, rule |-> MaxRuleChange, cancel |-> MaxCancel]

-----------------------------------------------------------------------------
\* The proxy records the 402 before the box sees it (C21).
Observe(o) ==
    /\ ost[o] = "none"
    /\ ost' = [ost EXCEPT ![o] = "observed"]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, b>>

\* The agent of chat c calls wallet__pay_x402(o). Only an id: every term comes from
\* the observation (ObservedTerms); another chat's observation is refused (BindChat).
Call(o, c) ==
    /\ ost[o] = "observed"
    /\ IF BindChat /\ ObsChat[o] # c
       THEN UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending,
                        chain, dur, b>>
       ELSE /\ \E t \in (IF ObservedTerms THEN {Observed(o)} ELSE TermSpace) : terms' = [terms EXCEPT ![o] = t]
            /\ LET rule == EffRule(o)
                   fits == terms'[o][2] <= Balance - Reserved(o)
               IN ost' = [ost EXCEPT ![o] =
                      IF rule = "Deny" \/ ~fits THEN "refused"
                      ELSE IF rule = "Always" THEN "authorizing"
                      ELSE "waiting"]
            /\ caller' = [caller EXCEPT ![o] = c]
            /\ Persist
            /\ UNCHANGED <<onc, vb, appr, always, deny, known, dflt, nextN, sig, box, pending, chain, b>>

\* The owner's card. Always and Deny answer the other open asks with that key in the
\* same commit (C9). A card answered after the observation's window is Not paid.
Pay(o) ==
    /\ ost[o] = "waiting"
    /\ IF WindowLeft
       THEN /\ ost' = [ost EXCEPT ![o] = "authorizing"] /\ appr' = [appr EXCEPT ![o] = TRUE]
            /\ known' = known \cup {ObsKey[o]}
       ELSE ost' = [ost EXCEPT ![o] = "notpaid"] /\ UNCHANGED <<appr, known>>
    /\ Persist
    /\ UNCHANGED <<onc, vb, terms, always, deny, dflt, caller, nextN, sig, box, pending, chain, b>>

AlwaysPay(o) ==
    /\ ost[o] = "waiting" /\ b.rule > 0 /\ ~Denied(o)
    /\ always' = always \cup {<<AgentOf(o), ObsKey[o]>>}
    /\ known' = known \cup {ObsKey[o]}
    /\ ost' = [x \in Obs |-> IF ost[x] = "waiting" /\ AgentOf(x) = AgentOf(o) /\ ObsKey[x] = ObsKey[o]
                             THEN (IF WindowLeft THEN "authorizing" ELSE "notpaid") ELSE ost[x]]
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, deny, dflt, caller, nextN, sig, box, pending, chain>>

SetDeny(o) ==
    /\ deny' = deny \cup {DenyKey(o)}
    /\ always' = IF DenyPerWallet THEN {x \in always : x[2] # ObsKey[o]} ELSE always \ {<<AgentOf(o), ObsKey[o]>>}
    /\ known' = known \cup {ObsKey[o]}
    /\ ost' = [x \in Obs |-> IF ost[x] \in {"waiting", "authorizing"} /\ ObsKey[x] = ObsKey[o]
                                /\ (DenyPerWallet \/ AgentOf(x) = AgentOf(o))
                             THEN "refused" ELSE ost[x]]

NeverPay(o) ==
    /\ ost[o] = "waiting" /\ b.rule > 0
    /\ SetDeny(o)
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, dflt, caller, nextN, sig, box, pending, chain>>

DontPay(o) ==
    /\ ost[o] = "waiting" /\ ost' = [ost EXCEPT ![o] = "refused"]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, b>>

\* The owner's Recipients list: Deny an endpoint key, Always for an agent, back to Ask.
ListDeny(o) ==
    /\ b.rule > 0 /\ ~Denied(o)
    /\ SetDeny(o)
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, dflt, caller, nextN, sig, box, pending, chain>>
ListAsk(k) ==
    /\ b.rule > 0 /\ k \in known
    /\ deny' = {d \in deny : d[2] # k}
    /\ always' = {x \in always : x[2] # k}
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist
    /\ UNCHANGED <<ost, onc, vb, appr, terms, known, dflt, caller, nextN, sig, box, pending, chain>>
SetDefault ==
    /\ b.rule > 0
    /\ dflt' = IF dflt = "Ask" THEN "Deny" ELSE "Ask"
    /\ b' = [b EXCEPT !.rule = @ - 1]
    /\ Persist
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, caller, nextN, sig, box, pending, chain>>

\* An observation not paid within its life (24 h, OD-10) is Not paid.
Deadline(o) ==
    /\ ost[o] \in {"waiting", "authorizing"} /\ ost' = [ost EXCEPT ![o] = "notpaid"]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, b>>

\* The authorization commit: re-check (C4's analogue), store nonce and message with
\* a window from chain time (C19, R-9: the window starts at approval).
Authorize(o) ==
    /\ ost[o] = "authorizing" /\ WindowLeft
    /\ CASE EffRule(o) = "Deny" -> ost' = [ost EXCEPT ![o] = "refused"] /\ UNCHANGED <<onc, vb, nextN>>
         [] EffRule(o) # "Always" /\ ~appr[o] -> ost' = [ost EXCEPT ![o] = "waiting"] /\ UNCHANGED <<onc, vb, nextN>>
         [] ~Fits(o) -> ost' = [ost EXCEPT ![o] = "refused"] /\ UNCHANGED <<onc, vb, nextN>>
         [] OTHER -> /\ ost' = [ost EXCEPT ![o] = "authorized"]
                     /\ onc' = [onc EXCEPT ![o] = IF DerivedNonce THEN o ELSE nextN]
                     /\ nextN' = IF DerivedNonce THEN nextN ELSE nextN + 1
                     /\ vb' = [vb EXCEPT ![o] = Now + W]
    /\ Persist
    /\ UNCHANGED <<appr, terms, always, deny, known, dflt, caller, sig, box, pending, chain, b>>

\* The signer signs the stored message in its memory; nothing is committed.
SignAuth(o) ==
    /\ ost[o] = "authorized" /\ o \notin sig
    /\ sig' = sig \cup {o}
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, box, pending, chain, dur, b>>

\* The header leaves to the box. Under Sync = "all" the authorization commit it
\* comes from is already on disk.
Give(o) ==
    /\ o \in sig /\ ost[o] = "authorized"
    /\ box' = box \cup {<<o, onc[o], vb[o], terms[o]>>}
    /\ sig' = sig \ {o}
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, pending, chain, dur, b>>

\* A commit records that the header was handed.
CommitHanded(o) ==
    /\ ost[o] = "authorized" /\ \E x \in box : x[1] = o /\ x[2] = onc[o]
    /\ ost' = [ost EXCEPT ![o] = "handed"]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, b>>

\* The box (untrusted) hands any authorization it holds to a server, any time.
Submit(x) ==
    /\ x \in box /\ x[2] \notin UsedNonces
    /\ LET p == <<"pay", x[1], x[2], x[3], x[4][2]>> IN
       /\ p \notin pending
       /\ pending' = pending \cup {p}
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, chain, dur, b>>

\* The owner cancels a live authorization on chain (H-242).
CancelAuth(o) ==
    /\ ost[o] = "handed" /\ b.cancel > 0 /\ Now < vb[o]
    /\ pending' = pending \cup {<<"cancel", o, onc[o], MaxHeight + 1, 0>>}
    /\ b' = [b EXCEPT !.cancel = @ - 1]
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, chain, dur>>

\* A block at time Now + 1: empty, or with one includable transaction (the token's
\* rules: nonce unused, time before validBefore, funds).
Includable(x) ==
    /\ x[3] \notin UsedNonces
    /\ Now + 1 < x[4]
    /\ Balance >= x[5]
Mine ==
    /\ Now < MaxHeight
    /\ \/ /\ chain' = Append(chain, [ev |-> <<>>, fin |-> FALSE]) /\ UNCHANGED pending
       \/ \E x \in pending :
            /\ Includable(x)
            /\ chain' = Append(chain, [ev |-> x, fin |-> FALSE])
            /\ pending' = pending \ {x}
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, dur, b>>

Finalize ==
    /\ \E k \in 1..Len(chain) : ~chain[k].fin
    /\ LET k == CHOOSE k \in 1..Len(chain) : ~chain[k].fin /\ \A j \in 1..(k - 1) : chain[j].fin
       IN chain' = [chain EXCEPT ![k].fin = TRUE]
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, dur, b>>

\* A reorg drops the tip; its transaction returns to the facilitator (worst case).
Reorg ==
    /\ b.reorg > 0 /\ Len(chain) > 0 /\ ~chain[Len(chain)].fin
    /\ LET e == chain[Len(chain)].ev IN
       pending' = IF e = <<>> THEN pending ELSE pending \cup {e}
    /\ chain' = SubSeq(chain, 1, Len(chain) - 1)
    /\ b' = [b EXCEPT !.reorg = @ - 1]
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, dur>>

\* The follower: settled at finalized; cancelled likewise; expired once no settlement
\* can appear any more.
NoSettlementPossible(o) ==
    /\ Now >= vb[o]
    /\ ExpireAtFinal => (vb[o] <= Len(chain) /\ chain[vb[o]].fin)
Track(o) ==
    /\ ost[o] = "handed"
    /\ \/ /\ \E k \in SettledFor(o) : chain[k].fin
          /\ ost' = [ost EXCEPT ![o] = "settled"]
       \/ /\ CancelledOnChain(o) /\ ~Settled(o)
          /\ \E k \in 1..Len(chain) : chain[k].ev # <<>> /\ chain[k].ev[1] = "cancel"
                                      /\ chain[k].ev[3] = onc[o] /\ chain[k].fin
          /\ ost' = [ost EXCEPT ![o] = "cancelled"]
       \/ /\ ~Settled(o) /\ ~CancelledOnChain(o) /\ NoSettlementPossible(o)
          /\ ost' = [ost EXCEPT ![o] = "expired"]
    /\ Persist
    /\ UNCHANGED <<onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, b>>

\* A process crash: the signer's memory is lost, every commit that returned kept.
Crash ==
    /\ b.crash > 0 /\ b' = [b EXCEPT !.crash = @ - 1]
    /\ sig' = {}
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, box, pending, chain, dur>>

\* Power loss: memory lost and the store goes back to what is on disk. The box may
\* already hold a header whose commit is lost (Sync = "none").
PowerLoss ==
    /\ b.pl > 0
    /\ IF dur = <<>> THEN UNCHANGED storeVars
       ELSE /\ ost' = dur.ost /\ onc' = dur.onc /\ vb' = dur.vb /\ appr' = dur.appr /\ terms' = dur.terms
            /\ always' = dur.always /\ deny' = dur.deny /\ known' = dur.known /\ dflt' = dur.dflt
            /\ caller' = dur.caller
    /\ sig' = {} /\ dur' = <<>>
    /\ b' = [b EXCEPT !.pl = @ - 1]
    /\ UNCHANGED <<nextN, box, pending, chain>>

Flush ==
    /\ dur # <<>> /\ dur' = <<>>
    /\ UNCHANGED <<ost, onc, vb, appr, terms, always, deny, known, dflt, caller, nextN, sig, box, pending, chain, b>>

\* Every observation the box saw reached a terminal state: the run ends here.
Quiesce == (\A o \in Obs : ost[o] \in Terminal) /\ UNCHANGED vars

Next ==
    \/ \E o \in Obs : Observe(o) \/ Pay(o) \/ AlwaysPay(o) \/ NeverPay(o) \/ DontPay(o) \/ Deadline(o)
                      \/ Authorize(o) \/ SignAuth(o) \/ Give(o) \/ CommitHanded(o) \/ CancelAuth(o) \/ Track(o)
                      \/ ListDeny(o)
    \/ \E o \in Obs, c \in Chats : Call(o, c)
    \/ \E k \in EKeys : ListAsk(k)
    \/ \E x \in box : Submit(x)
    \/ SetDefault \/ Flush \/ Mine \/ Finalize \/ Reorg \/ Crash \/ PowerLoss \/ Quiesce

Fairness ==
    /\ \A o \in Obs : WF_vars(Authorize(o)) /\ WF_vars(SignAuth(o)) /\ WF_vars(Give(o)) /\ WF_vars(CommitHanded(o))
                      /\ WF_vars(Track(o)) /\ WF_vars(Deadline(o))
    /\ WF_vars(Flush) /\ WF_vars(Mine) /\ WF_vars(Finalize)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK == /\ ost \in [Obs -> {"none", "observed", "waiting", "authorizing"} \cup Live \cup Terminal]
          /\ dflt \in {"Ask", "Deny"} /\ known \subseteq EKeys

\* At most one settlement per observation (one payment per 402 seen).
AtMostOncePerObs == \A o \in Obs : Cardinality(SettledFor(o)) <= 1
\* What is reported is what the chain says.
ReportedIsTrue == \A o \in Obs :
    /\ ost[o] = "settled" => Settled(o)
    /\ ost[o] \in {"expired", "refused", "notpaid", "cancelled"} => ~Settled(o)
\* Only the terms the proxy observed are ever signed (C3, H-217): never the agent's.
SignedOnlyObserved == \A x \in box : x[4] = Observed(x[1])
\* Sanity: the token never moves more than the wallet held.
WithinBalance == Paid <= InitBalance

Authorized(o) == ost[o] # "authorized" /\ ost'[o] = "authorized"
\* An authorization is made only under Always for (agent, endpoint key) or the owner's
\* approval, never under Deny (by rule, for any agent, or by default): checked in the
\* authorization commit.
AuthorizeBasis == [][\A o \in Obs : Authorized(o) =>
    (EffRuleSpec(o) # "Deny" /\ (<<AgentOf(o), ObsKey[o]>> \in always \/ appr[o]))]_vars
\* Deny is per wallet: a call to a denied endpoint key is refused, whichever agent calls.
DenyIsPerWallet == [][\A o \in Obs :
    (ost[o] = "observed" /\ ost'[o] # "observed" /\ Denied(o)) => ost'[o] = "refused"]_vars
\* Always never asks (C3): a call under Always is authorized or refused, never a card.
AlwaysNeverAsks == [][\A o \in Obs :
    (ost[o] = "observed" /\ ost'[o] = "waiting") => EffRuleSpec(o) # "Always"]_vars
\* C11: no authorization the balance less the other live ones cannot cover.
TrueReserved(o) == SumAmt({x \in Obs \ {o} : ost[x] \in Live /\ ~Settled(x) /\ Now < vb[x]})
NoUnderfundedAuth == [][\A o \in Obs : Authorized(o) => terms[o][2] <= Balance - TrueReserved(o)]_vars
\* A payment is made only for the chat whose box saw the 402 (C18, H-218).
PaidByObservingChat == \A o \in Obs : ost[o] \in Live \cup {"settled"} => caller[o] = ObsChat[o]

EveryCallEnds == \A o \in Obs : (ost[o] \notin {"none", "observed"}) ~> (ost[o] \in Terminal)
=============================================================================
