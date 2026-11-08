/**
 * What a connection's tools may do (DESIGN.md "What each tool does is said once, on adding", "A connection only
 * narrows"): its tools in their groups, each group collapsed to its count and one control, each tool saying what it
 * does and who said so. The same list is the review after sign-in, where nothing changes until Accept, and the
 * connection's place in Settings, where each change is at once and for every agent.
 */
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { FLOOR_WORDS } from "../../../src/core/floor.ts";
import {
	inGroup,
	type Kind,
	SETTING_WORDS,
	SETTINGS,
	type Setting,
	tally,
	tallyWords,
} from "../../../src/core/tool-kinds.ts";
import type { ConnectionToolView, ConnectionView } from "../../../src/server/api.ts";
import { usePhone } from "../lib/phone.ts";

/** A tool the list can set: one of a remote connection's, with what it does said. */
type Settable = ConnectionToolView & Required<Pick<ConnectionToolView, "classed" | "group" | "options">>;

const settable = (tools: readonly ConnectionToolView[]): Settable[] =>
	tools.filter((tool): tool is Settable => tool.classed !== undefined && tool.options !== undefined);

/** What a tool does, in words: "reads", "changes something", or why it asks every time. */
function kindWords(kind: Kind, floor: ConnectionToolView["floor"]): string {
	if (kind === "read") return "reads";
	if (kind === "write" || floor === undefined) return "changes something";
	return FLOOR_WORDS[floor].replace(/^it /, "");
}

/** Who said what a tool does, in words. */
function fromWords(from: NonNullable<ConnectionToolView["classed"]>["from"], service: string): string {
	if (from === "service") return `${service} says`;
	if (from === "you") return "You said";
	if (from === "guess") return "banda's guess";
	return "Nobody said, so it asks";
}

/** The settings a group's control offers: each one some tool in it takes. */
const groupOptions = (tools: readonly Settable[]) =>
	SETTINGS.filter((setting) => tools.some((tool) => inGroup(setting, tool.options) !== undefined));

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
				if ((SETTINGS as readonly string[]).includes(next)) onChange(next as Setting);
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

/**
 * A connection's tools in their groups, each set as `settingOf` says; `onTools` sets some, `onGroup` a whole group.
 * Groups start collapsed (`expanded`: open), except one with a new tool in it.
 */
export function ToolList({
	service,
	tools,
	groups,
	settingOf,
	onTools,
	onGroup,
	disabled,
	expanded = false,
}: {
	service: string;
	tools: readonly ConnectionToolView[];
	groups?: readonly string[] | undefined;
	settingOf: (tool: Settable) => Setting;
	onTools: (settings: { readonly [tool: string]: Setting }) => void;
	onGroup: (group: string, setting: Setting, tools: readonly Settable[]) => void;
	disabled?: boolean | undefined;
	expanded?: boolean | undefined;
}) {
	const all = settable(tools);
	const order = [...new Set([...(groups ?? []), ...all.map((tool) => tool.group)])];
	return (
		<div className="flex flex-col divide-y divide-line-soft rounded-field border border-line-soft" data-tool-list="">
			{order.map((group) => {
				const inside = all.filter((tool) => tool.group === group);
				if (inside.length === 0) return null;
				return (
					<Group
						key={group}
						service={service}
						group={group}
						tools={inside}
						settingOf={settingOf}
						onTools={onTools}
						onGroup={onGroup}
						disabled={disabled}
						expanded={expanded}
					/>
				);
			})}
		</div>
	);
}

function Group({
	service,
	group,
	tools,
	settingOf,
	onTools,
	onGroup,
	disabled,
	expanded,
}: {
	expanded: boolean;
	service: string;
	group: string;
	tools: readonly Settable[];
	settingOf: (tool: Settable) => Setting;
	onTools: (settings: { readonly [tool: string]: Setting }) => void;
	onGroup: (group: string, setting: Setting, tools: readonly Settable[]) => void;
	disabled?: boolean | undefined;
}) {
	const fresh = tools.filter((tool) => tool.fresh === true).length;
	const [open, setOpen] = useState(expanded || fresh > 0);
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
						{fresh > 0 ? <Badge variant="secondary">{fresh === 1 ? "New" : `${fresh} new`}</Badge> : null}
					</Button>
				</CollapsibleTrigger>
				<div className="flex items-center gap-2">
					{common === undefined ? <span className="text-meta text-ink-2">Mixed</span> : null}
					<Choice
						label={`Every tool in ${group}`}
						options={groupOptions(tools)}
						value={common}
						disabled={disabled}
						onChange={(setting) => onGroup(group, setting, tools)}
					/>
				</div>
			</div>
			<CollapsibleContent id={id} className="flex flex-col divide-y divide-line-soft border-t border-line-soft">
				{tools.map((tool) => (
					<div
						key={tool.name}
						data-tool={tool.title}
						className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-2.5 pr-3.5 pl-9"
					>
						<div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
							<p className="flex flex-wrap items-center gap-1.5 break-words text-ui text-ink">
								{tool.words}
								{tool.fresh ? <Badge variant="secondary">New</Badge> : null}
							</p>
							<p className="text-meta text-ink-2">
								{fromWords(tool.classed.from, service)} · {kindWords(tool.classed.kind, tool.classed.floor)}
							</p>
							<details className="text-meta text-ink-2">
								<summary className="cursor-pointer">Tool details</summary>
								<p className="mt-1 break-all font-mono">{tool.title}</p>
								<p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{tool.description}</p>
								{tool.readsWhen ? <p className="mt-1">Reads when {tool.readsWhen.join(" or ")}</p> : null}
							</details>
						</div>
						<Choice
							label={tool.words}
							options={tool.options}
							value={settingOf(tool)}
							disabled={disabled}
							onChange={(setting) => onTools({ [tool.title]: setting })}
						/>
					</div>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Each of `tools` set to `setting` as a group sets it: the setting, or the nearest it has; the rest as they were. */
const groupSet = (tools: readonly Settable[], setting: Setting) =>
	Object.fromEntries(
		tools.flatMap((tool) => {
			const near = inGroup(setting, tool.options);
			return near === undefined ? [] : [[tool.title, near]];
		}),
	) as { [tool: string]: Setting };

/** The line that says how a connection's tools are set: "34 read and run freely · 20 change something and ask first". */
export function toolTally(tools: readonly ConnectionToolView[], settingOf: (tool: Settable) => Setting) {
	return tallyWords(tally(settable(tools).map((tool) => ({ kind: tool.classed.kind, setting: settingOf(tool) }))));
}

/** A connection's tools in Settings: each change at once (`onTools`, `onGroup`), for every agent. */
export function ToolSettings({
	view,
	service,
	onTools,
	onGroup,
	busy = false,
}: {
	view: ConnectionView;
	service: string;
	onTools: (settings: { readonly [tool: string]: Setting }) => void;
	onGroup: (group: string, setting: Setting) => void;
	busy?: boolean | undefined;
}) {
	if (settable(view.tools).length === 0) return null;
	const settingOf = (tool: Settable) => tool.setting ?? "ask";
	return (
		<div className="flex flex-col gap-2" data-tool-settings={view.name}>
			<p className="text-meta text-ink-2">
				{toolTally(view.tools, settingOf)}. For every agent; letting one agent do a change without asking is in its
				Access.
			</p>
			<ToolList
				service={service}
				tools={view.tools}
				groups={view.groups}
				settingOf={settingOf}
				disabled={busy}
				onTools={onTools}
				onGroup={(group, setting) => onGroup(group, setting)}
			/>
		</div>
	);
}

/** How a review reads a tool's setting: as chosen in it, else as proposed. */
const reviewing =
	(chosen: { readonly [tool: string]: Setting }) =>
	(tool: Settable): Setting =>
		chosen[tool.title] ?? tool.proposed ?? tool.setting ?? "ask";

/** The review's content: what it is sorting, what it could not, and the list, as `chosen` sets it. */
export function ReviewBody({
	view,
	service,
	chosen,
	onChosen,
	busy = false,
	error = "",
	expanded = false,
}: {
	view: ConnectionView;
	service: string;
	chosen: { readonly [tool: string]: Setting };
	onChosen: (chosen: { readonly [tool: string]: Setting }) => void;
	busy?: boolean | undefined;
	error?: string | undefined;
	expanded?: boolean | undefined;
}) {
	return (
		<div className="flex min-h-0 flex-col gap-3" data-tool-review={view.name}>
			{view.classifying ? (
				<p role="status" className="flex items-center gap-2 text-ui text-ink-2">
					<Spinner /> Sorting {service}'s tools…
				</p>
			) : null}
			{view.unguessed !== undefined && !view.classifying ? (
				<p className="text-meta text-ink-2">banda couldn't sort some of them, so they ask first.</p>
			) : null}
			<p className="text-meta text-ink-2">
				Allow lets a tool run without asking, for every agent with {service}. Ask shows you each change first; Always
				ask never lets an agent skip that.
			</p>
			<ToolList
				service={service}
				tools={view.tools}
				groups={view.groups}
				settingOf={reviewing(chosen)}
				disabled={busy}
				expanded={expanded}
				onTools={(settings) => onChosen({ ...chosen, ...settings })}
				onGroup={(_group, setting, tools) => onChosen({ ...chosen, ...groupSet(tools, setting) })}
			/>
			{error ? (
				<p role="alert" className="break-words text-ui text-danger">
					{error}
				</p>
			) : null}
		</div>
	);
}

/** The line that says how a review would set a connection's tools. */
export const reviewTally = (view: ConnectionView, chosen: { readonly [tool: string]: Setting }) =>
	view.classifying
		? "banda is sorting its tools. Nothing it guesses runs before you accept."
		: toolTally(view.tools, reviewing(chosen));

/**
 * The review after sign-in, for a connection the owner added: a dialog on the desktop, a sheet from below on the
 * phone. It starts from what each tool is said or guessed to do; nothing guessed runs unasked until Accept.
 */
export function ToolReview({
	view,
	service,
	open,
	onOpenChange,
	onAccept,
}: {
	view: ConnectionView;
	service: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Accept, with the settings chosen: what the daemon is sent. */
	onAccept: (settings: { readonly [tool: string]: Setting }) => Promise<void>;
}) {
	const phone = usePhone();
	const [chosen, setChosen] = useState<{ readonly [tool: string]: Setting }>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!open) setChosen({});
	}, [open]);
	const settingOf = reviewing(chosen);
	const accept = async () => {
		setBusy(true);
		setError("");
		try {
			const settings = Object.fromEntries(settable(view.tools).map((tool) => [tool.title, settingOf(tool)]));
			await onAccept(settings);
			onOpenChange(false);
		} catch (failed) {
			setError(failed instanceof Error ? failed.message : "Couldn't save it. Try again.");
		} finally {
			setBusy(false);
		}
	};
	const title = `${service}'s tools`;
	const note = reviewTally(view, chosen);
	const body = (
		<ReviewBody view={view} service={service} chosen={chosen} onChosen={setChosen} busy={busy} error={error} />
	);
	const actions = (
		<>
			<Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
				Not now
			</Button>
			<Button disabled={busy || view.classifying === true} onClick={() => void accept()}>
				{busy ? <Spinner data-icon="inline-start" /> : null}Accept
			</Button>
		</>
	);
	return phone ? (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto px-4 pb-6">
				<SheetHeader className="px-0">
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>{note}</SheetDescription>
				</SheetHeader>
				{body}
				<SheetFooter className="flex-row justify-end px-0">{actions}</SheetFooter>
			</SheetContent>
		</Sheet>
	) : (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{note}</DialogDescription>
				</DialogHeader>
				{body}
				<DialogFooter>{actions}</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
