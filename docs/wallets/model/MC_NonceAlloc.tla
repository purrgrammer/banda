--------------------------- MODULE MC_NonceAlloc ---------------------------
EXTENDS NonceAlloc
\* Two agents and the owner share the wallet's nonces; the external spender is in the spec.
MC_Payer == <<"a1", "a2", "owner">>
=============================================================================
