/**
 * The specimen (`#/specimen`): every component of the app with fixture data, in light and dark side by side, at
 * desktop or phone width. It is reviewed in the browser before anything is wired behind it.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/cn";
import { EmailDraftPreview } from "../app/EmailDraftPreview.tsx";
import { ConnectCard, ConnectionPermissions } from "../chat/Connect.tsx";
import { EmailCard } from "../chat/Object.tsx";
import { ActivityPreview, ActivitySection } from "../specimen/activity.tsx";
import { AvatarCandidateSpecimen } from "../specimen/avatar-candidate.tsx";
import { AvatarCreator, AvatarIcon } from "../specimen/avatar-creator.tsx";
import { AvatarColorsContext, AvatarSpecimenContext } from "../specimen/avatar-face.tsx";
import { AvatarSpike } from "../specimen/avatar-spike.tsx";
import { BandSection } from "../specimen/band.tsx";
import { Controls } from "../specimen/controls.tsx";
import { Copy } from "../specimen/copy.tsx";
import { DevicesSection } from "../specimen/devices.tsx";
import { DoneSection } from "../specimen/done.tsx";
import { Faces } from "../specimen/faces.tsx";
import { Foundation } from "../specimen/foundation.tsx";
import { HarnessSection } from "../specimen/harness.tsx";
import { McpPreview, McpSection } from "../specimen/mcp.tsx";
import { MemorySection } from "../specimen/memory.tsx";
import { PanelSections } from "../specimen/panel.tsx";
import { Parts } from "../specimen/parts.tsx";
import { RecordedActivityPreview } from "../specimen/recorded-activity.tsx";
import { Screens } from "../specimen/screens.tsx";
import { SkillDetailPreview, SkillsSection } from "../specimen/skills.tsx";
import { type Scheme, Section, StageContext, type Width } from "../specimen/stage.tsx";
import { States } from "../specimen/states.tsx";

const CONTENTS = [
	{ id: "activity", label: "Activity drill-down" },
	{ id: "skills", label: "Skills" },
	{ id: "skill-activity", label: "Skill in Activity" },
	{ id: "skills-about", label: "Skills in About" },
	{ id: "app", label: "The app" },
	{ id: "pinned", label: "Pinned" },
	{ id: "pinned-alignment", label: "Pinned: left or centred" },
	{ id: "pinned-hold", label: "Pinning on the phone" },
	{ id: "agent-meta-tools", label: "Agent-to-agent tools in a chat" },
	{ id: "working-chat", label: "A chat at work" },
	{ id: "first-run", label: "First run" },
	{ id: "first-skills", label: "First run: skills" },
	{ id: "first-chat", label: "The first chat" },
	{ id: "group", label: "A group" },
	{ id: "panel-app", label: "A chat and its panel" },
	{ id: "panel", label: "The panel" },
	{ id: "connections-signed-in", label: "Connections after sign-in" },
	{ id: "scoped-memory", label: "Scoped memory" },
	{ id: "open-file", label: "What opens in the panel" },
	{ id: "browser", label: "The browser, enlarged" },

	{ id: "new-agent", label: "A new agent" },
	{ id: "new-group", label: "A new group" },
	{ id: "settings", label: "Settings" },
	{ id: "devices", label: "Devices" },
	{ id: "devices-states", label: "Devices, each state" },
	{ id: "pair-phone", label: "Pairing, on the phone" },
	{ id: "qr", label: "QR code" },
	{ id: "connections", label: "Connections" },
	{ id: "connect", label: "Connecting" },
	{ id: "harness", label: "Claude Code in a chat" },
	{ id: "harness-states", label: "A session, every state" },
	{ id: "harness-headlines", label: "The card's one line" },
	{ id: "harness-asks", label: "Its asks, one at a time" },
	{ id: "harness-panel", label: "Claude Code in the panel" },
	{ id: "harness-sheet", label: "The steps sheet" },
	{ id: "mcp", label: "Add MCP server" },
	{ id: "github", label: "GitHub" },
	{ id: "gmail", label: "Gmail" },
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
	{ id: "done", label: "Done, folded" },
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
	const [permissionDialog, setPermissionDialog] = useState(false);
	const [gmailScopes, setGmailScopes] = useState<string[]>(["https://www.googleapis.com/auth/gmail.readonly"]);
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
									<Section
										id="gmail"
										title="Gmail"
										note="Choose Google access before connecting. Sends and mailbox changes always ask for your approval."
									>
										<div className="grid gap-6 lg:grid-cols-2">
											<EmailCard
												message={{
													from: "Ana García <ana@example.com>",
													to: "bandarra@example.com",
													subject: "The launch checklist",
													date: "Today · 10:24",
													snippet: "Three things before Friday…",
													body: "Three things before Friday:\n\n1. Confirm the final copy.\n2. Review the rollout plan.",
													unread: true,
												}}
											/>
											<EmailDraftPreview
												args={{
													to: "mira@northstar.example",
													subject: "Re: quarterly planning",
													body: "Thanks, Mira. Friday at 10:30 works for me. I’ve attached the updated notes.",
													attachments: [{ name: "planning-notes.pdf", mimeType: "application/pdf", size: 1_258_291 }],
												}}
												edits={{}}
												readOnly
												onEdit={() => {}}
											/>
											<EmailCard
												message={{
													from: "Mira from Northstar <mira@northstar.example>",
													to: "bandarra@example.com",
													subject: "Re: quarterly planning",
													date: "Yesterday · 16:42",
													snippet: "I’ve attached the notes…",
													body: "Thanks for the thoughtful review. I’ve added the three dates we agreed on.",
													unread: false,
												}}
											/>
											<div className="lg:col-span-2">
												<ConnectCard
													agent="Sancho"
													connection="Gmail"
													state={{ kind: "connect", why: "Choose access, then sign in to Gmail." }}
													onConnect={() => setPermissionDialog(true)}
													onPermissions={() => setPermissionDialog(true)}
												/>
												<Dialog open={permissionDialog} onOpenChange={setPermissionDialog}>
													<DialogContent>
														<DialogHeader>
															<DialogTitle>Gmail access</DialogTitle>
															<DialogDescription>Choose what Banda can access before signing in.</DialogDescription>
														</DialogHeader>
														<ConnectionPermissions
															connection="gmail"
															scopes={gmailScopes}
															onScopes={(scopes) => setGmailScopes([...scopes])}
														/>
														<DialogFooter>
															<Button variant="ghost" onClick={() => setPermissionDialog(false)}>
																Cancel
															</Button>
															<Button onClick={() => setPermissionDialog(false)}>Save and sign in</Button>
														</DialogFooter>
													</DialogContent>
												</Dialog>
											</div>
										</div>
									</Section>
									<PanelSections />
									<MemorySection />
									<DevicesSection />
									<McpSection />
									<HarnessSection />
									<States />
									<BandSection />
									<Parts />
									<DoneSection />
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
