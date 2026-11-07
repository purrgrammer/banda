/**
 * The connect card: the one flow for every connection, in the chat where it was needed, in an agent's Access tab, in
 * Settings and on the Connections page. Connect, sign in at the service (a code to enter on its page, or its own page
 * in another tab), done once banda sees the grant. Asked once more only when an account already signed in is to be
 * shared with another agent. Without an agent (from Settings or the Connections page) it signs an account in for none.
 */
import { CheckIcon, ChevronDownIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { ConnectionToolView } from "../../../src/server/api.ts";
import { Tile } from "./Cards.tsx";
import { ConnectionIcon } from "./ConnectionIcon.tsx";

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

export type ConnectActions = {
	/** Start signing in: Connect, Try again, Sign in another. */
	readonly onConnect?: (() => void) | undefined;
	/** Let the agent use an account already signed in. */
	readonly onUse?: ((login: string) => void) | undefined;
	/** Not now, Don't: the card steps back. */
	readonly onDismiss?: (() => void) | undefined;
	/** A control is waiting on banda. */
	readonly busy?: boolean | undefined;
	/** Opens the provider permission picker without changing the card's size. */
	readonly onPermissions?: (() => void) | undefined;
};

export function ConnectCard({
	agent,
	connection,
	connectionUrl,
	state,
	onConnect,
	onUse,
	onDismiss,
	onPermissions,
	busy = false,
}: {
	/** The agent it connects for; none from Settings or the Connections page. */
	agent?: string | undefined;
	connection: string;
	connectionUrl?: string | undefined;
	state: ConnectState;
} & ConnectActions) {
	const [copied, setCopied] = useState(false);
	const copy = (code: string) => {
		void navigator.clipboard?.writeText(code).then(
			() => setCopied(true),
			() => {},
		);
	};
	return (
		<Tile className={`flex flex-col ${state.kind === "done" || state.kind === "already" ? "gap-0 p-3" : "gap-3 p-4"}`}>
			<span className="flex items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
					<ConnectionIcon connection={connection} url={connectionUrl} className="size-5" />
				</span>
				<span className="flex min-w-0 flex-col">
					<span className="flex items-center gap-1.5 text-ui font-semibold text-ink">
						{state.kind === "done" || state.kind === "already" ? <CheckIcon className="size-4 text-ink-2" /> : null}
						{title(agent, connection, state)}
					</span>
					{state.kind === "done" || state.kind === "already" ? null : (
						<span className="text-meta text-ink-2">{detail(agent, connection, state)}</span>
					)}
				</span>
			</span>
			{state.kind === "connect" ? (
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
			) : state.kind === "code" ? (
				<>
					{state.code === undefined ? null : (
						<span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-field bg-paper-2 px-4 py-3">
							<span className="font-code text-heading font-semibold tracking-[0.12em] whitespace-nowrap text-ink">
								{state.code}
							</span>
							<Button variant="ghost" size="sm" onClick={() => copy(state.code as string)}>
								{copied ? <CheckIcon /> : <CopyIcon />}
								{copied ? "Copied" : "Copy code"}
							</Button>
						</span>
					)}
					<span className="flex flex-wrap items-center gap-3">
						<Button asChild>
							<a href={state.url} target="_blank" rel="noreferrer noopener">
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
			) : state.kind === "done" || state.kind === "already" ? null : state.kind === "failed" ? (
				<span className="flex flex-wrap gap-2">
					<Button disabled={busy} onClick={onConnect}>
						Try again
					</Button>
					{onDismiss === undefined ? null : (
						<Button variant="ghost" onClick={onDismiss}>
							Not now
						</Button>
					)}
				</span>
			) : state.kind === "known" ? (
				<span className="flex flex-wrap gap-2">
					{state.logins.map((login) => (
						<Button key={login} variant="outline" disabled={busy} onClick={() => onUse?.(login)}>
							Use {login}
						</Button>
					))}
					<Button variant="ghost" disabled={busy} onClick={onConnect}>
						Sign in another
					</Button>
				</span>
			) : (
				<span className="flex flex-wrap gap-2">
					<Button disabled={busy} onClick={() => onUse?.(state.login)}>
						Allow
					</Button>
					<Button variant="ghost" disabled={busy} onClick={onConnect}>
						Sign in another
					</Button>
					{onDismiss === undefined ? null : (
						<Button variant="ghost" onClick={onDismiss}>
							Don't
						</Button>
					)}
				</span>
			)}
			{onPermissions === undefined ? null : (
				<Button variant="outline" size="sm" disabled={busy} onClick={onPermissions}>
					Change permissions
				</Button>
			)}
		</Tile>
	);
}

/** OAuth permissions chosen before sign-in; the dialog keeps provider details off the connection card. */
export function ConnectionPermissions({
	connection,
	scopes,
	onScopes,
	busy = false,
	readonly = false,
}: {
	connection: string;
	scopes: readonly string[];
	onScopes: (scopes: readonly string[]) => void;
	busy?: boolean;
	readonly?: boolean;
}) {
	const google = connection.toLowerCase() === "gmail";
	const required = google ? "https://www.googleapis.com/auth/gmail.readonly" : undefined;
	const choices = google
		? ([
				["https://www.googleapis.com/auth/gmail.send", "Send email"],
				["https://www.googleapis.com/auth/gmail.modify", "Archive, trash, mark read and manage labels"],
			] as const)
		: ([
				["repo", "Repositories, including private repositories"],
				["read:org", "Organization and team information"],
				["notifications", "Read and manage notifications"],
				["gist", "Read and manage gists"],
				["security_events", "Repository security alerts"],
				["project", "Read and manage projects"],
				["read:project", "Read projects"],
				["admin:org", "Administer organizations"],
				["write:org", "Manage organization membership and teams"],
				["delete_repo", "Delete repositories"],
			] as const);
	return (
		<fieldset className="flex flex-col gap-3 text-meta" disabled={busy || readonly}>
			{required === undefined ? null : (
				<label className="flex items-start gap-2 text-ink-2">
					<input type="checkbox" checked={scopes.includes(required)} disabled readOnly className="mt-0.5" />
					<span>
						Read email <span className="text-ink-3">· required</span>
					</span>
				</label>
			)}
			{choices.map(([scope, label]) => (
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
					? `Change access and sign in again on the computer Banda runs on. Connected ${connection} accounts are available on this device.`
					: google
						? "Changing access signs in again. Sending and mailbox changes still ask you to approve each action."
						: "Changing access signs in again. Actions that change GitHub still ask you to approve them."}
			</p>
		</fieldset>
	);
}

/** Connection tools, available behind details in Settings. */
export function ConnectionTools({
	connection,
	tools,
	defaultOpen = false,
}: {
	connection: string;
	tools: readonly ConnectionToolView[];
	defaultOpen?: boolean | undefined;
}) {
	const [open, setOpen] = useState(defaultOpen);
	if (tools.length === 0) return null;
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="rounded-field border border-line-soft">
			<CollapsibleTrigger asChild>
				<Button variant="ghost" size="sm" className="w-full justify-between px-3.5">
					<span>
						{connection} tools · {tools.length}
					</span>
					<ChevronDownIcon className={open ? "rotate-180" : ""} data-icon="inline-end" />
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="border-t border-line-soft px-3.5 py-3">
				<div className="flex flex-col gap-3">
					{tools.map((tool) => (
						<div key={tool.name} className="flex min-w-0 flex-col gap-1">
							<p className="break-words font-medium text-ui text-ink">{tool.words}</p>
							<p className="text-meta text-ink-2">
								{!tool.on
									? "Switched off"
									: tool.kind === "read"
										? "Reads without asking"
										: tool.floor || tool.alwaysAsk
											? "Asks every time"
											: "Asks first"}
							</p>
							{tool.needs?.length ? (
								<p className="text-meta text-ink-2">Needs Google access: {tool.needs.join(", ")}</p>
							) : null}
							<details>
								<summary className="cursor-pointer text-meta text-ink-2">Tool details</summary>
								<p className="mt-2 break-all font-mono text-meta">{tool.title}</p>
								<p className="mt-2 whitespace-pre-wrap break-words text-meta text-ink-2">{tool.description}</p>
								{tool.parameters ? (
									<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-meta">
										{JSON.stringify(tool.parameters, null, 2)}
									</pre>
								) : null}
							</details>
						</div>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
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
				? `Finish signing in on ${connection}'s page; this card follows it.`
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
