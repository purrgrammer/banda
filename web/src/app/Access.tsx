/**
 * An agent's Access tab on the daemon's data (DESIGN.md "The app"): what the agent has, and only that: the accounts and
 * the harnesses on for it, then its permissions, each revokable. Each section's "Show more" reveals its rest: every
 * connection with its switches or Connect and Add MCP server; the harnesses connected but off for it and Add a harness. A switch is in
 * effect at once; Connect opens the connect card under the row, for this agent.
 */
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CapabilitiesView, ControlView, PermissionView } from "../../../src/server/api.ts";
import { Block, type ConnectionRow, Connections, Permissions } from "../chat/Settings.tsx";
import { revokePermission, switchAccount, switchPublicConnection } from "../lib/api.ts";
import { showCapabilities, showControl, useShell } from "../lib/shell.ts";
import { ConnectFlow } from "./ConnectFlow.tsx";
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
		if (!shipped.added && shipped.connection.auth !== "none")
			rows.push({ connection: shipped.connection.service, id: shipped.name, accounts: [] });
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
	const [all, setAll] = useState(false);
	const rows = connectionRows(capabilities, agent.id);
	const used = rows
		.map((row) => ({ ...row, accounts: row.accounts.filter((account) => account.on) }))
		.filter((row) => row.accounts.length > 0);
	const permissions = (control?.permissions ?? [])
		.filter((permission) => permission.agent === agent.id)
		.map((permission) => ({ id: permission.id, what: permission.what, scope: scopeWords(permission) }));
	return (
		<>
			<Connections
				agent={agent.name}
				rows={all ? rows : used}
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
				connect={(row, close) =>
					row.id === undefined ? null : capabilities?.connections.find((view) => view.name === row.id)?.agents !==
						undefined ? (
						<McpSetup connection={row.id} onClose={close} />
					) : (
						<ConnectFlow connection={row.id} agent={agent} onDismiss={close} />
					)
				}
			/>
			{all ? (
				<Button
					variant="outline"
					size="sm"
					className="-mt-5 self-start"
					onClick={() => {
						location.hash = "#/connections?add=true";
					}}
				>
					Add MCP server
				</Button>
			) : null}
			<ShowMore all={all} more={rows.length - used.length} onAll={setAll} />
			{error === undefined ? null : <p className="-mt-5 text-meta text-danger">{error}</p>}
			<HarnessAccess agent={agent} />
			<Permissions
				agent={agent.name}
				permissions={permissions}
				onRevoke={(id) =>
					void revokePermission(id)
						.then(showControl)
						.catch(() => {})
				}
			/>
		</>
	);
}

/** "Show N more" under a section, or "Show less" once it shows all; "Add more" when nothing is hidden but adding. */
function ShowMore({ all, more, onAll }: { all: boolean; more: number; onAll: (all: boolean) => void }) {
	return (
		<Button variant="ghost" size="sm" className="-mt-5 self-start text-ink-2" onClick={() => onAll(!all)}>
			{all ? <ChevronUpIcon /> : <ChevronDownIcon />}
			{all ? "Show less" : more > 0 ? `Show ${more} more` : "Add more"}
		</Button>
	);
}

/** The harnesses this agent may hand work to, a section of their own; "Show more" adds those off for it, and Add. */
function HarnessAccess({ agent }: { agent: { readonly id: string; readonly name: string } }) {
	const { harnesses } = useShell();
	const [all, setAll] = useState(false);
	if (harnesses === undefined) return null;
	const connected = harnesses.harnesses.filter(({ name }) => harnesses.accounts[name] !== undefined);
	const on = connected.filter(({ name }) => harnesses.accounts[name]?.agents.includes(agent.id) === true);
	const names = (all ? connected : on).map(({ name }) => name);
	return (
		<>
			<Block title="Harnesses" note={`Coding agents on this computer ${agent.name} may hand work to.`}>
				{names.length === 0 ? (
					<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">
						{all ? "None connected yet." : `${agent.name} hands work to none yet.`}
					</p>
				) : (
					<div className="flex flex-col gap-3">
						{names.map((name) => (
							<HarnessAccessTile key={name} name={name} agent={agent} />
						))}
					</div>
				)}
				{all ? <AddHarnessButton agent={agent} size="sm" /> : null}
			</Block>
			<ShowMore all={all} more={connected.length - on.length} onAll={setAll} />
		</>
	);
}
