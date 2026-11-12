# Routines

Priority: **High**. Implementation status lives in [Status](status.md).

Routines, deduplicated wakes, runs a day, pause and run now are implemented, with timers. Every routine wakes in its
agent's chat; a wake draws its event line only when the agent replied or the run failed, and trouble (a failed run, a
skipped due time, the runs a day reached) is an error line that counts as unread. The panel's Routines tab lists them;
a row opens the routine's detail in the same panel: Pause or Resume, Edit (the owner's own editor, in its place), and
its runs. Each run is recorded on the routine's record in the commit that fired or skipped it, and the commit that
ended its Turn says how it ended and where its wake is in the chat; what it said is read from the chat as the feed
reads it, so a run that spoke opens its line there and a quiet one opens nothing. Watches and monitors wait for their own design (DESIGN.md "Open").

Entry points: ../src/core/routines.ts, ../src/core/schedule.ts, ../src/core/control.ts, ../src/server/routines.ts,
../web/src/app/routines.tsx and ../web/src/chat/RoutineEditor.tsx.

## Work and acceptance

Every routine wakes in its agent's chat, never a chat of its own; `ownChat` goes. A wake draws an event line (the
routine's name, when it fired) only when the agent replied or the run failed; a failed, stalled or exhausted run draws
an error line that marks the chat unread. Delete `watch`, watch.ts and the connection files' event sources; delete
the Inbox doc and its cards, since unread is the chat's. The panel lists the agent's routines with pause, run now,
the editor and "+" (a file the daemon writes as the owner's own, in effect at once). `job` becomes `routine` in
code, docs and stored shapes.

A routine runs once per due time, missed due times coalesce, runs a day survive restart, pause holds scheduled work
and run now deduplicates. Fault sweep at wake and event boundaries. Through the app at both widths: make a routine
by asking and from the panel, leave, return to its event and reply, inspect its next run, pause it.

## Open work

- [x] Wakes in the agent's chat; event lines; the Inbox deleted
- [x] `job` becomes `routine` everywhere
- [x] The panel's routine list and editor
- [x] The panel's "next in …" is computed when the daemon pushes, so it does not tick on its own
- [x] A routine's detail: its runs in words (said, said nothing, failed, skipped, waiting, running), ten and "Show
  earlier", a run that spoke opening its line in the chat
- [ ] The row says what the last run said ("Said: 2 PRs need you", "Said nothing"): the record now keeps each run, so
  the control view can say it; reading the chat on every push is the cost to weigh
- [x] Tried through the app at phone and desktop width, light and dark: a routine's detail, its runs opening the
  chat at their line (one the feed does not draw says so), Pause, Edit and Back (test/routine-detail-app.browser.test.ts;
  screenshots in screenshots/routine-detail-review-*.png)
- [x] Watches return on their design (DESIGN.md "Watches"); the object side is in [Connections](connections.md);
  monitors wait for theirs (DESIGN.md "Open")
