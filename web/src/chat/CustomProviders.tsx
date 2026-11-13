/**
 * Settings' custom providers (`src/core/custom-providers.ts`): an address that speaks OpenAI's chat completions, on the
 * computer banda runs on, the owner's network or the internet, with the models they declare and the model each tier
 * runs. Each row says where it sends what the band says; Check is the one way the app reaches it, asked first with the
 * address and the model it will use; saving never does. Removing one the band or an agent still runs on is refused by
 * the daemon, which says what to move first.
 */
import { ChevronDownIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import {
	COMPAT_DEFAULTS,
	type CustomCompat,
	type CustomProvider,
	type Destination,
	destinationOf,
	modelName,
	problemsOf,
} from "../../../src/core/custom-providers.ts";
import { TIER_WORDS, TIERS, type Tier } from "../../../src/core/tiers.ts";
import type { Checked, CustomProviderSave, CustomProviderView } from "../areas/custom-providers.ts";
import { Confirm } from "./Confirm.tsx";
import { Block, RowOf, Rows } from "./Settings.tsx";

/** Where an address sends things, in the owner's words; on a phone, the computer is still banda's, never the phone. */
export function placeWords(destination: Pick<Destination, "place" | "secure">, here: boolean): string {
	if (destination.place === "computer")
		return here ? "On this computer" : "On the computer banda runs on, not this phone";
	if (destination.place === "network") return destination.secure ? "On your network" : "On your network, over http";
	return "On the internet";
}

/** A check's outcome in a line. */
export function checkedWords(checked: Checked): string {
	if (!checked.ok) return `Didn't answer: ${checked.why}`;
	const reply = checked.reply === "" ? "an empty answer" : `“${checked.reply.slice(0, 60)}”`;
	return `Answered in ${checked.ms} ms with ${checked.model}: ${reply}`;
}

const keyWords = (row: CustomProviderView) =>
	row.key === "none" ? "No key" : row.key === "stored" ? "Key saved" : "Needs its key";

/**
 * The custom providers, each with where it sends things and how it stands; Use, Check and Edit; and Add a provider.
 * `form` and `asking` open the form or a check's question at first, for the specimen.
 */
export function CustomProviders({
	view,
	current,
	here = true,
	checking,
	error,
	onAdd,
	onEdit,
	onRemove,
	onUse,
	onCheck,
	form: openForm,
	asking: openAsking,
}: {
	view: { readonly providers: readonly CustomProviderView[]; readonly error?: string } | undefined;
	/** The provider the band thinks with. */
	current: string;
	/** On the computer banda runs on; false on a phone, where localhost is still that computer. */
	here?: boolean;
	/** The provider a check is under way for. */
	checking?: string | undefined;
	error?: string | undefined;
	/** Each resolves with why it was refused, or undefined. */
	onAdd?: ((save: CustomProviderSave) => Promise<string | undefined>) | undefined;
	onEdit?: ((id: string, save: CustomProviderSave) => Promise<string | undefined>) | undefined;
	onRemove?: ((id: string) => Promise<string | undefined>) | undefined;
	onUse?: ((id: string) => void) | undefined;
	onCheck?: ((id: string) => void) | undefined;
	form?: "add" | string | undefined;
	asking?: string | undefined;
}) {
	const [form, setForm] = useState<string | undefined>(openForm);
	const [asking, setAsking] = useState<string | undefined>(openAsking);
	const providers = view?.providers ?? [];
	const editing = form === undefined || form === "add" ? undefined : providers.find((row) => row.id === form);
	const ask = providers.find((row) => row.id === asking);
	const others = (id?: string) => providers.filter((row) => row.id !== id).map((row) => row.name);
	return (
		<Block
			title="Your own providers"
			note="Any address that speaks OpenAI's chat completions: a model on your computer, your network, or a service you pay. It sees what you ask while the band thinks with it."
		>
			<Rows>
				{providers.map((row) => {
					const using = row.id === current;
					const mapped = TIERS.every((tier) => row.models.some((model) => model.id === row.tiers[tier]));
					const ready = row.key !== "missing" && mapped;
					return (
						<div key={row.id} className="flex flex-col" data-custom-provider={row.id}>
							<RowOf
								lead={<ServerIcon aria-hidden="true" className="size-5 shrink-0 text-ink-2" />}
								title={row.name}
								detail={
									<>
										<span className="block truncate">
											{placeWords(row.destination, here)} · {row.destination.host}
										</span>
										<span className="block">
											{using ? "In use · " : ""}
											{keyWords(row)} · {row.models.length === 1 ? "1 model" : `${row.models.length} models`}
											{mapped ? "" : " · No model for each tier yet: edit it"}
										</span>
									</>
								}
								end={
									<span className="flex shrink-0 flex-wrap justify-end gap-1.5">
										{!using && ready ? (
											<Button
												variant="outline"
												size="xs"
												aria-label={`Use ${row.name}`}
												onClick={() => onUse?.(row.id)}
											>
												Use
											</Button>
										) : null}
										<Button
											variant="ghost"
											size="xs"
											aria-label={`Check ${row.name}`}
											disabled={checking === row.id || row.key === "missing"}
											onClick={() => setAsking(row.id)}
										>
											{checking === row.id ? <Spinner className="size-3" /> : null}
											Check
										</Button>
										<Button variant="ghost" size="xs" aria-label={`Edit ${row.name}`} onClick={() => setForm(row.id)}>
											Edit
										</Button>
									</span>
								}
							/>
							{row.checked === undefined || checking === row.id ? null : (
								<p
									role="status"
									className={cn(
										"border-t border-line-soft px-3.5 py-2 pl-[2.875rem] text-meta break-words",
										row.checked.ok ? "text-ink-2" : "text-danger",
									)}
								>
									{checkedWords(row.checked)}
								</p>
							)}
						</div>
					);
				})}
				<RowOf
					className={providers.length === 0 ? "" : "border-t border-line-soft"}
					title={<span className="text-ink-2">{providers.length === 0 ? "None yet" : "Another one"}</span>}
					end={
						<Button variant="ghost" size="xs" aria-label="Add a provider" onClick={() => setForm("add")}>
							<PlusIcon />
							Add a provider
						</Button>
					}
				/>
			</Rows>
			{view?.error === undefined ? null : (
				<p role="alert" className="text-ui text-danger">
					banda could not read your own providers, so none of them can think until this is fixed: {view.error}
				</p>
			)}
			{error === undefined ? null : (
				<p role="alert" className="text-ui text-danger">
					{error}
				</p>
			)}
			<Dialog open={form !== undefined} onOpenChange={(open) => (open ? undefined : setForm(undefined))}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>{editing === undefined ? "Add a provider" : `Edit ${editing.name}`}</DialogTitle>
						<DialogDescription>Saving doesn't contact it. Check it once it's saved, from its row.</DialogDescription>
					</DialogHeader>
					{form === undefined ? null : (
						<CustomProviderForm
							key={form}
							here={here}
							initial={editing}
							others={others(editing?.id)}
							onCancel={() => setForm(undefined)}
							onSave={async (save) => {
								const why = await (editing === undefined ? onAdd?.(save) : onEdit?.(editing.id, save));
								if (why === undefined) setForm(undefined);
								return why;
							}}
							{...(editing === undefined || onRemove === undefined
								? {}
								: {
										onRemove: async () => {
											const why = await onRemove(editing.id);
											if (why === undefined) setForm(undefined);
											return why;
										},
									})}
						/>
					)}
				</DialogContent>
			</Dialog>
			<AlertDialog open={ask !== undefined} onOpenChange={(open) => (open ? undefined : setAsking(undefined))}>
				{ask === undefined ? null : (
					<AlertDialogContent size="sm">
						<AlertDialogHeader>
							<AlertDialogTitle>Check {ask.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								banda sends one short message to {ask.destination.host} (
								{placeWords(ask.destination, here).toLowerCase()}) with{" "}
								{modelName(ask.models.find((model) => model.id === ask.tiers.quick) ?? ask.models[0] ?? { id: "?" })}{" "}
								and waits for its answer. If it charges, this costs a few tokens.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									setAsking(undefined);
									onCheck?.(ask.id);
								}}
							>
								Send the check
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				)}
			</AlertDialog>
		</Block>
	);
}

/** A model as the form holds it: its numbers as typed, and a key of its own the tiers point at. */
type DraftModel = {
	readonly key: number;
	readonly id: string;
	readonly name: string;
	readonly contextWindow: string;
	readonly maxTokens: string;
	readonly images: boolean;
	readonly reasoning: boolean;
	readonly input: string;
	readonly output: string;
};

let nextKey = 1;
const blank = (): DraftModel => ({
	key: nextKey++,
	id: "",
	name: "",
	contextWindow: "32768",
	maxTokens: "4096",
	images: false,
	reasoning: false,
	input: "0",
	output: "0",
});
const numberOf = (text: string) => (text.trim() === "" ? Number.NaN : Number(text.replace(/[,_\s]/g, "")));

/** The definition the form says, for `problemsOf` and the daemon alike. */
function definitionOf(draft: {
	name: string;
	baseUrl: string;
	needsKey: boolean;
	models: readonly DraftModel[];
	compat: Required<CustomCompat>;
}): Omit<CustomProvider, "id"> {
	const compat = Object.fromEntries(
		Object.entries(draft.compat).filter(([key, value]) => COMPAT_DEFAULTS[key as keyof CustomCompat] !== value),
	) as CustomCompat;
	return {
		name: draft.name.trim(),
		baseUrl: draft.baseUrl.trim(),
		key: draft.needsKey ? "required" : "none",
		models: draft.models.map((model) => ({
			id: model.id.trim(),
			...(model.name.trim() === "" ? {} : { name: model.name.trim() }),
			images: model.images,
			reasoning: model.reasoning,
			contextWindow: numberOf(model.contextWindow),
			maxTokens: numberOf(model.maxTokens),
			cost: { input: numberOf(model.input), output: numberOf(model.output) },
		})),
		...(Object.keys(compat).length === 0 ? {} : { compat }),
	};
}

function FieldOf({
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

/**
 * Adding or editing one: its name, its address (where it sends things said as the owner types, without reaching it),
 * its key or none, its models and what each can do, the model of each tier, and how it differs from OpenAI's API.
 */
export function CustomProviderForm({
	initial,
	others = [],
	here = true,
	onSave,
	onCancel,
	onRemove,
}: {
	initial?: CustomProviderView | undefined;
	/** The other custom providers' names: a name is the owner's to tell them apart by. */
	others?: readonly string[];
	here?: boolean;
	onSave?: ((save: CustomProviderSave) => Promise<string | undefined>) | undefined;
	onCancel?: (() => void) | undefined;
	onRemove?: (() => Promise<string | undefined>) | undefined;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [needsKey, setNeedsKey] = useState(initial === undefined ? false : initial.key !== "none");
	const [key, setKey] = useState("");
	const [models, setModels] = useState<readonly DraftModel[]>(() =>
		initial === undefined
			? [blank()]
			: initial.models.map((model) => ({
					key: nextKey++,
					id: model.id,
					name: model.name ?? "",
					contextWindow: String(model.contextWindow),
					maxTokens: String(model.maxTokens),
					images: model.images,
					reasoning: model.reasoning,
					input: String(model.cost.input),
					output: String(model.cost.output),
				})),
	);
	const [tiers, setTiers] = useState<{ [T in Tier]: number | undefined }>(() => {
		const keyOf = (id: string | undefined) => models.find((model) => model.id === id)?.key ?? models[0]?.key;
		return {
			quick: keyOf(initial?.tiers.quick),
			balanced: keyOf(initial?.tiers.balanced),
			deep: keyOf(initial?.tiers.deep),
		};
	});
	const [compat, setCompat] = useState<Required<CustomCompat>>({ ...COMPAT_DEFAULTS, ...initial?.compat });
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [refused, setRefused] = useState<string | undefined>(undefined);
	const [removing, setRemoving] = useState(false);
	const form = useRef<HTMLFormElement>(null);
	const definition = definitionOf({ name, baseUrl, needsKey, models, compat });
	const problems = problemsOf(definition, others);
	const problem = (field: string) => (tried ? problems.find((each) => each.field === field)?.message : undefined);
	const destination = destinationOf(baseUrl);
	const keyStored = initial?.key === "stored";
	const keyProblem =
		tried && needsKey && key.trim() === "" && !keyStored ? "Paste its key, or say it needs none" : undefined;
	const change = (key: number, patch: Partial<DraftModel>) =>
		setModels((all) => all.map((model) => (model.key === key ? { ...model, ...patch } : model)));
	const save = async () => {
		setTried(true);
		setRefused(undefined);
		if (problems.length > 0 || (needsKey && key.trim() === "" && !keyStored)) {
			// the first thing to fix, in view: on a phone the form is taller than the screen
			requestAnimationFrame(() =>
				form.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "center", behavior: "smooth" }),
			);
			return;
		}
		const chosen = {} as { [T in Tier]: string };
		for (const tier of TIERS)
			chosen[tier] = (models.find((model) => model.key === tiers[tier]) ?? models[0])?.id.trim() ?? "";
		setBusy(true);
		const why = await onSave?.({
			provider: definition,
			...(needsKey && key.trim() !== "" ? { key: key.trim() } : {}),
			tiers: chosen,
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
	return (
		<form
			ref={form}
			noValidate
			className="flex flex-col gap-5"
			aria-label={initial === undefined ? "New provider" : `${initial.name}'s settings`}
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
							placeholder="LM Studio on my desk"
							autoComplete="off"
							onChange={(event) => setName(event.target.value)}
						/>
					)}
				</FieldOf>
				<FieldOf
					label="Address"
					problem={
						tried || baseUrl.trim() !== "" ? ("error" in destination ? destination.error : undefined) : undefined
					}
					note={where ?? "Its API's address, up to /v1, such as http://localhost:1234/v1"}
				>
					{(id) => (
						<Input
							id={id}
							value={baseUrl}
							inputMode="url"
							spellCheck={false}
							autoCapitalize="off"
							autoComplete="off"
							placeholder="http://localhost:1234/v1"
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					)}
				</FieldOf>
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-meta font-medium text-ink">Key</legend>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
					<label className="flex items-center gap-3">
						<Switch checked={needsKey} onCheckedChange={setNeedsKey} aria-label="It needs a key" />
						<span className="text-ui text-ink">{needsKey ? "It needs a key" : "It needs no key"}</span>
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
				</fieldset>
			</div>
			<section className="flex flex-col gap-3" aria-label="Models">
				<div className="flex items-baseline justify-between gap-3">
					<h3 className="text-ui font-medium text-ink">Models</h3>
					<span className="text-meta text-ink-2">As the server names them; banda doesn't look them up.</span>
				</div>
				{problem("models") === undefined ? null : (
					<span role="alert" className="text-meta text-danger">
						{problem("models")}
					</span>
				)}
				{models.map((model, n) => (
					<fieldset
						key={model.key}
						aria-label={`Model ${n + 1}`}
						className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-panel border border-line-soft p-3"
					>
						<FieldOf label="Model id" problem={problem(`models.${n}.id`)} className="col-span-2 sm:col-span-1">
							{(id) => (
								<Input
									id={id}
									value={model.id}
									spellCheck={false}
									autoCapitalize="off"
									autoComplete="off"
									placeholder="qwen3-8b"
									onChange={(event) => change(model.key, { id: event.target.value })}
								/>
							)}
						</FieldOf>
						<FieldOf label="Name in banda" problem={problem(`models.${n}.name`)} className="col-span-2 sm:col-span-1">
							{(id) => (
								<Input
									id={id}
									value={model.name}
									maxLength={60}
									placeholder={model.id === "" ? "Optional" : model.id}
									onChange={(event) => change(model.key, { name: event.target.value })}
								/>
							)}
						</FieldOf>
						<FieldOf label="Context, tokens" problem={problem(`models.${n}.contextWindow`)}>
							{(id) => (
								<Input
									id={id}
									inputMode="numeric"
									value={model.contextWindow}
									onChange={(event) => change(model.key, { contextWindow: event.target.value })}
								/>
							)}
						</FieldOf>
						<FieldOf label="Longest answer, tokens" problem={problem(`models.${n}.maxTokens`)}>
							{(id) => (
								<Input
									id={id}
									inputMode="numeric"
									value={model.maxTokens}
									onChange={(event) => change(model.key, { maxTokens: event.target.value })}
								/>
							)}
						</FieldOf>
						<FieldOf label="$ per 1M tokens in" problem={problem(`models.${n}.cost.input`)}>
							{(id) => (
								<Input
									id={id}
									inputMode="decimal"
									value={model.input}
									onChange={(event) => change(model.key, { input: event.target.value })}
								/>
							)}
						</FieldOf>
						<FieldOf label="$ per 1M tokens out" problem={problem(`models.${n}.cost.output`)}>
							{(id) => (
								<Input
									id={id}
									inputMode="decimal"
									value={model.output}
									onChange={(event) => change(model.key, { output: event.target.value })}
								/>
							)}
						</FieldOf>
						<span className="col-span-2 flex flex-wrap items-center gap-x-5 gap-y-2">
							{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
							<label className="flex items-center gap-2 text-ui text-ink">
								<Switch
									checked={model.images}
									onCheckedChange={(on) => change(model.key, { images: on })}
									aria-label={`Model ${n + 1} reads images`}
								/>
								Reads images
							</label>
							{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control */}
							<label className="flex items-center gap-2 text-ui text-ink">
								<Switch
									checked={model.reasoning}
									onCheckedChange={(on) => change(model.key, { reasoning: on })}
									aria-label={`Model ${n + 1} thinks first`}
								/>
								Thinks first
							</label>
							{models.length > 1 ? (
								<Button
									type="button"
									variant="ghost"
									size="xs"
									className="ml-auto"
									aria-label={`Remove model ${n + 1}`}
									onClick={() => {
										setModels((all) => all.filter((each) => each.key !== model.key));
										setTiers((was) => {
											const first = models.find((each) => each.key !== model.key)?.key;
											return {
												quick: was.quick === model.key ? first : was.quick,
												balanced: was.balanced === model.key ? first : was.balanced,
												deep: was.deep === model.key ? first : was.deep,
											};
										});
									}}
								>
									<Trash2Icon />
									Remove
								</Button>
							) : null}
						</span>
					</fieldset>
				))}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="self-start"
					disabled={models.length >= 32}
					onClick={() => setModels((all) => [...all, blank()])}
				>
					<PlusIcon />
					Add a model
				</Button>
			</section>
			<section className="flex flex-col gap-2.5" aria-label="Tiers">
				<div className="flex flex-col">
					<h3 className="text-ui font-medium text-ink">Tiers</h3>
					<span className="text-meta text-ink-2">The model each tier runs. One model may run all three.</span>
				</div>
				<div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
					{TIERS.map((tier) => (
						<FieldOf key={tier} label={TIER_WORDS[tier].name}>
							{(id) => (
								<select
									id={id}
									className={SELECT}
									value={tiers[tier] ?? ""}
									onChange={(event) => setTiers((was) => ({ ...was, [tier]: Number(event.target.value) }))}
								>
									{models.map((model, n) => (
										<option key={model.key} value={model.key}>
											{model.id.trim() === "" ? `Model ${n + 1}` : modelName({ id: model.id.trim(), name: model.name })}
										</option>
									))}
								</select>
							)}
						</FieldOf>
					))}
				</div>
			</section>
			<Collapsible>
				<CollapsibleTrigger asChild>
					<Button type="button" variant="ghost" size="sm" className="group -ml-2 self-start text-ink-2">
						<ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180" />
						Compatibility
					</Button>
				</CollapsibleTrigger>
				<CollapsibleContent className="flex flex-col gap-3 pt-2">
					<span className="text-meta text-ink-2">
						Change these only if it refuses a request. The defaults suit most local servers; not every server works with
						banda.
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
			{refused === undefined ? null : (
				<p role="alert" className="text-ui text-danger break-words">
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
							Remove provider
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
