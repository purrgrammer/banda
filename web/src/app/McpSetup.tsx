/**
 * Owner-driven MCP setup. Also embeddable in a future owner-reviewed proposal card. `McpSetup` holds the state and
 * talks to the daemon; `McpSetupView` draws it from that state alone, so the specimen shows every phase over a fixture.
 */
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type { McpConfig } from "../../../src/core/mcp-config.ts";
import type { Setting } from "../../../src/core/tool-kinds.ts";
import type { CapabilitiesView, ConnectionView } from "../../../src/server/api.ts";
import { Confirm } from "../chat/Confirm.tsx";
import { McpAgents, McpDetails, McpServerForm } from "../chat/McpConnection.tsx";
import { ToolReview, ToolSettings, toolTally } from "../chat/ToolKinds.tsx";
import {
	actOnCapability,
	addMcp,
	refreshConnection,
	reviewTools,
	setGroupSetting,
	setToolSettings,
	signIn,
	signOutAccount,
	switchAccount,
	switchPublicConnection,
} from "../lib/api.ts";
import { freshAccounts } from "../lib/connect.ts";
import { type ChatAgent, chatAgents } from "../lib/navigation.ts";
import { showCapabilities, useShell } from "../lib/shell.ts";

export type McpPhase = "setup" | "auth" | "waiting" | "review" | "done";

/** What the setup shows, as its container holds it: the daemon's view of the connection and the owner's choices so far. */
export type McpSetupState = {
	readonly phase: McpPhase;
	readonly view?: ConnectionView | undefined;
	readonly agents: readonly ChatAgent[];
	readonly busy: boolean;
	readonly error: string;
	readonly credential: string;
	readonly account: string;
	readonly selected: readonly string[];
	/** The review of what its tools may do is open. */
	readonly reviewing: boolean;
	/** The sign-in page this visit opened, while waiting. */
	readonly link?: string | undefined;
	/** The phase Back returns to, when there is one to return to. */
	readonly back?: McpPhase | undefined;
};

export type McpSetupActions = {
	readonly close: () => void;
	readonly back: () => void;
	readonly addServer: (config: McpConfig) => void;
	readonly setCredential: (credential: string) => void;
	readonly connectWithKey: () => void;
	readonly connectAnonymous: () => void;
	readonly startSignIn: () => void;
	readonly cancelSignIn: () => void;
	readonly useConnected: () => void;
	readonly retry: () => void;
	readonly setAccount: (account: string) => void;
	readonly setReviewing: (open: boolean) => void;
	/** Accept the review with the settings chosen: only then do its tools run as they say. */
	readonly acceptReview: (settings: { readonly [tool: string]: Setting }) => Promise<void>;
	/** A tool's setting, or a group's, changed in the list: at once, for every agent. */
	readonly setToolSettings: (settings: { readonly [tool: string]: Setting }) => void;
	readonly setGroupSetting: (group: string, setting: Setting) => void;
	readonly switchAgent: (agent: string, on: boolean) => void;
	readonly save: () => void;
	readonly review: () => void;
	readonly signInAnother: () => void;
	readonly signOut: () => void;
};

/**
 * The sign-in made before can't be used now: its account no longer fits the connection's file, or the last sign-in
 * did not finish (the daemon says so as its problem). Said plainly before asking to sign in again.
 */
export const signInExpired = (view: ConnectionView): boolean =>
	view.accepted?.connection !== undefined &&
	view.accepted.connection.auth !== "none" &&
	freshAccounts(view).length === 0 &&
	((view.accounts?.length ?? 0) > 0 || view.state === "problem");

/**
 * Whether Back can return to `phase` for `view` now: to sign in (never for a server without one: there is nothing to
 * do there but connect) or to review, which needs a connected server and the account being reviewed. Never to the
 * form (the server was added) or to done (a confirmation, not a place).
 */
const reachable = (phase: McpPhase, view: ConnectionView | undefined, account: string): boolean => {
	const anonymous = view?.accepted?.connection?.auth === "none";
	if (phase === "auth") return view !== undefined && !anonymous;
	if (phase !== "review" || view?.state !== "connected") return false;
	return anonymous || freshAccounts(view).some((each) => each.account === account);
};

export function McpSetup({
	connection,
	onCreated,
	agent,
	onClose,
}: {
	connection?: string;
	agent?: { readonly id: string; readonly name: string };
	onCreated?: (name: string) => void;
	onClose: () => void;
}) {
	const shell = useShell();
	const [name, setName] = useState(connection);
	const [phase, setPhase] = useState<McpPhase>(connection ? "review" : "setup");
	// the phases this visit went through, so Back goes to the one before when it still applies
	const [trail, setTrail] = useState<readonly McpPhase[]>([]);
	const [busy, setBusy] = useState(false);
	const working = useRef(false);
	const alive = useRef(true);
	const [error, setError] = useState("");
	const [credential, setCredential] = useState("");
	const [account, setAccount] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [reviewing, setReviewing] = useState(false);
	const offered = useRef<string | undefined>(undefined);
	const [link, setLink] = useState<string>();
	const [before, setBefore] = useState<number>();
	const view = shell.capabilities?.connections.find((each) => each.name === name);
	const summary = view?.accepted?.connection;
	const anonymous = summary?.auth === "none";
	const accounts = freshAccounts(view);
	const chosen = accounts.find((each) => each.account === account);
	const active = anonymous ? (view?.agents ?? []) : (chosen?.agents ?? []);
	const agents = shell.companion === undefined ? [] : chatAgents(shell.agents, shell.companion);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	/** Move to `next`, remembering where from, so Back can return there. */
	const go = (next: McpPhase) => {
		if (phase === next) return;
		setTrail((old) => [...old, phase]);
		setPhase(next);
	};
	/** Return to `to` from `phase`: the step forward is forgotten, and a typed credential never travels along. */
	const comeBack = (to: McpPhase) => {
		setCredential("");
		setLink(undefined);
		setTrail((old) => (old.at(-1) === to ? old.slice(0, -1) : old));
		setPhase(to);
	};
	const previous = trail.at(-1);
	const back = previous !== undefined && reachable(previous, view, account) ? previous : undefined;
	// Server state, not the OAuth popup, confirms success. Returning after a reload resumes from the same connection.
	useEffect(() => {
		if (!view) return;
		if (view.state === "connected") {
			// a finished sign-in starts a new chapter: there is nothing before review to go back to
			if (phase === "waiting" && view.finished?.at !== before) {
				setPhase("review");
				setTrail([]);
				setLink(undefined);
			}
			if (!account || !freshAccounts(view).some((each) => each.account === account))
				setAccount(view.finished?.account ?? freshAccounts(view)[0]?.account ?? "");
		} else if (
			phase === "review" &&
			(view.state === "sign-in" ||
				view.state === "key" ||
				(view.state === "problem" && freshAccounts(view).length === 0))
		)
			setPhase("auth");
	}, [view, phase, before, account]);
	const initialized = useRef("");
	useEffect(() => {
		const key = `${name}/${account}/${view?.accepted?.sha}`;
		if (initialized.current === key) return;
		initialized.current = key;
		setSelected([...new Set([...active, ...(agent === undefined ? [] : [agent.id])])]);
	}, [name, account, view, active, agent]);
	// once its tools are listed, a server the owner added opens on what they may do: once a file, never again by itself
	useEffect(() => {
		if (phase !== "review" || view?.review !== true || view.state !== "connected" || view.tools.length === 0) return;
		const key = `${view.name}/${view.accepted?.sha}`;
		if (offered.current === key) return;
		offered.current = key;
		setReviewing(true);
	}, [phase, view]);
	const update = (next: CapabilitiesView) => {
		showCapabilities(next);
		return next.connections.find((each) => each.name === name);
	};
	const run = async (work: () => Promise<void>) => {
		if (working.current) return;
		working.current = true;
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (failed) {
			if (alive.current) setError(failed instanceof Error ? failed.message : "Couldn’t finish. Try again.");
		} finally {
			working.current = false;
			if (alive.current) setBusy(false);
		}
	};
	const start = () =>
		void run(async () => {
			if (!name) return;
			const popup = window.open("about:blank", "_blank");
			if (popup) popup.opener = null;
			try {
				setBefore(view?.finished?.at);
				const result = await signIn(name);
				if ("connected" in result) {
					popup?.close();
					update(await refreshConnection(name));
					go("review");
					return;
				}
				const url = "url" in result ? result.url : result.page;
				setLink(url);
				go("waiting");
				if (popup) popup.location.replace(url);
			} catch (failed) {
				popup?.close();
				throw failed;
			}
		});
	const save = () =>
		void run(async () => {
			if (!view?.accepted || !name) return;
			if (view.state !== "connected") throw new Error("Finish connecting before giving access.");
			if (!anonymous && !chosen) throw new Error("Choose a signed-in account first.");
			const current: ConnectionView = view;
			const allowed = anonymous
				? (current.agents ?? [])
				: (current.accounts?.find((each) => each.account === account)?.agents ?? []);
			for (const agent of agents)
				if (selected.includes(agent.id) !== allowed.includes(agent.id))
					update(
						await (anonymous
							? switchPublicConnection(name, agent.id, selected.includes(agent.id), current.accepted?.sha)
							: switchAccount(name, account, agent.id, selected.includes(agent.id), current.accepted?.sha)),
					);
			go("done");
		});
	const actions: McpSetupActions = {
		close: onClose,
		back: () => {
			if (back !== undefined) comeBack(back);
		},
		addServer: (config) =>
			void run(async () => {
				const result = await addMcp(config);
				showCapabilities(result.capabilities);
				if (!alive.current) return;
				setName(result.name);
				onCreated?.(result.name);
				const added = result.capabilities.connections.find((each) => each.name === result.name);
				go(added?.state === "connected" ? "review" : "auth");
			}),
		setCredential,
		connectWithKey: () => {
			if (!view) return;
			const key = credential;
			setCredential("");
			void run(async () => {
				update(await actOnCapability({ action: "key", name: view.name, key }));
				go("review");
			});
		},
		connectAnonymous: () => {
			if (!view) return;
			void run(async () => {
				update(await refreshConnection(view.name));
				go("review");
			});
		},
		startSignIn: start,
		// banda stops waiting; a sign-in page open at the service stays open, and the copy says so
		cancelSignIn: () => comeBack("auth"),
		useConnected: () => go("review"),
		retry: () => {
			if (!view) return;
			void run(async () => {
				update(await refreshConnection(view.name));
			});
		},
		setAccount,
		setReviewing,
		acceptReview: async (settings) => {
			if (!view) return;
			update(await reviewTools(view.name, view.accepted?.sha ?? "", settings));
		},
		setToolSettings: (settings) => {
			if (!view) return;
			void run(async () => {
				update(await setToolSettings(view.name, settings));
			});
		},
		setGroupSetting: (group, setting) => {
			if (!view) return;
			void run(async () => {
				update(await setGroupSetting(view.name, group, setting));
			});
		},
		switchAgent: (agent, on) =>
			phase === "done"
				? void run(async () => {
						if (!view) return;
						update(
							await (anonymous
								? switchPublicConnection(view.name, agent, on, view.accepted?.sha)
								: switchAccount(view.name, account, agent, on, view.accepted?.sha)),
						);
					})
				: setSelected((old) => (on ? [...new Set([...old, agent])] : old.filter((each) => each !== agent))),
		save,
		review: () => {
			if (!view) return;
			setSelected([...active]);
			go("review");
		},
		signInAnother: () => go("auth"),
		signOut: () => {
			if (!view) return;
			void run(async () => {
				update(
					await (anonymous
						? actOnCapability({ action: "disconnect", name: view.name })
						: signOutAccount(view.name, account)),
				);
				setAccount("");
				setSelected([]);
				setTrail([]);
				setPhase("auth");
			});
		},
	};
	return (
		<McpSetupView
			state={{ phase, view, agents, busy, error, credential, account, selected, reviewing, link, back }}
			actions={actions}
		/>
	);
}

/** The setup as the owner sees it, from its state alone: no daemon, no network, nothing kept. */
export function McpSetupView({ state, actions }: { state: McpSetupState; actions: McpSetupActions }) {
	const { phase, view, agents, busy, error, credential, account, selected, reviewing, link, back } = state;
	const id = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const summary = view?.accepted?.connection;
	const service = summary?.service ?? "MCP server";
	const anonymous = summary?.auth === "none";
	const accounts = freshAccounts(view);
	const chosen = accounts.find((each) => each.account === account);
	const active = anonymous ? (view?.agents ?? []) : (chosen?.agents ?? []);
	const expired = view !== undefined && phase === "auth" && signInExpired(view);
	const previous = useRef(phase);
	useEffect(() => {
		if (previous.current !== phase) heading.current?.focus();
		previous.current = phase;
	}, [phase]);
	return (
		<div className="flex min-w-0 flex-col gap-6" data-mcp-phase={phase}>
			<div className="flex flex-wrap gap-2">
				<Button variant="ghost" size="sm" onClick={actions.close} disabled={busy}>
					Connections
				</Button>
				{back !== undefined && (phase === "auth" || phase === "review") ? (
					<Button variant="ghost" size="sm" onClick={actions.back} disabled={busy}>
						<ArrowLeftIcon data-icon="inline-start" />
						{back === "review" ? "Back to review" : "Back to sign-in"}
					</Button>
				) : null}
			</div>
			<header className="flex flex-col gap-2">
				<h1 ref={heading} tabIndex={-1} className="break-words text-heading font-semibold outline-none">
					{phase === "setup"
						? "Add an MCP server"
						: phase === "auth"
							? expired
								? `Sign in to ${service} again`
								: `Connect ${service}`
							: phase === "waiting"
								? "Finish signing in"
								: phase === "done"
									? `${service} is connected`
									: `Review ${service}`}
				</h1>
				{summary?.url ? <p className="break-all text-meta text-ink-2">{summary.url}</p> : null}
			</header>
			{error ? (
				<p role="alert" className="whitespace-pre-wrap break-words text-ui text-destructive">
					{error}
				</p>
			) : null}
			{phase === "setup" ? (
				<McpServerForm busy={busy} onSubmit={actions.addServer} />
			) : !view ? (
				<p role="status" className="text-ui text-ink-2">
					Loading connection…
				</p>
			) : null}
			{view && phase === "auth" ? (
				<>
					{expired ? (
						<p role="alert" className="text-ui">
							Your sign-in expired or wasn’t completed. No new access has been given. Sign in again to continue.
						</p>
					) : null}
					<p className="text-ui text-ink-2">
						Sign in, then review the server’s introduction and tools before giving an agent access.
					</p>
					{view.problem ? <p className="break-words text-ui text-ink-2">{view.problem}</p> : null}
					{summary?.auth === "key" ? (
						<form
							className="flex flex-col gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								actions.connectWithKey();
							}}
						>
							<FieldGroup>
								<Field>
									<FieldLabel htmlFor={`${id}-credential`}>Bearer credential</FieldLabel>
									<Input
										id={`${id}-credential`}
										type="password"
										autoComplete="off"
										value={credential}
										onChange={(event) => actions.setCredential(event.target.value)}
										disabled={busy}
										required
									/>
								</Field>
							</FieldGroup>
							<Button type="submit" className="self-start" disabled={busy || !credential.trim()}>
								Connect
							</Button>
						</form>
					) : anonymous ? (
						<Button className="self-start" disabled={busy} onClick={actions.connectAnonymous}>
							Connect
						</Button>
					) : (
						<Button className="self-start" disabled={busy} onClick={actions.startSignIn}>
							{busy ? <Spinner data-icon="inline-start" /> : null}Continue to sign in
						</Button>
					)}
					{accounts.length > 0 && back !== "review" ? (
						<Button variant="outline" className="self-start" onClick={actions.useConnected}>
							Use a connected account
						</Button>
					) : null}
				</>
			) : null}
			{view && phase === "waiting" ? (
				<>
					<p role="status" className="text-ui text-ink-2">
						Waiting for the service to confirm your sign-in. Return here when you’re done.
					</p>
					{view.code ? <p className="font-mono text-body">{view.code.code}</p> : null}
					{link ? (
						<Button asChild className="self-start">
							<a href={link} target="_blank" rel="noopener noreferrer">
								Open sign-in page
							</a>
						</Button>
					) : null}
					{view.problem ? (
						<p role="alert" className="break-words text-ui text-destructive">
							{view.problem}
						</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" disabled={busy} onClick={actions.startSignIn}>
							Start sign-in again
						</Button>
						<Button variant="ghost" disabled={busy} onClick={actions.cancelSignIn}>
							Cancel sign-in
						</Button>
					</div>
					<p className="text-meta text-ink-2">
						No agent gets access from signing in alone. Closing this page or cancelling here doesn’t cancel a sign-in
						already open at the service.
					</p>
				</>
			) : null}
			{view && (phase === "review" || phase === "done") ? (
				<>
					{view.state !== "connected" ? (
						<>
							<p role="alert" className="text-ui text-ink-2">
								{view.problem ?? "The server’s tools haven’t been loaded yet."}
							</p>
							<Button variant="outline" className="self-start" disabled={busy} onClick={actions.retry}>
								Try again
							</Button>
						</>
					) : null}
					{anonymous ? (
						<p className="text-ui text-ink-2">No sign-in needed. No account or credential was created.</p>
					) : (
						<Field>
							<FieldLabel htmlFor={`${id}-account`}>Account</FieldLabel>
							<Select value={account} onValueChange={actions.setAccount} disabled={busy}>
								<SelectTrigger id={`${id}-account`}>
									<SelectValue placeholder="Choose an account" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{accounts.map((each) => (
											<SelectItem key={each.account} value={each.account}>
												{each.label}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							{chosen?.id.startsWith("account ") ? (
								<p className="text-meta text-ink-2">
									The server hasn’t supplied an account name. Each sign-in is numbered.
								</p>
							) : null}
						</Field>
					)}
					<McpDetails view={view} />
					{view.state === "connected" && view.review ? (
						<div className="flex flex-col gap-2 rounded-field border border-line-soft p-3" data-tool-review-offer="">
							<p className="font-medium text-ui">What its tools may do</p>
							<p className="text-meta text-ink-2">
								{view.classifying
									? "banda is sorting its tools."
									: `Until you accept, every tool asks first. ${toolTally(view.tools, (tool) => tool.proposed ?? "ask")}.`}
							</p>
							<Button variant="outline" size="sm" className="self-start" onClick={() => actions.setReviewing(true)}>
								Review its tools
							</Button>
						</div>
					) : view.state === "connected" ? (
						<ToolSettings
							view={view}
							service={service}
							busy={busy}
							onTools={actions.setToolSettings}
							onGroup={actions.setGroupSetting}
						/>
					) : null}
					<ToolReview
						view={view}
						service={service}
						open={reviewing}
						onOpenChange={actions.setReviewing}
						onAccept={actions.acceptReview}
					/>
					<Separator />
					<McpAgents
						agents={agents}
						selected={phase === "done" ? active : selected}
						disabled={busy || view.state !== "connected" || (!anonymous && !chosen)}
						onSwitch={actions.switchAgent}
					/>
					{phase === "review" ? (
						<>
							<p className="text-meta text-ink-2">
								{selected.length
									? "Only the agents you selected will get access."
									: "No agents have access unless you select them. You can do this later."}
							</p>
							<Button
								className="self-start"
								disabled={busy || view.state !== "connected" || (!anonymous && !chosen)}
								onClick={actions.save}
							>
								{busy ? "Saving…" : "Save access"}
							</Button>
						</>
					) : (
						<Button variant="outline" className="self-start" onClick={actions.review}>
							Review tool permissions
						</Button>
					)}
					<div className="flex flex-wrap gap-2">
						{!anonymous ? (
							<Button variant="ghost" size="sm" disabled={busy} onClick={actions.signInAnother}>
								Sign in another account
							</Button>
						) : null}
						<Confirm
							title={anonymous ? `Disconnect ${service}?` : `Sign out of ${service}?`}
							body="Agents lose access to this sign-in. You can reconnect later."
							action={anonymous ? "Disconnect" : "Sign out"}
							keep="Stay connected"
							onConfirm={actions.signOut}
						>
							<Button variant="outline" size="sm" disabled={busy || (!anonymous && !chosen)}>
								{anonymous ? "Disconnect" : "Sign out"}
							</Button>
						</Confirm>
					</div>
				</>
			) : null}
		</div>
	);
}
