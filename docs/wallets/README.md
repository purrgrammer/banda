# Agent-operable EVM wallets: system analysis

Status: analysis for the RFC in [`../wallets.md`](../wallets.md) (the owner's requirements are in its "Requirements"
section), dated 2026-11-23. Nothing here is a DESIGN.md rule (principle 6): the documents hold the analysis, the
scenarios and the evidence a design would rest on. Everything ran on anvil, forks or testnets, with no real funds.

## Deliverables

| Path | What it is |
|---|---|
| [`research/`](research/) | Library and standards research with sources and dates: [signing libraries](research/signing-libraries.md), [OS keychain](research/os-keychain.md), [chain operations](research/chain-operations.md), [wallet security](research/wallet-security.md), [x402](research/x402.md); micro-spikes in `research/spikes/`. |
| [`hazards.md`](hazards.md) | The register of hazards (H-nnn), owner decisions (OD-n) and trust assumptions (TA-n), merged from the three analyses in [`analysis/`](analysis/) (durability and concurrency, security and trust, product and lifecycle) and their spikes. |
| [`conflicts.md`](conflicts.md) | The deterministic rules (C1 to C23) that resolve every conflict between scenarios, so two scenarios never disagree. |
| [`stack.md`](stack.md) | The chosen libraries and versions (exact, with publish dates, licences and advisories) and what each does. |
| [`use-cases.md`](use-cases.md) | The use cases (UC-xx, with out-of-scope OOS-xx), each with the hazards it must answer. |
| [`model/`](model/) | The formal models: six TLA+ modules checked with TLC, the `*_bug_*` configurations that must fail, and `transitions.json`, the deterministic transition table of the seven state machines. See [`model/README.md`](model/README.md). |
| [`features/`](features/) | The Gherkin scenarios (12 files, 162 scenarios, 315 with outline rows), the closed step vocabulary [`STEPS.md`](features/STEPS.md), the isolation rules [`ISOLATION.md`](features/ISOLATION.md), and a standard-library gate `check_features.py`. |
| [`verification/`](verification/) | The scenario and model checker (`check-scenarios.mjs`, official Gherkin parser), its mutation check, the adversarial [`REVIEW.md`](verification/REVIEW.md), and the final run [`REPORT.md`](verification/REPORT.md). |
| [`spikes/`](spikes/) | Micro-spikes that confirm outside-world claims: [keychain](spikes/keychain/), [keys and signing](spikes/keys-and-signing/), [nonce and crash](spikes/nonce-and-crash/), [tx history](spikes/tx-history/), [x402 settlement](spikes/x402-settlement/), [banda integration](spikes/banda-integration/), [gaps](spikes/gaps/), [lane model](spikes/lane-model/). Analysis spikes are in `analysis/spikes/`. |
| [`uml/`](uml/) | PlantUML sources and rendered SVGs: 2 use-case, 3 structure, 11 sequence, 1 activity and 7 state diagrams (the state diagrams are generated from `transitions.json`). See [`uml/README.md`](uml/README.md). |

## Re-running the checks

Docker (OrbStack or Docker Desktop), Node 24 and python3 are needed. Install any dependency outside the repository.

**Scenario checker and mutations** (about 0.3 s each; exit 1 on a failure):

```sh
DEPS=/path/outside/the/repo/checker
mkdir -p "$DEPS" && cd "$DEPS" && npm init -y >/dev/null
npm install --save-exact --ignore-scripts @cucumber/gherkin@43.0.0 @cucumber/messages@35.0.0
cd <repo>
node docs/wallets/verification/check-scenarios.mjs --deps "$DEPS" --coverage
node docs/wallets/verification/mutations.mjs --deps "$DEPS"
python3 -I docs/wallets/features/check_features.py     # independent gate, standard library only
python3 -I docs/wallets/model/check_transitions.py     # transition table: guards exclusive and exhaustive (slow: a few minutes)
```

**TLC** (TLC 2.19, `tla2tools.jar` of https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). Copy `model/*.tla` and
`model/*.cfg` to a scratch folder so that TLC's outputs stay out of the repo, then, for one configuration:

```sh
docker run --rm --name tlc-$RANDOM -v "$SCRATCH":/m -v /path/to/tla2tools.jar:/t.jar:ro -w /m eclipse-temurin:21-jre \
  java -Xmx4g -XX:+UseParallelGC -cp /t.jar tlc2.TLC -workers 2 -cleanup -metadir /tmp/st \
  -config SharedBalance_safety.cfg MC_SharedBalance.tla
```

The module is `MC_<Name>.tla` for `<Name>_<variant>.cfg`. A `*_bug_*` or `*_mut_*` configuration must fail on the
property named in [`model/README.md`](model/README.md); a pass there is a failed check. Several runs take an hour or
more (45M distinct states and up), and five are recorded there as stopped. `gen_cfgs.py` regenerates the
configurations, and `build_transitions.py` regenerates `transitions.json`.

**UML renders** (PlantUML `1.2026.10`, pinned by digest in the script; regenerates and checks the state diagrams,
syntax-checks every file, then writes `uml/svg/`; exits non-zero on any error):

```sh
sh docs/wallets/uml/render.sh
```

The last full run of all of these is recorded in [`verification/REPORT.md`](verification/REPORT.md).
