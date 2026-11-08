/**
 * What a connection's tools may do, in every state: the review after sign-in (collapsed, expanded, while banda sorts
 * them, when it could not), and the same list in Settings with a tool listed since, new and off. Illustrative data,
 * no daemon: Accept only closes it.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Setting } from "../../../src/core/tool-kinds.ts";
import type { ConnectionToolView, ConnectionView } from "../../../src/server/api.ts";
import { ReviewBody, reviewTally, ToolList, ToolReview, toolTally } from "../chat/ToolKinds.tsx";
import { Section } from "./stage.tsx";

type Row = [
	title: string,
	words: string,
	group: string,
	kind: "read" | "write" | "floor",
	from: "service" | "you" | "guess" | "none",
	setting: Setting,
	more?: { floor?: "money" | "account"; fresh?: true; shipped?: true },
];

const ROWS: readonly Row[] = [
	["list_issues", "List issues", "Issues", "read", "service", "allow"],
	["get_issue", "Get an issue", "Issues", "read", "service", "allow"],
	["search_issues", "Search issues", "Issues", "read", "guess", "allow"],
	["create_issue", "Create an issue", "Issues", "write", "guess", "ask"],
	["update_issue", "Update an issue", "Issues", "write", "service", "ask"],
	["delete_issue", "Delete an issue", "Issues", "write", "service", "always"],
	["list_projects", "List projects", "Projects", "read", "guess", "allow"],
	["create_project", "Create a project", "Projects", "write", "none", "ask"],
	["archive_project", "Archive a project", "Projects", "write", "guess", "off", { fresh: true }],
	["list_comments", "List comments", "Comments", "read", "service", "allow"],
	["create_comment", "Comment on an issue", "Comments", "write", "guess", "ask"],
	["get_viewer", "Who you are", "Account", "read", "service", "allow"],
	["invite_member", "Invite a member", "Account", "floor", "guess", "always", { floor: "account" }],
	["update_billing", "Change the plan", "Account", "floor", "you", "always", { floor: "money" }],
];

const toolOf = ([title, words, group, kind, from, setting, more]: Row): ConnectionToolView => ({
	name: `linear__${title}`,
	title,
	words,
	description: `${words} in Linear.`,
	kind: kind === "read" && from !== "guess" ? "read" : "write",
	on: setting !== "off",
	classed: { kind, ...(more?.floor === undefined ? {} : { floor: more.floor }), from },
	group,
	setting,
	proposed: setting,
	options:
		kind === "floor" && from !== "guess"
			? ["always", "off"]
			: kind === "read"
				? ["allow", "ask", "off"]
				: ["allow", "ask", "always", "off"],
	...(more?.fresh === true ? { fresh: true as const } : {}),
	...(more?.floor === undefined || from === "guess" ? {} : { floor: more.floor }),
});

const VIEW: ConnectionView = {
	name: "linear",
	state: "connected",
	accepted: {
		sha: "0".repeat(64),
		connection: {
			service: "Linear",
			url: "https://mcp.linear.app/mcp",
			where: "mcp.linear.app",
			boxed: false,
			auth: "oauth",
			reads: [],
			floors: {},
			why: "",
		},
	},
	groups: ["Issues", "Projects", "Comments", "Account"],
	review: true,
	tools: ROWS.filter((row) => row[6]?.fresh !== true).map(toolOf),
};

const SETTINGS_VIEW: ConnectionView = { ...VIEW, tools: ROWS.map(toolOf) };
const { review: _review, ...REVIEWED } = SETTINGS_VIEW;

function Review({ view, expanded = false }: { view: ConnectionView; expanded?: boolean }) {
	const [chosen, setChosen] = useState<{ readonly [tool: string]: Setting }>({});
	return (
		<div className="flex flex-col gap-2">
			<p className="font-semibold text-ui">Linear's tools</p>
			<p className="text-meta text-ink-2">{reviewTally(view, chosen)}</p>
			<ReviewBody view={view} service="Linear" chosen={chosen} onChosen={setChosen} expanded={expanded} />
		</div>
	);
}

function InSettings() {
	const [set, setSet] = useState<{ readonly [tool: string]: Setting }>({});
	const settingOf = (tool: ConnectionToolView) => set[tool.title] ?? tool.setting ?? "ask";
	return (
		<div className="flex flex-col gap-2">
			<p className="text-meta text-ink-2">{toolTally(REVIEWED.tools, settingOf)}. For every agent.</p>
			<ToolList
				service="Linear"
				tools={REVIEWED.tools}
				groups={REVIEWED.groups}
				settingOf={settingOf}
				onTools={(settings) => setSet((old) => ({ ...old, ...settings }))}
				onGroup={(_group, setting, tools) =>
					setSet((old) => ({ ...old, ...Object.fromEntries(tools.map((tool) => [tool.title, setting])) }))
				}
			/>
		</div>
	);
}

function OpenReview() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button variant="outline" className="self-start" onClick={() => setOpen(true)} data-open-review="">
				Open the review
			</Button>
			<ToolReview view={VIEW} service="Linear" open={open} onOpenChange={setOpen} onAccept={async () => {}} />
		</>
	);
}

export function ToolKindsSection() {
	return (
		<Section
			id="tool-kinds"
			title="What a connection's tools may do"
			note="The review after sign-in, then the same list in Settings. Each tool says who said what it does; a group is collapsed to its count and one control. Ask on a read, or Always ask on a write, asks every time."
		>
			<div className="flex min-w-0 flex-col gap-6">
				<OpenReview />
				<div data-state="collapsed">
					<Review view={VIEW} />
				</div>
				<div data-state="expanded">
					<Review view={VIEW} expanded />
				</div>
				<div data-state="classifying">
					<Review view={{ ...VIEW, classifying: true }} />
				</div>
				<div data-state="unguessed">
					<Review view={{ ...VIEW, unguessed: "The model couldn't answer: rate limited." }} />
				</div>
				<div data-state="settings">
					<InSettings />
				</div>
			</div>
		</Section>
	);
}
