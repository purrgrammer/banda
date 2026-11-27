--------------------------- MODULE WalletLifecycle ---------------------------
(***************************************************************************)
(* A wallet's life across two stores: banda's store (pi-durable) and the  *)
(* OS keychain (conflicts.md C15, C16, C20).                               *)
(*                                                                         *)
(* Creation: the signer draws a key in its own process; the store commits  *)
(* `creating` with the address; the keychain account named by the address  *)
(* must be empty; the key is written, read back and its address derived    *)
(* again; only then the store commits `ready`. The owner is offered the    *)
(* key once at creation (requirement 5) through a one-time reveal          *)
(* capability minted on the host after an OS re-authentication; the paste- *)
(* back check marks it saved; Skip marks it not backed up. The address is  *)
(* withheld from every channel until saved or skipped (Receive and its QR, *)
(* the wallet's screens, an agent's wallet__address and wallet__balance,   *)
(* any transaction from it), so no funds land on a key nobody saved        *)
(* (H-005). Revealing the key and disclosing the address are two facts.    *)
(*                                                                         *)
(* Availability: the keychain can lock, lose the item (reset, migration)   *)
(* or have an item planted under a name. Signing needs the key to derive   *)
(* the wallet's address (key proof) and the lease (C16): the keychain's    *)
(* epoch and holder match the home's, and the holder is proven by a home   *)
(* secret no backup, restore or fork copies. Archive, removal (refused     *)
(* while funds or payments remain), and a crash at every boundary.         *)
(*                                                                         *)
(* Key material is abstracted to where its bytes are: `keyAt` holds every  *)
(* place other than the keychain; the store, the box and logs must never   *)
(* be among them.                                                          *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    Addrs,          \* addresses a create can draw (random: two creates never draw one address)
    MaxCrash, MaxKeyFault, MaxPlant, MaxLeaseMove,
    \* design rules the bug configurations switch off
    CreatingFirst,     \* C15: commit `creating` with the address before the keychain write
    ReadBack,          \* C15: read back and derive before `ready`
    WithholdReceive,   \* H-005: the address is disclosed only once the key was saved or skipped
    RemovalGuard,      \* C17: removal refused while funds or payments remain
    KeyProof,          \* C16: the signer derives the address from the key and compares
    HomeSecret,        \* C16: the lease holder is proven by a secret no backup copies
    HostOnlyReveal,    \* C16, OD-2: the reveal capability is minted on the host only
    SignerIsolated,    \* C20: the key never enters the daemon's durable state
    RemovalRecheck     \* finding F-4: removal re-checks in the step that deletes the key

Homes == {"H1", "H2"}        \* H1 the home; H2 a backup of it restored beside it (H-284)
Places == {"signer", "client", "store", "box", "log"}
Forbidden == {"store", "box", "log"}

VARIABLES
    rec,        \* store record: none | creating | ready | archived | removing | removed | dropped
    backup,     \* pending | saved | skipped
    kc,         \* keychain item under the address's account: empty | ours | planted
    kcUp,       \* the keychain answers: TRUE, or locked / prompting nobody answers
    step,       \* the signer's volatile progress on a create: idle | drawn | written | verified
    keyAt,      \* places other than the keychain that hold the key's bytes now
    cap,        \* reveal capability: none | minted | used
    capDev,     \* the device the capability was minted for: none | host | phone
    disclosed,  \* the address left banda by some channel (Receive, a screen, a tool, a transaction)
    funds,      \* the address holds funds
    inflight,   \* a payment of this wallet is past its burn point and not final
    lost,       \* the OS lost the item (a fault, not a banda act)
    epoch,      \* the keychain's lease epoch for the address
    holder,     \* the home the keychain's lease names (proven by its home secret)
    sEpoch,     \* home -> address -> the epoch the home's store holds
    h2,         \* H2 exists (a backup restored beside H1)
    signedBad,  \* ghost: a signature was made with a key that is not this wallet's
    b

vars == <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
          signedBad, b>>

Init ==
    /\ rec = [a \in Addrs |-> "none"]
    /\ backup = [a \in Addrs |-> "pending"]
    /\ kc = [a \in Addrs |-> "empty"]
    /\ kcUp = TRUE
    /\ step = [a \in Addrs |-> "idle"]
    /\ keyAt = [a \in Addrs |-> {}]
    /\ cap = [a \in Addrs |-> "none"]
    /\ capDev = [a \in Addrs |-> "none"]
    /\ disclosed = [a \in Addrs |-> FALSE]
    /\ funds = [a \in Addrs |-> FALSE]
    /\ inflight = [a \in Addrs |-> FALSE]
    /\ lost = [a \in Addrs |-> FALSE]
    /\ epoch = [a \in Addrs |-> 1]
    /\ holder = [a \in Addrs |-> "H1"]
    /\ sEpoch = [h \in Homes |-> [a \in Addrs |-> 1]]
    /\ h2 = FALSE
    /\ signedBad = FALSE
    /\ b = [crash |-> MaxCrash, keyf |-> MaxKeyFault, plant |-> MaxPlant, lease |-> MaxLeaseMove]

-----------------------------------------------------------------------------
\* Creation (C15).

Draw(a) ==
    /\ rec[a] = "none" /\ step[a] = "idle" /\ kc[a] = "empty"
    /\ step' = [step EXCEPT ![a] = "drawn"]
    /\ keyAt' = [keyAt EXCEPT ![a] = IF SignerIsolated THEN {"signer"} ELSE {"signer", "store"}]
    /\ rec' = IF CreatingFirst THEN [rec EXCEPT ![a] = "creating"] ELSE rec
    /\ UNCHANGED <<backup, kc, kcUp, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

\* Write under the address's account, only if it is empty (a planted or older item
\* refuses the create: H-024). A write can report success and not persist (H-006),
\* a keychain fault bounded by MaxKeyFault.
Write(a) ==
    /\ step[a] = "drawn" /\ kcUp
    /\ IF kc[a] = "empty"
       THEN /\ \E v \in (IF b.keyf > 0 THEN {"ours", "empty"} ELSE {"ours"}) :
                 /\ kc' = [kc EXCEPT ![a] = v]
                 /\ b' = IF v = "empty" THEN [b EXCEPT !.keyf = @ - 1] ELSE b
            /\ step' = [step EXCEPT ![a] = "written"]
            /\ UNCHANGED <<rec, keyAt>>
       ELSE /\ step' = [step EXCEPT ![a] = "idle"]
            /\ rec' = [rec EXCEPT ![a] = IF rec[a] = "creating" THEN "dropped" ELSE rec[a]]
            /\ keyAt' = [keyAt EXCEPT ![a] = keyAt[a] \ {"signer"}]
            /\ UNCHANGED <<kc, b>>
    /\ UNCHANGED <<backup, kcUp, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad>>

\* Read back, derive the address again, and commit `ready` (ReadBack); with it off,
\* the write's own answer is trusted.
Ready(a) ==
    /\ step[a] = "written" /\ (ReadBack => kcUp)
    /\ rec[a] \in {"none", "creating"}
    /\ rec' = [rec EXCEPT ![a] = IF ~ReadBack \/ kc[a] = "ours" THEN "ready"
                                 ELSE IF rec[a] = "creating" THEN "dropped" ELSE "none"]
    /\ step' = [step EXCEPT ![a] = "idle"]
    /\ keyAt' = [keyAt EXCEPT ![a] = keyAt[a] \ {"signer"}]
    /\ UNCHANGED <<backup, kc, kcUp, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

\* The signer's call missed its deadline (a prompt nobody answers, C20): killed.
AbortCreate(a) ==
    /\ step[a] \in {"drawn", "written"} /\ ~kcUp
    /\ step' = [step EXCEPT ![a] = "idle"]
    /\ keyAt' = [keyAt EXCEPT ![a] = keyAt[a] \ {"signer"}]
    /\ UNCHANGED <<rec, backup, kc, kcUp, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

\* At start (and after an abort): a `creating` record with no create running is
\* resolved by what the keychain holds under its address (H-005).
Reconcile(a) ==
    /\ rec[a] = "creating" /\ step[a] = "idle" /\ kcUp
    /\ rec' = [rec EXCEPT ![a] = IF kc[a] = "ours" THEN "ready" ELSE "dropped"]
    /\ UNCHANGED <<backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

-----------------------------------------------------------------------------
\* Saving the key at creation (requirement 5, H-263) and later (OD-2).

\* The desktop shell mints a one-time capability after an OS re-authentication. A
\* paired device cannot (HostOnlyReveal); with it off, a device token mints one.
MintCap(a, dev) ==
    /\ rec[a] = "ready" /\ cap[a] # "minted"
    /\ HostOnlyReveal => dev = "host"
    /\ cap' = [cap EXCEPT ![a] = "minted"]
    /\ capDev' = [capDev EXCEPT ![a] = dev]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

\* The reveal consumes the capability in its commit and shows the key on the host's
\* screen only (the client); a crash after it loses only the screen (H-269).
Reveal(a) ==
    /\ cap[a] = "minted" /\ rec[a] = "ready" /\ kcUp /\ kc[a] = "ours"
    /\ cap' = [cap EXCEPT ![a] = "used"]
    /\ keyAt' = [keyAt EXCEPT ![a] = @ \cup {"client"}]
    /\ UNCHANGED <<capDev, rec, backup, kc, kcUp, step, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

\* Paste-back check: the pasted key derives the address (R-8).
ConfirmSaved(a) ==
    /\ "client" \in keyAt[a] /\ backup[a] # "saved"
    /\ backup' = [backup EXCEPT ![a] = "saved"]
    /\ keyAt' = [keyAt EXCEPT ![a] = @ \ {"client"}]
    /\ cap' = [cap EXCEPT ![a] = "none"]
    /\ UNCHANGED <<capDev, rec, kc, kcUp, step, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

Skip(a) ==
    /\ rec[a] = "ready" /\ backup[a] = "pending"
    /\ backup' = [backup EXCEPT ![a] = "skipped"]
    /\ keyAt' = [keyAt EXCEPT ![a] = @ \ {"client"}]
    /\ UNCHANGED <<rec, kc, kcUp, step, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

\* The address is disclosed by any channel: Receive and its QR, a screen, an agent's
\* wallet__address or wallet__balance, a transaction from it. Every channel reads one
\* gate, so one action stands for all.
Disclose(a) ==
    /\ rec[a] = "ready" /\ ~disclosed[a]
    /\ WithholdReceive => backup[a] # "pending"
    /\ disclosed' = [disclosed EXCEPT ![a] = TRUE]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

\* Someone (the owner, or anyone the address reached) funds a disclosed address.
Fund(a) ==
    /\ disclosed[a] /\ ~funds[a]
    /\ funds' = [funds EXCEPT ![a] = TRUE]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

\* Spending it all back to zero (payments, abstracted: PaymentLane holds them).
CanSign(h, a) ==
    /\ rec[a] \in {"ready"} /\ kcUp
    /\ IF KeyProof THEN kc[a] = "ours" ELSE kc[a] # "empty"
    /\ (h = "H1" \/ h2)
    /\ sEpoch[h][a] = epoch[a]
    /\ HomeSecret => holder[a] = h

Pay(h, a) ==
    /\ CanSign(h, a) /\ funds[a] /\ ~inflight[a]
    /\ inflight' = [inflight EXCEPT ![a] = TRUE]
    /\ signedBad' = (signedBad \/ kc[a] # "ours")
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, lost, epoch, holder, sEpoch, h2, b>>

Settle(a) ==
    /\ inflight[a]
    /\ inflight' = [inflight EXCEPT ![a] = FALSE]
    /\ funds' \in [Addrs -> BOOLEAN] /\ \A x \in Addrs \ {a} : funds'[x] = funds[x]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, lost, epoch, holder, sEpoch, h2, signedBad, b>>

-----------------------------------------------------------------------------
\* Archive and removal (C15, C17).

Archive(a) == rec[a] = "ready" /\ rec' = [rec EXCEPT ![a] = "archived"]
              /\ UNCHANGED <<backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch,
                             h2, signedBad, b>>
Unarchive(a) == rec[a] = "archived" /\ rec' = [rec EXCEPT ![a] = "ready"]
              /\ UNCHANGED <<backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch,
                             h2, signedBad, b>>

\* Finding F-4: the balance read when removal begins is not enough; funds can land
\* between that commit and the delete. The key is deleted only if, in the same step,
\* nothing is held or in flight and the owner saved the key or the address was never
\* disclosed (so nobody can send to it later); otherwise the removal rolls back.
Removable(a) == ~funds[a] /\ ~inflight[a] /\ (backup[a] = "saved" \/ ~disclosed[a])

BeginRemove(a) ==
    /\ rec[a] \in {"ready", "archived"}
    /\ RemovalGuard => IF RemovalRecheck THEN Removable(a) ELSE (~funds[a] /\ ~inflight[a])
    /\ rec' = [rec EXCEPT ![a] = "removing"]
    /\ cap' = [cap EXCEPT ![a] = "none"]       \* a reveal is refused once removing committed (H-048)
    /\ UNCHANGED <<capDev, backup, kc, kcUp, step, keyAt, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad, b>>

DeleteItem(a) ==
    /\ rec[a] = "removing" /\ kcUp /\ kc[a] # "empty"
    /\ (RemovalGuard /\ RemovalRecheck) => Removable(a)
    /\ kc' = [kc EXCEPT ![a] = "empty"]
    /\ UNCHANGED <<rec, backup, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

CancelRemove(a) ==
    /\ rec[a] = "removing" /\ kc[a] # "empty" /\ RemovalGuard /\ RemovalRecheck /\ ~Removable(a)
    /\ rec' = [rec EXCEPT ![a] = "archived"]
    /\ UNCHANGED <<backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

Removed(a) ==
    /\ rec[a] = "removing" /\ kc[a] = "empty"
    /\ rec' = [rec EXCEPT ![a] = "removed"]
    /\ UNCHANGED <<backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

-----------------------------------------------------------------------------
\* The keychain's own faults, the owner's restore, an item planted, two homes.

Lock == b.keyf > 0 /\ kcUp /\ kcUp' = FALSE /\ b' = [b EXCEPT !.keyf = @ - 1]
        /\ UNCHANGED <<rec, backup, kc, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                       signedBad>>
Unlock == ~kcUp /\ kcUp' = TRUE
        /\ UNCHANGED <<rec, backup, kc, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                       signedBad, b>>

LoseItem(a) ==
    /\ b.keyf > 0 /\ kc[a] = "ours"
    /\ kc' = [kc EXCEPT ![a] = "empty"]
    /\ lost' = [lost EXCEPT ![a] = TRUE]
    /\ b' = [b EXCEPT !.keyf = @ - 1]
    /\ UNCHANGED <<rec, backup, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, epoch, holder, sEpoch, h2, signedBad>>

\* "Restore key": accepted only if the pasted key derives this address (C16).
RestoreKey(a) ==
    /\ rec[a] \in {"ready", "archived"} /\ kc[a] = "empty" /\ backup[a] = "saved" /\ kcUp
    /\ kc' = [kc EXCEPT ![a] = "ours"]
    /\ UNCHANGED <<rec, backup, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad, b>>

\* A process as the owner, or an older home, writes an item under an account.
Plant(a) ==
    /\ b.plant > 0 /\ kc[a] = "empty"
    /\ kc' = [kc EXCEPT ![a] = "planted"]
    /\ b' = [b EXCEPT !.plant = @ - 1]
    /\ UNCHANGED <<rec, backup, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2,
                   signedBad>>

\* A backup of H1 restored beside it: its store copies H1's epochs; its home secret
\* is its own (the secret lives outside what a backup copies).
RestoreBeside ==
    /\ ~h2
    /\ h2' = TRUE
    /\ sEpoch' = [sEpoch EXCEPT !["H2"] = sEpoch["H1"]]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, signedBad, b>>

\* The owner moves a wallet's lease to the other home: the keychain's epoch first,
\* then the new holder's store (C15); a crash between leaves neither able to sign.
LeaseKeychain(a, h) ==
    /\ b.lease > 0 /\ h2 /\ holder[a] # h /\ kcUp /\ ~inflight[a]
    /\ epoch' = [epoch EXCEPT ![a] = @ + 1]
    /\ holder' = [holder EXCEPT ![a] = h]
    /\ b' = [b EXCEPT !.lease = @ - 1]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, sEpoch, h2, signedBad>>

LeaseStore(a) ==
    /\ sEpoch[holder[a]][a] # epoch[a]
    /\ sEpoch' = [sEpoch EXCEPT ![holder[a]][a] = epoch[a]]
    /\ UNCHANGED <<rec, backup, kc, kcUp, step, keyAt, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, h2,
                   signedBad, b>>

\* A crash loses volatile state: the signer's progress and its bytes, the screen.
Crash ==
    /\ b.crash > 0
    /\ step' = [a \in Addrs |-> "idle"]
    /\ keyAt' = [a \in Addrs |-> keyAt[a] \cap Forbidden]
    /\ b' = [b EXCEPT !.crash = @ - 1]
    /\ UNCHANGED <<rec, backup, kc, kcUp, cap, capDev, disclosed, funds, inflight, lost, epoch, holder, sEpoch, h2, signedBad>>

-----------------------------------------------------------------------------
\* Every address rests (no creation or removal under way, no capability minted): the
\* run may end here; any other state with nothing enabled is a deadlock.
Rest == \A a \in Addrs : rec[a] \in {"none", "ready", "archived", "dropped", "removed"} /\ cap[a] # "minted"
Quiesce == Rest /\ UNCHANGED vars

Next ==
    \/ Quiesce
    \/ \E a \in Addrs :
         \/ Draw(a) \/ Write(a) \/ Ready(a) \/ AbortCreate(a) \/ Reconcile(a)
         \/ Reveal(a) \/ ConfirmSaved(a) \/ Skip(a) \/ Disclose(a) \/ Fund(a) \/ Settle(a)
         \/ Archive(a) \/ Unarchive(a) \/ BeginRemove(a) \/ DeleteItem(a) \/ CancelRemove(a) \/ Removed(a)
         \/ LoseItem(a) \/ RestoreKey(a) \/ Plant(a) \/ LeaseStore(a)
         \/ \E dev \in {"host", "phone"} : MintCap(a, dev)
         \/ \E h \in Homes : Pay(h, a) \/ LeaseKeychain(a, h)
    \/ Lock \/ Unlock \/ RestoreBeside \/ Crash

\* Liveness assumes the keychain eventually answers (WF on Unlock: the owner logs in),
\* as PaymentLane assumes the RPC eventually does.
Fairness ==
    /\ WF_vars(Unlock)
    /\ \A a \in Addrs :
        /\ WF_vars(Write(a)) /\ WF_vars(Ready(a)) /\ WF_vars(AbortCreate(a))
        /\ WF_vars(Reconcile(a)) /\ WF_vars(DeleteItem(a)) /\ WF_vars(CancelRemove(a)) /\ WF_vars(Removed(a)) /\ WF_vars(LeaseStore(a))

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
    /\ rec \in [Addrs -> {"none", "creating", "ready", "archived", "removing", "removed", "dropped"}]
    /\ kc \in [Addrs -> {"empty", "ours", "planted"}]
    /\ \A a \in Addrs : keyAt[a] \subseteq Places

\* Key material never enters the store, the box or a log.
KeyNeverInStoreOrBox == \A a \in Addrs : keyAt[a] \cap Forbidden = {}

\* A ready wallet's key was durably in the keychain under its address when it
\* became ready (checked as an action property, ReadyOnlyWithKey); an address the
\* owner can fund always had its key saved or the save explicitly skipped.
AddressOnlyAfterSaveStep == \A a \in Addrs : disclosed[a] => backup[a] \in {"saved", "skipped"}

\* Funds never sit on an address whose only copy of the key banda destroyed:
\* if the keychain no longer holds the key, the OS lost it or the owner saved it.
FundsNeverOrphanedByBanda == \A a \in Addrs :
    (funds[a] /\ kc[a] # "ours") => (lost[a] \/ backup[a] = "saved")

\* No signature with a key that is not this wallet's (key proof, H-025).
NeverSignWithForeignKey == ~signedBad

\* At most one home can sign for a wallet (the lease, H-020, H-284).
OneSigningHome == \A a \in Addrs : Cardinality({h \in Homes : CanSign(h, a)}) <= 1

\* Every item of ours under a wallet's account has a record, or a create is running
\* for it: recovery never meets a key it cannot place (H-005, H-045).
NoOrphanItem == \A a \in Addrs : kc[a] = "ours" => (rec[a] # "none" \/ step[a] # "idle")

\* The key reaches a screen only on the host (OD-2, H-264).
RevealOnlyOnHost == \A a \in Addrs : "client" \in keyAt[a] => capDev[a] = "host"

\* A reveal happens only with a capability minted on the host, consumed once.
ReadyOnlyWithKey == [][\A a \in Addrs : (rec[a] # "ready" /\ rec'[a] = "ready" /\ rec[a] # "archived") => kc[a] = "ours"]_vars
RevealOnce == [][\A a \in Addrs : ("client" \notin keyAt[a] /\ "client" \in keyAt'[a]) => (cap[a] = "minted" /\ cap'[a] = "used")]_vars

\* Liveness: a create always ends (ready or dropped); a removal ends once the
\* keychain answers.
CreateEnds == \A a \in Addrs : rec[a] = "creating" ~> rec[a] \in {"ready", "dropped"}
RemoveEnds == \A a \in Addrs : rec[a] = "removing" ~> rec[a] \in {"removed", "archived"}
=============================================================================
