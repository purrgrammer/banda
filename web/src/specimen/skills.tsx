/** Fixture-only exploration of /name, the chat feed item, the tool preview and the skill detail page. */
import { BookOpenIcon, ChevronLeftIcon } from "lucide-react";
import { type CSSProperties, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { skillTokens } from "../../../src/core/skill-tokens.ts";
import { FromBanda, SkillForm, Waiting } from "../app/Skills.tsx";
import { RawRow, RawValue } from "../chat/ActivityDetail.tsx";
import { Composer } from "../chat/Composer.tsx";
import { Bubble, Run } from "../chat/Feed.tsx";
import { Panel, PanelSection } from "../chat/Panel.tsx";
import {
	SkillCatalogue,
	SkillDetail,
	SkillFeedItem,
	type SkillInfo,
	SkillList,
	type SkillRow,
	SkillToolPreview,
} from "../chat/Skill.tsx";
import { toolPreview } from "../chat/tool-presentation.tsx";
import { Section, StageContext } from "./stage.tsx";

const RESEARCH: SkillInfo = {
	name: "research",
	description: "Compare sources, check their dates, and give a short answer with links to the evidence.",
	path: "skills/research/SKILL.md",
	body: "Check at least two independent sources. Prefer primary material. Say when a claim could not be verified.",
	files: ["skills/research/checklist.md"],
};

const REVIEW: SkillInfo = {
	name: "review",
	description: "Review a draft for missing facts, unclear wording and anything the owner should decide.",
	path: "skills/review/SKILL.md",
	body: "Read the draft. List the most important changes first. Do not rewrite the owner's voice without asking.",
};

export const SKILLS: readonly SkillInfo[] = [
	RESEARCH,
	{
		name: "trip-planner",
		description: "Plan a trip around the owner's dates, budget and travel preferences.",
		path: "skills/trip-planner/SKILL.md",
		body: "Start with the dates and budget. Give two routes, including travel time. Ask before booking anything.",
		files: ["skills/trip-planner/routes.md", "skills/trip-planner/budget.md"],
	},
	REVIEW,
];

/** Links on the specimen never leave it; the wired app will resolve them against the real catalogue. */
export const skillHref = (name: string) => `#/specimen/skills/${encodeURIComponent(name)}`;

const PAGE_ROWS: readonly SkillRow[] = [
	{ name: "pdf", description: "Read and fill PDF forms without losing their layout.", changed: true },
	{ name: "xlsx", description: "Build and check spreadsheets, formulas included." },
	{ name: "deploy-staging", description: "Put the current branch on the staging site, step by step.", ownerOnly: true },
];

const MANY_ROWS: readonly SkillRow[] = [
	...PAGE_ROWS,
	{ name: "docx", description: "Write and edit documents in the house style." },
	{ name: "csv", description: "Clean up exported tables before anyone reads them." },
	{ name: "charts", description: "Turn a table into a clear chart, as a page." },
	{ name: "release-notes", description: "Say what changed, for people who did not read the commits." },
	{ name: "meeting-notes", description: "Notes with decisions and who does what next." },
	{ name: "invoices", description: "Check an invoice's sums and dates before it goes out." },
	{ name: "translate", description: "Déplacer un texte d'une langue à l'autre sans le raidir." },
];

const skillFile = (name: string, description: string, body: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

/** Box-written drafts waiting on the owner: one changed, one new. */
const WAITING = [
	{
		name: "pdf",
		change: {
			kind: "changed" as const,
			sha: "b1",
			text: skillFile("pdf", "Read and fill PDF forms", "Flatten the form after filling it."),
		},
	},
	{
		name: "invoices",
		change: {
			kind: "added" as const,
			sha: "b2",
			text: skillFile("invoices", "Check invoices", "Check the sums and the dates."),
		},
	},
];

const OFFERS = [
	{ name: "pdf", about: "Read and fill PDF forms.", added: false },
	{
		name: "charts",
		about: "Clear diagrams and charts, as pages.",
		note: "Its pages load fonts from Google.",
		added: false,
	},
];

const noop = () => {};
const settle = async () => {};

/** One page state, titled, at the page's reading width. */
function PageState({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<p className="text-meta text-ink-2">{label}</p>
			<div className="flex max-w-[34rem] min-w-0 flex-col gap-5 rounded-field border border-line-soft p-4">
				{children}
			</div>
		</div>
	);
}

function SkillDemo() {
	const [messages, setMessages] = useState<{ id: number; text: string; names: string[] }[]>([]);
	return (
		<div className="flex w-full min-w-0 flex-col gap-5">
			<p className="text-ui text-ink-2">
				Try typing /res or /trip in the composer. Enter or tap chooses a skill; Enter again sends. Backticks and quotes
				keep /names literal.
			</p>
			<div
				role="log"
				className="flex min-h-44 flex-col gap-4 rounded-field bg-paper-2 p-3"
				aria-label="Skill chat fixture"
			>
				<Run>
					<Bubble>Use /research to compare the overnight trains to Lisbon.</Bubble>
				</Run>
				<SkillFeedItem name="research" href={skillHref("research")} />
				<SkillFeedItem name="review" agent="Mara" href={skillHref("review")} />
				{messages.map((message) => (
					<div key={message.id} className="flex flex-col gap-3">
						<Run>
							<Bubble>{message.text}</Bubble>
						</Run>
						{message.names.map((name) => (
							<SkillFeedItem key={name} name={name} href={skillHref(name)} />
						))}
					</div>
				))}
			</div>
			<Composer
				to="Mara"
				skills={SKILLS}
				onSend={async (text) => {
					const names = [
						...new Set(
							skillTokens(
								text,
								SKILLS.map((skill) => skill.name),
							).map((token) => token.name),
						),
					];
					setMessages((previous) => [...previous, { id: (previous.at(-1)?.id ?? 0) + 1, text, names }]);
				}}
			/>
		</div>
	);
}

/** The detailed loaded result belongs to the `skill` tool in Activity, not the chat feed. */
function SkillActivity() {
	return (
		<div className="max-w-[var(--measure)] min-w-0">
			<RawRow
				title="skill"
				icon={<BookOpenIcon className="size-4" />}
				summary={toolPreview("skill", { name: RESEARCH.name })}
				state="Loaded"
			>
				<RawValue label="Arguments">{JSON.stringify({ name: RESEARCH.name })}</RawValue>
				<SkillToolPreview skill={RESEARCH} />
			</RawRow>
		</div>
	);
}

export function SkillsSection() {
	const { width } = useContext(StageContext);
	return (
		<>
			<Section
				id="skills"
				title="Skills"
				note="One quiet item in the chat when a skill loads. Tap its name for the skill's detail page; Activity keeps the exact instructions returned by the tool."
			>
				<SkillDemo />
			</Section>
			<Section
				id="skill-activity"
				title="Skill in Activity"
				note="The skill tool's arguments and the exact instructions returned are inspectable here, not repeated in the chat."
			>
				<SkillActivity />
			</Section>
			<Section
				id="skills-page"
				title="Skills page"
				note="What waits on the owner first, then every accepted skill, flat; a filter appears from nine skills. 'Only you' marks an owner-only skill, 'Changed' a row whose change waits."
			>
				<div className="flex min-w-0 flex-col gap-6 p-4">
					<PageState label="Nothing yet">
						<SkillList skills={[]} hrefFor={skillHref} />
					</PageState>
					<PageState label="Three skills: one changed, one only you">
						<SkillList skills={PAGE_ROWS} hrefFor={skillHref} />
					</PageState>
					<PageState label="Ten skills: type in the filter; 'deployer' or 'Déploy' both match">
						<SkillList skills={MANY_ROWS} hrefFor={skillHref} />
					</PageState>
					<PageState label="Changes wait: the review block sits above the list">
						<Waiting list={WAITING} onOpen={noop} reload={settle} />
						<SkillList skills={PAGE_ROWS} hrefFor={skillHref} />
					</PageState>
					<PageState label="From banda: two left to add; with none left the section is gone">
						<FromBanda offers={OFFERS} onAdd={noop} />
						<FromBanda offers={[]} onAdd={noop} />
					</PageState>
				</div>
			</Section>
			<Section
				id="skill-form"
				title="Skill form"
				note="The form says what the daemon would refuse while the owner types; Save and use stays off until the file would be taken."
			>
				<div className="flex min-w-0 flex-col gap-6 p-4">
					<PageState label="Valid">
						<SkillForm
							heading="New skill"
							initialName="xlsx"
							initialText={skillFile("xlsx", "Build and check spreadsheets", "Check the formulas first.")}
							existing={["pdf"]}
							onSave={settle}
							onCancel={noop}
						/>
					</PageState>
					<PageState label="The name breaks the rule">
						<SkillForm
							heading="New skill"
							initialName="my skill"
							initialText={skillFile("my skill", "Spreadsheets", "Body.")}
							existing={[]}
							onSave={settle}
							onCancel={noop}
						/>
					</PageState>
					<PageState label="The name is taken">
						<SkillForm
							heading="New skill"
							initialName="pdf"
							initialText={skillFile("pdf", "Read and fill PDF forms", "Body.")}
							existing={["pdf"]}
							onSave={settle}
							onCancel={noop}
						/>
					</PageState>
					<PageState label="No description yet">
						<SkillForm
							heading="New skill"
							initialName="csv"
							initialText={"---\nname: csv\n---\n\nClean the table."}
							existing={[]}
							onSave={settle}
							onCancel={noop}
						/>
					</PageState>
					<PageState label="Near the size limit">
						<SkillForm
							heading="New skill"
							initialName="docx"
							initialText={skillFile("docx", "House-style documents", "x".repeat(50_000))}
							existing={[]}
							onSave={settle}
							onCancel={noop}
						/>
					</PageState>
				</div>
			</Section>
			<Section
				id="skill-detail"
				title="Skill detail"
				note="Shared with the band, or only the owner: an owner-only skill says so under its name."
			>
				<div className="flex min-w-0 flex-col gap-6 p-4">
					<PageState label="Shared">
						<SkillDetail skill={REVIEW} />
					</PageState>
					<PageState label="Only you">
						<SkillDetail
							skill={{
								name: "deploy-staging",
								description: "Put the current branch on the staging site, step by step.",
								path: "skills/deploy-staging/SKILL.md",
								body: "Build first. Stop at the first failing check and say which.",
								ownerOnly: true,
							}}
						/>
					</PageState>
				</div>
			</Section>
			<Section
				id="skills-about"
				title="Skills in an agent's About"
				note="The shared catalogue lists skills in About. A name opens the same detail page as the chat feed item."
			>
				<div className="flex flex-wrap items-start gap-4">
					<div className="w-80 max-w-full" style={{ "--panel-width": "20rem" } as CSSProperties}>
						<Panel name="Mara" phone={width === "phone"} className="h-96">
							<PanelSection title="About">
								<SkillCatalogue skills={SKILLS} hrefFor={skillHref} />
							</PanelSection>
						</Panel>
					</div>
					<div className="w-80 max-w-full" style={{ "--panel-width": "20rem" } as CSSProperties}>
						<p className="mb-2 text-meta text-ink-2">Empty shared catalogue · another home</p>
						<Panel name="Mara" phone={width === "phone"} className="h-44">
							<PanelSection title="About">
								<SkillCatalogue skills={[]} hrefFor={skillHref} />
							</PanelSection>
						</Panel>
					</div>
				</div>
			</Section>
		</>
	);
}

/** A distinct page in the specimen; the wired app will read the actual skill file here. */
export function SkillDetailPreview({ name }: { name: string }) {
	const [scheme, setScheme] = useState<"light" | "dark">("light");
	const skill = SKILLS.find((item) => item.name === name);
	return (
		<div style={{ colorScheme: scheme }} className="min-h-svh bg-paper text-ink" data-skill-detail-page="">
			<header className="flex min-h-12 items-center justify-between gap-3 border-b border-line-soft px-4">
				<Button variant="ghost" size="sm" asChild>
					<a href="#/specimen?section=skills">
						<ChevronLeftIcon />
						Skills
					</a>
				</Button>
				<span className="text-meta text-ink-2">Specimen · skill detail</span>
				<Button variant="ghost" size="sm" onClick={() => setScheme(scheme === "light" ? "dark" : "light")}>
					{scheme === "light" ? "Dark" : "Light"}
				</Button>
			</header>
			<main className="mx-auto max-w-2xl px-5 py-8">
				{skill === undefined ? (
					<p className="text-ui text-ink-2">This skill is not in the catalogue.</p>
				) : (
					<SkillDetail skill={skill} />
				)}
			</main>
		</div>
	);
}
