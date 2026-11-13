/** Connections: the catalogue page, and connecting, one dialog everywhere. */
import { PlugIcon } from "lucide-react";
import { useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { Band } from "../../chat/Band.tsx";
import { Catalogue } from "../../chat/Catalogue.tsx";
import { ConnectCard, ConnectDialog, type ConnectStep } from "../../chat/Connect.tsx";
import { SettingsPage } from "../../chat/Settings.tsx";
import { scopesOfChoice } from "../../lib/connect.ts";
import { choicesOf, MARA, OCTO, ROWS, SANCHO, SERVICES } from "../fixtures.ts";
import { Labelled, Section, StageContext } from "../stage.tsx";

export function ConnectSections() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<>
			<Section id="connections" note="Everything the band can work with, from the band's foot or Settings." bleed>
				{phone ? null : <Band rows={ROWS} />}
				<SettingsPage title="Connections" icon={PlugIcon} phone={phone}>
					<Catalogue services={SERVICES} />
				</SettingsPage>
			</Section>
			<Section id="connect" note="One flow everywhere: Connect, sign in at the service, done.">
				<div className="grid gap-4 lg:grid-cols-2">
					<Labelled label="An agent asks">
						<ConnectCard
							agent="Octo"
							connection="GitHub"
							id="github"
							state={{
								kind: "connect",
								why: "Octo can read your pull requests and issues, and asks before it writes.",
							}}
						/>
					</Labelled>
					<Labelled label="Signed in">
						<ConnectCard agent="Octo" connection="GitHub" id="github" state={{ kind: "done", login: "@bandarra" }} />
					</Labelled>
					<Labelled label="Signed in to an account already known">
						<ConnectCard agent="Octo" connection="GitHub" id="github" state={{ kind: "already", login: "@bandarra" }} />
					</Labelled>
					<Labelled label="The connect dialog, each step">
						<ConnectSteps />
					</Labelled>
				</div>
			</Section>
		</>
	);
}

const CONNECT_STEPS: readonly {
	readonly label: string;
	readonly agent?: string;
	readonly connection: string;
	readonly id: string;
	readonly step: ConnectStep;
	readonly account?: string;
}[] = [
	{ label: "Access to grant", connection: "Google Calendar", id: "calendar", step: { kind: "permissions" } },
	{ label: "GitHub's access", agent: "Octo", connection: "GitHub", id: "github", step: { kind: "permissions" } },
	{ label: "Starting", connection: "GitHub", id: "github", step: { kind: "starting" } },
	{
		label: "Signing in on its page",
		connection: "Google Calendar",
		id: "calendar",
		step: { kind: "code", url: "https://accounts.google.com/o/oauth2/v2/auth" },
	},
	{
		label: "A code to enter",
		agent: "Octo",
		connection: "GitHub",
		id: "github",
		step: { kind: "code", code: "WDJB-MJHT", url: "https://github.com/login/device" },
	},
	{
		label: "Failed",
		connection: "Google Calendar",
		id: "calendar",
		step: {
			kind: "failed",
			why: "Google Calendar answered 403 (SERVICE_DISABLED): Google Calendar API has not been used in project 1234 before or it is disabled.",
		},
	},
	{
		label: "Already signed in",
		agent: "Mara",
		connection: "GitHub",
		id: "github",
		step: { kind: "known", logins: ["@bandarra", "@purrgrammer"] },
	},
	{
		label: "Naming an account its server didn't",
		agent: "Octo",
		connection: "Ernesto",
		id: "ernesto",
		step: { kind: "name", login: "ernesto.example 2" },
	},
	{
		label: "Signed in for no agent",
		connection: "Google Calendar",
		id: "calendar",
		step: {
			kind: "agents",
			login: "bandarra@example.com",
			agents: [
				{ id: "sancho", name: "Sancho", face: SANCHO.face, on: true },
				{ id: "mara", name: "Mara", face: MARA.face, on: false },
				{ id: "octo", name: "Octo", face: OCTO.face, on: false },
			],
		},
	},
	{
		label: "Sharing an account",
		agent: "Mara",
		connection: "GitHub",
		id: "github",
		step: { kind: "share", login: "@bandarra" },
	},
	{
		label: "Changing one account's access",
		connection: "Google Calendar",
		id: "calendar",
		account: "@bandarra",
		step: { kind: "permissions" },
	},
	{ label: "Slack's access", agent: "Mara", connection: "Slack", id: "slack", step: { kind: "permissions" } },
	{
		label: "Slack on another port",
		agent: "Mara",
		connection: "Slack",
		id: "slack",
		step: {
			kind: "failed",
			why: "could not start signing in to Slack: Slack signs in only to a banda on port 7787 or 7788, and this one runs on port 7799: start banda with --port 7787 to connect Slack.",
		},
	},
	{
		label: "Slack signed in",
		agent: "Mara",
		connection: "Slack",
		id: "slack",
		step: { kind: "done", login: "@ana at Acme" },
	},
];

/** Each step of the connect dialog, opened by its button; the dialog takes the frame's colour scheme. */
function ConnectSteps() {
	const [open, setOpen] = useState<number | undefined>(undefined);
	const [scheme, setScheme] = useState("light");
	const [scopes, setScopes] = useState<readonly string[]>([]);
	const [on, setOn] = useState<{ readonly [agent: string]: boolean }>({});
	const listed = open === undefined ? undefined : CONNECT_STEPS[open];
	const shown =
		listed?.step.kind === "agents"
			? {
					...listed,
					step: {
						...listed.step,
						agents: listed.step.agents.map((each) => ({ ...each, on: on[each.id] ?? each.on })),
					},
				}
			: listed;
	const show = (index: number) => {
		const required = choicesOf(CONNECT_STEPS[index]?.id)?.required;
		setScopes(required === undefined ? [] : scopesOfChoice(required));
		setOn({});
		setOpen(index);
	};
	return (
		<span className="flex flex-wrap gap-2">
			{CONNECT_STEPS.map((each, index) => (
				<Button
					key={each.label}
					variant="outline"
					size="sm"
					data-connect-specimen={index}
					onClick={(event) => {
						setScheme(getComputedStyle(event.currentTarget).colorScheme);
						show(index);
					}}
				>
					{each.label}
				</Button>
			))}
			{shown === undefined ? null : (
				<ConnectDialog
					open
					onOpenChange={() => setOpen(undefined)}
					agent={shown.agent}
					connection={shown.connection}
					id={shown.id}
					account={shown.account}
					step={shown.step}
					scopes={scopes}
					choices={choicesOf(shown.id)}
					onScopes={setScopes}
					scopesChanged={scopes.length > 1}
					onSignIn={() => setOpen(undefined)}
					onPermissions={() =>
						show(CONNECT_STEPS.findIndex((each) => each.id === shown.id && each.step.kind === "permissions"))
					}
					onAgent={(agent, value) => setOn((was) => ({ ...was, [agent]: value }))}
					style={{ colorScheme: scheme }}
				/>
			)}
		</span>
	);
}
