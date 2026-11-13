# Work status

## Current work

General shows shared browser preparation, verified-download progress, safe failures and an explicit retry, separately
from running pages. Opening Settings leaves browser preparation lazy. Ordinary backend checks and desktop/phone
walkthroughs against throwaway daemons pass; independent review found no reproduced blocker. Exact packaged native
qualification, public asset delivery and owner review remain open.

Replacement-sign-in authority is implemented for connection drafts and reusable permissions. Ordinary tests and
desktop/phone browser walkthroughs against a throwaway daemon pass; independent review findings are fixed. CI-only
replacement publication and replay fault scenarios are authored but unrun. Owner acceptance remains open.

Agent-definition publication is integrated into the native-computer candidate. Owner saves compare
their accepted base inside the commit, keep publication intent with the accepted bytes, and preserve competing
workspace versions. The app retains stale personality drafts and exposes saved and workspace history. Native
insertion-race and open-descriptor checks pass. CI fault qualification, the hands-on desktop/phone walkthrough and
owner acceptance remain open. Combined ordinary checks, types, build and contrast pass. Artifact, routine, watch and memory
publication remain in [Workspace](workspace.md).

Retained proxy requests now recover without another command, into a once-only owner approval or an explicit not-sent
resolution. Ordinary checks, typecheck, build and independent review pass after rebasing onto main. Native macOS ARM64
restart walkthroughs pass at desktop and phone widths. Owner acceptance remains open. CI-only receipt fault scenarios
are authored but unrun.

The bundled computer is in `prototype/microvm-box`. The macOS ARM64 candidate has packaged desktop/phone-width
walkthrough evidence, including lazy browser preparation, guarded sends and restart persistence. Linux x64 and
ARM64 packaging and adapter work is under local verification; a native KVM run remains before either is accepted.
Windows retains the existing backend while its native runtime boundaries are unresolved ([Operations](operations.md)).
macOS support requires Apple silicon; Intel Macs are no longer a release target. Public browser download delivery
and clean-machine distribution remain open.
Workspace refreshes come from tool completion and owner actions; startup and explicit reads reconcile missed
changes. Native Mac proxy and command-VM recovery have throwaway-home evidence, including concurrent homes;
full CI fault qualification, host sleep/wake and recovery preflight latency remain open.

Agent search is in review on `feat/agent-search`: messages, shared group histories and artifacts use the same
retrieval as Cmd+K, with bounded results and source reads. Recall now searches saved facts only. Validation and
owner acceptance remain pending; definition and attachment coverage is tracked in [Chat](chat.md). The local tool-access
preview has owner review: Connections, Permissions, Tools, toolset icons and highlighted schemas in Details. Its switches
remain local to the preview.

Google Calendar, Contacts and Drive join Gmail as built-in connections, from one registry of Google APIs
([Connections](connections.md)). Calendar reads events and free/busy and makes approved changes (create with guests
and a Meet link, change, answer, delete), each made once across a crash and from the event's current version;
Contacts finds saved people and people the owner has emailed; Drive finds files and reads Docs, every tab of a Sheet,
and Slides as text, and adds rows, writes cells and adds tabs to a Sheet as approved drafts, under a "Change your
spreadsheets" scope of its own; it reads a file's comments, adds text at the end of a Doc ("Change your documents")
and replies to a comment in the owner's name, each an approved draft. Access is per account: each account asks for its own scopes within what its file allows, and the required ones
are always asked. Connecting happens in one dialog, which ends by choosing the agents that use the account; a shipped
connection is on for the lead by default. An agent names objects in its prose as links that open their cards; cards
appear only when it shows them. Sends to third parties (Gmail's send, Calendar's create and change) ask every time.
The owner connected all four on a throwaway home and used them through the app; an adversarial review's findings are
fixed. Google's verification for restricted scopes (Gmail, Drive) and the owner's acceptance remain.

Provider accounts are on main: a model provider holds several accounts, each
named by the owner, added, renamed, used and signed out of in Settings → Model; the band thinks with one at a time, and
each account's usage is counted apart. Tests, static checks and a desktop/phone walkthrough in a throwaway home with
keys pass. A real second OAuth sign-in and a paid run on a second account remain, then owner review.

Gmail REST is implemented in a topic worktree with least-privilege sign-in, account-bound email cards and attachment
reads, approval-required sending and mailbox actions, and separate OAuth scopes for reading, sending and modifying
mail ([Connections](connections.md)). Redirect sign-in starts on the computer; paired devices can use accounts already
connected there. The public Google Desktop OAuth client id and client secret ship with the daemon; development can
override both through daemon environment variables.
GitHub and Gmail now open scope selection in a dialog, keeping permission details off the connection cards. Existing
accounts can change scopes and re-consent; the daemon replaces credentials for the same provider identity and preserves
its agent switches. Connection tiles use official provider marks/favicons where known, try the configured HTTPS MCP
origin's favicon for other servers, and fall back to the connection name. The desktop and phone walkthrough remains open.
The owner connected a real Gmail account and confirmed mail works through the app. Email previews render plain text and
fetch attachments only on request; the send approval previews and permits editing the recipient, subject and body, and
names each attached file with its size. The owner reviewed and approved the draft preview specimen. Approved send
attachments are SHA-256 checked again at execution, so bytes changed after approval are refused. Adapter, blob,
attachment, specimen and browser checks, static checks, typecheck and the production web build pass. The complete
desktop/phone walkthrough, real send and mailbox approval flows, adversarial review and acceptance remain. Google's
restricted-scope verification and publishing a public Desktop OAuth client remain external gates.

Harnesses are on the `feat/harness-acp` branch ([Connections](connections.md)): an agent hands coding work to a
coding agent on the owner's computer (Claude Code, Codex, pi through banda's own adapter, or one the owner adds),
connected once to the owner's code folder, each task in a project there; the session is live and steerable in the chat,
and only the harness's own asks reach the owner. Claude Code, Codex and pi each fixed a scratch repository through the
app in a throwaway home; an adversarial review was triaged and fixed; the harness fault sweep passes. The owner approved starts without an extra draft when enablement clearly explains host access and the harness's own
permissions. The continuation redesign, access revocation fixes and delegated header status passed independent review
and a desktop/phone app walkthrough in a throwaway home, including real Codex work and native resumption, concurrent
sessions, approvals and Stop. Integrated checks are complete; the owner authorized landing.

Remote access over Iroh is built, and the owner reviewed the app and the specimen: the daemon's Iroh
endpoint on n0's relays, devices paired by a QR code the owner approves in Settings → Devices (listed, renamed and
revoked there, never from a device), and an Android shell (`mobile/`) that pairs and opens the app as a device. Its
adversarial review's fix-now findings are fixed; each request a device makes is logged by its name; the full suite
passes. The phone's side was tried on the arm64
emulator against a throwaway daemon on n0; a real phone on cellular, iOS and push remain
([Operations](operations.md)).

Tool discovery is wired in draft PR #4 using pi-durable’s existing search and deferred tool loading.
The agent tool-access specimen is carried in the separate agent-search UI worktree; the owner requested that it
stay a specimen while they give feedback. Per-agent switches are not wired to the daemon. Full/deep verification
and owner review remain open ([Agents and groups](agents.md)).

Pre-release binaries are on the `desktop-release` branch ([Operations](operations.md)): an Electron desktop app that
starts or attaches to the daemon, a CLI archive that brings its own Node.js, and a release workflow that drafts an
unsigned pre-release from a `v*` tag. Both were packaged and tried on macOS arm64 against throwaway homes. The
workflow hasn't run on the other runners yet, and owner review is pending.

Scoped memory is implemented; the owner requested integration on main. Global and agent facts have scoped tools,
recall, model-boundary updates and app controls. Independent coding review, full/deep suites with Docker, build and
palette checks pass; the running app was exercised at both widths, including draft recovery. Broader workspace
concurrency and provenance work remains in [Memory](memory.md); this is not release qualification.
The Library and panel redesign is a separate slice.

Watches are in code on the `watches` branch, draft PR #24 ([Watches](watches.md)): a watch file in `watches/`, its
task that looks, diffs and wakes its agent's chat as a feed item ("<ref>: all checks green", the ref a link), the `watch`
tool's card, Follow on an object's card, the Watching list (Add a link, Check now, Pause, Stop) and the detail's
editor. Slices 1 to 3 (health, gaps, resume, authority, bursts, cadence, wakes a day) and every connection banda
ships: GitHub's pull requests, issues, jobs, notifications, repositories, discussions and workflow runs; Gmail's
emails, conversations and searches; Calendar's events; Drive's files and folders; contacts. A shipped connection's
definition is the one this banda ships, and it takes effect at its first start ([Connections](connections.md)). Followed for real in a forked home:
purrgrammer/banda#24's pushes and green checks, each seen on time. The fault sweeps over the new scenarios, the Google
kinds against real accounts, the phone pass of slices 2 and 3 and owner review remain open.

Slack is built on the `slack` branch, one PR on main in stages ([Slack](slack.md), [the plan](slack-plan.md)): a
built-in connection whose account is the owner in one Slack team, signed in by PKCE on the daemon's loopback with user
scopes only; threads, channels, searches and people as objects on the cards that exist, with faces; posting as the
owner on the floor, reacting as an approved draft whose permission covers a channel for the task; a thread and a
channel followed through a paged window under a per-account queue, a search and a person followed; files read through
the daemon into the chat's blobs. The spikes ran against the owner's team; each stage had an adversarial review. The
fault sweep in CI, `files:read` on the shipped app, the owner's UI pass over the specimen and the walkthrough at both
widths, and owner acceptance remain. On 2026-11-12 the owner said they had tried it live; which
walkthroughs, widths and accounts that covered is not recorded, so the plan's live lanes stay unchecked.

Bringing your own is in code ([Chat](chat.md)): at first run on the desktop, the skills and agents of Claude Code,
Codex and pi on this computer, in place of banda's skills, and again from Settings; the band's menu with Skills and a
dot while something waits. Unit and fault tests pass; the real desktop app on a fresh home, phone width and owner
review remain.

Settings → Model lists every model provider to connect, use or sign out of, so the band can switch providers after
first run ([Chat](chat.md)). Owner review is pending.

Skills are wired in a separate worktree: accepted shared SKILL.md files, read-only agent loads, explicit owner /name
loads at the pre-request boundary, linked chat lines and Activity results, and the shared catalogue and detail page.
Throwaway-daemon browser runs at desktop and phone width and skill fault sweeps pass. Other files are listed as box
data, not loaded instructions. Owner review remains open ([Chat](chat.md)).

Activity disclosure is wired in direct and group chats ([Chat](chat.md)): status → activity → full transcript,
scoped to the selected work. Desktop and phone fork walkthroughs and owner review are complete.

Avatar identities are implemented, including accepted faces, generation previews and install icons. The owner has
reviewed the avatar work; accepted-file publication still needs the concurrency and crash-safety work in
[Agents and groups](agents.md).

The 🏕️ banda identity, without a tagline, is staged in the specimen: branding, site header,
sidebar and first run. Owner review is pending before applying them to the app and install assets.

banda is a chat: a band of agents in a sidebar, one conversation each, groups, a panel, and no other screen, as
DESIGN.md says. The specimen ([Chat](chat.md) steps 0 to 4) is built and the app runs on it: slice 5 is in progress.

- 5a, the shell on the daemon's data, is in use: the band, routes, chats, groups, the panel's tabs, Settings,
  Connections, search, artifacts in the main pane, one event stream a page. Homes made by an earlier build are refused.
- 5b to 5h landed: the old pages, segment views and components are gone, and with them goals, hand-offs, side chats,
  proposals, memory's accepted core, skills, speak-up, the face's colour, the inbox, watch and extensions.
  `theme.css` stays until its tokens move to `tokens.css`.
- 5i landed in code: taint is gone, and browsing never asks unless it acts as the owner. Its adversarial review's
  findings are fixed (a signed-in site opens only as allowed for the task, its session never goes with another page's
  requests); a review of the fixes and the owner's review are pending; then slices 6 to 10.
- Slice 5's complete phone walkthrough remains open. A resizable browser is available; slice 9's chat/card flows
  have their own desktop and phone checks, not acceptance of every slice 5 workflow.
- Owner review of slice 5 is pending.
- Slice 8 (accounts and the connect flow) landed in code: accounts, per-agent switches, the connect card in Access,
  Settings, the Connections page and the chat. A real GitHub sign-in was approved and read as its account; an agent
  has used a real account with a model in an isolated home. Owner review pending.
- Slice 7, routines in the chat, landed in code ([Routines](routines.md)): wakes in the agent's chat, event and
  trouble lines, `job` renamed `routine`, the panel's editor. Owner review pending.
- Slice 9, connection objects ([Connections](connections.md)), is in owner review: account-bound cards in direct and
  group chats, object-only messages, and editable object-bound approvals. Adversarial findings are repaired. Real
  GitHub read-only PR/issue/Actions examples and isolated approval/failure flows have been tried at desktop and phone
  widths. Owner-requested layout polish, full/deep tests, build and contrast checks pass. Owner acceptance and
  real notification-card acceptance with the required scope remain open.

The inspirations studied for the surface: Grok Bot (the bot, not the conversation, as the core object; a roster
sidebar with a latest-message preview; one timeline where prose, events and cards share the transcript; the bot's
computer as a status icon, a pinned preview and a take-over; routines in a bot-specific list with their runs in the
transcript; groups of up to six; approvals as cards with Allow once, Deny and Always) and Meta's Muse (one long
conversation like a text thread; the agent's current activity in one line under its avatar, the full log and the
approved permissions a tap away; browsing allowed by default and irreversible actions checked in; artifacts in the
chat; a name, an avatar and a style the owner chooses; notifications only when something is meaningfully new).

Editing proposed text before accepting it (#53) is in review on `feat/issue-53-edit-proposals`: a pull request's
title and description (open, change, merge's commit title and message), an issue's title, an agent's proposed
description and instructions, and a proposed routine's schedule and ask, each a read block with a quiet Edit. Sends
held by the proxy and coding-agent asks stay as drafted. Walked through in the app against a daemon on a throwaway
home, at desktop and phone widths, light and dark (`test/edit-proposals-daemon.browser.test.ts`); owner review
remains.

## Existing implementation

| Area | Implementation baseline | What the slices do with it |
|---|---|---|
| Chat, message parts, feed lines, cards | Present | Kept; re-specified in the specimen, pages around them deleted |
| Agents, accepted files, tiers | Present; direct meta tools and owner-reviewed proposals restored in code | Proposals for agents, groups and limited existing-agent edits; legacy identity/preference proposals remain deleted |
| Groups | Present on this line | Kept; rows in the band, members in the panel |
| Agent meta tools | Direct agent messages, bounded direct-chat reads, agent-definition proposals and owner-reviewed group/existing-agent proposals are implemented in code; fault sweeps and responsive component checks pass | Throwaway-daemon walkthrough and owner acceptance remain open |
| Hand-offs, helpers, side chats, errands and tasks areas | Removed | Agent-to-agent messages are a narrow direct-chat tool; groups keep their existing mention behavior |
| Goals, Inbox, Library, Routines and Connections pages | Removed | Deleted; routines in the panel, connections in settings, artifacts in the chat |
| Routines, schedule | Present | Wake in the agent's chat as events |
| Watches, `follow` in an object kind, `watches.ts` | Present on the `watches` branch | Slices 1 to 3: a pull request or an issue followed until it ends; health, gaps, resume and authority; bursts, cadence and wakes a day; owner review pending ([Watches](watches.md)) |
| Skills, `skill` | Wired in a separate worktree, owner review pending | Accepted shared prompt files, owner and agent loads; supporting files remain data |
| Memory's accepted core, learned cards, `propose_preference`, `used` | Removed | Deleted; facts in effect at once |
| Connections, OAuth, GitHub by code, shipped definitions | Present, per-account credentials and object readings | Accounts; one connect flow; objects; a definition banda ships and a choice the store holds, never a workspace file |
| Drafts, permissions, activity, floor | Present | Kept; bound to an account |
| Taint | Removed | Deleted; browsing asks only as the owner (DESIGN.md "The browser", "Trust") |
| Extensions, agent-built tools and connections, `propose_connection` | Removed | Deleted (DESIGN.md "Open") |
| Avatar face and colour | Present | Accepted agent identity, generation preview and install icons; publication safety remains open |
| Speak-up, companion summary | Removed | Deleted |
| Box, proxy, browser per agent, artifacts, memory, compaction, provider setup | Present | Kept; a provider has accounts |

These baselines describe code presence, not completed owner acceptance or production readiness.

## Updating status

Keep only current state here: the active slice, remaining gates, owner review and next action. Work descriptions
and checkboxes live in their section files; update them there rather than adding another task list. Test evidence,
findings triage, decisions and caveats belong in commit messages and executable tests. Mark a slice accepted only
after the required checks and app use, followed by owner review. Detailed history remains in git.
