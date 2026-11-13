/** The panel, settings and connections: the agent beside its chat, what opens there, and the pages behind the gear. */
import { FileTextIcon, UserRoundPlusIcon, UsersIcon } from "lucide-react";
import { isValidElement, type ReactNode, useContext } from "react";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import type { RoutineRunView } from "../../../../src/server/api.ts";
import { MakeTabsList } from "../../app/NewSheet.tsx";
import { WatchDetail } from "../../app/watches.tsx";
import { Band } from "../../chat/Band.tsx";
import { BrowserWindow } from "../../chat/Browser.tsx";
import type { FaceState } from "../../chat/Face.tsx";
import { PaneHeader } from "../../chat/Header.tsx";
import { MemorySettings } from "../../chat/MemorySettings.tsx";
import {
	AgentPanel,
	firstTab,
	GroupPanel,
	Panel,
	type PanelTab,
	type RoutineRowView,
	Routines,
	Watching,
	type WatchRowView,
} from "../../chat/Panel.tsx";
import { RoutineDetail } from "../../chat/RoutineDetail.tsx";
import { RoutineEditor } from "../../chat/RoutineEditor.tsx";
import type { Who } from "../../chat/Row.tsx";
import {
	Archive,
	ArchiveConfirm,
	ArchivedAgents,
	ArchivedGroups,
	type ConnectionRow,
	Connections,
	FaceAndName,
	GroupLimitsBlock,
	Members,
	Permissions,
	Personality,
	SettingsPage,
	ThinkingTiers,
} from "../../chat/Settings.tsx";
import { SkillCatalogue } from "../../chat/Skill.tsx";
import { ArtifactViewer, FileViewer, Versions } from "../../chat/Viewer.tsx";
import { sayFailed } from "../../lib/attempt.ts";
import { runRows } from "../../lib/routine-runs.ts";
import {
	ATLAS,
	FACTS,
	MARA,
	OCTO,
	OTTO,
	PAGE,
	PERMISSIONS,
	PHOTO,
	ROUTINES,
	ROWS,
	SANCHO,
	WATCH_CONTACT_VIEW,
	WATCH_VIEW,
	WATCHES,
} from "../fixtures.ts";
import { MaraChat } from "../screens/screens.tsx";
import { Group, Labelled, Section, StageContext } from "../stage.tsx";
import { SKILLS, skillHref } from "./skills.tsx";

const ITINERARY = `Lisbon, 14 to 16 November

Friday
9:15 TP 1351 from Madrid, window 14A, lands 9:35
Check in at Casa do Largo, Alfama, from 14:00
Dinner with Ana at 20:30

Saturday
Belém in the morning, before the queues
Free afternoon

Sunday
18:40 TP 1358 home`;

const VERSIONS = [
	{ n: 3, when: "today 10:44", by: "You" },
	{ n: 2, when: "today 10:43", by: "Mara" },
	{ n: 1, when: "today 10:40", by: "Mara" },
];

const GITHUB_ROWS = [
	{
		connection: "GitHub",
		accounts: [
			{ login: "@bandarra", account: "bandarra", on: true },
			{ login: "@purrgrammer", account: "purrgrammer", on: false },
		],
	},
];

/** A fixed time the specimen's next runs are read from: Monday 2 November 2026, 09:00. */
const SPECIMEN_NOW = new Date(2026, 10, 2, 9, 0).getTime();

/** A routine's runs as the daemon reads them: Morning brief, weekdays at 08:00, Mara's chat 12. */
const at = (daysAgo: number) => SPECIMEN_NOW - daysAgo * 86_400_000 - 60 * 60_000;
const MORNING_RUNS: readonly RoutineRunView[] = [
	{ at: at(0), state: "said", said: "2 PRs need you: #34 has red checks", line: { chat: 12, entry: 40 } },
	{ at: at(3), state: "quiet" },
	{ at: at(4), state: "quiet" },
	{ at: at(5), state: "said", said: "CI is red on #34", line: { chat: 12, entry: 31 } },
	{ at: at(5) + 3 * 60 * 60_000, owner: true, state: "quiet" },
	{ at: at(6), state: "skipped", skipped: "running" },
	{ at: at(7), state: "quiet" },
];
const FAILED_RUNS: readonly RoutineRunView[] = [
	{ at: SPECIMEN_NOW - 60_000, state: "running" },
	{ at: at(1), state: "failed", why: "the model failed: rate limited", line: { chat: 12, entry: 52 } },
	{ at: at(2), state: "said", said: "Nothing on your plate before 11:00", line: { chat: 12, entry: 47 } },
	{ at: at(3), state: "quiet" },
];
const rows = (runs: readonly RoutineRunView[]) => runRows(runs, SPECIMEN_NOW, "Mara", 12, () => {});
/** A save slow enough to see the selector's saving state. */
const slowly = () => new Promise<void>((resolve) => setTimeout(resolve, 1500));

/** An agent's panel with its four tabs filled; `tab` picks the one open. */
function AgentPanelOf({
	who,
	phone = false,
	tab,
	state,
	routines = ROUTINES,
	watches = WATCHES,
	paused = false,
	facts = FACTS,
	permissions = PERMISSIONS,
	connections = GITHUB_ROWS,
}: {
	who: Who;
	phone?: boolean;
	tab?: PanelTab;
	state?: FaceState;
	routines?: readonly RoutineRowView[];
	watches?: readonly WatchRowView[];
	paused?: boolean;
	facts?: readonly { id: string; text: string }[];
	permissions?: readonly { what: string; scope: string }[];
	connections?: readonly ConnectionRow[];
}) {
	return (
		<Panel name={who.name} phone={phone}>
			<AgentPanel
				who={who}
				onIdentity={() => {}}
				paused={paused}
				tab={
					tab ?? firstTab({ routines: routines.length, connected: connections.some((row) => row.accounts.length > 0) })
				}
				{...(state === undefined ? {} : { state })}
				routines={
					<>
						<Routines agent={who.name} routines={routines} allPaused={paused} />
						<Watching agent={who.name} watches={watches} allPaused={paused} onFollow={async () => {}} />
					</>
				}
				access={
					<>
						<Connections agent={who.name} rows={connections} />
						<Permissions agent={who.name} permissions={permissions} />
					</>
				}
				memory={
					<MemorySettings
						agent={{ id: "specimen", name: who.name }}
						phone={phone}
						memory={{
							facts: facts.map((fact) => ({ ...fact, scope: "agent" as const, agent: "specimen" })),
							budget: 4000,
						}}
						onAdd={async () => {}}
						onEdit={async () => {}}
						onForget={async () => {}}
					/>
				}
				about={
					<>
						<Personality text="Warm and brief. Plans our family trips, keeps to the budget, and asks before booking anything." />
						<SkillCatalogue skills={SKILLS} hrefFor={skillHref} />
						<ThinkingTiers tier="balanced" custom={false} save={slowly} onFailed={() => {}} />
						<Archive agent={who.name} />
					</>
				}
			/>
		</Panel>
	);
}

export function PanelSections() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<>
			<Section
				id="panel-app"
				note="The panel opens beside the chat for what needs room; here a routine's line opened it. On the phone it is a sheet."
				bleed
				wide
			>
				{phone ? null : <Band rows={ROWS} selected="mara" />}
				{phone ? null : <MaraChat panelOpen />}
				<AgentPanelOf who={MARA} state="waiting" phone={phone} tab="routines" />
			</Section>
			<Section
				id="thinking-tiers"
				note="A pick shows at once with a spinner while it saves. The second one's save fails: it goes back to Balanced, with a notice and Try again."
			>
				<div className="flex max-w-md flex-col gap-6">
					<ThinkingTiers tier="balanced" custom={false} save={slowly} onFailed={() => {}} />
					<ThinkingTiers
						tier="balanced"
						custom={false}
						save={() => slowly().then(() => Promise.reject(new Error("refused")))}
						onFailed={(error, retry) => sayFailed("change how hard it thinks", error, retry)}
					/>
					<ThinkingTiers tier="deep" custom save={slowly} onFailed={() => {}} />
					<ThinkingTiers tier={undefined} custom={false} save={slowly} onFailed={() => {}} />
				</div>
			</Section>
			<Section
				id="connections-signed-in"
				note="One row per account the agent uses, with Remove; a connection with no account name is its own row."
			>
				<div className="max-w-md">
					<Connections
						agent="Sancho"
						rows={[
							{
								connection: "GitHub",
								id: "github",
								accounts: [{ login: "@purrgrammer", account: "purrgrammer", on: true }],
							},
							{
								connection: "Gmail",
								id: "gmail",
								accounts: [
									{ login: "bandarra@example.com", account: "bandarra@example.com", on: true },
									{ login: "work@example.com", account: "work@example.com", on: false },
								],
							},
							{
								connection: "Vercel",
								icon: (
									<svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
										<path d="M12 3 24 23H0Z" fill="currentColor" />
									</svg>
								),
								accounts: [{ login: "Vercel", on: true }],
							},
							{ connection: "My workspace", accounts: [{ login: "My workspace", on: true }] },
						]}
					/>
				</div>
			</Section>
			<Section id="panel" note="The agent's home: routines, access, memory and who it is.">
				<div className="flex flex-wrap items-start gap-4">
					<Specimen label="Routines">
						<AgentPanelOf who={MARA} state="waiting" />
					</Specimen>
					<Specimen label="Access: connections, then what it may do without asking">
						<AgentPanelOf who={MARA} tab="access" />
					</Specimen>
					<Specimen label="Memory">
						<AgentPanelOf who={MARA} tab="memory" />
					</Specimen>
					<Specimen label="About">
						<AgentPanelOf who={MARA} tab="about" />
					</Specimen>
					<Specimen label="Nothing yet: it opens on Access">
						<AgentPanelOf
							who={OCTO}
							routines={[]}
							facts={[]}
							permissions={[]}
							connections={[{ connection: "GitHub", accounts: [] }]}
						/>
					</Specimen>
					<Specimen label="Connected, no routines: it opens on About">
						<AgentPanelOf who={SANCHO} routines={[]} facts={[]} permissions={[]} />
					</Specimen>
					<Specimen label="No routines or watches yet: Add takes a link">
						<AgentPanelOf who={OCTO} tab="routines" routines={[]} watches={[]} />
					</Specimen>
					<Specimen label="Every watch's state: looking, waiting for you, can't reach, behind, paused at its wakes a day, done, ended by authority">
						<Panel name="Mara">
							<Watching agent="Mara" watches={WATCHES} onFollow={async () => {}} />
						</Panel>
					</Specimen>
					<Specimen label="Add, its first look running">
						<Panel name="Octo">
							<Watching
								agent="Octo"
								watches={[]}
								form={{ step: "looking", link: "https://github.com/purrgrammer/banda/pull/142" }}
								onFollow={() => new Promise(() => {})}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Add, refused in the daemon's words">
						<Panel name="Octo">
							<Watching
								agent="Octo"
								watches={WATCHES.slice(0, 1)}
								form={{
									step: "refused",
									link: "https://gitlab.com/acme/banda/-/merge_requests/7",
									why: "no connection you have can follow that link",
								}}
								onFollow={async () => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Nothing remembered yet">
						<AgentPanelOf who={OCTO} tab="memory" facts={[]} />
					</Specimen>
					<Specimen label="Atlas, routines paused">
						<AgentPanelOf who={ATLAS} routines={ROUTINES.slice(0, 2)} paused />
					</Specimen>
					<Specimen label="A group: its members, and who may join">
						<Panel name="Trip">
							<GroupPanel
								name="Trip"
								members={[SANCHO, { ...MARA, state: "working" }]}
								others={[OCTO, ATLAS]}
								onArchive={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="A group nobody is in yet">
						<Panel name="New group">
							<GroupPanel name="New group" members={[]} others={[SANCHO, MARA, OCTO]} onRemove={() => {}} />
						</Panel>
					</Specimen>
					<Specimen label="A group at the most Settings allows">
						<Panel name="Desk">
							<GroupPanel name="Desk" members={[SANCHO, MARA]} others={[OCTO, ATLAS]} most={2} onRemove={() => {}} />
						</Panel>
					</Specimen>
				</div>
			</Section>
			<Section
				id="routine-detail"
				note="A routine's row opens it in the same panel: Pause or Resume, Edit, and its runs in words. A run that spoke opens its line in the chat; silence is quiet."
			>
				<div className="flex flex-wrap items-start gap-4">
					<Specimen label="With runs">
						<Panel name="Mara">
							<RoutineDetail
								routine={{
									title: "Morning brief",
									when: "Weekdays at 08:00 · next tomorrow 08:00",
									paused: false,
									runs: rows(MORNING_RUNS),
									earlier: true,
								}}
								onBack={() => {}}
								onEdit={() => {}}
								onPause={() => {}}
								onEarlier={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="None yet">
						<Panel name="Mara">
							<RoutineDetail
								routine={{
									title: "Portugal fun fact",
									when: "Mondays at 09:00 · next Mon 09:00",
									paused: false,
									runs: [],
									earlier: false,
								}}
								onBack={() => {}}
								onEdit={() => {}}
								onPause={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Paused">
						<Panel name="Mara">
							<RoutineDetail
								routine={{
									title: "PR watch",
									when: "Every 2 hours",
									paused: true,
									runs: rows(MORNING_RUNS.slice(1, 4)),
									earlier: false,
								}}
								onBack={() => {}}
								onEdit={() => {}}
								onPause={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="One failed, one running">
						<Panel name="Mara">
							<RoutineDetail
								routine={{
									title: "Morning brief",
									when: "Weekdays at 08:00 · next tomorrow 08:00",
									paused: false,
									runs: rows(FAILED_RUNS),
									earlier: false,
								}}
								onBack={() => {}}
								onEdit={() => {}}
								onPause={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="A change waits; routines are off">
						<Panel name="Mara">
							<RoutineDetail
								routine={{
									title: "Morning brief",
									when: "Weekdays at 08:00",
									paused: false,
									allPaused: true,
									waiting: "Mara asks to change it. Answer in the chat or the list.",
									runs: rows(MORNING_RUNS.slice(0, 2)),
									earlier: false,
									full: true,
								}}
								onBack={() => {}}
								onEdit={() => {}}
								onPause={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Paused itself; Resume refused">
						<Panel name="Mara">
							<RoutineDetail
								routine={{
									title: "Inbox sweep",
									when: "Every 15 minutes",
									paused: true,
									pausedWhy: "it ran the most times a day it may",
									runs: rows([
										{ at: at(0), state: "skipped", skipped: "limit" },
										{ at: at(0) - 15 * 60_000, state: "quiet" },
									]),
									refused: "Mara is archived: restore it to run its routines",
									earlier: false,
								}}
								onBack={() => {}}
								onEdit={() => {}}
								onPause={() => {}}
							/>
						</Panel>
					</Specimen>
				</div>
			</Section>
			<Section
				id="open-file"
				note="A file in full, an artifact and its versions, a routine's editor, a watch's detail and its editor."
			>
				<div className="flex flex-wrap items-start gap-4">
					<Specimen label="A PDF, its first page">
						<Panel name="Mara">
							<FileViewer
								size="1.2 MB · 12 pages"
								file={{
									kind: "pdf",
									name: "Booking terms.pdf",
									pages: 12,
									title: "Booking terms and conditions",
									lines: [
										"1. Who these terms are between",
										"These terms are between you and Alfama Stays, Rua dos Remédios 12, Lisbon.",
										"2. Your booking",
										"A booking is confirmed once paid in full. A deposit of 30% holds it for 7 days.",
										"3. Cancelling",
										"Free until 14 days before arrival; after that, the deposit is kept.",
									],
								}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="An image">
						<Panel name="Mara">
							<FileViewer size="2.4 MB" file={{ kind: "image", name: "coast.jpg", src: PHOTO }} />
						</Panel>
					</Specimen>
					<Specimen label="A sheet, as a table">
						<Panel name="Mara">
							<FileViewer
								size="8 KB"
								file={{
									kind: "sheet",
									name: "Flights.csv",
									rows: [
										["Flight", "Leaves", "Price", "Seat"],
										["TP 1351", "9:15", "€214", "14A"],
										["IB 3104", "7:05", "€189", "22F"],
										["UX 1153", "11:40", "€241", "9A"],
										["FR 6342", "6:30", "€96", "—"],
									],
								}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Code, readable">
						<Panel name="Octo">
							<FileViewer
								size="2 KB"
								file={{
									kind: "text",
									name: "routines.test.ts",
									language: "typescript",
									text: `test("a paused routine never fires", async () => {\n  const home = await tempHome();\n  await pause(home, "pr-watch");\n  await advance(home, hours(24));\n  expect(await runs(home, "pr-watch")).toHaveLength(0);\n});`,
								}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="An artifact, the newest">
						<Panel name="Mara">
							<ArtifactViewer agent="Mara" title="Lisbon itinerary" versions={VERSIONS} showing={3} body={ITINERARY} />
						</Panel>
					</Specimen>
					<Specimen label="An artifact opened in the main pane">
						<div className="w-80 max-w-full overflow-hidden rounded-tile border border-line-soft bg-paper">
							<PaneHeader
								title="Lisbon itinerary"
								parent={{ title: "Mara", href: "#/specimen?section=panel-app" }}
								icon={<FileTextIcon />}
								detail={<p className="text-meta text-ink-2">Document · version 3</p>}
							/>
							<p className="whitespace-pre-line p-4 text-ui">{ITINERARY}</p>
						</div>
					</Specimen>
					<Specimen label="Editing it">
						<Panel name="Mara">
							<ArtifactViewer
								agent="Mara"
								title="Lisbon itinerary"
								versions={VERSIONS}
								showing={3}
								editing
								body={ITINERARY}
							/>
						</Panel>
					</Specimen>
					<Specimen label="An older version, to restore">
						<Panel name="Mara">
							<ArtifactViewer
								agent="Mara"
								title="Lisbon itinerary"
								versions={VERSIONS}
								showing={1}
								body={ITINERARY.split("\n").slice(0, 6).join("\n")}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Its versions">
						<div className="w-[var(--panel-width)] rounded-tile border border-line-soft p-2">
							<Versions versions={VERSIONS} showing={1} />
						</div>
					</Specimen>
					<Specimen label="A routine's editor">
						<Panel name="Octo">
							<RoutineEditor
								agent="Octo"
								now={SPECIMEN_NOW}
								routine={{
									title: "PR watch",
									draft: {
										description: "PR watch",
										pick: { kind: "weekdays", time: "08:00" },
										ask: "Tell me which of my pull requests need me, and why. Say nothing if none do.",
									},
									paused: false,
									last: "Last ran today 08:00",
								}}
								onSave={async () => {}}
								onRunNow={() => undefined}
								onPause={() => undefined}
								onDelete={() => undefined}
							/>
						</Panel>
					</Specimen>
					<Specimen label="When it can't read the time">
						<Panel name="Octo">
							<RoutineEditor
								agent="Octo"
								now={SPECIMEN_NOW}
								routine={{
									title: "PR watch",
									draft: {
										description: "PR watch",
										pick: { kind: "custom", text: "most mornings" },
										ask: "Tell me which of my pull requests need me.",
									},
									paused: true,
								}}
								onSave={async () => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="+, a new routine">
						<Panel name="Octo">
							<RoutineEditor agent="Octo" now={SPECIMEN_NOW} onSave={async () => {}} />
						</Panel>
					</Specimen>
					<Specimen label="A watch's detail">
						<Panel name="Mara">
							<WatchDetail
								agent={{ id: "mara", name: "Mara" }}
								chat={undefined}
								watch={WATCH_VIEW}
								now={SPECIMEN_NOW}
								onDone={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Editing what ends it and what matters">
						<Panel name="Mara">
							<WatchDetail
								agent={{ id: "mara", name: "Mara" }}
								chat={undefined}
								watch={WATCH_VIEW}
								now={SPECIMEN_NOW}
								edit={{ step: "editing", until: null, ask: WATCH_VIEW.accepted?.watch?.ask ?? "" }}
								onDone={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="A watch nothing ends: a contact">
						<Panel name="Mara">
							<WatchDetail
								agent={{ id: "mara", name: "Mara" }}
								chat={undefined}
								watch={WATCH_CONTACT_VIEW}
								now={SPECIMEN_NOW}
								onDone={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="Editing it: no end to pick">
						<Panel name="Mara">
							<WatchDetail
								agent={{ id: "mara", name: "Mara" }}
								chat={undefined}
								watch={WATCH_CONTACT_VIEW}
								now={SPECIMEN_NOW}
								edit={{ step: "editing", until: null, ask: WATCH_CONTACT_VIEW.accepted?.watch?.ask ?? "" }}
								onDone={() => {}}
							/>
						</Panel>
					</Specimen>
					<Specimen label="An edit refused in the daemon's words">
						<Panel name="Mara">
							<WatchDetail
								agent={{ id: "mara", name: "Mara" }}
								chat={undefined}
								watch={WATCH_VIEW}
								now={SPECIMEN_NOW}
								edit={{
									step: "refused",
									until: "closed",
									ask: WATCH_VIEW.accepted?.watch?.ask ?? "",
									why: "it changed since you saw it: look again",
								}}
								onDone={() => {}}
							/>
						</Panel>
					</Specimen>
				</div>
			</Section>
			<Section
				id="browser"
				note="For reading and take-over. Nothing is drawn over the page; closing hands it back first."
			>
				<Group label="Mara uses it · you took over · hand-back not confirmed" className="items-start">
					<div className="w-[30rem] max-w-full">
						<BrowserWindow agent="Mara" host="flights.example" title="Lisbon, Fri 14 Nov" shot={PAGE} />
					</div>
					<div className="w-[30rem] max-w-full">
						<BrowserWindow agent="Mara" host="flights.example" title="Lisbon, Fri 14 Nov" shot={PAGE} hold="owner" />
					</div>
					<div className="w-[30rem] max-w-full">
						<BrowserWindow agent="Mara" host="flights.example" title="Lisbon, Fri 14 Nov" shot={PAGE} hold="stuck" />
					</div>
				</Group>
				<Group label="The phone, landscape: Give back pinned">
					<div className="h-[340px] w-[740px] max-w-full overflow-hidden rounded-tile border border-line">
						<BrowserWindow
							agent="Mara"
							host="flights.example"
							title="Lisbon, Fri 14 Nov"
							shot={PAGE}
							hold="owner"
							landscape
						/>
					</div>
				</Group>
			</Section>
			<Section id="new-agent" note="A short sheet with the face picked for you; the rest is in its panel." bleed>
				<SettingsPage
					title="New agent"
					icon={UserRoundPlusIcon}
					phone
					footer={<Button className="flex-1">Add to the band</Button>}
				>
					<div className="flex flex-col gap-2">
						<p className="text-meta font-medium text-ink-2">Agent or group: tabs, so the arrow keys switch</p>
						<span className="flex gap-3">
							<Tabs defaultValue="agent">
								<MakeTabsList />
							</Tabs>
							<Tabs defaultValue="group">
								<MakeTabsList />
							</Tabs>
						</span>
					</div>
					<FaceAndName who={{ ...OTTO, name: "" }} autoFocus={false} />
					<Personality starters />
				</SettingsPage>
			</Section>
			<Section id="new-group" note="Pick who is in it and name it." bleed>
				<SettingsPage
					title="New group"
					icon={UsersIcon}
					phone
					footer={<Button className="flex-1">Start the group</Button>}
				>
					<label className="flex flex-col gap-1.5">
						<span className="text-ui font-medium text-ink">Name</span>
						<input
							placeholder="Trip"
							className="h-9 rounded-field border border-line bg-paper px-3 text-heading text-ink outline-none placeholder:text-ink-2 focus-visible:border-ink-2"
						/>
					</label>
					<Members band={[SANCHO, MARA, OCTO, ATLAS]} picked={["Sancho", "Mara"]} />
				</SettingsPage>
			</Section>
			<Section
				id="archive"
				note="A quiet destructive button, then a short confirm; the last active agent cannot be archived."
			>
				<Group label="Archive, and its confirm" className="items-start">
					<div className="w-[20rem] max-w-full">
						<Archive agent={MARA.name} />
					</div>
					<ArchiveConfirm agent={MARA.name} />
				</Group>
				<Group label="The only active agent" className="items-start">
					<div className="w-[20rem] max-w-full">
						<Archive agent={SANCHO.name} last />
					</div>
				</Group>
				<Group label="Settings' Agents: none archived, and one to restore" className="items-start">
					<div className="w-[30rem] max-w-full">
						<ArchivedAgents archived={[]} />
					</div>
					<div className="w-[30rem] max-w-full">
						<ArchivedAgents archived={[{ ...ATLAS, id: "atlas", when: "2 Oct" }]} />
					</div>
				</Group>
				<Group label="Settings' Agents: the limits on groups, and an archived group to restore" className="items-start">
					<div className="w-[30rem] max-w-full">
						<GroupLimitsBlock limits={{ members: 8, depth: 3, chain: 8 }} />
					</div>
					<div className="w-[30rem] max-w-full">
						<ArchivedGroups groups={[{ room: 7, name: "Trip", faces: [SANCHO, MARA], when: "3 Nov" }]} />
					</div>
				</Group>
			</Section>
		</>
	);
}

/** A labelled specimen; a panel gets the height of a short screen, bordered as it would sit. */
function Specimen({ label, children }: { label: string; children: ReactNode }) {
	const panel = isValidElement(children) && (children.type === Panel || children.type === AgentPanelOf);
	return (
		<Labelled label={label}>
			{panel ? (
				<div className="flex h-[600px] w-fit overflow-hidden rounded-tile border border-line-soft [&>aside]:border-l-0">
					{children}
				</div>
			) : (
				children
			)}
		</Labelled>
	);
}
