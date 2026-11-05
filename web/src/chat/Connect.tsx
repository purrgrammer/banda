/**
 * The connect card: the one flow for every connection, in the chat where it was needed, in an agent's Access tab, in
 * Settings and on the Connections page. Connect, sign in at the service (a code to enter on its page, or its own page
 * in another tab), done once banda sees the grant. Asked once more only when an account already signed in is to be
 * shared with another agent. Without an agent (from Settings or the Connections page) it signs an account in for none.
 */
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tile } from "./Cards.tsx";
import { GitHubMark } from "./Object.tsx";

export type ConnectState =
	| { readonly kind: "connect"; readonly why: string }
	/** Signing in: the code to enter on `url`, or none when the service's own page is open in another tab. */
	| { readonly kind: "code"; readonly code?: string | undefined; readonly url: string }
	| { readonly kind: "done"; readonly login: string }
	/** The sign-in was an account banda knew already. */
	| { readonly kind: "already"; readonly login: string }
	| { readonly kind: "failed"; readonly why: string }
	| { readonly kind: "known"; readonly logins: readonly string[] }
	| { readonly kind: "share"; readonly login: string };

export type ConnectActions = {
	/** Start signing in: Connect, Try again, Sign in another. */
	readonly onConnect?: (() => void) | undefined;
	/** Let the agent use an account already signed in. */
	readonly onUse?: ((login: string) => void) | undefined;
	/** Not now, Don't: the card steps back. */
	readonly onDismiss?: (() => void) | undefined;
	/** A control is waiting on banda. */
	readonly busy?: boolean | undefined;
};

const LOGOS: Record<string, ReactNode> = { GitHub: <GitHubMark className="size-5" /> };

export function ConnectCard({
	agent,
	connection,
	state,
	onConnect,
	onUse,
	onDismiss,
	busy = false,
}: {
	/** The agent it connects for; none from Settings or the Connections page. */
	agent?: string | undefined;
	connection: string;
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
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex items-center gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-field bg-paper-3">
					{LOGOS[connection] ?? <span className="text-ui font-semibold text-ink-2">{connection.slice(0, 1)}</span>}
				</span>
				<span className="flex min-w-0 flex-col">
					<span className="text-ui font-semibold text-ink">{title(agent, connection, state)}</span>
					<span className="text-meta text-ink-2">{detail(agent, connection, state)}</span>
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
			) : state.kind === "done" || state.kind === "already" ? (
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<CheckIcon className="size-4 text-ink" />
					{agent === undefined ? "Any agent can be given it now" : `${agent} can use it now`}
				</span>
			) : state.kind === "failed" ? (
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
		</Tile>
	);
}

function title(agent: string | undefined, connection: string, state: ConnectState): string {
	switch (state.kind) {
		case "connect":
			return `Connect ${connection}`;
		case "code":
			return state.code === undefined ? `Sign in on ${connection}` : `Enter this code on ${connection}`;
		case "done":
			return `Signed in as ${state.login}${agent === undefined ? "" : ` · on for ${agent}`}`;
		case "already":
			return `That's ${state.login}, already connected${agent === undefined ? "" : ` · switched on for ${agent}`}`;
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
			return `${who} reads with it and asks before anything it writes.`;
	}
}
