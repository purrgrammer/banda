/** UI proposal only: no API, OAuth popup, credentials, or connection writes. */
import { ArrowLeftIcon, CheckIcon, LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { Face } from "../../chat/Face.tsx";
import { MARA, SANCHO } from "../fixtures.ts";
import { Section } from "../stage.tsx";

type Scenario = "oauth" | "key" | "anonymous" | "unreachable" | "expired";
type Step = "catalogue" | "server" | "checking" | "auth" | "waiting" | "review" | "done" | "problem";
const SCENARIOS: readonly (readonly [Scenario, string])[] = [
	["oauth", "Ernesto · OAuth"],
	["key", "Bearer credential"],
	["anonymous", "No sign-in"],
	["unreachable", "Server unavailable"],
	["expired", "Expired sign-in"],
];
const AGENTS = [
	{ id: "sancho", who: SANCHO },
	{ id: "mara", who: MARA },
];
const TOOLS = [
	{
		name: "fs_read",
		title: "Read files",
		description: "Read files and browse directories in Ernesto.",
		parameters: "uri, offset, limit",
	},
	{
		name: "fs_write",
		title: "Change files",
		description: "Create or change files in Ernesto.",
		parameters: "uri, content",
	},
	{
		name: "execute",
		title: "Run actions",
		description: "Search, run routes and commit changes. Some routes read; others write.",
		parameters: "uri, params",
	},
];

export function McpSection() {
	return (
		<Section
			id="mcp"
			note="Ernesto first. Interactive UI proposal with illustrative server content; nothing connects or saves. Open the focused preview to try every sign-in and failure state."
		>
			<Button variant="outline" asChild>
				<a href="#/specimen/mcp">Open MCP connection preview</a>
			</Button>
			<McpExample />
		</Section>
	);
}

/** Focused, token-free owner review link, using the same example as the collection. */
export function McpPreview() {
	const [scheme, setScheme] = useState("light");
	const [width, setWidth] = useState("desktop");
	return (
		<div style={{ colorScheme: scheme }} className="flex h-svh flex-col bg-paper-2 text-ink">
			<header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line-soft bg-paper px-4 py-3">
				<a href="#/specimen?section=mcp" className="text-meta text-ink-2">
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
				<McpExample />
			</div>
		</div>
	);
}

function McpExample() {
	const [scenario, setScenario] = useState<Scenario>("oauth");
	const [generation, setGeneration] = useState(0);
	const scope = useRef<HTMLDivElement>(null);
	const [popupScheme, setPopupScheme] = useState("light");
	return (
		<div ref={scope} className="flex min-w-0 flex-col">
			<div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-paper-2 px-4 py-3">
				<Select
					value={scenario}
					onValueChange={(value) => setScenario(value as Scenario)}
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
				<Button variant="ghost" size="sm" onClick={() => setGeneration((old) => old + 1)}>
					Reset preview
				</Button>
				<p className="w-full text-meta text-ink-2">Simulated only. No server requests. Don’t enter real credentials.</p>
			</div>
			<McpJourney key={`${scenario}-${generation}`} scenario={scenario} />
		</div>
	);
}

function McpJourney({ scenario }: { scenario: Scenario }) {
	const id = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const [step, setStep] = useState<Step>(scenario === "expired" ? "auth" : "catalogue");
	const [url, setUrl] = useState("https://ernesto.example/mcp");
	const [name, setName] = useState("Ernesto");
	const [validation, setValidation] = useState("");
	const [credential, setCredential] = useState("");
	const [client, setClient] = useState("");
	const [scopes, setScopes] = useState("");
	const [authError, setAuthError] = useState(scenario === "expired");
	const [retried, setRetried] = useState(false);
	const [agents, setAgents] = useState<string[]>([]);
	const [reads, setReads] = useState(false);
	const service = name.trim() || "MCP server";
	const anonymous = scenario === "anonymous";
	const key = scenario === "key";
	const previous = useRef(step);
	useEffect(() => {
		if (previous.current !== step) heading.current?.focus();
		previous.current = step;
	}, [step]);
	useEffect(() => {
		if (step !== "checking") return;
		const timer = setTimeout(
			() => setStep(scenario === "unreachable" && !retried ? "problem" : anonymous ? "review" : "auth"),
			650,
		);
		return () => clearTimeout(timer);
	}, [step, scenario, anonymous, retried]);
	const check = () => {
		try {
			const address = new URL(url.trim());
			if (address.username || address.password || address.hash) throw new Error();
			if (
				address.protocol !== "https:" &&
				!(address.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname))
			)
				throw new Error();
		} catch {
			setValidation("Use an HTTPS server address, or HTTP on localhost. Leave out passwords and fragments.");
			return;
		}
		setValidation("");
		setStep("checking");
	};
	const toggle = (agent: string, on: boolean) =>
		setAgents((old) =>
			on ? [...old.filter((value) => value !== agent), agent] : old.filter((value) => value !== agent),
		);
	const title = {
		catalogue: "Connections",
		server: "Add an MCP server",
		checking: "Checking the server…",
		auth: authError ? `Sign in to ${service} again` : key ? `Connect ${service}` : `Sign in to ${service}`,
		waiting: "Finish signing in",
		review: `Review ${service}`,
		done: `${service} is connected`,
		problem: "The server didn’t answer",
	}[step];
	return (
		<div className="mx-auto flex w-full max-w-[34rem] flex-col gap-6 px-4 py-6" data-mcp-step={step}>
			{step !== "catalogue" && step !== "done" ? (
				<Button
					variant="ghost"
					size="sm"
					className="self-start"
					onClick={() => {
						setCredential("");
						setStep(step === "server" ? "catalogue" : "server");
					}}
				>
					<ArrowLeftIcon data-icon="inline-start" />
					{step === "server" ? "Connections" : "Server details"}
				</Button>
			) : null}
			<header className="flex flex-col gap-2">
				{step !== "catalogue" && step !== "server" ? <p className="break-all text-meta text-ink-2">{url}</p> : null}
				<h1 ref={heading} tabIndex={-1} className="break-words text-heading font-semibold outline-none">
					{title}
				</h1>
				{step === "catalogue" ? (
					<p className="text-ui text-ink-2">Connect your services, then choose which agents can use them.</p>
				) : null}
			</header>
			{step === "catalogue" ? (
				<>
					<div className="flex items-center gap-3 rounded-tile border border-line-soft p-4">
						<LinkIcon aria-hidden="true" className="size-5 shrink-0 text-ink-2" />
						<div className="min-w-0 flex-1">
							<p className="text-ui font-medium">Your own MCP server</p>
							<p className="text-meta text-ink-2">Add a service by its address.</p>
						</div>
					</div>
					<Button className="self-start" onClick={() => setStep("server")}>
						<PlusIcon data-icon="inline-start" />
						Add MCP server
					</Button>
				</>
			) : null}
			{step === "server" ? (
				<form
					className="flex flex-col gap-6"
					onSubmit={(event) => {
						event.preventDefault();
						check();
					}}
				>
					<FieldGroup>
						<Field data-invalid={!!validation}>
							<FieldLabel htmlFor={`${id}-url`}>Server address</FieldLabel>
							<Input
								id={`${id}-url`}
								value={url}
								onChange={(event) => {
									setUrl(event.target.value);
									setValidation("");
								}}
								aria-invalid={!!validation}
								aria-describedby={`${id}-url-help`}
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								placeholder="https://example.com/mcp"
							/>
							<FieldDescription id={`${id}-url-help`}>
								The server’s remote MCP endpoint, without credentials.
							</FieldDescription>
							{validation ? (
								<p role="alert" className="text-ui text-destructive">
									{validation}
								</p>
							) : null}
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Optional"
								maxLength={80}
							/>
							<FieldDescription>What you’ll call this connection in banda.</FieldDescription>
						</Field>
					</FieldGroup>
					<details className="text-ui">
						<summary className="cursor-pointer text-ink-2">Advanced sign-in settings</summary>
						<FieldGroup className="mt-4">
							<Field>
								<FieldLabel htmlFor={`${id}-client`}>OAuth client ID</FieldLabel>
								<Input
									id={`${id}-client`}
									value={client}
									onChange={(event) => setClient(event.target.value)}
									placeholder="Register automatically"
								/>
								<FieldDescription>Only needed if the service gives you a registered client.</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-scopes`}>Scopes</FieldLabel>
								<Input
									id={`${id}-scopes`}
									value={scopes}
									onChange={(event) => setScopes(event.target.value)}
									placeholder="Discover from the server"
								/>
								<FieldDescription>
									Optional, separated by spaces. This preview does not use these settings.
								</FieldDescription>
							</Field>
						</FieldGroup>
					</details>
					<p className="text-ui text-ink-2">We’ll check how it connects. Nothing is given to your agents yet.</p>
					<Button type="submit" className="self-start">
						Check server
					</Button>
				</form>
			) : null}
			{step === "checking" ? (
				<p role="status" className="flex items-center gap-2 text-ui text-ink-2">
					<Spinner />
					Checking MCP support and sign-in…
				</p>
			) : null}
			{step === "problem" ? (
				<>
					<p role="alert" className="text-ui text-ink-2">
						Check that the address ends at the MCP endpoint and that the server is running. Your details are still here.
					</p>
					<Button
						className="self-start"
						onClick={() => {
							setRetried(true);
							setStep("checking");
						}}
					>
						Try again
					</Button>
				</>
			) : null}
			{step === "auth" ? (
				<>
					{authError ? (
						<p role="alert" className="text-ui text-ink-2">
							Your sign-in expired or wasn’t completed. No new access has been given. Sign in again to continue.
						</p>
					) : null}
					{key ? (
						<form
							className="flex flex-col gap-5"
							onSubmit={(event) => {
								event.preventDefault();
								setCredential("");
								setStep("review");
							}}
						>
							<FieldGroup>
								<Field>
									<FieldLabel htmlFor={`${id}-key`}>Bearer credential</FieldLabel>
									<Input
										id={`${id}-key`}
										type="password"
										value={credential}
										onChange={(event) => setCredential(event.target.value)}
										autoComplete="off"
										placeholder="Use any pretend value"
										required
									/>
									<FieldDescription>
										For this preview, use a pretend value. It is discarded when you continue.
									</FieldDescription>
								</Field>
							</FieldGroup>
							<Button type="submit" className="self-start" disabled={!credential.trim()}>
								Continue
							</Button>
						</form>
					) : (
						<>
							<p className="text-ui text-ink-2">
								Continue to the service’s sign-in page, then return here. You’ll review what your agents can use before
								giving access.
							</p>
							<Button
								className="self-start"
								onClick={() => {
									setAuthError(false);
									setStep("waiting");
								}}
							>
								Continue to sign in
							</Button>
						</>
					)}
				</>
			) : null}
			{step === "waiting" ? (
				<>
					<p role="status" className="text-ui text-ink-2">
						Waiting for the service to confirm your sign-in. This page will update when you’re done.
					</p>
					<Button variant="outline" className="self-start" onClick={() => setStep("auth")}>
						Cancel sign-in
					</Button>
					<Separator />
					<div className="flex flex-col gap-3">
						<p className="text-meta text-ink-2">Specimen controls · no sign-in page was opened</p>
						<div className="flex flex-wrap gap-2">
							<Button variant="outline" size="sm" onClick={() => setStep("review")}>
								Simulate successful sign-in
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setAuthError(true);
									setStep("auth");
								}}
							>
								Simulate expired sign-in
							</Button>
						</div>
					</div>
				</>
			) : null}
			{step === "review" ? (
				<>
					<p className="text-ui text-ink-2">
						{anonymous
							? "This server needs no sign-in. No account or credential will be created."
							: "Signed in · Account 1. The server hasn’t supplied an account name."}
					</p>
					<div className="flex flex-col gap-4">
						<h2 className="text-body font-medium">What your agents will get</h2>
						<p className="text-ui text-ink-2">
							An introduction from the server and its tools. Tool use asks you first unless you explicitly allow a read
							below.
						</p>
						<ServerDetails />
					</div>
					<FieldSet>
						<FieldLegend variant="label">Read without asking</FieldLegend>
						<Field orientation="horizontal">
							<Checkbox id={`${id}-read`} checked={reads} onCheckedChange={(on) => setReads(on === true)} />
							<div className="flex min-w-0 flex-col gap-1">
								<FieldLabel htmlFor={`${id}-read`}>Allow file reads without approval</FieldLabel>
								<FieldDescription>
									Only fs_read. Turn this on only if you trust this tool to read without making changes. Run actions
									(execute) still asks.
								</FieldDescription>
							</div>
						</Field>
					</FieldSet>
					<Separator />
					<AgentChoices id={id} agents={agents} toggle={toggle} />
					<p className="text-meta text-ink-2">
						{agents.length === 0
							? "You can add the connection now and give an agent access later."
							: "Only the agents you selected will get this connection’s introduction and tools."}
					</p>
					<Button className="self-start" onClick={() => setStep("done")}>
						{agents.length ? "Add connection and give access" : "Add connection"}
					</Button>
				</>
			) : null}
			{step === "done" ? (
				<>
					<p className="flex items-center gap-2 text-ui">
						<CheckIcon aria-hidden="true" className="size-4 shrink-0" />
						{anonymous ? "No sign-in needed" : "Account 1"}
					</p>
					<p className="text-ui text-ink-2">
						{agents.length
							? `${AGENTS.filter((agent) => agents.includes(agent.id))
									.map((agent) => agent.who.name)
									.join(" and ")} can use this connection.`
							: "No agents have access yet."}{" "}
						{reads ? "File reads run without asking. Other tools ask first." : "Every tool asks for approval."}
					</p>
					<AgentChoices id={id} agents={agents} toggle={toggle} />
					<ServerDetails />
					<McpSignOut
						service={service}
						anonymous={anonymous}
						onConfirm={() => {
							setAgents([]);
							setReads(false);
							setStep(anonymous ? "server" : "auth");
						}}
					/>
				</>
			) : null}
		</div>
	);
}

function McpSignOut({ service, anonymous, onConfirm }: { service: string; anonymous: boolean; onConfirm: () => void }) {
	const trigger = useRef<HTMLButtonElement>(null);
	const [scheme, setScheme] = useState("light");
	const action = anonymous ? "Disconnect" : "Sign out";
	return (
		<AlertDialog
			onOpenChange={(open) => {
				if (open && trigger.current) setScheme(getComputedStyle(trigger.current).colorScheme);
			}}
		>
			<AlertDialogTrigger asChild>
				<Button ref={trigger} variant="outline" className="self-start">
					{action}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent size="sm" style={{ colorScheme: scheme }}>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-words">
						{anonymous ? `Disconnect ${service}?` : `Sign out of ${service}?`}
					</AlertDialogTitle>
					<AlertDialogDescription>
						Every agent loses access. To use this connection again, you’ll reconnect.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Stay connected</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={onConfirm}>
						{action}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function AgentChoices({
	id,
	agents,
	toggle,
}: {
	id: string;
	agents: readonly string[];
	toggle: (agent: string, on: boolean) => void;
}) {
	return (
		<FieldSet>
			<FieldLegend variant="label">Who can use it?</FieldLegend>
			<FieldDescription>Off for everyone until you choose.</FieldDescription>
			<FieldGroup>
				{AGENTS.map(({ id: agent, who }) => (
					<Field key={agent} orientation="horizontal">
						<Face {...who} size="message" />
						<FieldLabel htmlFor={`${id}-${agent}`}>{who.name}</FieldLabel>
						<Switch
							id={`${id}-${agent}`}
							checked={agents.includes(agent)}
							onCheckedChange={(on) => toggle(agent, on)}
						/>
					</Field>
				))}
			</FieldGroup>
		</FieldSet>
	);
}

function ServerDetails() {
	return (
		<div className="flex flex-col gap-4 text-ui">
			<details className="rounded-field border border-line-soft p-3">
				<summary className="cursor-pointer font-medium">Introduction from the server</summary>
				<div className="mt-3 flex flex-col gap-2">
					<p className="text-meta text-ink-2">
						Illustrative content, not a live server listing. Shown to agents that have access; it grants no permissions.
					</p>
					<p className="whitespace-pre-wrap break-words">
						Ernesto exposes files and actions through three tools. Read files with fs_read, change files with fs_write,
						and use execute for routes such as search. Inspect a route before running it.
					</p>
				</div>
			</details>
			<details className="rounded-field border border-line-soft p-3">
				<summary className="cursor-pointer font-medium">Tools · 3</summary>
				<div className="mt-3 flex flex-col gap-4">
					{TOOLS.map((tool) => (
						<div key={tool.name} className="flex flex-col gap-1">
							<p className="font-medium">{tool.title}</p>
							<p className="text-ink-2">{tool.description}</p>
							<details>
								<summary className="cursor-pointer text-meta text-ink-2">Tool details</summary>
								<p className="mt-2 break-words font-mono text-meta">
									{tool.name} · example parameters: {tool.parameters}
								</p>
							</details>
						</div>
					))}
				</div>
			</details>
		</div>
	);
}
