"""Checks the wallet's Gherkin scenarios against the transition table, the step vocabulary and the use cases.

Every scenario is replayed against ../model/transitions.json, the only source of outcomes:

- every step phrase matches exactly one phrase of STEPS.md, and its keyword fits the phrase's kind
  (state: Given or Then; atom: Given; event: When; invariant: Then; And/But inherit the keyword before them);
- a `Given` state sets a machine's state before its first event; an atom step sets one atom of one machine and
  holds until another step of the same atom changes it;
- at each event, every completion of the atoms the scenario left unset must select the same row of the table
  (the scenario is fully determined), and the machine moves to that row's `to`;
- a `Then` state equals the state the table gives; an invariant names a definition of its TLA+ module;
- the scenario's `@t:<machine>:<from>:<event>:<guard>` tags are exactly the rows it exercised (outline: per Examples
  block), the guard written as `slug(guard)` below;
- every scenario carries at least one `@UC-xx` of an in-scope use case of ../use-cases.md and at least one `@H-xxx`,
  and every `@H-xxx` is listed under one of its use cases.

It also checks the traceability of ../use-cases.md: every hazard of ../hazards.md is listed by at least one use case
(in or out of scope), and it reports which rows, use cases and hazards the scenarios cover.

Run:   python3 -I check_features.py              (exit 1 on any failure)
       python3 -I check_features.py --fix-tags   (rewrites the @t tags from the replay, then checks)
       python3 -I check_features.py --coverage   (also lists rows and hazards no scenario covers)
       python3 -I check_features.py --slugs      (prints the tag of every row of the table)
Standard library only.
"""
import io
import itertools
import json
import os
import re
import sys
import tokenize

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # docs/wallets
fail = []


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- the table

table = json.loads(read(os.path.join(ROOT, "model", "transitions.json")))
MACHINES = table["machines"]
ROWS = table["transitions"]


def slug(guard):
    """The guard as a tag-safe word: and & or | not ! == = ( [ ) ] True T, quotes and spaces dropped."""
    out = []
    for tok in tokenize.generate_tokens(io.StringIO(guard).readline):
        t, s = tok.type, tok.string
        if t == tokenize.NAME:
            out.append({"and": "&", "or": "|", "not": "!", "True": "T", "False": "F"}.get(s, s))
        elif t == tokenize.OP:
            out.append({"==": "=", "!=": "!=", "(": "[", ")": "]"}[s])
        elif t == tokenize.STRING:
            out.append(s[1:-1])
        elif t in (tokenize.NEWLINE, tokenize.ENDMARKER, tokenize.NL):
            continue
        else:
            raise ValueError(f"unexpected token {s!r} in guard {guard!r}")
    return "".join(out)


def tag_of(row):
    return f"@t:{row['machine']}:{row['from']}:{row['event']}:{slug(row['guard'])}"


ROW_TAGS = {}
for r in ROWS:
    t = tag_of(r)
    if t in ROW_TAGS:
        fail.append(f"table: two rows share the tag {t}")
    ROW_TAGS[t] = r

GROUPS = {}
for r in ROWS:
    GROUPS.setdefault((r["machine"], r["from"], r["event"]), []).append(r)

TLA_DEFS = {}
for m in MACHINES.values():
    mod = m["tla"]
    if mod not in TLA_DEFS:
        src = read(os.path.join(ROOT, "model", mod + ".tla"))
        TLA_DEFS[mod] = set(re.findall(r"^(\w+)\s*(?:\([^)]*\))?\s*==", src, re.M))


def coerce(machine, atom, text):
    dom = MACHINES[machine]["atoms"][atom]
    for v in dom:
        if str(v) == text or (isinstance(v, str) and v == text):
            return v
    raise ValueError(f"{text!r} is not in the domain {dom} of {machine}.{atom}")


# ---------------------------------------------------------------- STEPS.md

STEP_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*(state|atom|event|invariant)\s*\|\s*`([^`]+)`\s*\|")
KIND_KEYWORD = {"state": {"Given", "Then"}, "atom": {"Given"}, "event": {"When"}, "invariant": {"Then"}}


def load_steps():
    steps = []
    seen = set()
    for n, line in enumerate(read(os.path.join(HERE, "STEPS.md")).splitlines(), 1):
        m = STEP_ROW.match(line)
        if not m:
            continue
        phrase, kind, target = m.groups()
        if phrase in seen:
            fail.append(f"STEPS.md:{n}: phrase defined twice: {phrase}")
        seen.add(phrase)
        # one placeholder at most, written "<name>" in quotes
        holes = re.findall(r'"<(\w+)>"', phrase)
        pattern = "^" + re.escape(phrase) + "$"
        for h in holes:
            pattern = pattern.replace(re.escape(f'"<{h}>"'), r'"([^"]+)"')
        entry = {"phrase": phrase, "kind": kind, "target": target, "re": re.compile(pattern), "holes": holes, "line": n}
        # validate the target
        try:
            if kind == "state":
                if target not in MACHINES or holes != ["state"]:
                    raise ValueError("a state phrase names a machine and has one \"<state>\" hole")
            elif kind == "atom":
                mach, rest = target.split(".", 1)
                if "=" in rest:
                    atom, val = rest.split("=", 1)
                    entry["value"] = coerce(mach, atom.strip(), val.strip())
                    if holes:
                        raise ValueError("an atom phrase with a fixed value has no hole")
                else:
                    atom = rest
                    if holes != ["value"]:
                        raise ValueError("an atom phrase without a value has one \"<value>\" hole")
                entry["machine"], entry["atom"] = mach, atom.strip()
                if entry["atom"] not in MACHINES[mach]["atoms"]:
                    raise ValueError(f"{mach} has no atom {entry['atom']}")
            elif kind == "event":
                mach, ev = target.split(".", 1)
                if not any(k[0] == mach and k[2] == ev for k in GROUPS):
                    raise ValueError(f"{mach} has no event {ev}")
                entry["machine"], entry["event"] = mach, ev
                if holes:
                    raise ValueError("an event phrase has no hole")
            elif kind == "invariant":
                mod, name = target.split(".", 1)
                if name not in TLA_DEFS.get(mod, set()):
                    raise ValueError(f"{name} is not defined in {mod}.tla")
                if holes:
                    raise ValueError("an invariant phrase has no hole")
        except (ValueError, KeyError) as e:
            fail.append(f"STEPS.md:{n}: {phrase}: {e}")
            continue
        steps.append(entry)
    return steps


STEPS = load_steps()
USED_PHRASES = set()


def match_step(text, where):
    found = [(s, s["re"].match(text)) for s in STEPS]
    found = [(s, m) for s, m in found if m]
    if len(found) != 1:
        fail.append(f"{where}: step matches {len(found)} phrases of STEPS.md: {text!r}")
        return None, None
    USED_PHRASES.add(found[0][0]["phrase"])
    return found[0]


# ---------------------------------------------------------------- use cases and hazards

HAZARDS = set(re.findall(r"^\*\*(H-\d{3})\*\*", read(os.path.join(ROOT, "hazards.md")), re.M))


def load_use_cases():
    text = read(os.path.join(ROOT, "use-cases.md"))
    ucs = {}
    cur = None
    for line in text.splitlines():
        h = re.match(r"^###\s+((?:UC|OOS)-\d{2})\b", line)
        if h:
            cur = h.group(1)
            ucs[cur] = {"hazards": set(), "oos": cur.startswith("OOS"), "outside": ""}
            field = None
            continue
        if line.startswith("#"):
            cur = None
        if not cur:
            continue
        f = re.match(r"^-\s+\*\*([^*]+):\*\*", line)
        if f:
            field = "hazards" if f.group(1).startswith("Hazards") else "outside" if f.group(1).startswith("V&V outside") else None
        elif not re.match(r"^\s{2,}\S", line):
            field = None
        if field == "hazards":
            ucs[cur]["hazards"] |= set(re.findall(r"\bH-\d{3}\b", line))
        if field == "outside":
            ucs[cur]["outside"] += " " + line.strip()
    # "V&V outside" names hazards one by one, as ranges ("H-061 to H-067"), or all of the use case's ("all eight
    # hazards", "every hazard here"): the same reading as check-scenarios.mjs, written again here on purpose.
    for u in ucs.values():
        t = u["outside"]
        named = set(re.findall(r"\bH-\d{3}\b", t))
        for a, b in re.findall(r"\bH-(\d{3})\s+to\s+H-(\d{3})\b", t):
            named |= {f"H-{n:03d}" for n in range(int(a), int(b) + 1)}
        if re.search(r"\b(?:all|every)\b[^.;]*\bhazards?\b", t):
            named |= u["hazards"]
        u["outside_named"] = named
    return ucs


UCS = load_use_cases()
UC_TAGGED = {}  # use case -> hazards tagged on its scenarios


# ---------------------------------------------------------------- Gherkin

KEYWORDS = ("Given", "When", "Then", "And", "But")


class Block:
    def __init__(self, kind, name, line, tags, tag_lines):
        self.kind, self.name, self.line = kind, name, line
        self.tags, self.tag_lines = tags, tag_lines
        self.steps = []  # (keyword, text, line)
        self.examples = []  # Block(kind="examples") with .header, .rows


def parse_feature(path):
    lines = read(path).splitlines()
    feature_tags, background, scenarios = [], [], []
    pending_tags, pending_lines = [], []
    cur = None
    ex = None
    for i, raw in enumerate(lines, 1):
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("@"):
            pending_tags += s.split()
            pending_lines.append(i)
            continue
        if s.startswith("Feature:"):
            feature_tags, pending_tags, pending_lines = pending_tags, [], []
            continue
        if s.startswith("Background:"):
            cur = Block("background", "", i, [], [])
            background = cur.steps
            ex = None
            continue
        m = re.match(r"^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$", s)
        if m:
            kind = "outline" if m.group(1) in ("Scenario Outline", "Scenario Template") else "scenario"
            cur = Block(kind, m.group(2), i, pending_tags, pending_lines)
            pending_tags, pending_lines = [], []
            scenarios.append(cur)
            ex = None
            continue
        if s.startswith("Examples:") or s.startswith("Scenarios:"):
            ex = Block("examples", s.split(":", 1)[1].strip(), i, pending_tags, pending_lines)
            ex.header, ex.rows = None, []
            pending_tags, pending_lines = [], []
            cur.examples.append(ex)
            continue
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if ex is None:
                fail.append(f"{path}:{i}: a table outside Examples (step tables are not used)")
            elif ex.header is None:
                ex.header = cells
            else:
                ex.rows.append((cells, i))
            continue
        kw = s.split(" ", 1)[0]
        if kw in KEYWORDS and cur is not None:
            if ex is not None:
                fail.append(f"{path}:{i}: a step after Examples")
            cur.steps.append((kw, s.split(" ", 1)[1], i))
            continue
        fail.append(f"{path}:{i}: cannot parse: {s}")
    return feature_tags, background, scenarios


# ---------------------------------------------------------------- replay


def completions(machine, known):
    m = MACHINES[machine]
    free = [a for a in m["atoms"] if a not in known]
    for combo in itertools.product(*(m["atoms"][a] for a in free)):
        env = dict(known)
        env.update(zip(free, combo))
        for k, expr in m["defs"].items():
            env[k] = eval(expr, {}, dict(env))
        yield env


def replay(steps, where):
    """Returns the list of rows exercised, in order; records failures."""
    state, atoms, started = {}, {}, set()
    exercised = []
    effective = None
    for kw, text, line in steps:
        at = f"{where}:{line}"
        effective = effective if kw in ("And", "But") else kw
        if effective is None:
            fail.append(f"{at}: And/But with no keyword before it")
            continue
        entry, m = match_step(text, at)
        if entry is None:
            continue
        kind = entry["kind"]
        if effective not in KIND_KEYWORD[kind]:
            fail.append(f"{at}: a {kind} step cannot be a {effective}: {text!r}")
            continue
        if kind == "state":
            mach, value = entry["target"], m.group(1)
            if value not in MACHINES[mach]["states"]:
                fail.append(f"{at}: {value!r} is not a state of {mach}")
                continue
            if effective == "Given":
                if mach in started and state.get(mach) != value:
                    fail.append(f"{at}: Given sets {mach} to {value} after its events moved it to {state.get(mach)}")
                state[mach] = value
            else:
                if mach not in state:
                    fail.append(f"{at}: Then asserts {mach} with no Given state for it")
                elif state[mach] != value:
                    fail.append(f"{at}: Then says {mach} is {value}, the table gives {state[mach]}")
        elif kind == "atom":
            mach, atom = entry["machine"], entry["atom"]
            try:
                value = entry["value"] if "value" in entry else coerce(mach, atom, m.group(1))
            except ValueError as e:
                fail.append(f"{at}: {e}")
                continue
            atoms.setdefault(mach, {})[atom] = value
        elif kind == "event":
            mach, ev = entry["machine"], entry["event"]
            if mach not in state:
                fail.append(f"{at}: event {ev} on {mach} with no Given state for it")
                continue
            rows = GROUPS.get((mach, state[mach], ev))
            if not rows:
                fail.append(f"{at}: {mach} in {state[mach]} has no row for {ev} (the event is not enabled there)")
                continue
            chosen = set()
            deciders = set()
            for env in completions(mach, atoms.get(mach, {})):
                held = [r for r in rows if eval(r["guard"], {}, dict(env))]
                chosen.add(id(held[0]))
            if len(chosen) != 1:
                for r in rows:
                    deciders |= {a for a in MACHINES[mach]["atoms"] if re.search(rf"\b{a}\b", r["guard"])}
                deciders |= {a for d, e in MACHINES[mach]["defs"].items() for a in MACHINES[mach]["atoms"]
                             if any(re.search(rf"\b{d}\b", r["guard"]) for r in rows) and re.search(rf"\b{a}\b", e)}
                unset = sorted(deciders - set(atoms.get(mach, {})))
                fail.append(f"{at}: {mach} {state[mach]} --{ev}: undetermined; set {', '.join(unset)}")
                continue
            row = next(r for r in rows if id(r) in chosen)
            exercised.append(row)
            state[mach] = row["to"]
            started.add(mach)
        elif kind == "invariant":
            pass
    return exercised


# ---------------------------------------------------------------- tags


def split_tags(tags):
    t = [x for x in tags if x.startswith("@t:")]
    uc = [x[1:] for x in tags if re.match(r"^@(UC|OOS)-\d{2}$", x)]
    hz = [x[1:] for x in tags if re.match(r"^@H-\d{3}$", x)]
    other = [x for x in tags if x not in t and x[1:] not in uc and x[1:] not in hz]
    return t, uc, hz, other


ALLOWED_OTHER = {"@keychain", "@crash", "@race", "@best", "@error", "@edge", "@security", "@spike", "@slow"}


def check_meta(tags, where, covered_uc, covered_hz):
    _, uc, hz, other = split_tags(tags)
    for o in other:
        if o not in ALLOWED_OTHER:
            fail.append(f"{where}: unknown tag {o}")
    if not uc:
        fail.append(f"{where}: no @UC-xx tag")
    if not hz:
        fail.append(f"{where}: no @H-xxx tag")
    for u in uc:
        if u not in UCS:
            fail.append(f"{where}: @{u} is not a use case of use-cases.md")
        elif UCS[u]["oos"]:
            fail.append(f"{where}: @{u} is out of scope")
        else:
            covered_uc.add(u)
    for h in hz:
        if h not in HAZARDS:
            fail.append(f"{where}: @{h} is not in hazards.md")
        elif not any(h in UCS.get(u, {}).get("hazards", set()) for u in uc):
            fail.append(f"{where}: @{h} is not listed under {', '.join('@' + u for u in uc)} in use-cases.md")
        else:
            covered_hz.add(h)
            for u in uc:
                UC_TAGGED.setdefault(u, set()).add(h)


def rewrite_tags(path, edits):
    """edits: list of (keyword_line, tag_lines, new_t_tags). Removes @t tags on tag_lines, inserts new ones."""
    lines = read(path).splitlines()
    drop = set()
    inserts = {}
    for kw_line, tag_lines, new in edits:
        for tl in tag_lines:
            kept = [x for x in lines[tl - 1].split() if not x.startswith("@t:")]
            indent = re.match(r"^(\s*)", lines[tl - 1]).group(1)
            if kept:
                lines[tl - 1] = indent + " ".join(kept)
            else:
                drop.add(tl)
        indent = re.match(r"^(\s*)", lines[kw_line - 1]).group(1)
        inserts[kw_line] = [indent + t for t in new]
    out = []
    for i, l in enumerate(lines, 1):
        if i in drop:
            continue
        if i in inserts:
            out.extend(inserts[i])
        out.append(l)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")


def substitute(text, header, cells):
    for h, c in zip(header, cells):
        text = text.replace(f"<{h}>", c)
    return text


def run(fix):
    covered_rows, covered_uc, covered_hz = {}, set(), set()
    names = {}
    n_scen = 0
    files = sorted(f for f in os.listdir(HERE) if f.endswith(".feature"))
    for fname in files:
        path = os.path.join(HERE, fname)
        ftags, background, scenarios = parse_feature(path)
        if any(t.startswith("@t:") for t in ftags):
            fail.append(f"{fname}: @t tags belong on scenarios or Examples, not on the Feature")
        edits = []
        for sc in scenarios:
            where = f"{fname}:{sc.line}"
            if sc.name in names:
                fail.append(f"{where}: scenario name also used at {names[sc.name]}")
            names[sc.name] = where
            if sc.kind == "scenario":
                n_scen += 1
                ex = replay(background + sc.steps, fname)
                want = []
                for r in ex:
                    if tag_of(r) not in want:
                        want.append(tag_of(r))
                have = [t for t in sc.tags if t.startswith("@t:")]
                check_meta(ftags + sc.tags, where, covered_uc, covered_hz)
                if fix:
                    if have != want:
                        edits.append((sc.line, sc.tag_lines, want))
                elif set(have) != set(want):
                    fail.append(f"{where}: @t tags {sorted(set(have) ^ set(want))} differ from the replay")
                for r in ex:
                    covered_rows.setdefault(tag_of(r), []).append(where)
            else:
                if any(t.startswith("@t:") for t in sc.tags):
                    if fix:
                        edits.append((sc.line, sc.tag_lines, []))
                    else:
                        fail.append(f"{where}: an outline's @t tags belong on its Examples")
                if not sc.examples:
                    fail.append(f"{where}: an outline without Examples")
                for exb in sc.examples:
                    ewhere = f"{fname}:{exb.line}"
                    sets = []
                    for cells, ln in exb.rows:
                        n_scen += 1
                        if len(cells) != len(exb.header):
                            fail.append(f"{fname}:{ln}: row width differs from its header")
                            continue
                        steps = [(k, substitute(t, exb.header, cells), l) for k, t, l in background + sc.steps]
                        ex = replay(steps, f"{fname}[{ln}]")
                        want = []
                        for r in ex:
                            if tag_of(r) not in want:
                                want.append(tag_of(r))
                        sets.append((ln, want))
                        for r in ex:
                            covered_rows.setdefault(tag_of(r), []).append(f"{fname}:{ln}")
                        check_meta(ftags + sc.tags + exb.tags, f"{fname}:{ln}", covered_uc, covered_hz)
                    distinct = {tuple(sorted(w)) for _, w in sets}
                    if len(distinct) > 1:
                        fail.append(f"{ewhere}: its rows exercise different rows of the table; split the Examples "
                                    f"({'; '.join(str(ln) + ': ' + ' '.join(w) for ln, w in sets)})")
                        continue
                    want = sets[0][1] if sets else []
                    have = [t for t in exb.tags if t.startswith("@t:")]
                    if fix:
                        if have != want:
                            edits.append((exb.line, exb.tag_lines, want))
                    elif set(have) != set(want):
                        fail.append(f"{ewhere}: @t tags {sorted(set(have) ^ set(want))} differ from the replay")
        if fix and edits:
            rewrite_tags(path, edits)
    return files, n_scen, covered_rows, covered_uc, covered_hz


def main():
    args = set(sys.argv[1:])
    if "--slugs" in args:
        for r in ROWS:
            print(tag_of(r), "->", r["to"])
        return
    if "--fix-tags" in args:
        run(True)
        if fail:
            print("\n".join(fail))
            print(f"FAIL (while fixing): {len(fail)}")
            sys.exit(1)
    files, n_scen, rows, ucs, hzs = run(False)

    # traceability of use-cases.md
    listed = set().union(*(u["hazards"] for u in UCS.values())) if UCS else set()
    for h in sorted(HAZARDS - listed):
        fail.append(f"use-cases.md: {h} is listed under no use case")
    for h in sorted(listed - HAZARDS):
        fail.append(f"use-cases.md: {h} is not in hazards.md")
    in_scope = [u for u, v in UCS.items() if not v["oos"]]
    for u in in_scope:
        if u not in ucs:
            fail.append(f"use-cases.md: {u} has no scenario")
    unused = [s["phrase"] for s in STEPS if s["phrase"] not in USED_PHRASES]
    # coverage gaps fail (finding 33): every hazard a use case lists is tagged on one of its scenarios, named by a
    # table row one of its scenarios exercises, or named under its "V&V outside the scenarios"; out-of-scope use cases
    # accept theirs.
    row_hz = {}
    for t, where in rows.items():
        r = ROW_TAGS.get(t)
        if r:
            for h in r["hazards"]:
                row_hz.setdefault(h, set()).add(t)
    oos_hz = set().union(*(v["hazards"] for v in UCS.values() if v["oos"]))
    for u in in_scope:
        for h in sorted(UCS[u]["hazards"]):
            if h in UC_TAGGED.get(u, set()) or h in UCS[u]["outside_named"] or h in row_hz or h in oos_hz:
                continue
            fail.append(f"use-cases.md: {u}:{h} is covered by no scenario, exercised row or V&V-outside entry")

    print(f"{len(files)} feature files, {n_scen} scenarios (outline rows counted), {len(STEPS)} step phrases "
          f"({len(STEPS) - len(unused)} used)")
    print(f"table rows exercised: {len(rows)} of {len(ROWS)}")
    print(f"use cases with scenarios: {len(ucs)} of {len(in_scope)} in scope")
    print(f"hazards tagged on scenarios: {len(hzs)} of {len(HAZARDS)} (all {len(HAZARDS)} are traced to a use case)"
          if not (HAZARDS - listed) else f"hazards tagged on scenarios: {len(hzs)}")
    if "--coverage" in args:
        for t, r in ROW_TAGS.items():
            if t not in rows:
                print("  row not exercised:", t)
        for u in sorted(UCS):
            if UCS[u]["oos"]:
                continue
            missing = sorted(UCS[u]["hazards"] - hzs)
            if missing:
                print(f"  {u}: hazards verified outside the scenarios: {', '.join(missing)}")
        for p in unused:
            print("  phrase not used:", p)
    if fail:
        print("\n".join(fail))
        print(f"FAIL: {len(fail)}")
        sys.exit(1)
    print("OK: every step is a STEPS.md phrase, every outcome is the table's, every tag matches its replay")


if __name__ == "__main__":
    main()
