/** Agent tool access proposal. All switches are local specimen state until owner review. */
import {
	ArrowLeftIcon,
	BookOpenIcon,
	CalendarClockIcon,
	ChevronDownIcon,
	FileTextIcon,
	GitBranchIcon,
	GlobeIcon,
	type LucideIcon,
	MemoryStickIcon,
	MonitorIcon,
	SearchIcon,
	SendIcon,
	TerminalIcon,
	UsersIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import github from "../../../../shipped/connections/github.json";
import { TOOLSETS } from "../../../../src/core/toolsets.ts";
import { AgentPanel, Panel } from "../../chat/Panel.tsx";
import { Block, Connections, Permissions } from "../../chat/Settings.tsx";
import { MARA, SANCHO } from "../fixtures.ts";
import { Section } from "../stage.tsx";
import schemas from "./tool-schemas.json";

const SCHEMAS: Record<string, { description: string; parameters: unknown }> = schemas;
const ICONS: Record<string, LucideIcon> = {
	files: FileTextIcon,
	shell: TerminalIcon,
	web: GlobeIcon,
	browser: MonitorIcon,
	memory: MemoryStickIcon,
	routines: CalendarClockIcon,
	skills: BookOpenIcon,
	agents: UsersIcon,
	requests: SendIcon,
	search: SearchIcon,
	github: GitBranchIcon,
};

const GROUPS: Record<string, { title: string; description: string }> = {
	search: { title: "Search", description: "Find conversations and artifacts across the band." },
	files: { title: "Files", description: "Read and change files in the workspace." },
	shell: { title: "Shell", description: "Run commands, including reading and changing files." },
	web: { title: "Web", description: "Read a web page by its address." },
	browser: { title: "Browser", description: "Browse sites, interact with pages and hand over to you." },
	memory: { title: "Memory", description: "Recall, remember and forget facts." },
	routines: { title: "Routines", description: "Schedule work for later or repeat it." },
	skills: { title: "Skills", description: "Load instructions from accepted skills." },
	agents: { title: "The band", description: "Contact agents, read their chats and propose changes." },
	requests: { title: "Outgoing requests", description: "Ask you to allow hosts before sending to them." },
};
const TOOL_LABELS: Record<string, string> = {
	search: "Search banda",
	read_search_result: "Read a search source",
	read: "Read files",
	write: "Write files",
	edit: "Edit files",
	bash: "Run commands",
	web_fetch: "Read a web page",
	schedule: "Schedule work",
	remember: "Remember a fact",
	recall: "Recall facts",
	forget: "Forget a fact",
	skill: "Load a skill",
	message_agent: "Message an agent",
	read_agent_chat: "Read an agent’s chat",
	propose_agent: "Propose an agent",
	propose_group: "Propose a group",
	propose_agent_change: "Propose changes to an agent",
	ask_hosts: "Ask to allow hosts",
	browser_snapshot: "Read the page",
	browser_navigate: "Open a page",
	browser_click: "Click an element",
	browser_type: "Type into a field",
	browser_select: "Choose an option",
	browser_scroll: "Scroll the page",
	browser_wait: "Wait for the page",
	browser_screenshot: "See a screenshot",
	browser_send: "Send a browser request",
	browser_hand_over: "Hand the browser to you",
	propose_key: "Ask to save a key",
};
// The shipped inventory, not an invented service or a duplicate list to maintain.
const GITHUB_TOOLS = Object.keys(github.needs).map((name) => `github__${name}`);
const INVENTORY = Object.entries({
	...TOOLSETS,
	search: ["search", "read_search_result"],
	skills: ["skill"],
	agents: ["message_agent", "read_agent_chat", "propose_agent", "propose_group", "propose_agent_change"],
	requests: ["ask_hosts"],
}).map(([id, tools]) => ({
	id,
	...(GROUPS[id] ?? { title: id, description: "" }),
	tools,
}));
const ALL = [...INVENTORY.flatMap((group) => group.tools), ...GITHUB_TOOLS];
const titleOf = (name: string) =>
	TOOL_LABELS[name] ??
	name
		.replace(/^github__/, "")
		.replaceAll("_", " ")
		.replace(/^./, (c) => c.toUpperCase());

type Picked = Record<string, boolean>;
const defaults = (agent: string): Picked =>
	Object.fromEntries(
		ALL.map((name) => [
			name,
			agent === "sancho" ||
				!["bash", "write", "edit", "propose_agent", "propose_group", "propose_agent_change"].includes(name),
		]),
	);

export function ToolsetsSection() {
	const [picked, setPicked] = useState(() => defaults("mara"));
	return (
		<Section
			id="toolsets"
			note="A proposal: switch a whole toolset or pick tools one by one. Changes stay in this preview."
		>
			<Button variant="outline" asChild>
				<a href="#/specimen/toolsets">Open tool access preview</a>
			</Button>
			<div className="max-w-full w-[var(--panel-width)] p-4 border border-line-soft rounded-tile overflow-hidden">
				<ToolAccess
					agent="Mara"
					picked={picked}
					onChange={(names, on) =>
						setPicked((previous) => ({ ...previous, ...Object.fromEntries(names.map((name) => [name, on])) }))
					}
				/>
			</div>
		</Section>
	);
}

export function ToolAccess({
	agent,
	picked,
	onChange,
	failed = false,
	retry,
}: {
	agent: string;
	picked: Picked;
	onChange: (names: readonly string[], on: boolean) => void;
	failed?: boolean;
	retry?: () => void;
}) {
	const [query, setQuery] = useState("");
	const id = useId();
	const groups = [
		...INVENTORY,
		{
			id: "github",
			title: "GitHub",
			description: "Tools for the GitHub accounts enabled above. Sending or changing anything still needs approval.",
			tools: GITHUB_TOOLS,
		},
	];
	const matches = (name: string) => `${name} ${titleOf(name)}`.toLowerCase().includes(query.toLowerCase());
	const shown = groups.filter(
		(group) =>
			`${group.title} ${group.description}`.toLowerCase().includes(query.toLowerCase()) || group.tools.some(matches),
	);
	return (
		<Block title="Tools" note={`Choose the tools ${agent} can use. Approvals still apply.`}>
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor={id}>Find a tool</FieldLabel>
					<Input
						id={id}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search tools or toolsets…"
					/>
				</Field>
			</FieldGroup>
			{failed ? (
				<div className="flex flex-col items-start gap-3">
					<FieldError>Couldn’t save {agent}’s tools. Your previous choices still apply.</FieldError>
					<Button variant="outline" size="sm" onClick={retry}>
						Try again
					</Button>
				</div>
			) : null}
			<div className="flex flex-col divide-y divide-line-soft">
				{shown.map((group) => {
					const Icon = ICONS[group.id] ?? FileTextIcon;
					const on = group.tools.filter((name) => picked[name]).length;
					const wholeGroup = `${group.title} ${group.description}`.toLowerCase().includes(query.toLowerCase());
					const tools = wholeGroup ? group.tools : group.tools.filter(matches);
					return (
						<Collapsible key={group.id} className="py-3" {...(query ? { open: true } : {})}>
							<div className="flex items-center gap-3">
								<CollapsibleTrigger asChild>
									<Button variant="ghost" className="min-w-0 flex-1 justify-start" aria-label={`${group.title} tools`}>
										<Icon data-icon="inline-start" aria-hidden="true" />
										<span className="truncate">{group.title}</span>
										<ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
									</Button>
								</CollapsibleTrigger>
								<Switch
									aria-label={`${agent}: ${group.title}`}
									checked={on > 0}
									onCheckedChange={(value) => onChange(group.tools, value)}
								/>
							</div>
							<p className="mt-1 text-meta text-ink-2">{group.description}</p>
							<p className="mt-1 text-meta text-ink-2" aria-live="polite">
								{on === 0 ? "Off" : on === group.tools.length ? "All on" : `${on} of ${group.tools.length} on`} ·{" "}
								{group.tools.length} {group.tools.length === 1 ? "tool" : "tools"}
							</p>
							<CollapsibleContent className="pt-4">
								<FieldGroup>
									{tools.map((name) => (
										<ToolChoice
											key={name}
											agent={agent}
											name={name}
											on={picked[name] === true}
											onChange={(value) => onChange([name], value)}
										/>
									))}
								</FieldGroup>
							</CollapsibleContent>
						</Collapsible>
					);
				})}
				{shown.length === 0 ? (
					<p className="py-4 text-ui text-ink-2">No tools match “{query}”. Try a toolset or service name.</p>
				) : null}
			</div>
		</Block>
	);
}

function ToolChoice({
	agent,
	name,
	on,
	onChange,
}: {
	agent: string;
	name: string;
	on: boolean;
	onChange: (on: boolean) => void;
}) {
	const id = useId();
	return (
		<Field orientation="horizontal">
			<FieldContent>
				<FieldLabel htmlFor={id}>{titleOf(name)}</FieldLabel>
				<details>
					<summary className="cursor-pointer text-meta text-ink-2">See details</summary>
					<FieldDescription className="break-all">{name}</FieldDescription>
					{SCHEMAS[name] ? (
						<div className="mt-2 flex min-w-0 flex-col gap-2">
							<p className="text-meta text-ink-2">{SCHEMAS[name].description}</p>
							<CodeBlock
								title="Input schema"
								language="json"
								code={JSON.stringify(SCHEMAS[name].parameters, null, 2)}
							/>
						</div>
					) : (
						<FieldDescription>
							The connection supplies this schema when its tools are loaded. It is not included in this local preview.
						</FieldDescription>
					)}
				</details>
			</FieldContent>
			<Switch id={id} aria-label={`${agent}: ${titleOf(name)}`} checked={on} onCheckedChange={onChange} />
		</Field>
	);
}

export function ToolsetsPreview() {
	const [agent, setAgent] = useState("mara");
	const [theme, setTheme] = useState("light");
	const [fail, setFail] = useState(false);
	const [failed, setFailed] = useState(false);
	const [picks, setPicks] = useState<Record<string, Picked>>({ mara: defaults("mara"), sancho: defaults("sancho") });
	const [pending, setPending] = useState<{ names: readonly string[]; on: boolean }>();
	const who = agent === "mara" ? MARA : SANCHO;
	const save = (names: readonly string[], on: boolean) => {
		if (fail) {
			setPending({ names, on });
			setFailed(true);
			return;
		}
		setPicks((all) => ({ ...all, [agent]: { ...all[agent], ...Object.fromEntries(names.map((name) => [name, on])) } }));
		setFailed(false);
	};
	return (
		<div data-theme={theme} className="min-h-svh bg-paper-2 text-ink">
			<header className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-paper p-3">
				<Button variant="ghost" size="sm" asChild>
					<a href="#/specimen?section=toolsets">
						<ArrowLeftIcon data-icon="inline-start" />
						Specimen
					</a>
				</Button>
				<p className="text-meta text-ink-2">Tool access · local preview</p>
				<Select
					value={agent}
					onValueChange={(value) => {
						setAgent(value);
						setFailed(false);
						setPending(undefined);
					}}
				>
					<SelectTrigger aria-label="Agent">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value="mara">Mara</SelectItem>
							<SelectItem value="sancho">Sancho</SelectItem>
						</SelectGroup>
					</SelectContent>
				</Select>
				<Button variant="outline" size="sm" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
					{theme === "light" ? "Dark" : "Light"}
				</Button>
				<Button variant="outline" size="sm" aria-pressed={fail} onClick={() => setFail(!fail)}>
					Simulate save failure
				</Button>
			</header>
			<main className="mx-auto flex max-w-4xl justify-center p-4">
				<div className="flex h-[calc(100svh-9rem)] min-h-[30rem] max-w-full overflow-hidden rounded-tile border border-line-soft [&>aside]:border-l-0">
					<Panel name={who.name}>
						<AgentPanel
							key={agent}
							who={who}
							tab="access"
							routines={<p className="p-4 text-ui">No routines in this preview.</p>}
							memory={<p className="p-4 text-ui">No facts in this preview.</p>}
							about={<p className="p-4 text-ui">Tool access preview for {who.name}.</p>}
							access={
								<>
									<Connections
										agent={who.name}
										rows={[
											{
												connection: "GitHub",
												accounts: [
													{ login: "@bandarra", on: true },
													{ login: "@purrgrammer", on: false },
												],
											},
										]}
									/>
									<Permissions agent={who.name} permissions={[]} />
									<ToolAccess
										agent={who.name}
										picked={picks[agent] ?? {}}
										onChange={save}
										failed={failed}
										retry={() => {
											if (pending) save(pending.names, pending.on);
										}}
									/>
								</>
							}
						/>
					</Panel>
				</div>
			</main>
		</div>
	);
}
