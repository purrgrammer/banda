------------------------------ MODULE MC_X402 ------------------------------
EXTENDS X402
\* Two chats of two agents. o1: chat c1 saw endpoint e1 paying p1. o2: the same chat
\* saw e1 now paying p2 (payTo changed: another rule key, H-223). o3: chat c2 (agent
\* a2) saw e1 paying p1 (the same endpoint, another agent's rule, OD-1).
MC_ChatAgent == [c \in {"c1", "c2"} |-> IF c = "c1" THEN "a1" ELSE "a2"]
MC_ObsChat == <<"c1", "c1", "c2">>
MC_ObsKey  == <<"e1p1", "e1p2", "e1p1">>
MC_Amt     == <<1, 1, 1>>
MC_ObsChat2 == <<"c1", "c2">>
MC_ObsKey2  == <<"e1p1", "e1p1">>
MC_Amt2     == <<1, 1>>
=============================================================================
