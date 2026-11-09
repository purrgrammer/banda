/**
 * Connecting on the daemon's data: whichever place starts it (an agent's chat, its Access tab, Settings, the
 * Connections page), the connect dialog says what the daemon says of the connection. Signing in adds a connection banda
 * ships if it is not there yet, then starts the sign-in for the agent; the dialog shows the service's page (and the code
 * to enter on it) until the daemon sees the grant, then closes and says whom it signed in as. For an agent with no
 * account of it while some exist, the dialog is one tap: "Let Mara use GitHub as @bandarra?".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DEFAULT_FACE } from "../../../src/core/choices.ts";
import type { AccountView } from "../../../src/server/api.ts";
import { ConnectCard, ConnectDialog, type ConnectStep } from "../chat/Connect.tsx";
import { actOnCapability, labelAccount, runsOnDevice, signIn, switchAccount } from "../lib/api.ts";
import { connectState, freshAccounts, type Phase, scopeChoicesOf } from "../lib/connect.ts";
import { chatAgents } from "../lib/navigation.ts";
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

type Who = { readonly id: string; readonly name: string };

/** What the daemon knows of a connection, and the words around it, shared by the card and the dialog. */
function useConnection(connection: string, agent: Who | undefined, why: string | undefined) {
	const { capabilities } = useShell();
	const view = capabilities?.connections.find((each) => each.name === connection);
	const shipped = capabilities?.shipped?.find((each) => each.name === connection);
	const service = serviceOf(connection, capabilities);
	const currentScopes = view?.accepted?.connection?.scopes ?? shipped?.connection.scopes ?? [];
	// Google signs in through the computer banda runs on: its redirect is that computer's loopback address.
	const google = currentScopes.some((scope) => scope.startsWith("https://www.googleapis.com/auth/"));
	const reason = [
		why ??
			(agent === undefined
				? "Sign in once; then switch it on for the agents that may use it."
				: `${agent.name} reads with it and asks before anything it writes.`),
		runsOnDevice && google
			? `Sign in${connection === "gmail" ? " and change Gmail access" : ` to ${service}`} on the computer Banda runs on. Connected accounts are available on this device.`
			: undefined,
	]
		.filter(Boolean)
		.join(" ");
	return {
		view,
		shipped,
		service,
		connectionUrl: view?.accepted?.connection?.url ?? shipped?.connection.url,
		currentScopes,
		onComputerOnly: runsOnDevice && google,
		reason,
	};
}

/**
 * The connect dialog, open while it is mounted: the access to grant (for a connection with choices), then the
 * service's page, until the daemon sees the grant; then it closes, saying whom it signed in as unless `quiet` (a card
 * says it instead).
 */
export function ConnectFlow({
	connection,
	agent,
	account: signingAgain,
	why,
	onClose,
	quiet = false,
}: {
	/** The connection, by its name ("github"). */
	connection: string;
	/** The agent it connects for: the account is switched on for it. None from Settings or the Connections page. */
	agent?: Who | undefined;
	/** The account signing in again, to change its access: that one, however many there are. */
	account?: AccountView | undefined;
	/** Why, in a line, before anything is connected. */
	why?: string | undefined;
	onClose: () => void;
	quiet?: boolean | undefined;
}) {
	const shell = useShell();
	const { view, shipped, service, connectionUrl, currentScopes, onComputerOnly, reason } = useConnection(
		connection,
		agent,
		signingAgain === undefined
			? why
			: `Sign in as ${signingAgain.label} on ${serviceOf(connection, shell.capabilities)} to change its access. Signing in as anyone else changes nothing for it.`,
	);
	const offered = scopeChoicesOf(shipped?.access, shipped?.connection.required);
	// the access it asks for starts as what it has now, as far as the definition still offers it
	const startingScopes =
		signingAgain?.scopes === undefined || offered === undefined
			? currentScopes
			: signingAgain.scopes.filter(
					(scope) =>
						(offered.required?.scopes ?? []).includes(scope) ||
						offered.choices.some((choice) => choice.scopes.includes(scope)),
				);
	const choices = offered !== undefined;
	const band = useMemo(
		() => chatAgents(shell.agents, shell.companion ?? { face: DEFAULT_FACE }),
		[shell.agents, shell.companion],
	);
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [busy, setBusy] = useState(false);
	const [used, setUsed] = useState(false);
	const [named, setNamed] = useState(false);
	const [nameProblem, setNameProblem] = useState<string>();
	const [pickedScopes, setPickedScopes] = useState<readonly string[]>(startingScopes);
	const state = connectState(view, phase, agent?.id, reason);
	// a connection with choices starts on them, unless a sign-in is already under way or an account is there to use
	const [choosing, setChoosing] = useState(choices && state.kind === "connect");
	const scopesChanged =
		pickedScopes.length !== startingScopes.length ||
		pickedScopes.some((scope, index) => scope !== startingScopes[index]);
	const finishedNow = phase.kind === "started" && view?.finished !== undefined && view.finished.at !== phase.before;
	const signInWith = async () => {
		// opened in the click, so no pop-up blocker stops it; it goes to the service's page once the daemon names it
		const tab = window.open("about:blank", "_blank");
		if (tab) tab.opener = null;
		setBusy(true);
		setChoosing(false);
		const before = view?.finished?.at;
		try {
			// a connection banda ships is added (switched on in this home) before its sign-in
			if (view?.accepted?.connection === undefined) {
				if (shipped === undefined) throw new Error(`${service} is not one banda can connect yet.`);
				showCapabilities(await actOnCapability({ action: "add", name: connection }));
			}
			const started = await signIn(connection, agent?.id, {
				...(choices ? { scopes: pickedScopes } : {}),
				...(signingAgain === undefined ? {} : { account: signingAgain.account }),
			});
			const page = "url" in started ? started.url : "page" in started ? started.page : undefined;
			if (page === undefined) tab?.close();
			else tab?.location.replace(page);
			setPhase({ kind: "started", before, ...("url" in started ? { url: started.url } : {}) });
		} catch (error) {
			tab?.close();
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
			setUsed(true);
		} catch (error) {
			setPhase({ kind: "failed", why: wordsOf(error) });
		} finally {
			setBusy(false);
		}
	};
	const login = (state.kind === "done" || state.kind === "already") && (finishedNow || used) ? state.login : undefined;
	const account =
		view?.finished === undefined
			? undefined
			: freshAccounts(view).find((each) => each.account === view.finished?.account);
	// a sign-in its server did not name asks what to call it before the dialog moves on, wherever it started
	const signedIn = state.kind === "done" || state.kind === "already" || state.kind === "share";
	const naming = signedIn && finishedNow && !used && !named && account?.numbered === true;
	const finished = useRef(false);
	useEffect(() => {
		if (login === undefined || naming || finished.current) return;
		finished.current = true;
		if (!quiet) toast.success(`${service} connected as ${login}`);
		// signed in for no agent, it stays open on the agents that may use the account
		if (agent !== undefined) onClose();
	}, [agent, login, naming, onClose, quiet, service]);
	const nameAccount = async (name: string) => {
		const wanted = name.trim();
		if (account === undefined || wanted === "" || wanted === account.label) {
			setNamed(true);
			return;
		}
		setBusy(true);
		try {
			showCapabilities(await labelAccount(connection, account.account, wanted));
			setNamed(true);
		} catch (error) {
			setNameProblem(wordsOf(error));
		} finally {
			setBusy(false);
		}
	};
	const toggle = async (id: string, on: boolean) => {
		if (account === undefined) return;
		setBusy(true);
		try {
			showCapabilities(await switchAccount(connection, account.account, id, on, view?.accepted?.sha));
		} catch (error) {
			toast.error(wordsOf(error));
		} finally {
			setBusy(false);
		}
	};
	const step: ConnectStep =
		naming && account !== undefined
			? { kind: "name", login: account.label, why: nameProblem }
			: agent === undefined && login !== undefined && account !== undefined
				? {
						kind: "agents",
						login,
						agents: band.map((each) => ({
							id: each.id,
							name: each.name,
							face: each.face,
							on: account.agents.includes(each.id),
						})),
					}
				: choosing
					? { kind: "permissions" }
					: busy && state.kind !== "known" && state.kind !== "share"
						? { kind: "starting" }
						: // until the daemon finishes this sign-in, what the agent had before is not its outcome
							phase.kind === "started" && !finishedNow && state.kind !== "code" && state.kind !== "failed"
							? { kind: "starting" }
							: state;
	return (
		<ConnectDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			agent={agent?.name}
			connection={service}
			id={connection}
			connectionUrl={connectionUrl}
			step={step}
			busy={busy}
			scopes={pickedScopes}
			choices={offered}
			onScopes={setPickedScopes}
			scopesChanged={scopesChanged}
			scopesReadonly={onComputerOnly}
			account={signingAgain?.label}
			onSignIn={() => void signInWith()}
			{...(choices ? { onPermissions: () => setChoosing(true) } : {})}
			onUse={(login) => void use(login)}
			onAgent={(id, on) => void toggle(id, on)}
			onName={(name) => void nameAccount(name)}
		/>
	);
}

/** Where an agent asks to connect: the card says why and offers Connect, which opens the connect dialog. */
export function ConnectFlowCard({
	connection,
	agent,
	why,
	onDismiss,
}: {
	connection: string;
	agent?: Who | undefined;
	why?: string | undefined;
	onDismiss?: (() => void) | undefined;
}) {
	const { view, service, connectionUrl, reason } = useConnection(connection, agent, why);
	const [open, setOpen] = useState(false);
	const state = connectState(view, { kind: "idle" }, agent?.id, reason);
	return (
		<>
			<ConnectCard
				agent={agent?.name}
				connection={service}
				id={connection}
				connectionUrl={connectionUrl}
				state={state.kind === "done" || state.kind === "already" ? state : { kind: "connect", why: reason }}
				onConnect={() => setOpen(true)}
				{...(onDismiss === undefined ? {} : { onDismiss })}
			/>
			{open ? (
				<ConnectFlow connection={connection} agent={agent} why={why} onClose={() => setOpen(false)} quiet />
			) : null}
		</>
	);
}
