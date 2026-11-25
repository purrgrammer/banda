"""Writes transitions.json, the canonical transition table of the wallet's machines.

Each row is {machine, from, event, guard, to, effects[], hazards[], rules[], tla}. A guard is a
boolean expression over the machine's atoms (declared under "machines"), so check_transitions.py
can prove, by enumerating every valuation, that the guards of one (machine, from, event) are
mutually exclusive and exhaustive. "to" equal to "from" means the event is answered without a
state change (a refusal, a redraw, a wait). Run: python3 -I build_transitions.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
B = [False, True]

MACHINES = {
    "wallet": {
        "tla": "WalletLifecycle",
        "states": ["none", "creating", "ready_unsaved", "ready_saved", "ready_skipped", "archived", "removing",
                   "removed", "dropped"],
        "initial": "none",
        "terminal": ["removed", "dropped"],
        "atoms": {
            "kc_up": B,            # the keychain answers within the signer's deadline (C20)
            "item": ["empty", "ours", "other"],  # what the keychain holds under the address's account
            "cap_host": B,         # a reveal capability: the creation one (create request id, ready commit) or one the shell minted after OS re-authentication
            "cap_fresh": B,        # that capability is unused and under 60 s old
            "pasted_derives": B,   # the pasted key derives the wallet's address
            "funds": B,            # the balance at safe is above zero
            "inflight": B,         # a payment or authorization of this wallet is not final
            "address_disclosed": B,  # the address left banda: Receive, wallet__address/balance, a screen, a transaction
            "has_code": B,         # eth_getCode on the address is non-empty (an EIP-7702 delegation made elsewhere, H-157)
            "saved": B,            # the owner confirmed the key saved (paste-back)
            "version_current": B,  # the act carries the wallet's current version (C8)
        },
        "defs": {
            "removable": "(not funds) and (not inflight) and (saved or not address_disclosed)",
        },
    },
    "signing": {
        "tla": "WalletLifecycle",
        "states": ["online", "locked", "key_missing", "wrong_key", "other_home", "offline_host_mode"],
        "initial": "online",
        "terminal": [],
        "atoms": {
            "derives": B,          # the key read from the keychain derives the wallet's address
            "lease_mine": B,       # the keychain's epoch and holder match this home (home secret)
            "host_mode": B,        # banda runs commands on the host (no box)
        },
        "defs": {},
    },
    "recipient": {
        "tla": "RecipientRule",
        "states": ["unknown", "ask", "deny"],   # per (wallet, identity), with the owner's label (OD-1)
        "initial": "unknown",
        "terminal": [],
        "atoms": {
            "version_current": B,  # the act carries the version it saw (C8)
        },
        "defs": {},
    },
    "permission": {
        "tla": "RecipientRule",
        "states": ["none", "always"],           # per (wallet, agent, identity) (OD-1)
        "initial": "none",
        "terminal": [],
        "atoms": {
            "rcpt": ["unknown", "ask", "deny"],  # the recipient's state when the act commits
            "version_current": B,
        },
        "defs": {},
    },
    "payment": {
        "tla": "PaymentLane",
        "states": ["Idle", "Waiting", "Queued", "Signed", "Sent", "Included", "Confirmed", "Refused", "NotPaid",
                   "Failed", "Cancelled", "Restored"],
        "initial": "Idle",
        "terminal": ["Confirmed", "Refused", "NotPaid", "Failed", "Cancelled", "Restored"],
        "atoms": {
            "payer": ["agent", "owner"],
            "rule": ["deny", "always", "ask", "unknown"],  # the recipient's rule for this agent (identity, not label)
            "default_deny": B,
            "fits": B,             # amount <= balance at block b - every other reservation - fee reserve (C11)
            "approved": B,         # the owner approved this one payment
            "host_ok": B,          # the answer comes from the host, or the recipient is known by a host act: a rule the
                                   # owner set or a payment confirmed on the host, never a record an agent's ask created
            "wallet_usable": B,    # C3 steps 1-6, read at the call and again in the start commit: wallet ready, not archived,
                                   # on for this agent, tool on, args parse, identity valid, can sign; owner Send also
                                   # needs any code at the address acknowledged on the host (H-157)
            "ledger_moved": B,     # the ledger changed since the signer read it (C4)
            "blk": ["own", "own_cancel", "foreign", "none"],  # what the chain holds at this payment's nonce: a stored
                                   # paying version, the stored cancel replacement, another transaction, nothing yet
            "verified": B,         # an RPC claim that ends or re-asks the payment is proven: the foreign transaction's
                                   # signature recovers to the wallet at the nonce and its hash is no stored version, or
                                   # the status-0 receipt; a second, independent RPC agrees on the finalized block (TA-4)
            "blk_fin": B,
            "blk_ok": B,           # status 1
        },
        "defs": {
            "eff": "('deny' if rule == 'deny' or (rule == 'unknown' and default_deny) else "
                   "'always' if rule == 'always' else 'ask')",
            "start_ok": "payer == 'owner' or (eff != 'deny' and (eff == 'always' or approved))",
        },
    },
    "nonce": {
        "tla": "NonceAlloc",
        "states": ["free", "signing", "in_flight", "blocked"],
        "initial": "free",
        "terminal": [],
        "atoms": {
            "queued": B,           # the lane's FIFO holds a Queued effect
            "can_sign": B,         # keychain usable, key proven, lease held (C16)
            "chain_ahead": B,      # the chain's count at latest is above the ledger
            "ledger_moved": B,     # the ledger moved since the signer read it (C4)
            "recheck_ok": B,       # the start commit's re-check passes (C4)
            "above_final": B,      # every block above the ledger is finalized
            "more_in_flight": B,   # after a reorg, another stored effect is back in flight
            "verified": B,         # the foreign transaction's signer and nonce are proven and a second RPC agrees (TA-4)
        },
        "defs": {},
    },
    "x402": {
        "tla": "X402",
        "states": ["none", "observed", "waiting", "authorizing", "authorized", "handed", "settled", "expired",
                   "refused", "notpaid", "cancelled"],
        "initial": "none",
        "terminal": ["settled", "expired", "refused", "notpaid", "cancelled"],
        "atoms": {
            "same_chat": B,        # the calling chat is the chat whose box made the request (C18)
            "verified": B,         # TLS verified, scheme exact, asset and network the wallet's, domain from banda (H-224)
            "rule": ["deny", "always", "ask", "unknown"],  # Deny of (endpoint, payTo, asset, network) for the wallet, or
                                   # Always of (agent, the same), or Ask, or no rule at all
            "default_deny": B,     # the wallet's default for unknown recipients is Deny (OD-12)
            "approved": B,
            "host_ok": B,          # the answer comes from the host, or the endpoint is known by a host act
            "fits": B,             # amount <= available, live authorizations reserved (C11)
            "window_left": B,      # the observation is under 24 h old (R-9)
            "synced": B,           # the authorization commit is durable (C21)
            "event": ["used", "cancelled", "none"],  # what the token shows for the derived nonce
            "event_fin": B,        # that event's block is finalized
            "vb_passed_fin": B,    # the block at validBefore is finalized (C19)
        },
        "defs": {
            "eff": "('deny' if rule == 'deny' or (rule == 'unknown' and default_deny) else "
                   "'always' if rule == 'always' else 'ask')",
        },
    },
}

ROWS = []


def row(machine, frm, event, guard, to, effects=(), hazards=(), rules=(), tla="", unreachable_from=()):
    # unreachable_from: the from-states where a link of this machine rules out every valuation of the guard; the
    # row stays for exhaustiveness and the scenario checker proves the claim (S12) instead of asking for a scenario.
    frms = frm if isinstance(frm, (list, tuple)) else [frm]
    for f in frms:
        r = dict(machine=machine, **{"from": f}, event=event, guard=guard, to=(f if to == "=" else to),
                 effects=list(effects), hazards=list(hazards), rules=list(rules), tla=tla)
        if f in unreachable_from:
            r["unreachable"] = "a permission is Always only under an Ask recipient (link: PermissionUnderRecipient)"
        ROWS.append(r)


# ---------------------------------------------------------------- wallet
W = "wallet"
row(W, "none", "create", "True", "creating",
    ["signer draws 32 bytes (randomSecretKey over crypto.getRandomValues)", "commit creating with the address",
     "client request id dedupes a double tap (C14)"], ["H-001", "H-002", "H-007"], ["C14", "C15"], "Draw")
row(W, "creating", "keychain_write", "kc_up and item == 'empty'", "=",
    ["write the key under <home-id>/wallet/<address>"], ["H-001", "H-036"], ["C15", "C20"], "Write")
row(W, "creating", "keychain_write", "kc_up and item != 'empty'", "dropped",
    ["refuse: an item already exists under that account", "list the item as an orphan, never adopt it"],
    ["H-024", "H-045"], ["C15"], "Write")
row(W, "creating", "keychain_write", "not kc_up", "=",
    ["signer killed at its deadline (C20)", "nothing committed; reconcile when the keychain answers"],
    ["H-018", "H-032", "H-035"], ["C20"], "AbortCreate")
row(W, "creating", "read_back", "kc_up and item == 'ours'", "ready_unsaved",
    ["derive the address again and compare", "commit ready", "offer Save your key"], ["H-001", "H-006"], ["C15"],
    "Ready")
row(W, "creating", "read_back", "kc_up and item != 'ours'", "dropped",
    ["creation fails in words; no address is ever shown"], ["H-006"], ["C15"], "Ready")
row(W, "creating", "read_back", "not kc_up", "=", ["wait for the keychain; the signer is killed at its deadline"],
    ["H-018"], ["C20"], "AbortCreate")
row(W, "creating", "restart", "kc_up and item == 'ours'", "ready_unsaved", ["reconcile: the key is durable; offer Save your key again"],
    ["H-005"], ["C15"], "Reconcile")
row(W, "creating", "restart", "kc_up and item != 'ours'", "dropped", ["reconcile: drop the record; an item of another key stays an orphan"],
    ["H-005", "H-045"], ["C15"], "Reconcile")
row(W, "creating", "restart", "not kc_up", "=", ["stay creating until the keychain answers"], ["H-037"], ["C15", "C20"],
    "Reconcile")
READY = ["ready_unsaved", "ready_saved", "ready_skipped"]
row(W, READY, "reveal", "cap_host and cap_fresh and kc_up and item == 'ours'", "=",
    ["consume the capability in the commit", "show 0x + 64 hex beside the address, on the host only",
     "list 'key shown on this computer' in the wallet's activity"], ["H-263", "H-266", "H-268"], ["C14", "C16"],
    "Reveal")
row(W, READY, "reveal", "not (cap_host and cap_fresh) or not kc_up or item != 'ours'", "=",
    ["refuse: a device token, a replayed or expired capability, or the key unreadable",
     "phone: 'open banda on your computer to see the key'"], ["H-264", "H-267", "H-268", "H-021"], ["C16"], "MintCap")
# A skipped save is not final: the owner who skipped at creation and reveals the key later (H-266) proves the copy
# the same way, and the wallet becomes backed up (UC-02 step 4).
row(W, ["ready_unsaved", "ready_skipped"], "confirm_saved", "pasted_derives", "ready_saved", ["mark backed up"],
    ["H-263", "H-275"], ["C16"], "ConfirmSaved")
row(W, ["ready_unsaved", "ready_skipped"], "confirm_saved", "not pasted_derives", "=",
    ["say the pasted key does not open this wallet"], ["H-263"], ["C16"], "ConfirmSaved")
row(W, "ready_unsaved", "skip_save", "True", "ready_skipped", ["mark Not backed up"], ["H-273"], [], "Skip")
row(W, "ready_unsaved", "show_receive", "True", "=", ["withhold: save or skip the key first"], ["H-005"], ["C15"],
    "Disclose")
row(W, ["ready_saved", "ready_skipped"], "show_receive", "not has_code", "=",
    ["show the EIP-55 address and its QR", "the address is disclosed from now on"], ["H-258", "H-261"], [], "Disclose")
row(W, ["ready_saved", "ready_skipped"], "show_receive", "has_code", "=",
    ["withhold the address and QR: 'this address has code another key set; do not fund it'",
     "owner Send waits for an acknowledgement on the host"], ["H-157"], ["C3", "C17"], "")
row(W, "ready_unsaved", "agent_reads_address", "True", "=",
    ["wallet__address and wallet__balance answer 'not ready: the owner has not saved the key yet' (H-005)"],
    ["H-005"], ["C15"], "Disclose")
row(W, ["ready_saved", "ready_skipped"], "agent_reads_address", "True", "=",
    ["answer the address; it is disclosed from now on"], ["H-005", "H-046"], ["C17"], "Disclose")
row(W, READY, "acknowledge_code", "has_code and cap_host", "=",
    ["the owner acknowledged the address's code on the host: owner Send is allowed again; Receive keeps the warning"],
    ["H-157"], ["C17"], "")
row(W, READY, "acknowledge_code", "not (has_code and cap_host)", "=",
    ["refuse: nothing to acknowledge, or not on the host"], ["H-157", "H-277"], ["C17"], "")
row(W, READY, "archive", "version_current", "archived",
    ["refuse the wallet's open asks and queued payments in this commit"], ["H-042", "H-047"], ["C8", "C17"], "Archive")
row(W, READY, "archive", "not version_current", "=", ["refuse; the screen redraws"], ["H-050"], ["C8"], "Archive")
row(W, "archived", "unarchive", "version_current and saved", "ready_saved", ["back to ready, backed up"],
    ["H-042"], ["C8"], "Unarchive")
row(W, "archived", "unarchive", "version_current and not saved", "ready_skipped",
    ["back to ready, 'Not backed up' (an unsaved wallet comes back as skipped)"], ["H-042", "H-273"], ["C8"], "Unarchive")
row(W, "archived", "unarchive", "not version_current", "=", ["refuse; the screen redraws"], ["H-050"], ["C8"], "Unarchive")
row(W, READY + ["archived"], "begin_remove", "version_current and removable", "removing",
    ["commit removing", "refuse any reveal from now on"], ["H-043", "H-048"], ["C15", "C17"], "BeginRemove")
row(W, READY + ["archived"], "begin_remove", "not (version_current and removable)", "=",
    ["refuse in words: funds, a payment in flight, or a key never saved for an address that left banda"],
    ["H-043", "H-046", "H-050"], ["C17"], "BeginRemove")
row(W, "removing", "delete_item", "kc_up and item == 'ours' and removable", "=", ["delete the keychain item"],
    ["H-044"], ["C15"], "DeleteItem")
row(W, "removing", "delete_item", "kc_up and item == 'ours' and not removable", "archived",
    ["funds or a payment arrived since removal began: roll back (C17)"], ["H-046"], ["C17"], "CancelRemove")
row(W, "removing", "delete_item", "kc_up and item == 'other'", "removed",
    ["the item holds a key that does not open this wallet: never delete it, its address's funds were never checked",
     "the wallet's own key is gone already (deleted before a stop, or lost): commit removed with its account",
     "the item stays, listed as a key without a wallet (H-045)"], ["H-045", "H-024"], ["C15", "C17"], "Removed")
row(W, "removing", "delete_item", "kc_up and item == 'empty'", "=",
    ["nothing to delete: the delete happened before a stop, and item_gone ends the removal whatever reached the address"],
    ["H-044"], ["C15"], "Removed")
row(W, "removing", "delete_item", "not kc_up", "=", ["retry when the keychain answers"], ["H-044"], ["C15"], "DeleteItem")
row(W, "removing", "item_gone", "True", "removed", ["commit removed"], ["H-044"], ["C15"], "Removed")

# ---------------------------------------------------------------- signing availability
S = "signing"
row(S, "online", "keychain_locks", "True", "locked", ["one owner Wait 'unlock the keychain to pay' per lane",
    "nothing is burnt: queued payments stay queued and age out (C10)"], ["H-026", "H-027"], ["C4", "C20"], "Lock")
row(S, "online", "item_lost", "True", "key_missing", ["'Key missing from this computer'; reads keep working",
    "payments past the burn point keep tracking (they need no key)"], ["H-021"], ["C4", "C16"], "LoseItem")
# a lock or a loss seen while already offline: the wallet shows the newest reason (H-317); only a restore leaves
# key_missing (C9, H-290)
for frm in ["locked", "wrong_key", "other_home", "offline_host_mode"]:
    row(S, frm, "keychain_locks", "True", "locked", ["offline: the keychain is locked"], ["H-026", "H-317"], ["C16"],
        "Lock")
    row(S, frm, "item_lost", "True", "key_missing", ["offline: 'Key missing from this computer'"], ["H-021", "H-317"],
        ["C16"], "LoseItem")
row(S, "key_missing", "keychain_locks", "True", "=", ["still key missing: only a restore leaves it"],
    ["H-290", "H-317"], ["C9", "C16"], "Lock")
row(S, "key_missing", "item_lost", "True", "=", [], ["H-021"], ["C16"], "LoseItem")
row(S, "online", "unlock_check", "derives and lease_mine and not host_mode", "online", ["sign"], ["H-009"], ["C16"],
    "CanSign")
row(S, "online", "unlock_check", "not derives", "wrong_key", ["offline: the key in the keychain does not open the wallet"],
    ["H-025"], ["C16"], "CanSign")
row(S, "online", "unlock_check", "derives and not lease_mine", "other_home",
    ["offline: 'this wallet is used by another banda home'"], ["H-020", "H-284", "H-283"], ["C16"], "CanSign")
row(S, "online", "unlock_check", "derives and lease_mine and host_mode", "offline_host_mode",
    ["offline: host mode gives every command the owner's keychain"], ["H-064"], [], "CanSign")
for frm in ["locked", "wrong_key", "other_home", "offline_host_mode"]:
    row(S, frm, "unlock_check", "derives and lease_mine and not host_mode", "online", ["sign again"], ["H-026"],
        ["C16"], "Unlock")
    row(S, frm, "unlock_check", "not derives", "wrong_key", [], ["H-025"], ["C16"], "CanSign")
    row(S, frm, "unlock_check", "derives and not lease_mine", "other_home", [], ["H-020"], ["C16"], "CanSign")
    row(S, frm, "unlock_check", "derives and lease_mine and host_mode", "offline_host_mode", [], ["H-064"], [], "CanSign")
row(S, "key_missing", "restore_key", "derives", "online",
    ["accept the key (it derives this address)", "answer the lane's 'key missing' Wait (C9)"], ["H-014", "H-290"],
    ["C9", "C16"], "RestoreKey")
row(S, "key_missing", "restore_key", "not derives", "key_missing", ["refuse: that key opens another address"],
    ["H-014"], ["C16"], "RestoreKey")
row(S, ["online", "other_home"], "lease_moved", "lease_mine", "online",
    ["keychain epoch first, then the store (C15)"], ["H-289"], ["C15", "C16"], "LeaseKeychain")
row(S, ["online", "other_home"], "lease_moved", "not lease_mine", "other_home",
    ["this home stops signing"], ["H-289", "H-020"], ["C16"], "LeaseKeychain")

# ---------------------------------------------------------------- recipient (per wallet) and permission (per agent)
R = "recipient"
CUR, OLD = "version_current", "not version_current"
REDRAW = ["refuse the act; the screen redraws with the current rule (C8)"]
ALL_R = ["unknown", "ask", "deny"]
for ev, tla, eff in [("card_pay", "CardPay", "pay this once"), ("card_always", "CardAlways", "and grant this agent Always"),
                     ("card_dont_pay", "CardDontPay", "refuse this one")]:
    row(R, ["unknown", "ask"], ev, CUR, "ask", ["name the recipient if unknown (label only)", eff], ["H-073", "H-075"],
        ["C8", "C9"], tla)
    row(R, "deny", ev, CUR, "=", ["no card is open under Deny: the Deny answered it already (C9)"], ["H-084"], ["C9"], tla)
    row(R, ALL_R, ev, OLD, "=", REDRAW, ["H-141"], ["C8"], tla)
row(R, ["unknown", "ask"], "card_never", CUR, "deny",
    ["Deny per wallet, for every agent", "refuse every open ask and queued payment to it in this commit (C9)"],
    ["H-073", "H-084"], ["C8", "C9"], "CardNever")
row(R, "deny", "card_never", CUR, "=", ["no card is open under Deny"], ["H-084"], ["C9"], "CardNever")
row(R, ALL_R, "card_never", OLD, "=", REDRAW, ["H-141"], ["C8"], "CardNever")
row(R, ["ask", "deny"], "list_set_ask", CUR, "ask", ["lift the Deny; every agent's Always goes too (C4 re-checks queued payments)"],
    ["H-081", "H-087"], ["C4", "C8"], "SetAsk")
row(R, ["ask", "deny"], "list_set_always", CUR, "=", ["the recipient's own rule does not change (the permission does)"],
    ["H-081", "H-110"], ["C8", "C9"], "SetAlways")
row(R, ["ask", "deny"], "list_set_deny", CUR, "deny", ["sweep: refuse open asks and queued payments to it (C9)"],
    ["H-081", "H-084", "H-086"], ["C8", "C9"], "SetDeny")
row(R, ["ask", "deny"], "rename", CUR, "=", ["change the label only; every card redraws; the rule stays"],
    ["H-080", "H-077", "H-079"], ["C8", "C18"], "Rename")
row(R, ["ask", "deny"], "forget", CUR, "unknown", ["queued payments meet the default at their start commit (C4)"],
    ["H-088", "H-089"], ["C4", "C8"], "Forget")
for ev, tla in [("list_set_ask", "SetAsk"), ("list_set_always", "SetAlways"), ("list_set_deny", "SetDeny"),
                ("rename", "Rename"), ("forget", "Forget")]:
    row(R, ["ask", "deny"], ev, OLD, "=", REDRAW, ["H-109"], ["C8"], tla)
    row(R, "unknown", ev, "True", "=", ["an unknown recipient is not in the list"], [], [], tla)

PM = "permission"
for ev, tla in [("card_always", "CardAlways"), ("list_set_always", "SetAlways")]:
    ok = "rcpt != 'deny'" if ev == "card_always" else "rcpt == 'ask'"
    row(PM, ["none", "always"], ev, CUR + " and " + ok, "always",
        ["Always for (wallet, this agent, recipient), worded 'up to what's in the wallet'", "answer that agent's open asks (C9)"],
        ["H-073", "H-083", "H-091"], ["C8", "C9"], tla)
    row(PM, ["none", "always"], ev, CUR + " and not (" + ok + ")", "=",
        ["refused: never granted over a Deny, nor on a recipient the list does not hold"], ["H-084", "H-099"], ["C9"], tla,
        unreachable_from=["always"])
    row(PM, ["none", "always"], ev, OLD, "=", REDRAW, ["H-141"], ["C8"], tla)
for ev, tla in [("card_never", "CardNever"), ("list_set_deny", "SetDeny"), ("list_set_ask", "SetAsk"), ("forget", "Forget")]:
    row(PM, ["none", "always"], ev, CUR, "none", ["every agent's Always for the recipient goes in the same commit"],
        ["H-084", "H-088"], ["C8", "C9"], tla)
    row(PM, ["none", "always"], ev, OLD, "=", REDRAW, ["H-109"], ["C8"], tla)
row(PM, ["none", "always"], "rename", "True", "=", ["a label change keeps every permission (identity, not label)"],
    ["H-077", "H-080"], ["C18"], "Rename")

# ---------------------------------------------------------------- payment
P = "payment"
row(P, "Idle", "call", "not wallet_usable", "Refused", ["answer the first C3 check that fails, in words"],
    ["H-051", "H-053", "H-071", "H-137", "H-138"], ["C3"], "Call")
row(P, "Idle", "call", "wallet_usable and payer == 'agent' and eff == 'deny'", "Refused",
    ["'the owner doesn't pay <address>'; no card"], ["H-076"], ["C3"], "Call")
row(P, "Idle", "call", "wallet_usable and payer == 'agent' and eff != 'deny' and not fits", "Refused",
    ["refused with the available amount; no card (OD-8)"], ["H-132", "H-134"], ["C3", "C11"], "Call")
row(P, "Idle", "call", "wallet_usable and payer == 'agent' and eff == 'always' and fits", "Queued",
    ["reserve the amount (C11)", "append to the wallet's lane (C2)", "show a card in the chat, not asking"],
    ["H-074", "H-112"], ["C2", "C3", "C11"], "Call")
row(P, "Idle", "call", "wallet_usable and payer == 'agent' and eff == 'ask' and fits", "Waiting",
    ["reserve the amount (C11)", "open the payment card (an owner Wait, 24 h deadline)"], ["H-073", "H-075"],
    ["C3", "C10", "C11"], "Call")
row(P, "Idle", "call", "wallet_usable and payer == 'owner' and fits", "Queued",
    ["owner authority (law 1); the client request id dedupes (C14)", "append to the lane (C2)"],
    ["H-252", "H-253", "H-254"], ["C2", "C14"], "Call")
row(P, "Idle", "call", "wallet_usable and payer == 'owner' and not fits", "Refused", ["refused with the available amount"],
    ["H-134"], ["C11"], "Call")
row(P, "Waiting", "card_pay", "payer == 'agent' and rule == 'deny'", "Refused", ["Deny won meanwhile; the card says so"],
    ["H-082"], ["C1", "C8"], "Pay")
row(P, "Waiting", "card_pay", "not (payer == 'agent' and rule == 'deny') and not host_ok", "=",
    ["a paired device's Pay to a recipient the host never confirmed: the card stays a host Wait",
     "'confirm this new recipient on your computer'"], ["H-277", "H-278", "H-280"], ["C9", "C16"], "Pay")
row(P, "Waiting", "card_pay", "not (payer == 'agent' and rule == 'deny') and host_ok", "Queued",
    ["approve this one; the answer names an unknown recipient, so the default no longer applies to it", "append to the lane"],
    ["H-073", "H-075", "H-141"], ["C2", "C8", "C9"], "Pay")
row(P, "Waiting", "card_always", "payer == 'agent' and not host_ok", "=",
    ["Always from a paired device on a recipient the host never confirmed: a host Wait"], ["H-277", "H-280"],
    ["C9", "C16"], "AlwaysPay")
row(P, "Waiting", "card_always", "payer == 'agent' and host_ok", "Queued", ["set Always for (wallet, agent, recipient)",
    "approve every open ask of that agent to it (C9)"], ["H-073", "H-083", "H-311"], ["C9"], "AlwaysPay")
row(P, "Waiting", "card_always", "payer == 'owner'", "=", ["not offered on the owner's own Send"], ["H-107"], [], "AlwaysPay")
row(P, "Waiting", "card_dont_pay", "True", "Refused", ["refuse this one; the rule stays"], ["H-073"], ["C9"], "DontPay")
row(P, "Waiting", "card_never", "payer == 'agent'", "Refused", ["set Deny per wallet and sweep (C9)"], ["H-073", "H-084"],
    ["C9"], "NeverPay")
row(P, "Waiting", "card_never", "payer == 'owner'", "=", ["not offered on the owner's own Send"], ["H-106"], [], "NeverPay")
row(P, ["Waiting", "Queued"], "deny_committed", "payer == 'agent'", "Refused",
    ["refused in the Deny's commit (sweep)"], ["H-084", "H-086"], ["C9"], "SetDeny")
row(P, ["Waiting", "Queued"], "deny_committed", "payer == 'owner'", "=", ["the owner's own Send is not swept"], ["H-106"],
    [], "SetDeny")
row(P, ["Signed", "Sent", "Included"], "deny_committed", "True", "=",
    ["past the burn point: this one finishes and is reported; Deny applies from the next (C13)"], ["H-085"], ["C13"],
    "SetDeny")
row(P, "Waiting", "always_committed", "payer == 'agent'", "Queued", ["covered by the new Always: approved (C9)"],
    ["H-083", "H-311"], ["C9"], "GrantAlways")
row(P, "Waiting", "always_committed", "payer == 'owner'", "=", [], [], [], "GrantAlways")
row(P, ["Waiting", "Queued"], "cancel_or_switch_off", "True", "Refused",
    ["cancel of the chat's run, switch-off, archive, agent deleted: refused in that commit (C17)"],
    ["H-054", "H-055", "H-124", "H-047"], ["C13", "C17"], "Cancel")
row(P, ["Signed", "Sent", "Included"], "cancel_or_switch_off", "True", "=",
    ["the lane owns the outcome: the tool returns 'may have sent' until a receipt decides"], ["H-124", "H-126", "H-085"],
    ["C13"], "Cancel")
row(P, ["Waiting", "Queued"], "deadline", "True", "NotPaid",
    ["24 h with no answer, or queued and never started (keychain locked, lease lost): 'Not paid' (C10)"],
    ["H-142", "H-310", "H-026", "H-144"], ["C10"], "Deadline")
row(P, "Queued", "sign", "True", "=", ["the signer reads and proves the key and signs in its own memory; nothing committed"],
    ["H-116", "H-117", "H-027"], ["C4", "C20"], "Sign")
row(P, "Queued", "start_commit", "ledger_moved", "=", ["drop the bytes; the lane signs again at the new ledger (C4)"],
    ["H-171"], ["C4", "C5"], "StartCommit")
row(P, "Queued", "start_commit", "not ledger_moved and not wallet_usable", "Refused",
    ["switched off for the agent, archived, or the tool turned off meanwhile: drop the bytes (C17)"],
    ["H-054", "H-047", "H-118"], ["C4", "C17"], "StartCommit")
row(P, "Queued", "start_commit", "not ledger_moved and wallet_usable and payer == 'agent' and eff == 'deny'", "Refused",
    ["a Deny (or a forget under the default Deny) committed meanwhile: drop the bytes"], ["H-086", "H-118"], ["C4"],
    "StartCommit")
row(P, "Queued", "start_commit",
    "not ledger_moved and wallet_usable and not (payer == 'agent' and eff == 'deny') and not start_ok",
    "Waiting", ["Always revoked or forgotten meanwhile: ask again"], ["H-087", "H-088"], ["C4", "C10"], "StartCommit")
row(P, "Queued", "start_commit", "not ledger_moved and wallet_usable and start_ok and not fits", "Refused",
    ["the balance at the block read dropped meanwhile (C11)"], ["H-133"], ["C4", "C11"], "StartCommit")
row(P, "Queued", "start_commit", "not ledger_moved and wallet_usable and start_ok and fits", "Signed",
    ["take nonce = ledger; ledger + 1", "append the signed version with its hash (C6)", "sync before any byte leaves (C21)",
     "burn point: the lane owns the outcome (C13)"], ["H-112", "H-119", "H-129", "H-164", "H-165"],
    ["C4", "C5", "C6", "C13", "C21"], "StartCommit")
row(P, ["Waiting", "Refused", "NotPaid"], "start_commit", "True", "=",
    ["the payment left Queued while the signer held its bytes: drop them"], ["H-118"], ["C4"], "StartCommit")
row(P, ["Signed", "Sent"], "broadcast", "True", "Sent",
    ["send every committed version of the nonce, newest first; a timeout is not a failure"], ["H-113", "H-119", "H-184"],
    ["C6", "C12"], "Broadcast")
row(P, "Sent", "bump", "True", "=",
    ["the signer signs a version with both fees raised >= 12.5% (it needs the key and the fee reserve)",
     "commit the version and sync before any byte leaves (C21)", "then send it"], ["H-122", "H-172", "H-173"],
    ["C6", "C21"], "Bump")
row(P, "Sent", "cancel_replace", "True", "=",
    ["the owner's cancel: a zero-value transfer to the wallet itself at the same nonce, fees raised",
     "commit the version and sync before any byte leaves (C21)", "if it is mined the payment ends Cancelled, never Confirmed"],
    ["H-122", "H-124"], ["C6", "C13", "C21"], "CancelReplace")
row(P, "Sent", "receipt", "blk == 'own' or blk == 'own_cancel'", "Included",
    ["a committed version's receipt (paying or cancel) holds the nonce; its kind decides at finality"], ["H-175", "H-112"],
    ["C6", "C12"], "Track")
row(P, "Sent", "receipt", "blk == 'foreign' and blk_fin and verified", "Waiting",
    ["a finalized foreign transaction, signed by the wallet's key and agreed by the second RPC, took the nonce:",
     "ask the owner again, saying what happened (C7)"], ["H-167", "H-168"], ["C7"], "Track")
row(P, "Sent", "receipt", "blk == 'foreign' and blk_fin and not verified", "=",
    ["the lane stays frozen: 'the RPC's claim cannot be verified'; never re-sign on one source's word"],
    ["H-168", "H-186"], ["C7"], "LieForeign")
row(P, "Sent", "receipt", "blk == 'foreign' and not blk_fin", "=", ["wait for finalized; never re-sign at latest"], ["H-167"],
    ["C7"], "Track")
row(P, "Sent", "receipt", "blk == 'none'", "=", ["keep rebroadcasting; absence of a receipt never ends it"], ["H-179", "H-180"],
    ["C12"], "Track")
row(P, "Included", "reorg", "True", "Sent", ["back to Sent; rebroadcast in nonce order"], ["H-176", "H-181"], ["C5", "C12"],
    "Reorg")
row(P, "Included", "finality", "blk_fin and blk == 'own_cancel'", "Cancelled",
    ["the owner's cancel replacement is final: 'Not paid: cancelled' (the fee is spent)"], ["H-124"], ["C12", "C13"],
    "Settle")
row(P, "Included", "finality", "blk_fin and blk != 'own_cancel' and blk_ok", "Confirmed",
    ["the paying version is final: tell the chat it is confirmed (Confirmed only at finalized, C12)"], ["H-112", "H-201"],
    ["C12"], "Settle")
row(P, "Included", "finality", "blk_fin and blk != 'own_cancel' and not blk_ok and verified", "Failed",
    ["status 0, final and agreed by the second RPC: tell the chat it failed (C12)"], ["H-147", "H-189"], ["C12"], "Settle")
row(P, "Included", "finality", "blk_fin and blk != 'own_cancel' and not blk_ok and not verified", "=",
    ["a status 0 one source reports is not an outcome: stay Included and say the claim cannot be verified"],
    ["H-189"], ["C12"], "LieStatus0")
row(P, "Included", "finality", "not blk_fin", "=", ["shown as Included until final"], ["H-181"], ["C12"], "Settle")
row(P, ["Idle", "Waiting", "Queued", "Signed", "Sent", "Included"], "crash", "True", "=",
    ["resume from the last commit: the signer's bytes are lost before the start commit, kept after it"],
    ["H-114", "H-115", "H-116", "H-117", "H-119", "H-120", "H-121"], ["C4", "C6", "C13"], "Crash")
row(P, ["Idle", "Waiting", "Queued", "Signed", "Sent", "Included"], "power_loss", "True", "=",
    ["every wallet commit is synced before its result is acknowledged or leaves the machine (C21): power loss rolls the",
     "store back to the last synced commit, which is the last state anyone was told"], ["H-119", "H-120"], ["C21"],
    "PowerLoss")
row(P, ["Waiting", "Queued"], "restore_backup", "True", "Restored",
    ["the backup held it before its burn point: it may have been paid since, so it is never resumed",
     "'Not paid: restored from a backup; ask the agent again'; the lane is frozen until the owner reviews (C16)"],
    ["H-285"], ["C5", "C16"], "Restore")
row(P, ["Idle", "Signed", "Sent"], "restore_backup", "True", "=",
    ["past the burn point in the backup: its stored versions are tracked again against the chain"], ["H-285"],
    ["C6", "C16"], "Restore")
row(P, "Included", "restore_backup", "True", "Sent", ["tracked again from Sent: the chain decides"], ["H-285"],
    ["C12", "C16"], "Restore")

# ---------------------------------------------------------------- nonce allocation
N = "nonce"
row(N, "free", "lane_turn", "queued and can_sign and not chain_ahead", "signing", ["sign the head of the FIFO at the ledger"],
    ["H-164", "H-254"], ["C2", "C4"], "Sign")
row(N, "free", "lane_turn", "queued and not can_sign and not chain_ahead", "free",
    ["one owner Wait for the lane (unlock, restore, lease); nothing burnt"], ["H-026", "H-027"], ["C4", "C16"], "Sign")
row(N, "free", "lane_turn", "not queued and not chain_ahead", "free", [], ["H-202"], [], "Sign")
row(N, "free", "lane_turn", "chain_ahead", "blocked", ["an unexplained count above the ledger: block new starts"],
    ["H-166", "H-171"], ["C5", "C21"], "Sign")
row(N, "signing", "start_commit", "not ledger_moved and recheck_ok", "in_flight", ["nonce = ledger; ledger + 1 in the same commit"],
    ["H-112", "H-165"], ["C4", "C5"], "StartCommit")
row(N, "signing", "start_commit", "ledger_moved or not recheck_ok", "free", ["drop the bytes; nothing burnt"],
    ["H-118", "H-171"], ["C4"], "Redo")
row(N, "signing", "crash", "True", "free", ["the bytes in the signer's memory are lost; nothing was committed"], ["H-117"],
    ["C4"], "Crash")
row(N, "in_flight", "included_latest", "not more_in_flight", "free", ["the next effect may start (one in flight)"],
    ["H-112"], ["C5"], "Track")
row(N, "in_flight", "included_latest", "more_in_flight", "in_flight", ["after a reorg: the next stored nonce is still in flight"],
    ["H-176"], ["C5"], "Track")
row(N, "in_flight", "foreign_at_nonce", "above_final and verified", "free",
    ["release the effect to the owner (C7); the ledger stays above it"], ["H-167"], ["C7"], "Track")
row(N, "in_flight", "foreign_at_nonce", "above_final and not verified", "in_flight",
    ["frozen: the foreign transaction is not proven by its signature and a second RPC (TA-4)"], ["H-168"], ["C7"], "Track")
row(N, "in_flight", "foreign_at_nonce", "not above_final", "in_flight", ["wait for finalized"], ["H-167"], ["C7"], "Track")
row(N, ["in_flight", "free"], "reorg_undoes_inclusion", "True", "in_flight",
    ["the effect is Sent again; rebroadcast consecutive nonces in order"], ["H-176", "H-181"], ["C5", "C12"], "Reorg")
row(N, "in_flight", "crash", "True", "in_flight", ["rebroadcast the committed bytes; no new nonce"], ["H-113", "H-119"],
    ["C6"], "Crash")
row(N, "signing", "power_loss", "True", "free", ["the signer's bytes are lost; nothing was committed"], ["H-117"],
    ["C4", "C21"], "PowerLoss")
row(N, ["free", "in_flight", "blocked"], "power_loss", "True", "=",
    ["the start commit was synced before its bytes left (C21): the ledger and the stored versions survive"],
    ["H-119", "H-165"], ["C21"], "PowerLoss")
row(N, "blocked", "finality", "above_final", "free", ["raise the ledger to the chain's count (never lower)"],
    ["H-166", "H-171"], ["C5"], "RaiseLedger")
row(N, "blocked", "finality", "not above_final", "blocked", ["wait; a reorg may still remove the foreign transaction"],
    ["H-171"], ["C5"], "RaiseLedger")

# ---------------------------------------------------------------- x402
X = "x402"
row(X, "none", "proxy_sees_402", "verified", "observed",
    ["record the observation (chat, URL as reached over TLS, requirement as received)", "sync before the 402 reaches the box (C21)"],
    ["H-216", "H-229", "H-231"], ["C18", "C21"], "Observe")
row(X, "none", "proxy_sees_402", "not verified", "none", ["no observation: unknown asset, scheme, network or domain"],
    ["H-224", "H-231", "H-232"], ["C18"], "Observe")
row(X, "observed", "call", "not same_chat", "observed", ["refuse: another chat's observation (C18)"], ["H-218", "H-221"],
    ["C18"], "Call")
row(X, "observed", "call", "same_chat and eff == 'deny'", "refused", ["'the owner doesn't pay this endpoint'"], ["H-076"],
    ["C3", "C18"], "Call")
row(X, "observed", "call", "same_chat and eff != 'deny' and not fits", "refused", ["refused with the available amount"],
    ["H-240"], ["C11"], "Call")
row(X, "observed", "call", "same_chat and eff == 'always' and fits", "authorizing", ["reserve (C11)"], ["H-216", "H-238"],
    ["C11", "C18"], "Call")
row(X, "observed", "call", "same_chat and eff == 'ask' and fits", "waiting", ["open the card: endpoint, payTo, amount"],
    ["H-216", "H-223"], ["C18"], "Call")
row(X, "waiting", "card_pay", "window_left and not host_ok", "=",
    ["a paired device's Pay to an endpoint the host never confirmed: the card stays a host Wait"], ["H-277", "H-280"],
    ["C9", "C16"], "Pay")
row(X, "waiting", "card_pay", "window_left and host_ok", "authorizing", ["approve this one (R-9: sign now with a fresh window)"],
    ["H-241"], ["C10", "C19"], "Pay")
row(X, "waiting", "card_pay", "not window_left", "notpaid", ["'Not paid: the request expired'"], ["H-241"], ["C10"], "Pay")
row(X, "waiting", "card_always", "window_left and not host_ok", "=",
    ["Always from a paired device on an endpoint the host never confirmed: a host Wait"], ["H-277", "H-280"],
    ["C9", "C16"], "AlwaysPay")
row(X, "waiting", "card_always", "window_left and host_ok", "authorizing", ["Always for (agent, endpoint, payTo, asset, network)"],
    ["H-216", "H-223"], ["C9", "C18"], "AlwaysPay")
row(X, "waiting", "card_always", "not window_left", "notpaid", ["set Always; this one expired"], ["H-241"], ["C10"], "AlwaysPay")
row(X, "waiting", "card_never", "True", "refused", ["Deny for the key; sweep its open asks"], ["H-084"], ["C9"], "NeverPay")
row(X, "waiting", "card_dont_pay", "True", "refused", [], [], ["C9"], "DontPay")
row(X, ["waiting", "authorizing"], "deadline", "True", "notpaid", ["24 h with no answer or no start"], ["H-241", "H-310"],
    ["C10"], "Deadline")
row(X, "authorizing", "authorization_commit", "eff == 'deny'", "refused", ["a Deny committed meanwhile"], ["H-086"], ["C4"],
    "Authorize")
row(X, "authorizing", "authorization_commit", "eff != 'deny' and eff != 'always' and not approved", "waiting",
    ["Always revoked meanwhile: ask again"], ["H-087"], ["C4"], "Authorize")
row(X, "authorizing", "authorization_commit", "eff != 'deny' and (eff == 'always' or approved) and not fits", "refused",
    ["the balance dropped (C11)"], ["H-239", "H-240"], ["C11"], "Authorize")
row(X, "authorizing", "authorization_commit", "eff != 'deny' and (eff == 'always' or approved) and fits", "authorized",
    ["nonce = keccak256('banda/x402' || wallet || observation id) (R-5)",
     "validAfter = min(c, w) - 5 s, validBefore = max(c, w) + min(maxTimeoutSeconds, 60 s), c the latest block's time, w the wall clock (C19)",
     "domain from banda's chain definition (H-224)", "commit message and nonce before any signature exists"],
    ["H-216", "H-225", "H-227", "H-250"], ["C14", "C19", "C21"], "Authorize")
row(X, "authorized", "hand_header", "synced", "handed",
    ["the signer signs the stored message in its memory (SignAuth)", "give the box PAYMENT-SIGNATURE (Give)",
     "commit handed (CommitHanded); a crash between them re-signs the same message: same derived nonce"],
    ["H-226", "H-234"], ["C20", "C21"], "Give")
row(X, "authorized", "hand_header", "not synced", "authorized", ["wait for the sync (C21)"], ["H-235"], ["C21"], "SignAuth")
row(X, ["authorized", "handed"], "agent_pays_again", "True", "=",
    ["return the stored authorization: same derived nonce (C14)"], ["H-227", "H-228"], ["C14"], "Call")
row(X, "handed", "follow", "event == 'used' and event_fin", "settled", ["record the settlement; release the reservation"],
    ["H-245", "H-249"], ["C12"], "Track")
row(X, "handed", "follow", "event == 'cancelled' and event_fin", "cancelled", ["the owner's cancelAuthorization landed first"],
    ["H-242", "H-251"], ["C12"], "Track")
row(X, "handed", "follow", "event != 'none' and not event_fin", "handed", ["shown as reported until final"], ["H-236", "H-245"],
    ["C12"], "Track")
row(X, "handed", "follow", "event == 'none' and vb_passed_fin", "expired",
    ["no settlement can appear any more: Expired, release the reservation (C19)"], ["H-237"], ["C11", "C19"], "Track")
row(X, "handed", "follow", "event == 'none' and not vb_passed_fin", "handed", ["keep the reservation"], ["H-239"], ["C11"],
    "Track")
row(X, ["observed", "waiting", "authorizing", "authorized", "handed"], "crash", "True", "=",
    ["resume from the last commit; a re-sign yields the same derived nonce"], ["H-234", "H-235", "H-248"], ["C14", "C21"],
    "Crash")
row(X, ["observed", "waiting", "authorizing", "authorized", "handed"], "power_loss", "True", "=",
    ["every x402 commit is synced before its result reaches the box or the owner (C21)"], ["H-235"], ["C21"], "PowerLoss")


# ---------------------------------------------------------------- links between machines
# What one machine's atom says about another machine's state, for a scenario's contexts to stay coherent (the
# composition PaymentLane.tla checks; check-scenarios.mjs S10). A key is "machine" (its state) or "machine.atom".
# At every event of a machine whose atom a link names, when every "if" key is set and holds, every "then" key that is
# set must hold too.
RUNNING = ["none", "creating", "archived", "removing", "removed", "dropped"]
LINKS = [
    {"if": {"payment.rule": ["deny"]}, "then": {"recipient": ["deny"], "permission": ["none"]},
     "why": "Deny is the recipient's, for every agent of the wallet (OD-1)"},
    {"if": {"recipient": ["deny"]}, "then": {"payment.rule": ["deny"]},
     "why": "a payment meets the recipient's Deny (C3 step 7)"},
    {"if": {"payment.rule": ["unknown"]}, "then": {"recipient": ["unknown"], "permission": ["none"]},
     "why": "an unknown recipient has no entry and no permission"},
    {"if": {"recipient": ["unknown"]}, "then": {"payment.rule": ["unknown"]}, "why": "the same, the other way"},
    {"if": {"payment.rule": ["always"]}, "then": {"recipient": ["ask"], "permission": ["always"]},
     "why": "Always is this agent's permission on a known, not denied recipient"},
    {"if": {"payment.rule": ["ask"]}, "then": {"recipient": ["ask"], "permission": ["none"]},
     "why": "Ask: known, not denied, no permission for this agent"},
    {"if": {"permission": ["always"]}, "then": {"recipient": ["ask"], "permission.rcpt": ["ask"]},
     "why": "a permission lives only under a known recipient that is not denied (PermissionUnderRecipient)"},
    {"if": {"wallet": RUNNING}, "then": {"payment.wallet_usable": [False], "nonce.can_sign": [False]},
     "why": "a wallet that is not ready pays nothing (C3 step 1, C17)"},
    {"if": {"signing": ["locked", "key_missing", "wrong_key", "other_home", "offline_host_mode"]},
     "then": {"payment.wallet_usable": [False], "nonce.can_sign": [False]},
     "why": "an offline signer signs nothing (C3 step 6, C16)"},
    {"if": {"wallet.has_code": [True]}, "then": {"payment.wallet_usable": [False]},
     "why": "an address with code pays nothing until the owner acknowledged it (H-157)"},
]


def main():
    doc = {
        "about": ("Canonical deterministic transition table of the wallet's machines (docs/wallets/model). "
                  "Guards are Python boolean expressions over each machine's atoms; for every (machine, from, event) "
                  "the guards are mutually exclusive and exhaustive over the atoms' domains "
                  "(check_transitions.py proves it by enumeration). 'to' equal to 'from' answers the event without "
                  "a state change. 'tla' names the action of the TLA+ module that models the row."),
        "date": "2026-11-23",
        "machines": MACHINES,
        "links": LINKS,
        "transitions": ROWS,
    }
    with open(os.path.join(HERE, "transitions.json"), "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print(f"{len(ROWS)} rows")


if __name__ == "__main__":
    main()
