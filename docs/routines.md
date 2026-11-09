# Routines

Priority: **High**. Implementation status lives in [Status](status.md).

Routines, deduplicated wakes, runs a day, pause and run now are implemented, with timers. Every routine wakes in its
agent's chat; a wake draws its event line only when the agent replied or the run failed, and trouble (a failed run, a
skipped due time, the runs a day reached) is an error line that counts as unread. The panel's Routines tab lists them
and opens the owner's own editor. Watches and monitors wait for their own design (DESIGN.md "Open").

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
- [ ] The row says what the last run said ("last ran 8:00, nothing to say"): the store does not yet record whether
  a run said anything
- [ ] Tried through the app at phone width (the editor, pause and delete were tried at desktop width; the phone
  pass needs a resizable browser)
- [x] Watches return on their design (DESIGN.md "Watches"); the object side is in [Connections](connections.md);
  monitors wait for theirs (DESIGN.md "Open")
