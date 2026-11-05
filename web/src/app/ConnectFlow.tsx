/**
 * The connect card on the daemon's data: whichever place shows it (an agent's chat, its Access tab, Settings, the
 * Connections page), the card says what the daemon says of the connection. Connect adds a connection banda ships if
 * it is not there yet, then starts the sign-in for the agent; the card shows the code (or the service's page) until the
 * daemon sees the grant, then whom it signed in as. For an agent with no account of it while some exist, the card is one
 * tap: "Let Mara use GitHub as @bandarra?".
 */
import { useState } from "react";
import { ConnectCard } from "../chat/Connect.tsx";
import { actOnCapability, signIn, switchAccount } from "../lib/api.ts";
import { connectState, freshAccounts, type Phase } from "../lib/connect.ts";
import { showCapabilities, useShell } from "../lib/shell.ts";

export { freshAccounts };

/** A connection's service, as its file or banda's shipped one names it; else its name, capitalised. */
export function serviceOf(name: string, capabilities: ReturnType<typeof useShell>["capabilities"]): string {
	const view = capabilities?.connections.find((each) => each.name === name);
	const shipped = capabilities?.shipped?.find((each) => each.name === name);
	return (
		view?.accepted?.connection?.service ??
		shipped?.connection.service ??
		`${name.charAt(0).toUpperCase()}${name.slice(1)}`
	);
}

const wordsOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ConnectFlow({
	connection,
	agent,
	why,
	onDismiss,
}: {
	/** The connection, by its name ("github"). */
	connection: string;
	/** The agent it connects for: the account is switched on for it. None from Settings or the Connections page. */
	agent?: { readonly id: string; readonly name: string } | undefined;
	/** Why, in a line, before anything is connected. */
	why?: string | undefined;
	onDismiss?: (() => void) | undefined;
}) {
	const { capabilities } = useShell();
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [busy, setBusy] = useState(false);
	const view = capabilities?.connections.find((each) => each.name === connection);
	const shipped = capabilities?.shipped?.find((each) => each.name === connection);
	const service = serviceOf(connection, capabilities);
	const reason =
		why ??
		(agent === undefined
			? `Sign in once; then switch it on for the agents that may use it.`
			: `${agent.name} reads with it and asks before anything it writes.`);
	const start = async () => {
		setBusy(true);
		const before = view?.finished?.at;
		try {
			// a connection banda ships, not added yet: added first, as the owner chose it
			if (view === undefined) {
				if (shipped === undefined) throw new Error(`${service} is not one banda can connect yet.`);
				showCapabilities(await actOnCapability({ action: "add", name: connection }));
			}
			const started = await signIn(connection, agent?.id);
			setPhase({ kind: "started", before, ...("url" in started ? { url: started.url } : {}) });
		} catch (error) {
			setPhase({ kind: "failed", why: wordsOf(error) });
		} finally {
			setBusy(false);
		}
	};
	const use = async (login: string) => {
		const account = freshAccounts(view).find((each) => each.label === login);
		if (agent === undefined || account === undefined) return;
		setBusy(true);
		try {
			showCapabilities(await switchAccount(connection, account.account, agent.id, true));
		} catch (error) {
			setPhase({ kind: "failed", why: wordsOf(error) });
		} finally {
			setBusy(false);
		}
	};
	const state = connectState(view, phase, agent?.id, reason);
	return (
		<ConnectCard
			agent={agent?.name}
			connection={service}
			state={state}
			busy={busy}
			onConnect={() => void start()}
			onUse={(login) => void use(login)}
			{...(onDismiss === undefined ? {} : { onDismiss })}
		/>
	);
}
