/**
 * A connection's details: its tools in their groups, each saying what it does, who said so and what it is set to; each
 * account with the access it was given; the agents that use it; and the kinds it draws with what following each does. The
 * same component is the review when a connection is added, where nothing changes until Save, and the place to check and
 * change it afterwards, where each change is at once.
 */
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { FLOOR_WORDS } from "../../../src/core/floor.ts";
import {
	type Classed,
	type From,
	groupValue,
	type Kind,
	SETTING_WORDS,
	SETTINGS,
	type Setting,
	tally,
	tallyWords,
} from "../../../src/core/tool-kinds.ts";
import type { AccountView, ConnectionToolView, ConnectionView, KindView } from "../../../src/server/api.ts";
import type { ScopeChoices } from "../lib/connect.ts";
import { Confirm } from "./Confirm.tsx";
import { McpAgents } from "./McpConnection.tsx";
import type { Who } from "./Row.tsx";

/** A tool the list can set. */
type Settable = ConnectionToolView & {
	readonly classed: Classed;
	readonly options: readonly Setting[];
	readonly setting: Setting;
};

const settable = (tools: readonly ConnectionToolView[]): Settable[] =>
	tools.filter(
		(tool): tool is Settable => tool.classed !== undefined && tool.options !== undefined && tool.setting !== undefined,
	);

/** What a tool does, in words: "reads", "changes something", why it asks every time, or that nobody said. */
export function kindWords(kind: Kind, floor: Classed["floor"]): string {
	if (kind === "read") return "reads";
	if (kind === "unknown") return "asks until you say";
	if (kind === "write" || floor === undefined) return "changes something";
	return FLOOR_WORDS[floor].replace(/^it /, "");
}

/** Who said what a tool does, in words. */
export function fromWords(from: From): string {
	if (from === "definition") return "banda says";
	if (from === "you") return "You said";
	if (from === "server") return "The server says";
	return "Not known";
}

/** One control: a segmented choice of the settings given. */
function Choice({
	label,
	options,
	value,
	onChange,
	disabled,
}: {
	label: string;
	options: readonly Setting[];
	value: Setting | undefined;
	onChange: (setting: Setting) => void;
	disabled?: boolean | undefined;
}) {
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			size="sm"
			spacing={0}
			aria-label={label}
			value={value ?? ""}
			disabled={disabled}
			onValueChange={(next) => {
				// a segment clicked again deselects: the choice stands, so Off on a waiting tool can settle it as the owner's
				if (next === "" && value !== undefined) onChange(value);
				else if ((SETTINGS as readonly string[]).includes(next)) onChange(next as Setting);
			}}
			className="max-w-full shrink-0"
		>
			{options.map((setting) => (
				<ToggleGroupItem key={setting} value={setting} className="px-2 max-sm:min-h-10">
					{SETTING_WORDS[setting]}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

/**
 * Each of `tools` set to `setting` as a group sets it: the setting, or the nearest it has; the rest as they were. A group
 * never says a tool reads when nobody has: Allow leaves such a tool alone.
 */
const groupSet = (tools: readonly Settable[], setting: Setting): { [tool: string]: Setting } =>
	Object.fromEntries(
		tools.flatMap((tool) => {
			const near = groupValue(setting, tool.classed, tool.options);
			return near === undefined ? [] : [[tool.title, near]];
		}),
	);

/** The settings a group's control offers: each one some tool in it takes. */
const groupOptions = (tools: readonly Settable[]) =>
	SETTINGS.filter((setting) => tools.some((tool) => groupValue(setting, tool.classed, tool.options) !== undefined));

/**
 * The setting the group's control is at: one whose effect every tool already shows (a tool it cannot set counts as
 * unmoved), so Allow on a mix of reads and writes reads as Allow, not Mixed. Undefined when the tools differ.
 */
const groupCommon = (tools: readonly Settable[], settingOf: (tool: Settable) => Setting) =>
	SETTINGS.find((setting) => {
		const applied = tools.map((tool) => ({
			near: groupValue(setting, tool.classed, tool.options),
			now: settingOf(tool),
		}));
		return (
			applied.some(({ near }) => near !== undefined) &&
			applied.every(({ near, now }) => near === undefined || near === now)
		);
	});

/** The line that says how a connection's tools are set: "34 run freely · 20 ask first". */
export function toolTally(tools: readonly ConnectionToolView[], settingOf: (tool: Settable) => Setting) {
	return tallyWords(tally(settable(tools).map((tool) => ({ setting: settingOf(tool) }))));
}

/** A connection's tools in their groups, each set as `settingOf` says; a tool with no settings is shown as it is. */
export function ToolList({
	tools,
	groups,
	settingOf,
	onTools,
	disabled,
	expanded = false,
}: {
	tools: readonly ConnectionToolView[];
	groups: readonly string[];
	settingOf: (tool: Settable) => Setting;
	onTools: (settings: { readonly [tool: string]: Setting }, group?: boolean) => void;
	disabled?: boolean | undefined;
	expanded?: boolean | undefined;
}) {
	const all = settable(tools);
	const without = tools.filter((tool) => !all.includes(tool as Settable));
	if (tools.length === 0) return <p className="text-ui text-ink-2">Its tools aren't listed yet.</p>;
	return (
		<div className="flex flex-col divide-y divide-line-soft rounded-field border border-line-soft" data-tool-list="">
			{groups.map((group) => {
				const inside = all.filter((tool) => tool.group === group);
				return inside.length === 0 ? null : (
					<ToolGroup
						key={group}
						group={group}
						tools={inside}
						settingOf={settingOf}
						onTools={onTools}
						disabled={disabled}
						expanded={expanded}
					/>
				);
			})}
			{without.length === 0 ? null : (
				<div className="flex flex-col divide-y divide-line-soft">
					{without.map((tool) => (
						<ToolRow key={tool.name} tool={tool} />
					))}
				</div>
			)}
		</div>
	);
}

/** A tool's own line: what it does, in words, and who said so; its setting beside it when it has one. */
function ToolRow({ tool, children }: { tool: ConnectionToolView; children?: ReactNode }) {
	const classed = tool.classed;
	return (
		<div
			data-tool={tool.title}
			className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2.5 pr-3.5 pl-9"
		>
			<div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
				<p className="flex flex-wrap items-center gap-1.5 break-words text-ui text-ink">
					{tool.words}
					{tool.waiting ? <Badge variant="secondary">Off until you choose</Badge> : null}
				</p>
				<p className="text-meta text-ink-2">
					{classed === undefined
						? tool.on
							? "On"
							: "Off"
						: `${fromWords(classed.from)} · ${kindWords(classed.kind, classed.floor)}`}
					{tool.needs ? " · needs more access" : ""}
				</p>
				<details className="text-meta text-ink-2">
					<summary className="cursor-pointer max-sm:flex max-sm:min-h-10 max-sm:items-center">Tool details</summary>
					<p className="mt-1 break-all font-mono">{tool.title}</p>
					<p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{tool.description}</p>
					{tool.readsWhen ? <p className="mt-1">Reads when {tool.readsWhen.join(" or ")}</p> : null}
				</details>
			</div>
			{children}
		</div>
	);
}

function ToolGroup({
	group,
	tools,
	settingOf,
	onTools,
	disabled,
	expanded,
}: {
	group: string;
	tools: readonly Settable[];
	settingOf: (tool: Settable) => Setting;
	onTools: (settings: { readonly [tool: string]: Setting }, group?: boolean) => void;
	disabled?: boolean | undefined;
	expanded: boolean;
}) {
	const waiting = tools.filter((tool) => tool.waiting === true).length;
	const [open, setOpen] = useState(expanded || waiting > 0);
	const id = useId();
	const common = groupCommon(tools, settingOf);
	return (
		<Collapsible open={open} onOpenChange={setOpen} data-group={group}>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-2.5">
				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="sm" className="-ml-2 min-w-0 gap-1.5 px-2" aria-controls={id}>
						<ChevronDownIcon
							className={cn("transition-transform", open ? "rotate-180" : "")}
							data-icon="inline-start"
						/>
						<span className="truncate font-medium text-ink">{group}</span>
						<span className="text-ink-2">{tools.length}</span>
						{waiting > 0 ? (
							<Badge variant="secondary">{waiting === 1 ? "1 waiting" : `${waiting} waiting`}</Badge>
						) : null}
					</Button>
				</CollapsibleTrigger>
				<div className="flex items-center gap-2">
					{common === undefined ? <span className="text-meta text-ink-2">Mixed</span> : null}
					<Choice
						label={`Every tool in ${group}`}
						options={groupOptions(tools)}
						value={common}
						disabled={disabled}
						onChange={(setting) => onTools(groupSet(tools, setting), true)}
					/>
				</div>
			</div>
			<CollapsibleContent id={id} className="flex flex-col divide-y divide-line-soft border-t border-line-soft">
				{tools.map((tool) => (
					<ToolRow key={tool.name} tool={tool}>
						<Choice
							label={tool.words}
							options={tool.options}
							value={settingOf(tool)}
							disabled={disabled}
							onChange={(setting) => onTools({ [tool.title]: setting })}
						/>
						{tool.cards === true && settingOf(tool) === "off" ? (
							<p className="basis-full text-meta text-ink-2">Off also stops the cards and watches that use it.</p>
						) : null}
					</ToolRow>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** A section of the details: its title, a note, its body. */
function Part({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-2">
			<h2 className="text-ui font-semibold text-ink">{title}</h2>
			{note === undefined ? null : <p className="text-meta text-ink-2">{note}</p>}
			{children}
		</section>
	);
}

/** The access an account was given, in the definition's words where they name it; else the scopes as they are. */
export function accessWords(account: Pick<AccountView, "scopes" | "stale">, access: ScopeChoices | undefined): string {
	if (account.stale === true) return "Its sign-in no longer fits this connection";
	const scopes = account.scopes ?? [];
	const labels =
		access?.choices
			.filter((choice) => choice.scopes.every((scope) => scopes.includes(scope)))
			.map((choice) => choice.label) ?? [];
	return labels.length > 0 ? labels.join(" · ") : "Signed in";
}

/** One kind it draws, and what following one does, in words. */
export function KindLine({ kind }: { kind: KindView }) {
	const follow = kind.follow;
	return (
		<li className="flex flex-col gap-0.5 px-3.5 py-2.5" data-kind={kind.kind}>
			<span className="text-ui text-ink">{kind.label}</span>
			{follow === undefined ? (
				<span className="text-meta text-ink-2">Shown as a card. It cannot be followed.</span>
			) : follow.wakes.length === 0 && follow.tells.length === 0 ? (
				<span className="text-meta text-ink-2">Followed, it wakes for nothing.</span>
			) : (
				<>
					{follow.wakes.length === 0 ? null : (
						<span className="text-meta text-ink-2">Wakes the agent for: {follow.wakes.join("; ")}.</span>
					)}
					{follow.tells.length === 0 ? null : (
						<span className="text-meta text-ink-2">Only tells the chat: {follow.tells.join("; ")}.</span>
					)}
				</>
			)}
		</li>
	);
}

/** The agents of one account (or of an account-less connection), switched there. */
export type AgentsFor = {
	readonly key: string;
	readonly label?: string | undefined;
	readonly selected: readonly string[];
	readonly onSwitch: (agent: string, on: boolean) => void;
};

/**
 * The details as the owner reads them, from its data alone. `mode` is `details` (each change is at once, through
 * `onSetTools`), or `review` (nothing changes until the caller saves `chosen`, as `onChoose` keeps it).
 */
export function ConnectionDetailsView({
	view,
	service,
	about,
	mode,
	chosen = {},
	onChoose,
	onSetTools,
	agents,
	agentsFor,
	access,
	onChangeAccess,
	onSignOut,
	onRemove,
	busy = false,
	error = "",
}: {
	view: ConnectionView;
	service: string;
	about?: string | undefined;
	mode: "details" | "review";
	chosen?: { readonly [tool: string]: Setting } | undefined;
	onChoose?: ((chosen: { readonly [tool: string]: Setting }) => void) | undefined;
	onSetTools?: ((settings: { readonly [tool: string]: Setting }, group?: boolean) => void) | undefined;
	agents: readonly (Who & { id: string })[];
	agentsFor: readonly AgentsFor[];
	access?: ScopeChoices | undefined;
	onChangeAccess?: ((account: AccountView) => void) | undefined;
	onSignOut?: ((account: AccountView) => void) | undefined;
	/** Remove the connection whole; absent in the review on adding, where there is nothing yet to remove. */
	onRemove?: (() => void) | undefined;
	busy?: boolean | undefined;
	error?: string | undefined;
}) {
	const review = mode === "review";
	const settingOf = (tool: Settable): Setting => (review ? (chosen[tool.title] ?? tool.setting) : tool.setting);
	const onTools = (settings: { readonly [tool: string]: Setting }, group?: boolean) =>
		review ? onChoose?.({ ...chosen, ...settings }) : onSetTools?.(settings, group);
	const line = toolTally(view.tools, settingOf);
	const hasTools = view.tools.length > 0;
	return (
		<div className="flex min-w-0 flex-col gap-6" data-connection-details={view.name} data-mode={mode}>
			{about === undefined || about === "" ? null : <p className="text-ui text-ink-2">{about}</p>}
			{/* a change in details is told at the control, or by a toast from the page; the review's Save is beside this */}
			{error && review ? (
				<p role="alert" className="break-words text-ui text-danger">
					{error}
				</p>
			) : null}
			{view.notes === undefined ? null : (
				<details className="rounded-field border border-line-soft p-3 text-ui">
					<summary className="cursor-pointer font-medium">Introduction from the server</summary>
					<p className="mt-3 text-meta text-ink-2">
						Shown to agents that have access. The server's instructions grant no permissions.
					</p>
					<p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{view.notes}</p>
				</details>
			)}
			<Part
				title="Tools"
				note={
					hasTools ? (
						<>
							{line === "" ? null : `${line}. `}
							Allow lets a tool that reads run without asking, for every agent with {service}. Ask shows you each change
							first; Always ask never lets an agent skip that. Nothing here makes a tool that changes something run
							unasked.
							{view.tools.some((tool) => tool.classed?.kind === "unknown")
								? " Allow on a tool marked Not known is you saying it only reads; only that tool's own control can say so."
								: null}
						</>
					) : undefined
				}
			>
				<ToolList
					tools={view.tools}
					groups={view.groups}
					settingOf={settingOf}
					onTools={onTools}
					disabled={busy}
					expanded={review}
				/>
			</Part>
			{view.accounts === undefined || view.accounts.length === 0 || review ? null : (
				<Part title="Accounts" note="Each account you signed in to, with the access it was given.">
					<ul className="flex flex-col divide-y divide-line-soft rounded-field border border-line-soft">
						{view.accounts.map((account) => (
							<li
								key={account.account}
								className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5"
								data-account={account.account}
							>
								<span className="flex min-w-0 flex-col">
									<span className="flex items-center gap-1.5 text-ui text-ink">
										{account.label}
										{account.stale ? <Badge variant="secondary">Sign in again</Badge> : null}
									</span>
									<span className="text-meta text-ink-2">{accessWords(account, access)}</span>
									{account.missing ? (
										<span className="text-meta text-ink-2">Needs more access for some tools</span>
									) : null}
								</span>
								<span className="flex items-center gap-1.5">
									{onChangeAccess === undefined ? null : (
										<Button variant="outline" size="xs" disabled={busy} onClick={() => onChangeAccess(account)}>
											{account.stale ? "Sign in again" : "Change access"}
										</Button>
									)}
									{onSignOut === undefined ? null : (
										<Button variant="ghost" size="xs" disabled={busy} onClick={() => onSignOut(account)}>
											Sign out
										</Button>
									)}
								</span>
							</li>
						))}
					</ul>
				</Part>
			)}
			{agentsFor.length === 0 ? null : (
				<Part title="Who can use it?" note="Only the agents you select get this connection’s introduction and tools.">
					<div className="flex flex-col divide-y divide-line-soft rounded-field border border-line-soft">
						{agentsFor.map((each) => (
							<div key={each.key} className="flex flex-col gap-2 px-3.5 py-3">
								{each.label === undefined ? null : <p className="text-meta font-medium text-ink-2">{each.label}</p>}
								<McpAgents agents={agents} selected={each.selected} onSwitch={each.onSwitch} disabled={busy} plain />
							</div>
						))}
					</div>
				</Part>
			)}
			{view.draws.length === 0 ? null : (
				<Part title="What it draws" note="Cards banda shows for it, and what following one does.">
					<ul className="flex flex-col divide-y divide-line-soft rounded-field border border-line-soft">
						{view.draws.map((kind) => (
							<KindLine key={kind.kind} kind={kind} />
						))}
					</ul>
				</Part>
			)}
			{onRemove === undefined || review ? null : (
				<div className="border-t border-line-soft pt-4">
					<Confirm
						title={`Remove ${service}?`}
						body={removeWords(view.accounts ?? [])}
						action="Remove"
						keep={`Keep ${service}`}
						onConfirm={onRemove}
					>
						<Button variant="destructive" size="sm" disabled={busy}>
							Remove {service}
						</Button>
					</Confirm>
				</div>
			)}
			<p role="status" className="sr-only">
				{busy ? "Saving" : ""}
			</p>
		</div>
	);
}

/** What removing a connection takes with it, in plain words: what `POST …/remove` does. */
function removeWords(accounts: readonly AccountView[]): string {
	const signIns =
		accounts.length === 0
			? ""
			: `${accounts.length === 1 ? "The sign-in" : "The sign-ins"} for ${accounts.map((each) => each.label).join(", ")} ${accounts.length === 1 ? "is" : "are"} forgotten. `;
	return `${signIns}Its tool settings and which agents use it go too, the watches on it end, and drafts waiting on it are dropped. You can add it again.`;
}
