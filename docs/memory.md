# Memory

Priority: **Medium**. Implementation status lives in [Status](status.md).

Memory has two audiences (DESIGN.md "Memory"): global facts shared with the band, and one agent's facts across its
direct and group chats. Both are compact, bounded plain-text files. Definitions stay in `agents/<name>.md`;
project instructions, conversation history, artifacts and routines are not additional memory layers.

Entry points: ../src/core/memory.ts, ../src/core/search.ts, ../src/server/memory.ts,
../web/src/chat/MemorySettings.tsx and ../web/src/app/Shell.tsx.

## Work and acceptance

Bind every model operation to its stored calling agent, including group executions. Apply recall's audience before
ranking and limiting. A fact's path and exact words bind its id; corrections and deletions never use an id to reach
another agent's facts. The owner can inspect and change every audience. Shared memory in Settings and in an agent's
controls is one set of facts, not copies. A changed global fact reaches an existing chat at its next model boundary.

Test small memory budgets, missing scope, unknown callers, forged metadata, stale edits, concurrent owner edits,
replays interleaved with owner changes (including restoring identical contents), and restart. Scope is not filesystem isolation in a shared box. Search stays derived and rebuildable; a deleted
fact leaves search pages, while source chat history remains. App checks cover both widths, unavailable memory and
recoverable edit failures; unsaved drafts survive both scope switches and temporary unavailability. Follow [Delivery](delivery.md) and [Verification](verification.md).

## Open work

- [ ] Conditional workspace mutations under concurrent box writes; apply the shared primitive from [Workspace](workspace.md)
- [ ] A fact's source is written by the box, so it can be forged: sign it, or keep sources in the store
- [ ] Deleting a chat (and its messages from search): a deleted fact stays in what was said where it came from
- [ ] Search catches up lazily (before recall, after memory writes, at the sweep); messages are scanned per chat
- [ ] A "before" gate for the facts an agent writes, and "Why" a message said what it did (DESIGN.md "Open")
