/** Compact per-account and harness access, with add flows in dialogs. */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
			tools: view.tools,
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
	const [adding, setAdding] = useState(false);
	const [pick, setPick] = useState<string>();
	const rows = connectionRows(capabilities, agent.id);
	const used = rows.filter((row) => row.accounts.length > 0);
	const permissions = (control?.permissions ?? [])
		.filter((permission) => permission.agent === agent.id)
		.map((permission) => ({ id: permission.id, what: permission.what, scope: scopeWords(permission) }));
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
				onRevoke={(id) =>
					void revokePermission(id)
						.then(showControl)
						.catch(() => {})
				}
			/>
		</>
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
