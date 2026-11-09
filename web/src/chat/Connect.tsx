/**
 * Connecting, the one flow for every connection: in the chat where it was needed, in an agent's Access tab, in Settings
 * and on the Connections page. Where an agent asks, a compact card says why and offers Connect; the tile or row of a
 * page offers it as its own button. Either opens the connect dialog, where every step of signing in happens: the
 * access to grant, the service's page (and a code to enter on it), what failed, and an account banda already has.
 * Without an agent (from Settings or the Connections page) it signs an account in for none.
 */
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { AvatarFace } from "../../../src/core/avatar-face.ts";
import { scopeChoicesOf } from "../lib/connect.ts";
import { Tile } from "./Cards.tsx";
import { ConnectionIcon } from "./ConnectionIcon.tsx";
import { Face } from "./Face.tsx";

export type ConnectState =
	| { readonly kind: "connect"; readonly why: string }
	/** Signing in: the code to enter on `url`, or none when the service's own page is open in another tab. */
	| { readonly kind: "code"; readonly code?: string | undefined; readonly url: string }
	| { readonly kind: "done"; readonly login: string }
	/** The sign-in was an account banda knew already. */
	| { readonly kind: "already"; readonly login: string }
	| { readonly kind: "failed"; readonly why: string }
	| { readonly kind: "known"; readonly logins: readonly string[] }
	| { readonly kind: "share"; readonly login: string; readonly why?: string | undefined };

/**
 * A step of the connect dialog: a connection's state, the access chosen before signing in, a sign-in starting, or,
 * once one made for no agent finished, the agents that may use the account.
 */
export type ConnectStep =
	| ConnectState
	| { readonly kind: "permissions" }
	| { readonly kind: "starting" }
	/** Signed in to an account its server did not name: what to call it, `login` unless the owner says otherwise. */
	| { readonly kind: "name"; readonly login: string; readonly why?: string | undefined }
	| {
			readonly kind: "agents";
			readonly login: string;
			readonly agents: readonly {
				readonly id: string;
				readonly name: string;
				readonly face: AvatarFace;
				readonly on: boolean;
			}[];
	  };

/** The card where an agent asks: why, and Connect, until it is connected; then one line. */
export function ConnectCard({
	agent,
	connection,
	id,
	connectionUrl,
	state,
	onConnect,
	onDismiss,
	busy = false,
}: {
	/** The agent it connects for. */
	agent?: string | undefined;
	/** The service, in words ("Google Calendar"). */
	connection: string;
	/** Its name in the daemon ("calendar"), for its mark. */
	id: string;
	connectionUrl?: string | undefined;
	state: Extract<ConnectState, { kind: "connect" | "done" | "already" }>;
	/** Opens the connect dialog. */
	onConnect?: (() => void) | undefined;
	/** Not now: the card steps back. */
	onDismiss?: (() => void) | undefined;
	busy?: boolean | undefined;
}) {
	const connected = state.kind !== "connect";
	return (
		<Tile className={`flex flex-col ${connected ? "gap-0 p-3" : "gap-3 p-4"}`}>
			<span className="flex items-center gap-3">
				<ConnectionMark id={id} url={connectionUrl} />
				<span className="flex min-w-0 flex-col">
					<span className="flex items-center gap-1.5 text-ui font-semibold text-ink">
						{connected ? <CheckIcon className="size-4 text-ink-2" /> : null}
						{title(agent, connection, state)}
					</span>
					{connected ? null : <span className="text-meta text-ink-2">{detail(agent, connection, state)}</span>}
				</span>
			</span>
			{connected ? null : (
				<span className="flex flex-wrap gap-2">
					<Button disabled={busy} onClick={onConnect}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Connect {connection}
					</Button>
					{onDismiss === undefined ? null : (
						<Button variant="ghost" onClick={onDismiss}>
							Not now
						</Button>
					)}
				</span>
			)}
		</Tile>
	);
}

/** Every step of connecting, in one dialog: what the step says and the controls that move it on. */
export function ConnectDialog({
	open,
	onOpenChange,
	agent,
	connection,
	id,
	connectionUrl,
	step,
	busy = false,
	scopes = [],
	onScopes,
	scopesChanged = false,
	scopesReadonly = false,
	onSignIn,
	onPermissions,
	onUse,
	onAgent,
	onName,
	style,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agent?: string | undefined;
	connection: string;
	id: string;
	connectionUrl?: string | undefined;
	step: ConnectStep;
	/** A control is waiting on banda. */
	busy?: boolean | undefined;
	/** The access chosen on the permissions step. */
	scopes?: readonly string[] | undefined;
	onScopes?: ((scopes: readonly string[]) => void) | undefined;
	scopesChanged?: boolean | undefined;
	/** The access can be changed only on the computer banda runs on. */
	scopesReadonly?: boolean | undefined;
	/** Start signing in: Sign in, Save and sign in, Try again, Sign in another. */
	onSignIn?: (() => void) | undefined;
	/** Back to the access to grant; none for a connection without choices. */
	onPermissions?: (() => void) | undefined;
	/** Let the agent use an account already signed in. */
	onUse?: ((login: string) => void) | undefined;
	/** Switch the account just signed in on or off for an agent. */
	onAgent?: ((agent: string, on: boolean) => void) | undefined;
	/** Call the account just signed in this; empty keeps the name it has. */
	onName?: ((name: string) => void) | undefined;
	/** The specimen's frame passes its colour scheme to the dialog, which opens outside the frame. */
	style?: CSSProperties | undefined;
}) {
	const [copied, setCopied] = useState(false);
	const [name, setName] = useState("");
	const close = () => onOpenChange(false);
	const copy = (code: string) => {
		void navigator.clipboard?.writeText(code).then(
			() => setCopied(true),
			() => {},
		);
	};
	const heading =
		step.kind === "permissions"
			? {
					title: `${connection} access`,
					detail: "Choose what Banda can access. You can change this later by signing in again.",
				}
			: step.kind === "starting"
				? { title: `Sign in on ${connection}`, detail: `Waiting for ${connection}…` }
				: step.kind === "name"
					? {
							title: `Name this ${connection} account`,
							detail: `${connection} doesn’t say which account this is. Leave this empty to keep ${step.login}.`,
						}
					: step.kind === "agents"
						? {
								title: `Use ${connection} with`,
								detail: `Signed in as ${step.login}. The agents switched on may read with it; they ask before anything they write.`,
							}
						: { title: title(agent, connection, step), detail: detail(agent, connection, step) };
	// a sign-in again starts where the first did: on the access to grant, when the connection has choices
	const again = onPermissions ?? onSignIn;
	const signInAnother = (
		<Button variant="ghost" disabled={busy} onClick={again}>
			Sign in another
		</Button>
	);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-connect-step={step.kind}
				style={style}
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
			>
				<DialogHeader>
					<span className="flex items-center gap-3 pr-8">
						<ConnectionMark id={id} url={connectionUrl} />
						<DialogTitle className="min-w-0 leading-snug">{heading.title}</DialogTitle>
					</span>
					<DialogDescription className="break-words">{heading.detail}</DialogDescription>
				</DialogHeader>
				{step.kind === "permissions" ? (
					<ConnectionPermissions
						connection={id}
						service={connection}
						scopes={scopes}
						onScopes={onScopes ?? (() => {})}
						busy={busy}
						readonly={scopesReadonly}
					/>
				) : step.kind === "starting" ? (
					<span className="flex items-center gap-1.5 text-meta text-ink-2">
						<Spinner className="size-3.5" />
						Starting…
					</span>
				) : step.kind === "name" ? (
					<form
						id="connect-account-name"
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							onName?.(name);
						}}
					>
						<Input
							aria-label="Name this account"
							value={name}
							placeholder={step.login}
							maxLength={60}
							disabled={busy}
							onChange={(event) => setName(event.target.value)}
						/>
						{step.why === undefined ? null : (
							<p role="alert" className="break-words text-meta text-destructive">
								{step.why}
							</p>
						)}
					</form>
				) : step.kind === "agents" ? (
					<span className="flex flex-col">
						{step.agents.map((each) => (
							// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
							<label
								key={each.id}
								className="flex min-h-11 items-center gap-3 border-t border-line-soft pr-2 text-ui text-ink first:border-t-0"
							>
								<Face face={each.face} name={each.name} size="message" />
								<span className="min-w-0 flex-1 truncate">{each.name}</span>
								<Switch
									checked={each.on}
									disabled={busy}
									onCheckedChange={(on: boolean) => onAgent?.(each.id, on)}
									aria-label={`${each.name} may use ${connection} as ${step.login}`}
								/>
							</label>
						))}
					</span>
				) : step.kind === "code" ? (
					<>
						{step.code === undefined ? null : (
							<span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-field bg-paper-2 px-4 py-3">
								<span className="font-code text-heading font-semibold tracking-[0.12em] whitespace-nowrap text-ink">
									{step.code}
								</span>
								<Button variant="ghost" size="sm" onClick={() => copy(step.code as string)}>
									{copied ? <CheckIcon /> : <CopyIcon />}
									{copied ? "Copied" : "Copy code"}
								</Button>
							</span>
						)}
						<span className="flex flex-wrap items-center gap-3">
							<Button asChild>
								<a href={step.url} target="_blank" rel="noreferrer noopener">
									Open {connection}
									<ExternalLinkIcon />
								</a>
							</Button>
							<span className="flex items-center gap-1.5 text-meta text-ink-2">
								<Spinner className="size-3.5" />
								Waiting for {connection}…
							</span>
						</span>
					</>
				) : null}
				<DialogFooter>
					{step.kind === "permissions" ? (
						<>
							<Button variant="ghost" disabled={busy} onClick={close}>
								Cancel
							</Button>
							<Button disabled={busy || scopesReadonly} onClick={onSignIn}>
								{busy ? <Spinner className="size-3.5" /> : null}
								{scopesChanged ? "Save and sign in" : "Sign in"}
							</Button>
						</>
					) : step.kind === "connect" ? (
						<>
							<Button variant="ghost" disabled={busy} onClick={close}>
								Cancel
							</Button>
							<Button disabled={busy} onClick={onSignIn}>
								{busy ? <Spinner className="size-3.5" /> : null}
								Sign in
							</Button>
						</>
					) : step.kind === "starting" || step.kind === "code" ? (
						<>
							{onPermissions === undefined ? null : (
								<Button variant="ghost" disabled={busy} onClick={onPermissions}>
									Change permissions
								</Button>
							)}
							<Button variant="outline" onClick={close}>
								Close
							</Button>
						</>
					) : step.kind === "name" ? (
						<Button type="submit" form="connect-account-name" disabled={busy}>
							{busy ? <Spinner className="size-3.5" /> : null}
							Continue
						</Button>
					) : step.kind === "agents" ? (
						<Button onClick={close}>Done</Button>
					) : step.kind === "failed" ? (
						<>
							<Button variant="ghost" onClick={close}>
								Not now
							</Button>
							<Button disabled={busy} onClick={again}>
								Try again
							</Button>
						</>
					) : step.kind === "known" ? (
						<>
							{signInAnother}
							{step.logins.map((login) => (
								<Button key={login} variant="outline" disabled={busy} onClick={() => onUse?.(login)}>
									Use {login}
								</Button>
							))}
						</>
					) : step.kind === "share" ? (
						<>
							<Button variant="ghost" onClick={close}>
								Don't
							</Button>
							{signInAnother}
							<Button disabled={busy} onClick={() => onUse?.(step.login)}>
								Allow
							</Button>
						</>
					) : (
						<>
							{signInAnother}
							<Button onClick={close}>Done</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ConnectionMark({ id, url }: { id: string; url?: string | undefined }) {
	return (
		<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
			<ConnectionIcon connection={id} url={url} className="size-5" />
		</span>
	);
}

/** OAuth permissions chosen before sign-in, on the connect dialog's first step. */
export function ConnectionPermissions({
	connection,
	service,
	scopes,
	onScopes,
	busy = false,
	readonly = false,
}: {
	/** Its name in the daemon ("gmail"). */
	connection: string;
	/** The service, in words ("Gmail"). */
	service: string;
	scopes: readonly string[];
	onScopes: (scopes: readonly string[]) => void;
	busy?: boolean;
	readonly?: boolean;
}) {
	const { required, choices, note } = scopeChoicesOf(connection) ?? { choices: [], note: "" };
	return (
		<fieldset className="flex flex-col gap-3 text-meta" disabled={busy || readonly}>
			{required === undefined ? null : (
				<label className="flex items-start gap-2 text-ink-2">
					<input type="checkbox" checked={scopes.includes(required.scope)} disabled readOnly className="mt-0.5" />
					<span>
						{required.label} <span className="text-ink-3">· required</span>
					</span>
				</label>
			)}
			{choices.map(({ scope, label }) => (
				<label key={scope} className="flex items-start gap-2 text-ink-2">
					<input
						type="checkbox"
						checked={scopes.includes(scope)}
						onChange={(event) =>
							onScopes(event.target.checked ? [...scopes, scope] : scopes.filter((current) => current !== scope))
						}
						className="mt-0.5"
					/>
					<span>{label}</span>
				</label>
			))}
			<p className="text-ink-3">
				{readonly
					? `Change access and sign in again on the computer Banda runs on. Connected ${service} accounts are available on this device.`
					: note}
			</p>
		</fieldset>
	);
}

function title(agent: string | undefined, connection: string, state: ConnectState): string {
	switch (state.kind) {
		case "connect":
			return `Connect ${connection}`;
		case "code":
			return state.code === undefined ? `Sign in on ${connection}` : `Enter this code on ${connection}`;
		case "done":
			return `${connection} connected`;
		case "already":
			return `${connection} connected`;
		case "failed":
			return `${connection} isn't connected`;
		case "known":
			return `${connection} is already signed in`;
		case "share":
			return `Let ${agent ?? "this agent"} use ${connection} as ${state.login}?`;
	}
}

function detail(agent: string | undefined, connection: string, state: ConnectState): string {
	const who = agent ?? "An agent";
	switch (state.kind) {
		case "connect":
			return state.why;
		case "code":
			return state.code === undefined
				? `Finish signing in on ${connection}'s page; this closes once you have.`
				: `${connection} asks for it after you sign in. It works once, for 15 minutes.`;
		case "done":
		case "already":
			return `${who} reads with it and asks before anything it writes.`;
		case "failed":
			return state.why;
		case "known":
			return `Pick the account ${agent ?? "the agent"} should use.`;
		case "share":
			return state.why ?? `${who} reads with it and asks before anything it writes.`;
	}
}
