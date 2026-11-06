# Draft: memory on the phone

Status: **draft for owner review**, no code. It follows DESIGN.md "Memory" and [Memory](memory.md); where they
disagree, they win.

## What exists

Settings shows the shared (global) facts through `MemorySettings` without an agent. An agent's panel has a Memory tab
with two scopes, "This agent" and "Shared", over the same facts. On a phone the panel opens as a sheet over the chat,
so the agent's facts sit two taps deep and Settings never shows an agent's facts at all.

## Settings → Memory

One page, the same facts as everywhere else, never a copy (DESIGN.md: "Settings shows the same shared facts").

- **Shared**, first: the band's facts, each one line, with Add, Edit and Forget.
- **Per agent**, after: one collapsed row per agent (face, name, how many facts), opening that agent's facts with
  Edit and Forget. Add is offered here too and saves in that agent's scope, named by the row, never by the text.
- A fact about another person shows only under its agent. Shared's Add refuses a fact that names someone else and
  points to an agent's memory instead, since such a fact "stays agent-scoped, never in the band's shared memory".
- Each scope shows its budget as it fills; a save that would pass it is refused with the facts kept, and the owner
  shortens or forgets one first, as an agent must.
- Forget asks first and says what it does: the fact leaves its file and search; what was said in chats stays.
- Archived agents keep a row, read-only apart from Forget, so their facts can still be removed.

## An agent's Memory tab

The panel's tab, made a first-class phone screen (a sheet at full height, or the panel's tab on desktop).

- **List**: this agent's facts first, then the shared ones it also reads, marked "Shared with the band".
- **Edit** in place, one line; the correction names the exact old fact, so a stale edit is refused, not applied over
  newer words, and the draft stays for the owner to retry.
- **Add**: a field at the foot, saving in this agent's scope by default; a switch moves it to Shared, disabled with a
  reason when the fact is about another person.
- Facts are context, not permission: nothing on this tab grants a tool or changes the agent's personality.

## Phone specifics

- Rows are full width with Edit and Forget behind a row's menu (or a swipe), never two small buttons.
- Edit opens a drawer with the keyboard up; an unsaved draft survives closing it, a scope switch and the daemon
  being briefly unreachable.
- Back closes the drawer first, then the tab.
- Memory unavailable (the box is down) says so and keeps the list read-only rather than empty.

## Open questions

1. Should "about another person" be detected (a model check) or declared by the owner when adding?
2. Does Settings' per-agent list replace the panel's "Shared" scope, or do both stay as two views of one set?
3. Show facts an agent wrote differently from the owner's, given a box-written source is context, not proof?

## Words

memory, agent, band, Settings: as DESIGN.md defines them. "Fact" is DESIGN.md "Memory"'s word for one line of memory.
