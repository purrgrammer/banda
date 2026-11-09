/**
 * A connection's details, in every state: changed in place, as the review on adding it, with tools waiting for the owner,
 * with the kinds it draws and a connection with no tools listed yet. Illustrative data, no daemon: a tap only changes what
 * is shown here.
 */
import { useState } from "react";
import { type Classed, optionsOf, type Setting } from "../../../../src/core/tool-kinds.ts";
import type { ConnectionToolView, ConnectionView } from "../../../../src/server/api.ts";
import { type AgentsFor, ConnectionDetailsView } from "../../chat/ConnectionDetails.tsx";
import type { ChatAgent } from "../../lib/navigation.ts";
import { MARA, SANCHO } from "../fixtures.ts";
import { Labelled, Section } from "../stage.tsx";

const AGENTS: readonly ChatAgent[] = [
	{ id: "sancho", ...SANCHO },
	{ id: "mara", ...MARA },
];

type Row = [
	title: string,
	words: string,
	group: string,
	classed: Classed,
	setting: Setting,
	more?: { readonly waiting?: true; readonly ask?: "always" },
];

const ROWS: readonly Row[] = [
	["list_issues", "List issues", "Issues", { kind: "read", from: "definition" }, "allow"],
	["get_issue", "Get an issue", "Issues", { kind: "read", from: "definition" }, "ask"],
	["create_issue", "Create an issue", "Issues", { kind: "write", from: "definition" }, "ask"],
	["delete_issue", "Delete an issue", "Issues", { kind: "write", from: "definition" }, "always"],
	[
		"merge_pull_request",
		"Merge a pull request",
		"Pull requests",
		{ kind: "floor", floor: "private", from: "definition" },
		"always",
	],
	["list_pull_requests", "List pull requests", "Pull requests", { kind: "read", from: "definition" }, "allow"],
	["get_me", "Who you are", "Account", { kind: "read", from: "you" }, "allow"],
	["manage_billing", "Change the plan", "Account", { kind: "floor", floor: "money", from: "definition" }, "off"],
	["search_gists", "Search gists", "Gists", { kind: "read", from: "server" }, "off", { waiting: true }],
	["run_macro", "Run a macro", "Gists", { kind: "unknown", from: "nobody" }, "off", { waiting: true }],
	["drop_cache", "Drop the cache", "Gists", { kind: "write", from: "server" }, "off"],
];

const toolOf = ([title, words, group, classed, setting, more]: Row): ConnectionToolView => ({
	name: `github__${title}`,
	title,
	words,
	description: `${words} on GitHub.`,
	kind: classed.kind === "read" && classed.from !== "server" ? "read" : "write",
	on: setting !== "off",
	classed,
	group,
	setting,
	options: optionsOf(classed, more?.ask),
	...(more?.waiting === true ? { waiting: true as const } : {}),
});

const TOOLS = ROWS.map(toolOf);
const GROUPS = ["Issues", "Pull requests", "Account", "Gists"];

const ACCOUNT = {
	account: "bandarra",
	id: "bandarra",
	label: "@bandarra",
	at: Date.UTC(2026, 10, 13, 9, 30),
	agents: ["sancho"],
	scopes: ["repo", "read:user"],
};

const VIEW: ConnectionView = {
	name: "github",
	state: "connected",
	accepted: {
		sha: "specimen",
		connection: {
			service: "GitHub",
			url: "https://api.githubcopilot.com/mcp/",
			where: "api.githubcopilot.com",
			boxed: false,
			auth: "oauth",
			reads: [],
			floors: {},
		},
	},
	tools: TOOLS,
	groups: GROUPS,
	accounts: [ACCOUNT, { ...ACCOUNT, account: "work", id: "work", label: "@work", agents: [], stale: true, scopes: [] }],
	draws: [
		{
			kind: "pull_request",
			label: "Pull request",
			follow: { wakes: ["reviewed", "merged", "checks failed"], tells: ["new comment", "renamed: …"] },
		},
		{ kind: "check_run", label: "Check run", follow: { wakes: ["failed", "timed out"], tells: [] } },
		{ kind: "repository", label: "Repository", follow: { wakes: [], tells: [] } },
		{ kind: "gist", label: "Gist" },
	],
};

const ACCESS = {
	choices: [
		{ label: "Your repositories", scopes: ["repo"] },
		{ label: "Your organizations", scopes: ["read:org"] },
	],
	note: "Changing access signs in again.",
};

/** The details changed in place, as a tap would change them. */
function Live({ view, mode }: { view: ConnectionView; mode: "details" | "review" }) {
	const [tools, setTools] = useState(view.tools);
	const [chosen, setChosen] = useState<{ readonly [tool: string]: Setting }>({});
	const [selected, setSelected] = useState<readonly string[]>(["sancho"]);
	const onSwitch = (agent: string, on: boolean) =>
		setSelected((old) => (on ? [...old, agent] : old.filter((each) => each !== agent)));
	const agentsFor: AgentsFor[] = [{ key: "bandarra", selected, onSwitch }];
	return (
		<ConnectionDetailsView
			view={{ ...view, tools }}
			service="GitHub"
			about="Read and change code, issues and pull requests"
			mode={mode}
			chosen={chosen}
			onChoose={setChosen}
			onSetTools={(settings) =>
				setTools((old) =>
					old.map((tool) =>
						settings[tool.title] === undefined ? tool : { ...tool, setting: settings[tool.title] as Setting },
					),
				)
			}
			agents={AGENTS}
			agentsFor={agentsFor}
			access={ACCESS}
			onChangeAccess={() => {}}
			onSignOut={() => {}}
		/>
	);
}

export function ConnectionDetailsSection() {
	return (
		<Section
			id="connection-details"
			note="What the owner opens from Settings or an agent's Access, and the same component as the review on adding a connection."
		>
			<div className="flex flex-col gap-6">
				<Labelled label="Details: changes are at once">
					<div className="max-w-2xl">
						<Live view={VIEW} mode="details" />
					</div>
				</Labelled>
				<Labelled label="Review, on adding: nothing changes until Save">
					<div className="max-w-2xl">
						<Live view={{ ...VIEW, name: "reviewing", accounts: [], draws: [] }} mode="review" />
					</div>
				</Labelled>
				<Labelled label="Its tools not listed yet">
					<div className="max-w-2xl">
						<ConnectionDetailsView
							view={{ ...VIEW, tools: [], groups: [], draws: [], accounts: [] }}
							service="GitHub"
							mode="details"
							agents={AGENTS}
							agentsFor={[]}
						/>
					</div>
				</Labelled>
			</div>
		</Section>
	);
}
