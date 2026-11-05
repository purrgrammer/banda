# Delivery procedure

Implement the section order in [the index](README.md) as small end-to-end slices. Spike unknowns before designing
on them. The owner reviews each slice before the next starts, as AGENTS.md requires. This consolidation documents
work to perform; it does not mark a release gate passed or authorize publication.

## Worktrees and integration

For implementation, use local topic worktrees from the current branch and merge verified work back as requested.
Recheck the base and preserve other checkouts' changes. Keep commits small and conventional, run required checks
before committing, and record the why, evidence, decisions and caveats in commit messages. No pushes or PRs.
Never run against the live home. Documentation for this plan is maintained directly in the main tree under docs/.

## Slice procedure

1. Read DESIGN.md, docs/README.md, docs/status.md and the relevant section plan. Reproduce the underlying failure and identify the invariant it violates.
2. Inspect pi-durable, pi-env, git and Docker for an existing mechanism. Spike unresolved semantics, including
   cancellation, hostile concurrent writers and the relevant platform. Keep decisions and caveats in commit messages.
3. Add a regression reproducing the cause before changing it. Implement the smallest common mechanism and its app
   surface; reuse established UI components and add new variants to the specimen.
4. Add generated scenarios and a kill-at-every-boundary sweep for each new durable effect, using shared invariants
   under `test/fault/`. Include thrown faults, aborts and independent component loss where applicable.
5. Run the required checks in verification.md. Avoid competing heavy fault suites; a skipped Docker test or unfinished
   command is not a pass. Capture commands, exit codes, seeds and relevant traces without secrets.
6. Conduct an adversarial review of trust/durability changes after implementation. Triage every finding as fix now,
   implementation note or dismiss, with severity and reasoning. Re-run affected checks after a fix.
7. Use the app against a throwaway daemon at desktop and phone width, including the failure path. Present the concrete
   slice and evidence to the owner; record acceptance in docs/status.md before starting the next slice.
8. Update only proven rules in DESIGN.md, remove resolved section items, update docs/status.md, and commit once all
   mandatory checks pass. Keep evidence in test assertions and commit messages, not a second status ledger.

## Dependency gates

Scope and reproducible checks precede trust changes. Isolation informs egress admission; egress ownership and
conditional workspace mutation precede complete recovery. Connection authentication and browser qualification
both precede product acceptance. Resource controls and installation must be qualified before release. A shared
substrate fix may serve several sections but must still ship an observable app result and tests.

Before each slice, check recent fixes and retire findings that no longer reproduce. Preserve the browser and
current features; newly discovered blockers are work to resolve, not implicit authorization to remove scope.
No calendar estimate should assume an unresolved platform, protocol or filesystem mechanism works.
