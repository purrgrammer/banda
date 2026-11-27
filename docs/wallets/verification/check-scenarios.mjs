#!/usr/bin/env node
// Deterministic consistency checker: the wallet's Gherkin scenarios against the transition table.
//
// Inputs (all relative to docs/wallets/):
//   features/*.feature        parsed with the official @cucumber/gherkin parser and compiled to pickles
//                             (one pickle per Scenario and per Examples row; And/But resolved by the parser)
//   features/STEPS.md         the step vocabulary: each phrase maps to a state, an atom, an event or an invariant
//   model/transitions.json    the deterministic transition table (the only source of outcomes)
//   model/*.tla               the TLA+ modules the invariant phrases name
//   hazards.md, use-cases.md  the hazard ids and the use cases they are traced to
//
// Fails (exit 1) when:
//   T1  a (machine, from, event) group's guards overlap (two rows hold) or leave a gap (no row holds) for some
//       valuation of the machine's atoms, or a guard can never hold, or names an undeclared atom;
//   T2  a row names an undeclared state, or a terminal state changes;
//   S1  a step matches no phrase of STEPS.md (or more than one), or its keyword does not fit the phrase's kind;
//   S2  an event is not enabled: the machine has no row for it in its current state, or no Given state;
//   S3  an event is undetermined: two valuations of the atoms the scenario left unset select different rows;
//   S4  a Then state contradicts the state the table gives;
//   S5  an @t tag names no row of the table, names a row the scenario did not exercise, or an exercised row has
//       no @t tag;
//   S6  two scenarios reach the same (machine, from, event, guard) and assert different outcomes, or two
//       scenarios at the same (machine, from, event) set compatible atoms (some valuation satisfies both) and
//       assert different outcomes (this one is computed from the scenarios alone, without the table's `to`);
//   S7  an invariant phrase names a definition its TLA+ module lacks; a STEPS.md phrase is malformed;
//   S8  traceability: a scenario without an in-scope @UC-xx or an @H-xxx, an @H-xxx not in hazards.md or not
//       listed under one of the scenario's use cases, an unknown tag, a duplicate scenario name, an
//       unsubstituted <placeholder>, a Gherkin parse error;
//   S9  an event's resulting state is not asserted by a Then before the machine's next event;
//   S10 cross-machine coherence: at an event of a machine a link of transitions.json names, the scenario's states
//       and atoms break that link (a payment rule Always while the recipient is denied, a wallet archived while
//       the payment's wallet is usable);
//   S11 coverage: a hazard of hazards.md is covered by no scenario tag, no exercised row, no "V&V outside" entry and
//       no out-of-scope use case (a gap), or a use case lists a hazard none of its scenarios, exercised rows or
//       V&V-outside entries cover.
//   S12 unreachable rows: a row transitions.json marks `unreachable` holds its guard only in valuations that break a
//       link of its own machine, and no scenario exercises it.
// Reports (never fails): rows no scenario exercised; hazards split by how they are covered; STEPS.md phrases no
// scenario uses.
//
// Run (the parser is installed outside the repo, see README.md):
//   node docs/wallets/verification/check-scenarios.mjs --deps <dir holding node_modules/@cucumber/gherkin>
//   CHECKER_DEPS=<dir> node docs/wallets/verification/check-scenarios.mjs [--coverage] [--json <file>]
// Flags: --coverage lists every uncovered row and hazard; --json <file> writes the counts and findings as JSON.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// ------------------------------------------------------------------ the parser, from an install outside the repo

async function loadGherkin() {
  const deps = opt("--deps") ?? process.env.CHECKER_DEPS;
  const base = deps ? join(resolve(deps), "package.json") : join(HERE, "package.json");
  const req = createRequire(base);
  const load = async (name) => import(pathToFileURL(req.resolve(name)).href);
  try {
    const gherkin = await load("@cucumber/gherkin");
    const messages = await load("@cucumber/messages");
    const version = JSON.parse(readFileSync(req.resolve("@cucumber/gherkin/package.json"), "utf8")).version;
    return { gherkin, messages, version };
  } catch (e) {
    console.error(`cannot load @cucumber/gherkin (${e.message}); pass --deps <dir> or CHECKER_DEPS, see README.md`);
    process.exit(2);
  }
}

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const failures = []; // { code, where, msg }
const fail = (code, where, msg) => failures.push({ code, where, msg });

// ------------------------------------------------------------------ a Python boolean-expression subset
// The table's guards and defs are Python expressions: names, 'strings', True/False, == and != (chained),
// not/and/or with Python's value semantics, parentheses, and `a if c else b`.

function tokenize(src) {
  const toks = [];
  const re = /\s*(?:(==|!=|\(|\))|'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot tokenize ${JSON.stringify(src)} at ${i}`);
    i = re.lastIndex;
    if (m[1]) toks.push({ t: "op", v: m[1] });
    else if (m[2] !== undefined) toks.push({ t: "str", v: m[2] });
    else if (m[3] !== undefined) toks.push({ t: "str", v: m[3] });
    else toks.push({ t: "name", v: m[4] });
  }
  return toks;
}

const KW = new Set(["and", "or", "not", "if", "else", "True", "False"]);

function compileExpr(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isKw = (v) => peek() && peek().t === "name" && peek().v === v;
  const eat = (t, v) => {
    const k = toks[p];
    if (!k || k.t !== t || (v !== undefined && k.v !== v)) throw new Error(`expected ${v ?? t} in ${src}`);
    p++;
    return k;
  };
  const names = new Set();
  const truthy = (x) => !(x === false || x === "" || x === null || x === undefined || x === 0);
  function ternary() {
    const a = orExpr();
    if (isKw("if")) {
      p++;
      const c = orExpr();
      eat("name", "else");
      const b = ternary();
      return (env) => (truthy(c(env)) ? a(env) : b(env));
    }
    return a;
  }
  function orExpr() {
    const parts = [andExpr()];
    while (isKw("or")) {
      p++;
      parts.push(andExpr());
    }
    if (parts.length === 1) return parts[0];
    return (env) => {
      let v;
      for (const f of parts) if (truthy((v = f(env)))) return v;
      return v;
    };
  }
  function andExpr() {
    const parts = [notExpr()];
    while (isKw("and")) {
      p++;
      parts.push(notExpr());
    }
    if (parts.length === 1) return parts[0];
    return (env) => {
      let v;
      for (const f of parts) if (!truthy((v = f(env)))) return v;
      return v;
    };
  }
  function notExpr() {
    if (isKw("not")) {
      p++;
      const f = notExpr();
      return (env) => !truthy(f(env));
    }
    return comparison();
  }
  function comparison() {
    const operands = [atom()];
    const ops = [];
    while (peek() && peek().t === "op" && (peek().v === "==" || peek().v === "!=")) {
      ops.push(toks[p++].v);
      operands.push(atom());
    }
    if (!ops.length) return operands[0];
    return (env) => {
      const vals = operands.map((f) => f(env));
      for (let i = 0; i < ops.length; i++) {
        const eq = vals[i] === vals[i + 1];
        if (ops[i] === "==" ? !eq : eq) return false;
      }
      return true;
    };
  }
  function atom() {
    const k = peek();
    if (!k) throw new Error(`unexpected end of ${src}`);
    if (k.t === "op" && k.v === "(") {
      p++;
      const f = ternary();
      eat("op", ")");
      return f;
    }
    if (k.t === "str") {
      p++;
      return () => k.v;
    }
    if (k.t === "name" && k.v === "True") {
      p++;
      return () => true;
    }
    if (k.t === "name" && k.v === "False") {
      p++;
      return () => false;
    }
    if (k.t === "name" && !KW.has(k.v)) {
      p++;
      names.add(k.v);
      return (env) => {
        if (!(k.v in env)) throw new Error(`undeclared name ${k.v} in ${src}`);
        return env[k.v];
      };
    }
    throw new Error(`unexpected ${k.v} in ${src}`);
  }
  const f = ternary();
  if (p !== toks.length) throw new Error(`trailing tokens in ${src}`);
  f.names = names;
  return f;
}

// The tag-safe slug of a guard, as STEPS.md rule 5 and check_features.py define it.
function slug(guard) {
  const map = { and: "&", or: "|", not: "!", True: "T", False: "F", "==": "=", "!=": "!=", "(": "[", ")": "]" };
  return tokenize(guard)
    .map((k) => (k.t === "str" ? k.v : (map[k.v] ?? k.v)))
    .join("");
}

// ------------------------------------------------------------------ the table

const table = JSON.parse(read("model/transitions.json"));
const MACHINES = table.machines;
const ROWS = table.transitions;
const LINKS = table.links ?? [];
const groupKey = (m, from, ev) => `${m}\u0000${from}\u0000${ev}`;
const GROUPS = new Map();
const rowTag = (r) => `@t:${r.machine}:${r.from}:${r.event}:${slug(r.guard)}`;
const ROW_BY_TAG = new Map();

for (const [name, m] of Object.entries(MACHINES)) {
  m.defsC = {};
  for (const [d, e] of Object.entries(m.defs)) {
    try {
      m.defsC[d] = compileExpr(e);
    } catch (err) {
      fail("T1", `table:${name}.defs.${d}`, err.message);
    }
  }
  m.atomNames = Object.keys(m.atoms);
}

ROWS.forEach((r, i) => {
  r.index = i;
  const m = MACHINES[r.machine];
  if (!m) {
    fail("T2", `table:row ${i}`, `unknown machine ${r.machine}`);
    return;
  }
  for (const s of [r.from, r.to])
    if (!m.states.includes(s)) fail("T2", `table:row ${i}`, `${r.machine} has no state ${s}`);
  if (m.terminal.includes(r.from) && r.to !== r.from)
    fail("T2", `table:row ${i}`, `terminal ${r.machine}.${r.from} changes to ${r.to} on ${r.event}`);
  try {
    r.g = compileExpr(r.guard);
  } catch (err) {
    fail("T1", `table:row ${i}`, err.message);
    r.g = () => false;
    r.g.names = new Set();
  }
  r.tag = rowTag(r);
  if (ROW_BY_TAG.has(r.tag)) fail("T1", `table:row ${i}`, `two rows share the tag ${r.tag}`);
  ROW_BY_TAG.set(r.tag, r);
  const k = groupKey(r.machine, r.from, r.event);
  if (!GROUPS.has(k)) GROUPS.set(k, []);
  GROUPS.get(k).push(r);
});

function withDefs(m, env) {
  const out = { ...env };
  for (const [d, f] of Object.entries(m.defsC)) out[d] = f(out);
  return out;
}

function* product(names, domains, base = {}) {
  if (!names.length) {
    yield { ...base };
    return;
  }
  const [h, ...t] = names;
  for (const v of domains[h]) yield* product(t, domains, { ...base, [h]: v });
}

// The atoms a group's guards depend on, through the defs.
const relevantCache = new Map();
function relevantAtoms(mName, rows) {
  const key = rows.map((r) => r.index).join(",");
  if (relevantCache.has(key)) return relevantCache.get(key);
  const m = MACHINES[mName];
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (m.defsC[n]) for (const x of m.defsC[n].names) visit(x);
  };
  for (const r of rows) for (const n of r.g.names) visit(n);
  const atoms = m.atomNames.filter((a) => seen.has(a));
  relevantCache.set(key, atoms);
  return atoms;
}

// T1: exclusivity, exhaustiveness and satisfiability of every group, by full enumeration of the machine's atoms.
let valuationsChecked = 0;
// The digest of every (group, valuation) -> held row indices, in table order; mutations.mjs compares it with the
// same enumeration under Python's eval, so this evaluator and the table's own language agree on every valuation.
const selection = createHash("sha256");
for (const [k, rows] of GROUPS) {
  const [mName, from, ev] = k.split("\u0000");
  const m = MACHINES[mName];
  const held = new Map(rows.map((r) => [r, 0]));
  let reported = 0;
  for (const v of product(m.atomNames, m.atoms)) {
    valuationsChecked++;
    let env;
    let hold;
    try {
      env = withDefs(m, v);
      hold = rows.filter((r) => r.g(env));
    } catch (err) {
      fail("T1", `table:${mName}.${from}.${ev}`, err.message);
      break;
    }
    for (const r of hold) held.set(r, held.get(r) + 1);
    selection.update(`${hold.map((r) => r.index).join(",")};`);
    if (hold.length !== 1 && reported < 1) {
      reported++;
      const what = hold.length ? `guards overlap (${hold.map((r) => r.guard).join(" | ")})` : "no guard holds (gap)";
      fail("T1", `table:${mName}.${from}.${ev}`, `${what} at ${JSON.stringify(v)}`);
    }
  }
  for (const [r, n] of held) if (n === 0) fail("T1", `table:row ${r.index}`, `guard can never hold: ${r.guard}`);
}
const selectionDigest = selection.digest("hex");

// ------------------------------------------------------------------ TLA+ definitions, hazards, use cases

const TLA_DEFS = {};
for (const m of Object.values(MACHINES)) {
  if (TLA_DEFS[m.tla]) continue;
  const src = read(`model/${m.tla}.tla`);
  TLA_DEFS[m.tla] = new Set([...src.matchAll(/^(\w+)\s*(?:\([^)]*\))?\s*==/gm)].map((x) => x[1]));
}

const HAZARDS = new Set([...read("hazards.md").matchAll(/^\*\*(H-\d{3})\*\*/gm)].map((x) => x[1]));

const UCS = {};
{
  // A field is "- **Name:** text" and runs over its indented continuation lines.
  let cur = null;
  let field = null;
  for (const line of read("use-cases.md").split("\n")) {
    const h = line.match(/^###\s+((?:UC|OOS)-\d{2})\b/);
    if (h) {
      cur = h[1];
      UCS[cur] = { hazards: new Set(), outside: new Set(), oos: cur.startsWith("OOS") };
      field = null;
      continue;
    }
    if (line.startsWith("#")) {
      cur = field = null;
      continue;
    }
    if (!cur) continue;
    const f = line.match(/^-\s+\*\*([^*]+):\*\*/);
    if (f) field = /^Hazards/.test(f[1]) ? "hazards" : /^V&V outside/.test(f[1]) ? "outside" : null;
    else if (!/^\s{2,}\S/.test(line)) field = null;
    if (field === "hazards") for (const x of line.matchAll(/\bH-\d{3}\b/g)) UCS[cur].hazards.add(x[0]);
    if (field === "outside") UCS[cur].outsideText = `${UCS[cur].outsideText ?? ""} ${line.trim()}`;
  }
  // "V&V outside" names hazards one by one, as ranges ("H-061 to H-067"), or all of the use case's ("all eight
  // hazards", "every hazard here").
  for (const u of Object.values(UCS)) {
    const t = u.outsideText ?? "";
    for (const x of t.matchAll(/\bH-(\d{3})\s+to\s+H-(\d{3})\b/g))
      for (let n = Number(x[1]); n <= Number(x[2]); n++) u.outside.add(`H-${String(n).padStart(3, "0")}`);
    for (const x of t.matchAll(/\bH-\d{3}\b/g)) u.outside.add(x[0]);
    if (/\b(all|every)\b[^.;:]*\bhazards?\b/i.test(t)) for (const h of u.hazards) u.outside.add(h);
  }
}

// ------------------------------------------------------------------ STEPS.md

const KIND_TYPE = { state: ["Context", "Outcome"], atom: ["Context"], event: ["Action"], invariant: ["Outcome"] };
const TYPE_WORD = { Context: "Given", Action: "When", Outcome: "Then", Unknown: "And/But with nothing before" };

function coerce(mName, atom, text) {
  const dom = MACHINES[mName].atoms[atom];
  const v = dom.find((x) => String(x) === text || (x === true && text === "True") || (x === false && text === "False"));
  if (v === undefined) throw new Error(`${JSON.stringify(text)} is not in the domain ${JSON.stringify(dom)} of ${mName}.${atom}`);
  return v;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STEPS = [];
{
  const seen = new Set();
  const rowRe = /^\|\s*`([^`]+)`\s*\|\s*(state|atom|event|invariant)\s*\|\s*`([^`]+)`\s*\|/;
  read("features/STEPS.md")
    .split("\n")
    .forEach((line, i) => {
      const m = line.match(rowRe);
      if (!m) return;
      const [, phrase, kind, target] = m;
      const where = `STEPS.md:${i + 1}`;
      if (seen.has(phrase)) fail("S7", where, `phrase defined twice: ${phrase}`);
      seen.add(phrase);
      const holes = [...phrase.matchAll(/"<(\w+)>"/g)].map((x) => x[1]);
      let pattern = `^${escapeRe(phrase)}$`;
      for (const h of holes) pattern = pattern.replace(escapeRe(`"<${h}>"`), '"([^"]+)"');
      const e = { phrase, kind, target, re: new RegExp(pattern), holes, where, used: 0 };
      try {
        if (kind === "state") {
          if (!MACHINES[target] || holes.join() !== "state") throw new Error('a state phrase names a machine and one "<state>" hole');
          e.machine = target;
        } else if (kind === "atom") {
          const [mach, rest] = [target.slice(0, target.indexOf(".")), target.slice(target.indexOf(".") + 1)];
          if (!MACHINES[mach]) throw new Error(`no machine ${mach}`);
          e.machine = mach;
          if (rest.includes("=")) {
            const [a, v] = rest.split("=").map((s) => s.trim());
            e.atom = a;
            if (!(a in MACHINES[mach].atoms)) throw new Error(`${mach} has no atom ${a}`);
            e.value = coerce(mach, a, v);
            if (holes.length) throw new Error("an atom phrase with a fixed value has no hole");
          } else {
            e.atom = rest.trim();
            if (!(e.atom in MACHINES[mach].atoms)) throw new Error(`${mach} has no atom ${e.atom}`);
            if (holes.join() !== "value") throw new Error('an atom phrase without a value has one "<value>" hole');
          }
        } else if (kind === "event") {
          const [mach, ev] = target.split(".");
          if (!ROWS.some((r) => r.machine === mach && r.event === ev)) throw new Error(`${mach} has no event ${ev}`);
          e.machine = mach;
          e.event = ev;
          if (holes.length) throw new Error("an event phrase has no hole");
        } else {
          const [mod, name] = target.split(".");
          if (!TLA_DEFS[mod]?.has(name)) throw new Error(`${name} is not defined in ${mod}.tla`);
          if (holes.length) throw new Error("an invariant phrase has no hole");
        }
      } catch (err) {
        fail("S7", where, `${phrase}: ${err.message}`);
        return;
      }
      STEPS.push(e);
    });
}

// ------------------------------------------------------------------ Gherkin

const ALLOWED_TAGS = new Set(["@keychain", "@crash", "@race", "@best", "@error", "@edge", "@security", "@spike", "@slow"]);

const { gherkin, messages, version: gherkinVersion } = await loadGherkin();
const featureFiles = readdirSync(join(ROOT, "features"))
  .filter((f) => f.endsWith(".feature"))
  .sort();

const pickles = []; // { file, pickle, lineOf(astId), scenarioLine, isOutline, exampleLine }
for (const file of featureFiles) {
  const uri = `features/${file}`;
  const data = read(uri);
  const newId = messages.IdGenerator.incrementing();
  const builder = new gherkin.AstBuilder(newId);
  const parser = new gherkin.Parser(builder, new gherkin.GherkinClassicTokenMatcher());
  let doc;
  try {
    doc = parser.parse(data);
  } catch (err) {
    for (const e of err.errors ?? [err]) fail("S8", uri, `Gherkin parse error: ${e.message}`);
    continue;
  }
  const lines = new Map(); // ast id -> { line, kind, node, parent }
  const feature = doc.feature;
  if (!feature) continue;
  for (const t of feature.tags) if (t.name.startsWith("@t:")) fail("S5", `${uri}:${t.location.line}`, "@t tags belong on scenarios or Examples");
  for (const child of feature.children) {
    if (child.background) fail("S8", `${uri}:${child.background.location.line}`, "a Background is not used (ISOLATION.md §2)");
    if (child.rule) fail("S8", `${uri}:${child.rule.location.line}`, "a Rule is not used in these features");
    const sc = child.scenario;
    if (!sc) continue;
    const isOutline = sc.examples.length > 0;
    lines.set(sc.id, { line: sc.location.line, kind: "scenario", node: sc, isOutline });
    for (const st of sc.steps) {
      lines.set(st.id, { line: st.location.line, kind: "step", node: st });
      if (st.docString || st.dataTable) fail("S8", `${uri}:${st.location.line}`, "step arguments are not used");
    }
    if (isOutline && sc.tags.some((t) => t.name.startsWith("@t:")))
      fail("S5", `${uri}:${sc.location.line}`, "an outline's @t tags belong on its Examples");
    for (const ex of sc.examples) {
      for (const row of ex.tableBody) lines.set(row.id, { line: row.location.line, kind: "row", node: row, examples: ex, scenario: sc });
      const header = (ex.tableHeader?.cells ?? []).map((c) => c.value);
      const text = sc.steps.map((s) => s.text).join("\n");
      for (const h of header) if (!text.includes(`<${h}>`)) fail("S8", `${uri}:${ex.location.line}`, `Examples column <${h}> is used by no step`);
    }
  }
  for (const pickle of gherkin.compile(doc, uri, newId)) {
    const ids = pickle.astNodeIds;
    const scen = lines.get(ids[0]);
    const row = ids[1] ? lines.get(ids[1]) : null;
    pickles.push({
      file: uri,
      pickle,
      scenario: scen.node,
      isOutline: scen.isOutline,
      examples: row?.examples ?? null,
      where: row ? `${uri}:${row.line}` : `${uri}:${scen.line}`,
      stepLine: (step) => lines.get(step.astNodeIds[0])?.line ?? 0,
    });
  }
}

// ------------------------------------------------------------------ replay

function matchStep(text, where) {
  const hits = [];
  for (const s of STEPS) {
    const m = s.re.exec(text);
    if (m) hits.push([s, m]);
  }
  if (hits.length !== 1) {
    fail("S1", where, `step matches ${hits.length} phrases of STEPS.md: ${JSON.stringify(text)}`);
    return [null, null];
  }
  hits[0][0].used++;
  return hits[0];
}

const occurrences = []; // one per event replayed

// S10: the value a link key has in the scenario so far (undefined when unset).
function linkValue(key, state, atoms) {
  const [mn, atom] = key.split(".");
  return atom === undefined ? state[mn] : atoms[mn]?.[atom];
}
function checkLinks(mach, state, atoms, at) {
  for (const [i, ln] of LINKS.entries()) {
    // A link is checked when a machine whose atom it names takes an event: the facts that event reads must agree
    // with the other machines' states at that moment.
    const keys = [...Object.keys(ln.if), ...Object.keys(ln.then)];
    if (!keys.some((k) => k.includes(".") && k.split(".")[0] === mach)) continue;
    const holds = Object.entries(ln.if).every(([k, vs]) => {
      const v = linkValue(k, state, atoms);
      return v !== undefined && vs.includes(v);
    });
    if (!holds) continue;
    for (const [k, vs] of Object.entries(ln.then)) {
      const v = linkValue(k, state, atoms);
      if (v !== undefined && !vs.includes(v))
        fail("S10", at, `link ${i} (${ln.why}): ${Object.entries(ln.if).map(([a, b]) => `${a} in ${JSON.stringify(b)}`).join(", ")} but ${k} is ${JSON.stringify(v)}`);
    }
  }
}
let eventsReplayed = 0;

function replay(p) {
  const state = {};
  const atoms = {};
  const started = new Set();
  const exercised = [];
  const lastOcc = {};
  for (const step of p.pickle.steps) {
    const at = `${p.file}:${p.stepLine(step)}${p.isOutline ? ` (row ${p.where.split(":").pop()})` : ""}`;
    if (/<[^>\s]+>/.test(step.text)) fail("S8", at, `unsubstituted placeholder in ${JSON.stringify(step.text)}`);
    const [entry, m] = matchStep(step.text, at);
    if (!entry) continue;
    const type = step.type ?? "Unknown";
    if (!KIND_TYPE[entry.kind].includes(type)) {
      fail("S1", at, `a ${entry.kind} step cannot be a ${TYPE_WORD[type]}: ${JSON.stringify(step.text)}`);
      continue;
    }
    if (entry.kind === "state") {
      const mach = entry.machine;
      const value = m[1];
      if (!MACHINES[mach].states.includes(value)) {
        fail("S1", at, `${JSON.stringify(value)} is not a state of ${mach}`);
        continue;
      }
      if (type === "Context") {
        if (started.has(mach) && state[mach] !== value)
          fail("S4", at, `Given sets ${mach} to ${value} after its events moved it to ${state[mach]}`);
        state[mach] = value;
      } else {
        if (!(mach in state)) fail("S4", at, `Then asserts ${mach} with no Given state for it`);
        else if (state[mach] !== value) fail("S4", at, `Then says ${mach} is ${value}, the table gives ${state[mach]}`);
        const o = lastOcc[mach];
        if (o && o.asserted === null) o.asserted = value;
      }
    } else if (entry.kind === "atom") {
      let value;
      try {
        value = "value" in entry ? entry.value : coerce(entry.machine, entry.atom, m[1]);
      } catch (err) {
        fail("S1", at, err.message);
        continue;
      }
      (atoms[entry.machine] ??= {})[entry.atom] = value;
    } else if (entry.kind === "event") {
      eventsReplayed++;
      const mach = entry.machine;
      const ev = entry.event;
      checkLinks(mach, state, atoms, at);
      if (!(mach in state)) {
        fail("S2", at, `event ${ev} on ${mach} with no Given state for it`);
        continue;
      }
      const rows = GROUPS.get(groupKey(mach, state[mach], ev));
      if (!rows) {
        fail("S2", at, `${mach} in ${state[mach]} has no row for ${ev} (the event is not enabled there)`);
        continue;
      }
      const known = atoms[mach] ?? {};
      const rel = relevantAtoms(mach, rows);
      const free = rel.filter((a) => !(a in known));
      const chosen = new Set();
      const md = MACHINES[mach];
      // Atoms outside the group's guards do not change the row; fill them with their first value.
      const filler = {};
      for (const a of md.atomNames) if (!rel.includes(a) && !(a in known)) filler[a] = md.atoms[a][0];
      let broken = false;
      for (const v of product(free, md.atoms, { ...filler, ...known })) {
        let hold;
        try {
          hold = rows.filter((r) => r.g(withDefs(md, v)));
        } catch (err) {
          broken = true; // a T1 failure, reported by the table check
          break;
        }
        chosen.add(hold[0]); // T1 guarantees exactly one; a T1 failure is reported on its own
      }
      if (broken) {
        fail("S2", at, `${mach} ${state[mach]} --${ev}: the table's guards cannot be evaluated (see T1)`);
        continue;
      }
      if (chosen.size !== 1 || chosen.has(undefined)) {
        fail("S3", at, `${mach} ${state[mach]} --${ev}: undetermined; set ${free.join(", ")}`);
        continue;
      }
      const row = [...chosen][0];
      exercised.push(row);
      const occ = { machine: mach, from: state[mach], event: ev, guard: row.guard, to: row.to, atoms: { ...known }, asserted: null, where: at };
      occurrences.push(occ);
      lastOcc[mach] = occ;
      state[mach] = row.to;
      started.add(mach);
    }
  }
  return exercised;
}

// ------------------------------------------------------------------ run every pickle

const rowsCovered = new Map(); // tag -> [where]
const hazardsTagged = new Map(); // H -> [where]
const ucCovered = new Set();
const hazardsTaggedUnder = new Set();
const rowsUnderUc = new Set(); // "UC-xx|row index" when a scenario tagged UC-xx exercised the row // "UC-xx|H-xxx" when a scenario tagged UC-xx also tags H-xxx

for (const p of pickles) {
  const exercised = replay(p);
  const want = [...new Set(exercised.map((r) => r.tag))];
  const tags = p.pickle.tags.map((t) => t.name);
  const have = tags.filter((t) => t.startsWith("@t:"));
  for (const t of have) {
    if (!ROW_BY_TAG.has(t)) fail("S5", p.where, `${t} names no row of the table`);
    else if (!want.includes(t)) fail("S5", p.where, `${t} is not exercised by the scenario`);
  }
  for (const t of want) if (!have.includes(t)) fail("S5", p.where, `exercised row has no tag: ${t}`);
  for (const t of want) {
    if (!rowsCovered.has(t)) rowsCovered.set(t, []);
    rowsCovered.get(t).push(p.where);
  }
  for (const r of exercised) for (const t of tags) if (/^@UC-\d{2}$/.test(t)) rowsUnderUc.add(`${t.slice(1)}|${r.index}`);
  // traceability
  const uc = tags.filter((t) => /^@(UC|OOS)-\d{2}$/.test(t)).map((t) => t.slice(1));
  const hz = tags.filter((t) => /^@H-\d{3}$/.test(t)).map((t) => t.slice(1));
  for (const t of tags)
    if (!t.startsWith("@t:") && !/^@(UC|OOS)-\d{2}$/.test(t) && !/^@H-\d{3}$/.test(t) && !ALLOWED_TAGS.has(t))
      fail("S8", p.where, `unknown tag ${t}`);
  if (!uc.length) fail("S8", p.where, "no @UC-xx tag");
  if (!hz.length) fail("S8", p.where, "no @H-xxx tag");
  for (const u of uc) {
    if (!UCS[u]) fail("S8", p.where, `@${u} is not a use case of use-cases.md`);
    else if (UCS[u].oos) fail("S8", p.where, `@${u} is out of scope`);
    else ucCovered.add(u);
  }
  for (const h of hz) {
    if (!HAZARDS.has(h)) fail("S8", p.where, `@${h} is not in hazards.md`);
    else if (!uc.some((u) => UCS[u]?.hazards.has(h))) fail("S8", p.where, `@${h} is not listed under ${uc.map((u) => "@" + u).join(", ")} in use-cases.md`);
    if (!hazardsTagged.has(h)) hazardsTagged.set(h, []);
    hazardsTagged.get(h).push(p.where);
    for (const u of uc) hazardsTaggedUnder.add(`${u}|${h}`);
  }
}

// Scenario names are unique across the folder (the pickles of one outline share its name).
{
  const byName = new Map();
  for (const p of pickles) {
    const where = `${p.file}:${p.scenario.location.line}`;
    if (!byName.has(p.scenario.name)) byName.set(p.scenario.name, new Set());
    byName.get(p.scenario.name).add(where);
  }
  for (const [n, ws] of byName) if (ws.size > 1) fail("S8", [...ws].join(", "), `scenario name used ${ws.size} times: ${n}`);
}

// ------------------------------------------------------------------ S6: cross-scenario conflicts

let conflictPairs = 0;
{
  const byRow = new Map();
  for (const o of occurrences) {
    if (o.asserted === null) continue;
    const k = `${o.machine}|${o.from}|${o.event}|${o.guard}`;
    if (!byRow.has(k)) byRow.set(k, new Map());
    const m = byRow.get(k);
    if (!m.has(o.asserted)) m.set(o.asserted, o.where);
  }
  for (const [k, m] of byRow)
    if (m.size > 1) fail("S6", [...m.values()].join(" vs "), `same (machine, from, event, guard) ${k} asserts ${[...m.keys()].join(" and ")}`);

  const byGroup = new Map();
  for (const o of occurrences) {
    if (o.asserted === null) continue;
    const k = groupKey(o.machine, o.from, o.event);
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(o);
  }
  const compatible = (a, b) => Object.keys(a).every((x) => !(x in b) || a[x] === b[x]);
  for (const list of byGroup.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        conflictPairs++;
        const a = list[i];
        const b = list[j];
        if (a.asserted !== b.asserted && compatible(a.atoms, b.atoms))
          fail("S6", `${a.where} vs ${b.where}`, `${a.machine} ${a.from} --${a.event}: compatible atoms ${JSON.stringify(a.atoms)} / ${JSON.stringify(b.atoms)} but asserted ${a.asserted} vs ${b.asserted}`);
      }
  }
}

// ------------------------------------------------------------------ coverage and report

const inScope = Object.keys(UCS).filter((u) => !UCS[u].oos);
for (const u of inScope) if (!ucCovered.has(u)) fail("S8", "use-cases.md", `${u} has no scenario`);

// S9: every event's resulting state is asserted before the machine's next event (or the scenario's end), so the
// order a race scenario claims is observable step by step.
const unasserted = occurrences.filter((o) => o.asserted === null);
for (const o of unasserted) fail("S9", o.where, `no Then asserts ${o.machine} after ${o.from} --${o.event}--> ${o.to}`);

// S12: a row the table claims unreachable (r.unreachable) must be: every valuation of its machine's atoms that holds
// its guard, with the machine in the row's from-state, breaks a link: one whose "if" keys are all this machine's own
// and holds, with a "then" key of this machine that fails. Such a row stays for exhaustiveness and is not asked for a
// scenario; a scenario that exercises it is a contradiction.
const rowsUnreachable = [];
const ownKey = (k, mach) => k.split(".")[0] === mach;
for (const r of ROWS) {
  if (!r.unreachable) continue;
  const m = MACHINES[r.machine];
  const own = LINKS.filter((ln) => Object.keys(ln.if).every((k) => ownKey(k, r.machine)));
  let reachable = null;
  for (const v of product(m.atomNames, m.atoms)) {
    const env = withDefs(m, v);
    if (!r.g(env)) continue;
    const state = { [r.machine]: r.from };
    const atoms = { [r.machine]: v };
    const broken = own.some(
      (ln) =>
        Object.entries(ln.if).every(([k, vs]) => vs.includes(linkValue(k, state, atoms))) &&
        Object.entries(ln.then).some(([k, vs]) => ownKey(k, r.machine) && !vs.includes(linkValue(k, state, atoms))),
    );
    if (!broken) {
      reachable = v;
      break;
    }
  }
  if (reachable) fail("S12", `table:${r.tag}`, `claimed unreachable, but ${JSON.stringify(reachable)} breaks no link`);
  else if (rowsCovered.has(r.tag)) fail("S12", `table:${r.tag}`, "claimed unreachable, but a scenario exercises it");
  else rowsUnreachable.push(r);
}
const rowsNot = ROWS.filter((r) => !rowsCovered.has(r.tag) && !rowsUnreachable.includes(r));
const unusedPhrases = STEPS.filter((s) => !s.used).map((s) => s.phrase);
const nScenarioNodes = new Set(pickles.map((p) => `${p.file}:${p.scenario.location.line}`)).size;

// Hazard coverage, in tiers: (1) tagged on a scenario; (2) named only by a table row some scenario exercised;
// (3) named under a use case's "V&V outside the scenarios"; (4) listed only under out-of-scope use cases
// (accepted residuals); (5) none of these: a gap.
const hazardsViaRows = new Set();
for (const r of ROWS) if (rowsCovered.has(r.tag)) for (const h of r.hazards) hazardsViaRows.add(h);
const outsideAll = new Set(Object.values(UCS).flatMap((u) => [...u.outside]));
const listedInScope = new Set(inScope.flatMap((u) => [...UCS[u].hazards]));
const listedOos = new Set(Object.values(UCS).filter((u) => u.oos).flatMap((u) => [...u.hazards]));
const tier = {};
for (const h of [...HAZARDS].sort()) {
  tier[h] = hazardsTagged.has(h)
    ? "tagged"
    : hazardsViaRows.has(h)
      ? "row"
      : outsideAll.has(h)
        ? "outside"
        : listedOos.has(h) && !listedInScope.has(h)
          ? "oos"
          : "gap";
}
const byTier = (t) => Object.keys(tier).filter((h) => tier[h] === t);
// Per use case: a hazard it lists, neither tagged on one of its scenarios, nor named by a row one of its scenarios
// exercised, nor under its own "V&V outside".
const ucGaps = [];
for (const u of inScope)
  for (const h of [...UCS[u].hazards].sort()) {
    const viaRow = ROWS.some((r) => r.hazards.includes(h) && rowsUnderUc.has(`${u}|${r.index}`));
    if (!hazardsTaggedUnder.has(`${u}|${h}`) && !viaRow && !UCS[u].outside.has(h)) ucGaps.push(`${u}:${h}`);
  }

const counts = {
  gherkin: `@cucumber/gherkin ${gherkinVersion}`,
  featureFiles: featureFiles.length,
  scenarios: nScenarioNodes,
  pickles: pickles.length,
  stepPhrases: STEPS.length,
  stepPhrasesUsed: STEPS.length - unusedPhrases.length,
  tableRows: ROWS.length,
  tableGroups: GROUPS.size,
  valuationsChecked,
  eventsReplayed,
  rowsExercised: ROWS.length - rowsNot.length - rowsUnreachable.length,
  rowsUnreachable: rowsUnreachable.length,
  occurrencePairsCompared: conflictPairs,
  eventsWithoutThen: unasserted.length,
  useCasesCovered: ucCovered.size,
  useCasesInScope: inScope.length,
  hazards: HAZARDS.size,
  hazardsTagged: byTier("tagged").length,
  hazardsOnlyViaExercisedRows: byTier("row").length,
  hazardsValidatedOutside: byTier("outside").length,
  hazardsAcceptedOutOfScope: byTier("oos").length,
  hazardsGap: byTier("gap").length,
  useCaseHazardGaps: ucGaps.length,
  selectionDigest,
  failures: failures.length,
};

console.log(`${counts.gherkin}; ${counts.featureFiles} feature files, ${counts.scenarios} scenarios, ${counts.pickles} pickles (outline rows counted)`);
console.log(`table: ${counts.tableRows} rows in ${counts.tableGroups} groups; ${counts.valuationsChecked} valuations checked for overlap and gaps (selection sha256 ${selectionDigest.slice(0, 16)})`);
console.log(`steps: ${counts.stepPhrases} phrases (${counts.stepPhrasesUsed} used); ${counts.eventsReplayed} events replayed, ${counts.eventsWithoutThen} without a Then`);
console.log(`rows exercised: ${counts.rowsExercised} of ${counts.tableRows}; ${counts.rowsUnreachable} proven unreachable by a link (S12)`);
console.log(`cross-scenario: ${counts.occurrencePairsCompared} pairs of asserted events at the same (machine, from, event) compared`);
console.log(`use cases with scenarios: ${counts.useCasesCovered} of ${counts.useCasesInScope} in scope`);
console.log(`hazards (${counts.hazards}): ${counts.hazardsTagged} tagged on a scenario, ${counts.hazardsOnlyViaExercisedRows} named only by an exercised row, ${counts.hazardsValidatedOutside} under "V&V outside the scenarios", ${counts.hazardsAcceptedOutOfScope} accepted out of scope, ${counts.hazardsGap} not covered`);
console.log(`use-case hazard gaps: ${counts.useCaseHazardGaps} (a hazard a use case lists that none of its scenarios, exercised rows or V&V-outside notes cover)`);
if (flag("--coverage")) {
  for (const r of rowsNot) console.log(`  row not exercised: ${r.tag}`);
  for (const t of ["row", "outside", "oos", "gap"]) if (byTier(t).length) console.log(`  hazards ${t}: ${byTier(t).join(", ")}`);
  if (ucGaps.length) console.log(`  use-case hazard gaps: ${ucGaps.join(", ")}`);
  for (const p of unusedPhrases) console.log(`  phrase not used: ${p}`);
}
const jsonOut = opt("--json");
if (jsonOut) {
  const hazards = Object.fromEntries(["tagged", "row", "outside", "oos", "gap"].map((t) => [t, byTier(t)]));
  writeFileSync(jsonOut, `${JSON.stringify({ counts, failures, rowsNotExercised: rowsNot.map((r) => r.tag), hazards, ucGaps }, null, 2)}\n`);
}
for (const h of byTier("gap")) fail("S11", "hazards.md", `${h} is covered by no scenario, exercised row, V&V-outside entry or out-of-scope use case`);
for (const g of ucGaps) fail("S11", "use-cases.md", `${g}: the use case lists the hazard but none of its scenarios, exercised rows or V&V-outside entries cover it`);
counts.failures = failures.length;
if (failures.length) {
  const order = (f) => `${f.code}${f.where}`;
  for (const f of [...failures].sort((a, b) => (order(a) < order(b) ? -1 : 1))) console.log(`${f.code} ${f.where}: ${f.msg}`);
  const byCode = {};
  for (const f of failures) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  console.log(`FAIL: ${failures.length} (${Object.entries(byCode).map(([c, n]) => `${c} ${n}`).join(", ")})`);
  process.exit(1);
}
console.log("OK: guards exclusive and exhaustive; every step maps; every event enabled and determined; every Then is the table's; every @t tag exercised; no two scenarios conflict; every link holds; no hazard or use-case gap");
