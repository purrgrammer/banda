/** The panel, settings and connections: the agent beside its chat, what opens there, and the pages behind the gear. */
import { isValidElement, type ReactNode, useContext } from "react";
import { Button } from "@/components/ui/button";
import { DraftApproval } from "../app/DraftApproval.tsx";
import { ObjectReading } from "../app/Objects.tsx";
import { ApprovalCard } from "../chat/Approval.tsx";
import { BrowserWindow } from "../chat/Browser.tsx";
import { Catalogue } from "../chat/Catalogue.tsx";
import { ConnectCard } from "../chat/Connect.tsx";
import type { FaceState } from "../chat/Face.tsx";
import { Bubble } from "../chat/Feed.tsx";
import { ObjectUnavailable } from "../chat/Loading.tsx";
import {
	CheckRunCard,
	IssueCard,
	NotificationCard,
	ObjectLink,
	ObjectReference,
	PullRequestCard,
} from "../chat/Object.tsx";
import {
	AgentPanel,
	firstTab,
	GroupPanel,
	Panel,
	type PanelTab,
	type RoutineRowView,
	Routines,
} from "../chat/Panel.tsx";
import { RoutineEditor } from "../chat/RoutineEditor.tsx";
import type { Who } from "../chat/Row.tsx";
import {
	AppSettings,
	Archive,
	ArchiveConfirm,
	ArchivedAgents,
	type ConnectionRow,
	Connections,
	FaceAndName,
	Members,
	Memory,
	ModelProviders,
	Permissions,
	Personality,
	SettingsPage,
	ThinkingTiers,
} from "../chat/Settings.tsx";
import { SkillCatalogue } from "../chat/Skill.tsx";
import { ArtifactViewer, FileViewer, Versions } from "../chat/Viewer.tsx";
import { Band } from "./brand.tsx";
import {
	ATLAS,
	CHECK_RUN,
	FACTS,
	ISSUE,
	MARA,
	OCTO,
	OTTO,
	PAGE,
	PERMISSIONS,
	PHOTO,
	PR,
	ROUTINES,
	ROWS,
	SANCHO,
	SERVICES,
	SETTINGS,
	SETTINGS_PROVIDERS,
} from "./fixtures.ts";
import { MaraChat } from "./screens.tsx";
import { SKILLS, skillHref } from "./skills.tsx";
import { Group, Section, StageContext } from "./stage.tsx";

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

/** An agent's panel with its four tabs filled; `tab` picks the one open. */
function AgentPanelOf({
	who,
	phone = false,
	tab,
	state,
	routines = ROUTINES,
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
				routines={<Routines agent={who.name} routines={routines} allPaused={paused} />}
				access={
					<>
						<Connections agent={who.name} rows={connections} compact />
						<Permissions agent={who.name} permissions={permissions} />
					</>
				}
				memory={<Memory agent={who.name} facts={facts} />}
				about={
					<>
						<Personality text="Warm and brief. Plans our family trips, keeps to the budget, and asks before booking anything." />
						<SkillCatalogue skills={SKILLS} hrefFor={skillHref} />
						<ThinkingTiers />
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
				title="A chat and its panel"
				note="On wide screens the panel is open by default; on the phone the header's name opens it as a sheet."
				bleed
				wide
			>
				{phone ? null : <Band rows={ROWS} selected="mara" />}
				{phone ? null : <MaraChat />}
				<AgentPanelOf who={MARA} state="waiting" phone={phone} />
			</Section>
			<Section
				id="panel"
				title="The panel"
				note="The agent's whole home: routines, what it can reach and do, what it remembers, and who it is. It opens on Routines when there are some; else Access when nothing is connected; else About."
			>
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
					<Specimen label="No routines yet">
						<AgentPanelOf who={OCTO} tab="routines" routines={[]} />
					</Specimen>
					<Specimen label="Nothing remembered yet">
						<AgentPanelOf who={OCTO} tab="memory" facts={[]} />
					</Specimen>
					<Specimen label="Atlas, routines paused">
						<AgentPanelOf who={ATLAS} routines={ROUTINES.slice(0, 2)} paused />
					</Specimen>
					<Specimen label="A group: its members, and who may join">
						<Panel name="Trip">
							<GroupPanel name="Trip" members={[SANCHO, { ...MARA, state: "working" }]} others={[OCTO, ATLAS]} />
						</Panel>
					</Specimen>
				</div>
			</Section>
			<Section
				id="open-file"
				title="What opens in the panel"
				note="A file in full (full screen on the phone), an artifact and its versions, a routine's editor."
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
				</div>
			</Section>
			<Section
				id="browser"
				title="The browser, enlarged"
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
			<Section
				id="new-agent"
				title="A new agent"
				note="A short sheet with the face picked for you: naming a friend, not filling a form. The rest is in its panel."
				bleed
			>
				<SettingsPage title="New agent" phone footer={<Button className="flex-1">Add to the band</Button>}>
					<FaceAndName who={{ ...OTTO, name: "" }} autoFocus={false} />
					<Personality starters />
				</SettingsPage>
			</Section>
			<Section id="new-group" title="A new group" note="Pick who is in it and name it." bleed>
				<SettingsPage title="New group" phone footer={<Button className="flex-1">Start the group</Button>}>
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
				title="Archive"
				note="The foot of an agent's About: a quiet destructive button, then a short confirm. The last active agent cannot be archived."
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
			</Section>
			<Section
				id="settings"
				title="Settings"
				note="One page in four tabs, as the agent's panel has them: General, Model, Connections, Agents."
				bleed
			>
				{phone ? null : <Band rows={ROWS} />}
				<SettingsPage title="Settings" phone={phone}>
					<AppSettings data={{ ...SETTINGS, archived: [{ ...ATLAS, when: "2 Oct" }] }} />
				</SettingsPage>
			</Section>
			<Section id="settings-tabs" title="Settings, each tab" note="Model, Connections and Agents, as each opens.">
				{(["model", "connections", "agents"] as const).map((tab) => (
					<div key={tab} className="h-[30rem] overflow-hidden rounded-tile border border-line-soft">
						<SettingsPage title="Settings" phone={phone}>
							<AppSettings
								tab={tab}
								data={{ ...SETTINGS, archived: [{ ...ATLAS, when: "2 Oct" }] }}
								providers={<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} />}
							/>
						</SettingsPage>
					</div>
				))}
			</Section>
			<Section
				id="settings-providers"
				title="Settings, providers"
				note="Every provider the band may think with: in use, connected (Use, Sign out), connecting, failed, and a key form open."
			>
				<SettingsPage title="Settings" phone={phone}>
					<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} open="mistral" />
				</SettingsPage>
			</Section>
			<Section
				id="connections"
				title="Connections"
				note="Everything the band can work with, from the band's foot or Settings: connect before an agent needs it."
				bleed
			>
				{phone ? null : <Band rows={ROWS} />}
				<SettingsPage title="Connections" phone={phone}>
					<Catalogue services={SERVICES} />
				</SettingsPage>
			</Section>
			<Section
				id="connect"
				title="Connecting"
				note="One flow everywhere: Connect, sign in at the service, done. Asked again only to share an account."
			>
				<div className="grid gap-4 lg:grid-cols-2">
					<Specimen label="Connect">
						<ConnectCard
							agent="Octo"
							connection="GitHub"
							state={{
								kind: "connect",
								why: "Octo can read your pull requests and issues, and asks before it writes.",
							}}
						/>
					</Specimen>
					<Specimen label="A code to enter">
						<ConnectCard
							agent="Octo"
							connection="GitHub"
							state={{ kind: "code", code: "WDJB-MJHT", url: "https://github.com/login/device" }}
						/>
					</Specimen>
					<Specimen label="Signing in on GitHub's own page, in another tab">
						<ConnectCard
							agent="Octo"
							connection="GitHub"
							state={{ kind: "code", url: "https://github.com/login/oauth/authorize" }}
						/>
					</Specimen>
					<Specimen label="Signed in">
						<ConnectCard agent="Octo" connection="GitHub" state={{ kind: "done", login: "@bandarra" }} />
					</Specimen>
					<Specimen label="Signed in to an account already known">
						<ConnectCard agent="Octo" connection="GitHub" state={{ kind: "already", login: "@bandarra" }} />
					</Specimen>
					<Specimen label="From Settings: for no agent yet">
						<ConnectCard connection="GitHub" state={{ kind: "done", login: "@purrgrammer" }} />
					</Specimen>
					<Specimen label="Failed">
						<ConnectCard
							agent="Octo"
							connection="GitHub"
							state={{ kind: "failed", why: "The code expired before you entered it." }}
						/>
					</Specimen>
					<Specimen label="Already signed in">
						<ConnectCard
							agent="Mara"
							connection="GitHub"
							state={{ kind: "known", logins: ["@bandarra", "@purrgrammer"] }}
						/>
					</Specimen>
					<Specimen label="Sharing an account with another agent">
						<ConnectCard agent="Mara" connection="GitHub" state={{ kind: "share", login: "@bandarra" }} />
					</Specimen>
				</div>
			</Section>
			<Section
				id="github"
				title="GitHub"
				note="A pull request, an issue, a check run, and a notification as its subject; each in its states, and with a draft."
			>
				<div className="grid gap-6 lg:grid-cols-2">
					<Specimen label="Quiet actions and details · long metadata">
						<ObjectReading
							chat={1}
							onRefresh={() => {}}
							shown={{
								shown: "card",
								key: "specimen-long",
								name: "banda #34",
								connection: "github",
								service: "GitHub",
								account: "@bandarra",
								at: SPECIMEN_NOW,
								old: true,
								card: {
									...PR,
									card: "pull-request",
									repo: "an-organisation-with-a-long-name/a-repository-with-a-very-long-name-that-must-not-stretch-the-chat",
									title:
										"A realistic pull request title that keeps its full meaning even on a narrow phone and can wrap safely",
									branch: "ernesto/6aa9457fc87469c60ed88413/qa-commit-a-failed-web-case-s-proven-pre-cb5c56",
									url: "https://github.com/purrgrammer/banda/pull/34",
								},
							}}
						/>
					</Specimen>
					<Specimen label="Owner reference: source icon, object-type icon and linked title; aligned with the words, no metadata or card">
						<Bubble mine>
							Approve and merge{" "}
							<ObjectLink
								object={{ ...PR, card: "pull-request" }}
								href="https://github.com/purrgrammer/banda/pull/34"
							/>
						</Bubble>
					</Specimen>
					<Specimen label="Pull requests: open · failing · running · draft · merged · closed, an old reading">
						<div className="flex flex-col gap-3">
							<PullRequestCard pr={PR} />
							<PullRequestCard pr={{ ...PR, checks: { passed: 9, failed: 2, running: 0 }, reviews: "None yet" }} />
							<PullRequestCard
								pr={{ ...PR, checks: { passed: 6, failed: 0, running: 5 }, reviews: "Ana requested changes" }}
							/>
							<PullRequestCard pr={{ ...PR, state: "draft", reviews: "None yet" }} />
							<PullRequestCard pr={{ ...PR, state: "merged" }} />
							<PullRequestCard pr={{ ...PR, state: "closed", asOf: "2 Nov, 09:40" }} />
							<PullRequestCard pr={{ ...PR, checks: { passed: 0, failed: 0, running: 0 } }} />
							<PullRequestCard
								pr={{ ...PR, state: "unknown", checks: null, reviews: "Unavailable", added: null, removed: null }}
							/>
						</div>
					</Specimen>
					<Specimen label="Issues: open · closed · not planned">
						<div className="flex flex-col gap-3">
							<IssueCard issue={ISSUE} />
							<IssueCard issue={{ ...ISSUE, state: "completed", comments: 5 }} />
							<IssueCard issue={{ ...ISSUE, state: "unknown", comments: null }} />
							<IssueCard
								issue={{
									...ISSUE,
									state: "not-planned",
									assignee: undefined,
									labels: ["idea"],
									comments: 1,
									asOf: "yesterday",
								}}
							/>
						</div>
					</Specimen>
					<Specimen label="Check runs: failed · running · queued · passed · cancelled · skipped · neutral · unknown">
						<div className="flex flex-col gap-3">
							<CheckRunCard run={CHECK_RUN} />
							{(["cancelled", "skipped", "neutral", "unknown"] as const).map((state) => (
								<CheckRunCard
									key={state}
									run={{ ...CHECK_RUN, state, step: undefined, took: undefined, log: undefined }}
								/>
							))}
							<CheckRunCard
								run={{ ...CHECK_RUN, state: "running", step: "npm run typecheck", took: "1m 04s", log: undefined }}
							/>
							<CheckRunCard
								run={{ ...CHECK_RUN, name: "lint", state: "queued", step: undefined, took: undefined, log: undefined }}
							/>
							<CheckRunCard
								run={{ ...CHECK_RUN, name: "build", state: "passed", step: undefined, took: "48s", log: undefined }}
							/>
						</div>
					</Specimen>
					<Specimen label="Unrecognised or unavailable explicit object">
						<ObjectReference reference="https://github.com/purrgrammer/banda/discussions/34" />
					</Specimen>
					<Specimen label="Notifications: unread · done">
						<div className="flex flex-col gap-4">
							<NotificationCard reason="review-requested" when="9:40">
								<PullRequestCard pr={PR} />
							</NotificationCard>
							<NotificationCard reason="mention" when="Yesterday" unread={false}>
								<IssueCard issue={ISSUE} />
							</NotificationCard>
							<NotificationCard reason="ci" when="10:12">
								<CheckRunCard run={CHECK_RUN} />
							</NotificationCard>
							<NotificationCard reason="activity" when="">
								<ObjectUnavailable what="Repository activity" why="Subject preview unavailable" fix="Try again" />
							</NotificationCard>
						</div>
					</Specimen>
					<Specimen label="A draft on each: comment · close · re-run · mark done">
						<div className="flex flex-col gap-3">
							<ApprovalCard
								agent="Octo"
								as="@bandarra on GitHub"
								what={`Comment on ${PR.repo} #${PR.number}`}
								verb="Comment"
								object={<PullRequestCard pr={PR} />}
								text="Looks good. One nit: `poll` still appears in docs/routines.md; rename it there too and this is ready."
								scope="Don't ask again for comments on this pull request"
							/>
							<ApprovalCard
								agent="Octo"
								as="@bandarra on GitHub"
								what={`Close ${ISSUE.repo} #${ISSUE.number} as done`}
								verb="Close"
								object={<IssueCard issue={ISSUE} />}
								text="Fixed in #34: the panel keeps the open file across reloads."
							/>
						</div>
					</Specimen>
					<Specimen label="Interrupted attempt: original bytes only, retry or skip">
						<DraftApproval
							chat={0}
							agent={{ name: "Octo" }}
							label="Comment on purrgrammer/banda #34 again"
							ask={{
								type: "approval",
								tool: "github__add_issue_comment",
								interrupted: true,
								as: "@bandarra on GitHub",
								args: { owner: "purrgrammer", repo: "banda", issue_number: 34, body: "Looks good. Ready for review." },
								editable: ["body"],
							}}
						/>
					</Specimen>
					<Specimen label="Answered: done · not sent">
						<div className="flex flex-col gap-3">
							<ApprovalCard
								agent="Octo"
								as="@bandarra on GitHub"
								what="Re-run the failed routine"
								verb="Re-run"
								object={<CheckRunCard run={CHECK_RUN} />}
								state={{ kind: "done", words: "Re-ran at 10:14" }}
							/>
							<ApprovalCard
								agent="Octo"
								as="@bandarra on GitHub"
								what="Mark 4 notifications done"
								verb="Mark done"
								scope="Don't ask again for marking notifications done"
								state={{ kind: "declined" }}
							/>
						</div>
					</Specimen>
				</div>
			</Section>
		</>
	);
}

/** One specimen with its label; a panel gets the height of a short screen, bordered as it would sit. */
function Specimen({ label, children }: { label: string; children: ReactNode }) {
	const panel = isValidElement(children) && (children.type === Panel || children.type === AgentPanelOf);
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<p className="text-meta font-medium text-ink-2">{label}</p>
			{panel ? (
				<div className="flex h-[600px] w-fit overflow-hidden rounded-tile border border-line-soft [&>aside]:border-l-0">
					{children}
				</div>
			) : (
				children
			)}
		</div>
	);
}
