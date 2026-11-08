# banda: design

banda is a band of agents the owner runs on their own machine, the bots that get things done for them. Each agent is an
face and a name, with one conversation that never ends, a personality in the owner's words, the connections it may use
and the routines and watches it keeps; the owner talks to each directly, or to several at once in a group. They
research, write, keep track of things and work with the owner's services in a computer of their own, keep working while
the owner is away, wake on schedules and on what they follow, and ask before anything consequential leaves their
computer. Everything an agent does, finds, asks or makes appears in its conversation, as a message or as a rich object
the owner acts on in place.
There is no other screen. The owner works with the band through one app, on the web, as an installed app on the phone
and on the desktop. All state lives in one store on the owner's machine. This file holds the ideas and the rules; the
code holds the details. If a sentence here only restates code, delete it.

## Pillars
1. **Sovereign.** The owner's machine holds the only copy that matters: the store, the blobs, the workspace. Nothing
   needs a vendor to keep working, and nothing is lost when one goes away. The model provider is a named, swappable
   choice, local models included.
2. **Private by structure.** Credentials never enter the computer where the agent's code runs. Boundaries are what is
   mounted, what is reachable and which process runs what, never an instruction in a prompt.
3. **Safe by consequence.** The owner is asked only about what cannot be undone or what sends data out, shown as the
   exact thing that will happen, once. Everything else runs freely inside the box.
4. **Durable.** Every promise the agent makes is a stored wait, routine or watch, never something the model has to
   remember. A crash, a restart or a week offline loses nothing and does nothing twice.
5. **Just a chat.** The owner sees agents and their conversations, never Docker, YAML, diffs, tool traces or ids. As
   agents take on more, the app asks less of the owner: no screen to supervise, no list to manage. The raw transcript
   exists behind activity disclosure, for whoever wants it.

## Bets
1. **The agent is the object; the chat is its surface.** Every agent has one chat, its identity, personality, memory,
   connections, routines and watches, and the owner talks to it directly. The owner never manages threads: a routine's
   run, an ask and a result all land in the agent's one conversation.
2. **What the agent is made of is files.** Agents, connections, routines, watches and memory are plain text files in the
   workspace, inspectable and editable by the owner or an agent. The store holds what runs and what is in effect, never
   a second copy of a definition.
3. **An agent speaks only through its speaking tools.** The only way to reach the owner is a speaking tool, one per
   act: `message_user` for words, `ask_user`, `react`, `publish`, …; in a group, `message_group` posts the words to its
   room in `message_user`'s place. Proactive
   work with nothing worth saying says nothing, so the agent works in the background like a colleague, not a chatbot;
   but the owner who wrote is always answered, which the daemon enforces rather than trusting the model to.
4. **Silence is the default.** Proactive work runs often and speaks rarely: a run decides whether anything is worth a
   message, and most say nothing. What a routine finds is a message in its agent's chat, which becomes unread; only
   work that needs the owner interrupts.
5. **The form of a reply is part of the answer.** A thing the app knows (a pull request, a draft, a question, a
   routine's run, a file) is a card the owner acts on in place; prose where prose fits. Connections ship curated, with
   their objects drawn by the daemon, so the first one works out of the box.
6. **One durable store.** pi-durable owns conversations, tasks and documents. Nothing else is a source of truth.

## Words
agent, band, group, chat, turn, queue, message, part, tool, wait, draft, permission, routine, watch, event, connection,
account, object, harness, session, artifact, memory, box, workspace, gateway, inference, device. One word per thing, in code, docs and
the UI.
The words the rules lean on:
- **band**: the owner's agents, as the sidebar lists them.
- **origin**: where a message came from (gateway, peer, thread); **replyTo**: the origin a Turn's messages and asks go
  to.
- **ask**: what a Wait shows the owner (a choice, a form, text); an **approval** is an ask whether an effect may run; a
  **draft** is the effect it shows, stored whole.
- **permission**: a stored, scoped approval the owner gave (once, for a task, for a time, always), within the floor.
- **group**: a chat with several agents as equal participants; its shared message history is the context they receive.
- **routine**: a file in `routines/` that wakes its agent on a timer.
- **watch**: a file in `watches/` that wakes its agent when an object in a connection changes, until what ends it.
- **event**: a routine's or a watch's wake as the chat shows it: what fired or what changed, and when, before the
  agent's reply.
- **connection**: a service the band can work with (GitHub, mail, a calendar); an **account** is one sign-in to it
  ("GitHub · @bandarra"), and a connection may have several.
- **harness**: a coding agent on the owner's computer that the band hands work to over ACP (Claude Code, Codex, pi); a
  connection whose account is the owner's code folder. A **session** is one piece of work a harness does, from the
  agent's ask to its end.
- **object**: a thing in a connection the owner recognises (a pull request, an issue, a check run), drawn as a card.
- **artifact**: a work product the agent made (a document, a table, a page), shown beside the chat and versioned in
  the store.
- **notice**: an entry telling the owner something went wrong, such as a message that was not delivered.
- **attachment**: a file a message carries, in either direction; **blob**: its bytes, stored once by their sha256.
- **inference**: one bounded model request outside any chat, on a tier's model, whose answer the app reads on the spot
  (a face from a description); nothing is stored and no tool runs. Work that uses tools, answers to a chat or must
  survive a restart is a turn.
- **device**: a phone (or another computer) the owner paired, known by its Iroh endpoint id; it reaches the daemon
  from anywhere and acts as the owner.

## Core
| Primitive | What it is |
|---|---|
| **Agent** | `agents/<name>.md` in the workspace: identity, model and personality; one chat, its memory, its connections' accounts, its routines and its watches |
| **Group** | one shared message history and one hidden execution chat for each participating agent |
| **Chat** | a conversation running one agent; a group presents its shared history as one chat |
| **Queue** | a chat's inputs waiting for a run (pi-durable's inbox): the owner steers, everything else follows up |
| **Turn** | a task per input: submits it, waits for the run to settle |
| **Message** | what a speaking tool sends to the Turn's `replyTo`: parts, at-least-once, in order per origin |
| **Wait** | a task a tool call blocks on, with an answer slot the owner fills: `ask`, `deadline` |
| **Draft** | an effect leaving the box, stored whole and shown for approval; approved, it runs exactly as stored, once |
| **Permission** | a stored approval with a scope; an effect within an open permission runs without asking |
| **Routine** | `routines/<name>.md` in the workspace: when it runs (a timer) and what it asks; its task submits those inputs to its agent's chat |
| **Watch** | `watches/<name>.md` in the workspace: the object it follows, the account it looks with, what ends it and what matters; its task keeps the reading and submits each change to its agent's chat |
| **Connection** | `connections/<name>.md`, shipped with the app: a service's tools, which only read, and its objects; its accounts' credentials stay with the daemon |
| **Harness** | `shipped/harnesses/<name>.md`, or a command line the owner gave: an ACP agent on the owner's computer (or banda's own adapter around one that speaks something else), connected in the owner's code folder, for the agents the owner turns it on for |
| **Object** | the daemon's rendering of one thing in a connection, read with an account's credentials for the owner's eyes |
| **Gateway** | where the owner reaches the band: the app and the CLI |

## The app
The app is the owner's only way to work with the band, and one codebase serves every place: the daemon serves it on
loopback, it installs as a PWA on the phone and desktop, and the desktop app is a shell around it: it starts the
home's daemon or attaches to the one running, keeps it running when its window closes, and stops it on Quit. It is
built around what the agent does, not around what the model emits. It has three surfaces: the sidebar, the chat and
the chat's panel.
Settings are sheets or plain pages reached from them. Nothing else. A feature joins only if it helps the owner delegate;
one that gives them one more thing to manage stays out.

- **First run meets an agent.** The first screen is the first agent's face, its name and one line, then the providers
  to pick from, each a row with its logo and name; the one picked signs the owner in, or takes a key where it has no
  sign-in. One screen, no other step. A credential found outside banda (an ANTHROPIC_API_KEY around the daemon) is
  named by where it came from wherever providers show, never passes for one connected here, and can be connected
  over; first run stays until the owner picks it, so a key they never saw is never what the band silently thinks with.
  Then the chat opens with the agent's first words (who it is and what to try) and
  complete, broadly useful requests a tap sends as written, none needing a connection; every new agent's chat starts
  so, and the first words stay at the chat's beginning (the starters go once the owner has written).
  Returning owners open straight into their last chat. While the box starts, the chat says so in a line ("Mara's
  computer is starting…"), never only a footer notice. If a provider later fails, the chat says who, what and the fix
  ("Mara can't answer: your Anthropic sign-in expired · Sign in again").
- **The sidebar** is the band: one row per agent and one per group, and nothing else. A row is the agent's face
  (40px) or the group's faces (two overlapping; more, a count), its name, one line of its last message ("You: " when
  the owner wrote it), the time at the right and an unread count. Rows order by the latest message. Pinned agents and
  groups sit above the rows as tiles of one size, three to a row and scrolling sideways past that; a tile shows what it
  wants of the owner at its face's foot, the unread count or a dot while it waits, and is pinned from its own corner
  (on the phone, by a long press). Unread rows get a
  bold name, an ink excerpt and an ink count on a neutral pill; read rows are muted. When an ask is open in a chat,
  its excerpt reads the ask in ink ("Waiting: send the email to Ana?"), a dot marks its face, and
  the tab's title counts asks before unread; on the desktop an open ask also fires a local notification, which needs
  no vendor, while a routine's message only badges. A harness's ask notifies with the harness and the kind of thing asked, never the
  command, the path or the project's name, any of which would sit in a banner on a lock screen. The agent's face moves while it works, a dot marks it while it waits
  on the owner, and it dims while its routines are paused. The header
  holds the app's name, search (Cmd/Ctrl+K: with nothing typed, the band's rows, a switcher; typed, agents, skills and
  pages found in the app, then the chats' messages, each opening its chat scrolled to it) and a quiet
  "+" for a new agent or group, and one menu: Skills, Connections, Settings. A dot on the menu, and on its item, says
  something there waits on the owner, and the page it opens says what: a skill the box added or changed, to review; a
  connection not reached, or an account to sign in to again. A skill the box removed has nothing to allow, and a
  connection's change is answered in the chat, so neither lights it: the dot never cries wolf. The footer holds only the
  daemon's notices. Collapsed, the rail shows faces alone, the menu below them.
- **The chat** is one timeline where the owner's words, the agent's messages, events and cards share the transcript. The
  header (48px) is the agent's face and name and, under it, its presence in a word or two (working, waiting on you,
  routines paused): what it does is said once, at the foot; tapping the name opens the panel on the phone and toggles it on the desktop. The owner's messages sit on
  the right in ink-filled bubbles, the agent's on the left as bubbles, its face and name above each run of consecutive
  messages (on the phone the face alone, the name once at the top); day separators; an unread divider where the owner
  last read; "jump to latest" when scrolled up; times on hover or tap; paged backwards from any point, so a search
  result or a card from last month opens in place. A chat is read when its newest message was on screen with the window
  focused, and the row updates then. Each part of a message is its own affordance: text; files (below); a **question**
  as a card with its choices or form and a way to dismiss it, an answer typed in the composer appearing as the owner's
  words beneath it; a **draft** as the approval card (below); a **view** of the browser, live, with take-over; an
  **artifact** card that opens in the panel; an **object** card; a sign-in handed to the owner; a reaction. Events and
  asks draw as lines in the feed, in place: a routine's run, a change to accept, a connection to finish signing in to,
  an error. Work in progress is said in the header, under the name, once: the face's motion and what it does now
  ("Using its browser…"; in a group, who is at work), cut to the width; the feed has no working line, never a tool
  row, never typing dots. Any message can be copied. Every destructive action (forgetting a fact, removing a member,
  taking back a permission, archiving an agent) asks first, in its own verb, with a way to keep things as they are. A reply that
  failed, a message that was not delivered, or an agent that did not answer, ends in one tap, "Try again", which sends
  the owner's "Try again." in their own words: what they asked stays where it was, and the agent answers it.
- **Files are rich wherever they appear**: sent by the owner, made by an agent, or attached in the composer. An image
  shows inline, zoomable; a PDF shows its first page and its page count; a document, a sheet, a text or code file
  shows a card with its name, size and a glimpse of its content (a sheet's first rows, a document's first lines, code
  coloured); audio and video play inline. Tapping opens the file in the panel (full screen on the phone): the PDF
  paged, the image zoomed, text and code readable, a sheet as a table, with Download and Open in the device's apps.
  Previews are drawn by the daemon from the bytes, never by code the box wrote; a file the daemon cannot preview
  shows its card.
- **The composer** is ai-elements' `prompt-input`: text, attachments (previewed as above), send. While the agent
  works it offers Stop only when empty; with words or files it offers Send, and what is sent steers the turn under way
  (see Queue), so writing never waits on the agent or stops it. `@` autocomplete everywhere. In a direct chat it inserts
  a reference to an agent; in a group it targets members for work. Its draft, words and files, is kept per chat on
  the device until sent, through navigation and reloads; a send takes back only what it sent, so whatever is written
  or attached while it is on its way stays. Enter sends and Shift+Enter breaks a line. No transcript mode, model or
  tier choice lives here.
- **The approval card** is the daemon's, plain, identical whoever the agent is: what will happen, on its object where
  it has one, the account it acts as ("as @bandarra on GitHub"), its text editable where the owner may edit it; an
  action with money or no way back lists its facts (what, when, how much, paid how, the way back); one primary button
  that is the effect's own verb (Comment, Send, Merge), a quiet one that says what will not happen ("Don't merge"),
  and at most one offered scope as a single row ("Don't ask again for this
  task"). Every other permission is granted and revoked from the Access tab of the agent's panel. An agent's
  change to its own file is a card showing the resulting text in full, the old behind "What it was", with Allow and
  Keep as is. A "waiting on you" pill sits above the composer when an open ask is out of view; tapping it scrolls
  there. A card with nothing left to do folds into one row of the feed, what was done and to what, with the card
  behind it; who did it is said only in a group, as on messages.
- **Activity has three depths**: the quiet status in chat; a readable timeline opened from that status or a quiet
  action beside a message's Copy; the full transcript, opened by any timeline item in the same sheet, with a way back.
  Hover, focus or a phone's long press reveals a message's actions. The sheet is full-width on the phone. It inspects
  that work, not every chat on the device, and stays on it when more work arrives. In a group, the reply identifies
  the member's own work; the group's working status lets the owner choose a member.
  The transcript starts with the recorded system prompt collapsed and the complete toolset offered to that model
  request, unused tools included, each description and schema available in full. Then come the input and chronological
  records: provider-exposed thinking, model notes, arguments, results, asks and errors. Thinking is never invented;
  timeline labels describe recorded actions, never a model's retrospective explanation. Historical context is what
  that request was sent, never today's agent definition. These are views of the same stored facts, not a second log,
  and inspecting them never submits work.
- **The panel** is a 20rem column at the right on the desktop, open by default on wide screens, and a sheet from the
  header on the phone. An agent's panel is the agent's whole home; it has no settings page of its own. At the top, the
  face large and the name; below, four tabs. It opens on Routines when the agent has routines or watches; else on Access
  while it can reach nothing; else on About. **Routines**: Routines on (a switch) and Add, then rows (name, when in
  words, next run, last run and what it said, paused; run now and pause in now on the row; tapping opens its editor) or,
  with none, one example in muted text ("Every weekday at 8:00, …"); Add opens a short form the daemon writes as the
  owner's own file. Beneath them, **Watching**: rows (the service's icon and the object's title, what ends it, when it
  last looked and what it last saw, paused or done; Check now and Pause on the row; tapping opens the object's card and
  the watch's editor); Follow takes a link, and an object's card in the chat offers it too. **Access**: the connections
  first, one row per
  connection with one switch per account and Connect when none is signed in, then what the agent may do without
  asking, each revokable. **Memory**: the facts, editable and deletable. The face and the name at the top are
  edited where they show: a tap on the face picks another, a tap on the name edits it in place. **About**: the
  **personality**, a text in the owner's words, the body of the agent's file, whose placeholder is a complete example
  in the owner's voice; thinking (Quick, Balanced, Deep), never a model's name;
  archive. A file or artifact the owner opens replaces the tabs
  until Back (an artifact's versions, edit and restore). The browser is not in the panel: the chat already shows it.
  A group's panel has no tabs: its members, who may be added, and archive. **New agent** is a short sheet, the face
  defaulted, a name and a personality that three tappable starters fill (Researcher, Writer, Keeper of the calendar):
  naming a friend, not filling a form. No description, no interview.
- **Connections** is a page from the band's menu and from Settings: every service the band can work with, a tile each
  (its accounts, or Connect; one not shipped yet says so), so the owner connects before any agent needs it. A chat
  that needs a connection carries the connect card instead of pointing elsewhere.
- **Settings** is one page: the model providers (connect another, add another account of one by name, switch the
  band to one account, sign out of each; the models the tiers use); connections (every account across
  services: sign in another, sign out, which agents use it); agents (the limits on groups; archived agents and groups,
  to restore); appearance; shared memory; Pause all
  routines; Advanced (show how the work is done on this device; the computer's state).
- **The phone** shows the sidebar first, full width; a row opens its chat full screen with a back control; the
  header's name and a routine's or a watch's event line open the panel's sheet; the composer sticks to the
  keyboard, the pill above it; the enlarged browser has a full-screen landscape mode with Give back pinned. The same
  hierarchy as the desktop, never a different one.
- **Keyboard**: Enter sends; Cmd/Ctrl+K searches; Cmd/Ctrl+1 to 9 open the band's rows; Esc closes the panel or a
  sheet.
- **Work products beside the talk.** What the agent makes (a document, a table, a plan, a page) is an artifact: a
  card in the chat, a first-class object in the panel, editable by the owner, with its versions kept in the store, so
  any version can be restored. The agent prefers a card or an artifact over prose when what it says has structure: an
  itinerary is an itinerary, not a long reply. An artifact the owner edits is the owner's version, and the agent reads
  what they changed as their words.
  - The agent publishes a file of its box with `publish`; each publish of the same path is its next version, and
    the same bytes make none. Every version's bytes are a blob the artifact holds, restorable byte for byte.
  - The owner edits (text) or restores (any version) on the newest version only, so nothing is lost to an edit made
    meanwhile. Their version is written back into the box only while the box's file holds the bytes it is known to
    hold, in one step from the box's side: the file is moved aside, hashed, then replaced or put back. Never over a
    change the box made since and never through a link; removing the artifact ends its pending write-backs without
    writing or telling. The chat is told at its run's next boundary: what the owner changed reaches the agent as their
    words; everything else as data, quoted, and a restore names the version, never its bytes, which the box wrote. A
    title or path is one plain line: no control or invisible characters.
  - A page renders in a sandboxed frame with an opaque origin and no network. Its own inline interactions may run, but
    it loads no outside code or data and cannot navigate the app or open another window: what the box wrote never
    runs on the daemon's origin, reaches the token or the API, or calls out.
- **The browser** appears as a live view inline in the conversation using it and in the panel, small: a status, a
  preview, a take-over, never a workspace that invites supervision. The preview or Open enlarges it for reading and
  take-over, with Give back and Stop. Closing an enlarged view hands control back before hiding it, including when a
  take-over is still in flight; if hand-back cannot be confirmed, the view stays open with a retry. Nothing is drawn
  over the page the agent reads.
- **What needs the owner stays in the chat**, where it was raised, and the row says so: the layout never reorders
  itself from watching the owner; it changes only by the state of the work.
- **Voice and touch are one loop.** The owner can speak or type in the same chat; a spoken message is transcribed on
  the owner's side of the boundary and arrives as text with its audio attached. A control on screen is always the way
  to approve: voice never approves anything on the floor.

What leaks no developer concept: no ids to type, no model strings, no file paths, no diffs, no Docker. An ask is
answered by a control, never by typing its id.

**Design language.** Sober and plain; the agent's face is the colour.
- Neutrals at chroma 0. The primary button is ink-filled, neutral. One accent marks changes; one error red. Agent
  faces carry the other colour on screen. Light and dark are designed, not inverted; every token passes the contrast audit.
- Each agent has an open-bot-avatar face, never an emoji identity: 40px in rows, 28px beside a message group's name in a group
  (a 1:1 chat names no one above its messages: the header says who),
  64px in the panel, 96px on the first-run screen. The face itself moves while working; a subtle dot marks waiting,
  and paused routines dim it. There is no disc or working icon. In voice mode its states include listening, thinking
  and speaking. The owner's face choice also supplies the first agent's favicon and installed app icons.
- Surfaces: one hairline border, the card radius, no shadow; the composer alone casts one. One primary button per
  card; the rest are quiet. Cards from connections carry the service's logo, from shipped assets, never fetched.
- Geist for people, Geist Mono for machines; the scale as it stands; prose at the measure; numbers tabular.
- Motion says something changed or something is alive: the working face moves and entries fade in; reduced motion
  is honoured.
- A messaging app's density, not a dashboard's: 56px rows, bubbles, grouped messages, day separators, times on
  demand. Bubbles, never a flat transcript, because messages arrive out of turn.
- Copy is short, plain, second person; no exclamation marks; nothing counts, streaks or nags. An error names who,
  what and the fix ("Mara's computer is off · Start it"), never the daemon's words. A tap always says in words what
  it will do. The agent says when it is unsure, in words.
- shadcn and ai-elements first (`prompt-input`, `attachments`, `web-preview`, `avatar`, `command`, `sheet`, `drawer`,
  `sonner`), each taking the app's tokens and joining the specimen. The specimen is the app's index: each section says
  whether it is in the app, a proposal or an exploration, and which component it shows; it never shows a copy of one.
  Everything the app needs ships with it: fonts, icons and logos load from the daemon, never a third party, so opening
  the app tells no one anything.

## Agents
An agent file is frontmatter plus its personality. Its filename is its stable id; the owner sees its editable name
and face, never the id:

| Field | Meaning |
|---|---|
| `name`, `face` | its identity in the app: a name and a bounded, validated avatar definition with its colour |
| `state` | active or archived |
| `tier` | how hard its chat thinks |
| `model` | its model (`provider/model`), which no tier changes; else its chat's tier's |
| `connections` | the connections it may use, by name; which of their accounts is the owner's switch |

The body is its personality, a prompt section. Every direct agent chat gets the same base tools: the box, its files,
its browser, memory, routines, watches and the speaking tools, plus `message_agent`, `read_agent_chat`, `propose_agent`,
`propose_group` and `propose_agent_change`. Group executions do not get these direct-chat tools.
What distinguishes agents is personality, connections, routines, watches and memory. An agent never gets a connection's
tools its file does not name. Enabled tools need not all be offered upfront: secondary tools are discovered on demand,
within the same authority. Discovery never grants access, and a previously discovered tool loses access when its
authority is revoked. A tool that asks the owner to accept something is named `propose_<what>`; a tool that acts
is a plain verb. Agent files are "before" files (see the workspace): the owner's own edit is accepted by construction,
in effect at once; the agent's change to itself waits for the owner as a card in its chat. An accepted change reaches
its chat at the next model boundary and deliberately starts its prompt cache cold.

The workspace starts with one agent, which is ordinary: renameable and archivable like any other, except
that the last active agent cannot be archived, since the app opens in a chat. The owner makes another from the sheet:
a face, a name, a personality, connections; nothing runs before the file is written. The default face is the chat
bubble. The owner can choose a shape and colour or accept a generated candidate; generated geometry is data, validated
and previewed before acceptance, never code or markup from the box. The sheet designs one in place, from the owner's
description or the name alone, by an inference on the Balanced tier; it is the owner's pick, written with the file.

Archiving an agent stops its runs, pauses its routines and watches, ends its permissions and removes it from the band
and from groups' mentions. Its definition, chat, memory and artifacts remain; Settings lists it, to restore. Restoring
it shows its current connections for review; old permissions and paused routines and watches do not silently return.

The agent climbs a ladder before it asks the owner: what it already knows, a connection, a search, the browser, and
the owner last. **Pause routines** on an agent holds its routines and watches and says so in its chat's header; Stop
ends a run; Pause all routines, in Settings, holds every agent's. The owner's own messages always run.

Agents may send one another messages only from direct chats, through `message_agent`; the recipient gets a feed entry and a turn, and decides what to do. Another agent may read a bounded page of a direct chat through `read_agent_chat`. The read is untrusted data; tools, results and hidden group execution chats are not exposed. Agents may propose an agent, a group or a change to an existing agent. Agent proposals follow the agent definition's identity, face, description, model, tier and instructions; the owner still chooses tools and connections, and new agents start active. Existing-agent proposals can change identity, face, description, model, tier and instructions, but not state, tools, connections or permissions. Proposals are cards in the proposing chat; only the owner's acceptance makes a definition or group effective. An existing-agent change shows the resulting file and the previous file and is bound to the accepted version it started from.

**How hard it thinks is three words.** Quick, Balanced and Deep, never a model string: each provider the app knows maps
them to models of pi-ai's catalog, and Quick is the default, so it answers fast. Advanced names the provider in plain
words and lets the owner pick another (only one with a key is offered) or run one tier on another of its models; a
provider without presets runs the configured model on every tier. An agent's tier is set in its panel's About tab and
nowhere in the chat: the owner who wants depth says so in words. A run asks for its model at every request, so a change
takes effect between runs, never inside one. When the owner starts to write in a chat idle long enough for the
provider's prompt cache to go cold, the daemon sends the provider what the chat's next request starts with, for one
token, so the reply comes sooner; nothing is stored.

**A provider has accounts.** The owner may connect several of one provider (two sign-ins, a personal key and a work
one), each named by the owner, and picks one account for the whole band, as they pick a provider. A provider's first
account is the provider itself; another thinks only with the credential connected for it, never with one from outside
banda, and leaves with its sign-in. The tiers are the provider's whichever account runs them, and what a run spends is
counted against the account it ran on. An account's name shows only once its provider has more than one.

**The face is never the trust.** Personality makes an agent pleasant; it does not make it safe. Trust lives in the
structural rules, and the warmth of an agent never softens an approval: the card that asks is the daemon's, plain, and
identical whoever the agent is.

## Groups
A group is made by the owner, who chooses its agents (any number, none at first, up to the limit Settings sets) and
alone adds or removes one; a group may lose its last member and wait for the next. Every participant is
equal; there is no coordinator. A message asks everyone unless it mentions one or more agents (`@name`), which narrows
it to them; each starts independently against the same shared history, and the members limit bounds the cost. With
nobody in it, a message asks nobody and stays for whoever joins. The composer
says so beneath the field ("To everyone · @ to pick one"). A mention, in the composer and in any message, shows as the
agent's face and name, a link that opens its chat. A member speaks only in the room: `message_group` posts its
words, files and artifacts (by id, each at its version then) there, and its other speaking tools act there (`ask_user` asks the owner in the room, `react` puts its
emoji on the owner's message its turn answers, `publish` shows its card); `message_user` and `propose_avatar` are not
offered in a group, and
`message_group` nowhere else. Its `ask` names the members whose work is needed, each starting a turn: its schema is an
enum of the group's other active members by the names the group shows, so a member can name nobody else, and with
nobody else there it has no `ask`. The enum follows the group at each member's turn. A name written with an @ in the
words asks that member too. Agents' asks are visible and bounded in depth, total turns and concurrency; the owner
sets the depth and the turns in Settings, for every group; past a bound
the message still posts, asking nobody, and says why. A lowered limit binds what comes next: a group already past it
keeps its members but takes no more. Each member keeps its own memory, permissions and browser; the
group gives them shared context, nothing else. Joining reveals the full history; leaving prevents future work but cannot
erase what the agent saw. The group's row sits in the band like an agent's; its panel lists its members.

Archiving a group takes it out of the band and stops what its members are doing there; it takes no message, starts no
turn and does not change until restored, and the room says when it was archived. Its history, members and their
execution chats remain; Settings lists it, to restore, and a restored group goes on where it was: nothing it was doing
comes back.

## Connections
A connection is how the band works with the owner's services without holding them. It ships as a file
(`shipped/connections/<name>.md`): the service in plain words, its logo, where it is, how the daemon signs in (OAuth
with PKCE, or by code where the server registers no clients, as GitHub), the scopes it asks for, which tools only
read and its objects. The owner adds one with a tap: its bytes are written into the workspace and
allowed at once, since the app wrote them and the owner chose them; from then on it is an ordinary "before" file. It
follows banda's version: at each start, one nobody but banda changed since is written again as banda ships it now, with
the scopes the owner picked, and allowed at once; one the owner allowed a box change to is theirs, and stays. It
is first class in the UI (a logo and a name on every card, event and draft of its) and secondary in the hierarchy: it
lives inside agents' settings and the app's Settings, never as a screen of its own.
- **Accounts.** An account is one sign-in: `auth/connections/<connection>/<account>/` holds its credentials, bound to
  the URL they were given for, so a changed URL never carries them along. Its id is what the service calls the owner,
  read once after sign-in and shown ("@bandarra"). Each account has its own access: the file's scopes are what a new
  account asks for, and the owner may pick others for one account from what the file allows (its scopes and every
  scope its tools need), so a personal mailbox can read while a work one sends; what an account was given is what its
  credentials record, and a tool it was not given access for is refused in words before any request. Narrowing what
  the file allows makes the accounts beyond it sign in again. The owner signs in another at any time; signing out forgets the
  credentials and switches the account off for every agent. Credentials never reach the
  box, a prompt, an entry, the store or a log; what a server echoes of one is hidden.
- **One flow everywhere: enable, sign in, done.** From an agent's panel (Permissions), from Settings, or from a card the agent
  sends when it needs a service it lacks ("Connect GitHub?"): a tap starts the sign-in (a redirect that comes back to
  the daemon's loopback callback, where the state names one sign-in, once; or a code the card shows, with Copy code
  and Open GitHub as separate controls, the card alive in the chat so a phone can come back to it), the daemon sees
  the grant, the card says done ("Signed in as @bandarra · on for Mara"), and the account is on for that agent. A
  sign-in that did not finish says why and offers Try again; one that signs in an account already known says so
  ("That's @bandarra, already connected · switched on for Mara"). Cancelling a sign-in in banda only stops
  waiting for it: it never claims to cancel one open at the service. When an account exists, a second agent's card is one
  tap and no sign-in: "Let Mara use GitHub as @bandarra?". From then on reads run freely; a write is a draft. The
  agent is never asked for permission to use a connection it has: the draft is the only ask.
- **What is offered is what was listed.** On connecting, the daemon lists the server's tools and keeps them in the
  store for that accepted file; the model is offered exactly those, under stable names (`<connection>__<tool>`). A
  tool the server adds later waits switched off.
- **What each tool does is said once, on adding.** A tool's kind (a read, a write, or a write on the floor and its
  class) and its group ("Issues", "Pull requests") come from the shipped file, else the server's annotations, else an
  inference over the listing framed as foreign data, else it is a write. The owner sees them grouped, a group
  collapsed to its count and one control, each tool saying where its kind came from ("GitHub says", "banda's guess"),
  changes any of them, and accepts; only then are they the file's `reads` and `groups`, and each tool's setting the
  owner's (a guessed floor is kept as Always ask, with its class). Until then every tool that is not the file's read
  asks every time. A guess may make a tool a write or put it on the floor; it only proposes a read, which the owner's
  acceptance makes one. A tool listed later
  is guessed the same way and waits switched off, marked new in its group.
- **A read runs, a write is a draft.** A read runs when called, and its answer comes back framed as foreign data. A
  tool that runs many routes may read for some exact arguments only, `tool(arg=value)` in the file; any other call of
  it is a write. Every other tool is a write: a draft the owner approves, run once as approved; one the file puts on
  the floor asks every time.
- **Tools and accounts.** One tool set per connection. When an agent has more than one account of it, the daemon adds
  a required `account` parameter to each tool and names the accounts in the description; with one, nothing is added.
  Objects, events, drafts and permissions carry their account; a permission binds one account and never covers
  another. A draft may edit its text, never its acting account. Nothing is on by default: an agent gets an account
  when the owner switches it on. Replacing a sign-in does not lend its authority to work still using the old one.
- **Switches.** The owner switches any tool off, signs an account out or removes a connection from Settings. Whether a
  tool is in effect is checked in the commit that starts each call, so one taken back is refused even mid-run, a write
  waiting for approval included.
- **A connection only narrows.** In Settings each tool or group is a read (Allow, Ask, Off), a write (Ask, Always ask,
  Off) or on the floor (Always ask, Off). Ask on a read, or Always ask on a write, puts it on the floor for every agent. Nothing set
  on a connection lets a write run unasked: that is a permission, and a permission is one agent's.

**Objects.** An object is a thing in a connection the owner recognises. In the owner's words, a recognised link is a
compact inline reference: the service's icon, the object's type icon and its linked title, aligned with the owner's
words, without metadata or a repeated card beneath it.
Unknown or unreadable references stay links. In the agent's text, recognised links unfurl as cards beneath the text,
once per message, a few at most; the rest stay links. In a draft, the card shows what a write will do to it ("Comment on banda#34", the comment
beneath, Approve, Edit, Decline). The card is the daemon's rendering of a reading the daemon made with the account's
credentials, for the owner's eyes: the model never sees what a card shows unless it read the object itself with its
tool. Readings are kept in the store by (connection, account, object), bounded, with their time; a card refreshes on tap
and says "as of 10:42" only when its reading is over an hour old. Refresh and reading details stay out of the prose,
behind the card's actions; an approval still names its acting account plainly. Long metadata stays compact, with its
full value available in details. A notification is drawn as the thing it is about.
Unfurls are few per message and never retried in a loop, so a chatty model cannot make the daemon hammer a service. A
reference names the object its URL opens, not a different object found before normalizing the URL. Equivalent names
share a reading only under the connection's declared identity rules. A connection declares its objects as data,
never code: for each kind, the URL and id shapes that name it, the read that
fetches it (a tool and how its arguments come from the match), the fields the card shows, the writes that act on it,
by tool, and how it is followed ("Watches"). Every object in every state is in the specimen, light and dark, both
widths.

**Harnesses.** A harness is a connection that does work rather than reads: a coding agent on the owner's computer,
spoken to over ACP, with the daemon as its client. It sits on Connections and in each agent's Access beside the
services, connected in the owner's code folder (any folder but `/` or one above the home; where code usually lives is suggested); that folder
is its account, and the owner turns it on per agent. It selects the starting project, not a sandbox: the harness runs
with the owner's host access and its own permissions, stated before enabling it. Harness execution is available only
on platforms where banda supervises its process tree (macOS and Linux). Each session works in a project the agent names: a git repository
inside that folder, by its path from there, or the folder itself when it is one (a folder of projects, the home among
them, never is). Never outside it (symlinks resolved), never through a
hidden folder, never a folder that is not a repository, so the home as the code folder never makes `~/.ssh` a project;
naming one that is not there answers with those that are.
- **What runs is the owner's.** A harness is a file banda ships (a bundled adapter, or a command on the PATH, offered
  only when installed) or a command line the owner typed. Never a file the box wrote: the daemon runs it on the
  owner's computer, outside the box. It runs under banda's supervisor, which watches every process group below it
  (a harness may run each command detached, in a group of its own) and kills them all when its session ends or the
  daemon dies; a later daemon uses the session marker and groups still anchored by a recorded process identity; a reused group number
  alone never authorizes a kill.
- **The agent knows what it has.** It gets a tool per harness turned on for it (`harness__claude_code(prompt,
  project?, session?)`), whose description says where it works and the projects there, rebuilt when that changes.
  A call starts a session at once and answers with its number. Given an earlier `session`, it follows up: a running
  one takes the prompt as a note after its current step; an ended one goes on in a new session that reopens the
  harness's own (`session/load`, its replayed history left out), else starts fresh with a summary of what the earlier one did.
  Both the owner and the agent see which happened. Each continuation checks the currently connected folder and agent
  access; changing either stops the affected work, including notes and approvals not yet sent.
  `harness__sessions` shows the agent its sessions (others' are not its to see), and `harness__stop` stops one, as
  the owner's Stop does.
- **The agent starts it; the harness asks.** A session starts with no draft. What reaches the owner is the harness's own asks: its mode is set before anything is sent, where the
  file names one, so it asks for what the owner would want asked (Claude Code: commands, and anything outside the
  folder); otherwise its own settings decide, and the connect card says which. The connect card says the agent can
  start it without asking. Only an unambiguous one-time choice is answered, and the harness's exact option is what is
  answered; the buttons speak banda's words, the same whatever the harness: the ask is named by what it does, approval
  by its verb, refusal by what will not happen (Don't run, Don't change, Don't open, Don't allow). "Always allow" is never answered: it would
  write a rule into the owner's own settings. Asks are reviewed whole, one at a time: the oldest in full, the rest
  folded to a line each until opened, and a folded ask cannot be approved; there is no approve-all. What is open is
  the owner's choice by id plus always the oldest, so an ask resolving elsewhere moves no other card; a card's
  buttons rest a moment after it appears or moves, so a click aimed at one never lands on another. A long command or
  diff sits in a bounded window with "Show all": folded, never cut. A request too large to show in full is refused, never shortened for approval;
  an unsupported permission mode stops the session before work is sent. The device notification for an open ask says
  the harness and the kind of thing asked, never the command, the path or the project's name.
- **A session is live in the chat.** It is drawn in the call's place: one line for its current step, in the owner's
  words where they exist, and only a single plain command earns them (a command loses its `cd … &&` throat-clearing,
  a simple search or read is said as such, a path reads from the project only when anchored at the project's own
  folder); a chain, a pipe, a redirection or a substitution shows the command whole, so a quiet verb never fronts a
  second command, truncated in the middle so head and tail both read. What the harness waits on is said by the kind of
  thing asked ("Waiting on you: run a command"), and an answered ask the same way ("You allowed: run a command"),
  never with the command or the path: a folded line never shows a command in part, so a cut can never hide its middle;
  the command shows whole only on the ask's card and in the sheet's row once opened. The card names the harness and the
  project; the session's number and full path belong to the sheet's detail, not the card. Its state is said in words
  ("Working 1:48", "Waiting on you", "Took 0:03", "Stopped", "Interrupted", "Failed") and announced to a screen
  reader when it changes, never colour alone. The owner's notes live behind "Add a note" and show on the card with
  whether each was taken; Stop and the step line's own target (and "Steps", the touch target the line repeats) open
  what it does. Every step lives in a sheet, each folded to its one line until opened: it opens at the newest step and
  follows the end while the session streams, stops following when the owner scrolls up and offers "Jump to latest"
  back; a step that arrives while it is open never arrives expanded, and opening one never jumps the view. Each ask
  is a card under the session's; several may be
  open at once, and each lives as long as the harness's process. The header shows delegated work from its recorded state,
  with approval attention and a way to open its activity; several sessions have a picker. The agent's own active reply
  takes priority, with a compact delegated indicator alongside it. Stop answers them all, and before the ask was sent,
  stops it from being sent. The owner steers in their own words: a note is sent to the harness as a
  prompt it takes after its current step. Stop cancels the turn. Stop acts at once, with no confirmation: a stopped
  session keeps its record, and the agent can follow it up (native resume where the harness supports it, otherwise a
  fresh session handed a summary of what happened), so stopping loses nothing the owner cannot take up again.
- **Once, and then the agent hears.** The ask is sent at most once: a restart after it was sent ends the session
  interrupted, never sends it again, and a session whose task ended without ending it ends failed. Either way, and
  when the harness finishes, its agent wakes once with what was done, fenced as foreign data: how it ended, what it
  said (in full at the end, a line for each earlier turn), the files and lines it changed, the commands it ran, and
  the owner's notes and answers to its asks, so its report never contradicts what the owner did; bounded, the least
  needed cut first. It tells the owner in its own words. Steps are kept in the store, bounded, with files named from the project; lines added and removed are shown only
  when the harness said, never a made-up zero. A disconnect stops the sessions running there.

## Messages
The speaking tools are the only path from an agent to a person, one tool per act: `message_user` sends words in its
own chats (a group member posts with `message_group` instead, "Groups"), `ask_user` asks and waits, `react` puts an
emoji on the owner's message, `publish` puts a file in the Library, `connect` offers a connection's card, and
`propose_avatar` offers a face (direct chats only). Each but the words works in both venues: in a group member's chat
it acts in the room. Every chat gets them whatever its file lists; `connect` and `propose_avatar` load on demand. A
run's final text is its working notes: kept in the chat, in the raw transcript, never sent. **The owner is always
answered**: a run answering the owner (the newest input in its chat is theirs, a message or a steer) ends in an act
toward them since they last acted there: a speaking call that went through (words, a question, a reaction when
nothing needs saying, a publish). A run that
settles without one is nudged: the daemon queues its own words into the chat ("you ended without answering the
owner…"), part of the same task and not shown as the owner's, once; a run that still has not acted leaves a notice in
the chat, "<name> didn't answer.", so the owner never meets silence. A run that failed or was stopped is told as such,
never nudged; a newer input of the owner's already queued is the one the next run answers, so it is not nudged
either. In a group the same holds for a member's turn that an owner's message asked for: it ends in a speaking call
that went through in the room, or it is nudged once in the group's words, and then the room says "<name> didn't
answer". Routines' and watches' runs and a member's turn another member asked for may stay silent. What a message
carries:
- **text**, markdown; a link the daemon recognises as an object draws its card beneath;
- **file**: a path in the box, sent as an attachment and shown inline where it can be;
- **artifacts**: ids of artifacts in the Library (`publish` returns its id), each drawn as its card at the version
  current when it was sent; an id the Library does not hold is refused before anything is sent;
- **view**: a live view of something in the box (the browser's page).

The other acts: **question** (`ask_user`): choices, a form or free text; the call opens a Wait and returns its answer;
in a group, options alone. **reaction** (`react`): one emoji on the owner's message the run answers; alone, it is the
whole reply ("got it"). A routine's or a watch's run answers no one's message, so it has none. **artifact**
(`publish`): a path in the box published as its next version (see "The app"), a card in the app.

A call returns once its message is delivered, or with why it was not; a question returns its answer. Calls in one
round run one after another, so messages go in the order the model wrote them. A message is sent by the tool's own
task in two phases: memoize the payload, send it, memoize the sent id. Sends are at-least-once: a transient failure
sleeps and retries the same bytes, so a client gone for hours delays messages and loses none; a permanent one, or too
many attempts, fails the call and leaves a notice. Messages to one origin go in order.

**Drafts.** An effect that leaves the box is never a message the agent sends: its tool stores the whole effect as a
draft, opens an approval Wait, and blocks. The daemon renders the draft, never the model: the card shows exactly what
will run, on its object where it has one, and the owner may edit a draft's text before approving it, which binds the
edited bytes. Approved, the daemon runs the stored draft once and the tool returns its result; declined, the tool
returns that. Outgoing messages on the owner's behalf (an email, a comment) are always drafts. Wait ids never reach
the model.

**Permissions.** An approval can be given with a scope: this once, for this task, for an hour, always. A permission is
stored; an effect within an open permission runs without asking and is listed in the activity log, and the owner revokes
a permission from the agent's panel. A permission belongs to one agent and one account, and covers only that agent's
chats; one for a task, only the task's chat. Below every
permission sits a floor no permission covers: money, credentials and account changes, and anything that sends private
data to a recipient the owner has not approved, ask every time. A tool declares its floor class and the daemon enforces
it: a draft on the floor offers no permission, a permission asked for it is refused, and no permission covers it. A
permission binds one tool and the values of the arguments the tool names (by default all but the text the owner may
edit): a later call is within it only with exactly those values. "For this task" lasts while the run answers the same
input, so the owner's next message ends it (in a group, the owner's next message that asks the member; another
member's message never does); a steer joins the run under way, and its task with it. A tool declares wider grains as
data, each a subset of what it binds and worded by the daemon: the object ("Merge banda#34"), the place ("Merge pull requests in purrgrammer/banda"), the
action ("Merge any pull request as @bandarra"); a permission at a grain binds only that subset. Trust is earned from
the owner's answers, never the model's asking: after three approvals of one place, unedited and with none declined in
between, the card's offered row is that place's grain. The widest grain of a tool with no way back is never offered on
a card; it is granted from the agent's permissions, its consequence in full. A task that read foreign content (a read
from outside or a write's answer, another agent's message or chat, a group member's message, a harness's work) is
offered no scope but an earned place, until the owner's next message starts another. An agent knows its own: a section of its prompt says how it asks (a write
it proposes is the owner's review, never a way around it; the floor asks every time) and lists, in the daemon's
words, what it may do without asking and until when, so a grant or a revocation reaches it at its next model
boundary; and each effect's result says what let it run ("The owner approved this", "Ran without asking, within
your permission to …"). It never sees another agent's permissions, and knowing one widens nothing. Each permission shows what it let run ("Merged 4 pull requests this week"), and
one unused for a month says so beside Take back. An effect checks its permission in the commit that records its start, so a
revoked permission covers nothing after it. The daemon offers at most one scope on a card, the task's where it applies,
worded as its consequence ("Don't ask again for this task"); every other scope is granted from the agent's permissions;
an answer giving a scope it did not offer is refused. Nothing is asked twice: a permission answers, in the commit that
gives it, the open asks it covers, and an ask a permission covers by the time it opens is answered by it.

## Routines
- **Routines are files**: the `schedule` tool and the app write them like any other workspace file, and
  the accepted file is what runs; the store holds only each routine's task (its next due time, its runs). A promise
  the agent makes ("I'll check tomorrow") is a routine or a Wait, so it is kept whether or not the model remembers it.
  A routine that stalls or fails is itself news.
- **A routine belongs to one agent and runs in that agent's chat**, never in a chat of its own. The agent writes one
  (a card in its chat the owner accepts) or the owner does from the panel, in effect at once. A `schedule` call is
  that card, never a tool row.
- **A wake is an event in the chat**: a line with the routine's name and when it fired, and then the agent's reply
  as its message. A wake draws its line only when the agent replied or the run failed, so a quiet run leaves no
  trace in the chat. A run that failed, stalled or ran the most it may today draws an error line and marks the chat
  unread. The panel's row says the rest ("last ran 8:00, nothing to say").
- **The owner's own edits take effect at once**: when a routine runs (picked from presets, or a cron line), pausing and
  deleting. A change rewrites only that line of the file, bound to the version the owner saw; the store accepts it
  first and notes that the box still needs it, so a restart between the two finishes the box's copy, and an edit over
  a change the box made is refused until that change is answered. **Run now** is one wake beside the schedule, which it
  leaves as it was, once per click; like a due time, it waits while the routine's last run still goes.
- **Wakes** (an owner's message, a routine, a watch's change, a finished wait, a mention in a group) go into the
  chat's queue, deduplicated.
- **Due times.** A routine fires once per due time, in the commit that records the time as fired; due times missed
  while the daemon was down or paused come together as one wake. A routine whose last run still goes skips its turn.
- **A time is on someone's wall**: `at` and `cron` are read in the routine file's `zone` (an IANA name), which the
  agent gives for the place the owner means and the panel gives as the owner's browser's; without one, the daemon's
  computer's. Its words always say whose wall ("Weekdays at 08:00, Lisbon time").
- **Runs a day** are per routine (`runs_a_day` in its file); one that runs that many times in a day pauses alone and
  says so.

## Watches
A watch follows one object outside, through a connection, and wakes its agent when it changes: a pull request until
it merges, an issue until it closes, a mailbox for what matters. A routine's trigger is a time on someone's wall and
a Wait blocks a tool call; a watch's trigger is the world, and the world ends it. Like a routine, it is kept whether
or not the model remembers it.
- **Watches are files**: `watches/<name>.md`, written by the `watch` tool (a card in its agent's chat the owner
  accepts: "Follow banda#142 until merged?") or by the owner from an object's card or the panel, in effect at once;
  the accepted file is what runs. The file names the object (a link the connection recognises), the account it looks
  with and what ends it; its body says what matters and what to do about it, words the agent gets at every wake. The
  store holds only the watch's task: its reading, its health and its wakes.
- **A connection says how each kind of object is followed**, in that kind's entry beside the read that fetches it,
  the fields its card shows and the writes that act on it, as data, never code: the further reads a following needs
  (only tools listed under `reads`), how each list in the reading is keyed (comments by id; check runs by name, since
  every push gives them new ids), what is noise, whose items are the account's own, conditions derived from the whole
  ("all checks green again", so it wakes once), which changes wake and which only tell, each said in words from the
  reading's fields, what ends it, and when it is busy. The daemon makes the reads with the account's credentials, in
  the daemon: no box, no model. Any link the connection recognises as that kind can be followed; a kind without the
  declaration cannot, and the card says so.
- **One reading per object.** The daemon keeps one reading per (connection, account, object) fresh while any watch
  holds it, the same reading the object's card draws, so five watches on one inbox read it once and a followed
  object's card is always current. An object's card offers Follow among its quiet actions; a followed one says who
  follows it and until what, in one line, and never says "as of" while the daemon can look.
- **The change is the event, and its identity is the change.** Each reading is compared with the one before, or
  read from a feed's cursor where the service keeps one; the events are the differences, and an event's id is the
  change itself, so a read repeated after a crash yields the same events and the same wake key, which the chat's queue
  deduplicates. A short page never counts as removal. Push (a server's notification, a webhook) only says when to
  look, never what happened.
- **The first look comes before the watch is live.** Making a watch reads the object once, and that reading is its
  baseline: only what changes after it is an event; what came before, the agent can read for itself. A watch whose
  first look fails is not made, and the card says why.
- **Wake, tell or nothing.** The kind's rules sort each change: a wake starts the agent's run with the change as its
  input, framed as data, the watch's words beside it; a change that only tells draws its line and card in the chat
  and runs no model; the rest (noise, what the account itself did, a bot's) leaves no trace, so an agent never wakes
  on its own work. At a wake the agent decides whether anything is worth a message, as at a routine's: its message
  counts as unread, a line alone does not.
- **A burst is one wake.** Changes that arrive while the watch's last run still goes, or before the kind's settling
  time passes, come together as one wake carrying the newest reading, and its line names what came together. A
  watch looks often while its object is busy (checks running) and seldom when it is quiet, as the kind says; wakes a
  day are per watch, as runs a day are per routine.
- **The wake in the chat** is an event line, the change in the kind's words with the service's icon ("banda#142 · Ana
  approved · 2 checks failed"), the object's card beneath and then the agent's reply when it had one. Tapping the line
  opens the watch in the panel.
- **It ends itself.** When what ends it holds, the last wake says so and the watch is done, as a routine that ran
  once is; its row says what ended it until the owner removes it. Following the same object again starts a new
  watch from a fresh baseline.
- **Health is observed and told.** A watch has what the owner wants (on, paused, done) and what the daemon sees
  (looking; can't reach, since when; behind, when a feed's cursor expired or a gap could not be recovered). The row
  says which, in words ("can't reach GitHub since 9:10"); a watch that could not look for an hour draws an error line
  and marks the chat unread, like a failed routine. It never says it is caught up when it is not: a gap it cannot
  replay is closed by a fresh reading, and the wake that follows says what may have been missed.
- **Pause and resume.** Pause stops looking. Resume looks once and reconciles: what changed meanwhile is one wake
  that says it comes from the pause, never dropped and never replayed as if live. Pause routines on an agent, and
  Pause all routines, hold its watches too; Check now looks at once, as Run now runs.
- **Authority.** A watch looks only for an agent given that connection's account, checked in the commit before each
  look; switching the account off, signing it out or removing the connection ends its watches in that commit, and the
  row says why. What a watch reads is foreign data ("Trust"): it changes nothing about admission, and what the agent
  does about it leaves the box as a draft, as ever. A subscription the service itself keeps (a mail feed that expires
  in days) is the connection's to declare and the daemon's to renew; one that lapsed is a health the row says, never a
  silent gap.

## Flows
- **Every input is a Turn** with a `replyTo`: an inbound's origin; for a routine's or a watch's input or a group's
  mention, the chat's last owner origin. Asks go to the `replyTo` of the Turn that raised them. The commit that ends a
  Turn checks, once per run, whether the run left the owner unanswered ("Messages"), and queues the nudge or the notice
  in it.
- **Queue.** An input that fills a Wait is an answer, never an input. A chat answers one run at a time. The owner's
  input while it works steers: it joins the running run after the current tool round. Every other input follows up,
  and follow-ups queued together start one run. Inputs reach a chat in the order they arrived; cancel always works.
- **Inbound** is one commit: the routing (creating the chat if new), the message ref, and the Turn, keyed by the
  message id; a redelivery starts nothing.
- **Routing** is deterministic: `gateway:peer:thread` names a chat; the model never chooses where a message goes.
- **A group's visible history has one copy.** Its canonical room conversation never runs a model. Each agent has one
  persistent hidden execution chat for that group, preserving its permissions and cache. Posting a message and
  admitting one Turn per mentioned agent is one durable operation, deduplicated by the message id. Those Turns run in
  parallel against the same bounded room snapshot; neither sees a concurrent reply. A later Turn catches up everything
  added since that agent last worked. The room shows attributed messages, asks, artifacts and status; raw execution
  entries stay in the agent's hidden chat, reached through its activity rather than mixed into the room's log.
- **Answers.** A Wait is filled by the owner, first writer wins, through the ask's own control in the app, or on the
  CLI by its id (unguessable, single-use). An open question may instead be dismissed: the model learns that the owner
  declined to answer, never a fabricated answer. The owner's own words typed in the chat are shown as their message
  as well as filling the question. Model text carrying an open Wait's id is not sent. Forwarded or quoted text never
  parses as an answer. An answer that cannot fill the Wait it names is refused, never taken as a message.
- **Waits** are keyed by the tool task that opened them and created in the same commit as that key. The phases held
  open (a Wait, a Turn waiting on its run) commit a fresh checkpoint on each invocation, so crashes never park them; a
  send counts its attempts instead. On start, the daemon runs again a task parked while it owned an open Wait. The
  deadline is decided in the transaction that reads the slot: an expired Wait answers the tool `expired`, and an
  approval that expires is denied.
- **Status** is derived from the task graph and the tasks' own inputs: `waiting`, `running`, `idle`, with routines,
  watches and parked tasks beside it.

## Search
Search finds what was said and made across the band: direct chats, shared group histories and artifacts' titles and
latest text. Agents and the owner's search use the same derived index. Search is separate from memory: recall
retrieves saved facts; search retrieves sources, with bounded excerpts and references that open or read their context.
All agents may search these shared sources, including from a group. Hidden execution chats, internal transcripts,
credentials and memory files never become search sources. Visibility is applied before ranking and limiting.
Retrieved text is data, never instructions. Search describes its coverage; local results do not claim to search live
connections, arbitrary workspace files or attachment contents. Pagination is over current sources, not a saved snapshot.

## Memory
Memory is compact facts in workspace files, with two scopes: **global**, shared with the band, and **agent**, used
by one agent across its direct and group chats. Scope says who uses a fact, not whom the fact is about. Saving names
the scope explicitly; the calling chat determines the agent, never a name the model supplies. Recall searches the
shared facts and that agent's facts, or the narrower scope requested. Forgetting and
correcting a fact use the same audience. These scopes control context and memory tools, not filesystem privacy
between agents sharing a box.

Both scopes are small enough to carry in context, with a fixed budget for each. A save that would exceed the budget
is refused without discarding facts; the agent shortens or forgets something before retrying. Progress stays in chat,
work products in artifacts, and future promises in routines and watches: memory is neither a second transcript nor a
scheduler.
A correction names the exact old fact and stays in its scope, so a stale edit cannot overwrite newer words.
Replaying an interrupted save or deletion never undoes a later owner change, even when the owner restores the old words.

A fact is one line and may name its source in the line itself; a box-written source is context, not proof of origin.
Its id binds its file and words. Shared facts and the current agent's facts render into a prompt section; a change
reaches every affected chat at its next model boundary without resetting the chat. Facts are context, never permission
or an accepted change to personality. The owner reads, adds, edits and deletes facts in the agent's Memory controls;
Settings shows the same shared facts, not a copy. Who wrote a fact is the owner's to see; the agent never reads it. A
deletion removes the fact from its file and the derived search
index, whose pages are scrubbed; what was said in chats stays.
- **Other people.** A fact about someone else names them and the owner's task it serves and stays agent-scoped,
  never in the band's shared memory.

## The prompt
A chat's prompt is built for the cache in a fixed order. An accepted change to its agent updates the prefix at the next
request and deliberately starts that cache cold; otherwise every request repeats it and only the newest messages are
new. Sections are the agent's personality and its facts, in a fixed order. Anything that changes during a chat arrives
as an entry, not as an edit of the prefix. Long outputs go to files the agent reads back.

**Compaction** is pi-durable's: a summary entry replaces older entries in what the model sees, and every entry stays
in the store. That entry is the checkpoint; the app keeps no record of its own. pi-durable's thresholds decide when: a
chat's budget is one share of its model's window, the same for every model, so a long chat stays fast and cheap
instead of filling a large window. A compaction for the budget summarizes at least a tenth of the window of what was
said, or waits, so a chat whose kept context sits near the threshold never compacts on every turn. The summary keeps
an agent's working state (people, promises and open work with their dates, decisions and why, the owner's tone, what
waits on whom); lasting facts are scoped memory, not a second summary. Pending drafts, permissions and waits live in
the store, never only in a summary. The chat shows nothing of a compaction; the raw transcript marks it as a
checkpoint with its reason, tokens before and after, cost and summary.

## State
All truth is in `durable.db`. A bookkeeping doc exists only for a fact that cannot be derived from entries or tasks,
and is written in the commit of the thing it records: message refs, routes, drafts, permissions, blobs, artifacts,
readings, read cursors, group membership, accounts' switches, each chat's tier, and the accepted versions of the
workspace's "before" files. Agent identity lives in its accepted file, not a second document. Indexes are pruned with
what they index.

**Blobs** keep bytes out of the store. An attachment's bytes live on disk at `blobs/<ab>/<sha256>`, written to a
temporary file, synced and renamed before the commit that refers to them; the store holds every fact about them and
never the bytes. So a crash leaves at most a file nothing refers to, never a reference to nothing. A blob lives while a
chat, an artifact or a write-back of one holds it; a sweep deletes the blobs nothing holds, and files with no row once
they are an hour old. Writes and the sweep take one lock. An attachment that came in is written into the box at
`/work/attachments/<sha8>/<name>`, and the input names that path. In text, a blob is a markdown link,
`[name](sha256:<hex>)`, which the app renders as the file itself. One file may weigh `files.maxBytes` (50 MB by
default) wherever it comes from or goes.

**Search** is the one derived store: SQLite FTS, caught up from a commit cursor stored with its rows, rebuildable from
scratch.

## The box
The agents share one computer: a container where tools run, files live and the browsers draw. Their chat transcripts
remain in the store and are not shared, but workspace files are not a privacy boundary between agents and two agents
may race on them. A later box per agent closes that structural boundary without changing chats or groups. The daemon
reaches the box through pi-env: it starts pi-env's daemon in the box with `docker exec -i`, and every tool call and
file read goes over that one connection, as a pi-durable `ExecutionEnv`. The agent loop, the store and every
credential stay in the daemon, so the box is disposable: it can be destroyed and made again mid-chat and nothing is
lost. pi-env isolates nothing: the boundary is the container's. Each command runs in its own process group, killed
whole on cancel or timeout, with an allow-listed environment. A tool call a crash interrupted is reported interrupted,
never run again.

What the box holds: `/workspace` (what the agents are made of, their memory and their files), `/work` (attachments,
dependencies) and `/tools` (toolchains), each a volume. Nothing of the host's: no `auth/`, no store, no host home. It
runs as the owner's uid, with a read-only root, all capabilities dropped, no new privileges, and limits on memory and
processes. The box's runtime is the app's to bring, never the owner's to install by hand.

**Network.** The box sits on an internal network whose only other member is the egress proxy. It resolves no outside
names and has no route out; only the proxy reaches the internet. The proxy terminates TLS with the app's own
certificate authority, the only one the box trusts, and pins the address it resolves; a request whose Host or TLS name
names another server than its tunnel's is refused. A command reaches the proxy as its chat, by a login only the daemon
can mark, so what the box sends is always someone's. The daemon talks to the proxy over `docker exec` alone. With no
proxy the box does not run: the app says its computer is offline, never that its network is open. Host mode
(`serve --box host`) is the one exception, opt-in by name and never a fallback: there is no box, commands run on the
daemon's own machine in the home's workspace and drop every guarantee here, and the CLI and the app say so for as
long as it runs.
- **Reads pass** to public hosts; never to loopback, private ranges, link-local and metadata addresses or the daemon's
  port, however the address is spelled. What came back is foreign content: framed as data in the chat that read it.
  `web_fetch` is such a read, made for an agent: a GET from the box through the proxy as its chat, acting as nobody,
  each redirect checked before it is asked; it asks no one, and gives back the page as text, bounded. A page that
  needs scripts, a click or the owner's session is the browser's.
- **A write needs the owner.** A write (any method but GET, HEAD and OPTIONS, a WebSocket upgrade) is held as a ticket
  and answered 403. A git fetch is a read, but only to a forge the daemon names: git's own request to upload-pack,
  which only sends objects back. After each command the daemon takes the chat's tickets into the store and lists
  them; `propose_send` makes one a draft, and approved, the proxy sends exactly the stored request, once. A permission
  covers a route (the method, the host, the path with its ids as `*`) and is checked in the daemon's commit, never in
  the proxy. The owner may instead allow a host (its name in lower case, its port unless the scheme's): anything sent
  there, always, a second shape the request binds, offered beside the route's and never the default. The owner may
  also allow one for an agent directly, from its Access, and there a host may be a pattern: `*.example.com`, any name
  under it, or `*`, every host, each at its scheme and port. An agent may ask for several at once, before it needs
  them (`ask_hosts`): one approval, its list editable, approved as if the owner had added each; it offers no scope, so
  every such ask asks. An agent that runs commands has both ways to ask, whatever its file lists. A host is allowed
  for the agent that asked, and covers only that agent's chats, as the proxy knows them by their logins; while the
  agents share one box, one agent's process can read another's login, so the binding is by login, not by the
  boundary, and the app says any agent there could use it. The daemon tells the proxy each chat's allowed hosts, in
  order and never an older config than the store's (a push that fails stops the proxy), so a write there goes straight
  through as it happens (a `git push` run again succeeds); the proxy records each, durably, before sending it, and the
  daemon logs it with its outcome and its bytes' hash. A WebSocket opened there (a relay, a live API) is such a write:
  its opening is what is recorded, its frames then pass unrecorded, and what its server sends is scrubbed of
  credentials; every other WebSocket is cut. A request carrying its own credential, and the browser's, are still held.
- **Credentials** for a host are swapped in at the proxy, from the daemon's `auth/`, so the box holds no secrets; a
  response that echoes one has it scrubbed. A request the box sends carrying a credential of its own is on the floor.
  A request that acts as nobody (`web_fetch`'s) gets none: the box can only ever give one up that way.

**The browser.** Each agent has its own browser: Chromium, headless in the box, started when first needed and closed
when idle, as a uid of its own whose profiles only it can read: the agents' commands never read its sessions, its cache
or its memory. Each agent's profile is its own, so what the owner signed in to for one agent no other acts with. The
daemon drives it over DevTools on a pipe through `docker exec`, never a port. Each chat has its own tab in its agent's
browser, so an agent's chats never take a page from each other. The browser reaches the proxy by its agent's login, and
the daemon stamps every request a tab lets go with that tab's chat and a mark only the daemon makes, replacing anything
the page set; the proxy takes the request as that chat's, only while the chat holds a tab there, and refuses one with no
valid stamp.
- **Snapshots, not pixels.** The agent reads a page as its accessibility tree, each element it may act on named by a
  ref bound to that snapshot; a ref from an earlier one is refused. A screenshot is a fallback.
- **Nothing secret reaches the model.** Snapshots and screenshots never carry a sensitive field's value: a field is
  sensitive by what it is (a password, a one-time code, a card) or because the owner typed into it. A key a page shows
  is a handle only the daemon turns into its value.
- **Browsing asks only as the owner.** Opening an address, clicking and typing run at once, and what a page loads on
  its own is the page's: the browser's reads go to public hosts. A site is signed in when the agent handed the owner its
  page to sign in there, kept before the browser is the agent's again; what goes with that session acts as the owner.
- **A signed-in site opens only as allowed.** A page of it (a top page, a frame, each hop of a redirect) opens only once
  the owner allowed it for the task: `browser_navigate` there asks "open the site as you", binding the site, for once
  or for the rest of the task; any other page load there is stopped and the agent told. Any other request there (a
  picture, a script, a page's read) is stopped too, unless its page is of an allowed signed-in site. Allowing the
  visit allows no send: typing there is a draft on the floor, its words the owner's to edit.
- **A page's write waits in the browser.** While the agent drives, a write reaches the proxy only once the daemon lets
  it go, logged as sent first, and the proxy lets exactly its method, address and body through once, for a minute at
  most. One that acts as nobody (no session of a signed-in site goes with it, no credential of its own, and no page or
  frame of a signed-in site made it) goes at once. Any other is a draft on the floor: the owner approves those bytes,
  every time. One carrying a sensitive value or a key is never drafted: only the owner sends it.
- **Take-over.** The owner watches the page live and takes it over from the app: while they hold it what the browser
  sends is theirs, and an agent's call that drives it waits for them, in a Wait that outlives a restart; taking it cuts
  a call at work short, and Stop ends a call at once. Given back, the call goes on with the page as they left it, what
  it was to do not done; the run's other tools never wait for the browser. Signing in or a passkey is the owner's:
  the agent hands over the page, and a session signed in to lives in the browser's profile, a credential the owner
  chose to hand over for that site, listed in Settings with a way to sign it out. A bot check is not handed over: a
  site that checks for bots does not serve the agent's browser, whoever clicks, so the agent goes elsewhere or says so.

## The workspace
The workspace is the band's folder, in the box: `agents/`, `connections/`, `routines/`, `watches/`, `skills/`,
`memory/`, and the files the agents work on. The daemon reads it over the box's connection, so no folder the box writes
sits on the owner's machine. The agent writes it and the owner edits it, so the daemon decides when a change takes
effect:
- **Before**: `agents/`, `connections/`, `routines/`, `watches/` and skill instructions take effect once the owner
  accepts the change. Accepting binds the hash of the bytes shown; the daemon keeps the accepted version in the store,
  and prompts and loading read only from there. Until then the accepted version stays in effect, and the tool that made
  the change tells the model so. The owner's own write through the app is accepted in the commit that stores it. The app
  shows the agent's change as a plain question ("Allow this change?"), not a diff.
- **After**: everything else, memory included, takes effect at once. Admission still guards every effect that leaves
  the box.
- The daemon opens workspace files without following symlinks.

Data the workspace holds is typed: `.json` with a schema the daemon checks on every read, and `.md` only where
free-form text is the point (instructions, personality, memory). `band.json` at the root is the band's own file: the
agents (by id) and groups (`group:<room>`) pinned to the top of the band, in the owner's order. It only orders what the
app shows, so it is an "after" file: in effect at once, whoever wrote it. With no file Sancho is pinned; the app writes
it when the owner pins or unpins, and never writes over one that does not fit its schema.

A skill is one shared prompt file, not an agent's private copy. Agents may load one by name; an owner's unquoted
`/name` invokes a known skill. The accepted instructions are loaded before that message's first model request, as
one recorded tool call and result; an earlier running request must not see the load without the owner's message. The
chat names only what loaded; Activity holds the exact result. Other files in a skill's folder remain box data, never
instructions the daemon loads from an unaccepted change. A skill may be owner-only (`disable-model-invocation: true`):
only the owner's /name loads it, agents never see it, and the app says so wherever the skill shows. banda ships a few
skills; first run offers them once, right after the provider, and the ones the owner keeps are written into the
workspace and accepted in that step, since banda wrote them and the owner chose them. The Skills page offers the
shipped skills the workspace lacks the same way, any time: adding one is the same choice, accepted by the hash of the
bytes banda wrote. A skill of that name already accepted is never replaced. The Skills page puts what waits on the
owner first, then every accepted skill in one flat list, marked where owner-only or where a change waits; nothing the
page is for hides behind a disclosure.

**Bringing your own.** An owner who already works with another harness on this computer (Claude Code, Codex, pi) has
skills and agents there. In the desktop app, first run offers those in place of banda's own: the owner picks harnesses,
sees everything they bring, and leaves any of it behind; bringing nothing goes on to banda's skills, bringing anything
means they are not offered. Settings offers the same any time. The daemon reads the harnesses' own folders on the
owner's computer, the only host files it reads for this, and only names and descriptions until a pick; a pick is read
again then, never taken from the request. A skill comes as its folder's text files (hidden files, links and files that
are not text stay behind) and its SKILL.md is accepted by the hash of the bytes written, as a shipped one is: the owner
chose it from their own computer. Since they saw its name and description, not every character, a SKILL.md with
characters nobody sees is refused, as an agent file is. An agent comes as a banda agent file with its name, description and instructions;
its own tools and model are another harness's words and stay behind. A skill or agent of that name already accepted is
left as it is; one the box wrote and nobody accepted is superseded, so a bring cut part way is finished by bringing
again.

## Trust
Laws (property-tested):
1. **Owner authority.** Only the owner, through a client holding the owner's token, starts owner work or fills an
   owner Wait or permission.
2. **Admission.** An effect that leaves the box runs only as an approved draft or within a permission, bound to content:
   exact arguments, hashes of referenced files, one account. No permission ever covers the floor.
3. **Least tools.** An agent runs only the tools its accepted file and the owner's switches give it; a group grants no
   member another's tools.
4. **Foreign content is data.** Another agent's answer and results from outside (pages, mail, a connection's reads)
   are framed as data and change nothing about admission.
5. **Integrity.** Nothing the box wrote is executed by the daemon, or changes who an agent is or what it may do,
   until the owner accepted it.
6. **Confidentiality.** Owner data leaves only through an admitted effect, or through what the policy lets go unasked:
   a read to a public host, and what the browser types and sends acting as nobody. Opening a signed-in site is an
   admitted effect, and anything sent with the owner's session or a credential is an effect on the floor.
7. **Structure over judgment.** A reviewer model may triage what to show the owner; it never permits anything.

What a chat read does not change what it may do: a standing permission covers an injected call as it covers any
other, within its exact arguments, and the floor still asks. So the permissions the daemon offers are worded as their
consequence, and the owner grants them knowing what they cover. A page that steers the agent can make it browse, type
and send anonymously, as any visitor could; it can never make it act as the owner unasked.

**The model provider** sees every prompt, owner data included. The app names it once, in Settings beside the tiers,
and the owner can choose a local model.

**Interrupted effects.** A tool declares its effect `idempotent` (retried with its stored key) or `unsafe`. An unsafe
effect interrupted by a crash opens an owner Wait (retry or skip); the model never re-issues it.

## Clients
The daemon alone opens the store. The app and a minimal CLI (`serve`, `say`, `approve`/`deny`/`answer`, `status`)
talk HTTP on loopback: Host and Origin checked, the owner's token on every API request. The app's own files are
public code and need no token. The token lives in `auth/token` and survives restarts; `serve` and `status` print the
app's link, which carries it in the URL fragment, so it never reaches a request or a log. Reads come from the harness
(entries paged, doc snapshots, task graph); live updates are SSE.

A device reaches the same API over Iroh, never through an open port: the daemon's one endpoint, its key in `auth/`
so its id outlives restarts, reached through n0's relays and discovery unless the owner says otherwise; one HTTP
request a bi-stream. Who asks over Iroh is the endpoint id the handshake authenticated, never a header or the token:
a paired device acts as the owner; any other endpoint reaches the pairing route alone and holds little while it does
(a small body, one stream at a time, short deadlines, a bounded number of such connections), since a key costs
nothing. The owner pairs a device on the computer banda runs on: an invite shown as a QR code, single use and live for
ten minutes. Before presenting it, the phone asks the owner to match the computer's code with the desktop; before
approving, the desktop asks them to match the phone's code. A link cannot silently change a phone's computer, and a
trial computer cannot erase an existing pairing. Devices are listed, renamed and revoked there too,
never from a device, so no device can mint access that outlives its own revocation. A device learns what it is from
the daemon's answer to the pairing route, never from how a connection closed: a restart or a dropped connection is
only dialed again.

## Home
`~/.banda` (`--home <dir>` or `BANDA_HOME`): `config.json`, `durable.db`, `search.db`, `blobs/`, `auth/`. The
workspace lives in the box.

## Open
- A monitor: a command in the box whose output a watch-like file follows, waking when it changes; it needs its own
  design, apart from watches.
- Push to a watch: a service's notification or webhook reaching the daemon, through a relay while the daemon is
  off; it only says when to look ("Watches"), and whether the relay keeps the bytes or only that one came is the
  owner's choice.
- A hand-off: one agent messaging another for a piece of work, visible to the owner in the receiving agent's chat.
- A "before" gate for the facts an agent writes to memory.
- Why a message said what it did: the facts and sources that shaped it, in one line the owner can tap.
- A box per agent, so workspace files, processes and logins are a boundary between agents.
- Approvals on the floor confirmed with the device's own authenticator (a passkey), so a tap on a forged screen cannot
  confirm them.
- Tools and connections the agent builds itself, offered once the owner accepts their definition.
- Packaging the box's runtime so no owner installs Docker: a bundled VM, Podman, or a managed host.
- Push to the phone without a vendor seeing the content: a notification that only says to open the app.
- A guest in a group, through an invite scoped to that group.
- Sending a copy of an agent's files to another banda.
- The daemon on an always-on machine (a home server or a VPS), with the phone as its client.
- Voice in the composer; the agent's voice.
- Replying to or quoting a message, so "do this with that" can point at a card from last week; pinning rows; a
  proactivity dial per agent.
- pi-durable is experimental, so the primitives live in one module.
