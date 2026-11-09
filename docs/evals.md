# Behavioral evaluation research and plan

banda should become more useful as an owner works with it: remember and apply the right information, improve after
corrections, complete complex work, keep long-term work moving, and speak proactively only when worthwhile. These
are behavioral claims to measure, not consequences of having a memory system or a test suite. This document proposes
a research program and eval specification; it does not claim a mechanism is implemented, accepted, or safe.

Behavioral evals complement, never replace, the deterministic trust, durability, fault, browser and product gates in
[Verification](verification.md). Follow [Delivery](delivery.md); the current implementation order and acceptance
remain in [Status](status.md). Synthetic tasks and eval dashboards do not replace using each slice through the app.

Use existing benchmark examples, harnesses and graders first. Do not build a general-purpose simulation platform or
an original scenario corpus when a suitable benchmark exists. The first milestone is a small, inspectable run of
published examples through banda, with model inputs and outcomes checked by hand. Add banda-specific tests only
for concrete gaps in those examples or the product's authority and durability contract.

## Research: comparable products and benchmarks

The following are product descriptions, not independently verified performance claims. Products, pages and
benchmarks change; pin their revisions and data before a comparison.

- [Muse](https://muse.ai/) is Meta's personal agent: its public page describes a persistent cloud computer, browser,
  approvals, background work, learned context and tool building. Its [design account](https://introducing.muse.ai/)
  describes one main chat, editable memory files, artifacts and a high bar for proactive
  messages. Its [security account](https://security.muse.ai/) describes an isolated runtime, credential separation and
  a separate authority for connector actions and egress. These claims suggest testing outcomes, interruption value,
  transparency and control together; they do not establish how well Muse learns in practice.
- [Grok Bot](https://x.ai/bot) describes persistent context, scheduled routines, parallel bots and teaching a
  workflow by demonstration. The teaching claim motivates a held-out workflow-transfer experiment, including a
  changed environment; it is not proof that a demonstrated workflow generalizes. banda need not adopt multiple
  visible companions or demonstration as a feature to evaluate the underlying learning question.
- [Hermes](https://github.com/NousResearch/hermes-agent) describes curated memory, session search, skill creation and
  refinement, and optional Honcho integration. Distinguish knowing the owner from acquiring a reusable procedure.
- [Honcho](https://github.com/plastic-labs/honcho) describes asynchronous synthesis of peer representations and
  retrieval over sessions. Treat synthesized observations as fallible, time-dependent hypotheses, not proof of owner
  intent or authority. A separate Honcho service can be a research baseline, not a second source of truth for banda.
- [OpenClaw memory](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md) describes layered,
  editable files, consolidation, optional hybrid retrieval and scheduled tasks for exact reminders. banda similarly
  distinguishes memory from durable promises; neither a memory file nor a model judgment enforces permission.
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval) tests extraction, multi-session reasoning, updates,
  temporal reasoning and abstention; evidence labels make retrieval diagnosis possible. [LoCoMo](https://github.com/snap-research/locomo)
  supplies long conversations and evidence-annotated questions, but its released ten conversations are not ten
  independent samples per question and its generated conversations do not prove usefulness to real owners.
  [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) tests memory from agent trajectories, including
  workflow knowledge and changed environment state. These are external diagnostics, not acceptance tests for a
  consumer agent. Pin dataset versions and licenses, and report conditions and categories rather than comparing
  vendor leaderboard claims across incompatible setups.

## Benchmark portfolio

Use published examples and, where practical, their existing evaluators. Start with a small subset to validate the
adapter, then use the benchmark's intended split and protocol when reporting a comparable score. A smoke subset is not
representative benchmark performance. Check dataset and code licenses separately before download, redistribution or
use; pin exact revisions. Do not copy datasets into the repository by default.

| Priority | Benchmark | Primary use | Key limitation |
|---|---|---|---|
| First | [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | Long-history recall, updates, abstention and evidence retrieval | Question answering, not full task performance |
| Later | [OP-Bench](https://github.com/yulinlp/OP-Bench) | Irrelevant personalization, sycophancy and repetition | Related cases share underlying histories; model-based grading needs calibration |
| Next | [VitaBench 2.0](https://github.com/meituan-longcat/VitaBench-2.0) | Preferences applied across consumer tasks | Check language availability, license and how its memory interface differs from banda |
| Next | [π-Bench](https://github.com/Simplified-Reasoning/Pi-Bench) | Proactive multi-session workflows and artifact completion | Hidden-intent discovery alone does not measure quietness |
| As needed | [AMemGym](https://github.com/AGI-Eval-Official/amemgym), [HABIT-Bench](https://github.com/LUMIA-Group/habit-bench) | Interactive memory diagnostics, scope and exceptions | Simulated users or multiple-choice answers do not establish real-world task success |
| As needed | [Memora](https://github.com/geniesinc/Memora), [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) | Behavioral forgetting and memory from agent trajectories | Suppressing an answer is not proof that stored copies were deleted |
| As needed | [PROBE](https://github.com/fastino-ai/PROBE_benchmark), [PARE](https://arxiv.org/abs/2604.00842) | Proactive problem detection and intervention timing | Check implementation availability, permissions and whether no-op cases are covered |
| As needed | [AhaBench](https://arxiv.org/abs/2609.05435), [SkillLearnBench](https://arxiv.org/abs/2604.20087) | Transfer from experience and learned skills | Check released code and task fit; success need not generalize to consumer tasks |
| As needed | [AgentDojo](https://github.com/ethz-spylab/agentdojo) | Tool-result prompt injection under legitimate tasks | Behavioral results do not prove a structural trust boundary |

These are candidates, not verified integrations. Before implementing an adapter, inspect its data, scorer, execution
requirements and licenses. Record whether the run tests banda's actual daemon and complete learning path, or only a
memory component. Replay requires an explicit policy for owner acceptance of historical facts; preaccepting facts,
automatic capture and retrieval over raw transcripts are different experiments. Never bypass banda's approval policy
to match a benchmark. Explain any protocol change and do not claim direct leaderboard comparability.

## LongMemEval first

Use [LongMemEval](https://github.com/xiaowu0162/LongMemEval) as the first memory benchmark. Its 500 question instances
cover single-session user and assistant information, preferences, multi-session reasoning, knowledge updates and
temporal reasoning; 30 also test abstention. The cleaned dataset has S, M and oracle-evidence variants. The dataset
card declares MIT; check the benchmark code and other assets separately. Pin the dataset, scorer and model revisions:
cleaned and original data, different judges and changed protocols are not automatically comparable.

The initial question is **historical-chat recall**: can banda find and use evidence in previous conversations? This
is not a test of whether it independently wrote memories or learned from owner feedback. Use existing examples and
scoring; do not build a new scenario framework. LongMemEval is not a test of actual deletion, durable promises,
proactivity, owner approval or usefulness on completed tasks.

### Replay contract and unresolved seams

- Each question and experimental arm gets an isolated throwaway home and workspace: histories are compiled per
  question and must not share chats, core facts, indexes or other state. Preserve session boundaries, original
  speaker roles and text, original session timestamps and ordering. Keep question answers, `has_answer`, answer
  session IDs and other evaluator labels out of all agent-visible inputs.
- banda's public message endpoint does not import historical assistant messages or timestamps. pi-durable exposes
  conversation creation and entry append primitives, but an evaluation-only seeding path is not yet verified. Search
  recognizes owner entries by model role and inbound metadata, and the agent's text through `message_user` tool calls;
  plain assistant text alone is not equivalent. Historical entries must not create work or imply an effect was sent.
  Prove the import and index against actual entries before treating seeded chats as representative.
- The dataset provides session times without explicit offsets. Record a deterministic time-zone interpretation and
  preserve the original strings; do not invent separate turn times. `recall` currently renders the local date rather
  than time of day for chat hits: inspect same-day temporal cases before attributing an error to the model.
- The official generation protocol supplies the question date. Make that date available without leaking the answer,
  record how, and distinguish a date added to the input from banda's own clock awareness. pi-durable supports a host
  clock, but banda's daemon has additional `Date.now()` paths; a whole-daemon simulated clock is not established.
- Historical seeding does not run banda over prior turns or accept its proposals. Do not use gold evidence or answers
  to populate core facts, except in an explicitly labelled oracle condition. An interactive learning track must
  use banda's own responses and an explicit owner-acceptance policy; it is a different experiment, not a directly
  comparable fixed-history score.

### Diagnostics and scoring

Compare normal recall, a precisely defined no-cross-session-access control, and evaluator-supplied oracle evidence.
Inspect actual prompts and tool outputs for leakage. A no-recall run tests access, not learning; an oracle is a
non-deployable diagnostic. If evidence is inaccessible even with a direct search, investigate retrieval; if oracle
also fails, investigate reasoning, time, output capture and grading. Do not change security or authority for an arm.

Keep an evaluator-only mapping from benchmark session/turn to durable chat/entry. Observe ranked search hits and the
actual `recall` output separately, without adding source IDs or labels to the model's view. Reuse LongMemEval's
recall-any, recall-all and ranking metrics where the mapping supports them; report session/turn granularity, cutoff,
filtering and multiple searches. Retrieval metrics exclude the benchmark's abstention cases. Capture the owner's
actual delivered `message_user` text, not the model's final working notes; predefine how multiple messages, no answer,
failed delivery and stopped runs are recorded.

Use the official judge and report per-category scores for comparable runs, but validate that each expected ID appears
exactly once and that all runs and judgments are accounted for: the published scorer can skip unknown IDs and does
not establish completeness. Its rubrics allow some off-by-one temporal answers and updated answers accompanied by old
information. Report stricter banda-specific analysis separately, never as the official score. Record model, judge,
inputs, evidence, tokens, cost, failures and dataset/scorer revisions; do not expose private data to a provider without
consent. Ordinary tests remain network- and key-free.

### First spike

Inspect a few existing user-side, assistant-side, multi-session, temporal and abstention examples, then prove the
replay and search mapping in a temporary home with the existing faux provider before a model-in-the-loop run. Check
roles, message visibility, times, source mapping and isolation; exercise the delivered-answer path. Compare normal,
no-recall and oracle conditions only when the actual model-visible inputs verify that the arms differ as intended.
A small subset validates the adapter, not benchmark accuracy. If faithful seeding is not possible, report a
component-only retrieval diagnostic instead of presenting it as a daemon-level result. No benchmark or spike is
claimed to have been run by this plan.

## Claims and controls

Evaluate these separately, then together:

| Claim | Observable outcome | Essential countercase |
|---|---|---|
| Remembers | Relevant evidence is available and used in a later task | Irrelevant or unsupported fact is not applied |
| Adapts | An accepted correction improves a different later task | One-off exception does not become a global preference |
| Continues | Task state and promises survive time, interruption and restart | It does not assert completion or repeat an uncertain effect |
| Learns a procedure | Prior experience improves a new instance of related work | A changed service invalidates the old procedure |
| Is proactive | Important, actionable events reach the owner in time | Trivial and unchanged events do not cause noise |
| Respects control | Rejection, correction, deletion, stop and permissions have their intended effect | A foreign instruction or unaccepted change gains no authority |

Improvement is a comparison against an appropriately matched control, not simply a later answer being better. Fix the
model, harness, budgets and environment unless that variable is the intended treatment. Report harms and regressions
alongside gains; do not trade trust violations against average task scores.

## Scenario contract

Use a benchmark's existing format and runner when possible. For an adapted or genuinely missing case, keep a plain
versioned fixture; do not introduce a new scenario language without demonstrated need. Document:

1. **Owner and initial state:** fictional owner, accepted preferences and definitions, permissions, connected stand-in
   services and a fresh throwaway home. Ground truth and private owner preferences are evaluator-only.
2. **Timeline:** dated owner messages, owner approvals or rejections, service events, time advances, wake-ups,
   failures and restarts. The agent sees only events delivered through real banda interfaces and tools.
3. **Interventions:** the treatment, control, experience phase and held-out tasks. Define the causal question and
   exactly which inputs differ; do not assume a component can be removed without changing other inputs.
4. **Oracle:** observable target world state, mandatory constraints, deadline and permissible alternatives, evidence
   supporting each answer, applicable uncertainty and undesired effects. No hidden evaluator labels reach the agent.
5. **Evaluation:** deterministic assertions, rubric and severity; expected owner effort, cost and timing; and what
   constitutes a correct silence. Record why a scenario is representative and vary its surface details.
6. **Artifacts:** a sanitized trace and reproducibility manifest; no real credentials or personal data by default.

Stand-in services model reads, writes, failures and time; use the real daemon and its admission paths rather than a
mock agent loop for behavioral claims. The evaluator controls its clock and service events without leaking future
state to the agent. If the production clock cannot be controlled, spike an injection seam rather than claiming wall
clock sleeps are reproducible. A simulated approval must enter through the same owner-authorized boundary as the app.

### Gaps requiring banda-specific checks

Existing examples may not exercise acceptance or rejection of a memory proposal, durable promises, quiet delivery,
restart, deletion or approved drafts. First look for suitable existing examples and tests; add only the smallest case
needed to cover a demonstrated gap. These checks remain subject to banda's deterministic and fault gates.

## Measurements

Keep a scorecard per family and report denominators, failures, uncertainty and resource use. There is no single
intelligence score.

- **Task:** correct final world state and artifact; constraint satisfaction; valid completion or appropriate
  abstention; unnecessary questions and owner corrections; time and cost per successful outcome.
- **Memory:** capture precision and coverage; evidence recall at a fixed context budget; correct application;
  stale or unsupported use; update and temporal-scope accuracy; provenance integrity; correction and deletion.
  Diagnose capture, retrieval and use separately. Model-reported citations do not prove complete attribution.
- **Learning:** held-out task delta against a fresh/matched control, repeated-correction rate, transfer, negative
  transfer and performance after rejection or reversal. Distinguish personal preferences, task state and reusable
  procedures. Weight updates to model parameters are not required to demonstrate improvement. If the baseline has
  not yet been measured, report the result as unestablished, not as improvement.
- **Proactivity:** important-event recall and deadline misses; useful-update precision; low-value interruptions per
  simulated week; stale/duplicate updates; timing; correct now/silence decision; durable
  promise keeping; and adaptation to ratings. Report precision and recall together: always speaking and never
  speaking are both poor baselines. Explicitly score correct silence.
- **Trust and durability:** unauthorized effects, unaccepted prompt/tool authority, forged provenance, failed
  revocation or deletion and duplicate unsafe effects are separate hard failures. Run the existing deterministic
  and fault gates; an LLM judge cannot establish these structural guarantees.
- **Cost:** ingestion, maintenance, retrieval, model and tool calls, tokens, wall time and money, including background
  work. Separate provider latency from banda overhead. Quality and cost must be compared together.

The owner controls behavioral changes as specified in DESIGN.md: inferred changes are proposals, not silently accepted
preferences. What remains in retained source chats after deleting a fact must be explicit. Test whether retained
history can cause rediscovery separately; the intended policy for that case needs an owner decision.

## Ablation and experimental protocol

An ablation removes or changes one component to estimate its contribution under a specified workload. It is often
impossible to remove a component without changing other inputs, costs or behavior; state precisely what the
comparison estimates. All arms, including diagnostic controls, retain the same structural security and approval
policy. Never disable trust boundaries in a real system.

Two experiments answer different questions. A **controlled decision test** forks the same state just before a held-out
query and changes only the evidence made available; it diagnoses use of that evidence. An **end-to-end learning test**
runs each arm independently through its full experience, capture and retrieval, then measures later tasks; it includes
failures and costs of learning. Do not use a post-learning snapshot for both arms and claim it measures learning.
Where stored information cannot be removed without changing other state, disclose the residual information and narrow
the claim.

| Question | Treatment and control | Interpretation and confound to check |
|---|---|---|
| Does cross-session memory help? | Full system vs no cross-session recall, with identical current input | Keep current-task conversation and tools equal; report facts already in prompt; call it an access ablation, not removal of learning |
| Do core facts help? | Core facts available vs withheld from the model, other permitted recall fixed | Core may duplicate searchable history; measure duplicate evidence and token budget |
| Does retrieval help? | Current FTS retrieval vs no retrieval; optionally hybrid prototype | Match allowed corpus, context budget and reader; account for indexing and embedding cost |
| Where is the ceiling? | Normal retrieval vs evaluator-supplied relevant evidence | Oracle is diagnostic, not deployable; an unchanged failure implicates interpretation or action too |
| Does consolidation help? | Raw eligible history vs derived summaries plus access to the same eligible history | Match or report context and compute; audit lost qualifiers, hallucinations and deletion |
| Does feedback improve behavior? | Identical experience and accepted owner correction vs matched control without that correction | Match owner interactions where possible; measure improvement and overgeneralization |
| Do procedures transfer? | Experience plus accepted procedure vs experience without the procedure and fresh agent | Held-out task differs from training; test a changed service and measure extra tool use |
| Does proactive judgment add value? | Model gate vs deterministic threshold, always notify and always silent | Match events, owner settings and budget; score missed events, not just message quality; always-notify cannot override delivery policy |
| Do ratings help? | Ratings made available to subsequent runs vs withheld, same initial policy | Include negative and conflicting feedback; current docs say ratings reach runs, not a tuned gate |

These are **eval-only** interventions; do not ship controls that weaken safety. A no-memory arm must specify whether
core facts, topic files, chat history, summaries, skills and task state are withheld. It must not erase durable
routines or task state in a way that silently changes the task. Prevent leakage through existing prompt prefixes, search,
workspace files, chat compaction, tools and owner-visible artifacts. Verify the actual model inputs and
retrieval traces for each arm. When an arm cannot be isolated under the real harness, label it a system comparison,
not a component ablation.

For learning, split each scenario into an **experience phase** and independently varied **held-out tasks**. Fork
comparable world snapshots before the intervention; give arms equivalent external events, model version and limits.
For controlled decision tests, fork immediately before the decision instead. Report actual spend even when limits
match; equal limits do not imply equal cost.
Randomize arm assignment and ordering. When comparing an experienced agent to a fresh one, distinguish the effect of
personal experience from the effect of having more total task exposure; use a matched irrelevant-experience control
where possible. Predefine the primary outcome, scenario unit, exclusions and analysis before inspecting results.
Report paired differences, per-family results, confidence intervals clustered by owner or scenario family, and repeated
model runs. Identical seeds do not guarantee identical provider behavior; save actual settings and traces. Prespecify
how failed runs and provider errors are counted; do not drop inconvenient failures. Keep held-out families private
and refresh them to limit benchmark overfitting. Select a minimum meaningful effect and estimate required sample
size using a pilot; a few families can find defects but cannot support a precise population-level improvement claim.
If samples are too small, show paired outcomes and uncertainty rather than declaring a winner.

## Evaluation infrastructure and grading

1. **Deterministic tests:** extend the existing network-free faux-provider tests and `test/fault/` for state,
   provenance, deletion, approvals, restart and effect boundaries. These verify mechanisms, not model intelligence.
2. **Model-in-the-loop runner:** an explicitly invoked, opt-in runner uses throwaway homes, the real daemon, fictional
   worlds and stand-in services, with a pinned local or external provider. Ordinary `npm test` remains network- and
   key-free. Refuse a live home by construction. Do not contact real services or execute real-world effects.
3. **Public benchmark adapters:** use existing data, runners and scoring where practical; pin their versions, prompts
   and models and check licenses. Compare matched budgets and report actual costs, category results and oracle
   separately. Label component-only runs and protocol differences; add native scenarios only for identified gaps.
4. **Human study:** after the foundations work, use voluntary, informed participation and data minimization to assess
   realistic usefulness, interruption burden, corrections and trust. The required app-based slice review and release
   trial remain separate gates, not proof of longitudinal improvement.

Prefer deterministic checks of service state, drafts, timings and policy. Prelabel proactive events for relevance,
deadline and expected channel under each owner setting; have human reviewers independently inspect ambiguous cases
before comparing systems. These labels represent a scenario designer's judgment, not universal owner preferences.
Use a blinded, rubric-based model judge only for open-ended qualities; calibrate against independently human-labeled
cases, inspect disagreements and track judge version and error. An uncalibrated judge is exploratory, not a release
gate. Never use the agent's self-report as the sole evidence of completion or an authority decision.
Record scenario and dataset revision, arm, seed and clock, model/provider settings, code revision, prompt/tool inputs,
evidence, events, approval decisions, outputs, final world state, cost, failures and grader version. Keep traces
synthetic by default, access-controlled and subject to explicit retention/deletion; disclose when an external model
provider sees eval data.

## Proposed sequence

1. Spike LongMemEval historical replay and evidence mapping as specified above. Preserve the existing examples and
   inspect actual model-visible inputs; do not install a general evaluation framework or invent a new corpus.
2. Once the adapter is verified, run a small opt-in model-in-the-loop comparison of normal recall, no cross-session
   access and oracle evidence. Label protocol deviations and measure cost; this is not yet a benchmark score.
3. Expand to the intended cleaned benchmark split with the official scorer and complete manifests. Analyze recall,
   updates, temporal reasoning and abstention separately before proposing memory changes or numerical targets.
4. Only after this foundation, consider other published suites for over-personalization, interactive learning and
   proactivity, and add banda-specific checks for demonstrated gaps. Existing acceptance gates remain unchanged.

## Product journey checks

The reusable [journey catalogue and runner](../evals/README.md) exercise banda-specific app workflows: first use,
the band, groups, artifacts, approvals, routines, memory, agents, browser use and recovery.
These are product acceptance checks, separate from the published behavioral benchmarks above. Prompt delivery is
not a pass: each step needs recorded desktop and phone observations. Fresh runs use throwaway homes; existing test
instances require explicit targeting. The runner never approves an effect on the owner's behalf.
