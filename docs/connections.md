# Connections

Priority: **High**. Implementation status lives in [Status](status.md).

Stored drafts, permissions and attempt admission use transactions. Credentials belong to accounts, never to the box;
GitHub ships as a file with its reads, scopes and object definitions. DESIGN.md "Connections" defines accounts, one
connect flow and daemon-read objects. Agent-built connections and `propose_connection` are out of scope.

Entry points: ../src/core/connections.ts, ../src/core/mcp.ts, ../src/core/mcp-remote.ts, ../src/core/oauth.ts,
../src/server/capabilities.ts, ../shipped/connections/github.md and ../scripts/shipped-github.ts.

## Work and acceptance

**Accounts.** Credentials per account under `auth/connections/<connection>/<account>/`, the id read once after sign-in
(the file's `account: tool.field`). Settings lists every account (sign in another, sign out, which agents use
it); agent settings has one switch per account, in effect at once; the `account` parameter is added to a connection's
tools only when the agent has more than one; drafts and permissions bind one account; signing out ends everything
on it.

**One flow.** "Connect GitHub" as one card, from agent settings, Settings or the agent's chat: the code shown while the
site opens, done when the daemon sees the grant, the account on for that agent. OAuth with PKCE where a server
registers clients. Reads run free; a write is a draft; the floor asks every time.

**Objects.** `objects:` in the connection file (and its generator for GitHub): for each kind the URL and id shapes, the
read that fetches it, the fields the card shows and the writes that act on it. A readings doc in the store, bounded,
by (connection, account, object), with its time. Links in agent messages unfurl to cards, few per message, never retried
in a loop; owner references stay compact inside their words (service icon, object-type icon, linked title), without
metadata or another card.
A draft on an object shows it. GitHub first: pull request, issue, Actions job, and notification as its subject.
PR cards summarize checks; arbitrary standalone Checks API IDs are not Actions job IDs. Missing or partial facts stay
unknown. Fake OAuth and MCP services cover automated tests and write approvals; manual app acceptance uses an isolated
home at desktop and phone widths. Real-account reads require the owner's authorization; real writes use a disposable
account. The specimen includes long metadata, reading details and interrupted approvals.

Bind remote descriptions and schemas to the accepted definition so a relisting cannot change prompt authority; verify
effect authority at every call start and retry, idempotent replay after revocation included; verify OAuth refresh,
interrupted sign-in, disconnect, tool switches and tools a server adds later.

## Open work

- [x] Accounts: credentials, Settings, switches, the `account` parameter, bindings
- [x] The connect card by code and by redirect; the callback page for a failed sign-in is plain HTML
- [x] Agents using a real GitHub account, read-only in an isolated home
- [ ] Slice 8's owner review
- [ ] The `account` parameter is offered to every agent once one has two accounts of a connection: the registry has
  one schema per tool name; an agent with one account may leave it out
- [ ] A connection without `account:` numbers its sign-ins and cannot tell one already known
- [x] `objects:` and bounded account-bound readings; owner/agent/group unfurls; editable drafts on objects
- [x] GitHub PRs, issues, Actions jobs and notification subjects, generated with the tool table
- [x] Slice 9's final layout rechecks and full/deep qualification
- [x] Owner-inline references: desktop/phone app walkthrough, with agent cards unchanged
- [x] Owner-inline references: owner review
- [ ] Slice 9's owner acceptance
- [ ] Real notification-card acceptance with the hosted MCP server's required `notifications` scope
- [ ] Delete agent-built connections, `propose_connection`, extensions and agent-built tools
- [ ] Logos as shipped assets on every card, event and draft of a connection; initials as the fallback
- [ ] Drafts show hashes of referenced files: the first effect tool that refers to a box file stores it as a blob in its draft
- [ ] Approvals on the floor confirmed with a passkey (DESIGN.md "Open"); today a tap approves them
- [ ] Approved recipients: the "private" floor class is declared per tool; no list of recipients the owner approved yet
- [ ] Permissions for a task that ended are hidden, not pruned
- [ ] "Don't ask again today" ends at the browser's midnight; the daemon checks only that the end is within a week
- [ ] Each call is a session of its own; no server notifications, resources or prompts
- [ ] A server's notes reach the model as first listed; a disconnect forgets the listing
- [ ] Reads by argument are exact values only; a prefix waits for a spike of how a real server routes it
- [ ] The shipped file's `events` and the watch intake are deleted with the routines slice; they return with the watch design (DESIGN.md "Open")
- [ ] No built-in email or calendar yet: they follow GitHub as shipped connections
