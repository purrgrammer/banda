# Watches

Priority: **High**. Implementation status lives in [Status](status.md).

A watch follows one object through a connection and wakes its agent when it changes, until what ends it (DESIGN.md
"Watches"). The object side (how a kind is followed, the shared reading, Follow on the card, the event line's words)
is in [Connections](connections.md); this section owns the watch itself: its file, task, health, tool and the panel's
Watching list. Monitors (a command's output in the box) wait for their own design (DESIGN.md "Open").

Entry points, once built: src/core/watches.ts (the file, the task, the looks), src/server/watches.ts and the
Watching list in web/src/app/. Commit 4613028 holds an earlier spike (watch.ts, the GitHub rules, a fault worker on a
watched pull request) whose shapes predate routines, `objects:` and the readings doc: take from it, never restore it.

## Work and acceptance

**The watch.** `watches/<name>.md` is a "before" file: the object (a link), the account, `until` and a body the agent
gets at every wake. The `watch` tool writes one as a card ("Follow banda#142 until merged?"); Follow on an object's
card and the panel's Add write the owner's own, accepted in the commit that stores them. The store holds the watch's
task only: its reading, its health, its wakes.

**The task.** The first look happens before the watch is live and is its baseline; a failed first look makes no
watch. Each look reads with the account's credentials in the daemon, diffs against the reading before and sorts the
changes by the kind's rules: wake, tell or nothing. A wake is one input in the agent's chat, keyed by the change
itself, so a look repeated after a crash yields the same wake once. Changes during a run or within the settling time
coalesce; busy cadence and wakes a day as the kind and the file say. `until` ends it with a last wake. Pause stops
looking; resume looks and reconciles into one wake marked as such. Switching the account off, signing out or removing
the connection ends its watches in that commit. Pause routines and Pause all routines hold watches too.

**Health.** What the owner wants (on, paused, done) and what the daemon sees (looking; can't reach, since when;
behind) are separate facts. The row says the observed one in words; an hour unable to look draws an error line and
marks the chat unread; a gap that cannot be replayed is closed by a fresh reading, and the next wake says so. Never
"caught up" when it is not.

**In the chat and the panel.** The event line (the kind's words, the service's icon), the object's card beneath, the
agent's reply when it had one; a tell draws the line and the card without a run and does not count as unread. The
panel's Watching list under Routines: rows (icon and title, until, last looked, last saw, paused or done), Check now,
Pause and Remove; tapping opens the card and the editor; Add takes a link. Every state in the specimen, light and dark,
both widths.

**Verification.** A fault worker on a watched pull request under `test/fault/`: thrown faults and SIGKILLs at every
look, the diff's commit, the wake's submit, the end, pause and resume, and the account's switch; properties over
generated scenarios of readings (duplicates, out of order, bursts, a change before the first look completes, a revoked
account, a cancel while a wake is pending, a thousand changes in one look, days of readings skipped). Invariants: every
change the store recorded ends in a wake, a tell or nothing, recorded; a change wakes at most once; no wake after
done, paused or ended by authority; the card's reading is the newest look's; a scenario replayed after any kill yields
the same wakes. Manual: a real pull request in a forked home, followed by asking in the chat and from the card, left,
returned to and merged, at desktop and phone width.

## Open work

- [x] Slice 1, one pull request end to end: `follow` for GitHub's pull request kind; `watches/` accepted like
  `routines/`; the task (first look, look, diff, wake, until); the `watch` tool's card and Follow on the card; the
  event line with the card; the Watching list with Check now, Pause and Stop; the fault sweep at look, diff, wake
  and end; a real pull request in a forked home at desktop width
- [ ] Slice 1 through the app at phone width (the desktop pass is done; the phone pass needs a resizable browser)
- [x] A real wake seen in the app: purrgrammer/banda#24 followed in a forked home; its pushes told, its checks
  finishing woke the agent as "all checks green, checks finished", each on the right look
- [x] Add in the panel takes a link; the Watching section shows even when empty
- [x] An editor for a watch's words: `until` from the kind's ends, and what matters, bound to the version shown
- [ ] A wake's key is the transition (the watch's `since`, its cursor, the changes), so the same change later wakes
  again; the fault sweep has not run on it yet (CI)
- [x] Slice 2, health and gaps: can't reach (since when) in the row; the error line after an hour, once per run of
  failures, unread; resume reconciles into one marked wake; a gap in the readings kept says changes may be missing;
  the account's switch, sign-out and removal end watches in the same commit; no wake after done or paused; scenarios:
  a revoked account, days offline, a cancel (Stop) while a wake is pending, duplicate and out-of-order readings; the
  scenario's invariants (`watchInvariants`); every state in the specimen
- [x] Slice 2's rest in code: "behind" in the row until a wake without a gap; resuming after Pause all marks the next
  wake as from the pause; the fault worker runs the pause, Pause all and switch-off scenarios (`SCENARIOS`), each
  once without faults in the unit suite
- [ ] The fault sweep and property over every scenario (pause, Pause all, the account's switch, the new burst and
  limit paths, a held failure a later push undid) have not run in CI yet; only a two-run property of Pause all ran locally
- [ ] Slice 2 through the app against a daemon at desktop and phone width
- [x] Slice 3, volume: a burst is one wake (held while the last wake's run goes or within the kind's `settle`, the
  cursor kept, the held reading never evicted); busy cadence (`lookEvery`, tested end to end); `wakes_a_day` (pauses
  alone, an error line, unread; resume wakes once); tell-only changes run no model and are not unread; the issue kind
  followed until closed (labels and assignees as sets, told); a thousand changes in one look name twenty and count
  the rest; a derived "all …" condition may be `steady` over a path, so a push's first look never says all checks
  green; the new rows and lines in the specimen
- [ ] Slice 3 through the app against a daemon; a burst, a limit and an issue against real GitHub
- [x] GitHub's repository-level kinds: a repository (a release, others' new pull requests and issues wake; a push to
  the default branch tells; never ends), a discussion (comments and replies wake; until answered or closed) and a
  workflow run (a job failing wakes; until completed), each with its card in the specimen
- [ ] Those kinds through the app against a daemon and real GitHub, at desktop and phone width; the specimen not yet
  looked at in a browser
- [ ] A repository's push says "the default branch", not its name (no listed read answers it within four reads); a
  discussion's comments carry no author, so the account's own wake too
- [x] Every connection banda ships can be followed: GitHub's pull request, issue, check run, notification,
  repository, discussion and workflow run; Gmail's email (until read or trashed), conversation (others' replies wake)
  and search (new matches wake; never ends); Calendar's event (moved, cancelled, a guest's reply); Drive's file
  (another's edit, trashed) and folder (a new file); Contacts' contact (told only; never ends). Each with scenario
  tests through the harness, which fakes any connection's reads by tool name
- [ ] The Google kinds against real accounts and through the app: whether a rename or a share moves Drive's
  `modifiedTime`, whether a deleted (not cancelled) event ends its watch, label names for user labels, a calendar's
  upcoming events (needs a sync token, not a moving window)
- [ ] A watch's file has no editor field and the `watch` tool no parameter for `wakes_a_day`; an issue's and a pull
  request's comments are read one page of a hundred, so comments past the hundredth are never seen
- [ ] **A look pushes the whole shell.** A watch's task waking and sleeping is a task-graph change, which the shell
  stream watches, so each look (every two to thirty minutes per watch) has every connected stream rebuild every view:
  the chats; the control room (the box's routines and watches folders listed and read, the activity log's hundred
  lines, the permissions); the agents (the agents folder); memory (its files); the capabilities (the shipped files
  read from disk); the areas. `chats`, `control` and `agents` are then written to each client whether or not they
  changed, tens of KB a push. The watches area declares no `watch`, so a look reaches the app by that coincidence
  alone. Fix, in layers: the area owns its state (`watch: [Watches, Followed]`; a `watches` shell event in place of
  `ControlView.watches`, kept on the shell by the app's `areas/watches.ts` handler, written when it changed as the
  areas' events are); the stream writes `chats`, `control` and `agents` only when they changed, like the rest; then a
  change rebuilds only the views its source feeds (each watched doc and the graph mapped to its events), so a quiet
  look costs one `watches()` view and one small event per client. Acceptance: a test on `shell()` counts what a
  quiet look writes: one event, no control view built.
- [ ] **A done watch's readings stay kept.** Reconcile holds the `Followed` reading of every accepted watch's key, a
  done watch's included, and nothing reads it again: a done watch never looks, and its card is `Readings`'s own
  (bounded at 300). So up to four readings of 512 KB sit in the doc until the owner removes the watch, written into
  every checkpoint of it (one per sixteen deltas, each delta a whole changed reading). Fix: the commit that ends a
  watch (by its end, or by authority in `endWatches`) drops the key's reading when no live watch shares it, and
  reconcile drops what a kill between left; `object.version` then leaves a done watch's row, which says Done. The
  scenario's "three that differed" moves from the kept reading to the wakes' `version`s. Acceptance: the invariant "a
  done watch holds no reading unless a live watch shares it", in `watchInvariants`.
- [ ] **Check now remakes the task.** A look the owner asked for moves `next`, but the watch's task sleeps until the
  time the look before set, so `checkNow` ends it (a commit and an abort) and reconcile makes another (a commit and a
  task): pi-durable wakes a sleeping task only at its `until`, and the sleep's checkpoint is the look phase, so a task
  left alone would wake at the old time and read the object again. The sleep is wrong only when the new `next` is
  earlier (the look found the object busy, or came while a wake was held to settle). Fix: the look phase looks only
  when `record.next` is due, else sleeps again (one commit, no read); and `checkNow` remakes the task only when
  `record.next` is before the task's `until` (`tx.task(record.task).state`), else leaves it. Acceptance: Check now on
  a quiet watch keeps its task (its id unchanged, one extra commit at the old time); on a busy one the sleep moves
  earlier; the fault sweep over both.
- [ ] Spike before slice 2: the readings doc keeps 300 and evicts the oldest first, so a held reading must be
  skipped; GitHub's hosted MCP server still answers `pull_request_read`'s get, get_reviews, get_comments and
  get_check_runs
- [ ] With the mail connection: a feed with a cursor and a service subscription with renewal, as data
  ([Connections](connections.md)); push through a relay stays in DESIGN.md "Open"
