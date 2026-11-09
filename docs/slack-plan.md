# Slack connection plan

An agent works in the owner's Slack as it does in Gmail. It reads what the owner sees, follows threads and channels,
and posts only as an approved draft ([Slack](slack.md)). The program enforces one rule. Nothing reaches DESIGN.md
until a spike or a test proved it, and nothing is done until it was used through the app against a throwaway daemon
at desktop and phone width. One PR, `slack`, on `main` (it began stacked on `watches`, PR #24, which has landed). Its
commits come in four stages, spikes, then connect and read, then follow, then search, people, reactions and files.
Decided by the owner. Direct messages and search stay a scope choice, and there is no Marketplace listing now.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box
above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The
body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-stack.md` with one PR. One owner at a time builds and verifies it, stage by
stage, and the operator lands it after PR #24. The PR is neither pushed nor opened until the operator says so
(AGENTS.md "Changes"). The swarm lanes the playbook names run here as browser tests and Claude-in-Chrome walkthroughs
against a throwaway daemon with a fake Slack, since this repository has no cloud lane machinery.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:AGENTS.md`, `git show origin/main:DESIGN.md` ("Connections", "Watches", "Trust", "Messages"), `git show origin/watches:docs/watches.md`, `docs/slack.md`.
- [ ] The operator has configured the Slack app as Appendix A lists and has given its client id. Without it the spike stage cannot run and the connect stage cannot be verified against Slack.
- [x] The base is `origin/watches` at the SHA the status message records. When PR #24 lands, rebase `slack` onto `origin/main` and record the new base. Done on 2026-11-08. PR #24 merged as c0641047, the branch rebased onto `origin/main` at 5a8a4977 with no conflicts, and the base is `origin/main` from here on.

### Spawn owners

- [ ] One owner for the PR per stage, a fresh subagent each time with the consolidated brief. This plan, `docs/slack.md`, the base SHA, the branch and the prior stage's report. A stage starts when the one before has every unit box checked.
- [ ] The owner works in a local topic worktree from the base, makes small conventional commits whose messages carry the why, decisions and caveats, and never touches `~/.banda`.
- [ ] The owner posts a status message at every tick. The head SHA, boxes checked since the last tick, what blocks. The root polls on `/loop 1h` and relays the status message to the operator only when something changed.

### PR mechanics

- [ ] `npm run check`, `npm run typecheck` and `npm test` green before every commit. `npm run test:fast -- <file>` during edits, at most two workers, unique temp homes, OS-assigned ports.
- [ ] A new durable effect gets a fault worker under `test/fault/` and runs in the `faults` project. Fault suites run in CI by dispatching the `ci` workflow on the branch, never locally.
- [ ] Every new component or card variant joins the specimen (`#/specimen`), light and dark, 390 and 1440.
- [ ] Before review, `/no-comments` and `/deslop` over the diff. The PR body opens with `## Why` restating the goal.

### Verdict and merge

- [ ] The root re-runs the **Verify, unit** block, the **Verify, live** lanes and the **Verify, perf** block at the exact head SHA, and two audit lanes read the diff and the receipts distrusting the PR body. One audit lane is an adversarial review for trust and durability (AGENTS.md principle 11). Its findings are triaged fix now, implementation note or dismiss, in the PR.
- [ ] A finding blocks when it breaks a Trust law, loses or duplicates a message or a wake, or leaks a credential. A failure recorded against trunk in the lane marked "Regression lane against trunk." does not block the PR.
- [ ] At merge-ready the PR goes to the operator with its receipts. The operator lands PR #24 first, then `slack`. A new head gets a fresh verdict unless its patch-id is unchanged (`playbooks/shipping.md`).

### Boot recipe, for every live lane

Each live lane runs in a throwaway home against a fake Slack, or against the operator's real Slack team when the
lane says so, driven by the browser test harness (`test/*.browser.test.ts`) or Claude in Chrome.

- [ ] `git fetch origin slack && git checkout <head SHA>`, `npm ci`, `npm run build:web`.
- [ ] `BANDA_HOME=$(mktemp -d) BANDA_SLACK_CLIENT_ID=<id> node dist/cli/index.js serve --port 0`, then open the link it prints and onboard with the faux provider unless the lane needs a model.
- [ ] Deliver input only through the app (the composer, cards, Settings) or the CLI (`say`, `approve`, `deny`). The read-only diagnostics are the daemon's log and `status`.
- [ ] Save every screenshot to `/tmp/swarm-slack/worker-<n>/<slug>.png` and return the paths with the report.
- [ ] Stop the daemon and run `npm run boxes:sweep` when the lane ends.

## Build the Slack connection (slack)

**Depends on.** `origin/main` with PR #24 (`watches`) merged, and the operator's Slack app (Appendix A).

**Files.**

- [ ] Create `scripts/spike-slack.ts`, the recorded run of the spike stage (AGENTS.md principle 6), kept.
- [x] Create `shipped/connections/slack.md` as `docs/slack.md` sketches it, fixed by the spikes.
- [x] Create `src/core/slack-rest.ts`. `SLACK_TOOLS`, `slackCall`, `slackWriteCall`, mrkdwn to plain text, names resolved through a per-account cache, authors as handles with `[bot]` and outside marked, `mentions_me`, `active`, and `slackBudget`.
- [ ] Edit `src/core/rest.ts`. Register `slack` in `REST_APIS` with `required`, `scopes`, the account read (`whoami`, `handle`), `read`, `write`, `drafts` and `limits`.
- [x] Edit `src/core/oauth.ts` and `src/server/capabilities.ts`. A `CLIENTS` table over client names (`google`, `slack`) replaces the Google branches. Each row holds the public id and its environment override, the authorize parameters, the token body's shape and how the redirect is sent.
- [ ] Edit `src/core/connections.ts`. `client: slack` accepted, `limits` parsed from the file.
- [x] Edit `src/core/objects.ts`. The Slack kinds' URL shapes and ids, the root taken from `thread_ts`, `p<digits>` turned into Slack's `ts`, the `messages` and `contact` cards fed from Slack readings.
- [x] Edit `src/core/follow.ts`. A read's `pages` declaration (`list`, `by`, `keep`), the window and the merge, and `authors` scoped to additions where a kind says so. Built as follows. a list's author owns an item's coming, going and own fields, a list inside it is judged by its own entry or the rules (`authorOf`). Evidence. the property "a list's author speaks for its items…" in test/follow.test.ts, which fails on the code before it, with GitHub's, Drive's and Gmail's tests unchanged.
- [ ] Edit `src/core/watches.ts`. The paged look, pages held in the task's record across a crash, "behind" while a gap is open, a gap older than an hour closed by a fresh window with the marked wake, and the budget's spacing between looks on one account.
- [ ] Edit `DESIGN.md` "Watches". The paged list and the per-account budget as rules, only after the unit boxes below are checked.
- [x] Create `test/fixtures/slack.ts`, a fake Slack Web API over the fetcher. OAuth by PKCE, `auth.test`, `team.info`, conversations, users, search, `chat.postMessage`, `reactions.add`, files, and `Retry-After` on demand. Evidence. the fixture as of stage 3 (`reactions.add`, `files.info` and `files.slack.com`, a late index, a per-minute clamp); `team.info` left out, stage 0 found `auth.test` names the team.
- [ ] Create `test/slack-rest.test.ts`, `test/watch-slack.test.ts`, `test/slack.browser.test.ts`, `test/fault/slack-post-worker.ts`, `test/slack.faults.test.ts`.
- [ ] Edit `test/oauth.test.ts`, `test/connections.test.ts`, `test/object-shapes.test.ts`, `test/stored-shapes.test.ts`, `test/follow.test.ts`, `test/watch.faults.test.ts`, `test/fault/watch-scenario.ts`.
- [ ] Create `web/public/providers/slack.svg`. Edit `web/src/specimen/fixtures.ts` and `web/src/specimen/panel.tsx` with Slack's tile, a thread, a channel, a search and a person card, an outside author and a bot, the post and reaction drafts, a Slack watch's row with "behind", and the Follow card on a channel.
- [ ] Edit `docs/slack.md` and `docs/status.md` as each stage lands, and delete this plan when the program closes.

**Build.**

- [ ] Stage 0, the spikes. `spikeSlack(port, clientId)` in `scripts/spike-slack.ts` runs the PKCE flow on a given loopback port through `authorizeUrl` and `exchange` with a Slack client row, then calls `auth.test`, `conversations.history` with a limit of 100 twice within a minute with and without `oldest`, `conversations.replies` on a thread of twenty replies, `search.messages` sorted by timestamp against a message it just posted, `conversations.info` on a shared channel, and a refresh after expiry. It prints each answer's shape, the limit honoured, `Retry-After`, page order and cursors, tokens redacted. Appendix A is filled and `docs/slack.md` fixed before stage 1 begins.
- [x] Stage 1, connect and read. `CLIENTS` in `src/core/oauth.ts` read by `authorizeUrl`, `exchange`, `refresh` and `oauthClient`, the Google branches in `src/server/capabilities.ts` become lookups.
  - [ ] `slackBudget` in `src/core/slack-rest.ts`, a per-(account, method) queue that spaces calls to the declared rate, honours `Retry-After`, and answers a caller past its depth with "Slack is busy, try again" in words.
  - [x] `SLACK_TOOLS` and `slackCall`, each read's answer shaped as the kinds' `fields` name it and bounded by `MAX_RESPONSE_BYTES`.
  - [x] `slackWriteCall` for `post_message`, `effect: "unsafe"`, on the `private` floor, its draft words "Post in #name" or "Reply in thread in #name" with the text shown as it will notify.
  - [x] The Slack kinds in `src/core/objects.ts` and the two cards reading them, with `follow` left out of the file until stage 2.
- [x] Stage 2, follow a thread and a channel. `pages` in `src/core/follow.ts`, `window(reading, pages)` keeping the newest `keep` by the ordering field, `merge(held, pages)` joining pages into the window.
  - [x] `lookPaged` in `src/core/watches.ts`. Fetch the newest page, compare its oldest item to the window's newest, hold or merge, record "behind" with the gap's age, repeat on the next due look within the budget.
  - [x] The thread and channel `follow` entries in `shipped/connections/slack.md`, as `docs/slack.md` has them. A mention wakes, a message tells, the owner's own are nothing.
  - [x] DESIGN.md "Watches" gains the paged list and the budget.
- [x] Stage 3, search, people, reactions and files. `search_messages` followed as a `newest` page by `ts` sorted by timestamp, the person kind told, `add_reaction` as an idempotent draft with "Don't ask again for this task" offered, `get_file` reading a Slack file's bytes through the daemon as a blob and never into the box, and `authors` scoped to additions so a reaction on the owner's own message counts. Evidence. test/watch-slack.test.ts (search, person, reaction scenarios), test/slack-writes.test.ts (the reaction draft, a task permission covering the second), test/slack-rest.test.ts, test/attachments.test.ts (a file fetched only when a card shows it); `get_file` itself says what a file is and the bytes come through the owner's open from a card.

**You see.**

- [ ] Stage 0. A run on port 7788 and one on another port, each ending in `authed_user.access_token` present with no bot token, or Slack's exact refusal, in the script's output, with the limit honoured, `Retry-After`, page order and refresh shape recorded.
- [ ] Stage 1. Settings → Connections shows Slack's tile. Connect Slack opens Slack's authorize page with `user_scope`. The callback ends in "Signed in as @you at Team · on for <agent>".
- [ ] Stage 1. An agent asked "what's new in #general" answers with a channel card. A pasted permalink in the owner's words draws a compact inline reference. A link to a reply and a link to its root open the same thread card.
- [ ] Stage 1. "Reply in that thread saying I'll look" opens a draft on the thread's card with the text editable, "Send" as the verb and no "Don't ask again" offered. Approved, the message appears in Slack from the owner. Three thread unfurls in one message are fetched a minute apart, drawn from held readings when present.
- [ ] Stage 2. Follow on a channel card makes a watch. A message in the channel draws a tell line. A mention wakes the agent, whose reply follows the event line. Forty messages at once arrive as one wake three looks later, the row saying "behind" between and "looking" after, all forty in the card. The owner's own approved reply in a followed thread wakes nothing.
- [ ] Stage 3. A search watch on `slack/search/in:#deploys failed` wakes on a match. A reaction approved once for the task asks nothing for a second one in the run. A file in a message is a named link whose card shows its size and opens through the daemon.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `test/oauth.test.ts`. The `CLIENTS` table for Google and Slack, `user_scope` sent and `scope` not, `authed_user.access_token` as the token, no `client_secret`. Run `npm run test:fast -- test/oauth.test.ts`.
- [ ] `test/slack-rest.test.ts`. Each read's shape against the fake, mrkdwn rendering, mention and bot marking, `whoami.handle`, the budget's spacing and `Retry-After`, `post_message` on the floor, `add_reaction` idempotent, `get_file` bounded. Run `npm run test:fast -- test/slack-rest.test.ts`.
- [ ] `test/connections.test.ts`, `test/object-shapes.test.ts`, `test/stored-shapes.test.ts`. The file parses, the kinds' URLs and ids round-trip, a reply's link names its root, `limits` is stored. Run `npm run test:fast -- test/connections.test.ts test/object-shapes.test.ts test/stored-shapes.test.ts`.
- [x] `test/follow.test.ts`. `window` and `merge` properties. Merging the same pages twice is the same reading, and nothing newer than the window's newest is ever dropped. Run `npm run test:fast -- test/follow.test.ts`.
- [x] `test/watch-slack.test.ts`. A thread and a channel through the scenario harness. A burst past the page, a gap closed late, three watches sharing one budget, a `Retry-After`, pages held across a kill, the owner's own post ignored, a bot's post told, a search's late-indexed match, a person's status change told. Run `npm run test:fast -- test/watch-slack.test.ts`. Evidence. 14 passed at stage 3's head; the three watches run the real adapter and budget against the fake's one-a-minute clamp.
- [ ] `test/slack.faults.test.ts` and `test/watch.faults.test.ts`. A post under a kill at every boundary is sent once or asks again, never twice. A reaction runs again unasked and ends with one reaction. The watch sweep kills at the page fetch, the hold, the merge and the wake. Dispatch the `ci` workflow with faults on the branch and record the run id.
- [ ] `npm run check && npm run typecheck && npm test` green at the head.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `sonnet` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Connect Gmail by the fake Google and follow a GitHub pull request by the fake GitHub at trunk (`watches`) and head. Save `regression-gmail-github.png`. Pass when both sign-ins end "Signed in as" and the pull request's wake lines match at trunk and head.
- [ ] Lane 2. Connect Slack against the fake at 1440 from Settings, then at 390 from the agent's card. Save `slack-connect.png`. Pass when both cards say "Signed in as @ana at Acme · on for Mara" and the phone's card is alive in the chat after the redirect.
- [ ] Lane 3. The agent reads a channel and names it, and the owner pastes a permalink to a reply. Save `channel-card-and-reference.png`. Pass when a channel card is drawn and the reference opens the thread's root card.
- [ ] Lane 4. A thread draft "Reply in thread" with `@here` in the text, approved once, then a second one declined. Save `post-draft.png`. Pass when the draft shows the notification plainly, offers no permission scope, the fake logged exactly one send, and the declined call returned declined.
- [ ] Lane 5. Three thread unfurls in one message with the fake at one request a minute, then the fake answering `Retry-After` of 30 seconds. Save `budget.png`. Pass when the cards appear a minute apart, the card says Slack is busy on the refusal, and the next request waits thirty seconds.
- [ ] Lane 6. Follow a channel from its card, post three messages, then one mentioning the owner. Save `channel-follow.png`. Pass when three tell lines appear without a model run and the mention's event line says "mentioned you" with the agent's reply after it.
- [ ] Lane 7. Forty messages at once at one request a minute, then a kill between a page fetch and the merge and a restart. Save `channel-burst-kill.png`. Pass when the row says "behind", one wake names what came together within four minutes, and the wake appears once after the restart.
- [ ] Lane 8. Follow a thread, the owner approves a reply the agent drafted, another replies, then the account is switched off for the agent. Save `thread-own-and-authority.png`. Pass when the owner's reply draws nothing, the other's wakes, and the row says why the watch ended in that commit.
- [ ] Lane 9. A search watch with a match the fake indexes a minute late, a person card's status change, a reaction draft at 390 approved for the task and a second reaction in the run, a 2 MB file and one past the bound. Save `stage3.png`. Pass when the late match wakes or the row says changes may be missing, the status change tells, the second reaction asks nothing, the file opens through the daemon and the oversize one is refused in words.
- [ ] Lane 10. The operator's real team in a forked home at 1440 and 390. Connect, read a channel, reply once to a message of their own, follow a busy channel and a thread, and a search watch over a day. Save `real-team.png`. Pass when the reply is in Slack from the operator and nothing else was sent, a real mention woke the agent, the row never said "looking" while behind, and every match in Slack's own search appeared as a wake.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Requests to Slack per minute per account at head across every watch, agent read and unfurl on it, and the diff time of a 100-message window with 40 changes. Trunk has no Slack, so the budget is absolute. At most one history request per minute per account, zero requests for a card drawn from a held reading, and the diff within the bound below.
- [ ] Probe. Three channel watches and one agent message naming three threads on one fake account for ten minutes, requests counted at the fake, the diff timed in the scenario harness, interleaved with the trunk probe of a GitHub pull request watch for the same ten minutes.
- [ ] Baseline. Record the trunk GitHub pull request watch's requests per look first (four per look, from PR #24's review) and its diff time (12 ms for 42 changes on a 268 KB reading).
- [ ] Rule. More than one history request in any minute on one account fails. A card redrawn from a held reading making a request fails. A quiet look's diff over 5 ms or a 40-change diff over 20 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 4, 6, 7 and 9 screenshots into `docs/screenshots/slack-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of connect, a card, a draft and a channel followed through a burst on a lane. Save it as `docs/screenshots/slack-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, the adversarial review triaged.
- [ ] DESIGN.md "Watches" carries the paged list and the budget only with every unit box checked.
- [ ] Rebased onto the current base after the verdict, patch-id unchanged. After PR #24 lands, rebased onto `origin/main`.
- [ ] Handed to the operator at merge-ready. The operator lands it after PR #24.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `docs/slack.md` says what shipped and what remains. `docs/status.md` records the owner's acceptance. This plan is deleted, its evidence living in the commits and tests (docs/README.md keeps no separate backlog).
- [ ] Reply to the operator with the PR, its head, and the receipts.

## Appendix A. Prototype evidence

Stage 0 ran on 2026-11-08 on this branch with `scripts/spike-slack.ts` against the owner's own team and the channel
they named; the probes' log is the recorded run and `docs/slack.md` "What the spikes found" holds the observations.

- The app as configured. PKCE enabled, redirect `http://127.0.0.1:7788/oauth/callback`, the twelve user scopes, no bot scopes.
- A loopback port other than the registered one. Refused on Slack's page before any redirect, "redirect_uri did not match any configured URIs".
- A `user_scope`-only grant. Returns `authed_user.access_token`, `refresh_token` and `expires_in` of twelve hours, and no bot token; before PKCE was on, the exchange answered `bad_client_secret`.
- The history limit on the owner's team. Not clamped, 60 of 60 messages twice within a second, no `Retry-After`. Open, the limit a second team meets, and whether the budget is per team or per token.
- Page order and cursors. History newest first with and without `oldest`; replies parent first then oldest first, `limit` counting replies, the parent repeated on every page, `next_cursor` present while `has_more`.
- Search indexing lag. Under ten seconds.
- A shared channel from two accounts. Open, no shared channel was available.
- Refresh behaviour. A refresh without a secret answers new access and refresh tokens. Open, whether the 30 days slide.
- `team.info` needs `team:read`; `auth.test` answers the team's name, so the handle needs no extra scope.
- A post with the user token carries `user` and also `bot_id`, `app_id` and a `bot_profile` named after the app.
- `conversations.list` over 758 channels missed a public channel the owner is in; `conversations.info` by id answered it.

## Appendix B. Alternatives rejected

- Four PRs, one per stage. The operator asked for one PR stacked on `watches`. The stages stay as ordered commits with their own evidence, so each is verifiable on its own (the sequence-verifiable-units principle).
- A bot user with Socket Mode or the Events API. Slack refuses bot scopes on a desktop redirect. Socket Mode's app-level token is the app's, not the team's, and allows ten connections for every install together. The Events API needs a public URL. Push stays in DESIGN.md "Open".
- A cursor read from the previous reading's newest `ts` into `oldest`. Slack's history answers newest first, so a burst past the page would be skipped for good. The paged list walks pages down to the window instead.
- Delta readings holding only what is new since the cursor. The card would show only the delta, and a watch whose cursor fell behind would diff two deltas. The reading stays a whole window.
- A channel whose every message wakes the agent. A model run every two minutes all day. Mentions wake, messages tell, words are a search watch.
- Direct messages and search in the required scopes. The owner decided they stay a choice.
- A Marketplace listing to lift the history limit. Not now, the owner decided. The budget and the paged list make the design hold without it.
- Stable `T…/U…` ids as the account id. DESIGN.md wants what the service calls the owner, shown. Handles are the precedent (GitHub's login, Gmail's address), and the adapter keeps the ids beside the credentials.

## Appendix C. Risks

- Slack refuses a loopback port other than the registered one (stage 0). Then banda's default port is registered and the connect card says so on another port. The owner watches the spike's output.
- The history budget is per team, not per token (stage 0). Two accounts of one team then share the minute and the budget keys on the team. The owner watches the spike's output.
- Refresh tokens expire 30 days from sign-in, not from the last refresh (stage 0). Every account then signs in again monthly, said in its row. The owner watches the row's words.
- The paged list touches the watch task (stage 2), the most fault-sensitive code on `watches`. Its sweep must run in CI before the verdict, and if PR #24 moves, the stack rebases.
- `search.messages` honours the owner's Slack search filters (Slack's reference), so a search watch may see less than the owner expects. The owner watches lane 10.
- A Slack Connect channel exists in several teams (stage 0). Until answered, a shared channel's link may draw as the wrong account's reading. The owner watches the spike's output.
- One PR carries four stages, so review is heavier than four small ones. The ordered commits and the per-stage unit boxes keep each stage checkable on its own.

## Appendix D. Links and reading list

- `AGENTS.md`, `DESIGN.md` "Connections", "Watches", "Messages", "Trust", `docs/connections.md`, `docs/watches.md` (on `watches`), `docs/slack.md`, `docs/delivery.md`, `docs/verification.md`.
- Code to read before editing. `src/core/rest.ts`, `src/core/gmail-rest.ts`, `src/core/oauth.ts`, `src/core/connections.ts`, `src/core/objects.ts`, `src/core/follow.ts` and `src/core/watches.ts` (on `watches`), `src/server/capabilities.ts` (sign-in and drafts), `test/fault/watch-scenario.ts`, `test/fixtures/google-drive.ts` (a fake API's shape), `test/watches.browser.test.ts`, `web/src/chat/Object.tsx` (`MessagesCard`).
- Slack. The PKCE guide at docs.slack.dev/authentication/using-pkce, the rate-limit change at docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps, and the `search.messages`, `conversations.history`, `conversations.replies`, `chat.postMessage` and `reactions.add` references.
- Stages 1 and 2 get the `how` skill over OAuth and the watch task before editing, and `interrogate` on the paged list before stage 2 ships. The decision trail per `show-me-your-work` lives in the commit messages.
