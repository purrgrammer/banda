#!/usr/bin/env node
// Proves check-scenarios.mjs catches what it claims to: each mutation below breaks one rule in a copy of
// docs/wallets (in a temporary folder, never in the repo), runs the checker on the copy, and expects exit 1 with the
// named failure code. The unmutated copy must pass. It also compares the checker's guard evaluator with Python's own
// eval over every valuation of every group of the table (the table's guards are Python expressions).
//
// Run: node docs/wallets/verification/mutations.mjs --deps <dir holding node_modules/@cucumber/gherkin>

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const args = process.argv.slice(2);
const i = args.indexOf("--deps");
const deps = i >= 0 ? args[i + 1] : process.env.CHECKER_DEPS;
if (!deps) {
  console.error("pass --deps <dir> or CHECKER_DEPS (see README.md)");
  process.exit(2);
}

const COPY = ["features", "model/transitions.json", "hazards.md", "use-cases.md", "verification/check-scenarios.mjs"];
const TLA = ["WalletLifecycle", "RecipientRule", "PaymentLane", "NonceAlloc", "X402", "SharedBalance"];

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "wallet-checker-mut-"));
  for (const p of COPY) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  for (const m of TLA) cpSync(join(ROOT, "model", `${m}.tla`), join(dir, "model", `${m}.tla`));
  return dir;
}

function run(dir, extra = []) {
  const r = spawnSync(process.execPath, [join(dir, "verification/check-scenarios.mjs"), "--deps", deps, ...extra], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function edit(dir, file, from, to) {
  const p = join(dir, file);
  const s = readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from.slice(0, 60)}`);
  writeFileSync(p, s.replace(from, to));
}

function editTable(dir, fn) {
  const p = join(dir, "model/transitions.json");
  const t = JSON.parse(readFileSync(p, "utf8"));
  fn(t);
  writeFileSync(p, JSON.stringify(t, null, 1));
}

const rowOf = (t, m, from, ev, guard) => t.transitions.find((r) => r.machine === m && r.from === from && r.event === ev && r.guard === guard);
const FIRST = "Scenario: An agent pays a recipient set to Always, and it lands exactly once";

const mutations = [
  ["T1", "two guards of a group overlap", (d) => editTable(d, (t) => { rowOf(t, "wallet", "creating", "keychain_write", "kc_up and item != 'empty'").guard = "kc_up"; })],
  ["T1", "a group's guards leave a gap", (d) => editTable(d, (t) => { rowOf(t, "wallet", "creating", "keychain_write", "kc_up and item != 'empty'").guard = "kc_up and item == 'other'"; })],
  ["T1", "a guard can never hold", (d) => editTable(d, (t) => { t.transitions.push({ ...rowOf(t, "wallet", "none", "create", "True"), guard: "funds and not funds", to: "dropped" }); })],
  ["T1", "a guard names an undeclared atom", (d) => editTable(d, (t) => { rowOf(t, "wallet", "none", "create", "True").guard = "True or nonsense"; rowOf(t, "wallet", "none", "create", "True or nonsense").guard = "nonsense == 'x' or True"; })],
  ["T2", "a row names an undeclared state", (d) => editTable(d, (t) => { rowOf(t, "wallet", "none", "create", "True").to = "limbo"; })],
  ["T2", "a terminal state changes", (d) => editTable(d, (t) => { t.transitions.push({ ...rowOf(t, "wallet", "none", "create", "True"), from: "removed", to: "creating" }); })],
  ["S1", "a step matches no phrase (typo)", (d) => edit(d, "features/payments.feature", '    Then the payment is "Queued"\n    When the signer signs', '    Then the paymnt is "Queued"\n    When the signer signs')],
  ["S1", "an event written as Given", (d) => edit(d, "features/payments.feature", "    When the payment is requested\n", "    Given the payment is requested\n")],
  ["S1", "a state value outside the machine", (d) => edit(d, "features/payments.feature", '    Then the payment is "Queued"\n    When the signer signs', '    Then the payment is "Pending"\n    When the signer signs')],
  ["S2", "an event not enabled in the current state", (d) => edit(d, "features/payments.feature", "    When the payment is requested\n", "    When the payment's block reaches finality\n    When the payment is requested\n")],
  ["S3", "an event left undetermined", (d) => edit(d, "features/payments.feature", `${FIRST}\n    Given the payment is "Idle"\n    And the payer is the agent\n    And the wallet is usable by the payer\n    And the payment's recipient is set to Always\n    And the available balance covers the payment\n`, `${FIRST}\n    Given the payment is "Idle"\n    And the payer is the agent\n    And the wallet is usable by the payer\n    And the payment's recipient is set to Always\n`)],
  ["S4", "a Then contradicts the table", (d) => edit(d, "features/payments.feature", '    When the lane runs the start commit\n    Then the payment is "Signed"', '    When the lane runs the start commit\n    Then the payment is "Queued"')],
  ["S5", "an @t tag names no row", (d) => edit(d, "features/payments.feature", "  @t:payment:Signed:broadcast:T\n", "  @t:payment:Signed:broadcast:T\n  @t:payment:Idle:teleport:T\n")],
  ["S5", "an @t tag the scenario does not exercise", (d) => edit(d, "features/payments.feature", "  @t:payment:Signed:broadcast:T\n", "  @t:payment:Signed:broadcast:T\n  @t:wallet:none:create:T\n")],
  ["S5", "an exercised row without its @t tag", (d) => edit(d, "features/payments.feature", "  @t:payment:Signed:broadcast:T\n", "")],
  ["S6", "two scenarios assert different outcomes at the same row", (d) => {
    const p = join(d, "features/payments.feature");
    const s = readFileSync(p, "utf8");
    const a = s.indexOf("  @UC-07 @UC-10 @H-074 @H-112 @best");
    const b = s.indexOf("\n\n", s.indexOf(FIRST)) + 2;
    const clone = s.slice(a, b).replace(FIRST, "Scenario: A clone that claims the start commit leaves the payment queued").replace('    When the lane runs the start commit\n    Then the payment is "Signed"', '    When the lane runs the start commit\n    Then the payment is "Queued"');
    writeFileSync(p, `${s}\n${clone}`);
  }],
  ["S7", "an invariant phrase names an undefined TLA+ definition", (d) => edit(d, "features/STEPS.md", "`PaymentLane.AtMostOnePaid`", "`PaymentLane.AtMostOncePaidTwice`")],
  ["S7", "a phrase defined twice", (d) => edit(d, "features/STEPS.md", "| `the owner creates a wallet` | event | `wallet.create` |", "| `the owner creates a wallet` | event | `wallet.create` | x |\n| `the owner creates a wallet` | event | `wallet.create` |")],
  ["S8", "an @H tag not in hazards.md", (d) => edit(d, "features/payments.feature", "  @UC-07 @UC-10 @H-074 @H-112 @best", "  @UC-07 @UC-10 @H-074 @H-112 @H-999 @best")],
  ["S8", "an @H tag not listed under the scenario's use cases", (d) => edit(d, "features/payments.feature", "  @UC-07 @UC-10 @H-074 @H-112 @best", "  @UC-07 @UC-10 @H-074 @H-112 @H-001 @best")],
  ["S8", "a scenario without a use case", (d) => edit(d, "features/payments.feature", "  @UC-07 @UC-10 @H-074 @H-112 @best", "  @H-074 @H-112 @best")],
  ["S8", "an unknown tag", (d) => edit(d, "features/payments.feature", "  @UC-07 @UC-10 @H-074 @H-112 @best", "  @UC-07 @UC-10 @H-074 @H-112 @wip")],
  ["S8", "a duplicate scenario name", (d) => edit(d, "features/payments.feature", "Scenario: The first payment to an unknown recipient asks, the owner taps Pay, and the rule becomes Ask", `${FIRST}`)],
  ["S8", "a Gherkin parse error", (d) => edit(d, "features/payments.feature", `  ${FIRST}`, `  Scenari: broken\n  ${FIRST}`)],
  ["S8", "a Background", (d) => edit(d, "features/payments.feature", "Feature: An agent pays an address, and the owner answers when asked\n", 'Feature: An agent pays an address, and the owner answers when asked\n\n  Background:\n    Given the payment is "Idle"\n')],
  ["S10", "a scenario whose machines contradict each other (a denied recipient, its payment read as Always)", (d) => {
    const p = join(d, "features/payments.feature");
    writeFileSync(p, `${readFileSync(p, "utf8")}
  @UC-07 @H-074
  @t:payment:Idle:call:wallet_usable&payer=agent&eff=always&fits
  Scenario: A mutant whose recipient is denied while its payment reads Always
    Given the recipient is "deny"
    And the payment is "Idle"
    And the payer is the agent
    And the wallet is usable by the payer
    And the payment's recipient is set to Always
    And the available balance covers the payment
    When the payment is requested
    Then the payment is "Queued"
`);
  }],
  ["S11", "a hazard left with no scenario and no V&V-outside entry", (d) => edit(d, "use-cases.md", "; H-191 (lying-RPC balance test", "; (lying-RPC balance test")],
  ["S12", "a reachable row claimed unreachable", (d) => editTable(d, (t) => { rowOf(t, "permission", "none", "card_always", "version_current and not (rcpt != 'deny')").unreachable = "mutant"; })],
  ["S9", "an event with no Then after it", (d) => edit(d, "features/payments.feature", '    When the signer signs the payment\n    Then the payment is "Queued"\n    When the lane runs the start commit', "    When the signer signs the payment\n    When the lane runs the start commit")],
];

let failed = 0;
const base = fresh();
const b = run(base, ["--json", join(base, "out.json")]);
if (b.code !== 0) {
  console.log(`baseline: expected pass, got ${b.code}\n${b.out}`);
  failed++;
} else console.log("baseline: pass");

// The evaluator against Python's eval, valuation by valuation.
const digest = JSON.parse(readFileSync(join(base, "out.json"), "utf8")).counts.selectionDigest;
const py = `
import hashlib, itertools, json, sys
t = json.load(open(sys.argv[1]))
h = hashlib.sha256()
groups = {}
for i, r in enumerate(t["transitions"]):
    groups.setdefault((r["machine"], r["from"], r["event"]), []).append((i, r))
for (mn, _, _), rows in groups.items():
    m = t["machines"][mn]
    names = list(m["atoms"])
    for combo in itertools.product(*(m["atoms"][n] for n in names)):
        env = dict(zip(names, combo))
        for k, e in m["defs"].items():
            env[k] = eval(e, {}, dict(env))
        h.update((",".join(str(i) for i, r in rows if eval(r["guard"], {}, dict(env))) + ";").encode())
print(h.hexdigest())
`;
const p = spawnSync("python3", ["-I", "-c", py, join(ROOT, "model/transitions.json")], { encoding: "utf8" });
const pyDigest = p.stdout.trim();
if (p.status !== 0 || pyDigest !== digest) {
  console.log(`evaluator: JS ${digest} vs Python ${pyDigest || p.stderr}`);
  failed++;
} else console.log(`evaluator: agrees with Python eval on every valuation (sha256 ${digest.slice(0, 16)})`);
rmSync(base, { recursive: true, force: true });

for (const [code, what, mutate] of mutations) {
  const dir = fresh();
  try {
    mutate(dir);
    const r = run(dir);
    const hit = r.code === 1 && new RegExp(`^${code} `, "m").test(r.out);
    if (!hit) failed++;
    console.log(`${hit ? "caught" : "MISSED"} ${code}: ${what}${hit ? "" : `\n${r.out}`}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `FAIL: ${failed} of ${mutations.length + 2}` : `OK: baseline passes, evaluator agrees, ${mutations.length} of ${mutations.length} mutations caught`);
process.exit(failed ? 1 : 0);
