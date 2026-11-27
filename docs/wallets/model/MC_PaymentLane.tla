--------------------------- MODULE MC_PaymentLane ---------------------------
(* Model values for PaymentLane: agent a1 and agent a2 both pay r1 (one shared  *)
(* wallet, OD-1: Always is per agent, Deny per wallet), the owner sends to r2.  *)
EXTENDS PaymentLane

MC_Payer == <<"a1", "a2", "owner">>
MC_Rcpt  == <<"r1", "r1", "r2">>
MC_Amt   == <<1, 1, 1>>

\* A smaller cast for liveness checking: one agent, the owner.
MC_Payer2 == <<"a1", "owner">>
MC_Rcpt2  == <<"r1", "r2">>
MC_Amt2   == <<1, 1>>
=============================================================================
