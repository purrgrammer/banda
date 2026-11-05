/**
 * The specimen (`#/specimen`): every component of the app with fixture data, in light and dark side by side, at
 * desktop or phone width. It is reviewed in the browser before anything is wired behind it.
 */

import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { ActivityPreview, ActivitySection } from "../specimen/activity.tsx";
import { AvatarCandidateSpecimen } from "../specimen/avatar-candidate.tsx";
import { AvatarCreator, AvatarIcon } from "../specimen/avatar-creator.tsx";
import { AvatarColorsContext, AvatarSpecimenContext } from "../specimen/avatar-face.tsx";
import { AvatarSpike } from "../specimen/avatar-spike.tsx";
import { BandSection } from "../specimen/band.tsx";
import { Controls } from "../specimen/controls.tsx";
import { Copy } from "../specimen/copy.tsx";
import { Faces } from "../specimen/faces.tsx";
import { Foundation } from "../specimen/foundation.tsx";
import { McpPreview, McpSection } from "../specimen/mcp.tsx";
import { MemorySection } from "../specimen/memory.tsx";
import { PanelSections } from "../specimen/panel.tsx";
import { Parts } from "../specimen/parts.tsx";
import { RecordedActivityPreview } from "../specimen/recorded-activity.tsx";
import { Screens } from "../specimen/screens.tsx";
import { SkillDetailPreview, SkillsSection } from "../specimen/skills.tsx";
import { type Scheme, StageContext, type Width } from "../specimen/stage.tsx";
import { States } from "../specimen/states.tsx";

const CONTENTS = [
	{ id: "activity", label: "Activity drill-down" },
	{ id: "skills", label: "Skills" },
	{ id: "skill-activity", label: "Skill in Activity" },
	{ id: "skills-about", label: "Skills in About" },
	{ id: "app", label: "The app" },
	{ id: "agent-meta-tools", label: "Agent-to-agent tools in a chat" },
	{ id: "working-chat", label: "A chat at work" },
	{ id: "first-run", label: "First run" },
	{ id: "first-skills", label: "First run: skills" },
	{ id: "first-chat", label: "The first chat" },
	{ id: "group", label: "A group" },
	{ id: "panel-app", label: "A chat and its panel" },
	{ id: "panel", label: "The panel" },
	{ id: "scoped-memory", label: "Scoped memory" },
	{ id: "open-file", label: "What opens in the panel" },
	{ id: "browser", label: "The browser, enlarged" },

	{ id: "new-agent", label: "A new agent" },
	{ id: "new-group", label: "A new group" },
	{ id: "settings", label: "Settings" },
	{ id: "connections", label: "Connections" },
	{ id: "connect", label: "Connecting" },
	{ id: "mcp", label: "Add MCP server" },
	{ id: "github", label: "GitHub" },
	{ id: "loading-app", label: "Opening the app" },
	{ id: "empty-chat", label: "A new agent's chat" },
	{ id: "states", label: "Empty and loading" },
	{ id: "rows", label: "Rows" },
	{ id: "sidebar", label: "The sidebar" },
	{ id: "search", label: "Search" },
	{ id: "messages", label: "Messages" },
	{ id: "files", label: "Files" },
	{ id: "voice", label: "Voice" },
	{ id: "cards", label: "Cards" },
	{ id: "approvals", label: "Approvals" },
	{ id: "working", label: "Working" },
	{ id: "lines", label: "Lines" },
	{ id: "routine-items", label: "Routines in the chat" },
	{ id: "feed-lines", label: "What else the chat says" },
	{ id: "composer", label: "Composer" },
	{ id: "object-in-chat", label: "An object in the chat" },
	{ id: "colour", label: "Colour" },
	{ id: "type", label: "Type" },
	{ id: "shape", label: "Shape" },
	{ id: "motion", label: "Motion" },
	{ id: "faces", label: "Faces" },
	{ id: "avatar-spike", label: "Avatar exploration" },
	{ id: "avatar-creator", label: "Choose a face" },
	{ id: "avatar-candidate", label: "A generated face" },
	{ id: "avatar-icon", label: "App icon" },
	{ id: "controls", label: "Controls" },
	{ id: "words", label: "Words" },
] as const;

export function Specimen() {
	const [scheme, setScheme] = useState<Scheme>("both");
	const [width, setWidth] = useState<Width>("desktop");
	const [colors, setColors] = useState<Record<string, string>>({});
	useEffect(() => {
		let frame = 0;
		const scrollToSection = () => {
			const query = location.hash.split("?")[1] ?? "";
			const section = new URLSearchParams(query).get("section");
			if (!section || !CONTENTS.some((item) => item.id === section)) return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView());
		};
		scrollToSection();
		addEventListener("hashchange", scrollToSection);
		return () => {
			cancelAnimationFrame(frame);
			removeEventListener("hashchange", scrollToSection);
		};
	}, []);
	if (location.hash === "#/specimen/mcp") return <McpPreview />;
	const skill = /^#\/specimen\/skills\/([a-z0-9-]+)$/.exec(location.hash);
	if (skill !== null) return <SkillDetailPreview name={skill[1] ?? ""} />;
	if (location.hash === "#/specimen/activity/recorded") return <RecordedActivityPreview />;
	if (location.hash === "#/specimen/activity") return <ActivityPreview />;
	return (
		<StageContext.Provider value={{ scheme, width }}>
			<AvatarSpecimenContext.Provider value={true}>
				<AvatarColorsContext.Provider
					value={{ colors, setColor: (name, color) => setColors((previous) => ({ ...previous, [name]: color })) }}
				>
					<Toaster />
					<div className="flex h-svh flex-col bg-paper-2 text-ink">
						<header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 py-2 border-b border-line-soft bg-paper px-4">
							<div className="flex items-center gap-2">
								<span className="text-meta text-ink-2">Specimen</span>
							</div>
							<div className="ml-auto flex items-center gap-2">
								<Segmented
									label="Theme"
									value={scheme}
									onChange={setScheme}
									options={[
										["both", "Both"],
										["light", "Light"],
										["dark", "Dark"],
									]}
								/>
								<Segmented
									label="Width"
									value={width}
									onChange={setWidth}
									options={[
										["desktop", "Desktop"],
										["phone", "Phone"],
									]}
								/>
							</div>
						</header>
						<div className="flex min-h-0 flex-1">
							<nav
								aria-label="Specimen contents"
								className="hidden w-48 shrink-0 flex-col gap-0.5 overflow-y-auto p-3 md:flex"
							>
								{CONTENTS.map((item) => (
									<button
										type="button"
										key={item.id}
										onClick={() => {
											document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth" });
										}}
										className="rounded-field px-2.5 py-1.5 text-left text-ui text-ink-2 hover:bg-paper-3 hover:text-ink"
									>
										{item.label}
									</button>
								))}
							</nav>
							<main className="min-w-0 flex-1 overflow-y-auto">
								<div className="mx-auto flex max-w-[110rem] flex-col gap-12 p-4 pb-24 md:p-6">
									<ActivitySection />
									<SkillsSection />
									<Screens />
									<PanelSections />
									<MemorySection />
									<McpSection />
									<States />
									<BandSection />
									<Parts />
									<Foundation />
									<Faces />
									<AvatarSpike />
									<AvatarCreator />
									<AvatarCandidateSpecimen />
									<AvatarIcon />
									<Controls />
									<Copy />
								</div>
							</main>
						</div>
					</div>
				</AvatarColorsContext.Provider>
			</AvatarSpecimenContext.Provider>
		</StageContext.Provider>
	);
}

function Segmented<T extends string>({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: T;
	onChange: (value: T) => void;
	options: readonly (readonly [T, string])[];
}) {
	return (
		<fieldset aria-label={label} className="flex rounded-field border-0 bg-paper-3 p-0.5">
			{options.map(([one, text]) => (
				<button
					key={one}
					type="button"
					aria-pressed={value === one}
					onClick={() => onChange(one)}
					className={cn(
						"rounded-[6px] px-2.5 py-1 text-meta font-medium text-ink-2",
						value === one && "bg-paper text-ink shadow-[0_0_0_1px_var(--line-soft)]",
					)}
				>
					{text}
				</button>
			))}
		</fieldset>
	);
}
