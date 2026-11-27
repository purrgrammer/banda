"""Writes the TLC configurations of PaymentLane, NonceAlloc, X402, RecipientRule and SharedBalance from one base each, so every run differs from the
others only in what its name says. Run: python3 -I gen_cfgs.py (prints each name). Every run is made without
-deadlock: a state with nothing enabled but the end of the run (Quiesce) is a failure."""
import itertools
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- PaymentLane

BASE = dict(
    Agents='{"a1", "a2"}', Recipients='{"r1", "r2"}', Labels='{"L1"}',
    Payer="<- MC_Payer", Rcpt="<- MC_Rcpt", Amt="<- MC_Amt",
    ForeignAmt=1, DefaultRule='"Ask"', InitFunds=2, MaxFund=0,
    MaxCrash=1, MaxPowerLoss=1, MaxReorg=0, MaxForeign=0, MaxBump=0, MaxRuleChange=0, MaxOutage=0, MaxKeyFault=0,
    MaxCancel=0, MaxRevert=0, MaxLie=1, MaxCancelReplace=0, MaxBaseRise=0, MaxRestore=0, MaxAccess=0,
    RecheckAtStart="TRUE", RecheckAccess="TRUE", ReadmitAtFinal="TRUE", Sync='"all"', DecodeForeign="TRUE",
    LaneOwnsOutcome="TRUE", PreBurnDeadline="TRUE", ResolveByLabel="FALSE", FailAtFinal="TRUE", VerifyRpc="TRUE",
    ReserveIncluded="TRUE", ResumeRestored="FALSE", BurstPause="FALSE", OwnerActs="FALSE",
)
SAFETY_INV = ("TypeOK AtMostOnePaid RefusedNeverPaid AckedNeverStarts ReportedIsTrue UniqueNonce NoGap "
              "OwnBelowLedger OneInFlight SpentWithinFunded")
SAFETY_PROP = ("StartBasis AckedDenyHolds UnderfundedNeverStarts DenyRefusesCall AdmitByIdentity AlwaysNeverAsks "
               "RenameKeepsRule LedgerMonotone ForwardOnly")

RULES = dict(Labels='{"L1", "L2"}', MaxRuleChange=2, MaxCancel=1, MaxKeyFault=1, MaxFund=1)
CHAIN = dict(MaxForeign=1, MaxReorg=1, MaxBump=1, MaxRuleChange=1, InitFunds=3, MaxRevert=1)
SMALL2 = dict(Agents='{"a1"}', Payer="<- MC_Payer2", Rcpt="<- MC_Rcpt2", Amt="<- MC_Amt2", InitFunds=1)
LANE = dict(MaxRuleChange=0, MaxForeign=0, MaxReorg=0, MaxRevert=0)
S, L = "Spec", "FairSpec"

PAYMENT = {
    # all rules on: owner and rule races (2 agents + owner), with crash, power loss, cancel, keychain faults, rename
    "PaymentLane_rules": (dict(RULES), SAFETY_INV, SAFETY_PROP, S, "all design rules; owner, rule and label races"),
    # the same with the default rule Deny for unknown recipients (OD-13)
    "PaymentLane_default_deny": (dict(RULES, DefaultRule='"Deny"'), SAFETY_INV, SAFETY_PROP, S,
                                 "all design rules; the default for unknown recipients is Deny"),
    # all rules on: chain races (2 agents + owner + external spender), reorg, bump, revert, crash, power loss
    "PaymentLane_chain": (dict(CHAIN), SAFETY_INV, SAFETY_PROP, S, "all design rules; chain, nonce and external-spender races"),
    # access: switch an agent off and on, archive, change the default, against queued payments
    "PaymentLane_access": (dict(MaxAccess=2, MaxRuleChange=1, InitFunds=3), SAFETY_INV, SAFETY_PROP, S,
                           "all design rules; access switched off, archive and default changes against the lane"),
    # cancel replacement and a rising base fee against reorg and bump
    "PaymentLane_cancel": (dict(MaxCancelReplace=1, MaxBaseRise=1, MaxBump=1, MaxReorg=1, InitFunds=3, MaxKeyFault=1),
                           SAFETY_INV, SAFETY_PROP, S, "all design rules; cancel replacement, fee bump, base fee rise, reorg"),
    # a backup restored over the live home
    "PaymentLane_restore": (dict(MaxRestore=1, MaxRuleChange=1, MaxBump=1, InitFunds=3), SAFETY_INV, SAFETY_PROP, S,
                            "all design rules; a backup restored over the live home"),
    # C21's second line alone: version commits unsynced, own transactions decoded
    "PaymentLane_decode": (dict(LANE, MaxBump=1, InitFunds=3, Sync='"start"'), "AtMostOnePaid UniqueNonce", "", S,
                           "version commits unsynced; a decoded own transaction is recognised (second line of C21)"),
    # liveness, all rules on, every fault class once (1 agent + owner + external spender)
    "PaymentLane_live": (dict(SMALL2, MaxForeign=1, MaxReorg=1, MaxBump=1, MaxRuleChange=1, MaxOutage=1,
                              MaxKeyFault=1, MaxCancel=1, MaxFund=0),
                         "TypeOK", "EveryAdmittedEnds", L, "liveness under weak fairness, all design rules"),
    # liveness with the full cast: 2 agents + owner + external spender
    "PaymentLane_live3": (dict(MaxForeign=1, MaxReorg=1, MaxRuleChange=1, MaxOutage=1, MaxKeyFault=1, InitFunds=3),
                          "TypeOK", "EveryAdmittedEnds", L, "liveness under weak fairness, full cast"),
    # liveness when the base fee prices a sent payment out and the keychain is lost: needs the owner
    "PaymentLane_live_stuck": (dict(SMALL2, MaxBaseRise=1, MaxBump=1, MaxKeyFault=1), "TypeOK", "EveryAdmittedEnds", L,
                               "liveness without the owner when a sent payment is priced out and the key is lost (expected to fail)"),
    "PaymentLane_live_owner": (dict(SMALL2, MaxBaseRise=1, MaxBump=1, MaxKeyFault=1, OwnerActs="TRUE"), "TypeOK",
                               "EveryAdmittedEnds", L, "liveness when the owner eventually unlocks or funds"),
    # each bug configuration switches one rule off and must fail
    "PaymentLane_bug_C4": (dict(RULES, RecheckAtStart="FALSE"), "", "StartBasis", S,
                           "C4 off: the start commit does not re-check"),
    "PaymentLane_bug_C4access": (dict(MaxAccess=2, MaxRuleChange=1, InitFunds=3, RecheckAccess="FALSE"), "", "StartBasis", S,
                                 "C4 narrowed: the start commit ignores access, archive and the default"),
    "PaymentLane_bug_C3burst": (dict(MaxRuleChange=2, BurstPause="TRUE"), "", "AlwaysNeverAsks", S,
                                "C3 negated: a burst of Always calls is paused to ask"),
    "PaymentLane_bug_C7": (dict(CHAIN, MaxRuleChange=0, ReadmitAtFinal="FALSE"), "AtMostOnePaid", "", S,
                           "C7 off: re-admit after a foreign nonce at latest"),
    "PaymentLane_bug_C7gap": (dict(CHAIN, MaxRuleChange=0, ReadmitAtFinal="FALSE"), "NoGap", "", S,
                              "C7 off: the gap it leaves"),
    "PaymentLane_bug_C10": (dict(SMALL2, MaxKeyFault=1, PreBurnDeadline="FALSE"), "TypeOK", "EveryAdmittedEnds", L,
                            "C10 narrowed: a queued payment never ages out while the keychain is locked"),
    "PaymentLane_bug_C11": (dict(LANE, ReserveIncluded="FALSE"), "", "UnderfundedNeverStarts", S,
                            "C11 narrowed: an own transaction the balance reading does not reflect is not reserved"),
    "PaymentLane_bug_C12": (dict(CHAIN, MaxRuleChange=0, MaxForeign=0, MaxRevert=1, FailAtFinal="FALSE"),
                            "ReportedIsTrue RefusedNeverPaid", "", S, "C12 narrowed: status 0 is final at latest"),
    "PaymentLane_bug_C12rpc": (dict(LANE, InitFunds=3, VerifyRpc="FALSE"), "AtMostOnePaid ReportedIsTrue", "", S,
                               "C12 off: an RPC's foreign nonce or status 0 is believed unverified"),
    "PaymentLane_bug_C12pay": (dict(LANE, InitFunds=3, VerifyRpc="FALSE"), "AtMostOnePaid", "", S,
                               "C12 off: an RPC's unverified foreign nonce re-admits a payment still in the pool"),
    "PaymentLane_bug_C13": (dict(RULES, LaneOwnsOutcome="FALSE"), "RefusedNeverPaid", "", S,
                            "C13 off: cancel or rerun past the burn point reports refused"),
    "PaymentLane_bug_C16": (dict(MaxRestore=1, MaxRuleChange=1, MaxBump=1, InitFunds=3, ResumeRestored="TRUE"),
                            "AtMostOnePaid AckedNeverStarts", "", S, "C16 off: a restored backup resumes its unstarted payments"),
    "PaymentLane_bug_C18": (dict(RULES, ResolveByLabel="TRUE"), "", "AdmitByIdentity StartBasis", S,
                            "C18 off: the rule is resolved through the recipient's label"),
    "PaymentLane_bug_C21": (dict(LANE, InitFunds=3, Sync='"none"'), "AtMostOnePaid", "", S,
                            "C21 off: a start commit can be lost to power loss after its bytes left"),
    "PaymentLane_bug_C21bump": (dict(LANE, MaxBump=1, InitFunds=3, Sync='"start"', DecodeForeign="FALSE"),
                                "AtMostOnePaid", "", S, "C21 for start commits only, no decoding: a bump's version commit is lost"),
    "PaymentLane_bug_C21acked": (dict(RULES, Sync='"effects"'), "AckedNeverStarts", "AckedDenyHolds", S,
                                 "C21 for effect commits only: an acknowledged refusal or Deny is lost"),
}

# pairwise coverage of the fault classes too large to combine in one run (instead of an unfinished "full" run)
PAIR_A = {"cancel": dict(MaxCancel=1, MaxCancelReplace=1), "keyf": dict(MaxKeyFault=1), "outage": dict(MaxOutage=1)}
PAIR_B = {"reorg": dict(MaxReorg=1), "foreign": dict(MaxForeign=1), "bump": dict(MaxBump=1, MaxBaseRise=1)}
for (an, a), (bn, bo) in itertools.product(PAIR_A.items(), PAIR_B.items()):
    PAYMENT[f"PaymentLane_pair_{an}_{bn}"] = (dict(a, **bo, MaxRuleChange=1, InitFunds=3, MaxRevert=1), SAFETY_INV,
                                              SAFETY_PROP, S, f"all design rules; pairwise: {an} with {bn}")

# ---------------------------------------------------------------- NonceAlloc

NBASE = dict(Payer="<- MC_Payer", MaxCrash=2, MaxReorg=2, MaxForeign=2, MaxBump=1, MaxPowerLoss=1, Sync='"all"',
             ReadmitAtFinal="TRUE", RaiseAtFinal="TRUE", NonceCAS="TRUE")
NSAFE_I = "TypeOK AtMostOnce UniqueNonce NoGap OwnBelowLedger OnChainAtOwnNonce OneInFlight FifoNonces"
NSAFE_P = "LedgerMonotone RaiseOnlyFinal"
NONE1 = dict(MaxCrash=0, MaxReorg=0, MaxForeign=0)
NONCE = {
    "NonceAlloc_safety": (dict(), NSAFE_I, NSAFE_P, S, "all design rules: 2 agents + owner + external spender "
                          "(2 spends), 2 reorgs, 2 crashes, 1 power loss, 1 bump"),
    "NonceAlloc_live": (dict(MaxCrash=1, MaxReorg=1, MaxForeign=1), "", "EveryEffectEnds", L,
                        "liveness under weak fairness, all design rules"),
    "NonceAlloc_bug_C21": (dict(NONE1, MaxBump=0, Sync='"none"'), "AtMostOnce", "", S,
                           "C21 off: no commit is synced before its bytes leave"),
    "NonceAlloc_bug_C21bump": (dict(NONE1, Sync='"start"'), "AtMostOnce", "", S,
                               "C21 for start commits only: a fee bump's version commit is lost to power loss"),
    "NonceAlloc_bug_C5": (dict(MaxCrash=0, MaxReorg=1, MaxForeign=1, MaxBump=0, MaxPowerLoss=0, RaiseAtFinal="FALSE"),
                          "NoGap", "", S, "C5 off: the ledger is raised to the chain's count at latest"),
    "NonceAlloc_bug_C7": (dict(MaxCrash=0, MaxReorg=1, MaxForeign=1, MaxBump=0, MaxPowerLoss=0, ReadmitAtFinal="FALSE"),
                          "AtMostOnce", "", S, "C7 off: an effect is released at latest when a foreign transaction holds its nonce"),
    "NonceAlloc_bug_C4cas": (dict(NonceCAS="FALSE"), "TypeOK", "LedgerMonotone", S,
                             "C4 narrowed: the start commit takes the signed nonce even if the ledger moved"),
}

# ---------------------------------------------------------------- X402

XBASE = dict(Chats='{"c1", "c2"}', ChatAgent="<- MC_ChatAgent", ObsChat="<- MC_ObsChat", ObsKey="<- MC_ObsKey",
             Amt="<- MC_Amt", DefaultRule='"Ask"', InitBalance=2, W=2, MaxHeight=4, MaxCrash=1, MaxPowerLoss=1,
             MaxReorg=2, MaxRuleChange=1, MaxCancel=1, DerivedNonce="TRUE", Sync='"all"', BindChat="TRUE",
             ExpireAtFinal="TRUE", ObservedTerms="TRUE", ReserveLive="TRUE", DenyPerWallet="TRUE")
XSAFE_I = "TypeOK AtMostOncePerObs ReportedIsTrue SignedOnlyObserved WithinBalance PaidByObservingChat"
XSAFE_P = "AuthorizeBasis DenyIsPerWallet AlwaysNeverAsks NoUnderfundedAuth"
QUIET = dict(MaxCrash=0, MaxPowerLoss=0, MaxReorg=0, MaxRuleChange=0, MaxCancel=0)
X402 = {
    "X402_safety": (dict(), XSAFE_I, XSAFE_P, S, "all design rules: 3 observations, 2 chats, 2 reorgs, a crash, "
                    "a power loss, a rule change, a cancel"),
    "X402_default_deny": (dict(DefaultRule='"Deny"', MaxReorg=1), XSAFE_I, XSAFE_P, S,
                          "all design rules; the default for unknown endpoints is Deny"),
    "X402_live": (dict(MaxReorg=1), "", "EveryCallEnds", L, "liveness under weak fairness, all design rules"),
    "X402_nondurable": (dict(MaxReorg=1, MaxRuleChange=0, MaxCancel=0, Sync='"none"'),
                        "AtMostOncePerObs SignedOnlyObserved WithinBalance PaidByObservingChat", "", S,
                        "C21 off but R-5 on: a lost authorization commit re-signs the same derived nonce: still once"),
    "X402_bug_C21": (dict(MaxReorg=1, MaxRuleChange=0, MaxCancel=0, Sync='"none"'), "ReportedIsTrue", "", S,
                     "C21 off, R-5 on: a lost authorization commit after the header left; the report can be false"),
    "X402_bug_R5": (dict(MaxCrash=0, MaxReorg=0, MaxRuleChange=0, MaxCancel=0, Sync='"none"', DerivedNonce="FALSE"),
                    "AtMostOncePerObs", "", S, "R-5 and C21 off: a random nonce and a lost commit give the box two authorizations"),
    "X402_bug_C18": (dict(QUIET, MaxHeight=3, BindChat="FALSE"), "PaidByObservingChat", "", S,
                     "C18 off: a chat's agent pays another chat's observation"),
    "X402_bug_C12": (dict(MaxCrash=0, MaxPowerLoss=0, MaxRuleChange=0, MaxCancel=0, ExpireAtFinal="FALSE"),
                     "ReportedIsTrue", "", S, "C12 narrowed: Expired at latest, before the block at validBefore is finalized"),
    "X402_bug_C3terms": (dict(QUIET, ObservedTerms="FALSE"), "SignedOnlyObserved", "", S,
                         "C3 off: the pay call carries the agent's terms instead of the observation's"),
    "X402_bug_C11": (dict(QUIET, ReserveLive="FALSE"), "", "NoUnderfundedAuth", S,
                     "C11 off: a live authorization is not reserved"),
    "X402_bug_C3deny": (dict(QUIET, MaxRuleChange=1, DenyPerWallet="FALSE"), "", "DenyIsPerWallet", S,
                        "C3/OD-1 off: Deny binds the endpoint key for one agent only"),
}

# ---------------------------------------------------------------- RecipientRule

RBASE = dict(Agents='{"a1", "a2"}', Recipients='{"r1", "r2"}', Labels='{"L1", "L2"}', Devices='{"desk", "phone"}',
             DefaultRule='"Ask"', MaxActs=4, Versioned="TRUE", ForgetKeepsAlways="FALSE", AlwaysOverDeny="FALSE")
RSAFE_I = "TypeOK PermissionUnderRecipient UnknownNeverAlways DenyExcludesAlways DenyIsPerWallet"
RSAFE_P = "RenameKeepsRule OneIdentityPerAct AlwaysPerAgent NoLostUpdate"
RECIPIENT = {
    "RecipientRule_safety": (dict(), RSAFE_I, RSAFE_P, S, "versioned acts, default Ask, 4 acts by two devices"),
    "RecipientRule_safety_default_deny": (dict(DefaultRule='"Deny"'), RSAFE_I, RSAFE_P, S,
                                          "versioned acts, default Deny, 4 acts by two devices"),
    "RecipientRule_bug_C8": (dict(MaxActs=3, Versioned="FALSE"), "", "NoLostUpdate", S,
                             "C8 off: an act applies on a version it did not see"),
    "RecipientRule_mut_forget": (dict(MaxActs=3, ForgetKeepsAlways="TRUE"), "UnknownNeverAlways", "", S,
                                 "mutation: Forget keeps the permissions (the guard must fail)"),
    "RecipientRule_mut_alwaysdeny": (dict(MaxActs=3, AlwaysOverDeny="TRUE"), "DenyExcludesAlways", "", S,
                                     "mutation: a card's Always applies under Deny (the guard must fail)"),
}

# ---------------------------------------------------------------- SharedBalance

SBASE = dict(InitBalance=1, PayAmt=1, AuthAmt=1, MaxDeposit=1, OneLedger="TRUE")
SHARED = {
    "SharedBalance_safety": (dict(), "CommittedWithinBalance", "", S, "one ledger: a transfer and an x402 authorization"),
    "SharedBalance_bug_C11": (dict(OneLedger="FALSE"), "CommittedWithinBalance", "", S,
                              "C11 off: the lane and x402 each reserve against their own ledger"),
}


def write(name, base, over, inv, prop, spec, title):
    c = dict(base)
    c.update(over)
    lines = [f"\\* {title}. Generated by gen_cfgs.py.", f"SPECIFICATION {spec}", "CONSTANTS"]
    for k, v in c.items():
        lines.append(f"    {k} {v}" if str(v).startswith("<-") else f"    {k} = {v}")
    if inv:
        lines += ["INVARIANTS", "    " + inv]
    if prop:
        lines += ["PROPERTIES", "    " + prop]
    with open(os.path.join(HERE, name + ".cfg"), "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    for base, table in ((BASE, PAYMENT), (NBASE, NONCE), (XBASE, X402), (RBASE, RECIPIENT), (SBASE, SHARED)):
        for name, (over, inv, prop, spec, title) in table.items():
            write(name, base, over, inv, prop, spec, title)
            print(name)
