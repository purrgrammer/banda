"""Checks transitions.json, the oracle of the wallet's Gherkin scenarios.

For every (machine, from, event) it enumerates every valuation of the machine's atoms and checks that exactly
one guard holds (mutually exclusive and exhaustive). It also checks that every state named is declared, that
terminal states have no outgoing change, that every hazard id exists in ../hazards.md and every rule id in
../conflicts.md, that every "tla" names a definition of the module the machine is modelled in, and that the
payment machine's state-changing edges are exactly PaymentLane.tla's Edges (ForwardOnly), rewinds aside.
Run: python3 -I check_transitions.py   (exit 1 on any failure)
"""
import itertools
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
fail = []


def read(path):
    with open(os.path.join(HERE, path)) as f:
        return f.read()


doc = json.loads(read("transitions.json"))
machines = doc["machines"]
rows = doc["transitions"]
hazard_ids = set(re.findall(r"\bH-\d{3}\b", read("../hazards.md")))
rule_ids = set(re.findall(r"\bC\d{1,2}\b", read("../conflicts.md")))


def valuations(m):
    names = list(m["atoms"])
    for combo in itertools.product(*(m["atoms"][n] for n in names)):
        env = dict(zip(names, combo))
        for k, expr in m["defs"].items():
            env[k] = eval(expr, {}, dict(env))
        yield env


groups = {}
for r in rows:
    groups.setdefault((r["machine"], r["from"], r["event"]), []).append(r)

for (mn, frm, ev), rs in groups.items():
    m = machines.get(mn)
    if m is None:
        fail.append(f"{mn}: unknown machine")
        continue
    for r in rs:
        for s in (r["from"], r["to"]):
            if s not in m["states"]:
                fail.append(f"{mn}: {frm} --{ev}--> {r['to']}: undeclared state {s}")
        if r["from"] in m["terminal"] and r["to"] != r["from"]:
            fail.append(f"{mn}: terminal {frm} changes on {ev}")
        for h in r["hazards"]:
            if h not in hazard_ids:
                fail.append(f"{mn}: {frm}/{ev}: hazard {h} not in hazards.md")
        for c in r["rules"]:
            if c not in rule_ids:
                fail.append(f"{mn}: {frm}/{ev}: rule {c} not in conflicts.md")
    n_val = 0
    for env in valuations(m):
        n_val += 1
        held = [r for r in rs if eval(r["guard"], {}, dict(env))]
        if len(held) != 1:
            kind = "no guard holds" if not held else f"{len(held)} guards hold"
            fail.append(f"{mn}: {frm} --{ev}: {kind} at {env}")
            break

# Every "tla" names a definition of the machine's module.
defs = {}
for mn, m in machines.items():
    mod = m["tla"]
    if mod not in defs:
        defs[mod] = set(re.findall(r"^(\w+)\s*(?:\([^)]*\))?\s*==", read(mod + ".tla"), re.M))
for r in rows:
    if r["tla"] and r["tla"] not in defs[machines[r["machine"]]["tla"]]:
        fail.append(f"{r['machine']}: {r['from']}/{r['event']}: {r['tla']} is not defined in {machines[r['machine']]['tla']}.tla")

# The payment machine's edges are PaymentLane's ForwardOnly Edges.
m = re.search(r"^Edges == \{(.*?)\}\s*$", read("PaymentLane.tla"), re.M | re.S)
tla_edges = set(re.findall(r'<<"(\w+)", "(\w+)">>', m.group(1)))
# Rows of a rewind (power loss, a backup restored) roll the store back: PaymentLane exempts them from ForwardOnly
# (its Rewind), so they are compared with RestoredSt instead of Edges.
REWIND = {"power_loss", "restore_backup"}
json_edges = {(r["from"], r["to"]) for r in rows
              if r["machine"] == "payment" and r["from"] != r["to"] and r["event"] not in REWIND}
rewind = {(r["from"], r["to"]) for r in rows if r["machine"] == "payment" and r["event"] == "restore_backup"}
want_rewind = {("Waiting", "Restored"), ("Queued", "Restored"), ("Included", "Sent")}  # RestoredSt, ResumeRestored off
if {e for e in rewind if e[0] != e[1]} != want_rewind:
    fail.append(f"payment: restore_backup rows {sorted(rewind)} do not match PaymentLane.RestoredSt {sorted(want_rewind)}")
for r in rows:
    if r["event"] == "power_loss" and r["from"] != r["to"] and r["machine"] != "nonce":
        fail.append(f"{r['machine']}: {r['from']}/power_loss changes state: with every commit synced (C21) power loss "
                    "returns to the last state anyone was told")
for e in sorted(tla_edges - json_edges):
    fail.append(f"payment: edge {e} is in PaymentLane Edges but not in transitions.json")
for e in sorted(json_edges - tla_edges):
    fail.append(f"payment: edge {e} is in transitions.json but not in PaymentLane Edges")

# Every non-terminal state of every machine has a way out, and every state is reached.
for mn, m in machines.items():
    mine = [r for r in rows if r["machine"] == mn]
    reached = {m["initial"]}
    changed = True
    while changed:
        changed = False
        for r in mine:
            if r["from"] in reached and r["to"] not in reached:
                reached.add(r["to"])
                changed = True
    for s in m["states"]:
        if s not in reached:
            fail.append(f"{mn}: state {s} is never reached from {m['initial']}")
        if s not in m["terminal"] and not any(r["from"] == s and r["to"] != s for r in mine):
            fail.append(f"{mn}: non-terminal state {s} has no way out")

# Every link names declared machines, states and atom values.
for i, ln in enumerate(doc.get("links", [])):
    for side in ("if", "then"):
        for key, vals in ln[side].items():
            mn, _, atom = key.partition(".")
            m = machines.get(mn)
            dom = None if m is None else (m["atoms"].get(atom) if atom else m["states"])
            if dom is None:
                fail.append(f"link {i}: {key} names no machine, state set or atom")
            elif any(v not in dom for v in vals):
                fail.append(f"link {i}: {key} {vals} not in {dom}")

print(f"{len(rows)} rows, {len(groups)} (machine, from, event) groups, {len(machines)} machines")
if fail:
    print("\n".join(fail))
    print(f"FAIL: {len(fail)}")
    sys.exit(1)
print("OK: guards mutually exclusive and exhaustive; states, hazards, rules, TLA actions and Edges consistent")
