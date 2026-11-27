"""Explicit-state model check of one wallet's lane (docs/wallets/conflicts.md).

Exhaustive breadth-first search over every interleaving of: the lane (start, fused commit, broadcast, fee bump,
receipt tracking), the owner (Pay, rule changes, cancelling the run), the chain (mining, finalizing, a one-block
reorg), a foreign spend with the exported key, crashes, and power loss. Two intents, bounded counters.

Run: python3 -I model.py            (all variants; exit status 1 if the full rule set fails)
Each variant switches one rule of conflicts.md off; the full set must hold every invariant, and each weakened set
must produce the counterexample that rule exists to prevent.
"""
import sys
from collections import deque

# intent: (st, nonce, nvers, rep, approved, signed_under_deny)
# st: Q queued, W waiting for the owner, S signed+committed, T sent, I included, R refused
INFLIGHT = ("S", "T")


def initial(rule="K"):
    intents = tuple(("Q", -1, 0, None, False, False) for _ in range(2))
    return dict(ledger=0, chain=(), mempool=frozenset(), rule=rule, intents=intents, mem=None, unsynced=None,
                frozen=False, crashes=2, rules=2, foreign=1, reorgs=1, bumps=1, cancels=1)


def freeze(s):
    return tuple(sorted((k, v) for k, v in s.items()))


def thaw(t):
    return dict(t)


def setint(s, i, **kw):
    it = list(s["intents"])
    names = ("st", "nonce", "nvers", "rep", "approved", "sud")
    cur = dict(zip(names, it[i]))
    cur.update(kw)
    it[i] = tuple(cur[n] for n in names)
    s["intents"] = tuple(it)


def st(s, i):
    return s["intents"][i][0]


def head_ok(s, i):
    # FIFO (C2): earlier intents must be past the lane (included or refused); one in flight (C5)
    if any(st(s, j) in INFLIGHT for j in range(2)):
        return False
    return all(st(s, j) in ("I", "R") for j in range(i))


def steps(s, v):
    out = []

    def nxt(label, **changes):
        n = dict(s)
        n.update(changes)
        return label, n

    for i in range(2):
        it = s["intents"][i]
        # lane: start (rule check, key read and sign in the signer's memory)
        if st(s, i) == "Q" and head_ok(s, i) and s["mem"] is None and not s["frozen"]:
            n = dict(s)
            if s["rule"] == "D":
                setint(n, i, st="R", rep="refused")
                out.append((f"start-refuse{i}", n))
            elif s["rule"] == "K" and not it[4]:
                setint(n, i, st="W")
                out.append((f"start-ask{i}", n))
            else:
                n["mem"] = (i, s["ledger"])
                out.append((f"sign{i}", n))
        # lane: the fused start commit (C4): re-check the rule, take the nonce, store the bytes
        if s["mem"] is not None and s["mem"][0] == i:
            n = dict(s)
            n["mem"] = None
            if st(s, i) != "Q" and "no_C4" not in v:
                # the intent was refused (cancel, a Deny's sweep) while the signer held its bytes: drop them
                out.append((f"commit-drop{i}", n))
            elif s["rule"] == "D" and "no_C4" not in v:
                setint(n, i, st="R", rep="refused")
                out.append((f"commit-refuse{i}", n))
            else:
                nonce = s["mem"][1]
                n["ledger"] = nonce + 1
                if "no_C21" in v:  # commit not yet durable: a power loss can drop it
                    n["unsynced"] = (i, s["intents"][i], s["ledger"])
                setint(n, i, st="S", nonce=nonce, nvers=1, sud=(s["rule"] == "D"))
                out.append((f"commit{i}", n))
        # lane: broadcast every stored version (C6)
        if st(s, i) in INFLIGHT:
            n = dict(s)
            n["mempool"] = s["mempool"] | {(it[1], i, k) for k in range(it[2])}
            setint(n, i, st="T")
            if n != s:
                out.append((f"broadcast{i}", n))
        # lane: fee bump appends a version of the same nonce
        if st(s, i) == "T" and s["bumps"] > 0:
            n = dict(s, bumps=s["bumps"] - 1)
            setint(n, i, nvers=it[2] + 1)
            out.append((f"bump{i}", n))
        # lane: track the receipt (C12) or the foreign use of the nonce (C7)
        if st(s, i) == "T" and len(s["chain"]) > it[1]:
            tag, fin = s["chain"][it[1]]
            n = dict(s)
            if tag == i:
                setint(n, i, st="I", rep="paid")
                out.append((f"included{i}", n))
            elif tag == "F" and (fin or "no_C7" in v):
                setint(n, i, st="W", nonce=-1, nvers=0, approved=False)  # asks the owner again (C10)
                out.append((f"foreign-readmit{i}", n))
        # owner: Pay on the card
        if st(s, i) == "W":
            n = dict(s)
            setint(n, i, st="Q", approved=True)
            out.append((f"pay{i}", n))
        # owner: cancel the chat's run (C13: only before the burn point)
        if s["cancels"] > 0 and (st(s, i) in ("Q", "W") or ("no_C13" in v and st(s, i) in INFLIGHT)):
            n = dict(s, cancels=s["cancels"] - 1)
            if s["mem"] is not None and s["mem"][0] == i:
                n["mem"] = None
            setint(n, i, st="R", rep="refused")
            out.append((f"cancel{i}", n))
    # owner: rule change; a Deny answers the asks it covers (C9)
    if s["rules"] > 0:
        for r in ("A", "K", "D"):
            if r != s["rule"]:
                n = dict(s, rule=r, rules=s["rules"] - 1)
                if r == "D":
                    for i in range(2):
                        if st(n, i) in ("W", "Q"):
                            setint(n, i, st="R", rep="refused")
                out.append((f"rule-{r}", n))
    # chain: mine one transaction at the next nonce
    for tx in s["mempool"]:
        if tx[0] == len(s["chain"]):
            n = dict(s)
            n["chain"] = s["chain"] + ((tx[1], False),)
            n["mempool"] = frozenset(t for t in s["mempool"] if t[0] != tx[0])
            out.append((f"mine{tx[1]}@{tx[0]}", n))
    # chain: finalize the oldest unfinalized block
    for k, (tag, fin) in enumerate(s["chain"]):
        if not fin:
            ch = list(s["chain"])
            ch[k] = (tag, True)
            out.append(("finalize", dict(s, chain=tuple(ch))))
            break
    # chain: a reorg drops the newest unfinalized block; peers still hold the dropped nonce's other versions
    if s["reorgs"] > 0 and s["chain"] and not s["chain"][-1][1]:
        k = len(s["chain"]) - 1
        tag = s["chain"][-1][0]
        n = dict(s, chain=s["chain"][:-1], reorgs=s["reorgs"] - 1)
        # every version ever broadcast at nonce k is still in some peer's pool (worst case)
        back = set()
        for i in range(2):
            it = n["intents"][i]
            if it[1] == k and it[0] in ("T", "I"):
                setint(n, i, st="T", rep=None if it[3] == "paid" else it[3])
        back |= {t for t in s.get("seen", frozenset()) if t[0] == k and t[1] != "F"}
        if tag != "F":  # a foreign transaction vanishes (worst case); ours returns to the pool
            back.add((k, tag, 0))
        n["mempool"] = s["mempool"] | back
        out.append(("reorg", n))
    # the exported key spends once at the chain's next nonce
    if s["foreign"] > 0:
        out.append(("foreign-send", dict(s, foreign=0, mempool=s["mempool"] | {(len(s["chain"]), "F", 0)})))
    # power loss: an undurable commit is lost (only possible without C21)
    if s["unsynced"] is not None:
        i, old, oldledger = s["unsynced"]
        n = dict(s, unsynced=None, mem=None, ledger=oldledger)
        it = list(n["intents"])
        it[i] = old
        n["intents"] = tuple(it)
        out.append(("power-loss", restart(n, v)))
        out.append(("sync", dict(s, unsynced=None)))
    # crash: memory lost, tool tasks rerun, the lane reconciles at start
    if s["crashes"] > 0:
        n = dict(s, crashes=s["crashes"] - 1, mem=None, unsynced=None)
        out.append(("crash", restart(n, v)))
    return out


def restart(n, v):
    # tool reruns: with stored bytes the outcome is "may have sent" (C13); the buggy rerun says "did not run"
    if "rerun_bug" in v and n["rule"] == "D":
        for i in range(2):
            if st(n, i) in INFLIGHT:
                setint(n, i, rep="did_not_run")
    # C5: ledger = max(ledger, chain); C21: a chain count above the ledger that the store cannot explain freezes
    if len(n["chain"]) > n["ledger"]:
        if "no_C21" in v:
            n["ledger"] = len(n["chain"])
        else:
            n["frozen"] = True
    return n


def violations(s):
    bad = []
    tags = [t for t, _ in s["chain"]]
    for i in range(2):
        st_, nonce, nv, rep, appr, sud = s["intents"][i]
        if tags.count(i) > 1:
            bad.append(f"I1 intent {i} paid twice")
        if rep in ("refused", "did_not_run") and i in tags:
            bad.append(f"I3 intent {i} reported '{rep}' but paid")
        if rep == "paid" and i not in tags:
            bad.append(f"I4 intent {i} reported paid, not on chain")
        if sud:
            bad.append(f"I6 intent {i} signed after a Deny committed")
    # I5 no gap: every nonce below the ledger is held by a stored intent or used on chain
    held_or_used = {s["intents"][i][1] for i in range(2)} | set(range(len(s["chain"])))
    if any(k not in held_or_used for k in range(s["ledger"])):
        bad.append("I5 a nonce below the ledger is neither held nor used (gap)")
    # I8 one in flight, except after a reorg undid an inclusion (then in nonce order, consecutive from the chain)
    fl = sorted(s["intents"][i][1] for i in range(2) if st(s, i) in INFLIGHT)
    if len(fl) > 1 and (s["reorgs"] > 0 or fl != list(range(fl[0], fl[0] + len(fl)))):
        bad.append("I8 two nonces in flight without a reorg, or out of order")
    held = [s["intents"][i][1] for i in range(2) if s["intents"][i][1] >= 0]
    if len(held) != len(set(held)):
        bad.append("I7 two intents hold one nonce")
    return bad


def check(variant, rule0="K", target=None):
    v = set(variant)
    s0 = initial(rule0)
    # "seen": every transaction ever broadcast stays in some peer's pool (worst case for reorgs)
    s0["seen"] = frozenset()
    start = freeze(s0)
    parent = {start: None}
    q = deque([start])
    while q:
        cur = q.popleft()
        s = thaw(cur)
        bad = [b for b in violations(s) if target is None or b.startswith(target)]
        if bad:
            trace = []
            k = cur
            while parent[k] is not None:
                k, lab = parent[k]
                trace.append(lab)
            return len(parent), bad, list(reversed(trace))
        for lab, n in steps(s, v):
            n["seen"] = n.get("seen", frozenset()) | n["mempool"]
            fk = freeze(n)
            if fk not in parent:
                parent[fk] = (cur, lab)
                q.append(fk)
    return len(parent), [], []


VARIANTS = [
    ((), "all rules"),
    (("no_C7",), "C7 off, looking for a double payment", "I1"),
    (("no_C21",), "C21 off, looking for a double payment", "I1"),
    (("no_C4",), "C4 off: the start commit does not re-check the rule"),
    (("no_C7",), "C7 off: re-admit after a foreign nonce at latest, not finalized"),
    (("no_C13",), "C13 off: cancelling the run refuses a payment past the burn point"),
    (("no_C21",), "C21 off: the start commit may be lost to power loss; restart takes max(ledger, chain)"),
    (("rerun_bug",), "the idempotent rerun reports 'did not run' under a Deny (banda-integration spike)"),
]

if __name__ == "__main__":
    ok = True
    for entry in VARIANTS:
        variant, label = entry[0], entry[1]
        target = entry[2] if len(entry) > 2 else None
        for rule0 in ("K", "A"):
            n, bad, trace = check(variant, rule0, target)
            status = "holds" if not bad else "VIOLATED: " + "; ".join(bad)
            print(f"[{label}] initial rule {rule0}: {n} states, {status}")
            if bad:
                print("   trace: " + " -> ".join(trace))
            if not variant and bad:
                ok = False
    sys.exit(0 if ok else 1)
