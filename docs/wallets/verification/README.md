# Scenario and model consistency checker

Status: analysis for the RFC in [`../../wallets.md`](../../wallets.md), dated 2026-11-23. Nothing here is a DESIGN.md
rule (principle 6).

[`check-scenarios.mjs`](check-scenarios.mjs) replays every scenario of [`../features/`](../features/) on the transition
table [`../model/transitions.json`](../model/transitions.json), using the step vocabulary
[`../features/STEPS.md`](../features/STEPS.md). The `.feature` files are parsed with the official Cucumber parser,
`@cucumber/gherkin`, and compiled to pickles. Each Scenario gives one pickle, and each Examples row gives one more. The
parser resolves `And` and `But` to Given, When or Then. The checker is deterministic: it uses no clock, no randomness
and no network. Its output depends only on the files, and the same files always produce the same output.

It runs beside the standard-library gate [`../features/check_features.py`](../features/check_features.py). The two
are independent implementations of the same rules: a hand parser with Python's `eval`, and the official parser with
an evaluator written for the guards. Their totals match. [`mutations.mjs`](mutations.mjs) also proves that the two
evaluators select the same rows on every valuation of the table.

## What it checks

The checker exits with 1 on any of these failures:

| Code | Failure |
|---|---|
| T1 | A group's guards overlap or leave a gap for some valuation of the machine's atoms (full enumeration), a guard can never hold, or a guard names an undeclared atom. A group is one machine, one `from` state and one event. |
| T2 | A row names an undeclared state, or a terminal state changes. |
| S1 | A step matches no phrase of STEPS.md, or more than one. A step's keyword does not fit its kind (state: Given or Then; atom: Given; event: When; invariant: Then). A state value is outside its machine. |
| S2 | An event is not enabled: the machine has no Given state, or has no row for the event in its current state. |
| S3 | An event is undetermined: two completions of the atoms the scenario left unset select different rows. |
| S4 | A `Then` state contradicts the state the table gives, or a `Given` state overrides a machine after its events moved it. |
| S5 | An `@t` tag names no row, or names a row the scenario did not exercise, or a row the scenario exercised has no `@t` tag. |
| S6 | Two scenarios reach the same (machine, from, event, guard) and assert different outcomes. Also, two scenarios at the same (machine, from, event) set compatible atoms (some valuation satisfies both) and assert different outcomes. The second check uses only the scenarios, not the table's `to`. |
| S7 | An invariant phrase names a definition its TLA+ module lacks, or a STEPS.md phrase is malformed or defined twice. |
| S8 | Traceability is broken: a scenario has no in-scope `@UC-xx`, no `@H-xxx`, or an unknown tag; an `@H-xxx` is not in hazards.md or not listed under one of the scenario's use cases; a use case has no scenario; a scenario name is used twice; a placeholder is not substituted; an Examples column is unused; a Background, Rule or step argument appears; the Gherkin does not parse. |
| S9 | An event's resulting state is not asserted by a `Then` before the machine's next event or the end of the scenario, so the order a race scenario claims cannot be observed step by step. |
| S10 | Cross-machine coherence: at an event of a machine that a link of `transitions.json` names, the scenario's states and atoms break the link (a payment admitted as Always while its recipient is denied; a wallet archived while the payment reads its wallet as usable). |
| S11 | A coverage gap: a hazard of hazards.md is covered by no scenario tag, no exercised row, no "V&V outside the scenarios" entry and no out-of-scope use case; or a use case lists a hazard that none of its own scenarios, exercised rows or V&V-outside entries cover. |
| S12 | A row the table marks `unreachable` is reachable: some valuation that holds its guard keeps every link of its own machine, or a scenario exercises it. A row so marked is proven unreachable instead of being counted as unexercised. |

It also reports, without failing:

- the rows no scenario exercises, and the rows S12 proved unreachable;
- hazard coverage in five tiers: tagged on a scenario; named only by a row some scenario exercised; listed under a use
  case's "V&V outside the scenarios" (ranges such as `H-061 to H-067` and "all eight hazards" are expanded); accepted
  out of scope (listed only under an `OOS-` use case); not covered (a failure, S11);
- the STEPS.md phrases no scenario uses.

`check_features.py` applies the same gap rule as S11, with its own parser of the use cases' "V&V outside" field, so a
hazard or a use-case hazard left uncovered fails both gates.

## Current result

From [`check-scenarios.out.txt`](check-scenarios.out.txt) (run with `--coverage`) and
[`mutations.out.txt`](mutations.out.txt):

- 12 feature files, 162 scenarios, 315 pickles; 297 rows in 163 groups and 7 machines, guards exclusive and
  exhaustive over 1,158,618 valuations;
- 295 of 297 rows exercised; the other 2 (a permission refusal under an Always recipient) proven unreachable by the
  link `PermissionUnderRecipient` (S12);
- 231 of 231 phrases used; 406 events replayed, each with its `Then`; 744 cross-scenario pairs compared;
- 29 of 29 use cases in scope have scenarios;
- hazards (317): 145 tagged, 20 named only by an exercised row, 146 under "V&V outside the scenarios", 6 accepted out
  of scope, 0 gaps; 0 use-case hazard gaps;
- mutations: 29 of 29 caught, one or more per failure code, and the two evaluators agree on every valuation.

What the scenario layer does not show: a crash row (`X · crash → X`) is the identity, so a crash outline asserts only
that nothing changed. The crash and power-loss behaviour is checked by the TLA+ models (`../model/README.md`) and by
the fault sweep under `test/fault/` the slices add. Power loss is a scenario event (`power_loss`) that rewinds to the
last synced commit; a SIGKILL in the sweep never loses a WAL commit, so C21 gets its own runner, a store on a
filesystem that drops unsynced writes (`../features/ISOLATION.md` section 7), still to be chosen by spike I12.

## Running it

The parser is installed outside the repository, in a scratch folder. No `node_modules` and no `package.json` are added
to the repo. Use Node 24 or later (this was run on 24.22.1).

```sh
DEPS=/path/to/scratch/checker          # any folder outside the repo
mkdir -p "$DEPS" && cd "$DEPS" && npm init -y >/dev/null
npm install --save-exact --ignore-scripts @cucumber/gherkin@43.0.0 @cucumber/messages@35.0.0
npm audit                               # 0 vulnerabilities on 2026-11-23

cd <repo>
node docs/wallets/verification/check-scenarios.mjs --deps "$DEPS"              # the gate (exit 1 on any failure)
node docs/wallets/verification/check-scenarios.mjs --deps "$DEPS" --coverage   # also lists rows and hazards by tier
node docs/wallets/verification/check-scenarios.mjs --deps "$DEPS" --json out.json
node docs/wallets/verification/mutations.mjs --deps "$DEPS"                    # proves each failure code fires
```

`CHECKER_DEPS=<dir>` can be used instead of `--deps`. The run that produced
[`check-scenarios.out.txt`](check-scenarios.out.txt) and [`mutations.out.txt`](mutations.out.txt) used a scratch install of those two
packages outside the repository.
A full run takes about 0.3 s.

## Dependencies

| Package | Version | Published | License | Integrity |
|---|---|---|---|---|
| `@cucumber/gherkin` | 43.0.0 (latest) | 2026-11-13 | MIT | `sha512-WaEgGoOVJ8yU2kyMBLxhdlSXmF/zOjdH6EUIzxEZV1UrgAekuOFjDzqYoC5LuN3PGWjjBYX9pu8l9MBn6mFMow==` |
| `@cucumber/messages` | 35.0.0 (the only version gherkin 43 accepts above 34: `>=34.0.0 <36`) | 2026-11-12 | MIT | `sha512-lubB5srgXxXwz9uVIJXdk4dm+CdKj7qfrGNHqFvlBtt4wrUb9413KBOJUpdUWTasJmQe9pYAa2rYNIl3yfW4Ag==` |

Sources:

- the npm registry, `npm view @cucumber/gherkin@43.0.0` and `npm view @cucumber/messages@35.0.0`, read 2026-11-23;
- the parser's source at https://github.com/cucumber/gherkin, the repository the package names, read 2026-11-23;
- `npm audit` on the scratch install, run 2026-11-23, which reported 0 advisories in the GitHub Advisory Database for
  these two packages.

The checker uses only the parser's documented exports (`AstBuilder`, `Parser`, `GherkinClassicTokenMatcher`,
`compile`) and `IdGenerator` from messages, so a later major version is a one-line change to the install command.

Gherkin 43.0.0 was ten days old on the date of this run, a new major version. It is used because the task asked for
the latest exact version, and the checker is a docs tool that never ships. [`mutations.mjs`](mutations.mjs) is the
check that this parser behaves as the checker expects: a Gherkin parse error, a Background, keyword resolution and
outline substitution are each exercised. If the checker ever moves into the repo's toolchain, pin the version with the
repo's other dependencies (AGENTS.md principle 13).
