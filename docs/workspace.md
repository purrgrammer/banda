# Workspace mutation and concurrency

Priority: **High**. Implementation status lives in [Status](status.md).

## Findings

Artifact write-back checks a destination before renaming into it, leaving a concurrent-writer window. Rollback and routine writes have related races. A cooperative lock or daemon mutex cannot constrain arbitrary box code. Crash sweeps alone do not establish concurrent-write correctness.

Entry points: ../src/core/artifacts.ts, ../src/server/routines.ts and ../src/server/memory.ts.

## Work and exit criteria

- Spike pi-env/filesystem support for conditional replacement against an arbitrary concurrent box writer. A daemon
  mutex or a cooperative lock is insufficient. Test open file descriptors, symlinks, parent changes and rename races.
- Apply the proven primitive to artifact edits/restores, then audit routine, memory and accepted
  definition writes for the same class of race. Bind accept and decline actions to the bytes the owner saw.
- Make conflicts useful in the app: retain both versions, explain the conflict, and allow deliberate resolution.
- Recover cancellation and crash leftovers without deleting unknown bytes or keeping abandoned work forever.
- Exit: no owner or box version is silently overwritten; restart and concurrent-writer properties both hold.

Follow [Delivery](delivery.md) and the relevant gates in [Verification](verification.md).

## Open work

Recheck these items against current code before implementation; an unchecked item is not a freshly verified
defect. Remove it only when its fix and acceptance evidence are recorded in a commit.

- [ ] Qualify agent-definition publication under CI faults and through the running app at desktop and phone width.
  Verify saved owner versions separately from retained mutable workspace files, including late writes through an
  old descriptor, conflicts after restart and stale resolution actions. Retained history is still writable by box
  code; it is recoverable history, not a boundary against deliberate deletion. Complete its retention and cleanup
  contract before claiming the whole workspace section finished.
- [ ] An owner's version written back: the box's file is absent for the moment it is moved aside (a read then finds none); a new file the box makes at the path in the instant between the check and the rename in is replaced; a kill or an abort mid-write leaves `.<name>.<task>.tmp` or `.aside` beside the file until that write-back reruns (an aborted one never does), and a moved-aside file whose bytes the artifact does not know is left beside it
- [ ] A card's publish shows "removed" for a moment when the chat's items reach the app before the artifact does
