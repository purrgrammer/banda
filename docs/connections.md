# Connections

Priority: **High**. Implementation status lives in [Status](status.md).

Stored drafts, permissions and attempt admission use transactions. Credentials belong to accounts, never to the box;
GitHub ships as a file with its reads, scopes and object definitions. DESIGN.md "Connections" defines accounts, one
connect flow and daemon-read objects; DESIGN.md "Watches" follows an object through the same declaration, reading and
card. Agent-built connections and `propose_connection` are out of scope.

Gmail is a built-in daemon REST adapter: the accepted file declares scoped reads and approval-required writes, while
the adapter calls Gmail's API directly. Its public desktop OAuth client id and client secret ship with Banda; both can be
overridden with `BANDA_GOOGLE_CLIENT_ID` and `BANDA_GOOGLE_CLIENT_SECRET` for development. Desktop clients cannot keep
their secret confidential, and the flow still uses PKCE. The first sign-in asks for read-only access; send and mailbox changes have separate scope
choices and always use account-bound approval drafts. Email cards render sanitized plain text and retrieve attachments
through the daemon into the chat's blob store.

Entry points: ../src/core/connections.ts, ../src/core/mcp.ts, ../src/core/mcp-remote.ts, ../src/core/oauth.ts,
../src/core/gmail-rest.ts, ../src/server/capabilities.ts, ../shipped/connections/ and
../scripts/shipped-github.ts. Harnesses:
../src/core/acp.ts, ../src/core/harness.ts, ../src/core/harness-files.ts, ../src/server/routes/harnesses.ts,
../shipped/harnesses/, ../web/src/chat/Harness.tsx and ../web/src/app/HarnessSession.tsx.

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

**Followed objects.** A kind that can be followed says how in its own `objects:` entry, beside `reads`, `fields` and
`writes`: the further reads a following needs, how each list is keyed, what is noise, whose items are the account's
own, derived conditions, the rules that wake or only tell with the words each is said in, what ends it and when it is
busy; the generator writes GitHub's for pull requests and issues. One reading per (connection, account, object) serves
the card and every watch on it, kept fresh while one holds it. The card offers Follow among its quiet actions; a
followed card says who follows it and until what; the event line says the change in the kind's words over the reading,
never the model's, with the object's card beneath. The watch itself (its file, task, health and the panel's Watching
list) is the watches slice; this section owns the object side.

Bind remote descriptions and schemas to the accepted definition so a relisting cannot change prompt authority; verify
effect authority at every call start and retry, idempotent replay after revocation included; verify OAuth refresh,
interrupted sign-in, disconnect, tool switches and tools a server adds later.

**Harnesses.** Any ACP agent, shipped as a file or added by its command line, connected in a folder per agent; one
tool starts a session without a draft; the harness's asks, the owner's notes and Stop in the chat; the agent woken once
at the end. A fake ACP harness (test/fixtures/fake-acp-agent.ts) stands in for the real ones in tests; the session
runs under test/harness.faults.test.ts (a kill at every commit and harness boundary). Real runs use a scratch repository
in a throwaway home, at desktop and phone width.

## Open work

- [x] Accounts: credentials, Settings, switches, the `account` parameter, bindings
- [x] The connect card by code and by redirect; the callback page for a failed sign-in is plain HTML
- [x] GitHub and Gmail scope choices live in a dialog; the card stays compact while the owner changes scopes and re-consents
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
- [ ] Following in each followable kind's `objects:` entry, generated for GitHub's pull request and issue; a kind
  without it cannot be followed and the card says so
- [ ] One reading per (connection, account, object), kept fresh while a watch holds it, drawn by the card and read by
  every watch on it; "as of" only when the daemon cannot look
- [ ] Follow among the card's quiet actions; a followed card's line (who, until what); the followed states (following,
  done, can't reach) in the specimen, light and dark, both widths
- [ ] The event line's words from the kind's rules over the reading, the object card beneath, in the specimen
- [ ] A feed with a cursor (mail's history id) and a service's own subscription with its renewal, declared as data;
  GitHub has neither, so they wait for the mail connection
- [x] Gmail REST: OAuth sign-in, profile, labels, search, message and thread reads; account-bound email objects and cards
- [x] Gmail chat connection action: on the running throwaway app, Connect Gmail changed to Open Gmail / Waiting for Gmail; this verifies the chat action starts OAuth
- [x] Gmail OAuth callback and account grant: the owner connected a real Google account and verified Gmail reads through the app
- [ ] Gmail: complete the app walkthrough at desktop and phone widths, including the connection success toast and compact card; owner acceptance
- [x] Gmail reads: bounded page tokens and canonical `gmail/<id>` references from search and thread reads; Banda email cards are the canonical view
- [x] Gmail hardening: text attachment parts stay out of message bodies; long Unicode subjects use folded RFC 2047 words; redirect OAuth sign-in starts on the computer and connected accounts remain usable on paired devices
- [ ] Gmail reads: try search pagination and thread cards through the running app; owner acceptance
- [x] Gmail attachments: list metadata and retrieve bounded bytes through the daemon; never render HTML or expose credentials to the box
- [x] Gmail send: show recipient, subject, body and held attachments in the existing approval draft; send only the approved content and account
- [x] Gmail mailbox actions: archive, trash, read/unread and label changes as individually named, account-bound approvals
- [ ] Gmail onboarding: Google OAuth verification and production publication for restricted/sensitive scopes remain external; the public client id ships with the adapter, least-privilege scope bundles and re-consent are wired
- [ ] Gmail hardening: pagination limits, revoked/expired grants, and approved attachment content-hash verification are covered; bounded retry behavior, additional write/attachment fault coverage and review remain
- [ ] Gmail: adversarial review and owner walkthrough of every shipped slice, including a throwaway account for send and mailbox changes
- [ ] Google Calendar: reads (profile, calendars, events, one event, free/busy), `calendar/<id>` event cards, and approved writes (create with guests and a Meet link, change, answer, delete; `calendar.events` added by choice; made once across a crash by an event id from the effect's key) are in; a watch feed for changed events, recurring-event changes (this one or all), a real sign-in with the Calendar API enabled on the shipped client, and the owner walkthrough at desktop and phone widths remain
- [ ] Google Contacts: reads (profile, search contacts and other contacts, one person) and `contacts/<id>` contact cards are in; a real sign-in with the People API enabled on the shipped client (confirming people/me shares the address under userinfo.email), an agent resolving "email Ana" end to end, and the owner walkthrough at desktop and phone widths remain
- [ ] Google Calendar: reads (profile, calendars, events, one event, free/busy) and `calendar/<id>` event cards are in; writes (create, RSVP, update), a watch feed for changed events, a real sign-in with the Calendar API enabled on the shipped client, and the owner walkthrough at desktop and phone widths remain
- [ ] Google Drive: reads (profile, search, one file, a file's text: Docs as Markdown, a Sheet's first sheet as CSV, Slides and text files as text, bounded) and `drive/<id>` file cards are in; a real sign-in with the Drive API enabled on the shipped client, the owner walkthrough at desktop and phone widths, and Google's security assessment before publishing beyond test users (drive.readonly is a restricted scope) remain
- [ ] Files: Drive and Docs adapters with scoped reads, rich file objects/previews, and approval-backed writes; no Google Workspace MCP token store
- [x] Harnesses: ACP client, sessions, asks, notes, Stop, the wake; shipped files, banda's adapters and the owner's own; the fault sweep (detached commands included)
- [x] Harnesses: Claude Code, Codex and pi each fixed a scratch repository through the app; Claude Code's background command was killed with its session
- [x] Harnesses: an adversarial review (store growth, the home as a project, Stop before open, several asks, detached commands, blind asks) triaged and fixed
- [x] Harnesses: desktop and phone app walkthrough of delegated status, concurrent sessions, approvals and Stop
- [x] Harnesses: starts need no extra draft; enablement states host access and the harness's own permissions
- [x] Harnesses: continuation and revocation regressions, native versus summary mode disclosure, real Codex native resumption through the app; owner authorized landing after final checks
- [x] Harnesses: the session card, asks and steps sheet in the owner's words (DESIGN.md "Harnesses"): humanized step
  lines, project name on the card, state in words and announced, folded steps sheet that follows the end, one ask
  whole at a time with kind verbs and bounded "Show all", quiet ask notification; verified in the real app against a
  throwaway daemon at desktop and phone width, with axe clean on every screen
- [ ] Harnesses: Windows process supervision before offering execution on Windows
- [ ] Harnesses: Gemini CLI, OpenCode, Cursor and Goose are not shipped: each failed or was missing here; they need a spike and a sign-in each
- [ ] Harnesses: their asks reach the owner only in the web app, not on other gateways; the agent still hears the end
- [ ] Harnesses: a step may flicker between flushes (a note the harness has not taken yet); sessions are keyed by the model's call id, as artifacts and groups are
- [ ] Harnesses: the adapters are not in a release (Claude Code's SDK is Anthropic's, all rights reserved); Connections says how to install them
