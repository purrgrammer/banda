/**
 * A server of the owner's, added or edited: its name, its address (where it sends things, said as the owner types and
 * never reached for that), its key or none; then its models, found when the owner asks the server for its list (the
 * route its kind documents, which runs no model) or added by id when it has none to give. Which models it keeps and the
 * one it starts on are two choices: every kept model can run, the start one runs all three tiers until the owner refines
 * them. Only what is missing is asked, and only for a model the owner keeps: a fact the server said is shown as its,
 * a model of the same id in pi-ai's catalog is offered and never taken, and a price is the owner's alone.
 */
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import {
	COMPAT_DEFAULTS,
	type CustomCompat,
	type CustomModel,
	type CustomProvider,
	destinationOf,
	type ModelSource,
	modelName,
	problemsOf,
	SERVER_KINDS,
	type ServerKind,
} from "../../../src/core/custom-providers.ts";
import type { CustomProviderSave, CustomProviderView, ListingView } from "../areas/custom-providers.ts";
import { Confirm } from "./Confirm.tsx";
import { failureWords } from "./CustomProviders.tsx";

/** A count of tokens, as people read one. */
export const tokens = (count: number) => count.toLocaleString("en-US");

type Listed = Extract<ListingView, { ok: true }>["models"][number];

/** A model the form holds: what the server or the owner said of it, as typed, and whether it is kept. */
type Entry = {
	readonly key: number;
	readonly id: string;
	readonly name: string;
	readonly listed: boolean;
	/** What the server's list said, kept apart from what the owner typed. */
	readonly server: Omit<Listed, "id" | "catalog">;
	readonly catalog?: Listed["catalog"];
	/** Facts taken from pi-ai's catalog, on the owner's word. */
	readonly fromCatalog: boolean;
	readonly contextWindow: string;
	readonly maxTokens: string;
	readonly images: boolean;
	readonly reasoning: boolean;
	readonly input: string;
	readonly output: string;
	readonly keep: boolean;
	/** The owner opened its details. */
	readonly open: boolean;
	/** The owner typed one of its limits. */
	readonly typed: boolean;
};

let next = 1;
const numberOf = (text: string) => (text.trim() === "" ? Number.NaN : Number(text.replace(/[,_\s]/g, "")));
const known = (text: string) => !Number.isNaN(numberOf(text));

function fromListed(model: Listed): Entry {
	const { id, catalog, ...server } = model;
	return {
		key: next++,
		id,
		name: model.name ?? "",
		listed: true,
		server,
		...(catalog === undefined ? {} : { catalog }),
		fromCatalog: false,
		contextWindow: server.contextWindow === undefined ? "" : String(server.contextWindow),
		maxTokens: server.maxTokens === undefined ? "" : String(server.maxTokens),
		images: server.images ?? false,
		reasoning: server.reasoning ?? false,
		input: "",
		output: "",
		keep: false,
		open: false,
		typed: false,
	};
}

function fromKept(model: CustomModel): Entry {
	return {
		key: next++,
		id: model.id,
		name: model.name ?? "",
		listed: model.source.listed,
		server: {},
		fromCatalog: typeof model.source.limits === "object",
		contextWindow: String(model.contextWindow),
		maxTokens: String(model.maxTokens),
		images: model.images,
		reasoning: model.reasoning,
		input: model.cost === undefined ? "" : String(model.cost.input),
		output: model.cost === undefined ? "" : String(model.cost.output),
		keep: true,
		open: false,
		typed: model.source.limits === "owner",
	};
}

/** Where a kept model's limits came from, as stored. */
function sourceOf(entry: Entry): ModelSource {
	const limits: ModelSource["limits"] = entry.typed
		? "owner"
		: entry.fromCatalog && entry.catalog !== undefined
			? { catalog: entry.catalog.ref }
			: entry.listed && entry.server.contextWindow !== undefined && entry.server.maxTokens !== undefined
				? "server"
				: "owner";
	return { listed: entry.listed, limits };
}

/** A model's facts and where they came from, in a line. */
function factsOf(entry: Entry): string {
	const parts = [
		known(entry.contextWindow) ? `${tokens(numberOf(entry.contextWindow))} context` : undefined,
		known(entry.maxTokens) ? `answer cap ${tokens(numberOf(entry.maxTokens))}` : undefined,
		entry.images ? "reads images" : undefined,
		entry.reasoning ? "thinks first" : undefined,
	].filter(Boolean);
	return parts.join(" · ");
}

function originOf(entry: Entry): string {
	const said = entry.listed ? "Listed by the server" : "Added by you";
	if (entry.typed) return `${said} · limits you entered`;
	if (entry.fromCatalog && entry.catalog !== undefined)
		return `${said} · limits from pi-ai's catalog (${entry.catalog.provider})`;
	if (entry.listed && (entry.server.contextWindow !== undefined || entry.server.maxTokens !== undefined))
		return `${said} · limits from the server`;
	return said;
}

/** What the model still needs before it can be kept, in words. */
function missingOf(entry: Entry): string | undefined {
	const missing = [
		known(entry.contextWindow) ? undefined : "its context",
		known(entry.maxTokens) ? undefined : "its answer cap",
	].filter(Boolean);
	return missing.length === 0 ? undefined : `Needs ${missing.join(" and ")}`;
}

export function FieldOf({
	label,
	note,
	problem,
	children,
	className,
}: {
	label: string;
	note?: ReactNode;
	problem?: string | undefined;
	children: (id: string) => ReactNode;
	className?: string;
}) {
	const id = useId();
	return (
		<div className={cn("flex min-w-0 flex-col gap-1", className)}>
			<label htmlFor={id} className="text-meta font-medium text-ink">
				{label}
			</label>
			{children(id)}
			{problem === undefined ? (
				note === undefined ? null : (
					<span className="text-meta text-ink-2">{note}</span>
				)
			) : (
				<span role="alert" className="text-meta text-danger">
					{problem}
				</span>
			)}
		</div>
	);
}

const SELECT =
	"h-9 w-full min-w-0 rounded-field border border-line bg-paper px-2.5 text-ui text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ServerSetup({
	kind,
	initial,
	others = [],
	here = true,
	list,
	onSave,
	onCancel,
	onRemove,
	listing: openListing,
}: {
	kind: ServerKind;
	/** The server being edited; a new one when absent. */
	initial?: CustomProviderView | undefined;
	/** The other servers' names. */
	others?: readonly string[];
	/** On the computer banda runs on; false on a phone. */
	here?: boolean;
	/** Ask the server for its list of models. */
	list?:
		| ((
				provider: { readonly kind: ServerKind; readonly baseUrl: string; readonly key: "none" | "required" },
				key?: string,
				id?: string,
		  ) => Promise<ListingView>)
		| undefined;
	/** Resolves with why it was refused, or undefined. */
	onSave?: ((save: CustomProviderSave) => Promise<string | undefined>) | undefined;
	onCancel?: (() => void) | undefined;
	onRemove?: (() => Promise<string | undefined>) | undefined;
	/** A listing shown at first, for the specimen. */
	listing?: ListingView | undefined;
}) {
	const about = SERVER_KINDS[kind];
	const editing = initial !== undefined;
	const [name, setName] = useState(
		initial?.name ?? (kind === "openai" || kind === "openai-responses" ? "" : about.label),
	);
	const [baseUrl, setBaseUrl] = useState(
		initial?.baseUrl ?? (about.address.startsWith("http://localhost") ? about.address : ""),
	);
	const [needsKey, setNeedsKey] = useState(
		initial === undefined ? !about.address.startsWith("http://localhost") : initial.key !== "none",
	);
	const [key, setKey] = useState("");
	const [entries, setEntries] = useState<readonly Entry[]>(() => [
		...(initial?.models.map(fromKept) ?? []),
		...(openListing?.ok === true ? openListing.models.map(fromListed) : []),
	]);
	const [start, setStart] = useState<number | undefined>(undefined);
	const [billing, setBilling] = useState<"none" | "rates" | undefined>(initial?.billing);
	const [compat, setCompat] = useState<Required<CustomCompat>>({ ...COMPAT_DEFAULTS, ...initial?.compat });
	const [listing, setListing] = useState<ListingView | undefined>(openListing);
	const [listingBusy, setListingBusy] = useState(false);
	const [manual, setManual] = useState("");
	const [othersOpen, setOthersOpen] = useState(false);
	const [manualOpen, setManualOpen] = useState(false);
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [refused, setRefused] = useState<string | undefined>(undefined);
	const [removing, setRemoving] = useState(false);
	const form = useRef<HTMLFormElement>(null);

	const destination = destinationOf(baseUrl);
	const keyStored = initial?.key === "stored";
	const kept = entries.filter((entry) => entry.keep || entry.key === start);
	const definition: Omit<CustomProvider, "id"> = {
		name: name.trim(),
		kind,
		baseUrl: baseUrl.trim(),
		key: needsKey ? "required" : "none",
		billing: billing ?? ("" as never),
		models: kept.map(
			(entry): CustomModel => ({
				id: entry.id,
				...(entry.name.trim() === "" ? {} : { name: entry.name.trim() }),
				images: entry.images,
				reasoning: entry.reasoning,
				contextWindow: numberOf(entry.contextWindow),
				maxTokens: numberOf(entry.maxTokens),
				...(billing === "rates" ? { cost: { input: numberOf(entry.input), output: numberOf(entry.output) } } : {}),
				source: sourceOf(entry),
			}),
		),
		...(about.api === "openai-completions"
			? (() => {
					const changed = Object.fromEntries(
						Object.entries(compat).filter(([field, value]) => COMPAT_DEFAULTS[field as keyof CustomCompat] !== value),
					);
					return Object.keys(changed).length === 0 ? {} : { compat: changed as CustomCompat };
				})()
			: {}),
	};
	const problems = problemsOf(definition, others);
	const problem = (field: string) => (tried ? problems.find((each) => each.field === field)?.message : undefined);
	/** A kept model's problem, by its entry. */
	const modelProblem = (entry: Entry, field: string) => {
		const at = kept.indexOf(entry);
		return at === -1 ? undefined : problem(`models.${at}.${field}`);
	};
	const startProblem = tried && !editing && start === undefined ? "Pick the model it starts on" : undefined;
	const keyProblem =
		tried && needsKey && key.trim() === "" && !keyStored ? "Paste its key, or turn off Requires an API key" : undefined;
	const change = (at: number, patch: Partial<Entry>) =>
		setEntries((all) => all.map((entry) => (entry.key === at ? { ...entry, ...patch } : entry)));

	const find = async () => {
		if (list === undefined || "error" in destination) return;
		setListingBusy(true);
		setRefused(undefined);
		const read = await list(
			{ kind, baseUrl: destination.url, key: needsKey ? "required" : "none" },
			needsKey && key.trim() !== "" ? key.trim() : undefined,
			initial?.id,
		).catch(
			(thrown: unknown): ListingView => ({
				ok: false,
				failure: "other",
				detail: thrown instanceof Error ? thrown.message : String(thrown),
			}),
		);
		setListingBusy(false);
		setListing(read);
		if (!read.ok) return;
		// the next choice is the model it starts on: there, once the list shows
		requestAnimationFrame(() => {
			const first = form.current?.querySelector<HTMLElement>('input[name="start"]');
			first?.scrollIntoView({ block: "center" });
			first?.focus();
		});
		// what the owner already kept or typed stays; a listed model new to the form joins it
		setEntries((all) => {
			const have = new Set(all.map((entry) => entry.id));
			return [
				...all.map((entry) => {
					const listed = read.models.find((model) => model.id === entry.id);
					if (listed === undefined || entry.typed) return entry;
					const fresh = fromListed(listed);
					return {
						...entry,
						listed: true,
						server: fresh.server,
						...(fresh.catalog === undefined ? {} : { catalog: fresh.catalog }),
						contextWindow: entry.contextWindow === "" ? fresh.contextWindow : entry.contextWindow,
						maxTokens: entry.maxTokens === "" ? fresh.maxTokens : entry.maxTokens,
					};
				}),
				...read.models.filter((model) => !have.has(model.id)).map(fromListed),
			];
		});
	};
	const addManual = () => {
		const id = manual.trim();
		if (id === "" || entries.some((entry) => entry.id === id)) return;
		const entry = { ...fromListed({ id }), listed: false, open: true };
		setEntries((all) => [...all, entry]);
		setManual("");
		if (start === undefined && !editing) setStart(entry.key);
	};
	const save = async () => {
		setTried(true);
		setRefused(undefined);
		if (problems.length > 0 || startProblem !== undefined || keyProblem !== undefined || kept.length === 0) {
			requestAnimationFrame(() =>
				form.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "center", behavior: "smooth" }),
			);
			return;
		}
		setBusy(true);
		const startEntry = entries.find((entry) => entry.key === start);
		const why = await onSave?.({
			provider: definition,
			...(needsKey && key.trim() !== "" ? { key: key.trim() } : {}),
			...(startEntry === undefined ? {} : { start: startEntry.id }),
		});
		setBusy(false);
		setRefused(why);
	};
	const where =
		"error" in destination
			? undefined
			: destination.place === "computer"
				? `Sends to ${destination.host}: ${here ? "this computer, where banda runs" : "the computer banda runs on, not this phone"}.`
				: destination.place === "network"
					? `Sends to ${destination.host}, on your network.${destination.secure ? "" : needsKey ? " Over http, its key and what you ask cross your network unencrypted." : " Over http, what you ask crosses your network unencrypted."}`
					: `Sends everything the band says to ${destination.host}, on the internet.`;
	const listingFailed = listing !== undefined && !listing.ok ? listing : undefined;
	/** A model's row: in the start list (a radio), the keep list (a checkbox), or an edit's one list (a checkbox). */
	const row = (entry: Entry, mode: "start" | "keep" | "edit") => {
		const missing = missingOf(entry);
		const chats = entry.server.chats !== false;
		const isStart = entry.key === start;
		const keptHere = entry.keep || isStart;
		// a start row asks what the start model lacks; a keep row, what a kept or opened model lacks
		const showFields =
			mode === "start"
				? isStart && (missing !== undefined || entry.open || billing === "rates")
				: !isStart && (entry.open || (entry.keep && billing === "rates"));
		return (
			<li
				key={entry.key}
				className="flex flex-col gap-2 px-3 py-2.5"
				{...(mode === "start" ? { "data-model": entry.id } : { "data-keep": entry.id })}
			>
				<div className="flex items-start gap-3">
					{mode === "start" ? null : (
						<Checkbox
							className="mt-0.5"
							checked={keptHere}
							disabled={!chats || isStart || (missing !== undefined && !entry.keep)}
							aria-label={`Keep ${entry.id}`}
							onCheckedChange={(on) => change(entry.key, { keep: on === true })}
						/>
					)}
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="text-ui break-all text-ink">
							{modelName({ id: entry.id, name: entry.name })}
							{entry.name.trim() === "" ? null : <span className="text-meta text-ink-2"> · {entry.id}</span>}
						</span>
						{factsOf(entry) === "" ? null : <span className="text-meta text-ink-2">{factsOf(entry)}</span>}
						<span className="text-meta text-ink-2">{originOf(entry)}</span>
						{!chats ? (
							<span className="text-meta text-ink-2">It doesn't chat (an embedding model): banda can't use it.</span>
						) : missing !== undefined && mode !== "start" ? (
							<span className="text-meta text-ink-2">
								{missing}: not usable until you add {missing.includes(" and ") ? "them" : "it"}.{" "}
								<button
									type="button"
									className="underline decoration-line underline-offset-[3px] hover:text-ink"
									onClick={() => change(entry.key, { open: true })}
								>
									Complete it
								</button>
							</span>
						) : null}
					</span>
					{mode !== "start" || !chats ? null : (
						<label className="flex shrink-0 items-center gap-1.5 text-meta text-ink">
							<input
								type="radio"
								name="start"
								className="size-4 accent-current"
								checked={isStart}
								onChange={() => setStart(entry.key)}
								aria-label={`Start with ${entry.id}`}
							/>
							Start with
						</label>
					)}
				</div>
				{showFields && chats ? (
					<div className="grid grid-cols-1 gap-x-3 gap-y-2.5 pl-7 sm:grid-cols-2">
						{entry.catalog !== undefined && missing !== undefined && !entry.fromCatalog ? (
							<div className="flex flex-wrap items-center gap-2 rounded-field bg-paper-3 px-2.5 py-2 text-meta text-ink-2 sm:col-span-2">
								<span className="flex-1">
									pi-ai's catalog has a model with this id ({entry.catalog.provider}):{" "}
									{tokens(entry.catalog.contextWindow)} context, at most {tokens(entry.catalog.maxTokens)} tokens an
									answer. Your server may run it differently.
								</span>
								<Button
									type="button"
									variant="outline"
									size="xs"
									onClick={() =>
										change(entry.key, {
											fromCatalog: true,
											contextWindow:
												entry.contextWindow === "" ? String(entry.catalog?.contextWindow) : entry.contextWindow,
											maxTokens: entry.maxTokens === "" ? String(entry.catalog?.maxTokens) : entry.maxTokens,
										})
									}
								>
									Use these limits
								</Button>
							</div>
						) : null}
						{known(entry.contextWindow) && entry.server.contextWindow !== undefined && !entry.open ? null : (
							<FieldOf label="Context, tokens" problem={modelProblem(entry, "contextWindow")}>
								{(id) => (
									<Input
										id={id}
										inputMode="numeric"
										placeholder="As the server allows"
										value={entry.contextWindow}
										onChange={(event) =>
											change(entry.key, { contextWindow: event.target.value, typed: true, open: true })
										}
									/>
								)}
							</FieldOf>
						)}
						{known(entry.maxTokens) && entry.server.maxTokens !== undefined && !entry.open ? null : (
							<FieldOf
								label="Answer cap, tokens"
								problem={modelProblem(entry, "maxTokens")}
								note="Sent as max_tokens with each request: no more than the server allows."
							>
								{(id) => (
									<Input
										id={id}
										inputMode="numeric"
										placeholder="As the server allows"
										value={entry.maxTokens}
										onChange={(event) => change(entry.key, { maxTokens: event.target.value, typed: true, open: true })}
									/>
								)}
							</FieldOf>
						)}
						{keptHere && billing === "rates" ? (
							<>
								<FieldOf label="$ per 1M tokens in" problem={modelProblem(entry, "cost.input")}>
									{(id) => (
										<Input
											id={id}
											inputMode="decimal"
											placeholder="As it bills you"
											value={entry.input}
											onChange={(event) => change(entry.key, { input: event.target.value, open: true })}
										/>
									)}
								</FieldOf>
								<FieldOf label="$ per 1M tokens out" problem={modelProblem(entry, "cost.output")}>
									{(id) => (
										<Input
											id={id}
											inputMode="decimal"
											placeholder="As it bills you"
											value={entry.output}
											onChange={(event) => change(entry.key, { output: event.target.value, open: true })}
										/>
									)}
								</FieldOf>
							</>
						) : null}
						{entry.open || entry.server.images === undefined ? (
							<span className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:col-span-2">
								{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
								<label className="flex items-center gap-2 text-ui text-ink">
									<Switch
										checked={entry.images}
										onCheckedChange={(on) => change(entry.key, { images: on })}
										aria-label={`${entry.id} reads images`}
									/>
									Reads images
								</label>
								{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
								<label className="flex items-center gap-2 text-ui text-ink">
									<Switch
										checked={entry.reasoning}
										onCheckedChange={(on) => change(entry.key, { reasoning: on })}
										aria-label={`${entry.id} thinks first`}
									/>
									Thinks first
								</label>
							</span>
						) : null}
					</div>
				) : null}
			</li>
		);
	};

	return (
		<form
			ref={form}
			noValidate
			className="flex min-w-0 flex-col gap-5"
			aria-label={editing ? `${initial.name}'s settings` : `New ${about.label}`}
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<div className="flex flex-col gap-3">
				<FieldOf label="Name" problem={problem("name")}>
					{(id) => (
						<Input
							id={id}
							value={name}
							maxLength={60}
							placeholder="My model server"
							autoComplete="off"
							autoFocus={!editing}
							onChange={(event) => setName(event.target.value)}
						/>
					)}
				</FieldOf>
				<FieldOf
					label="Address"
					problem={
						tried || baseUrl.trim() !== "" ? ("error" in destination ? destination.error : undefined) : undefined
					}
					note={where ?? `Its API's address, such as ${about.address}`}
				>
					{(id) => (
						<Input
							id={id}
							value={baseUrl}
							inputMode="url"
							spellCheck={false}
							autoCapitalize="off"
							autoComplete="off"
							placeholder={about.address}
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					)}
				</FieldOf>
				<div className="flex flex-col gap-2">
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
					<label className="flex items-center gap-3">
						<Switch checked={needsKey} onCheckedChange={setNeedsKey} aria-label="Requires an API key" />
						<span className="text-ui text-ink">Requires an API key</span>
					</label>
					{needsKey ? (
						<FieldOf
							label={keyStored ? "Replace its key" : "Its key"}
							problem={keyProblem}
							note={
								keyStored
									? "A key is saved. Leave this empty to keep it. A new address needs the key again."
									: "Kept on the computer banda runs on, apart from everything else. It's never shown again."
							}
						>
							{(id) => (
								<Input
									id={id}
									type="password"
									autoComplete="off"
									value={key}
									placeholder={keyStored ? "Saved: type to replace" : "Paste its key"}
									onChange={(event) => setKey(event.target.value)}
								/>
							)}
						</FieldOf>
					) : null}
				</div>
			</div>

			<section className="flex flex-col gap-3" aria-label="Models">
				<div className="flex flex-col gap-1">
					<h3 className="text-ui font-medium text-ink">Models</h3>
					<span className="text-meta text-ink-2">
						{"error" in destination
							? "Write its address, then ask it which models it has."
							: `Find models asks ${destination.host} which models it has. No model runs.`}
					</span>
				</div>
				<span className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={
							list === undefined ||
							"error" in destination ||
							listingBusy ||
							(needsKey && key.trim() === "" && !keyStored)
						}
						onClick={() => void find()}
					>
						{listingBusy ? <Spinner className="size-3.5" /> : null}
						Find models
					</Button>
					{listing?.ok === true ? (
						<span role="status" className="text-meta text-ink-2">
							{listing.models.length === 0
								? "It listed no models."
								: `It listed ${listing.models.length === 1 ? "1 model" : `${listing.models.length} models`}.`}
						</span>
					) : null}
				</span>
				{listingFailed === undefined ? null : (
					<div role="alert" className="text-meta text-danger">
						{failureWords(listingFailed.failure, "error" in destination ? baseUrl : destination.host)} You can still add
						a model by its id below.
						<details className="mt-1 text-ink-2">
							<summary className="cursor-pointer">Details</summary>
							<span className="break-all">
								{listingFailed.status === undefined ? "" : `HTTP ${listingFailed.status} · `}
								{listingFailed.detail}
							</span>
						</details>
					</div>
				)}
				{tried && kept.length === 0 ? (
					<span role="alert" className="text-meta text-danger">
						Keep at least one model.
					</span>
				) : null}
				{entries.length === 0 ? null : editing ? (
					<ul
						className="flex flex-col divide-y divide-line-soft rounded-panel border border-line-soft"
						aria-label="Its models"
					>
						{entries.map((entry) => row(entry, "edit"))}
					</ul>
				) : (
					<>
						<p className="text-ui text-ink">
							Pick the model it starts on. It runs all three tiers until you refine them.
						</p>
						<ul
							className="flex flex-col divide-y divide-line-soft rounded-panel border border-line-soft"
							aria-label="The model it starts on"
						>
							{entries.filter((entry) => entry.server.chats !== false).map((entry) => row(entry, "start"))}
						</ul>
						{start === undefined || entries.length < 2 ? null : (
							<Collapsible open={othersOpen} onOpenChange={setOthersOpen}>
								<CollapsibleTrigger asChild>
									<Button type="button" variant="ghost" size="sm" className="group -ml-2 self-start text-ink-2">
										<ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180" />
										Also keep other models ({entries.filter((entry) => entry.key !== start && entry.keep).length} of{" "}
										{entries.length - 1})
									</Button>
								</CollapsibleTrigger>
								<CollapsibleContent>
									<ul
										className="mt-2 flex flex-col divide-y divide-line-soft rounded-panel border border-line-soft"
										aria-label="Other models to keep"
									>
										{entries.filter((entry) => entry.key !== start).map((entry) => row(entry, "keep"))}
									</ul>
								</CollapsibleContent>
							</Collapsible>
						)}
					</>
				)}
				{startProblem === undefined ? null : (
					<span role="alert" className="text-meta text-danger">
						{startProblem}
					</span>
				)}
				<Collapsible
					open={manualOpen || listingFailed !== undefined || (listing?.ok === true && listing.models.length === 0)}
					onOpenChange={setManualOpen}
				>
					<CollapsibleTrigger asChild>
						<Button type="button" variant="ghost" size="sm" className="group -ml-2 self-start text-ink-2">
							<ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180" />
							Missing a model? Add it by its id
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						<div className="flex items-end gap-2">
							<FieldOf
								label="Add a model by its id"
								note="When it lists none, or not the one you want."
								className="flex-1"
							>
								{(id) => (
									<Input
										id={id}
										value={manual}
										spellCheck={false}
										autoCapitalize="off"
										autoComplete="off"
										placeholder="qwen3:8b"
										onChange={(event) => setManual(event.target.value)}
										onKeyDown={(event) => {
											if (event.key !== "Enter") return;
											event.preventDefault();
											addManual();
										}}
									/>
								)}
							</FieldOf>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mb-6"
								onClick={addManual}
								disabled={manual.trim() === ""}
							>
								<PlusIcon />
								Add
							</Button>
						</div>
					</CollapsibleContent>
				</Collapsible>
			</section>

			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-ui font-medium text-ink">What it charges</legend>
				<span className="text-meta text-ink-2">banda counts what the band spends from this. Nothing is assumed.</span>
				{(
					[
						["none", "No per-token charges", "Your own hardware, or a flat plan."],
						["rates", "Charges per token", "You give each kept model's rates."],
					] as const
				).map(([value, label, about]) => (
					<label key={value} className="flex items-start gap-2.5">
						<input
							type="radio"
							name="billing"
							className="mt-1 size-4 accent-current"
							checked={billing === value}
							onChange={() => setBilling(value)}
						/>
						<span className="flex flex-col">
							<span className="text-ui text-ink">{label}</span>
							<span className="text-meta text-ink-2">{about}</span>
						</span>
					</label>
				))}
				{problem("billing") === undefined ? null : (
					<span role="alert" className="text-meta text-danger">
						Say whether it charges per token.
					</span>
				)}
			</fieldset>

			{about.api === "openai-completions" ? (
				<Collapsible>
					<CollapsibleTrigger asChild>
						<Button type="button" variant="ghost" size="sm" className="group -ml-2 self-start text-ink-2">
							<ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180" />
							Compatibility
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent className="flex flex-col gap-3 pt-2">
						<span className="text-meta text-ink-2">
							For chat completions. Change these only if it refuses a request. The defaults suit most local servers; not
							every server works with banda.
						</span>
						<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
							<FieldOf label="Instructions to a thinking model go as">
								{(id) => (
									<select
										id={id}
										className={SELECT}
										value={compat.instructions}
										onChange={(event) =>
											setCompat((was) => ({ ...was, instructions: event.target.value as "system" | "developer" }))
										}
									>
										<option value="system">system</option>
										<option value="developer">developer (OpenAI)</option>
									</select>
								)}
							</FieldOf>
							<FieldOf label="Answer length goes in">
								{(id) => (
									<select
										id={id}
										className={SELECT}
										value={compat.maxTokensField}
										onChange={(event) =>
											setCompat((was) => ({
												...was,
												maxTokensField: event.target.value as "max_tokens" | "max_completion_tokens",
											}))
										}
									>
										<option value="max_tokens">max_tokens</option>
										<option value="max_completion_tokens">max_completion_tokens (OpenAI)</option>
									</select>
								)}
							</FieldOf>
						</div>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
						<label className="flex items-center gap-2 text-ui text-ink">
							<Switch checked={compat.store} onCheckedChange={(on) => setCompat((was) => ({ ...was, store: on }))} />
							Send <code className="text-meta">store: false</code>
						</label>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
						<label className="flex items-center gap-2 text-ui text-ink">
							<Switch
								checked={compat.reasoningEffort}
								onCheckedChange={(on) => setCompat((was) => ({ ...was, reasoningEffort: on }))}
							/>
							Send <code className="text-meta">reasoning_effort</code> to a thinking model
						</label>
					</CollapsibleContent>
				</Collapsible>
			) : null}

			{refused === undefined ? null : (
				<p role="alert" className="text-ui break-words text-danger">
					{refused}
				</p>
			)}
			{tried && problems.length > 0 ? (
				<p role="alert" className="text-meta text-danger">
					{problems.length === 1 ? "One thing to fix above." : `${problems.length} things to fix above.`}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				{onRemove === undefined || initial === undefined ? null : (
					<Confirm
						title={`Remove ${initial.name}?`}
						body="Its models and its key are forgotten. If the band or an agent still runs on it, banda says what to move first."
						action="Remove"
						keep="Keep it"
						onConfirm={() => {
							setRemoving(true);
							setRefused(undefined);
							void onRemove().then((why) => {
								setRemoving(false);
								setRefused(why);
							});
						}}
					>
						<Button type="button" variant="destructive" size="sm" disabled={removing}>
							<Trash2Icon />
							Remove server
						</Button>
					</Confirm>
				)}
				<span className="ml-auto flex gap-2">
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="submit" disabled={busy}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Save
					</Button>
				</span>
			</div>
		</form>
	);
}
