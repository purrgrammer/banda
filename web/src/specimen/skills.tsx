/** Fixture-only exploration of /name, the chat feed item, the tool preview and the skill detail page. */
import { BookOpenIcon, ChevronLeftIcon } from "lucide-react";
import { type CSSProperties, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { skillTokens } from "../../../src/core/skill-tokens.ts";
import { RawRow, RawValue } from "../chat/ActivityDetail.tsx";
import { Composer } from "../chat/Composer.tsx";
import { Bubble, Run } from "../chat/Feed.tsx";
import { Panel, PanelSection } from "../chat/Panel.tsx";
import { SkillCatalogue, SkillDetail, SkillFeedItem, type SkillInfo, SkillToolPreview } from "../chat/Skill.tsx";
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
