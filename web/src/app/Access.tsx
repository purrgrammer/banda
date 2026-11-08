/** Compact per-account and harness access, with add flows in dialogs. */
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { CapabilitiesView, ControlView, PermissionView } from "../../../src/server/api.ts";
import { type AheadAction, AllowAhead } from "../chat/AllowAhead.tsx";
import { Confirm } from "../chat/Confirm.tsx";
import { Block, type ConnectionRow, Connections, Permissions, RowOf, Rows } from "../chat/Settings.tsx";
import { allowGrain, allowHost, revokePermission, switchAccount, switchPublicConnection } from "../lib/api.ts";
import { usedWords } from "../lib/permissions.ts";
import { usePhone } from "../lib/phone.ts";
import { showCapabilities, showControl, useShell } from "../lib/shell.ts";
import { ConnectFlow } from "./ConnectFlow.tsx";
import { ConnectionToolSettings } from "./ConnectionToolSettings.tsx";
import { AddHarnessButton, HarnessAccessTile } from "./HarnessConnections.tsx";
import { McpSetup } from "./McpSetup.tsx";

/**
 * The rows of an agent's connections: every connection signed in to that banda has, then those banda ships and the
 * owner has not added yet (Connect adds them), each with its accounts and whether `agent` may use each.
 */
export function connectionRows(capabilities: CapabilitiesView | undefined, agent: string): ConnectionRow[] {
	const rows: ConnectionRow[] = (capabilities?.connections ?? [])
		.filter(
			(view) => (view.accounts !== undefined || view.agents !== undefined) && view.accepted?.connection !== undefined,
		)
		.map((view) => ({
			connection: view.accepted?.connection?.service ?? view.name,
			id: view.name,
			url: view.accepted?.connection?.url,
			tools: view.tools,
			...(view.review !== true && view.tools.some((tool) => tool.classed !== undefined)
				? {
						settings: <ConnectionToolSettings view={view} service={view.accepted?.connection?.service ?? view.name} />,
					}
				: {}),
			accounts:
				view.accepted?.connection?.auth === "none" && view.agents !== undefined
					? [{ login: "No sign-in needed", on: view.agents.includes(agent) }]
					: (view.accounts ?? []).map((account) => ({
							login: account.stale === true ? `${account.label} · sign in again` : account.label,
							account: account.account,
							on: account.agents.includes(agent),
						})),
		}));
	for (const shipped of capabilities?.shipped ?? [])
		if (!shipped.added && shipped.connection.auth !== "none" && !rows.some((row) => row.id === shipped.name))
			rows.push({
				connection: shipped.connection.service,
				id: shipped.name,
				url: shipped.connection.url,
				accounts: [],
			});
	return rows;
}

/** Whether `agent` can reach anything: an account of some connection switched on for it. */
export const reachesSomething = (capabilities: CapabilitiesView | undefined, agent: string) =>
	(capabilities?.connections ?? []).some(
		(view) =>
			(view.accepted?.connection?.auth === "none" && view.agents?.includes(agent)) ||
			(view.accounts ?? []).some((account) => account.stale !== true && account.agents.includes(agent)),
	);

/** How long a permission lasts, in words: "Always", "For this task", "Until Fri 18:00". */
export function scopeWords(permission: Pick<PermissionView, "scope" | "until">): string {
	if (permission.scope === "always" || permission.scope === "host") return "Always";
	if (permission.scope === "task") return "For this task";
	return permission.until === undefined
		? "For a while"
		: `Until ${new Date(permission.until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
}

export function AccessTab({
	agent,
	capabilities,
	control,
}: {
	agent: { readonly id: string; readonly name: string };
	capabilities: CapabilitiesView | undefined;
	control: ControlView | undefined;
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	const [pick, setPick] = useState<string>();
	/** The connection whose Allow without asking is open. */
	const [ahead, setAhead] = useState<string>();
	const rows = connectionRows(capabilities, agent.id);
	const used = rows.filter((row) => row.accounts.length > 0);
	const theirs = (control?.permissions ?? []).filter((permission) => permission.agent === agent.id);
	// a host allowed is listed with Allow a host, not among the other permissions
	const hosts = theirs.flatMap((permission) =>
		permission.host === undefined ? [] : [{ id: permission.id, host: permission.host }],
	);
	const now = Date.now();
	const permissions = theirs
		.filter((permission) => permission.host === undefined)
		.map((permission) => ({
			id: permission.id,
			what: permission.what,
			scope: scopeWords(permission),
			used: usedWords(permission, now),
			...(permission.connection === undefined ? {} : { connection: permission.connection }),
		}));
	const permitting = (capabilities?.connections ?? []).flatMap((view) => {
		const service = view.accepted?.connection;
		if (service === undefined) return [];
		const actions = view.tools.flatMap((tool) =>
			tool.on && tool.grains !== undefined ? [{ tool: tool.name, grains: tool.grains }] : [],
		);
		const accounts = (view.accounts ?? []).filter(
			(account) => account.stale !== true && account.agents.includes(agent.id),
		);
		return [
			{
				id: view.name,
				name: service.service,
				url: service.url,
				...(actions.length === 0 || accounts.length === 0
					? {}
					: {
							add: (
								<Button variant="ghost" size="xs" className="text-ink-2" onClick={() => setAhead(view.name)}>
									<PlusIcon />
									Allow without asking
								</Button>
							),
							actions,
							accounts: accounts.map((account) => ({ account: account.account, label: account.label })),
						}),
			},
		];
	});
	const allowing = permitting.find((connection) => connection.id === ahead);
	return (
		<>
			<Connections
				agent={agent.name}
				compact
				rows={used}
				empty={`${agent.name} reaches nothing yet.`}
				onSwitch={(row, account, on) => {
					if (row.id === undefined) return;
					setError(undefined);
					void (
						account.account === undefined
							? switchPublicConnection(row.id, agent.id, on)
							: switchAccount(row.id, account.account, agent.id, on)
					)
						.then(showCapabilities)
						.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)));
				}}
			/>
			<Button
				variant="outline"
				size="sm"
				className="-mt-5 self-start"
				onClick={() => {
					setPick(undefined);
					setAdding(true);
				}}
			>
				Add
			</Button>
			<Dialog open={adding} onOpenChange={setAdding}>
				<DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Add a connection</DialogTitle>
						<DialogDescription>Choose a connection for {agent.name}.</DialogDescription>
					</DialogHeader>
					<div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
						{pick === undefined ? (
							<>
								{rows.map((row) => (
									<Button key={row.id} variant="outline" onClick={() => setPick(row.id)}>
										{row.connection}
									</Button>
								))}
								<Button variant="outline" onClick={() => setPick("")}>
									Add MCP server
								</Button>
							</>
						) : pick === "" || !capabilities?.shipped?.some((view) => view.name === pick) ? (
							<McpSetup
								key={pick}
								{...(pick === "" ? {} : { connection: pick })}
								agent={agent}
								onClose={() => setPick(undefined)}
							/>
						) : (
							<ConnectFlow key={pick} connection={pick} agent={agent} onDismiss={() => setPick(undefined)} />
						)}
					</div>
				</DialogContent>
			</Dialog>
			{error === undefined ? null : <p className="-mt-5 text-meta text-danger">{error}</p>}
			<HarnessAccess agent={agent} />
			<Permissions
				agent={agent.name}
				permissions={permissions}
				connections={permitting}
				onRevoke={(id) =>
					void revokePermission(id)
						.then(showControl)
						.catch(() => {})
				}
			/>
			<AllowAheadDialog
				agent={agent}
				connection={
					allowing?.actions === undefined || allowing.accounts === undefined
						? undefined
						: { ...allowing, actions: allowing.actions, accounts: allowing.accounts }
				}
				onClose={() => setAhead(undefined)}
			/>
			<AllowHost agent={agent} hosts={hosts} />
		</>
	);
}

/**
 * Allow without asking, for one connection: a dialog on the desktop, a sheet from below on the phone. Allowed, it
 * closes and Permissions lists what the daemon stored; refused, it says why and stays open.
 */
function AllowAheadDialog({
	agent,
	connection,
	onClose,
}: {
	agent: { readonly id: string; readonly name: string };
	connection:
		| {
				readonly id: string;
				readonly name: string;
				readonly actions: readonly AheadAction[];
				readonly accounts: readonly { readonly account: string; readonly label: string }[];
		  }
		| undefined;
	onClose: () => void;
}) {
	const phone = usePhone();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const open = connection !== undefined;
	const close = (still: boolean) => {
		if (still) return;
		setError(undefined);
		onClose();
	};
	const title = connection === undefined ? "" : `Let ${agent.name} act on ${connection.name} without asking`;
	const note = "It still asks for anything else, and you can take it back here at any time.";
	const form =
		connection === undefined ? null : (
			<AllowAhead
				key={connection.id}
				agent={agent.name}
				actions={connection.actions}
				accounts={connection.accounts}
				busy={busy}
				error={error}
				onCancel={() => close(false)}
				onAllow={(asked) => {
					setBusy(true);
					setError(undefined);
					void allowGrain(agent.id, { connection: connection.id, ...asked })
						.then((after) => {
							showControl(after);
							close(false);
						})
						.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
						.finally(() => setBusy(false));
				}}
			/>
		);
	return phone ? (
		<Sheet open={open} onOpenChange={close}>
			<SheetContent side="bottom" className="max-h-[calc(100dvh-2rem)] overflow-y-auto px-4 pb-6">
				<SheetHeader className="px-0">
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>{note}</SheetDescription>
				</SheetHeader>
				{form}
			</SheetContent>
		</Sheet>
	) : (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{note}</DialogDescription>
				</DialogHeader>
				{form}
			</DialogContent>
		</Dialog>
	);
}

/**
 * Allow this agent a host as the owner, not answering an ask: anything it sends there goes straight through,
 * WebSockets included (a relay, a live API). `*.example.com` covers every name under it, `*` every host.
 */
function AllowHost({
	agent,
	hosts,
}: {
	agent: { readonly id: string; readonly name: string };
	hosts: readonly { readonly id: string; readonly host: string }[];
}) {
	const [host, setHost] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const every = host.trim() === "*" || /^[a-z]+:\/\/\*(?::\d+)?\/?$/i.test(host.trim());
	return (
		<Block
			title="Hosts"
			note={`Anything ${agent.name} sends there goes straight through, without asking you, WebSockets included. Use *.example.com for every name under it, or * for every host.`}
		>
			{hosts.length === 0 ? (
				<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">
					{`None yet: ${agent.name} asks before sending anywhere.`}
				</p>
			) : (
				<Rows>
					{hosts.map(({ id, host: allowed }) => (
						<RowOf
							key={id}
							title={allowed === "*" ? "Every host" : allowed}
							detail="Always"
							end={
								<Confirm
									title="Take this back?"
									body={`${agent.name} will ask you again before sending to ${allowed === "*" ? "any host" : allowed}.`}
									action="Take back"
									keep="Keep it"
									onConfirm={() =>
										void revokePermission(id)
											.then(showControl)
											.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
									}
								>
									<Button variant="destructive" size="xs">
										Revoke
									</Button>
								</Confirm>
							}
						/>
					))}
				</Rows>
			)}
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (host.trim() === "" || busy) return;
					setBusy(true);
					setError(undefined);
					void allowHost(agent.id, host)
						.then((after) => {
							showControl(after);
							setHost("");
						})
						.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)))
						.finally(() => setBusy(false));
				}}
			>
				<Input
					aria-label="Host to allow"
					placeholder="relay.example.com"
					value={host}
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					onChange={(event) => setHost(event.target.value)}
				/>
				<Button type="submit" variant="outline" disabled={host.trim() === "" || busy}>
					Allow
				</Button>
			</form>
			{every ? (
				<p className="text-meta text-danger">
					{`* lets ${agent.name} send anything anywhere on the internet without asking you.`}
				</p>
			) : null}
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
		</Block>
	);
}

/** Connected harnesses keep their switches visible when turned off. */
function HarnessAccess({ agent }: { agent: { readonly id: string; readonly name: string } }) {
	const { harnesses } = useShell();
	if (harnesses === undefined) return null;
	const connected = harnesses.harnesses.filter(({ name }) => harnesses.accounts[name] !== undefined);
	const names = connected.map(({ name }) => name);
	return (
		<Block title="Harnesses" note={`Coding agents on this computer ${agent.name} may hand work to.`}>
			{names.length === 0 ? (
				<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">
					{`${agent.name} hands work to none yet.`}
				</p>
			) : (
				<div className="flex flex-col">
					{names.map((name) => (
						<HarnessAccessTile key={name} name={name} agent={agent} />
					))}
				</div>
			)}
			<AddHarnessButton agent={agent} size="sm" />
		</Block>
	);
}
