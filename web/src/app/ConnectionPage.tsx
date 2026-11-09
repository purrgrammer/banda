/**
 * A connection's page, on the daemon's data: its details, to check and to change, reached from Settings → Connections
 * and from an agent's Access. Each change is sent with the version the owner saw, so a stale view changes nothing.
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AccountView } from "../../../src/server/api.ts";
import { Confirm } from "../chat/Confirm.tsx";
import { type AgentsFor, ConnectionDetailsView } from "../chat/ConnectionDetails.tsx";
import { setConnectionTools, signOutAccount, switchAccount, switchPublicConnection } from "../lib/api.ts";
import { scopeChoicesOf } from "../lib/connect.ts";
import { chatAgents } from "../lib/navigation.ts";
import { showCapabilities, useShell } from "../lib/shell.ts";
import { ConnectFlow } from "./ConnectFlow.tsx";
import { McpSetup } from "./McpSetup.tsx";

const wordsOf = (failed: unknown) => (failed instanceof Error ? failed.message : "Couldn't save it. Try again.");

export function ConnectionPage({ connection, onClose }: { connection: string; onClose: () => void }) {
	const shell = useShell();
	const view = shell.capabilities?.connections.find((each) => each.name === connection);
	const shipped = shell.capabilities?.shipped?.find((each) => each.name === connection);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [changing, setChanging] = useState<AccountView>();
	const [leaving, setLeaving] = useState<AccountView>();
	const [setup, setSetup] = useState(false);
	const version = useRef(view?.accepted?.version);
	version.current = view?.accepted?.version ?? version.current;
	const summary = view?.accepted?.connection;
	if (view === undefined || summary === undefined) return <p className="text-ui text-ink-2">Loading connection…</p>;
	// a server the owner added and has not connected yet is still being set up
	if (setup || (shipped === undefined && view.state !== "connected"))
		return <McpSetup connection={connection} onClose={setup ? () => setSetup(false) : onClose} />;
	const service = summary.service;
	const anonymous = summary.auth === "none";
	const agents = shell.companion === undefined ? [] : chatAgents(shell.agents, shell.companion);
	const access = scopeChoicesOf(shipped?.access, shipped?.connection.required);
	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (failed) {
			setError(wordsOf(failed));
		} finally {
			setBusy(false);
		}
	};
	const agentsFor: AgentsFor[] = anonymous
		? [
				{
					key: "public",
					selected: view.agents ?? [],
					onSwitch: (agent, on) =>
						void run(async () =>
							showCapabilities(await switchPublicConnection(connection, agent, on, version.current)),
						),
				},
			]
		: (view.accounts ?? []).map((account) => ({
				key: account.account,
				label: (view.accounts?.length ?? 0) > 1 ? account.label : undefined,
				selected: account.agents,
				onSwitch: (agent, on) =>
					void run(async () =>
						showCapabilities(await switchAccount(connection, account.account, agent, on, version.current)),
					),
			}));
	return (
		<div className="flex min-w-0 flex-col gap-6">
			<div className="flex flex-wrap gap-2">
				<Button variant="ghost" size="sm" onClick={onClose}>
					Connections
				</Button>
			</div>
			<header className="flex flex-col gap-1">
				<h1 className="break-words text-heading font-semibold">{service}</h1>
				{summary.url ? <p className="break-all text-meta text-ink-2">{summary.url}</p> : null}
			</header>
			<ConnectionDetailsView
				view={view}
				service={service}
				about={shipped?.about ?? summary.where}
				mode="details"
				agents={agents}
				agentsFor={agentsFor}
				access={access}
				busy={busy}
				error={error}
				onSetTools={(settings) => {
					const sha = version.current;
					if (sha === undefined) return;
					void run(async () => showCapabilities(await setConnectionTools(connection, settings, sha)));
				}}
				onChangeAccess={(account) => {
					// a key has no sign-in page to come back from: the setup takes a new one
					if (summary.auth === "key") setSetup(true);
					else setChanging(account);
				}}
				onSignOut={setLeaving}
			/>
			{changing !== undefined ? (
				<ConnectFlow connection={connection} account={changing} onClose={() => setChanging(undefined)} />
			) : null}
			{leaving !== undefined ? (
				<Confirm
					open
					onOpenChange={(open) => {
						if (!open) setLeaving(undefined);
					}}
					title={`Sign out of ${service} as ${leaving.label}?`}
					body={
						leaving.agents.length === 0
							? "Its sign-in is forgotten. You can sign in again any time."
							: `${leaving.agents.join(", ")} will lose it. What they were allowed to do as ${leaving.label} is taken back.`
					}
					action="Sign out"
					keep="Stay signed in"
					onConfirm={() =>
						void run(async () => {
							const account = leaving.account;
							setLeaving(undefined);
							showCapabilities(await signOutAccount(connection, account));
						})
					}
				/>
			) : null}
		</div>
	);
}
