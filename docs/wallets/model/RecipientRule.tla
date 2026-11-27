---------------------------- MODULE RecipientRule ----------------------------
(***************************************************************************)
(* The rules a wallet holds for each recipient identity (requirements 2    *)
(* and 4; conflicts.md C8, C9, C18; OD-1), as two machines:                *)
(*                                                                         *)
(* - the recipient, per (wallet, identity): unknown, ask or deny. It is    *)
(*   unknown until the owner answers its first card or adds it to the      *)
(*   Recipients list; then it has a label (the owner's name, never the     *)
(*   identity). Deny is the wallet's, for every agent;                     *)
(* - the permission, per (wallet, agent, identity): none or always. Always *)
(*   is granted only on a known recipient that is not denied, and Deny     *)
(*   clears every agent's permission in the same commit.                   *)
(*                                                                         *)
(* An unknown recipient meets the wallet's default, Ask or Deny, never     *)
(* Always. Every act carries the version it saw (C8), from either of two   *)
(* devices (desktop and phone); an act on a stale version is refused and   *)
(* the screen redraws. Nothing but the owner changes a rule.               *)
(*                                                                         *)
(* The invariants hold by construction of the acts: they are regression    *)
(* guards, and the mutation toggles below show each one fails when its act *)
(* is written wrong (RecipientRule_mut_*.cfg).                             *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Agents, Recipients, Labels, Devices, DefaultRule, MaxActs,
          Versioned,          \* C8: an act applies only on the version it saw
          ForgetKeepsAlways,  \* mutation: Forget leaves the permissions in place
          AlwaysOverDeny      \* mutation: a card's Always is offered and applied under Deny

None == "none"
Actors == Devices

VARIABLES
    label,    \* recipient -> label or "none" (Unknown)
    deny,     \* recipient -> Deny (per wallet)
    always,   \* recipient -> agents with Always
    ver,      \* recipient -> version, raised by every change
    view,     \* actor -> recipient -> the version that actor's screen (or check) saw
    lastSeen, \* ghost: the version the last applied act saw (for the property)
    acts      \* budget

vars == <<label, deny, always, ver, view, lastSeen, acts>>

Init ==
    /\ label = [r \in Recipients |-> None]
    /\ deny = [r \in Recipients |-> FALSE]
    /\ always = [r \in Recipients |-> {}]
    /\ ver = [r \in Recipients |-> 0]
    /\ view = [x \in Actors |-> [r \in Recipients |-> 0]]
    /\ lastSeen = [r \in Recipients |-> 0]
    /\ acts = MaxActs

\* The two machines' states.
RState(r) == IF label[r] = None THEN "unknown" ELSE IF deny[r] THEN "deny" ELSE "ask"
PState(a, r) == IF a \in always[r] THEN "always" ELSE "none"

\* The rule an agent's payment meets (C3 step 7).
Rule(a, r) ==
    IF deny[r] THEN "Deny"
    ELSE IF a \in always[r] THEN "Always"
    ELSE IF label[r] # None THEN "Ask"
    ELSE DefaultRule

\* An act from actor x on recipient r, seen at view[x][r]: applied only if current
\* (Versioned), else refused and x's screen redraws.
Act(x, r, newLabel, newDeny, newAlways) ==
    /\ acts > 0
    /\ acts' = acts - 1
    /\ IF Versioned => view[x][r] = ver[r]
       THEN /\ label' = [label EXCEPT ![r] = newLabel]
            /\ deny' = [deny EXCEPT ![r] = newDeny]
            /\ always' = [always EXCEPT ![r] = newAlways]
            /\ ver' = [ver EXCEPT ![r] = @ + 1]
            /\ view' = [view EXCEPT ![x][r] = ver[r] + 1]
            /\ lastSeen' = [lastSeen EXCEPT ![r] = view[x][r]]
       ELSE /\ view' = [view EXCEPT ![x][r] = ver[r]]
            /\ UNCHANGED <<label, deny, always, ver, lastSeen>>

\* A screen reads the current version.
Refresh(x, r) == view[x][r] # ver[r] /\ view' = [view EXCEPT ![x][r] = ver[r]]
                 /\ UNCHANGED <<label, deny, always, ver, lastSeen, acts>>

LabelOr(r, l) == IF label[r] = None THEN l ELSE label[r]

\* The first payment's card (or any card) answered by the owner from device d. A card
\* is never answered under Deny: Deny refuses its payments in the same commit.
CardPay(d, r, l)          == ~deny[r] /\ Act(d, r, LabelOr(r, l), deny[r], always[r])
CardAlways(d, r, a, l)    == (~deny[r] \/ AlwaysOverDeny)
                             /\ Act(d, r, LabelOr(r, l), deny[r], always[r] \cup {a})
CardDontPay(d, r, l)      == ~deny[r] /\ Act(d, r, LabelOr(r, l), deny[r], always[r])
CardNever(d, r, l)        == ~deny[r] /\ Act(d, r, LabelOr(r, l), TRUE, {})

\* The Recipients list.
SetAsk(d, r)              == label[r] # None /\ Act(d, r, label[r], FALSE, {})
SetAlways(d, r, a)        == label[r] # None /\ ~deny[r] /\ Act(d, r, label[r], FALSE, always[r] \cup {a})
SetDeny(d, r)             == label[r] # None /\ Act(d, r, label[r], TRUE, {})
Rename(d, r, l)           == label[r] # None /\ l # label[r] /\ Act(d, r, l, deny[r], always[r])
Forget(d, r)              == label[r] # None /\ Act(d, r, None, FALSE, IF ForgetKeepsAlways THEN always[r] ELSE {})

\* The act budget is spent: the run ends here (not a deadlock).
Quiesce == acts = 0 /\ UNCHANGED vars

Next ==
    \/ Quiesce
    \/ \E x \in Actors, r \in Recipients : Refresh(x, r)
    \/ \E d \in Devices, r \in Recipients, l \in Labels :
         CardPay(d, r, l) \/ CardDontPay(d, r, l) \/ CardNever(d, r, l) \/ Rename(d, r, l)
         \/ \E a \in Agents : CardAlways(d, r, a, l)
    \/ \E d \in Devices, r \in Recipients :
         SetAsk(d, r) \/ SetDeny(d, r) \/ Forget(d, r) \/ \E a \in Agents : SetAlways(d, r, a)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK == /\ label \in [Recipients -> Labels \cup {None}]
          /\ \A r \in Recipients : always[r] \subseteq Agents

\* The permission machine lives under the recipient machine: always only on a known
\* recipient that is not denied.
PermissionUnderRecipient == \A r \in Recipients, a \in Agents : PState(a, r) = "always" => RState(r) = "ask"

\* Unknown recipients are never Always; the default is Ask or Deny.
UnknownNeverAlways == \A r \in Recipients, a \in Agents : label[r] = None => Rule(a, r) = DefaultRule
\* Deny and Always never hold together; Deny is the wallet's for every agent (OD-1).
DenyExcludesAlways == \A r \in Recipients : deny[r] => always[r] = {}
DenyIsPerWallet == \A r \in Recipients : deny[r] => \A a \in Agents : Rule(a, r) = "Deny"

\* A renamed recipient keeps its rule, and a rename touches one identity only.
RenameKeepsRule == [][\A r \in Recipients :
    (label[r] # None /\ label'[r] # None /\ label'[r] # label[r]) => (deny'[r] = deny[r] /\ always'[r] = always[r])]_vars
OneIdentityPerAct == [][\A r, s \in Recipients :
    (r # s /\ ver'[r] # ver[r]) => (ver'[s] = ver[s] /\ label'[s] = label[s] /\ deny'[s] = deny[s]
                                     /\ always'[s] = always[s])]_vars
\* Always for one agent never covers another (H-091).
AlwaysPerAgent == [][\A r \in Recipients, a \in Agents :
    (a \notin always[r] /\ a \in always'[r]) => always'[r] \ always[r] = {a}]_vars

\* No lost update: every change was made by an actor that saw the version it changed (C8).
NoLostUpdate == [][\A r \in Recipients : ver'[r] # ver[r] => lastSeen'[r] = ver[r]]_vars
=============================================================================
