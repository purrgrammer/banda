/**
 * The specimen's index: every section, in the order the page shows them, with the group it sits in, what it is (in the
 * app, a proposal or an exploration), the files of the real components it shows, and whether it shows at one width only.
 * The nav, the page's order, `?section=` and each section's header read from here; a section not listed here does not
 * render (`stage.tsx` refuses it), and `registry.test.ts` holds the page to this list. README.md says how to add one.
 */

export type GroupId =
	| "foundation"
	| "chat"
	| "screens"
	| "agent"
	| "connections"
	| "harness"
	| "states"
	| "explorations";

/** `app`: the component as the app uses it. `proposal`: a UI for work not wired yet. `exploration`: a spike, no promise. */
export type Status = "app" | "proposal" | "exploration";

export type Width = "desktop" | "phone";

export type Group = { readonly id: GroupId; readonly title: string; readonly note: string };

export type Entry = {
	readonly id: string;
	readonly title: string;
	readonly group: GroupId;
	readonly status: Status;
	/** The files of the real components the section shows, from the repository's root; a proposal names its own file. */
	readonly sources: readonly string[];
	/** The one width the section shows at; absent, it shows at both. */
	readonly only?: Width;
};

/** The groups, from the most settled to the most provisional: the page and the nav follow this order. */
export const GROUPS: readonly Group[] = [
	{
		id: "foundation",
		title: "Foundation",
		note: "Colour, type, shape and motion as the tokens define them; faces, controls and words.",
	},
	{
		id: "chat",
		title: "Chat",
		note: "Everything a message can carry, every card, the lines no one said, and the composer.",
	},
	{
		id: "screens",
		title: "Screens",
		note: "Whole screens: the app, pinned agents, first run, a chat at work, a group, the band and search.",
	},
	{
		id: "agent",
		title: "Agent and panel",
		note: "An agent's panel and what opens there; a new agent and its face; memory, skills, tools and activity; Settings and devices.",
	},
	{
		id: "connections",
		title: "Connections",
		note: "The catalogue, connecting, and each service's objects as cards with their drafts.",
	},
	{
		id: "harness",
		title: "Harness",
		note: "A coding agent on the owner's computer at work in a chat; Claude Code here.",
	},
	{
		id: "states",
		title: "States",
		note: "Opening, empty and loading: wherever the app waits on the daemon or has nothing yet.",
	},
	{
		id: "explorations",
		title: "Explorations",
		note: "Spikes with no promise behind them. A new spike starts here and moves up once the design takes it.",
	},
];

/** What each status says in a section's header. */
export const STATUS_WORDS: Readonly<Record<Status, string>> = {
	app: "In the app",
	proposal: "Proposal",
	exploration: "Exploration",
};

const TOKENS = "web/src/styles/tokens.css";
const FEED = "web/src/chat/Feed.tsx";
const HEADER = "web/src/chat/Header.tsx";
const COMPOSER = "web/src/chat/Composer.tsx";
const BAND = "web/src/chat/Band.tsx";
const ROW = "web/src/chat/Row.tsx";
const LINE = "web/src/chat/Line.tsx";
const FIRST_RUN = "web/src/chat/FirstRun.tsx";
const PANEL = "web/src/chat/Panel.tsx";
const SETTINGS = "web/src/chat/Settings.tsx";
const SKILL = "web/src/chat/Skill.tsx";
const OBJECT = "web/src/chat/Object.tsx";
const DRAFT = "web/src/app/DraftApproval.tsx";
const CONNECT = "web/src/chat/Connect.tsx";
const HARNESS = "web/src/chat/Harness.tsx";
const DEVICES = "web/src/chat/Devices.tsx";
const LOADING = "web/src/chat/Loading.tsx";
const APPROVAL = "web/src/chat/Approval.tsx";
const FACE = "web/src/chat/Face.tsx";

/** Every section, in page order. Within a group the order is the order its components render in. */
export const SECTIONS: readonly Entry[] = [
	// Foundation
	{ id: "colour", title: "Colour", group: "foundation", status: "app", sources: [TOKENS] },
	{ id: "type", title: "Type", group: "foundation", status: "app", sources: [TOKENS] },
	{ id: "shape", title: "Shape", group: "foundation", status: "app", sources: [TOKENS] },
	{ id: "motion", title: "Motion", group: "foundation", status: "app", sources: [TOKENS, FACE] },
	{ id: "faces", title: "Faces", group: "foundation", status: "app", sources: [FACE] },
	{
		id: "controls",
		title: "Controls",
		group: "foundation",
		status: "app",
		sources: ["web/src/components/ui/", "web/src/app/Shortcuts.tsx"],
	},
	{ id: "words", title: "Words", group: "foundation", status: "app", sources: [LINE] },
	// Chat
	{ id: "messages", title: "Messages", group: "chat", status: "app", sources: [FEED] },
	{
		id: "source-links",
		title: "Source links",
		group: "chat",
		status: "app",
		sources: ["web/src/components/SourceLink.tsx", "web/src/components/Markdown.tsx"],
	},
	{
		id: "message-layout",
		title: "Message spacing",
		group: "chat",
		status: "app",
		sources: [FEED, "web/src/components/Markdown.tsx"],
	},
	{ id: "files", title: "Files", group: "chat", status: "app", sources: ["web/src/chat/Files.tsx"] },
	{ id: "voice", title: "Voice", group: "chat", status: "app", sources: ["web/src/chat/Voice.tsx"] },
	{ id: "cards", title: "Cards", group: "chat", status: "app", sources: ["web/src/chat/Cards.tsx"] },
	{
		id: "approvals",
		title: "Approvals",
		group: "chat",
		status: "app",
		sources: [APPROVAL, "web/src/chat/FileChanges.tsx"],
	},
	{ id: "working", title: "Working", group: "chat", status: "app", sources: [HEADER] },
	{ id: "lines", title: "Lines", group: "chat", status: "app", sources: [LINE] },
	{
		id: "routine-items",
		title: "Routines in the chat",
		group: "chat",
		status: "app",
		sources: ["web/src/chat/Routine.tsx", LINE],
	},
	{
		id: "watch-items",
		title: "Watches in the chat",
		group: "chat",
		status: "app",
		sources: ["web/src/chat/Watch.tsx", "web/src/lib/chat.ts", LINE],
	},
	{ id: "feed-lines", title: "What else the chat says", group: "chat", status: "app", sources: [LINE] },
	{ id: "composer", title: "Composer", group: "chat", status: "app", sources: [COMPOSER] },
	{ id: "object-in-chat", title: "An object in the chat", group: "chat", status: "app", sources: [OBJECT, FEED] },
	{ id: "done", title: "Done, folded", group: "chat", status: "app", sources: ["web/src/chat/Done.tsx", APPROVAL] },
	// Screens
	{ id: "app", title: "The app", group: "screens", status: "app", sources: [BAND, HEADER, FEED, COMPOSER] },
	{ id: "pinned", title: "Pinned", group: "screens", status: "app", sources: [BAND, ROW] },
	{ id: "pinned-alignment", title: "Pinned: left or centred", group: "screens", status: "app", sources: [BAND] },
	{
		id: "pinned-hold",
		title: "Pinning on the phone",
		group: "screens",
		status: "app",
		sources: [BAND, ROW],
		only: "phone",
	},
	{
		id: "app-chat",
		title: "A chat on the phone",
		group: "screens",
		status: "app",
		sources: [HEADER, FEED, COMPOSER],
		only: "phone",
	},
	{
		id: "app-keyboard",
		title: "Typing on the phone",
		group: "screens",
		status: "app",
		sources: [HEADER, FEED, COMPOSER],
		only: "phone",
	},
	{ id: "working-chat", title: "A chat at work", group: "screens", status: "app", sources: [HEADER, BAND] },
	{ id: "first-run", title: "First run", group: "screens", status: "app", sources: [FIRST_RUN] },
	{ id: "first-run-signing-in", title: "First run, signing in", group: "screens", status: "app", sources: [FIRST_RUN] },
	{
		id: "first-skills",
		title: "First run: skills",
		group: "screens",
		status: "app",
		sources: ["web/src/chat/FirstSkills.tsx"],
	},
	{
		id: "first-bring",
		title: "First run: bring your own",
		group: "screens",
		status: "app",
		sources: ["web/src/chat/FirstBring.tsx"],
	},
	{
		id: "bring-settings",
		title: "Settings: bring skills and agents",
		group: "screens",
		status: "app",
		sources: ["web/src/chat/FirstBring.tsx"],
	},
	{ id: "first-chat", title: "The first chat", group: "screens", status: "app", sources: [FIRST_RUN, CONNECT] },
	{ id: "group", title: "A group", group: "screens", status: "app", sources: [HEADER, FEED] },
	{
		id: "agent-meta-tools",
		title: "Agent-to-agent tools in a chat",
		group: "screens",
		status: "app",
		sources: ["web/src/chat/Proposal.tsx", LINE],
	},
	{ id: "rows", title: "Rows", group: "screens", status: "app", sources: [ROW] },
	{ id: "sidebar", title: "The sidebar", group: "screens", status: "app", sources: [BAND] },
	{ id: "search", title: "Search", group: "screens", status: "app", sources: ["web/src/chat/Search.tsx"] },
	// Agent and panel
	{ id: "panel-app", title: "A chat and its panel", group: "agent", status: "app", sources: [PANEL] },
	{ id: "thinking-tiers", title: "The thinking selector", group: "agent", status: "app", sources: [SETTINGS] },
	{
		id: "connections-signed-in",
		title: "Connections after sign-in",
		group: "agent",
		status: "app",
		sources: [SETTINGS],
	},
	{
		id: "panel",
		title: "The panel",
		group: "agent",
		status: "app",
		sources: [PANEL, SETTINGS, "web/src/chat/MemorySettings.tsx"],
	},
	{
		id: "open-file",
		title: "What opens in the panel",
		group: "agent",
		status: "app",
		sources: ["web/src/chat/Viewer.tsx", "web/src/chat/RoutineEditor.tsx", "web/src/app/watches.tsx", PANEL],
	},
	{
		id: "browser",
		title: "The browser, enlarged",
		group: "agent",
		status: "app",
		sources: ["web/src/chat/Browser.tsx"],
	},
	{
		id: "new-agent",
		title: "A new agent",
		group: "agent",
		status: "app",
		sources: [SETTINGS, "web/src/app/NewSheet.tsx"],
	},
	{ id: "new-group", title: "A new group", group: "agent", status: "app", sources: [SETTINGS] },
	{ id: "archive", title: "Archive", group: "agent", status: "app", sources: [SETTINGS] },
	{
		id: "avatar-creator",
		title: "Choose a face",
		group: "agent",
		status: "app",
		sources: ["web/src/avatar/Choices.tsx", FACE],
	},
	{
		id: "avatar-candidate",
		title: "A generated face",
		group: "agent",
		status: "app",
		sources: ["web/src/avatar/CandidateCard.tsx", "web/src/avatar/DescribeFace.tsx"],
	},
	{ id: "scoped-memory", title: "Memory", group: "agent", status: "app", sources: ["web/src/chat/MemorySettings.tsx"] },
	{ id: "skills", title: "Skills", group: "agent", status: "app", sources: [SKILL, COMPOSER] },
	{
		id: "skill-activity",
		title: "Skill in Activity",
		group: "agent",
		status: "app",
		sources: [SKILL, "web/src/chat/ActivityDetail.tsx"],
	},
	{
		id: "skills-page",
		title: "Skills page",
		group: "agent",
		status: "app",
		sources: ["web/src/app/Skills.tsx", SKILL],
	},
	{ id: "skill-form", title: "Skill form", group: "agent", status: "app", sources: ["web/src/app/Skills.tsx"] },
	{ id: "skill-detail", title: "Skill detail", group: "agent", status: "app", sources: [SKILL] },
	{ id: "skills-about", title: "Skills in an agent's About", group: "agent", status: "app", sources: [SKILL, PANEL] },
	{
		id: "toolsets",
		title: "Agent tools",
		group: "agent",
		status: "proposal",
		sources: ["web/src/specimen/agent/toolsets.tsx", "src/core/toolsets.ts"],
	},
	{
		id: "activity",
		title: "Activity",
		group: "agent",
		status: "app",
		sources: ["web/src/app/Activity.tsx", "web/src/chat/ActivityDetail.tsx", HEADER, FEED],
	},
	{ id: "settings", title: "Settings", group: "agent", status: "app", sources: [SETTINGS] },
	{ id: "settings-tabs", title: "Settings, each tab", group: "agent", status: "app", sources: [SETTINGS] },
	{ id: "settings-providers", title: "Settings, providers", group: "agent", status: "app", sources: [SETTINGS] },
	{ id: "devices", title: "Devices", group: "agent", status: "app", sources: [DEVICES, SETTINGS] },
	{ id: "devices-states", title: "Devices, each state", group: "agent", status: "app", sources: [DEVICES] },
	{
		id: "pair-phone",
		title: "Pairing, on the phone",
		group: "agent",
		status: "app",
		sources: ["web/src/chat/PairPhone.tsx"],
	},
	{ id: "qr", title: "QR code", group: "agent", status: "app", sources: ["web/src/components/QrCode.tsx"] },
	// Connections
	{
		id: "connections",
		title: "Connections",
		group: "connections",
		status: "app",
		sources: ["web/src/chat/Catalogue.tsx", SETTINGS],
	},
	{ id: "connect", title: "Connecting", group: "connections", status: "app", sources: [CONNECT] },
	{
		id: "github",
		title: "GitHub",
		group: "connections",
		status: "app",
		sources: [OBJECT, "web/src/app/Objects.tsx", DRAFT, APPROVAL],
	},
	{
		id: "gmail",
		title: "Gmail",
		group: "connections",
		status: "app",
		sources: [OBJECT, "web/src/app/EmailDraftPreview.tsx", CONNECT],
	},
	{ id: "calendar", title: "Google Calendar", group: "connections", status: "app", sources: [OBJECT, DRAFT] },
	{ id: "contacts", title: "Google Contacts", group: "connections", status: "app", sources: [OBJECT, DRAFT] },
	{ id: "drive", title: "Google Drive", group: "connections", status: "app", sources: [OBJECT, DRAFT] },
	{
		id: "mcp",
		title: "Add an MCP connection",
		group: "connections",
		status: "app",
		sources: ["web/src/app/McpSetup.tsx", "web/src/chat/McpConnection.tsx"],
	},
	// Harness
	{
		id: "harness",
		title: "Claude Code in a chat",
		group: "harness",
		status: "app",
		sources: [HARNESS, "web/src/chat/FolderPicker.tsx"],
	},
	{ id: "harness-states", title: "A session, every state", group: "harness", status: "app", sources: [HARNESS] },
	{ id: "harness-headlines", title: "The card's one line", group: "harness", status: "app", sources: [HARNESS] },
	{
		id: "harness-asks",
		title: "Its asks, one at a time",
		group: "harness",
		status: "app",
		sources: ["web/src/app/HarnessSession.tsx", HARNESS],
	},
	{
		id: "harness-header",
		title: "Delegated activity in the header",
		group: "harness",
		status: "app",
		sources: [HEADER, HARNESS],
	},
	{
		id: "harness-panel",
		title: "Claude Code in the panel",
		group: "harness",
		status: "app",
		sources: [HARNESS, PANEL],
	},
	{ id: "harness-sheet", title: "The steps sheet", group: "harness", status: "app", sources: [HARNESS] },
	// States
	{ id: "loading-app", title: "Opening the app", group: "states", status: "app", sources: [LOADING, BAND, PANEL] },
	{
		id: "empty-chat",
		title: "A new agent's chat",
		group: "states",
		status: "app",
		sources: [FIRST_RUN, "web/src/app/first-words.ts"],
	},
	{
		id: "states",
		title: "Empty and loading",
		group: "states",
		status: "app",
		sources: [LOADING, "web/src/chat/Search.tsx", SETTINGS],
	},
	// Explorations
	{
		id: "avatar-icon",
		title: "App icon",
		group: "explorations",
		status: "exploration",
		sources: ["web/src/avatar/Renderer.tsx"],
	},
];

const BY_ID: ReadonlyMap<string, Entry> = new Map(SECTIONS.map((entry) => [entry.id, entry]));

/** The section with this id, or nothing. */
export const sectionOf = (id: string): Entry | undefined => BY_ID.get(id);

/** Whether a section with this id is registered. */
export const isSection = (id: string): boolean => BY_ID.has(id);

/** The sections of one group, in page order. */
export const sectionsOf = (group: GroupId): readonly Entry[] => SECTIONS.filter((entry) => entry.group === group);
