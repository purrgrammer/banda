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
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { FLOOR_WORDS } from "../../../src/core/floor.ts";
import {
	type Classed,
	type From,
	inGroup,
	type Kind,
	SETTING_WORDS,
	SETTINGS,
	type Setting,
	tally,
	tallyWords,
} from "../../../src/core/tool-kinds.ts";
import type { AccountView, ConnectionToolView, ConnectionView, KindView } from "../../../src/server/api.ts";
import type { ScopeChoices } from "../lib/connect.ts";
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
	if (kind === "unknown") return "unknown, so it asks";
	if (kind === "write" || floor === undefined) return "changes something";
	return FLOOR_WORDS[floor].replace(/^it /, "");
}

/** Who said what a tool does, in words. */
export function fromWords(from: From, service: string): string {
	if (from === "definition") return `${service} says`;
	if (from === "you") return "You said";
	if (from === "server") return "The server says";
	return "Nobody said";
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
				<ToggleGroupItem key={setting} value={setting} className="px-2">
					{SETTING_WORDS[setting]}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

/** Each of `tools` set to `setting` as a group sets it: the setting, or the nearest it has; the rest as they were. */
const groupSet = (tools: readonly Settable[], setting: Setting): { [tool: string]: Setting } =>
	Object.fromEntries(
		tools.flatMap((tool) => {
			const near = inGroup(setting, tool.options);
			return near === undefined ? [] : [[tool.title, near]];
		}),
	);

/** The settings a group's control offers: each one some tool in it takes. */
const groupOptions = (tools: readonly Settable[]) =>
	SETTINGS.filter((setting) => tools.some((tool) => inGroup(setting, tool.options) !== undefined));

/** The line that says how a connection's tools are set: "34 run freely · 20 ask first". */
export function toolTally(tools: readonly ConnectionToolView[], settingOf: (tool: Settable) => Setting) {
	return tallyWords(tally(settable(tools).map((tool) => ({ kind: tool.classed.kind, setting: settingOf(tool) }))));
}

/** A connection's tools in their groups, each set as `settingOf` says; a tool with no settings is shown as it is. */
export function ToolList({
	service,
	tools,
	groups,
	settingOf,
	onTools,
	disabled,
	expanded = false,
}: {
	service: string;
	tools: readonly ConnectionToolView[];
	groups: readonly string[];
	settingOf: (tool: Settable) => Setting;
	onTools: (settings: { readonly [tool: string]: Setting }) => void;
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
						service={service}
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
						<ToolRow key={tool.name} tool={tool} service={service} />
					))}
				</div>
			)}
		</div>
	);
}

/** A tool's own line: what it does, in words, and who said so; its setting beside it when it has one. */
function ToolRow({ tool, service, children }: { tool: ConnectionToolView; service: string; children?: ReactNode }) {
	const classed = tool.classed;
	return (
		<div
			data-tool={tool.title}
			className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2.5 pr-3.5 pl-9"
		>
			<div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
				<p className="flex flex-wrap items-center gap-1.5 break-words text-ui text-ink">
					{tool.words}
					{tool.waiting ? <Badge variant="secondary">Waiting for you</Badge> : null}
				</p>
				<p className="text-meta text-ink-2">
					{classed === undefined
						? tool.on
							? "On"
							: "Off"
						: `${fromWords(classed.from, service)} · ${kindWords(classed.kind, classed.floor)}`}
					{tool.needs ? ` · needs ${tool.needs.join(", ")}` : ""}
				</p>
				<details className="text-meta text-ink-2">
					<summary className="cursor-pointer">Tool details</summary>
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
	service,
	group,
	tools,
	settingOf,
	onTools,
	disabled,
	expanded,
}: {
	service: string;
	group: string;
	tools: readonly Settable[];
	settingOf: (tool: Settable) => Setting;
	onTools: (settings: { readonly [tool: string]: Setting }) => void;
	disabled?: boolean | undefined;
	expanded: boolean;
}) {
	const waiting = tools.filter((tool) => tool.waiting === true).length;
	const [open, setOpen] = useState(expanded || waiting > 0);
	const id = useId();
	const settings = new Set(tools.map(settingOf));
	const common = settings.size === 1 ? [...settings][0] : undefined;
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
						onChange={(setting) => onTools(groupSet(tools, setting))}
					/>
				</div>
			</div>
			<CollapsibleContent id={id} className="flex flex-col divide-y divide-line-soft border-t border-line-soft">
				{tools.map((tool) => (
					<ToolRow key={tool.name} tool={tool} service={service}>
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
	if (scopes.length === 0) return "Signed in";
	if (access === undefined) return scopes.join(", ");
	const labels = access.choices
		.filter((choice) => choice.scopes.every((scope) => scopes.includes(scope)))
		.map((choice) => choice.label);
	return labels.length > 0 ? labels.join(" · ") : scopes.join(", ");
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
	busy = false,
	error = "",
}: {
	view: ConnectionView;
	service: string;
	about?: string | undefined;
	mode: "details" | "review";
	chosen?: { readonly [tool: string]: Setting } | undefined;
	onChoose?: ((chosen: { readonly [tool: string]: Setting }) => void) | undefined;
	onSetTools?: ((settings: { readonly [tool: string]: Setting }) => void) | undefined;
	agents: readonly (Who & { id: string })[];
	agentsFor: readonly AgentsFor[];
	access?: ScopeChoices | undefined;
	onChangeAccess?: ((account: AccountView) => void) | undefined;
	onSignOut?: ((account: AccountView) => void) | undefined;
	busy?: boolean | undefined;
	error?: string | undefined;
}) {
	const review = mode === "review";
	const settingOf = (tool: Settable): Setting => (review ? (chosen[tool.title] ?? tool.setting) : tool.setting);
	const onTools = (settings: { readonly [tool: string]: Setting }) =>
		review ? onChoose?.({ ...chosen, ...settings }) : onSetTools?.(settings);
	const line = toolTally(view.tools, settingOf);
	const hasTools = view.tools.length > 0;
	return (
		<div className="flex min-w-0 flex-col gap-6" data-connection-details={view.name} data-mode={mode}>
			{about === undefined || about === "" ? null : <p className="text-ui text-ink-2">{about}</p>}
			{error ? (
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
						</>
					) : undefined
				}
			>
				<ToolList
					service={service}
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
										<span className="text-meta text-ink-2">Needs {account.missing.join(", ")} for some tools</span>
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
				<div className="flex min-w-0 flex-col gap-4">
					{agentsFor.map((each) => (
						<div key={each.key} className="flex flex-col gap-2">
							{each.label === undefined ? null : <p className="text-meta font-medium text-ink-2">{each.label}</p>}
							<McpAgents agents={agents} selected={each.selected} onSwitch={each.onSwitch} disabled={busy} />
						</div>
					))}
				</div>
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
			{busy ? (
				<p role="status" className="flex items-center gap-2 text-meta text-ink-2">
					<Spinner /> Saving…
				</p>
			) : null}
		</div>
	);
}
