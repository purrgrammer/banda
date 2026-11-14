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

**The watch.** `watches/<name>.md` is a "before" file: the object (a link), the account, `until`,
`wakes_a_day` and a body the agent gets at every wake. The `watch` tool writes one as a card ("Follow banda#142 until merged?"); Follow on an object's
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

- [ ] Slice 3 through the app against a daemon: a burst, a limit and an issue against real GitHub (the pass followed
  a pull request alone) (#35)
- [ ] Those kinds through the app against a daemon and real GitHub, at desktop and phone width (#35)
- [ ] The account's own discussion comments still wake, as by an author not known, until a read names who wrote a
  comment (github-mcp-server's `get_discussion_comments` answering it; then `authors` on comments and replies) (#38)
- [ ] A repository's push says "the default branch", not its name: none of its four reads answers it, and the listed
  reads that do (`get_repository_tree` with no `tree_sha`, its `tree_sha`; `search_repositories` for
  `repo:{owner}/{repo}`, its `default_branch`, on the search quota) would be a fifth, past the four a kind may declare;
  a fifth read carried a day by `unless`, or the name kept from the first look, is the owner's call (#38)
- [ ] The Google kinds' changes against real accounts: whether a rename or a share moves Drive's `modifiedTime`,
  whether a deleted (not cancelled) event ends its watch, label names for user labels, a calendar's upcoming events
  (needs a sync token, not a moving window); a contact followed (the pass's account had no saved contacts); a
  calendar event's link carries its id encoded, so an event is followed from its card alone (#35)
- [ ] A discussion's comments are still one page of a hundred, oldest first: `get_discussion_comments` pages by cursor
  only, so its tail needs a walk of cursors; its `totalCount` keeps a comment off the page from being said gone (#34)
- [ ] The tail of a pull request's reviews and comments against real GitHub, through the app (#35)
- [ ] One read of a fixed query in place of four (GitHub's MCP server lists no GraphQL tool, so that is a Connections
  change), should a home hold more watches than that leaves room for (the readings doc's growth with many watches,
  #40)
- [ ] `npm run home:fork` carries no connection sign-ins, so a fork wants a sign-in per connection before a pass (#36)
- [ ] Spike before slice 2: the readings doc keeps 300 and evicts the oldest first, so a held reading must be
  skipped; GitHub's hosted MCP server still answers `pull_request_read`'s get, get_reviews, get_comments and
  get_check_runs
- [ ] With the mail connection: Gmail's history id as a `pages` read, and a service subscription with renewal, as
  data ([Connections](connections.md)); push through a relay stays in DESIGN.md "Open"
