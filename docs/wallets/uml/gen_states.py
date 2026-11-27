"""Generate one PlantUML state diagram per machine from ../model/transitions.json.

Every row of the table becomes exactly one line of a diagram:
- a row whose `to` differs from `from` is a line of the arrow from -> to (rows sharing a pair share one arrow);
- a row whose `to` equals `from` (the event is answered without a state change) is an internal line of the state.

Each emitted line is preceded by a `' row <index>` comment, and `--check` reparses the written files and proves that
every row index of the table appears exactly once, in the diagram of its machine, with its event, guard and target.

Usage (from this folder, standard library only):
    python3 -I gen_states.py           # writes state-<machine>.puml
    python3 -I gen_states.py --check   # verifies the written files against the table
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, "..", "model", "transitions.json")


def alias(machine, state):
    return f"{machine}_{state}"


def label(row):
    rules = ",".join(row["rules"]) if row["rules"] else "-"
    guard = row["guard"]
    # The guard is printed as the table holds it; "True" means unguarded.
    g = "" if guard == "True" else f" [{guard}]"
    return f"{row['event']}{g} / {row['tla']} ({rules})"


def escape(text):
    # PlantUML reads "\n" in a label as a line break; the guards hold no backslash, so only that is guarded.
    return text.replace("\\", "\\\\")


def render(machine, spec, rows):
    lines = []
    out = lines.append
    indexed = [(i, r) for i, r in rows]
    out(f"@startuml state-{machine}")
    out("!include style.iuml")
    out("hide empty description")
    out("skinparam stateFontStyle bold")
    out("skinparam stateAttributeFontSize 10")
    out("skinparam stateAttributeFontStyle plain")
    out("skinparam ArrowFontSize 10")
    title = (
        f"{machine} machine ({spec['tla']}.tla), generated from model/transitions.json: "
        f"{len(indexed)} rows, {len(spec['states'])} states"
    )
    out(f"title {title}")
    out("")
    # Legend: the machine's atoms (guard variables) and named definitions.
    out("legend top left")
    out("Guard atoms and their domains")
    for atom, dom in spec["atoms"].items():
        values = ", ".join(json.dumps(v) if isinstance(v, str) else str(v) for v in dom)
        out(f"  {atom} in {{{values}}}")
    if spec["defs"]:
        out("Definitions")
        for name, expr in spec["defs"].items():
            out(f"  {name} = {escape(expr)}")
    out("Label: event [guard] / TLA+ action (conflicts.md rules)")
    out("Lines inside a state answer the event without a state change.")
    out("endlegend")
    out("")
    terminal = set(spec["terminal"])
    for s in spec["states"]:
        stereo = " <<terminal>>" if s in terminal else ""
        out(f'state "{s}" as {alias(machine, s)}{stereo}')
    out("")
    out(f"[*] --> {alias(machine, spec['initial'])}")
    for s in spec["states"]:
        if s in terminal:
            out(f"{alias(machine, s)} --> [*]")
    out("")
    # Internal lines (self rows), grouped by state in table order.
    for s in spec["states"]:
        for i, r in indexed:
            if r["from"] == s and r["to"] == s:
                out(f"' row {i}")
                out(f"{alias(machine, s)} : {escape(label(r))}")
    out("")
    # Arrows, one per (from, to) pair, its rows in table order.
    pairs = []
    for i, r in indexed:
        if r["from"] != r["to"]:
            key = (r["from"], r["to"])
            if key not in [p[0] for p in pairs]:
                pairs.append((key, []))
            for p in pairs:
                if p[0] == key:
                    p[1].append((i, r))
    for (src, dst), members in pairs:
        for i, _ in members:
            out(f"' row {i}")
        text = "\\n".join(escape(label(r)) for _, r in members)
        out(f"{alias(machine, src)} --> {alias(machine, dst)} : {text}")
    out("@enduml")
    return "\n".join(lines) + "\n"


def load():
    with open(TABLE, encoding="utf-8") as f:
        return json.load(f)


def write(table):
    rows = list(enumerate(table["transitions"]))
    for machine, spec in table["machines"].items():
        mine = [(i, r) for i, r in rows if r["machine"] == machine]
        path = os.path.join(HERE, f"state-{machine}.puml")
        with open(path, "w", encoding="utf-8") as f:
            f.write(render(machine, spec, mine))
        print(f"wrote {os.path.basename(path)}: {len(mine)} rows")


def check(table):
    rows = table["transitions"]
    seen = {}
    problems = []
    for machine, spec in table["machines"].items():
        path = os.path.join(HERE, f"state-{machine}.puml")
        with open(path, encoding="utf-8") as f:
            text = f.read().splitlines()
        declared = set(re.findall(r'^state "([^"]+)" as ', "\n".join(text), flags=re.M))
        if declared != set(spec["states"]):
            problems.append(f"{machine}: declared states {sorted(declared)} != table {sorted(spec['states'])}")
        k = 0
        while k < len(text):
            m = re.match(r"^' row (\d+)$", text[k])
            if not m:
                k += 1
                continue
            # Consecutive row comments belong to the next non-comment line.
            idxs = []
            while k < len(text) and re.match(r"^' row (\d+)$", text[k]):
                idxs.append(int(re.match(r"^' row (\d+)$", text[k]).group(1)))
                k += 1
            body = text[k]
            for i in idxs:
                r = rows[i]
                if i in seen:
                    problems.append(f"row {i} emitted twice ({seen[i]} and {machine})")
                seen[i] = machine
                if r["machine"] != machine:
                    problems.append(f"row {i} of {r['machine']} found in {machine}")
                src = alias(machine, r["from"])
                dst = alias(machine, r["to"])
                if r["from"] == r["to"]:
                    ok = body == f"{src} : {escape(label(r))}"
                else:
                    ok = body.startswith(f"{src} --> {dst} : ") and escape(label(r)) in body.split(" : ", 1)[1].split("\\n")
                if not ok:
                    problems.append(f"row {i} not faithfully rendered: {body[:120]}")
            k += 1
    missing = sorted(set(range(len(rows))) - set(seen))
    if missing:
        problems.append(f"rows never emitted: {missing}")
    if problems:
        print("\n".join(problems))
        return 1
    print(f"ok: {len(rows)} of {len(rows)} rows emitted exactly once, across {len(table['machines'])} machines")
    return 0


if __name__ == "__main__":
    t = load()
    if "--check" in sys.argv:
        sys.exit(check(t))
    write(t)
