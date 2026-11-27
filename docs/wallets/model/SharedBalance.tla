--------------------------- MODULE SharedBalance ---------------------------
(***************************************************************************)
(* One wallet's balance shared by its two spenders (conflicts.md C11): the *)
(* payment lane (a transfer, from admission to its block) and x402 (an     *)
(* authorization, from its commit to settlement or expiry). Each admission *)
(* and each start reads the balance and every reservation of the wallet,   *)
(* of both kinds, in the commit that adds its own (OneLedger). With two    *)
(* ledgers each spender sees only its own reservations: the bug.           *)
(***************************************************************************)
EXTENDS Integers, TLC

CONSTANTS InitBalance, PayAmt, AuthAmt, MaxDeposit,
          OneLedger      \* C11: one reservation ledger per wallet, read by both spenders

VARIABLES pay, auth, spent, funded, b
vars == <<pay, auth, spent, funded, b>>

Balance == funded - spent
PayHeld == IF pay \in {"queued", "started"} THEN PayAmt ELSE 0
AuthHeld == IF auth = "authorized" THEN AuthAmt ELSE 0
\* What a spender sees as reserved besides its own amount.
OthersFor(who) == IF who = "pay" THEN (IF OneLedger THEN AuthHeld ELSE 0)
                  ELSE (IF OneLedger THEN PayHeld ELSE 0)

Init == pay = "idle" /\ auth = "idle" /\ spent = 0 /\ funded = InitBalance /\ b = MaxDeposit

PayAdmit == pay = "idle" /\ pay' = (IF Balance - OthersFor("pay") >= PayAmt THEN "queued" ELSE "refused")
            /\ UNCHANGED <<auth, spent, funded, b>>
PayStart == pay = "queued" /\ pay' = (IF Balance - OthersFor("pay") >= PayAmt THEN "started" ELSE "refused")
            /\ UNCHANGED <<auth, spent, funded, b>>
\* The chain includes the transfer only if the balance holds it; otherwise it waits.
PayMine == pay = "started" /\ Balance >= PayAmt /\ pay' = "done" /\ spent' = spent + PayAmt
           /\ UNCHANGED <<auth, funded, b>>
AuthCommit == auth = "idle" /\ auth' = (IF Balance - OthersFor("auth") >= AuthAmt THEN "authorized" ELSE "refused")
              /\ UNCHANGED <<pay, spent, funded, b>>
\* A facilitator settles only if the balance holds it; otherwise the authorization expires.
AuthSettle == auth = "authorized" /\ Balance >= AuthAmt /\ auth' = "settled" /\ spent' = spent + AuthAmt
              /\ UNCHANGED <<pay, funded, b>>
AuthExpire == auth = "authorized" /\ auth' = "expired" /\ UNCHANGED <<pay, spent, funded, b>>
Deposit == b > 0 /\ funded' = funded + 1 /\ b' = b - 1 /\ UNCHANGED <<pay, auth, spent>>

Quiesce == pay \in {"done", "refused"} /\ auth \in {"settled", "refused", "expired"} /\ UNCHANGED vars

Next == PayAdmit \/ PayStart \/ PayMine \/ AuthCommit \/ AuthSettle \/ AuthExpire \/ Deposit \/ Quiesce
Spec == Init /\ [][Next]_vars

\* What both spenders hold never exceeds the balance: nothing admitted or authorized
\* is left unfunded by the other spender.
CommittedWithinBalance == PayHeld + AuthHeld <= Balance
=============================================================================
