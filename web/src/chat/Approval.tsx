/**
 * The approval card: the daemon's, plain, identical whoever the agent is. What will happen, on its object; the text
 * the owner may edit; one primary button that is the effect's own verb, a quiet Don't, and at most one scope. And the
 * change card: an agent's change to itself, shown in full.
 */
import { CheckIcon, ChevronRightIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { Tile } from "./Cards.tsx";

export type ApprovalState =
	| { readonly kind: "open"; readonly editing?: boolean }
	| { readonly kind: "done"; readonly words: string }
	| { readonly kind: "declined" };

export function ApprovalCard({
	agent,
	what,
	verb,
	declineLabel,
	as,
	object,
	text,
	scope,
	state = { kind: "open" },
	disabled = false,
	onApprove,
	onDecline,
}: {
	agent: string;
	/** What will happen, in words: "Comment on purrgrammer/banda #34". */
	what: string;
	/** The primary button: the effect's own verb. */
	verb: string;
	/** A recovery ask skips another attempt rather than declining a new action. */
	declineLabel?: string | undefined;
	/** The account it acts as, where it has one: "@bandarra on GitHub". */
	as?: string | undefined;
	/** The object it acts on, drawn as its card. */
	object?: ReactNode;
	/** The text the owner may edit before it goes. */
	text?: string | undefined;
	/** The one scope offered: "Don't ask again for this task". */
	scope?: string | undefined;
	state?: ApprovalState;
	/** The buttons stand but take nothing yet: a card that just appeared or moved must hold still before a click lands. */
	disabled?: boolean | undefined;
	/** Run it as stored (or with the owner's edit); `scoped`: the one scope offered was ticked. */
	onApprove?: (scoped: boolean, text?: string) => unknown | Promise<unknown>;
	onDecline?: () => unknown | Promise<unknown>;
}) {
	const [scoped, setScoped] = useState(false);
	const [editing, setEditing] = useState(state.kind === "open" && state.editing === true);
	const [draft, setDraft] = useState(text ?? "");
	const [busy, setBusy] = useState(false);
	const scopeId = useId();
	const act = async (action: () => unknown | Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">{agent} asks to</span>
				<span className="text-body font-semibold text-ink">{what}</span>
				{as === undefined ? null : <span className="text-meta text-ink-2">as {as}</span>}
			</span>
			{object}
			{text === undefined ? null : state.kind === "open" && editing ? (
				<Textarea
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					disabled={busy}
					aria-label="What will be sent"
					className="min-h-24 text-body"
				/>
			) : (
				<blockquote className="rounded-field bg-paper-2 px-3.5 py-2.5 text-body whitespace-pre-line text-ink">
					{text}
				</blockquote>
			)}
			{state.kind === "open" ? (
				<>
					{scope === undefined ? null : (
						<span className="flex items-center gap-2.5 text-ui text-ink">
							<Checkbox
								id={scopeId}
								checked={scoped}
								disabled={busy}
								onCheckedChange={(on) => setScoped(on === true)}
							/>
							<label htmlFor={scopeId}>{scope}</label>
						</span>
					)}
					<span className="flex flex-wrap items-center gap-2">
						<Button
							disabled={busy || disabled}
							onClick={() => void act(() => onApprove?.(scoped, editing ? draft : text))}
						>
							{verb}
						</Button>
						{text === undefined || editing ? null : (
							<Button variant="outline" onClick={() => setEditing(true)}>
								Edit
							</Button>
						)}
						<Button variant="ghost" disabled={busy || disabled} onClick={() => void act(() => onDecline?.())}>
							{declineLabel ?? `Don't ${verb.toLowerCase()}`}
						</Button>
					</span>
				</>
			) : state.kind === "done" ? (
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<CheckIcon className="size-4 text-ink" />
					{state.words}
				</span>
			) : (
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<XIcon className="size-4" />
					You said no: didn't {verb.toLowerCase()}
				</span>
			)}
		</Tile>
	);
}

/** An agent's change to its own file: the new text in full, the old one behind a disclosure. */
export function ChangeCard({
	agent,
	what,
	after,
	before,
	allowDisabled = false,
	onAllow,
	onKeep,
}: {
	agent: string;
	what: string;
	after: ReactNode;
	before: ReactNode;
	allowDisabled?: boolean;
	onAllow?: () => void;
	onKeep?: () => void;
}) {
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">{agent} asks to change</span>
				<span className="text-body font-semibold text-ink">{what}</span>
			</span>
			<div className="rounded-field bg-paper-2 px-3.5 py-2.5 text-body whitespace-pre-line text-ink">{after}</div>
			<details className="group text-ui text-ink-2">
				<summary className="flex cursor-pointer list-none items-center gap-1 hover:text-ink">
					<ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
					What it was
				</summary>
				<div className="mt-2 px-3.5 text-body whitespace-pre-line text-ink-2">{before}</div>
			</details>
			<span className="flex items-center gap-2">
				<Button onClick={onAllow} disabled={allowDisabled}>
					Allow
				</Button>
				<Button variant="ghost" onClick={onKeep}>
					Keep as is
				</Button>
			</span>
		</Tile>
	);
}

/**
 * The effect in full, behind a disclosure under what the card leads with: a request's page, method, address, headers
 * and raw body, each stacked so a long header wraps on a phone. Credentials in it come masked from the daemon.
 */
export function Details({ rows }: { rows: readonly (readonly [string, string])[] }) {
	return (
		<Collapsible>
			<CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-ui text-ink-2 hover:text-ink">
				<ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
				Details
			</CollapsibleTrigger>
			<CollapsibleContent>
				<dl className="mt-2 flex flex-col gap-2.5 rounded-field bg-paper-2 px-3.5 py-3 text-ui">
					{rows.map(([term, value]) => (
						<div key={term} className="flex min-w-0 flex-col gap-0.5">
							<dt className="text-ink-2">{term}</dt>
							<dd className="min-w-0 font-code text-meta whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
								{value}
							</dd>
						</div>
					))}
				</dl>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** The red mark on a draft that opens every destination (`*` on an ask_hosts): said plainly before the owner approves. */
export function HostsWarning({ warning }: { warning: string }) {
	return (
		<p role="alert" className="flex items-center gap-1.5 text-ui font-medium text-danger">
			<TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
			{warning}
		</p>
	);
}

/** Above the composer when an open ask is out of view: one tap scrolls to it. */
export function WaitingPill({ ask, onClick }: { ask: string; onClick?: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex h-8 max-w-full items-center gap-2 rounded-full bg-ink px-3.5 text-meta font-medium text-paper shadow-composer"
		>
			<span className="size-1.5 shrink-0 rounded-full bg-paper" />
			<span className="truncate">Waiting on you: {ask}</span>
		</button>
	);
}

/** What an action without an object commits to, as plain facts: what, when, how much, paid how, and the way back. */
export function Facts({ rows }: { rows: readonly (readonly [string, string])[] }) {
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-field bg-paper-2 px-3.5 py-3 text-ui">
			{rows.map(([term, value]) => (
				<div key={term} className="contents">
					<dt className="text-ink-2">{term}</dt>
					<dd className="min-w-0 text-ink tabular-nums [overflow-wrap:anywhere]">{value}</dd>
				</div>
			))}
		</dl>
	);
}
