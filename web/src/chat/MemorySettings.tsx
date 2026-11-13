/**
 * One set of facts, never copies (DESIGN.md "Memory"). An agent's Memory tab shows only that agent's facts;
 * Settings shows everything: the band's shared facts first, then each agent's own under a row of its own.
 * Whom a fact is about is declared by the owner when adding, never detected; a fact about someone else stays
 * with its agent. Where a fact came from is the owner's metadata alone: the agent's context never carries it.
 * Facts are context, not permission: nothing here grants a tool or changes a personality.
 */
import { ChevronDownIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import type { AvatarFace, FactView, MemoryScope, MemoryView } from "../../../src/server/api.ts";
import { Confirm } from "./Confirm.tsx";
import { Face } from "./Face.tsx";
import { Block, RowOf, Rows } from "./Settings.tsx";

/** A fact the owner adds: its words, its named scope, and whom it is about when not the owner. */
export type NewFactSpec = {
	readonly text: string;
	readonly scope: MemoryScope;
	readonly agent?: string;
	/** Whom it is about, when not the owner: declared here, never inferred from the words. */
	readonly about?: string;
	/** For a fact about someone else: the owner's task it serves. */
	readonly task?: string;
};

export type MemoryActions = {
	onAdd: (fact: NewFactSpec) => Promise<void>;
	onEdit: (id: string, text: string) => Promise<void>;
	onForget: (id: string) => Promise<void>;
};

/** An agent as Settings' memory lists it. Archived: its facts stay readable and forgettable, nothing added or edited. */
export type MemoryAgent = {
	readonly id: string;
	readonly name: string;
	readonly face: AvatarFace;
	readonly archived?: boolean;
};

/** Who wrote a fact, in the owner's words; undefined for the owner's own. */
export type OriginOf = (fact: FactView) => string | undefined;

/**
 * The owner's memory controls. With `agent`: that agent's Memory tab, its facts alone. Without: Settings' Memory,
 * the shared facts first, then every agent as a section of its own, over the same set of facts.
 */
export function MemorySettings({
	agent,
	agents = [],
	memory,
	phone = false,
	originOf,
	...actions
}: {
	/** The agent whose Memory tab this is: only its facts. Without one: Settings, every scope. */
	agent?: { id: string; name: string };
	/** Settings only: the band's agents; archived ones keep a row while they have facts to forget. */
	agents?: readonly MemoryAgent[];
	memory: MemoryView | undefined;
	phone?: boolean;
	originOf?: OriginOf | undefined;
} & MemoryActions) {
	const available = memory !== undefined && !memory.unavailable;
	const facts = memory?.facts ?? [];
	const ofAgent = (id: string) => facts.filter((fact) => fact.scope === "agent" && fact.agent === id);
	const rows = agents.filter((each) => each.archived !== true || ofAgent(each.id).length > 0);
	const shared = {
		phone,
		available,
		budget: memory?.budget,
		originOf,
		...actions,
	};
	return (
		<>
			{available ? null : (
				<p role={memory === undefined ? "status" : "alert"} className="text-ui text-ink-2">
					{memory === undefined
						? "Reading memory…"
						: "Can't read memory right now. Your draft is kept; try again when memory is available."}
				</p>
			)}
			{/* Keep editors mounted through read failures: availability is not the lifetime of an owner's draft. */}
			<fieldset hidden={!available} disabled={!available} className="flex min-w-0 flex-col gap-8">
				{agent !== undefined ? (
					<FactsBlock
						title={`${agent.name}'s memory`}
						note={`What ${agent.name} keeps in mind in its direct and group chats. Facts are context, never permission: none grants a tool or changes its personality. Shared memory lives in Settings.`}
						facts={ofAgent(agent.id)}
						scope="agent"
						agent={agent.id}
						name={agent.name}
						place={`${agent.name}'s memory`}
						empty={`Nothing yet. Tell ${agent.name} something worth keeping.`}
						{...shared}
					/>
				) : (
					<>
						<FactsBlock
							title="Shared memory"
							note="Used by every agent in the band. A change applies to everyone."
							facts={facts.filter((fact) => fact.scope === "global")}
							scope="global"
							name="the band"
							place="the band's shared memory"
							empty="Nothing shared yet. Save a fact the whole band should use."
							{...shared}
						/>
						<Block
							title="Each agent's own"
							note="Facts one agent keeps: for itself, or about someone else for a task of yours. Never shared between agents."
						>
							{rows.length === 0 ? (
								<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">No agents yet.</p>
							) : (
								<Rows>
									{rows.map((each) => (
										<AgentSection key={each.id} agent={each} facts={ofAgent(each.id)} {...shared} />
									))}
								</Rows>
							)}
						</Block>
					</>
				)}
			</fieldset>
		</>
	);
}

/** One scope's facts as a settings section: the list, its budget as it fills, and Add. */
function FactsBlock({
	title,
	note,
	facts,
	scope,
	agent,
	name,
	place,
	empty,
	budget,
	phone,
	available,
	originOf,
	...actions
}: {
	title: string;
	note: string;
	facts: readonly FactView[];
	scope: MemoryScope;
	agent?: string;
	/** Whose facts these are, in words: "Mara", "the band". */
	name: string;
	/** What a forgotten fact leaves, in words: "Mara's memory", "the band's shared memory". */
	place: string;
	empty: string;
	budget: number | undefined;
	phone: boolean;
	available: boolean;
	originOf: OriginOf | undefined;
} & MemoryActions) {
	return (
		<Block title={title} note={note}>
			<FactList
				facts={facts}
				phone={phone}
				available={available}
				place={place}
				empty={empty}
				originOf={originOf}
				onEdit={actions.onEdit}
				onForget={actions.onForget}
			/>
			<BudgetLine facts={facts} budget={budget} />
			<AddFact scope={scope} agent={agent} name={name} onAdd={actions.onAdd} />
		</Block>
	);
}

/** An agent's row in Settings' memory: its face, its name and how many facts, opening them in place. */
function AgentSection({
	agent,
	facts,
	budget,
	phone,
	available,
	originOf,
	...actions
}: {
	agent: MemoryAgent;
	facts: readonly FactView[];
	budget: number | undefined;
	phone: boolean;
	available: boolean;
	originOf: OriginOf | undefined;
} & MemoryActions) {
	const [open, setOpen] = useState(false);
	const archived = agent.archived === true;
	const count = facts.length === 0 ? "Nothing yet" : facts.length === 1 ? "1 fact" : `${facts.length} facts`;
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					aria-label={`${agent.name}'s memory`}
					className="flex min-h-12 w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-paper-3"
				>
					<Face face={agent.face} name={agent.name} size="message" paused={archived} />
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="text-ui text-ink">{agent.name}</span>
						<span className="text-meta text-ink-2">
							{count}
							{archived ? " · Archived" : ""}
						</span>
					</span>
					<ChevronDownIcon
						aria-hidden="true"
						className={cn("size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
					/>
				</button>
			</CollapsibleTrigger>
			{/* Kept mounted while closed: an unsaved draft survives collapsing the section. */}
			<CollapsibleContent
				forceMount
				className="flex flex-col gap-3 border-t border-line-soft px-3.5 py-3 data-[state=closed]:hidden"
			>
				<FactList
					facts={facts}
					phone={phone}
					available={available}
					readOnly={archived}
					place={`${agent.name}'s memory`}
					empty={`Nothing yet. Tell ${agent.name} something worth keeping.`}
					originOf={originOf}
					onEdit={actions.onEdit}
					onForget={actions.onForget}
				/>
				<BudgetLine facts={facts} budget={budget} />
				{archived ? (
					<p className="text-meta text-ink-2">
						{agent.name} is archived: its facts can be forgotten, not edited or added to.
					</p>
				) : (
					<AddFact scope="agent" agent={agent.id} name={agent.name} onAdd={actions.onAdd} />
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** A scope's budget as it fills; a save past it is refused with the facts kept, so the line says what to do. */
function BudgetLine({ facts, budget }: { facts: readonly FactView[]; budget: number | undefined }) {
	if (budget === undefined || facts.length === 0) return null;
	const used = facts.reduce((sum, fact) => sum + (fact.size ?? 0), 0);
	return (
		<p className="text-meta text-ink-2">
			{used.toLocaleString()} of {budget.toLocaleString()} characters
			{used >= budget * 0.9 ? " — nearly full: a save past it is refused, so shorten or forget a fact first" : ""}.
		</p>
	);
}

/**
 * The facts of one scope. On the desktop a row edits in place; on the phone the actions sit behind the row's menu
 * and Edit opens a drawer. An unsaved draft is keyed by the fact's id and survives closing the drawer, collapsing
 * the section and memory being briefly unreachable; a stale save reports the conflict and keeps the draft.
 */
function FactList({
	facts,
	phone,
	available,
	readOnly = false,
	place,
	empty,
	originOf,
	onEdit,
	onForget,
}: {
	facts: readonly FactView[];
	phone: boolean;
	available: boolean;
	readOnly?: boolean;
	place: string;
	empty: string;
	originOf: OriginOf | undefined;
	onEdit: MemoryActions["onEdit"];
	onForget: MemoryActions["onForget"];
}) {
	// The fact being edited, as last seen: kept when SSE changes or removes it, so Save reports a conflict,
	// never loses the draft.
	const [editing, setEditing] = useState<FactView>();
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [forgetting, setForgetting] = useState<FactView>();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const shown = editing !== undefined && !facts.some((fact) => fact.id === editing.id) ? [...facts, editing] : facts;
	const draftOf = (fact: FactView) => drafts[fact.id] ?? fact.text;
	const save = async (run: () => void | Promise<void>, done: () => void = () => {}) => {
		setPending(true);
		setError(undefined);
		try {
			await run();
			done();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Couldn't save memory. Try again.");
		} finally {
			setPending(false);
		}
	};
	const submitEdit = (fact: FactView) => {
		const text = draftOf(fact).trim();
		if (text === "") return;
		void save(
			() => onEdit(fact.id, text),
			() => {
				setEditing(undefined);
				setDrafts(({ [fact.id]: _saved, ...rest }) => rest);
			},
		);
	};
	const forgetWords = (fact: FactView) => `“${fact.text}” leaves ${place}. What was said in chats stays.`;
	const detailOf = (fact: FactView) => {
		const parts = [
			fact.about === undefined ? undefined : `About ${fact.about}${fact.for === undefined ? "" : `, for ${fact.for}`}`,
			originOf?.(fact),
		].filter((part): part is string => part !== undefined);
		return parts.length === 0 ? undefined : parts.join(" · ");
	};
	return (
		<>
			{error === undefined ? null : (
				<p role="alert" className="text-ui text-danger">
					{error}
				</p>
			)}
			{shown.length === 0 ? (
				<p className="rounded-field bg-paper-2 px-3.5 py-3 text-ui text-ink-2">{empty}</p>
			) : (
				<Rows>
					{shown.map((fact) =>
						!phone && editing?.id === fact.id ? (
							<form
								key={fact.id}
								className="flex items-center gap-2 px-3 py-2"
								onSubmit={(event) => {
									event.preventDefault();
									submitEdit(fact);
								}}
							>
								<Input
									value={draftOf(fact)}
									onChange={(event) => setDrafts((was) => ({ ...was, [fact.id]: event.target.value }))}
									aria-label="The fact"
									className="h-8 flex-1 text-ui"
									maxLength={300}
									disabled={pending}
									autoFocus
								/>
								<Button type="submit" size="xs" disabled={pending}>
									Save
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="xs"
									disabled={pending}
									onClick={() => {
										setEditing(undefined);
										setError(undefined);
									}}
								>
									Cancel
								</Button>
							</form>
						) : (
							<RowOf
								key={fact.id}
								title={fact.text}
								detail={detailOf(fact)}
								end={
									phone ? (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button variant="ghost" size="icon-xs" className="text-ink-2" aria-label={`More: ${fact.text}`}>
													<MoreHorizontalIcon />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												{readOnly ? null : (
													<DropdownMenuItem
														aria-label={`Edit: ${fact.text}`}
														onSelect={() => {
															setError(undefined);
															setEditing(fact);
														}}
													>
														<PencilIcon />
														Edit
													</DropdownMenuItem>
												)}
												<DropdownMenuItem
													variant="destructive"
													aria-label={`Forget: ${fact.text}`}
													onSelect={() => setForgetting(fact)}
												>
													<Trash2Icon />
													Forget
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									) : (
										<span className="flex gap-0.5">
											{readOnly ? null : (
												<Button
													variant="ghost"
													size="icon-xs"
													className="text-ink-2"
													aria-label={`Edit: ${fact.text}`}
													onClick={() => {
														setError(undefined);
														setEditing(fact);
													}}
												>
													<PencilIcon />
												</Button>
											)}
											<Confirm
												title="Forget this?"
												body={forgetWords(fact)}
												action="Forget"
												keep="Keep it"
												onConfirm={() => void save(() => onForget(fact.id))}
											>
												<Button variant="destructive" size="icon-xs" aria-label={`Forget: ${fact.text}`}>
													<Trash2Icon />
												</Button>
											</Confirm>
										</span>
									)
								}
							/>
						),
					)}
				</Rows>
			)}
			{/* The phone's confirm, reached from a row's menu. */}
			<AlertDialog
				open={forgetting !== undefined}
				onOpenChange={(open) => {
					if (!open) setForgetting(undefined);
				}}
			>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>Forget this?</AlertDialogTitle>
						<AlertDialogDescription>{forgetting === undefined ? "" : forgetWords(forgetting)}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep it</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (forgetting !== undefined) void save(() => onForget(forgetting.id));
							}}
						>
							Forget
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			{/* The phone's editor: a drawer with the keyboard up. Closing it keeps the unsaved draft. */}
			{phone ? (
				<Sheet
					open={editing !== undefined}
					onOpenChange={(open) => {
						if (!open) setEditing(undefined);
					}}
				>
					<SheetContent side="bottom" showCloseButton={false} aria-describedby={undefined}>
						<SheetHeader>
							<SheetTitle>Edit the fact</SheetTitle>
						</SheetHeader>
						{editing === undefined ? null : (
							<form
								className="flex flex-col gap-3 px-4 pb-6"
								onSubmit={(event) => {
									event.preventDefault();
									submitEdit(editing);
								}}
							>
								{error === undefined ? null : (
									<p role="alert" className="text-ui text-danger">
										{error}
									</p>
								)}
								<Input
									value={draftOf(editing)}
									onChange={(event) => setDrafts((was) => ({ ...was, [editing.id]: event.target.value }))}
									aria-label="The fact"
									maxLength={300}
									disabled={pending || !available}
									autoFocus
								/>
								<div className="flex items-center justify-end gap-2">
									<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
										Close
									</Button>
									<Button type="submit" size="sm" disabled={pending || !available || draftOf(editing).trim() === ""}>
										Save
									</Button>
								</div>
								<p className="text-meta text-ink-2">Closing keeps your unsaved words.</p>
							</form>
						)}
					</SheetContent>
				</Sheet>
			) : null}
		</>
	);
}

/**
 * Add one fact to a named scope. Whom it is about is declared here: shared memory refuses a fact about someone
 * else and points to an agent's own, where it also names the owner's task it serves.
 */
function AddFact({
	scope,
	agent,
	name,
	onAdd,
}: {
	scope: MemoryScope;
	agent?: string | undefined;
	/** Whose memory it saves into, in words: "Mara", "the band". */
	name: string;
	onAdd: MemoryActions["onAdd"];
}) {
	const [text, setText] = useState("");
	const [others, setOthers] = useState(false);
	const [about, setAbout] = useState("");
	const [task, setTask] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const refused = scope === "global" && others;
	const ready = text.trim() !== "" && !refused && (!others || (about.trim() !== "" && task.trim() !== ""));
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (!ready || pending) return;
				setPending(true);
				setError(undefined);
				onAdd({
					text: text.trim(),
					scope,
					...(agent === undefined ? {} : { agent }),
					...(others && scope === "agent" ? { about: about.trim(), task: task.trim() } : {}),
				})
					.then(() => {
						setText("");
						setAbout("");
						setTask("");
						setOthers(false);
					})
					.catch((failure: unknown) =>
						setError(failure instanceof Error ? failure.message : "Couldn't save memory. Try again."),
					)
					.finally(() => setPending(false));
			}}
		>
			{error === undefined ? null : (
				<p role="alert" className="text-ui text-danger">
					{error}
				</p>
			)}
			<Input
				aria-label={scope === "global" ? "New shared fact" : "New agent fact"}
				placeholder="Something worth remembering…"
				value={text}
				onChange={(event) => setText(event.target.value)}
				maxLength={300}
				disabled={pending}
			/>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
			<label className="flex items-center gap-2.5 text-ui text-ink-2">
				<Switch checked={others} onCheckedChange={setOthers} disabled={pending} aria-label="About someone else" />
				About someone else
			</label>
			{!others ? null : refused ? (
				<p className="text-meta text-ink-2">
					A fact about someone else stays with an agent, never in the band's shared memory. Add it under that agent
					below.
				</p>
			) : (
				<>
					<Input
						aria-label="Who it's about"
						placeholder="Who it's about"
						value={about}
						onChange={(event) => setAbout(event.target.value)}
						maxLength={60}
						disabled={pending}
					/>
					<Input
						aria-label="Your task it serves"
						placeholder="Your task it serves"
						value={task}
						onChange={(event) => setTask(event.target.value)}
						maxLength={120}
						disabled={pending}
					/>
					<p className="text-meta text-ink-2">It stays with {name}, never in the band's shared memory.</p>
				</>
			)}
			<Button type="submit" variant="outline" size="sm" disabled={pending || !ready} className="self-start">
				Remember
			</Button>
		</form>
	);
}
