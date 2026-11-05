/** Owner-driven MCP setup. Also embeddable in a future owner-reviewed proposal card. */
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type { CapabilitiesView, ConnectionView } from "../../../src/server/api.ts";
import { Confirm } from "../chat/Confirm.tsx";
import { McpAgents, McpDetails, McpReadChoices, McpServerForm } from "../chat/McpConnection.tsx";
import {
	actOnCapability,
	addMcp,
	refreshConnection,
	setConnectionReads,
	signIn,
	signOutAccount,
	switchAccount,
	switchPublicConnection,
} from "../lib/api.ts";
import { freshAccounts } from "../lib/connect.ts";
import { chatAgents } from "../lib/navigation.ts";
import { showCapabilities, useShell } from "../lib/shell.ts";

type Phase = "setup" | "auth" | "waiting" | "review" | "done";
export function McpSetup({
	connection,
	onCreated,
	onClose,
}: {
	connection?: string;
	onCreated?: (name: string) => void;
	onClose: () => void;
}) {
	const shell = useShell();
	const id = useId();
	const [name, setName] = useState(connection);
	const [phase, setPhase] = useState<Phase>(connection ? "review" : "setup");
	const [busy, setBusy] = useState(false);
	const working = useRef(false);
	const alive = useRef(true);
	const [error, setError] = useState("");
	const [credential, setCredential] = useState("");
	const [account, setAccount] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [reads, setReads] = useState<string[]>([]);
	const [link, setLink] = useState<string>();
	const [before, setBefore] = useState<number>();
	const heading = useRef<HTMLHeadingElement>(null);
	const view = shell.capabilities?.connections.find((each) => each.name === name);
	const summary = view?.accepted?.connection;
	const service = summary?.service ?? "MCP server";
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
	const previous = useRef(phase);
	useEffect(() => {
		if (previous.current !== phase) heading.current?.focus();
		previous.current = phase;
	}, [phase]);
	// Server state, not the OAuth popup, confirms success. Returning after a reload resumes from the same connection.
	useEffect(() => {
		if (!view) return;
		if (view.state === "connected") {
			if (phase === "waiting" && view.finished?.at !== before) {
				setPhase("review");
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
		setSelected([...active]);
		setReads(view?.tools.filter((tool) => tool.kind === "read").map((tool) => tool.title) ?? []);
	}, [name, account, view, active]);
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
					setPhase("review");
					return;
				}
				const url = "url" in result ? result.url : result.page;
				setLink(url);
				setPhase("waiting");
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
			let current: ConnectionView = view;
			const old = view.tools
				.filter((tool) => tool.kind === "read")
				.map((tool) => tool.title)
				.sort();
			if (JSON.stringify(old) !== JSON.stringify([...reads].sort())) {
				const next = update(await setConnectionReads(name, reads, view.accepted.sha));
				if (!next) throw new Error("This connection was removed. Return to Connections.");
				current = next;
			}
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
			setPhase("done");
		});
	return (
		<div className="flex min-w-0 flex-col gap-6" data-mcp-phase={phase}>
			<Button variant="ghost" size="sm" className="self-start" onClick={onClose} disabled={busy}>
				Connections
			</Button>
			<header className="flex flex-col gap-2">
				<h1 ref={heading} tabIndex={-1} className="break-words text-heading font-semibold outline-none">
					{phase === "setup"
						? "Add an MCP server"
						: phase === "auth"
							? `Connect ${service}`
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
				<McpServerForm
					busy={busy}
					onSubmit={(config) =>
						void run(async () => {
							const result = await addMcp(config);
							showCapabilities(result.capabilities);
							if (!alive.current) return;
							setName(result.name);
							onCreated?.(result.name);
							const added = result.capabilities.connections.find((each) => each.name === result.name);
							setPhase(added?.state === "connected" ? "review" : "auth");
						})
					}
				/>
			) : !view ? (
				<p role="status" className="text-ui text-ink-2">
					Loading connection…
				</p>
			) : null}
			{view && phase === "auth" ? (
				<>
					<p className="text-ui text-ink-2">
						Sign in, then review the server’s introduction and tools before giving an agent access.
					</p>
					{view.problem ? <p className="break-words text-ui text-ink-2">{view.problem}</p> : null}
					{summary?.auth === "key" ? (
						<form
							className="flex flex-col gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								const key = credential;
								setCredential("");
								void run(async () => {
									update(await actOnCapability({ action: "key", name: view.name, key }));
									setPhase("review");
								});
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
										onChange={(event) => setCredential(event.target.value)}
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
						<Button
							className="self-start"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									update(await refreshConnection(view.name));
									setPhase("review");
								})
							}
						>
							Connect
						</Button>
					) : (
						<Button className="self-start" disabled={busy} onClick={start}>
							{busy ? <Spinner data-icon="inline-start" /> : null}Continue to sign in
						</Button>
					)}
					{accounts.length ? (
						<Button variant="outline" className="self-start" onClick={() => setPhase("review")}>
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
					<Button variant="outline" className="self-start" disabled={busy} onClick={start}>
						Start sign-in again
					</Button>
					<p className="text-meta text-ink-2">
						No agent gets access from signing in alone. Closing this page doesn’t cancel a sign-in already open at the
						service.
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
							<Button
								variant="outline"
								className="self-start"
								disabled={busy}
								onClick={() =>
									void run(async () => {
										update(await refreshConnection(view.name));
									})
								}
							>
								Try again
							</Button>
						</>
					) : null}
					{anonymous ? (
						<p className="text-ui text-ink-2">No sign-in needed. No account or credential was created.</p>
					) : (
						<Field>
							<FieldLabel htmlFor={`${id}-account`}>Account</FieldLabel>
							<Select value={account} onValueChange={setAccount} disabled={busy}>
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
					{phase === "review" ? <McpReadChoices view={view} reads={reads} onChange={setReads} disabled={busy} /> : null}
					<Separator />
					<McpAgents
						agents={agents}
						selected={phase === "done" ? active : selected}
						disabled={busy || view.state !== "connected" || (!anonymous && !chosen)}
						onSwitch={(agent, on) =>
							phase === "done"
								? void run(async () => {
										update(
											await (anonymous
												? switchPublicConnection(view.name, agent, on, view.accepted?.sha)
												: switchAccount(view.name, account, agent, on, view.accepted?.sha)),
										);
									})
								: setSelected((old) => (on ? [...new Set([...old, agent])] : old.filter((each) => each !== agent)))
						}
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
								onClick={save}
							>
								{busy ? "Saving…" : "Save access"}
							</Button>
						</>
					) : (
						<Button
							variant="outline"
							className="self-start"
							onClick={() => {
								setSelected([...active]);
								setReads(view.tools.filter((tool) => tool.kind === "read").map((tool) => tool.title));
								setPhase("review");
							}}
						>
							Review tool permissions
						</Button>
					)}
					<div className="flex flex-wrap gap-2">
						{!anonymous ? (
							<Button variant="ghost" size="sm" disabled={busy} onClick={() => setPhase("auth")}>
								Sign in another account
							</Button>
						) : null}
						<Confirm
							title={anonymous ? `Disconnect ${service}?` : `Sign out of ${service}?`}
							body="Agents lose access to this sign-in. You can reconnect later."
							action={anonymous ? "Disconnect" : "Sign out"}
							keep="Stay connected"
							onConfirm={() =>
								void run(async () => {
									update(
										await (anonymous
											? actOnCapability({ action: "disconnect", name: view.name })
											: signOutAccount(view.name, account)),
									);
									setAccount("");
									setSelected([]);
									setPhase("auth");
								})
							}
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
