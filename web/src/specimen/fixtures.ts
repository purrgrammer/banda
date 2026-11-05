/** The specimen's data: one band, its chats, and pictures drawn in SVG so nothing loads from outside. */
import { getExample } from "open-bot-avatar";
import type { FileUIPart } from "@/components/ai-elements/types";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import type { Service } from "../chat/Catalogue.tsx";
import type { CheckRun, Issue, PullRequest } from "../chat/Object.tsx";
import type { RoutineRowView } from "../chat/Panel.tsx";
import type { RowView, Who } from "../chat/Row.tsx";

export function sampleFace(shape: string, color: string) {
	const definition = getExample(shape);
	if (!definition) throw new Error(`Missing specimen shape: ${shape}`);
	return { definition, color };
}
export const SANCHO: Who = { face: defaultAvatarFace(), name: "Sancho" };
export const MARA: Who = { face: sampleFace("mug", "#e48c54"), name: "Mara" };
export const OCTO: Who = { face: sampleFace("controller", "#8b85d0"), name: "Octo" };
export const ATLAS: Who = { face: sampleFace("lightbulb", "#d4ae47"), name: "Atlas" };
export const OTTO: Who = { face: sampleFace("sprout", "#56a875"), name: "Otto" };

const svg = (body: string, w = 640, h = 420) =>
	`data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;

/** A coast at dusk: the owner's photo. */
export const PHOTO = svg(
	`<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4b183"/><stop offset=".55" stop-color="#f7d9b5"/><stop offset="1" stop-color="#9ec5d6"/></linearGradient></defs><rect width="640" height="420" fill="url(#s)"/><circle cx="430" cy="230" r="46" fill="#fff3dc"/><path d="M0 300 C120 270 220 320 330 292 S540 260 640 288 V420 H0Z" fill="#5f8fa6"/><path d="M0 350 C160 330 300 370 460 342 S600 330 640 340 V420 H0Z" fill="#3f6f86"/><path d="M0 250 L90 190 L160 240 L230 170 L330 262 L0 262Z" fill="#7d6a64" opacity=".55"/>`,
);
/** A page in the agent's browser: a flight search. */
export const PAGE = svg(
	`<rect width="640" height="400" fill="#fff"/><rect width="640" height="56" fill="#0b3a6b"/><rect x="24" y="18" width="120" height="20" rx="4" fill="#fff" opacity=".9"/><rect x="24" y="80" width="592" height="64" rx="10" fill="#eef2f6"/><g fill="#d7dee6"><rect x="24" y="168" width="592" height="56" rx="10"/><rect x="24" y="236" width="592" height="56" rx="10"/><rect x="24" y="304" width="592" height="56" rx="10"/></g><g fill="#0b3a6b"><rect x="44" y="186" width="160" height="10" rx="5"/><rect x="44" y="254" width="140" height="10" rx="5"/><rect x="44" y="322" width="180" height="10" rx="5"/></g><g fill="#1f8a5b"><rect x="520" y="184" width="76" height="20" rx="6"/><rect x="520" y="252" width="76" height="20" rx="6"/><rect x="520" y="320" width="76" height="20" rx="6"/></g>`,
	640,
	400,
);
/** A video's first frame: a street. */
export const POSTER = svg(
	`<rect width="640" height="360" fill="#2b3440"/><rect y="230" width="640" height="130" fill="#3d4652"/><g fill="#f2c14e" opacity=".85"><rect x="40" y="70" width="70" height="160"/><rect x="140" y="40" width="90" height="190"/><rect x="420" y="60" width="80" height="170"/><rect x="520" y="90" width="80" height="140"/></g><rect x="290" y="280" width="60" height="6" fill="#fff" opacity=".7"/>`,
	640,
	360,
);

export const ROWS: readonly RowView[] = [
	{
		id: "mara",
		name: "Mara",
		faces: [MARA],
		excerpt: "Found three under €300.",
		time: "10:42",
		ask: "book the 9:15 to Lisbon?",
		state: "waiting",
	},
	{
		id: "octo",
		name: "Octo",
		faces: [OCTO],
		excerpt: "CI is green again on #34.",
		time: "10:31",
		unread: 2,
		state: "working",
	},
	{
		id: "trip",
		name: "Trip",
		faces: [SANCHO, MARA],
		excerpt: "Saturday works for both.",
		by: "Sancho",
		time: "9:58",
		unread: 5,
	},
	{
		id: "sancho",
		name: "Sancho",
		faces: [SANCHO],
		excerpt: "Thanks, that's all for today.",
		by: "You",
		time: "Yesterday",
	},
	{
		id: "atlas",
		name: "Atlas",
		faces: [ATLAS],
		excerpt: "Morning brief: three things today.",
		time: "Mon",
		paused: true,
	},
	{ id: "desk", name: "Desk", faces: [SANCHO, OCTO, ATLAS], excerpt: "Merged.", by: "Octo", time: "Sun" },
];

export const PR: PullRequest = {
	repo: "purrgrammer/banda",
	number: 34,
	title: "One word per thing: chat, source, poll, extension",
	state: "open",
	author: "bandarra",
	branch: "terminology",
	checks: { passed: 11, failed: 0, running: 0 },
	reviews: "Octo approved",
	added: 412,
	removed: 380,
};

export const ATTACHED: (FileUIPart & { id: string })[] = [
	{ id: "a1", type: "file", mediaType: "image/svg+xml", filename: "coast.jpg", url: PHOTO },
	{ id: "a2", type: "file", mediaType: "application/pdf", filename: "Booking terms.pdf", url: "#" },
	{ id: "a3", type: "file", mediaType: "video/mp4", filename: "street.mov", url: "#" },
];

export const VOICE = [
	{ text: "Can you find", startSecond: 0, endSecond: 0.8 },
	{ text: "a flight to Lisbon", startSecond: 0.8, endSecond: 1.9 },
	{ text: "for the long weekend,", startSecond: 1.9, endSecond: 3.1 },
	{ text: "morning, window seat?", startSecond: 3.1, endSecond: 4.6 },
];

export const REPLY_VOICE = [
	{ text: "Three flights fit.", startSecond: 0, endSecond: 1.2 },
	{ text: "The 9:15 is the one I'd take:", startSecond: 1.2, endSecond: 2.9 },
	{ text: "€214, a window seat left.", startSecond: 2.9, endSecond: 4.4 },
];

export const PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", by: "sign-in" },
	{ id: "openai", name: "OpenAI", by: "sign-in" },
	{ id: "github-copilot", name: "GitHub Copilot", by: "sign-in" },
	{ id: "google", name: "Google", by: "key", keyUrl: "https://aistudio.google.com/apikey" },
	{ id: "openrouter", name: "OpenRouter", by: "key", note: "Use a key · many models" },
	{ id: "xai", name: "xAI", by: "key" },
] as const;

export const ROUTINES: readonly RoutineRowView[] = [
	{ id: "umbrella", name: "Umbrella check", when: "Weekdays at 9:00", waiting: "set up" },
	{
		id: "pr-watch",
		name: "PR watch",
		when: "Every weekday at 8:00",
		next: "Tomorrow 8:00",
		last: "Last ran today 08:00",
	},
	{
		id: "release",
		name: "Release notes",
		when: "Fridays at 17:00",
		next: "Fri 17:00",
		last: "Last ran Fri 09:00",
	},
	{ id: "deps", name: "Stale dependencies", when: "On the 1st of each month", next: "1 Dec", paused: true },
];

export const ACCOUNTS = [
	{ id: "gh-bandarra", connection: "GitHub", login: "@bandarra", agents: ["Mara", "Octo"] },
	{ id: "gh-purrgrammer", connection: "GitHub", login: "@purrgrammer", agents: ["Octo"] },
] as const;

export const FACTS = [
	{ id: "m0000000000", text: "Prefers window seats and morning flights." },
	{ id: "m0000000001", text: "Budget for weekend trips: under €300 a person." },
	{ id: "m0000000002", text: "Sister Ana lives in Lisbon." },
	{ id: "m0000000003", text: "Writes in English; reads Spanish and Portuguese." },
];

export const PERMISSIONS = [
	{ what: "Comment on pull requests in purrgrammer/banda", scope: "Always" },
	{ what: "Book flights under €300", scope: "Until Sunday" },
];

export const ISSUE: Issue = {
	repo: "purrgrammer/banda",
	number: 41,
	title: "The panel loses the open file on reload",
	state: "open",
	author: "ana-k",
	labels: ["bug", "web"],
	comments: 3,
	assignee: "bandarra",
};

export const CHECK_RUN: CheckRun = {
	repo: "purrgrammer/banda",
	pr: 34,
	name: "test (node 26)",
	state: "failed",
	step: "npm test",
	took: "3m 12s",
	log: [
		"FAIL test/routines.test.ts > a paused routine never fires",
		"  expected 0 runs, got 1",
		"    at test/routines.test.ts:88:21",
	],
};

export const SERVICES: readonly Service[] = [
	{ id: "github", name: "GitHub", does: "Pull requests, issues, checks", accounts: ["@bandarra", "@purrgrammer"] },
	{ id: "gmail", name: "Gmail", does: "Read and draft email" },
	{ id: "calendar", name: "Google Calendar", does: "Your days and invites" },
	{ id: "linear", name: "Linear", does: "Issues and cycles" },
	{ id: "slack", name: "Slack", does: "Channels and messages" },
	{ id: "notion", name: "Notion", does: "Pages and databases" },
];

/** Settings' providers, one of each state: in use, connected, connecting, failed, by sign-in and by key. */
export const SETTINGS_PROVIDERS: readonly import("../chat/Settings.tsx").ProviderRow[] = [
	{ id: "anthropic", name: "Anthropic", by: "sign-in", connected: true },
	{ id: "openai", name: "OpenAI", by: "sign-in", connected: true },
	{ id: "github-copilot", name: "GitHub Copilot", by: "sign-in", connected: false, connecting: true },
	{ id: "google", name: "Google", by: "key", connected: false, error: "the key was refused" },
	{ id: "mistral", name: "Mistral", by: "key", connected: false },
	{ id: "groq", name: "Groq", by: "key", connected: false },
];

export const SETTINGS: import("../chat/Settings.tsx").SettingsData = {
	provider: { id: "anthropic", name: "Anthropic" },
	models: { quick: "Claude Haiku 5.5", balanced: "Claude Sonnet 5.5", deep: "Claude Opus 5.5" },
	accounts: [...ACCOUNTS],
	archived: [],
	theme: "system",
	paused: false,
	notify: "off",
	computer: { state: "up", box: "container", network: "guarded" },
	signedIn: [{ agent: { ...MARA, id: "mara" }, site: "renfe.com", when: "2 Nov" }],
};
