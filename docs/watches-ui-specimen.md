# Watches: UI specimen

Status: approved specimen for slice 1. Derived from DESIGN.md ("The app", "Connections"). Implementation follows this.

## Sidebar (la banda)
- A watch has no row of its own: it belongs to its agent. The agent's row is the presence.
- A watch that waits on the owner (a change not yet resolved) makes the row read "Waiting: …" in ink, like an open ask, and the agent's face gets the waiting dot.
- Watches that need no decision only raise the unread count; nothing turns bold until read.
- Paused watches dim the face, as paused routines do.
- A watch never fires a desktop notification; it only badges (as routines do).

## Chat (the feed)
- Each wake is an event line in place: the change in the kind's words, then the object's card beneath, then the agent's reply if it answered.
- Line examples: "Review requested by @ana", "Checks failed on banda#34", "Merged", "New comment from @bob". Words come from the kind's rules, never from the model.
- A tell draws the line and the card without running the agent and does not count as unread.
- A problem (can't reach the service, or an hour without a look) is an error line and counts as unread.
- Lifecycle lines: "Following banda#34 until merged" (start), "Done · merged" (ended by until), "Paused", "Can't reach GitHub since 10:42".
- The final line of a watch that ended stays in the chat; it is not folded.

## Panel (agent's Routines tab)
- Below the routines, a Watching section: one row per watch with the service icon, the object's title, what ends it, last look and what it saw, and paused or done.
- Row actions: Check now, Pause. Tapping opens the object card and the watch editor.
- Follow takes a link; a PR card in the chat also offers Follow among its quiet actions.

## Not shown
- No ids, file paths or internal keys. Accounts appear as "@bandarra", never as an id.
- No counter of "watching N things".

## Open
- Nothing. Both questions were decided by the owner: a change that needs a decision appears in the sidebar as "Waiting: …"; the final line of an ended watch stays in the chat.
