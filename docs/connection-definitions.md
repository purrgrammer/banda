# Connection definitions

Priority: **Medium**. Implementation status lives in [Status](status.md). This is a design under owner review. Its
first two stages, the six shipped connections as definitions read from the release and the owner's servers and reads
as records in the store, are built on the branch and not yet tried through the app; the rest is not code yet. It changes rules DESIGN.md states today, so those change only when a
slice proves its part ([Delivery](delivery.md)). It belongs to [Connections](connections.md).

A connection's definition stops being a file in the owner's workspace. What banda ships is read from the release,
typed and checked against a schema; what the owner chose in this home lives in the store. Adding a shipped connection
is a switch, and nothing is ever updated, because the definition in effect is the one this banda ships.

## Why

A connection file was designed as something an agent writes and the owner accepts (commit 24b894b3: "the agent grows
what it can do only through 'before' files the owner accepts ... the body says why"). That use is gone: agent-built
connections are out of scope and their code is open work to delete ([Connections](connections.md)). What remains
is configuration, and the file shape now costs more than it gives. Read in the code and in a home with ten
connections:

- **No agent and no person writes one.** The built-in ones (Gmail, Calendar, Contacts, Drive, and Slack on its own
  branch) and GitHub are written by a release (GitHub's by `scripts/shipped-github.ts`). The ones an owner adds by
  address are written by the daemon (`addMcp`, `addByAddress`), and rewritten by the daemon when the owner says which
  tools only read (`trustReads` on main, `keepWithFile` in PR #28) or a server turns out to need no sign-in
  (`needsNoSignIn`).
- **Its prose reaches nobody.** The body becomes `why`, whose only use is a field of the API's connection summary
  (`summaryOf`) that nothing in the app reads. No prompt and no tool description carries it. Some bodies hold
  instructions written for an agent (Drive's) that the tools' own descriptions repeat.
- **Nothing shows the file.** No screen shows its text, its path or its hash; the hash is a concurrency token and
  nothing more. What the app says about a connection (the line under its name, the labels of its access choices) is
  written a second time in the app's own code (`SERVICES` in Shell.tsx, `SCOPE_CHOICES` in web/src/lib/connect.ts).
- **There are two copies, and a mechanism only to sync them.** Adding copies the shipped file into the workspace and
  accepts its hash; a newer release is then offered as Update, compared by text, refused while the box holds a change.
  AGENTS.md principle 1 names this: a mechanism that only syncs two stores means one of them should not exist.
- **Code and data that must agree are versioned apart.** The parser refuses a built-in file that disagrees with the
  code registry on its client, address or scopes, and the kinds' fields and `follow` rules name what the adapter of
  the same release produces. A home that added a connection on an earlier build runs the new adapter against the old
  file until its owner clicks Update.
- **State is kept by editing text.** Marking a tool as a read rewrites one line of the file (`withList`) and accepts
  the whole again by hash.
- **The box can write there.** The workspace is one writable volume, `connections/` and `tools/` are created in it,
  and the box's own tools tell the model they are folders whose changes wait for the owner. Eight places in the
  daemon compare the box's copy with what was accepted.
- **The rule for data already says otherwise.** AGENTS.md principle 2: a file that holds data, not prose, is `.json`
  with a TypeBox schema, `.md` only where free-form text is the point. `band.json` and `auth/providers.json` follow
  it; connection files are data behind about ninety hand-written checks.

Shipped harnesses are already read from `shipped/harnesses/` and never copied into a home, which is the precedent
for where a definition lives. That they are Markdown too is a separate cleanup, not part of this.

## What PR #28 already does

PR #28 ("agents earn trust per agent; connections only narrow") is open and moves the same way, stopping short of
removing the file. It is to be reworked, so this design does not wait for it: it takes from its branch what its
slices need (the owner's per-tool setting in the store and its check when a call starts, the tool list and its
review, `groups` as data of a definition) and leaves the rest there (trust per agent, grains, earned permissions,
the mark of foreign content, and banda's guesses for a server that says nothing of its tools). Read on its branch:

- **A shipped connection already follows banda's version.** At each start a file the store says is banda's
  (`Accepted.shipped`) is written again as shipped now, with the owner's scopes, accounts and switches kept
  (`followShipped`). The Update click is gone and the owner is asked nothing, which is the decision this design
  rests on. The copy, a marker for whose it is and a write at every start remain; slice 1 deletes those three.
- **The owner's setting for each tool is in the store** (`ToolSettings`), and banda's guesses for a server that does
  not say what its tools do are in `Classified`, by the listing. That is where a home's choices belong.
- **What the owner accepts is still written into the file.** The reads and the groups accepted in the review go
  through `keepWithFile`, so a file banda ships becomes the owner's the moment they allow one read, and stops
  following. Slice 2 moves accepted reads and groups into the store beside the settings.
- **Grains, `plural` and `place` are data in the connection file.** They are part of the definition and of its
  schema, unchanged.
- **The app already shows a connection's tools to check and change**: in groups, each tool with its kind, where
  the kind came from and its setting, on the Connections page and in an agent's Access, and as a review when a server
  is added (`ToolSettings`, `ToolReview` in web/src/chat/ToolKinds.tsx). Slice 4 completes that screen; it does not
  build another.

Where the two disagree, on the file's reads and groups, this is the later word, and the rework of PR #28 builds on
what lands here.

## The design

**Three things, three places.**

| What | Where it lives | Who writes it |
|---|---|---|
| A definition banda ships: the service, a line about it, how it signs in, its scopes and the access choices with their words, which tools read, floors, `needs`, the kinds with their cards, writes and how each is followed | `shipped/connections/<name>.json` in the release, checked against one TypeBox schema | banda's release; GitHub's by its generator |
| A server the owner added by its address: its name, address, how it signs in, the client and scopes they gave, which tools they said only read, and its version | the store, one typed record per connection | the daemon, in the commit that takes the owner's choice |
| What this home chose: which connections are on, their accounts and each account's access, agent switches, tool switches, the tools a server listed | the store, where the rest of it already is (`Connected`) | the daemon |

- **The definition in effect is the one this banda ships.** The daemon reads the shipped definitions once, when it
  starts (today it reads the folder again on every view). One that does not pass its schema or its checks is left out
  and said in the log, and the tests refuse to ship it. A release that changes a connection's cards or rules takes
  effect at that start, with the adapter it belongs to. The owner updated banda themselves, so nothing asks them to
  take the change a second time.
- **Add is a switch.** Turning a shipped connection on records that it is on in this home, and the connect flow goes
  on as today: sign in, pick the agents. Removing it signs its accounts out and ends its watches in that commit, as
  today, and flips the fact off. There is no Update and no "it proposes a change to this connection".
- **A server the owner added is a record.** The address, the sign-in kind found by discovery and the owner's read
  declarations are fields the daemon sets in a transaction; "which tools only read" is a set in the record, not a line
  in a file. Every tool still asks first until the owner says it reads. The two paths that add one today (one writes
  `ask: always`, one does not) become one. The record holds no secret: a key or tokens stay with the account under
  `auth/connections/`.
- **The owner's choices lie over the definition.** A tool's setting, a read the owner allowed that the definition
  did not name, and the groups they accepted are the store's, for a shipped connection and for their own server
  alike. A shipped definition is never the owner's to have changed, so it never stops following banda's version, and
  a connection still only narrows: nothing set on one lets a write run unasked.
- **The box holds no connection definitions.** Nothing in the workspace says how a connection works, so nothing the
  box writes can change one: the folders are not made, the box's tools stop naming them, and the daemon stops
  comparing copies. An agent's own file still names the connections it may use, by name, which was never checked
  against a file.
- **One version per definition.** A shipped definition's version is the hash of what was read at start; a record's is
  a counter that moves with each change to it. Everything that binds to the accepted file's hash today binds to that
  version: the tools a server listed, the stamp on an object's reading, the check each call makes before it runs, and
  the token the app sends back so two edits do not cross.
- **What a definition says is typed once.** One schema for the fields, `needs` and the kinds (`reads`, `fields`,
  `writes`, `follow`, and what later connections add). It carries the closed key sets, enums, patterns and caps that
  about half of today's checks spell out by hand. What a schema cannot say stays code after it: an address or a
  command but not both, a built-in's client and scopes within its registry's ceiling, a read that is not also on a
  floor, placeholders that agree across a kind's templates, a field's path that starts at one of its reads, and the
  grammars of a condition and a period. It is read as `band.json` is: parsed, checked with `Value.Check`, and refused
  whole with the first error.
- **The words about a connection are the definition's.** The line under its name (`about`) and each access choice's
  label and note move from the app's code into the definition, so a connection is described in one place. The prose
  body goes, each one first compared with its tools' descriptions so no instruction an agent relies on is lost.

**The rules a change of version follows.** Today these happen when the owner clicks Update; here they happen at the
start after a release.

- A remote server is listed again when its definition's version differs from the one its listing was taken for,
  as the daemon's start already does when a file's hash differs. Tool shapes and the server's notes are taken as it
  gives them then.
- Tool switches are kept by name across versions. One for a tool that no longer exists is kept until the connection
  is removed, so it returns if the tool does.
- A tool the definition names comes with the release: switched on, a read if the definition says so, with nothing
  asked. A tool a remote server lists that the definition does not name waits switched off, whatever the version.
  This closes a gap in today's rule, which holds only between two listings of the same file: a tool a server added
  before a file changed comes in switched on.
- An account whose access the new definition no longer allows is stale: its credentials are forgotten and it signs
  in again. Widening, or changing what a new account asks for, leaves accounts as they are. This is `fits`,
  unchanged.
- A reading taken under another version is not the current one: a card reads again, and a watch on the object takes
  its next reading as it does after an Update today.

**What does not change.** Credentials stay with accounts outside the store. A read runs and a write is a draft; the
floor asks every time. Drafts, permissions, objects, readings and watches bind an account as they do now.

**What it asks of the rules.** DESIGN.md's Bet 2 (line 32) and AGENTS.md principle 2 (line 10), where they list
connections among the plain text files of the workspace; the "Core" row for Connection (`connections/<name>.md`,
shipped with the app); the opening of "Connections" (its bytes written into the workspace and allowed at once, "an
ordinary 'before' file") and "for that accepted file"; and the workspace section's lists of folders. Each is
rewritten when its slice lands, to say that a connection is a definition banda ships and a choice the store holds.
"Open" keeps its line on connections an agent builds itself: if that returns, an agent-written, owner-accepted file
is the right shape for those alone, and the schema is the one both would pass.

## What moves, and what goes

Outside the daemon's capabilities module, nothing reads a connection file in the workspace: not the search index,
the archive, the home fork, bringing your own, any prompt or any shipped skill. What reads a definition reads the
`Accepted` doc's `connections/…` keys, and those readers move to one map of definitions, built at start from the
shipped ones and the store's records, in the shape they get today (`{...connection, sha}`).

| Moves | Where |
|---|---|
| Readers of the accepted definition | `acceptedConnection` and its roughly 25 callers; src/core/watches.ts, src/core/object-access.ts, src/server/objects.ts, src/server/watches.ts |
| The app's concurrency token | McpSetup.tsx and ConnectFlow.tsx send the definition's version in place of the file's hash |
| The words about a connection | `SERVICES` (Shell.tsx) and `SCOPE_CHOICES` (web/src/lib/connect.ts) into the definitions |
| The generator | scripts/shipped-github.ts emits one object in place of a frontmatter template; the json block already is one |
| Tests that read `shipped/connections/*.md` | about seventeen files and four fault workers; the specimen's import of `github.md?raw` and its regex |
| Words the owner is told | "update … on the Connections page" (a kind that cannot be followed) and "Accept the current connection file" |

| Goes | Where |
|---|---|
| Add as a copy, Update, the text comparison | `addShipped`, `updateShipped`, `shippedUpdate`, the `update` field of the shipped view; `UpdateOffer` in Catalogue.tsx |
| Text rewriting | `withList`, `withReads`, `withoutSignIn`, the frontmatter parser for connections, the parse cache keyed by text |
| The box's copy | `connections/` and `tools/` made in the workspace (src/server/agents.ts), named to the model (src/box/tools.ts), and the eight `boxedFiles("connections")` comparisons |
| A box's change to a connection, offered to the owner | accepting and declining it; the approval card and its words in the feed |
| Agent-built connections and tools | `command` connections, `OwnTool`, `TOOL_FIELDS`, `parseTool`, `ownTool`, `boxSession`, the tool routes: about 345 lines, which docs/status.md already calls deleted |

Releases need nothing: the packers copy `shipped/` whole and assume no extension.

## Work and acceptance

**Slice 1, shipped definitions from the release.** The schema; the shipped files as `.json` with `about` and the
access choices' words, each body checked against its tools' descriptions before it goes; the daemon reading them at
start; the definitions map and the version every binding uses; "on in this home" in the store; Add as a switch in
Connections, Settings and the agent's card; the workspace copy, `Accepted.shipped`, `followShipped` and its fault
point gone for shipped connections. Acceptance: a
fresh throwaway home connects each shipped connection through the app at both widths; a daemon restarted on a build
with a changed definition draws the changed card with no step from the owner, a followed object keeps its watch and
takes a new reading with no false wake, a tool the definition names is on and one a server added alone is off; an
account beyond a narrowed definition is asked to sign in again; the stored shapes test covers the new records; the
sweep kills at each new commit.

**Slice 2, the owner's choices and their own servers in the store.** The record and its version; one path that adds
a server; discovery and sign-in as transactions; the reads and groups the owner accepted, for every connection, in
the store beside `ToolSettings`; `keepWithFile` and the text rewriting gone. Acceptance: adding a server by its
address, reviewing and accepting its tools, allowing a read on a shipped connection that then still follows banda's
version, a server that turns out to need no sign-in, two edits that cross refused by version, and removing it,
through the app; a kill at every commit of each under `test/fault/`.

**Slice 3, what is left of the file.** The box's folders and their naming to the model, the comparisons, a box's
change to a connection and its card, and agent-built connections and tools deleted; DESIGN.md, AGENTS.md and the
status doc rewritten where they name connection files. Acceptance: the property "nothing the box wrote is offered or
runs before the owner accepted it" is restated as "nothing the box writes reaches a definition" and passes; an
adversarial review of the three slices, since they touch what an agent may do.

**Slice 4, a connection's details, to check and to change.** What the owner is shown when adding a connection, its
tools and what it is allowed, is what they can open afterwards, for every connection, shipped or their own, from
Settings → Connections and from an agent's Access. Its body is PR #28's tool list: each tool in its group, its kind,
where the kind came from, and its setting, changed in place. Around it: each account with the access it was given,
changed by signing in again with other choices; the agents that use it, switched there; and what it draws as cards
and what following each does, which is new in the API, since the kinds and their rules never reach the app today.
The review on adding and the details afterwards are one component, so the two cannot say different things.
Acceptance: every connection of a forked home opens its details at both widths; a tool's setting, an access choice
and an agent's switch changed there hold at the next call; a kind's line says what following it wakes for and what
it only tells; every state in the specimen, light and dark. It is built after slices 1 and 2, so what it changes is
the store's from the first day.

Pre-release rules apply: stored shapes change in place, with no migration, and a home made by an earlier build need
not open.

## Still to settle

- [x] What a watch does at the first look after its object's definition changed version: it stays live, takes no
  reading made under the version before, reads again and wakes on nothing (test/watches.test.ts)
- [x] "A tool the server adds later waits switched off": pinned, and for a shipped connection it now holds across
  versions (test/connections.test.ts)
- [x] A tool waiting off comes on when a later definition names it: `off[tool]` says `waiting` or `owner`, the owner's
  own off stays and the owner switching a waiting tool settles it (test/connections.test.ts)
- [x] The owner allows a read on a shipped connection (`trustReads`): an overlay in the store, kept by name across
  versions, never over a floor or a write the definition names (test/connections.test.ts); the app offers it only on
  a server added by address until slice 4's details view

## Open work

- [ ] Slice 1, built on the branch and waiting on its acceptance through the app: the schema, shipped `.json` read at
  start, the version, "on" in the store, Add as a switch, no Update
- [ ] Slice 2, built on the branch and waiting on its acceptance through the app: a server added by address as a
  record with a version counter (one path adds it, discovery and sign-in in commits), the owner's accepted reads as
  an overlay in the store; a due listing that fails is tried again on its own. Groups wait for slice 4 and PR #28's
  list; the frontmatter parser stays for what a box proposes until slice 3
- [ ] Slice 3: the box's folders, a box's change to a connection, and agent-built connections and tools deleted;
  DESIGN.md, AGENTS.md and the status doc rewritten
- [ ] Slice 4: a connection's details, to check and to change, on the tool list taken from PR #28
- [ ] Slack's reaction permission, which binds a channel, becomes a `place` grain when grains land with the rework of PR #28
- [ ] Revisit connections and tools an owner or an agent defines themselves. They are out of scope here and their
  code goes in slice 3; DESIGN.md "Open" keeps the line. A file an agent writes and the owner accepts is the shape to
  start from, beside the shipped definitions, passing the same schema
