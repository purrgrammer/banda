# Agents and groups

Priority: **High**. Implementation status lives in [Status](status.md).

Agents have stable identities, accepted files and one chat each; groups are shipped on this line as a canonical room
with one hidden execution chat per member, concurrent mentioned-agent executions and attributed replies. DESIGN.md
"Agents" and "Groups" now make every agent ordinary (no lead, no proposals) and put groups in the band; a hand-off
(one agent messaging another for work) is postponed to its own design (DESIGN.md "Open").

Entry points: ../src/core/agents.ts, ../src/core/groups.ts, ../src/core/turn.ts,
../src/server/agents.ts, ../web/src/routes/Agent.tsx, ../web/src/routes/AgentCreate.tsx and
../web/src/routes/Group.tsx.

## Work and acceptance

Make the first agent ordinary: every agent gets the same base tools; `delegate`, `helpers`, `propose_agent`,
`propose_group`, `propose_identity` and `propose_preference` go, with delegate.ts and the side chats they made. An
agent is made from the sheet (emoji, name, personality, connections) and its file written accepted; the owner's own
edits to an agent file are accepted in the commit that stores them; the agent's change to itself is a card in its chat.
The last active agent cannot be archived. Archive durably stops the agent's runs, pauses its routines, revokes its
permissions and removes it from the band and from mentions, keeping its chat and accepted history; restore
re-establishes only accepted authority.

Groups: none up to the owner's members limit, chosen and changed by the owner alone, without rewriting history; the
limits on members, ask depth and chained turns in Settings; `@name` and everyone in the composer; stopping one
member's work or everyone's through the daemon (`POST /groups/<room>/stop`), with no Stop in the app; unread per group; a member's asks in the room; the group's panel lists its members; archive and restore.
Each member keeps its own memory, permissions and browser.

Acceptance includes group snapshot properties and a fault sweep at every append, fan-out, reply, ask, chained mention,
archive and wake boundary. Through the running app at desktop and phone width: make an agent, change it during a
run, pause, archive and restore it, and run a group with concurrent mentions, unread replies, stopping and member
changes.

## Open work

- [ ] Wire tool choices to accepted agent files and enforce them in direct and group chats,
  search, already-loaded tools and retries. Reconcile the existing always-granted memory/routine/meta tools and first
  agent special case with owner-controlled choices; replying and discovery stay available. A tool switch controls
  that tool, not equivalent capabilities reachable through shell or browser access.
- [ ] Qualify pi-durable tool search through the app: initial core exposure, discovery, historical schemas, restart,
  compaction and revocation; search uses pi’s query/limit contract, with no namespace parameter or custom loader.

- [ ] Make owner definition saves and box publication crash-safe and concurrency-safe across all publishers before accepting avatar identity changes
- [ ] Re-audit avatar geometry preflight on every open-bot-avatar upgrade (`npm run avatar:bench`, and `node scripts/avatar-bench.ts <checkout>` on the previous pin); verify native colour selection and installed-icon refresh across supported browsers and platforms
- [ ] Verify meta-tools end to end in a throwaway home: direct agent messages, bounded chat reads, and `create_agent`,
  `update_agent` and `create_group` with their rows and cards at desktop and phone widths (#58)
- [ ] Removing a skill: a SKILL.md gone from the box still leaves effect only when the owner allows it, while adding
  and changing one is the agents' own (DESIGN.md "The workspace"); decide whether removal follows the file too
- [ ] A home made before #58 may hold a pending `propose_*` card: the owner still answers it (`POST /proposals/:id`),
  nothing else applies it; drop the route and `src/core/proposals.ts` once no home needs it
- [ ] Delete the lead, hand-offs, helpers and every `propose_*` tool; make the first agent ordinary
- [ ] The new agent sheet writes an accepted file; the owner's edits accepted in the commit that stores them
- [ ] Reconcile accepted-definition removal across runs, routines and permissions
- [ ] Restoring an agent shows its current connections for review (DESIGN.md "Agents")
- [ ] Groups in the band: rows, unread, member changes, the panel's member list, phone-width review
- [ ] Add archiving a group to the groups fault sweep: a kill between its commit and the stop of its work
- [ ] Give memory an agent audience and keep recall within it; band search excludes memory files ([Memory](memory.md))
- [ ] Replace the shared box and workspace with one structurally isolated computer per agent (DESIGN.md "Open")
