/**
 * MCP: the app's own setup (`app/McpSetup.tsx`, through its view) over a fixture connection, in every phase and for
 * each way a server signs in. The specimen keeps the owner's choices in its own state and never calls the daemon:
 * a tap moves between phases as the daemon's answer would. Pick a scenario and a phase above it.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import type { Setting } from "../../../../src/core/tool-kinds.ts";
import type { ConnectionToolView, ConnectionView } from "../../../../src/server/api.ts";
import { type McpPhase, type McpSetupActions, McpSetupView } from "../../app/McpSetup.tsx";
import type { ChatAgent } from "../../lib/navigation.ts";
import { MARA, SANCHO } from "../fixtures.ts";
import { Section } from "../stage.tsx";

type Scenario = "oauth" | "key" | "anonymous" | "expired";
const SCENARIOS: readonly (readonly [Scenario, string])[] = [
	["oauth", "Ernesto · OAuth"],
	["key", "Bearer credential"],
	["anonymous", "No sign-in"],
	["expired", "Expired sign-in"],
];
const PHASES: readonly (readonly [McpPhase, string])[] = [
	["setup", "Server"],
	["auth", "Sign in"],
	["waiting", "Waiting"],
	["review", "Review"],
	["done", "Connected"],
];
const AGENTS: readonly ChatAgent[] = [
	{ id: "sancho", ...SANCHO },
	{ id: "mara", ...MARA },
];
const URL_WORDS = "Use an HTTPS server address, or HTTP on localhost, without credentials or a fragment.";
const tool = (
	title: string,
	words: string,
	description: string,
	hint?: "reads" | "changes",
	kind: ConnectionToolView["kind"] = "write",
): ConnectionToolView => ({
	name: `ernesto__${title}`,
	title,
	words,
	description,
	kind,
	on: true,
	parameters: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
	...(hint === undefined ? {} : { hint }),
	classed:
		hint === "reads"
			? { kind: "read", from: "server" }
			: hint === "changes"
				? { kind: "write", from: "server" }
				: { kind: "unknown", from: "nobody" },
	group: "Tools",
	setting: hint === "reads" ? "ask" : "always",
	options:
		hint === "reads" ? ["allow", "ask", "off"] : hint === "changes" ? ["always", "off"] : ["allow", "always", "off"],
});
const TOOLS: readonly ConnectionToolView[] = [
	tool("fs_read", "Read files", "Read files and browse directories in Ernesto.", "reads"),
	tool("fs_write", "Change files", "Create or change files in Ernesto."),
	tool("execute", "Run actions", "Search, run routes and commit changes. Some routes read; others write."),
];
const NOTES =
	"Ernesto exposes files and actions through three tools. Read files with fs_read, change files with fs_write, and use execute for routes such as search. Inspect a route before running it.";
const ACCOUNT = {
	account: "account-1",
	id: "account 1",
	label: "ernesto.example",
	numbered: true,
	at: Date.UTC(2026, 10, 13, 9, 30),
};

/**
 * The daemon's view of the fixture server for a scenario: connected once its tools were listed (and still, while another
 * account signs in), else waiting for the sign-in the scenario needs.
 */
function connection(
	scenario: Scenario,
	phase: McpPhase,
	connected: boolean,
	agents: readonly string[],
): ConnectionView {
	const auth = scenario === "key" ? "key" : scenario === "anonymous" ? "none" : "oauth";
	return {
		name: "ernesto",
		groups: ["Tools"],
		draws: [],
		accepted: {
			version: "specimen",
			connection: {
				service: "Ernesto",
				url: "https://ernesto.example/mcp",
				where: "ernesto.example",
				auth,
				reads: [],
				floors: {},
			},
		},
		state:
			phase === "waiting"
				? "signing-in"
				: connected
					? "connected"
					: auth === "oauth"
						? "sign-in"
						: auth === "key"
							? "key"
							: "connecting",
		tools: connected ? TOOLS : [],
		...(connected ? { notes: NOTES } : {}),
		...(auth === "none"
			? { agents }
			: connected
				? { accounts: [{ ...ACCOUNT, agents }] }
				: scenario === "expired"
					? { accounts: [{ ...ACCOUNT, agents: [], stale: true }] }
					: { accounts: [] }),
		...(phase === "waiting" && auth === "oauth"
			? { code: { code: "HJKL-4821", page: "https://ernesto.example/device", expires: ACCOUNT.at + 900_000 } }
			: {}),
	};
}

/** The setup over the fixture, moving between phases as the daemon's answers would; nothing is sent anywhere. */
function McpExample({
	scenario,
	phase,
	onPhase,
}: {
	scenario: Scenario;
	phase: McpPhase;
	onPhase: (p: McpPhase) => void;
}) {
	const [error, setError] = useState("");
	const [credential, setCredential] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [chosen, setChosen] = useState<{ readonly [tool: string]: Setting }>({});
	const [granted, setGranted] = useState<string[]>([]);
	// the server's tools were listed: once the setup reached review, until the owner signs out
	const [connected, setConnected] = useState(phase === "review" || phase === "done");
	// the phases gone through, as the app keeps them: Back returns to sign-in or review, never to the form
	const [trail, setTrail] = useState<readonly McpPhase[]>([]);
	const view = phase === "setup" ? undefined : connection(scenario, phase, connected, granted);
	const previous = trail.at(-1);
	const back =
		previous === "review" && view?.state === "connected"
			? previous
			: previous === "auth" && scenario !== "anonymous"
				? previous
				: undefined;
	const go = (next: McpPhase) => {
		setError("");
		if (next === "review" || next === "done") setConnected(true);
		setTrail((old) => [...old, phase]);
		onPhase(next);
	};
	const comeBack = (to: McpPhase) => {
		setError("");
		setCredential("");
		setTrail((old) => (old.at(-1) === to ? old.slice(0, -1) : old));
		onPhase(to);
	};
	const actions: McpSetupActions = {
		close: () => {
			setTrail([]);
			onPhase("setup");
		},
		back: () => {
			if (back !== undefined) comeBack(back);
		},
		addServer: (config) => {
			let address: URL | undefined;
			try {
				address = new URL(config.url);
			} catch {}
			const local = address?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(address.hostname);
			if (
				address === undefined ||
				address.username ||
				address.password ||
				address.hash ||
				!(address.protocol === "https:" || local)
			)
				return setError(URL_WORDS);
			go(scenario === "anonymous" ? "review" : "auth");
		},
		setCredential,
		connectWithKey: () => {
			setCredential("");
			go("review");
		},
		connectAnonymous: () => go("review"),
		startSignIn: () => go("waiting"),
		cancelSignIn: () => comeBack("auth"),
		useConnected: () => go("review"),
		retry: () => {},
		setAccount: () => {},
		setLabel: () => {},
		setChosen,
		setTools: () => {},
		switchAgent: (agent, on) => {
			const set = phase === "done" ? setGranted : setSelected;
			set((old) => (on ? [...new Set([...old, agent])] : old.filter((each) => each !== agent)));
		},
		save: () => {
			setGranted(selected);
			go("done");
		},
		review: () => {
			setSelected(granted);
			go("review");
		},
		signInAnother: () => go("auth"),
		signOut: () => {
			setGranted([]);
			setSelected([]);
			setConnected(false);
			setTrail([]);
			onPhase("auth");
		},
	};
	return (
		<div className="mx-auto w-full max-w-[34rem] px-4 py-6">
			<McpSetupView
				state={{
					phase,
					view,
					agents: AGENTS,
					busy: false,
					error,
					credential,
					account: ACCOUNT.account,
					label: "",
					selected,
					chosen,
					back,
				}}
				actions={actions}
			/>
		</div>
	);
}

/** The scenario and the phase, chosen above the setup; a change starts the setup over. */
function McpStage() {
	const [scenario, setScenario] = useState<Scenario>("oauth");
	const [phase, setPhase] = useState<McpPhase>("setup");
	const [generation, setGeneration] = useState(0);
	const scope = useRef<HTMLDivElement>(null);
	const [popupScheme, setPopupScheme] = useState("light");
	const restart = (next: Scenario) => {
		setScenario(next);
		setPhase(next === "expired" ? "auth" : "setup");
		setGeneration((old) => old + 1);
	};
	return (
		<div ref={scope} className="flex min-w-0 flex-col" data-mcp-specimen="">
			<div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-paper-2 px-4 py-3">
				<Select
					value={scenario}
					onValueChange={(value) => restart(value as Scenario)}
					onOpenChange={(open) => {
						if (open && scope.current) setPopupScheme(getComputedStyle(scope.current).colorScheme);
					}}
				>
					<SelectTrigger aria-label="Specimen scenario">
						<SelectValue />
					</SelectTrigger>
					<SelectContent style={{ colorScheme: popupScheme }}>
						<SelectGroup>
							{SCENARIOS.map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
				<Tabs
					value={phase}
					onValueChange={(value) => {
						setPhase(value as McpPhase);
						setGeneration((old) => old + 1);
					}}
					className="max-w-full overflow-x-auto"
				>
					<TabsList aria-label="Phase">
						{PHASES.map(([value, label]) => (
							<TabsTrigger key={value} value={value} className="whitespace-nowrap">
								{label}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
			</div>
			<McpExample key={`${scenario}-${generation}`} scenario={scenario} phase={phase} onPhase={setPhase} />
		</div>
	);
}

export function McpSection() {
	return (
		<Section
			id="mcp"
			note="Adding a server the owner names: check it, sign in, review its introduction and tools, choose who may use it. The focused preview tries every phase and sign-in."
		>
			<Button variant="outline" asChild>
				<a href="#/specimen/mcp">Open MCP connection preview</a>
			</Button>
			<McpStage />
		</Section>
	);
}

/** A page of its own, for a browser test and a focused look; the page's scheme follows the theme, dialogs included. */
export function McpPreview() {
	const [scheme, setScheme] = useState("light");
	const [width, setWidth] = useState("desktop");
	useEffect(() => {
		const was = document.documentElement.style.colorScheme;
		document.documentElement.style.colorScheme = scheme;
		return () => {
			document.documentElement.style.colorScheme = was;
		};
	}, [scheme]);
	return (
		<div style={{ colorScheme: scheme }} className="flex h-svh flex-col bg-paper-2 text-ink">
			<header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft bg-paper px-4 py-3">
				<a href="#/specimen?section=mcp" className="text-meta text-ink-2 hover:text-ink">
					MCP connections · specimen
				</a>
				<div className="ml-auto flex flex-wrap gap-2">
					<Tabs value={scheme} onValueChange={setScheme}>
						<TabsList aria-label="Theme">
							<TabsTrigger value="light">Light</TabsTrigger>
							<TabsTrigger value="dark">Dark</TabsTrigger>
						</TabsList>
					</Tabs>
					<Tabs value={width} onValueChange={setWidth}>
						<TabsList aria-label="Preview width">
							<TabsTrigger value="desktop">Desktop</TabsTrigger>
							<TabsTrigger value="phone">Phone</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
			</header>
			<div
				className={cn(
					"mx-auto w-full flex-1 overflow-y-auto bg-paper",
					width === "phone" ? "max-w-[390px] border-x border-line-soft" : "max-w-[960px]",
				)}
			>
				<McpStage />
			</div>
		</div>
	);
}
