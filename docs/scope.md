# Product scope and reproducible development

The release keeps the browser and current feature scope, including groups, memory, artifacts, routines,
connections and current provider choices. Qualify their existing supported behavior rather than
hiding features to obtain a passing release. Keep the one-daemon architecture and product vocabulary.

## Work

- Inventory every exposed UI action, API route, model tool and resumable task. Name the supported operations,
  protocol subsets, provider models, authentication modes and platform/runtime combinations.
- Recheck recent provider setup work before treating app-based provider selection as missing. Validate setup,
  disconnect, restart and missing credentials through the actual app and API.
- Select a first packaged platform through a clean-machine spike. macOS arm64 is a candidate, not an accepted
  restriction on the existing product. Define model latency and per-workflow cost budgets from measurements.
- Repair lint traversal of nested worktrees and make toolchain, install, build and test commands reproducible.
  Pin exact dependencies and keep pi-durable, pi-ai, pi-env and chord in lockstep.
- Preserve current capabilities while resolving their blockers. An unsupported operation must explain its limits;
  silently broadening authority or lowering a privacy claim is not a substitute for a fix.

## Launch workflows

1. Install, configure a provider in the app, choose a name and face, and obtain a useful first answer.
2. Delegate research, inspect sources and progress, steer, stop, and deliberately recover interrupted work.
3. Receive an artifact, edit while work continues, inspect versions, restore one, and retain concurrent changes.
4. Review an exact send, edit/approve/decline, revoke permission, and resolve an uncertain external outcome.
5. Create a routine, leave the app, return to its event and reply in the chat, inspect its next run, and pause background work.
6. Use the browser live, take over for sign-in, hand it back, approve supported sends, and sign out.

Also accept existing memory, group and provider flows. Responsive phone-width review remains
required; remote pairing and off-network access remain separate work in [Operations](operations.md).

## Acceptance

The support matrix accounts for every current surface. Checks run from an isolated checkout without discovering
nested worktree configurations. Browser qualification is mandatory. Provider/model quality, cost and latency have
concrete reviewed budgets before release. Features DESIGN.md no longer names are deleted by the chat slices, not hidden.

Entry points: ../biome.json, ../mise.toml, ../package.json, ../src/server/routes/providers.ts,
../src/core/provider-credentials.ts and ../web/src/components/TierPick.tsx.

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Choosing the model provider (a local one) from the app: the chat names it, the config file sets it
- [ ] Inventory the current feature/provider/platform support contract and make checks independent of nested worktrees (scope.md)
