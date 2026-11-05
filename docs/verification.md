# Verification and release acceptance

Use these gates for each production slice and the final candidate. status.md records whether they passed; test code
and commit messages hold reproducible evidence. An empty evidence slot, skipped required environment, unfinished
check or owner review still pending means the gate is open.

## Required checks

For the edit loop, use `npm run test:fast -- <test-file>` or `npm run test:fast` for all ordinary suites. This lane
needs no Docker or process-kill sweeps. Test runs cap ordinary workers at two and fault files at one, with two child
jobs per sweep. Separate agents may run targeted checks concurrently; coordinate full, deep and Docker checks so
only one agent runs those expensive gates at a time. The fast lane does not replace the acceptance checks below.

Use the version in `mise.toml` and a clean lockfile install. Run these from the slice worktree, in order, without
other heavy test runs competing for the machine:

```sh
npm ci
npm run check
npm run typecheck
npm test
BANDA_PBT_RUNS=20 npm test
npm run build
npm run web:contrast
```

All must pass before a slice commit, along with its targeted regression and fault tests. Docker tests may skip on
an unsupported development machine, but cannot be skipped in slice acceptance for Docker changes or the release
qualification environment. Raise `BANDA_PBT_FAULT_RUNS` when a reproduced rare path requires greater depth; retain
the seed. Do not reduce existing property counts or timeouts merely to obtain a pass.

Record the revision, runtime/dependency versions, OS/architecture, Docker availability, commands, exit codes,
property seeds, fault boundaries, tested widths and owner review in the commit message. A passing run on another
revision is supporting evidence, not qualification of the candidate.

## Isolation and admission

| Gate | Scenario and required result |
|---|---|
| T1 | A chat writes files and starts processes; another chat or routine cannot use them to obtain network access it was not given. |
| T2 | Box code inspects process environments, shared tools and proxy logins; it cannot impersonate a less restricted principal or reach the host, auth or store. |
| T3 | A malicious response uses GET queries, redirects, new hosts and accepted connections to request a send; only explicitly granted disclosure authority or an admitted draft permits it. |
| T4 | Decline, expire, edit, revoke or switch off a tool during an approval and after restart; only the approved bytes run and no revoked authority starts another attempt. |
| T5 | A supported floor approval requires device authentication bound to the exact draft and is single-use; wrong challenge, expired challenge, cancellation and device recovery cannot bypass it. |
| T6 | An unaccepted agent, tool, connection description/schema or core-memory change cannot acquire prompt/tool authority; changed definitions keep the accepted version in effect. |
| T7 | A capability outside the declared support contract is attempted through direct API calls, model calls, persisted tasks and credential paths; admission refuses it consistently. |

Adversarial review must include a concrete attack trace, consequence and severity for each finding. Triage as
fix now, implementation note or dismiss; document the reason. A label or model opinion does not replace an
enforced boundary. High/critical means unauthorized authority/disclosure or plausible loss/corruption of owner
work; those findings block release until fixed. Removing a current feature requires a new explicit owner scope decision.

## Durability and concurrency

| Gate | Scenario and required result |
|---|---|
| D1 | Throw and SIGKILL before/after every new commit or external effect; shared invariants hold and no open work is silently stranded. |
| D2 | Kill daemon, proxy and box independently before intake, after receipt and before acknowledgement; reported tickets remain discoverable. |
| D3 | Cut an unsafe send after the receiver accepts bytes but before local completion; show an uncertain result and require an owner retry/skip decision. |
| D4 | Concurrently mutate artifact destinations, symlinks and parents at every replacement boundary; neither owner's nor box's unknown bytes are silently lost. |
| D5 | Cancel or kill write-back after every filesystem step; rerun or cleanup preserves unknown bytes, releases references correctly and does not leave abandoned work indefinitely. |
| D6 | Reboot/power-loss testing or a justified filesystem durability harness verifies file and directory ordering on the supported platform; SIGKILL alone does not qualify this gate. |
| D7 | Sleep past due times, restart and reconnect twice; routine wakes deduplicate, runs a day persist, and pause does not restart background work. |

## Restoration

| Gate | Scenario and required result |
|---|---|
| R1 | Back up during active work, restore into an empty home with fresh containers, rebuild derived indexes, and compare definitions, memory, blobs, artifacts and permissions. |
| R2 | Restore pending asks, tickets, routines and write-backs; completed effects are not silently replayed, and outcomes after the backup boundary are treated as uncertain. |
| R3 | Reject corrupt, missing, tampered or incompatible backup data before activation; the existing home remains intact. Verify wrong/lost backup-key behavior. |
| R4 | Export/restore protects auth material; credential revocation and token rotation remain effective. The app clearly identifies any required reauthentication or lost session. |

## Browser

| Gate | Scenario and required result |
|---|---|
| B1 | Verify the supported isolation boundary, cross-chat profile reuse and renderer assumptions; enabled isolation settings match the tested contract. |
| B2 | Test sensitive fields, owner-typed values, unfamiliar key formats, frames, canvas, encoding and screenshots against the declared secrecy contract. Heuristic matches cannot establish a universal guarantee. |
| B3 | Take over during navigation, typing and a held send; stale agent input cannot run while the owner holds control or release an unapproved request. |
| B4 | Test session writes, redirects, links, subresources, cookie expiry and unsupported uploads/upgrades; owner-only sends stay owner-only and activity reflects the result. |

The browser remains in scope. B1-B4 are mandatory release gates; a failed spike requires a fix, not automatic exclusion.

## Product acceptance

Run the built app against a unique throwaway home and port, never `~/.banda`. Use the app at 1440 by 900 and
390 by 844 CSS pixels, keyboard-only and touch-sized controls. Use a disposable account for any manual real-service
test; automated tests use faux providers and stand-in services without keys or network dependencies.

For each of the six workflows in scope.md, capture the inputs, observable outcome, one failure/recovery path and
owner acceptance. Verify reload/reconnect, light/dark contrast, focus order, readable drafts, accessible names,
reduced motion where applicable and no developer-only content outside the raw/details view. The specimen supports
component review but cannot satisfy product acceptance.

Provider setup, first answer, steering/stop, artifact conflict, approved/declined/uncertain send and next routine wake
must work without CLI intervention. Status must distinguish waiting, running, failed, interrupted and completed.
Test owner edits and revocation while another device-width view is open, even though remote pairing is deferred.

## Resource and latency acceptance

The following are proposed initial budgets to validate during scope qualification on a named reference machine. Fix the workload and
thresholds before optimization; any revision requires evidence and owner review. Measure daemon overhead separately
from provider/network latency and assess answer usefulness alongside speed.

| Gate | Workload and proposed budget |
|---|---|
| L1 | Seed 100 chats, 50,000 entries, 5,000 facts, 100 routines and 1,000 artifact versions; verify correct paging/search and measure startup, catch-up and backup. |
| L2 | With that history and two app tabs, p95 local API response under 500 ms and first useful shell state under 2 s; stop acknowledgement under 1 s while work runs. |
| L3 | Observe routine bursts, compaction, FTS scrub and backup; p95 event-loop delay under 100 ms and no control starvation. Record peak daemon/proxy/box memory against explicit configured limits. |
| L4 | Exceed body, response, queue, token/cost, memory and disk limits deliberately; bounded refusal/pause with a useful app state, no missing durable work and no silent background retry storm. |

Measure useful first-answer latency distributions and per-workflow cost for each supported provider/model path.
Set concrete launch budgets after the spike; release remains blocked while supported paths or their budgets are unspecified.

## Installation and release

On a clean supported machine, verify installation without developer tooling or manual Docker setup, signing,
runtime isolation, provider setup, autostart, sleep/wake, offline startup and full uninstall/data-retention behavior.
Interrupt download, verification, installation and activation of an update; recover deliberately without opening a
store using an incompatible binary. Restore the pre-update recovery set when store compatibility requires it.

Complete a proposed seven consecutive days of owner use after the last release-blocking fix, exercising all six
workflows, at least one reboot, one provider outage, one backup restoration and one interrupted update. A shorter
trial requires an explicit scope decision, not elapsed time treated as success.

The owner reviews the exact candidate and evidence. No high/critical trust or data-loss findings may remain. All
current-surface gates must pass; any genuinely unsupported capabilities must pass exclusion tests; existing features stay in scope. Publish only after a separate
explicit release instruction.

## Qualification workflow

- Execute verification.md on the exact candidate revision and packaged artifact, including full/deep tests with Docker,
  adversarial review, restored-home testing and the sustained owner trial.
- Triage defects by consequence. Every high/critical trust or data-loss finding blocks release; lower findings may
  remain only if the release contract still holds and the owner accepts their stated consequence.
- Complete the support matrix and user recovery instructions; name a local release owner and support contact before
  distribution. Record candidate hash, artifact hashes and evidence in the release commit message.
- Present the candidate and evidence for owner release approval. Publishing remains a separate explicit action.
