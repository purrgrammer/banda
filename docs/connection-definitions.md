# Connection definitions

Priority: **Medium**, after Slack lands. Implementation status lives in [Status](status.md). This is a design under
owner review; nothing here is code yet, and it changes rules DESIGN.md states today, so those change only when a
slice proves its part ([Delivery](delivery.md)). It belongs to [Connections](connections.md).

A connection's definition stops being a file in the owner's workspace. What banda ships is read from the release,
typed and checked against a schema; what the owner chose in this home lives in the store. Adding a shipped connection
is a switch, and nothing is ever updated, because the definition in effect is the one this banda ships.

## Why

A connection file was designed as something an agent writes and the owner accepts (commit 24b894b3: "the agent grows
what it can do only through 'before' files the owner accepts ... the body says why"). That use is gone: agent-built
connections are out of scope and their code is open work to delete ([Connections](connections.md)). What remains
is configuration, and the file shape now costs more than it gives. Observed in the code and in a home with ten
connections:

- **No agent and no person writes one.** The five built-in ones (Gmail, Calendar, Contacts, Drive, Slack) and GitHub
  are written by a release (GitHub's by `scripts/shipped-github.ts`). The ones an owner adds by address are written by
  the daemon, and rewritten by the daemon when the owner says which tools only read.
- **Its prose reaches nobody.** The body becomes `why`, whose only use is a field of the API's connection summary
  that the app never reads. No prompt and no tool description carries it.
- **There are two copies, and a mechanism only to sync them.** Adding copies the shipped file into the workspace and
  accepts its hash; a newer release is then offered as Update, compared by text, refused while the box holds a change.
  AGENTS.md principle 1 names this: a mechanism that only syncs two stores means one of them should not exist.
- **Code and data that must agree are versioned apart.** The parser already refuses a built-in file that disagrees
  with the code registry on its client, address or scopes, and the kinds' fields, `follow` rules and `pages` name
  fields the adapter of the same release produces. A home that added a connection on an earlier build runs the new
  adapter against the old file until its owner clicks Update.
- **State is kept by editing text.** Marking a tool as a read rewrites one line of the file and accepts the whole
  again by hash.
- **The rule for data already says otherwise.** AGENTS.md principle 2: a file that holds data, not prose, is `.json`
  with a TypeBox schema, `.md` only where free-form text is the point. Connection files are data with hand-written
  checks.

Harnesses already work the way this proposes: `shipped/harnesses/` is read at start (`shippedHarnesses`), never
copied, and the store holds which the owner connected.

## The design

**Three things, three places.**

| What | Where it lives | Who writes it |
|---|---|---|
| A definition banda ships: the service, how it signs in, its scopes and choices, which tools read, floors, `needs`, the kinds with their cards, writes and how each is followed | `shipped/connections/<name>.json` in the release, checked against one TypeBox schema at start and in the tests | banda's release; GitHub's by its generator |
| A server the owner added by its address: its name, address, how it signs in, the client and scopes they gave, and which tools they said only read | the store, one typed record per connection | the daemon, in the commit that takes the owner's choice |
| What this home chose: which connections are on, their accounts and each account's access, agent switches, tool switches, the tools a server listed | the store, where the rest of it already is (`Connected`) | the daemon |

- **The definition in effect is the one this banda ships.** The daemon reads the shipped definitions when it starts
  and never again; a definition that does not pass its schema is left out and said in the log, and the tests refuse
  to ship one. A release that changes Slack's cards or rules takes effect at that start, with the adapter it belongs
  to. The owner updated banda themselves, so nothing asks them to take the change a second time.
- **Add is a switch.** Turning a shipped connection on records that it is on in this home, and the connect flow goes
  on as today: sign in, pick the agents. Removing it signs its accounts out and ends its watches in that commit, as
  today, and flips the fact off. There is no Update and no "it proposes a change to this connection".
- **A server the owner added is a record.** The address, the sign-in kind found by discovery and the owner's read
  declarations are fields the daemon sets in a transaction; "which tools only read" is a set in the record, not a line
  in a file. Every tool still asks first until the owner says it reads.
- **The box holds no connection definitions.** Nothing in the workspace names how a connection works, so nothing the
  box writes can change one, and the daemon no longer compares the box's copy with what was accepted. An agent's own
  file still names the connections it may use, by name.
- **What a definition says is typed once.** One schema for the frontmatter's fields, `needs` and the kinds (`reads`,
  `pages`, `fields`, `writes`, `follow`); the checks `parseObjects` and `parseFollow` make that a schema cannot
  express (a rule's path exists, a placeholder is named, at most one read has `pages`) stay as code after it. The
  prose body goes: what an agent needs to know is in the tools' own descriptions, which is where every built-in
  adapter already says it, and the owner's one line about a connection (`about`) is a field shown in the connect
  dialog.
- **The owner can still look.** Details on a connection shows what the definition says in the owner's words: its
  tools and which read, what each access choice adds, the kinds it draws and what following each does. This replaces
  opening a file nobody opened; GitHub's is 1,413 lines.

**What does not change.** Credentials stay with accounts outside the store. A read runs and a write is a draft; the
floor asks every time. What is offered is what was listed: a remote server's listing is kept in the store for the
definition's version, so a tool the server adds later waits switched off, and a release that changes which tools
read lists again at start. An account whose access the new definition no longer allows signs in again, as a narrowed
file makes it today. Drafts, permissions, objects, readings and watches bind an account as they do now.

**What it asks of the rules.** DESIGN.md's "Core" row for Connection (`connections/<name>.md`, shipped with the app),
the opening of "Connections" (the file written into the workspace and allowed at once, "an ordinary 'before' file"),
Bet 2 and AGENTS.md principle 2 where they list connections among the files an owner or an agent edits: each is
rewritten when its slice lands, to say that a connection is a definition banda ships and a choice the store holds.
"Open" keeps its line on connections an agent builds itself: if that returns, an agent-written, owner-accepted file
is the right shape for those alone, beside the shipped ones, and this design leaves room for it by keeping the
schema the one both would pass.

## Work and acceptance

**Slice 1, shipped definitions from the release.** The schema; the six files as `.json` (GitHub's generator writes
JSON); the daemon reading them at start; "on in this home" in the store; Add as a switch in Connections, Settings
and the agent's card; Update, the hash comparison and the workspace copy gone for shipped connections. Acceptance: a
fresh throwaway home connects each of the six through the app at both widths; a daemon restarted on a build with a
changed definition draws the changed card with no step from the owner; an account beyond a narrowed definition is
asked to sign in again; the stored shapes test covers the new records.

**Slice 2, the owner's own servers in the store.** The record for a server added by address; discovery, sign-in and
read declarations as transactions; `withList`, `withReads`, `needsNoSignIn`'s rewrite and the frontmatter parser for
connections gone. Acceptance: adding a server by its address, marking its reads, a server that turns out to need no
sign-in, and removing it, through the app; a kill at every commit of each under `test/fault/`.

**Slice 3, what is left of the file.** The box's `connections/` and `tools/` folders, `boxedFiles("connections")`,
accepting and declining a box's change to a connection, `command` connections, `OwnTool` and `TOOL_FIELDS` deleted
(the open item in [Connections](connections.md)); DESIGN.md and AGENTS.md rewritten where they name connection files.
Acceptance: the trust properties that speak of connection files are restated over the store and pass; an adversarial
review of the three slices, since they touch what an agent may do.

Pre-release rules apply: stored shapes change in place, with no migration, and a home made by an earlier build need
not open.

## Unknowns to settle before slice 1

- [ ] How a remote server's listing is bound once there is no accepted file: by a hash of the shipped definition, read
  at start, and what a changed hash does to tool switches the owner set (kept by tool name, a tool that no longer
  exists dropped)
- [ ] Whether anything outside the daemon reads `connections/*.md` in a workspace: a skill, a harness, the search index
- [ ] What the app's Details needs from the definition to say it in the owner's words, checked in the specimen before
  the file goes

## Open work

- [ ] Slice 1: the schema, shipped `.json` read at start, "on" in the store, Add as a switch, no Update
- [ ] Slice 2: a server added by address as a store record; no text rewriting
- [ ] Slice 3: the box's connection and tool files and their acceptance deleted; DESIGN.md and AGENTS.md rewritten
- [ ] Slack ([Slack](slack.md)) ships as a `.md` file under today's convention and moves with the other five in slice 1
