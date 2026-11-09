# Connection definitions plan

A connection stops being a file in the owner's workspace ([Connection definitions](connection-definitions.md)). What
banda ships is read from the release, typed and schema-checked, and what the owner chose lives in the store. The
program enforces one rule. A definition is never copied, and nothing the box writes can reach one. One PR,
`connection-definitions`, stacked on the Slack branch and landed by the operator after it. Its commits come in four
stages, shipped definitions from the release, then the owner's choices and their own servers in the store, then a
connection's details to check and change, then the deletion of what is left of the file. It takes from PR #28's
branch what the stages need and does not wait for that PR.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box
above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The
body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-stack.md` with one PR. One owner at a time builds and verifies it, stage by
stage, and the operator lands it after the Slack PR. The PR is neither pushed nor opened until the operator says so
(AGENTS.md "Changes"). The swarm lanes the playbook names run here as browser tests and walkthroughs against a
throwaway daemon, since this repository has no cloud lane machinery.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Given on 2026-11-09, "take whatever you need from PR 28 to build it".
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:AGENTS.md`, `git show origin/main:DESIGN.md` ("Connections", "Watches", "Trust", "The workspace"), `docs/connection-definitions.md`, `docs/connections.md`.
- [ ] The base is the Slack branch `worktree-purring-orbiting-ritchie` at the SHA the status message records. When the Slack PR lands, rebase onto `origin/main` and record the new base.
- [ ] PR #28's branch `origin/feat/agent-trust` is fetched and read-only. Pieces are taken from it by reading and rewriting, never by merging it.

### Spawn owners

- [ ] One owner for the PR per stage, a fresh subagent each time with the consolidated brief. This plan, the design, the base SHA, the branch and the prior stage's report. A stage starts when the one before has every unit box checked.
- [ ] The owner works in the worktree on branch `connection-definitions`, makes small conventional commits whose messages carry the why, decisions and caveats, and never touches `~/.banda`.
- [ ] The owner posts a status message at every tick. The head SHA, boxes checked since the last tick, what blocks. The root polls on `/loop 1h` and relays the status message to the operator only when something changed.

### PR mechanics

- [ ] `npm run check`, `npm run typecheck` and `npm test` green before every commit. `npm run test:fast -- <file>` during edits, at most two workers, unique temp homes, OS-assigned ports.
- [ ] A new durable effect gets a fault worker under `test/fault/` and runs in the `faults` project. Fault suites run in CI by dispatching the `ci` workflow on the branch, never locally.
- [ ] Stored shapes change in place with no migration, and `test/stored-shapes.test.ts` covers them as they are.
- [ ] Every new component or variant joins the specimen (`#/specimen`), light and dark, 390 and 1440.
- [ ] Before review, `/no-comments` and `/deslop` over the diff. The PR body opens with `## Why` restating the goal.

### Verdict and merge

- [ ] The root re-runs the **Verify, unit** block, the **Verify, live** lanes and the **Verify, perf** block at the exact head SHA, and two audit lanes read the diff and the receipts distrusting the PR body. One audit lane is an adversarial review for trust and durability (AGENTS.md principle 11), since the stages change what an agent may do. Its findings are triaged fix now, implementation note or dismiss, in the PR.
- [ ] A finding blocks when it breaks a Trust law, lets a box's write reach a definition, loses an owner's choice, or changes which tools run unasked without the definition or the owner saying so. A failure recorded against trunk in the lane marked "Regression lane against trunk." does not block the PR.
- [ ] At merge-ready the PR goes to the operator with its receipts. The operator lands the Slack PR first, then this one. A new head gets a fresh verdict unless its patch-id is unchanged (`playbooks/shipping.md`).

### Boot recipe, for every live lane

Each live lane runs in a throwaway home against fake services, or against a fork of the operator's home when the
lane says so, driven by the browser test harness (`test/*.browser.test.ts`) or by hand.

- [ ] `git fetch origin connection-definitions && git checkout <head SHA>`, `npm ci`, `npm run build`.
- [ ] `BANDA_HOME=$(mktemp -d) node dist/cli/index.js serve --port 0`, then open the link it prints. For a fork, `npm run home:fork` and serve it as it prints.
- [ ] Deliver input only through the app or the CLI. The read-only diagnostics are the daemon's log and `status`.
- [ ] Save every screenshot to `/tmp/swarm-connection-definitions/worker-<n>/<slug>.png` and return the paths with the report.
- [ ] Stop the daemon and run `npm run boxes:sweep` when the lane ends.

## Make a connection a shipped definition and a stored choice (connection-definitions)

**Depends on.** The Slack branch as the base, and read access to `origin/feat/agent-trust`.

**Files.**

- [x] Create `src/core/definitions.ts`. The TypeBox schema of a definition, `readDefinition` (parse, `Value.Check`, then the checks a schema cannot say), the definitions map built at start, and a definition's version.
- [x] Create `shipped/connections/{github,gmail,calendar,contacts,drive,slack}.json` and delete the six `.md` files. Each carries `about` and its access choices' labels and notes.
- [x] Edit `scripts/shipped-github.ts` to emit one JSON object.
- [x] Edit `src/core/connections.ts`. `acceptedConnection` and its callers read the definitions map and the store's records. The frontmatter parser for connections, `withList`, `withReads`, the parse cache, `connectionPath` and the tool file code go. `withList` stays for agent files (agents.ts).
- [x] Edit `src/server/capabilities.ts`. "On in this home" and Add as a switch. A server added by address as a record with a version, through one path. Accepted reads and groups in the store. `addShipped`'s copy, `updateShipped`, `shippedUpdate`, `needsNoSignIn`'s rewrite, the eight `boxedFiles("connections")` comparisons, and the box's change to a connection go.
- [x] Edit `src/core/watches.ts`, `src/core/object-access.ts`, `src/server/objects.ts`, `src/server/watches.ts` to read the definitions map and bind to the version.
- [x] Create `src/core/tool-kinds.ts` and the `ToolSettings` doc, taken from PR #28 and rewritten here. A tool's kind (read, write, floor), the settings each kind allows, and the check when a call starts.
- [x] Edit `src/server/api.ts` and `src/server/http.ts`. The connection view carries the definition's version in place of a file's hash, `about`, the access choices with their words, each tool's kind, source and setting, and the kinds with what following each does. The routes that accept or decline a box's connection file and the tool routes go.
- [ ] Create `web/src/chat/ConnectionDetails.tsx` with the tool list taken from PR #28's `web/src/chat/ToolKinds.tsx`. Edit `web/src/app/McpSetup.tsx`, `web/src/app/ConnectFlow.tsx`, `web/src/chat/Catalogue.tsx`, `web/src/chat/Settings.tsx` and `web/src/app/Access.tsx` to use it and to send the version. Delete `SERVICES` from `web/src/app/Shell.tsx`, `SCOPE_CHOICES` from `web/src/lib/connect.ts`, `UpdateOffer`, and the approval card for a box's connection change.
- [x] Edit `src/server/agents.ts` and `src/box/tools.ts` so `connections/` and `tools/` are neither made nor named to the model.
- [ ] Edit `web/src/specimen/agent/toolsets.tsx` to import the JSON definition. Add the details view and its states to the specimen.
- [ ] Create `test/definitions.test.ts`, `test/tool-settings.test.ts`, `test/connection-details.browser.test.ts`. Edit `test/connections.test.ts`, `test/connections.faults.test.ts`, `test/fault/connection-worker.ts`, `test/stored-shapes.test.ts`, `test/watch-accept.test.ts` and every test that reads `shipped/connections/*.md` or seeds `Accepted.files["connections/…"]`.
- [ ] Edit `DESIGN.md`, `AGENTS.md`, `docs/connections.md`, `docs/status.md`, `docs/connection-definitions.md` as each stage lands, and delete this plan when the program closes.

**Build.**

- [x] Stage 1, shipped definitions from the release. First two scenario tests that pin today's behaviour, written before any change. What a watch does at its first look after its object's definition changed, and that a tool a server adds later waits switched off.
  - [x] The schema in `src/core/definitions.ts`, with the cross-field checks of `parseConnectionText`, `parseObjects` and `parseFollow` kept as code after `Value.Check`.
  - [x] The six shipped files as `.json`, each body compared with its tools' descriptions before it goes, with `about` and the access choices' words moved in from the app.
  - [x] The definitions map read once at start, and a definition's version, the hash of what was read. Every site that compares the accepted file's hash binds to it.
  - [x] "On in this home" in the store, Add as a switch in Connections, Settings and the agent's card. The copy and Update gone.
  - [x] The rule at a change of version. A tool the definition names comes on, a tool a server lists alone waits off whatever the version, switches kept by name.
- [x] Stage 2, the owner's choices and their own servers in the store. A record per server added by address with a version counter, one path that adds one, discovery and sign-in as transactions.
  - [x] The reads the owner accepted, for every connection, in the store, as an overlay on the definition. Nothing rewrites text. Groups are a definition's data (`groups` in the schema), so they are not in the overlay.
  - [x] The app's concurrency token is the version.
- [x] Stage 3, a connection's details, to check and to change. `ToolSettings` and `tool-kinds.ts` taken from PR #28, with the check in the commit that starts a call. A connection only narrows.
  - [x] `ConnectionDetails` with the tool list in groups, each tool's kind, source and setting, changed in place. Each account with its access, changed by signing in again. The agents that use it. The kinds it draws and what following each does.
  - [x] The review on adding a connection and the details afterwards are the same component, reached from Settings → Connections and from an agent's Access.
- [x] Stage 4, what is left of the file. The box's folders and their naming to the model, a box's change to a connection and its card, and agent-built connections and tools deleted. DESIGN.md, AGENTS.md and the status doc rewritten where they name connection files.

**You see.**

- [ ] Stage 1. A fresh home's Connections lists the six shipped connections with their line from the definition, and turning one on starts sign-in with no file written to the workspace. A daemon restarted on a build with a changed definition draws the changed card with no step from the owner.
- [ ] Stage 1. A followed object keeps its watch across that restart and wakes on nothing. An account beyond a narrowed definition is asked to sign in again.
- [ ] Stage 2. A server added by its address shows its tools, the owner marks which read, and nothing in the workspace changes. Allowing a read on a shipped connection survives a restart on a newer build.
- [ ] Stage 3. Settings → Connections → a connection opens its details. Tools in groups with their kind and setting, accounts with their access, the agents that use it, and what it draws with what following each wakes for. Setting a read to Ask makes its next call ask.
- [ ] Stage 3. The review shown when adding a server is the same list, and what was accepted there is what the details show.
- [ ] Stage 4. A box that writes `connections/x.md` changes nothing and no card appears. The agent's tools no longer mention those folders.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/definitions.test.ts`. Every shipped definition passes the schema and the checks, a round trip over generated definitions, each refusal the old parsers made still refused, and the version stable for the same bytes. Run `npm run test:fast -- test/definitions.test.ts`.
- [x] `test/connections.test.ts`. Add as a switch, no file in the workspace, a changed definition taken at start with accounts and switches kept, a narrowed one making an account stale, a tool named by the definition on and one a server added alone off across versions, a server added by address as a record, two edits crossing refused by version. Run `npm run test:fast -- test/connections.test.ts`.
- [x] `test/tool-settings.test.ts`. The settings each kind allows, Ask on a read and Always ask on a write putting it on the floor, the check at the call's start, an allowed read kept across a definition change, and nothing set on a connection letting a write run unasked. Run `npm run test:fast -- test/tool-settings.test.ts`.
- [x] `test/watch-slack.test.ts`, `test/watches.test.ts`, `test/objects.test.ts`. A watch and a card across a version change, with no false wake. Run `npm run test:fast -- test/watch-slack.test.ts test/watches.test.ts test/objects.test.ts`.
- [x] `test/stored-shapes.test.ts`. The new records and docs as they are. Run `npm run test:fast -- test/stored-shapes.test.ts`.
- [ ] `test/connections.faults.test.ts`. Kills at turning a connection on, adding a server, accepting its tools, changing a setting, and removing it. Dispatch the `ci` workflow with faults on the branch and record the run id.
- [x] The property "nothing the box writes reaches a definition" in `test/connections.test.ts`, in place of "nothing the box wrote is offered or runs before the owner accepted it".
- [ ] `npm run check && npm run typecheck && npm test` green at the head.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Connect Gmail and GitHub by their fakes and read a card at trunk (the Slack branch) and head. Save `regression-connect-read.png`. Pass when both sign in and draw the same cards at trunk and head.
- [ ] Lane 2. A fresh home at 1440 and 390 turns each of the six shipped connections on. Save `six-on.png`. Pass when each starts its sign-in, the workspace holds no `connections/` folder, and each tile shows its line from the definition.
- [ ] Lane 3. Restart the daemon on a build whose Gmail definition renames a card field and adds a read. Save `changed-definition.png`. Pass when the card draws the new field, the added read is on, accounts and switches are kept, and nothing was asked.
- [ ] Lane 4. A followed GitHub pull request and a followed Slack channel across that restart. Save `watch-across-version.png`. Pass when both watches are live, neither woke, and each row's last look is after the restart.
- [ ] Lane 5. A fake server adds a tool the definition does not name, before and after a version change. Save `tool-waits-off.png`. Pass when the tool is listed switched off both times.
- [ ] Lane 6. Add a server by its address, review its tools, mark two as reads, then cross two edits from two tabs. Save `own-server-record.png`. Pass when the reads hold, the second edit is refused by version in words, and the workspace is unchanged.
- [ ] Lane 7. Open a shipped connection's details at 1440 and 390, set a read to Ask and a write to Off. Save `details-settings.png`. Pass when the read's next call asks, the write is gone from the agent's tools, and both survive a restart.
- [ ] Lane 8. In the details, change an account's access by signing in again and switch an agent off. Save `details-access-agents.png`. Pass when the account shows the new access, the agent's next call is refused in words, and the kinds list says what following each wakes for.
- [ ] Lane 9. A box writes `connections/evil.md` and edits nothing else. Save `box-writes-nothing.png`. Pass when no connection appears, no card asks the owner, and the agent's tools are unchanged.
- [ ] Lane 10. A fork of the operator's home with its ten connections, at 1440 and 390. Save `forked-home.png`. Pass when every connection opens its details, each shipped one follows the build's definition, and each of the operator's own servers kept its reads.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Definition parses per watch look and per `/api/objects` request, and the daemon's start time with six shipped definitions, at trunk and head.
- [ ] Probe. One followed pull request looked at ten times and fifty object requests against the fakes, counting calls to the parser, interleaved at trunk and head. Start time over five starts each.
- [ ] Baseline. Record trunk first. PR #24 measured 0.86 ms per parse of GitHub's file, a dozen times per look before its cache.
- [ ] Rule. Head parses a definition zero times after start. Any parse per look or per request fails. A start slower than trunk's by more than 50 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 6, 7 and 8 screenshots into `docs/screenshots/connection-definitions-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of turning a connection on, opening its details and changing a setting. Save it as `docs/screenshots/connection-definitions-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, the adversarial review triaged.
- [ ] DESIGN.md and AGENTS.md say a connection is a definition banda ships and a choice the store holds, with every unit box checked.
- [ ] Rebased onto the current base after the verdict, patch-id unchanged. After the Slack PR lands, rebased onto `origin/main`.
- [ ] Handed to the operator at merge-ready. The operator lands it after the Slack PR.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `docs/connection-definitions.md` says what shipped and what remains. `docs/status.md` records the owner's acceptance. This plan is deleted, its evidence living in the commits and tests.
- [ ] Reply to the operator with the PR, its head, and the receipts.

## Appendix A. Prototype evidence

The open questions were closed by reading the code, recorded in `docs/connection-definitions.md` and its commits.

- How a server's listing is bound. To the accepted file's hash at about a dozen sites, relisted at start when it differs, switches kept by tool name. The design binds to one version per definition.
- Who reads a connection file in the workspace. Nobody outside the capabilities module. Readers use the `Accepted` doc's keys.
- What the app shows. No screen shows the file, its path or its hash.
- What PR #28 already has. `ToolSettings`, `tool-kinds.ts`, the tool list and review in `ToolKinds.tsx`, `followShipped`. Read on `origin/feat/agent-trust`.
- Unproven until stage 1's first two tests. What a watch does at its first look after its object's definition changed, and "a tool the server adds later waits switched off", which no test pins today.

## Appendix B. Alternatives rejected

- Wait for PR #28 and stack on it. The operator said it is to be reworked and to take what is needed.
- Merge PR #28's branch and delete what is not wanted. It carries per-agent trust, grains, earned permissions and guessed tool kinds, which are its own subject and 6,700 lines.
- Keep the workspace copy and follow at start, as PR #28 does. The copy, its marker and a write at every start exist only to sync two stores (AGENTS.md principle 1).
- Keep `.md` with frontmatter and add a schema. Principle 2 says a file that holds data is `.json`, and the prose body reaches nobody.
- Write the owner's accepted reads into the definition. A shipped definition would become the owner's and stop following.
- Build the details view first. It would write to files that stage 2 then replaces.
- Four PRs. The operator's standing preference is one PR, stacked, with the stages as ordered commits.

## Appendix C. Risks

- A definition's version changes at every release that touches it, so readings and listings taken under the old one are stale at start. The owner watches lanes 3 and 4.
- About seventeen test files and four fault workers read the shipped `.md` files or seed `Accepted` with connection paths. Stage 1 rewrites their fixtures, and a missed one fails loudly.
- The reaction permission on the Slack branch binds a channel by its own small mechanism. It stays until grains land with the rework of PR #28.
- A body's instruction that no tool description repeats would be lost with the body. Stage 1 compares each before deleting.
- The property test for box-written files is restated, not removed. The adversarial lane reads the restatement.
- One PR carries four stages on top of the Slack branch's thirty-nine commits. The ordered commits and per-stage unit boxes keep each stage checkable.

## Appendix D. Links and reading list

- `AGENTS.md`, `DESIGN.md` "Connections", "Watches", "Trust", "The workspace", `docs/connection-definitions.md`, `docs/connections.md`, `docs/slack.md`, `docs/delivery.md`.
- Code to read before editing. `src/core/connections.ts`, `src/core/objects.ts`, `src/core/follow.ts`, `src/core/rest.ts`, `src/core/band.ts` (the typed-file pattern), `src/server/capabilities.ts`, `src/core/watches.ts`, `src/core/object-access.ts`, `src/server/objects.ts`, `web/src/app/McpSetup.tsx`, `web/src/chat/McpConnection.tsx`, `web/src/chat/Connect.tsx`, `web/src/chat/Catalogue.tsx`, `web/src/lib/connect.ts`.
- On `origin/feat/agent-trust`, read-only. `src/core/tool-kinds.ts`, the `ToolSettings` doc in `src/core/connections.ts`, the call-start check in `src/server/capabilities.ts`, `web/src/chat/ToolKinds.tsx`, `test/tool-settings.test.ts`, `web/src/specimen/agent/tool-kinds.tsx`.
- Stages 1 and 2 get the `how` skill over the listing binding and the accept path before editing, and `interrogate` on the version rule before stage 1 ships. The decision trail lives in the commit messages.
