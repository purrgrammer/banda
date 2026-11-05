/**
 * An agent's Access tab on the daemon's data (DESIGN.md "The app"): its connections first, one row per connection that
 * is signed in to, with one switch per account and Connect when none is; then what it may do without asking, each
 * revokable. A switch is in effect at once; Connect opens the connect card under the row, for this agent.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CapabilitiesView, ControlView, PermissionView } from "../../../src/server/api.ts";
import { connectHarness, disconnectHarness, switchHarness } from "../areas/harnesses.ts";
import { HarnessConnectCard } from "../chat/Harness.tsx";
import { type ConnectionRow, Connections, Permissions } from "../chat/Settings.tsx";
import { revokePermission, switchAccount, switchPublicConnection } from "../lib/api.ts";
import { showCapabilities, showControl, useShell } from "../lib/shell.ts";
import { ConnectFlow } from "./ConnectFlow.tsx";
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
	const permissions = (control?.permissions ?? [])
		.filter((permission) => permission.agent === agent.id)
		.map((permission) => ({ id: permission.id, what: permission.what, scope: scopeWords(permission) }));
	return (
		<>
			<Connections
				agent={agent.name}
				rows={connectionRows(capabilities, agent.id)}
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
			<HarnessAccess agent={agent} />
			<Button
				variant="outline"
				size="sm"
				className="self-start"
				onClick={() => {
					location.hash = "#/connections?add=true";
				}}
			>
				Add MCP server
			</Button>
			{error === undefined ? null : <p className="-mt-5 text-meta text-danger">{error}</p>}
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

/** The harnesses banda can run on this computer, each connected in a folder, and on for this agent or not. */
function HarnessAccess({ agent }: { agent: { readonly id: string; readonly name: string } }) {
	const { harnesses } = useShell();
	const [error, setError] = useState<string | undefined>(undefined);
	if (harnesses === undefined || harnesses.harnesses.length === 0) return null;
	const doing = (what: Promise<unknown>) => {
		setError(undefined);
		void what.catch((failed: unknown) => setError(failed instanceof Error ? failed.message : String(failed)));
	};
	return (
		<div className="flex flex-col gap-3">
			{harnesses.harnesses.map(({ name, service }) => {
				const account = harnesses.accounts[name];
				return (
					<HarnessConnectCard
						key={name}
						agent={agent.name}
						harness={service}
						connected={account?.folder}
						on={account?.agents.includes(agent.id) === true}
						onConnect={(folder) => doing(connectHarness(name, folder, agent.id))}
						onSwitch={(on) => doing(switchHarness(name, agent.id, on))}
						onDisconnect={() => doing(disconnectHarness(name))}
					/>
				);
			})}
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
		</div>
	);
}
