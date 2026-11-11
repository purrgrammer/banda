# The chat

Priority: **Highest**. Implementation status lives in [Status](status.md).

The app is three surfaces (DESIGN.md "The app"): the sidebar, the chat and its panel, with settings as sheets or plain
pages. It is built specimen first: the design language is revamped and every screen and card exists as static UI with
fixture data, reviewed by the owner at desktop and phone width in light and dark, before the daemon is wired behind
it. Components the design does not name are deleted, not kept; the specimen is rebuilt from scratch and the old one
goes with them. Each slice, once wired, is end to end: its tests, its fault points where it is durable, a manual run
against a throwaway home, and the owner's review before the next.

Entry points: ../web/src/App.tsx, ../web/src/components/AppShell.tsx, ../web/src/routes/Chat.tsx,
../web/src/routes/Specimen.tsx, ../web/src/specimen/, ../web/src/components/ and ../web/src/styles/theme.css.

## The specimen, in order

Each step is reviewed in the browser before the next. Estimates are for an agent doing the work.

0. **The name** (half a day). banda in the package, the CLI, the home (`~/.banda`, `BANDA_HOME`), the app's header,
   the manifest and every doc.
1. **Foundation** (1 to 2 days). A new `theme.css`: neutrals at chroma 0, an ink-filled primary, one accent for alive
   alone, one error red, the face palette gone; the type scale, radii, motion, both themes through the contrast audit.
   The emoji at 96, 64, 40 and 24px with its states (working, waiting on the owner, routines paused) and the group's
   stacked emojis. The primitives kept from `ui/` (button, input, textarea, switch, sheet, drawer, dropdown, popover,
   tooltip, command, skeleton, avatar, emoji picker, sonner) restyled on the tokens; every other `ui/` file deleted.
   Copy rules shown as specimens: an error (who, what, the fix), an empty state, offline, the computer starting.
2. **The band and the chat** (3 days). Sidebar rows: agent, group, unread (bold name, ink excerpt, ink count), an open
   ask ("Waiting: …"), working, paused, the collapsed rail, the empty band, search and its results. The chat: header
   with the working line; bubbles grouped with the emoji and name (phone: emoji only); day separators; the unread
   divider; jump to latest; every part (text, image, PDF, document, sheet, code, audio, video, artifact, view, question,
   object, reaction, sign-in); the approval card (the verb, Don't, one scope row; on an object; editable); the change
   card (the text in full, What it was); every event line (a routine's run, a failure, a change to accept, a sign-in to
   finish); the "waiting on you" pill; Try again on a failed send; the transcript view. The composer: `prompt-input`
   with attachment previews, the menu, mentions in a group ("To everyone · @ to pick one"; a mention as the emoji
   and name, a link). First run: the first agent's screen with the providers to pick from; the first words and starters.
   A group chat with members' messages and a member's ask.
3. **The panel, settings and connections** (2 to 3 days). The agent's panel: its face and name over
   four tabs (Routines with Routines on and Add, its empty state, a routine's editor, Access with the connections'
   rows and switches, then the standing permissions; Memory; About with the personality and its placeholder,
   thinking and model, archive); a group's panel, its members. The browser enlarged (take-over, hand-back
   unconfirmed, landscape on the phone); the open file or artifact (PDF paged, image, text, a sheet as a table,
   versions and restore). The Connections page, a tile per service. The new agent sheet with three personality starters;
   Settings. The connect card in every state (Connect; code with Copy and
   Open; signed in; failed with Try again; already connected; "Let Mara use GitHub as @bandarra?"). GitHub's four
   objects (pull request, issue, check run, notification as its subject) in every state, with a draft on each. Empty
   and loading states wherever the app waits on the daemon or can have nothing yet.
4. **The phone pass and the owner's review** (1 day). Every screen at 390px, sheets, the keyboard; light and dark;
   reduced motion. The owner walks the specimen as a person would; what fails is fixed before wiring starts.

## Wiring, in order

5. **The shell** (4 to 5 days, mostly deletion), one commit per step, each green:
   - 5a. The new shell on the daemon's data: the band (rows with excerpt, "You:", the open ask, unread for groups
     too), routes (`#/` the last chat, `#/a/<id>`, `#/g/<id>`, `#/settings`, `#/connections`, `#/specimen`), the chat
     (header, feed, cards, approvals, working, composer, the unread divider from the read cursor, backward paging),
     search over messages, group logs and artifacts (titles and text) with jump to message, the pill, the tab's
     count (asks first), the local notification for an open ask (a line in the chat the first time, a switch in
     Settings). The panel shows About and Memory until its data lands (Routines in 7, Access in 8). Side chats are
     hidden. Homes made by an earlier build are refused with a plain message.
   - 5b. Delete the old web: the Inbox, Goals, Routines, Library and Connections pages, `web/src/areas/`,
     `web/src/sheet/`, `web/src/lib/segments/`, `theme.css` and every component the specimen did not keep.
   - 5c to 5h. Delete from core, server, tools and tests, a group each: goals; hand-offs, helpers, errands, tasks and
     side chats; proposals of agents, groups, identity and preferences; memory's accepted core and `used`; skills,
     speak-up, the companion summary (the first agent is an ordinary agent) and the face's colour; the inbox; watch,
     extensions and the Library's route (artifacts stay). No migrations: stored shapes change in place.
   - 5i. Delete taint, with an adversarial review that what it blocked stays bounded by permissions and drafts.
     Done in code: browsing never asks unless it acts as the owner (navigate, typing and a page's writes run at once
     acting as nobody; opening a signed-in site asks, for once or the task; typing and writes there, or with a
     credential, are drafts on the floor). The review's findings are fixed; a review of the fixes is pending.
6. **The panel and settings** (2 days). The agent's panel and its four tabs and the tab it opens on, Routines on; the group's panel; the new
   agent sheet; Settings; first run and the first words; the owner's edits in effect at once.
7. **Routines in the chat** ([Routines](routines.md), 2 days).
8. **Accounts and the connect flow** ([Connections](connections.md), 2 to 3 days).
9. **Objects** ([Connections](connections.md), 3 to 4 days).
10. **Files and polish** (2 to 3 days). Previews drawn by the daemon (a PDF's first page, a sheet's rows, code
    colouring) and the panel's viewers; copy a message, Try again, the composer's surviving draft, keyboard shortcuts;
    PWA icons from the emoji; accessible states, responsive overflow, recoverable failures, the same trust boundaries
    in the inline browser, the enlarged browser, approvals and previews.

About five weeks of agent work in all; slices 8 and 9 can run beside 6 and 7 once 5 has landed.

## Open work

- [ ] Owner review of the wired shared skills slice: /name autocomplete, a compact linked load item in direct and group chat, the accepted skill result in Activity, a detail page with metadata and box-data file names, the shared catalogue in About, and owner save/accept of SKILL.md. The read-only skill tool and owner-directed pre-request load run against accepted bytes; an earlier busy request cannot see the load before its owner input. Desktop and phone throwaway-daemon runs and the skill admission fault sweep pass. Supporting files remain data, not accepted instructions; their names are shown but their bytes are not loaded by `skill`. Owner acceptance remains open.

- [x] Owner review of live activity disclosure: direct and group chats now open a readable timeline from the status or a quiet message action beside Copy; any item opens the full streaming transcript in the same sheet. Historical prompt/tool declarations, unused tools, arguments, results, provider-exposed thinking and errors come from daemon records. There is no device-wide transcript mode. Desktop and 320px/390px fork walkthroughs and live/group browser checks are in place. `#/specimen/activity` remains the interactive fixture; `#/specimen/activity/recorded` reads an opt-in private fork snapshot through `BANDA_ACTIVITY_FIXTURE`, never bundled.

- [ ] Bringing your own (DESIGN.md "Bringing your own"): in the desktop app, first run offers the skills and agents of
  Claude Code, Codex and pi on this computer in place of banda's skills (harnesses picked, a preview of what comes,
  any of it left behind; nothing brought goes on to banda's skills), and Settings → Agents offers it any time; each
  harness says how to connect it over ACP. The band's menu (Skills, Connections, Settings) replaces the footer's
  links, with a dot while a skill or connection waits on the owner. In code with unit and fault tests, tried on a
  fork with the desktop bridge stubbed; the real desktop app on a fresh home, the menu at phone width and owner
  review remain

- [ ] Model providers in Settings: every provider listed to connect (sign-in or key), use or sign out of; signing out
  of the one in use moves the band to another still connected. In code with tests; owner review pending

- [ ] Review the 🏕️ branding specimen, then apply the identity to the app, site metadata and install icons

- [ ] Steps 0 to 4, the specimen
- [ ] Slices 5 to 10, the wiring
- [x] Syntax colouring of replies' and files' code (a Shiki plugin; tokens join the palette)
- [x] The manifest's install icons drawn from the first agent's emoji (an SVG; the iOS touch icon stays the PNG, as nothing here draws an emoji to PNG)
- [ ] Voice in the composer, decided before promising complete behaviour (DESIGN.md "Open")
- [ ] Agents that say too much or the same thing twice: watched in every slice's app use, fixed at the prompt or the tool's result that caused it
- [x] "Try again" on a message that was not delivered and on an agent that did not answer (a failed reply has it)
- [ ] A PDF's pages drawn as pictures: the daemon reads its page count, title and first page's words, never rasterizes it (no renderer that is not code to trust); the viewer is not paged
- [ ] Slice 10 tried at phone width: the browser used for app runs cannot be narrowed
- [ ] An approval with the owner's signed-in session reads as what it does ("Send this form on amazon.es as you?"), never a raw address as its title
- [x] Editing a routine from its row in the panel (slice 7)
- [ ] The panel's tab when switching agents: the one that fits what happens in that chat
- [ ] A page handed over that the owner cannot get through in the agent's browser (a bot check that keeps checking) offers "Open in your browser": the same address in the owner's own browser
- [ ] Long chats: "Earlier messages" and opening at a search hit, tried on a chat of hundreds of entries
- [ ] Stop has no control in the app: a chat's or a group's run stops only through the daemon (`POST /chats/<chat>/stop`, `POST /groups/<room>/stop`), the browser's Stop or archiving; the owner decides whether and where it returns

## Search tools

Agents use the same retrieval path as Cmd+K for direct messages, shared group logs and artifact titles/latest text.
Source links show an icon for their kind; explicit labels are preserved, and empty labels resolve to the source
name or a bounded message excerpt. Unavailable sources retain a generic, usable link.
`search` returns bounded excerpts, source references, app links and a continuation cursor; `read_search_result` reads
bounded source context. Recall stays memory-only. Hidden execution chats are excluded before ranking and limiting.
The text coverage of an artifact is its first 200 KB; binary contents, workspace files and live services are outside
this slice. Source changes can change pagination; restart the query for a fresh traversal.

- [ ] Extend shared search to agent/group names and routine/watch definitions, after this slice's owner review
- [ ] Search attachment contents and workspace files only through an explicit indexing and access mechanism

The tool-access specimen (`#/specimen/toolsets`) is a local proposal: Connections, Permissions, then Tools, with
icons, per-tool descriptions and syntax-highlighted input schemas. Built-in schemas are generated from registrations
by `node scripts/specimen-tools.ts`; live connection schemas are not fabricated. Its switches do not change daemon
settings. Owner review of this layout is complete; wiring tool access is a separate slice.
