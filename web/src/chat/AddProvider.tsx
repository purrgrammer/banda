/**
 * Add a provider: every provider pi-ai supports, searchable, and a server of the owner's by its kind. A built-in one is
 * connected as it signs in (a key, its cloud's own form, or a sign-in in a tab of its own), then its models are shown
 * as pi-ai's catalog has them, said to be a catalog and not the account's; one without banda's preset starts on one
 * model the owner picks, for all three tiers. A server is set up in its own form (`./ServerSetup.tsx`). Saving uses
 * nothing: the last step asks, and only Use changes what the band thinks with.
 */
import { ArrowLeftIcon, ServerIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { SERVER_KINDS, type ServerKind } from "../../../src/core/custom-providers.ts";
import type { FormField, FormMethod } from "../../../src/core/provider-forms.ts";
import type { Connecting, CustomProviderSave, ModelsListView } from "../areas/custom-providers.ts";
import type { ProviderAccountView, ProviderView } from "../areas/tiers.ts";
import { ProviderMark } from "./ProviderMark.tsx";
import { ProviderSignIn } from "./ProviderSignIn.tsx";
import { FieldOf, ServerSetup, tokens } from "./ServerSetup.tsx";

/** What the dialog asks of the daemon; each rejects with why, in words. */
export type AddProviderActions = {
	readonly catalog: (provider: string) => Promise<ModelsListView>;
	readonly refresh: (provider: string) => Promise<ModelsListView>;
	readonly connect: (provider: string, how: Connecting) => Promise<{ url?: string }>;
	/** The provider's accounts as they stand now, to follow a sign-in. */
	readonly providers: () => Promise<readonly ProviderView[]>;
	readonly answer: (provider: string, value: string) => Promise<unknown>;
	readonly cancel: (provider: string) => Promise<unknown>;
	readonly start: (provider: string, model: string) => Promise<unknown>;
	readonly list: NonNullable<ComponentProps<typeof ServerSetup>["list"]>;
	/** Resolves with the new server's id. */
	readonly saveServer: (save: CustomProviderSave) => Promise<string>;
	/** Resolves with why it was refused, or undefined. */
	readonly use: (provider: string) => Promise<string | undefined>;
};

export type Step =
	| { readonly kind: "choose" }
	| { readonly kind: "builtin"; readonly id: string }
	| { readonly kind: "servers" }
	| { readonly kind: "server"; readonly server: ServerKind }
	| { readonly kind: "saved"; readonly id: string; readonly name: string; readonly what: string };

/** How a provider signs in, in a few words. */
export function setupWords(provider: ProviderView): string {
	if (provider.form !== undefined) return "Cloud account";
	if (provider.oauth && provider.apiKey) return "Sign in or API key";
	if (provider.oauth) return "Sign in";
	return "API key";
}

/** What a provider's setup has shown, in words: a sign-in is the provider's yes; a saved key or setting is not. */
const saved = (account: ProviderAccountView) =>
	account.signedIn === true
		? "Signed in."
		: account.ambient === true
			? `Its credential comes from ${account.source ?? "your environment"}, outside banda.`
			: "Its credentials are saved; banda hasn't used them yet.";

/** A price from the catalog, as people read one; none when the catalog has none. */
const priceOf = (cost: { readonly input: number; readonly output: number }) =>
	cost.input === 0 && cost.output === 0
		? "no price in the catalog"
		: `$${cost.input} in · $${cost.output} out per 1M tokens`;

export function AddProvider({
	open,
	onOpenChange,
	onCloseAutoFocus,
	...steps
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus?: (event: Event) => void;
} & Omit<ComponentProps<typeof AddProviderSteps>, "onDone">) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
				{...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
			>
				{open ? <AddProviderSteps {...steps} onDone={() => onOpenChange(false)} dialog /> : null}
			</DialogContent>
		</Dialog>
	);
}

/** The dialog's steps, from the list of every provider to Use; inline in the specimen, in the dialog in the app. */
export function AddProviderSteps({
	providers,
	servers = [],
	here = true,
	actions,
	step: openStep,
	onDone,
	dialog = false,
}: {
	providers: readonly ProviderView[];
	/** The owner's servers' names, which a new one must not repeat. */
	servers?: readonly string[];
	here?: boolean;
	actions: AddProviderActions;
	/** A step shown at first, for the specimen. */
	step?: Step;
	onDone: () => void;
	/** Inside the dialog, whose title and description these are. */
	dialog?: boolean;
}) {
	const [step, setStep] = useState<Step>(openStep ?? { kind: "choose" });
	const provider = step.kind === "builtin" ? providers.find((each) => each.id === step.id) : undefined;
	const title =
		step.kind === "choose"
			? "Add a provider"
			: step.kind === "builtin"
				? (provider?.name ?? "Provider")
				: step.kind === "servers"
					? "A server of your own"
					: step.kind === "server"
						? SERVER_KINDS[step.server].label
						: `${step.name} saved`;
	const description =
		step.kind === "choose"
			? "Every provider banda can think with, and servers of your own."
			: step.kind === "builtin"
				? "Connect it, then pick the model it starts on."
				: step.kind === "servers"
					? "Pick what it runs or speaks: banda reads its models the way that kind documents."
					: step.kind === "server"
						? `${SERVER_KINDS[step.server].about} Saving doesn't contact it.`
						: step.what;
	const Title = dialog ? DialogTitle : "h2";
	const Description = dialog ? DialogDescription : "p";
	return (
		// min-w-0: the dialog lays it out on a grid, where a child is as wide as its widest line unless told otherwise
		<div className="flex min-w-0 flex-col gap-4" data-add-provider={step.kind}>
			<DialogHeaderOrNot dialog={dialog}>
				<span className="flex items-center gap-2 pr-8">
					{step.kind === "builtin" || step.kind === "server" || step.kind === "servers" ? (
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={step.kind === "server" ? "Back to the kinds of server" : "Back to every provider"}
							onClick={() => setStep(step.kind === "server" ? { kind: "servers" } : { kind: "choose" })}
						>
							<ArrowLeftIcon />
						</Button>
					) : null}
					<Title className="min-w-0 text-lg font-medium text-ink">{title}</Title>
				</span>
				<Description className="text-ui text-ink-2">{description}</Description>
			</DialogHeaderOrNot>
			{step.kind === "choose" ? (
				<Choose
					providers={providers}
					onBuiltin={(id) => setStep({ kind: "builtin", id })}
					onServer={(server) => setStep({ kind: "server", server })}
					onServers={() => setStep({ kind: "servers" })}
				/>
			) : step.kind === "servers" ? (
				<ServerKinds onServer={(server) => setStep({ kind: "server", server })} />
			) : step.kind === "builtin" && provider !== undefined ? (
				<BuiltinSetup
					key={provider.id}
					provider={provider}
					here={here}
					actions={actions}
					onSaved={(id, what) => setStep({ kind: "saved", id, name: provider.name, what })}
				/>
			) : step.kind === "server" ? (
				<ServerSetup
					key={step.server}
					kind={step.server}
					here={here}
					others={servers}
					list={actions.list}
					onCancel={() => setStep({ kind: "servers" })}
					onSave={async (save) => {
						try {
							const id = await actions.saveServer(save);
							setStep({
								kind: "saved",
								id,
								name: save.provider.name,
								what: `Saved, with ${save.provider.models.length === 1 ? "1 model" : `${save.provider.models.length} models`}. It starts on ${save.start ?? "its first model"} for every tier.`,
							});
							return undefined;
						} catch (thrown) {
							return thrown instanceof Error ? thrown.message : String(thrown);
						}
					}}
				/>
			) : step.kind === "saved" ? (
				<Saved id={step.id} name={step.name} actions={actions} onDone={onDone} />
			) : null}
		</div>
	);
}

function DialogHeaderOrNot({ dialog, children }: { dialog: boolean; children: ReactNode }) {
	return dialog ? <DialogHeader>{children}</DialogHeader> : <div className="flex flex-col gap-1.5">{children}</div>;
}

/** A kind of server, as the lists show one. */
function KindItem({ kind, onServer }: { kind: ServerKind; onServer: (kind: ServerKind) => void }) {
	return (
		<CommandItem
			value={`server ${SERVER_KINDS[kind].label}`}
			keywords={[kind, "local", "self-hosted", "server"]}
			onSelect={() => onServer(kind)}
		>
			<ServerIcon aria-hidden="true" className="size-4 text-ink-2" />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="break-words">{SERVER_KINDS[kind].label}</span>
				<span className="break-words text-meta text-ink-2">{SERVER_KINDS[kind].about}</span>
			</span>
		</CommandItem>
	);
}

/**
 * Every provider, searchable: pi-ai's first, each with how it signs in, then one way to a server of the owner's. A
 * search reaches the kinds of server too, so "ollama" finds Ollama.
 */
function Choose({
	providers,
	onBuiltin,
	onServer,
	onServers,
}: {
	providers: readonly ProviderView[];
	onBuiltin: (id: string) => void;
	onServer: (kind: ServerKind) => void;
	onServers: () => void;
}) {
	const [search, setSearch] = useState("");
	const searching = search.trim() !== "";
	return (
		<Command className="min-w-0 rounded-panel border border-line-soft" loop>
			<CommandInput
				placeholder="Search providers and servers"
				aria-label="Search providers and servers"
				autoFocus
				value={search}
				onValueChange={setSearch}
			/>
			<CommandList className="max-h-[min(28rem,60dvh)]">
				<CommandEmpty>No provider by that name. A server of your own can be added by its address.</CommandEmpty>
				<CommandGroup heading="Providers">
					{providers.map((provider) => {
						const connected = provider.accounts.some((account) => account.connected);
						return (
							<CommandItem
								key={provider.id}
								value={`provider ${provider.name}`}
								keywords={[provider.id]}
								onSelect={() => onBuiltin(provider.id)}
							>
								<ProviderMark provider={provider.id} />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="break-words">{provider.name}</span>
									<span className="break-words text-meta text-ink-2">
										{setupWords(provider)} · {provider.models === 1 ? "1 model" : `${provider.models} models`}
										{connected ? " · set up" : ""}
									</span>
								</span>
							</CommandItem>
						);
					})}
				</CommandGroup>
				<CommandGroup heading="Your own server">
					{searching ? (
						(Object.keys(SERVER_KINDS) as ServerKind[]).map((kind) => (
							<KindItem key={kind} kind={kind} onServer={onServer} />
						))
					) : (
						<CommandItem value="server of your own" onSelect={onServers}>
							<ServerIcon aria-hidden="true" className="size-4 text-ink-2" />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="break-words">A server of your own</span>
								<span className="break-words text-meta text-ink-2">
									Ollama, LM Studio, llama.cpp, vLLM, or an OpenAI-, Anthropic- or Mistral-compatible API.
								</span>
							</span>
						</CommandItem>
					)}
				</CommandGroup>
			</CommandList>
		</Command>
	);
}

/** The kinds of server, one choice each. */
function ServerKinds({ onServer }: { onServer: (kind: ServerKind) => void }) {
	return (
		<Command className="min-w-0 rounded-panel border border-line-soft" loop>
			<CommandList className="max-h-[min(28rem,60dvh)]">
				<CommandGroup>
					{(Object.keys(SERVER_KINDS) as ServerKind[]).map((kind) => (
						<KindItem key={kind} kind={kind} onServer={onServer} />
					))}
				</CommandGroup>
			</CommandList>
		</Command>
	);
}

/** A built-in provider: connected first if it is not, then the model it starts on. */
function BuiltinSetup({
	provider,
	here,
	actions,
	onSaved,
}: {
	provider: ProviderView;
	here: boolean;
	actions: AddProviderActions;
	onSaved: (id: string, what: string) => void;
}) {
	const [account, setAccount] = useState<ProviderAccountView | undefined>(provider.accounts[0]);
	const connected = account?.connected === true;
	return connected && account !== undefined ? (
		<Models provider={provider} account={account} actions={actions} onSaved={onSaved} />
	) : (
		<Connect provider={provider} here={here} actions={actions} account={account} onAccount={setAccount} />
	);
}

function Connect({
	provider,
	here,
	actions,
	account,
	onAccount,
}: {
	provider: ProviderView;
	here: boolean;
	actions: AddProviderActions;
	account: ProviderAccountView | undefined;
	onAccount: (account: ProviderAccountView | undefined) => void;
}) {
	const form = provider.form;
	const [method, setMethod] = useState<FormMethod | undefined>(form?.methods[0]);
	const [values, setValues] = useState<Record<string, string>>({});
	const [tried, setTried] = useState(false);
	/** What a field still needs, as the daemon would say it, once the owner tried to connect. */
	const needs = (field: FormField): string | undefined => {
		if (!tried || method === undefined) return undefined;
		const empty = (id: string) => (values[id] ?? "").trim() === "";
		if (field.optional !== true) return empty(field.id) ? `${field.label} is needed` : undefined;
		const either = method.fields.filter((each) => each.env !== undefined);
		// one of a pair is needed (Azure's resource or its endpoint): said once, under the first
		return either[0] === field && either.every((each) => empty(each.id))
			? `Give ${either.map((each) => each.label.replace(/^Or /, "").toLowerCase()).join(" or ")}`
			: undefined;
	};
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(account?.error);
	const signing = account?.connecting === true;
	// a sign-in finishes in another tab: follow it until it connects, fails or ends
	useEffect(() => {
		if (!signing) return;
		const timer = setInterval(() => {
			void actions.providers().then(
				(all) => {
					const now = all.find((each) => each.id === provider.id)?.accounts[0];
					if (now === undefined) return;
					onAccount(now);
					if (now.error !== undefined) setError(`${provider.name} didn't finish: ${now.error}`);
				},
				() => {},
			);
		}, 1500);
		return () => clearInterval(timer);
	}, [signing, actions, provider, onAccount]);
	const refreshAccount = async () => {
		const all = await actions.providers();
		onAccount(all.find((each) => each.id === provider.id)?.accounts[0]);
	};
	const connectWith = async (how: Connecting) => {
		setBusy(true);
		setError(undefined);
		try {
			await actions.connect(provider.id, how);
			await refreshAccount();
		} catch (thrown) {
			setError(thrown instanceof Error ? thrown.message : String(thrown));
		} finally {
			setBusy(false);
		}
	};
	const signIn = async () => {
		const tab = window.open("about:blank", "_blank");
		if (tab === null) {
			setError("Your browser blocked the sign-in tab. Allow pop-ups for banda, then try again.");
			return;
		}
		tab.opener = null;
		setBusy(true);
		setError(undefined);
		try {
			const { url } = await actions.connect(provider.id, { type: "oauth" });
			if (url === undefined) throw new Error(`${provider.name} sent no sign-in link. Try again.`);
			tab.location.replace(url);
			await refreshAccount();
		} catch (thrown) {
			tab.close();
			setError(thrown instanceof Error ? thrown.message : String(thrown));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-4">
			{account?.ambient === true ? (
				<p className="text-meta text-ink-2">
					banda already finds a credential for it in {account.source ?? "your environment"}, outside banda. Connect one
					here to use instead.
				</p>
			) : null}
			{form !== undefined ? (
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (method === undefined) return;
						setTried(true);
						const either = method.fields.filter((each) => each.env !== undefined);
						const empty = (id: string) => (values[id] ?? "").trim() === "";
						const missing =
							method.fields.some((field) => field.optional !== true && empty(field.id)) ||
							(either.length > 0 && either.every((each) => empty(each.id)));
						if (missing) return;
						void connectWith({
							type: "api_key",
							...(method.id === undefined ? {} : { method: method.id }),
							fields: values,
						});
					}}
				>
					<p className="text-meta text-ink-2">{form.note}</p>
					{form.methods.length > 1 ? (
						<fieldset className="flex flex-col gap-2">
							<legend className="mb-1 text-meta font-medium text-ink">How banda signs in</legend>
							{form.methods.map((each) => (
								<label key={each.label} className="flex items-start gap-2.5">
									<input
										type="radio"
										name="method"
										className="mt-1 size-4 accent-current"
										checked={method === each}
										onChange={() => setMethod(each)}
									/>
									<span className="flex flex-col">
										<span className="text-ui text-ink">{each.label}</span>
										<span className="text-meta text-ink-2">{each.note}</span>
									</span>
								</label>
							))}
						</fieldset>
					) : (
						<p className="text-meta text-ink-2">{method?.note}</p>
					)}
					{method?.fields.map((field) => (
						<FieldOf
							key={`${method.label}-${field.id}`}
							label={field.optional ? `${field.label} (optional)` : field.label}
							problem={needs(field)}
						>
							{(id) => (
								<Input
									id={id}
									type={field.secret ? "password" : "text"}
									autoComplete="off"
									spellCheck={false}
									placeholder={field.placeholder}
									value={values[field.id] ?? ""}
									onChange={(event) => {
										// what the daemon refused was about what was typed then
										setError(undefined);
										setValues((was) => ({ ...was, [field.id]: event.target.value }));
									}}
								/>
							)}
						</FieldOf>
					))}
					<Button type="submit" className="self-start" disabled={busy}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Connect
					</Button>
				</form>
			) : (
				<div className="flex flex-col gap-3">
					{provider.apiKey ? (
						<form
							className="flex flex-col gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								if (key.trim() !== "") void connectWith({ type: "api_key", key: key.trim() });
							}}
						>
							<FieldOf
								label={`${provider.name} API key`}
								note="Kept on the computer banda runs on, apart from everything else. It's never shown again."
							>
								{(id) => (
									<Input
										id={id}
										type="password"
										autoComplete="off"
										placeholder="Paste it"
										value={key}
										onChange={(event) => {
											setError(undefined);
											setKey(event.target.value);
										}}
									/>
								)}
							</FieldOf>
							<Button type="submit" className="self-start" disabled={busy || key.trim() === ""}>
								{busy && !signing ? <Spinner className="size-3.5" /> : null}
								Connect
							</Button>
						</form>
					) : null}
					{provider.oauth ? (
						here ? (
							<div className="flex flex-col gap-2">
								{provider.apiKey ? <span className="text-meta text-ink-2">Or sign in with your account:</span> : null}
								{signing ? (
									<>
										<span className="flex items-center gap-1.5 text-meta text-ink-2">
											<Spinner className="size-3" /> Finish signing in in the other tab…
										</span>
										<ProviderSignIn
											provider={provider}
											asks={account?.question !== undefined}
											ways={account?.methods}
											way={account?.method}
											onAnswer={(id, value) => void actions.answer(id, value).then(refreshAccount)}
											onWay={(id, way) => void actions.connect(id, { type: "oauth", method: way }).then(refreshAccount)}
											onCancel={(id) => void actions.cancel(id).then(refreshAccount)}
										/>
									</>
								) : (
									<Button variant="outline" className="self-start" disabled={busy} onClick={() => void signIn()}>
										Sign in with {provider.name}
									</Button>
								)}
							</div>
						) : (
							<p className="text-meta text-ink-2">
								Signing in to {provider.name} comes back to the computer banda runs on: do it there.
							</p>
						)
					) : null}
				</div>
			)}
			{error === undefined ? null : (
				<p role="alert" className="text-ui break-words text-danger">
					{error}
				</p>
			)}
		</div>
	);
}

/** Its models as the catalog has them, and the one it starts on, unless banda has its tiers picked already. */
function Models({
	provider,
	account,
	actions,
	onSaved,
}: {
	provider: ProviderView;
	account: ProviderAccountView;
	actions: AddProviderActions;
	onSaved: (id: string, what: string) => void;
}) {
	const [listing, setListing] = useState<ModelsListView | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [refreshing, setRefreshing] = useState(false);
	const [search, setSearch] = useState("");
	const [start, setStart] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	useEffect(() => {
		void actions
			.catalog(account.id)
			.then(setListing, (thrown: unknown) => setError(thrown instanceof Error ? thrown.message : String(thrown)));
	}, [actions, account.id]);
	const shown = useMemo(() => {
		const needle = search.trim().toLowerCase();
		const all = listing?.models ?? [];
		return needle === ""
			? all
			: all.filter((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
	}, [listing, search]);
	const LIMIT = 60;
	const save = async () => {
		setTried(true);
		if (!provider.presets && start === undefined) return;
		setBusy(true);
		setError(undefined);
		try {
			if (!provider.presets && start !== undefined) await actions.start(account.id, start);
			const name = listing?.models.find((model) => model.id === start)?.name ?? start;
			onSaved(
				account.id,
				provider.presets
					? `${saved(account)} It runs banda's picks for Quick, Balanced and Deep; you can change each later.`
					: `${saved(account)} It starts on ${name} for every tier; you can refine each later.`,
			);
		} catch (thrown) {
			setError(thrown instanceof Error ? thrown.message : String(thrown));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-3">
			<span className="flex items-center gap-2 text-meta text-ink-2">
				<ProviderMark provider={provider.id} />{" "}
				{account.ambient
					? `From ${account.source ?? "your environment"}, outside banda`
					: account.signedIn
						? "Signed in"
						: "Saved. banda hasn't used it yet: the first answer will say whether it works."}
			</span>
			<p className="text-meta text-ink-2">
				{listing?.source === "refreshed"
					? `Listed by ${provider.name} just now, through pi-ai.`
					: "From pi-ai's catalog. Your account may not reach every model, and your plan's prices may differ."}
			</p>
			{provider.refresh === true ? (
				<span className="flex flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={refreshing}
						onClick={() => {
							setRefreshing(true);
							void actions
								.refresh(account.id)
								.then(setListing, (thrown: unknown) =>
									setError(thrown instanceof Error ? thrown.message : String(thrown)),
								)
								.finally(() => setRefreshing(false));
						}}
					>
						{refreshing ? <Spinner className="size-3.5" /> : null}
						Refresh the list
					</Button>
					<span className="text-meta text-ink-2">Asks {provider.name} for its current list. No model runs.</span>
				</span>
			) : null}
			{listing === undefined && error === undefined ? (
				<span className="flex items-center gap-1.5 text-meta text-ink-2">
					<Spinner className="size-3" /> Reading its models…
				</span>
			) : null}
			{listing === undefined ? null : (
				<>
					{listing.models.length > 8 ? (
						<Input
							aria-label="Search its models"
							placeholder={`Search ${listing.models.length} models`}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					) : null}
					{provider.presets ? (
						<p className="text-ui text-ink">
							banda has Quick, Balanced and Deep picked for {provider.name}. You can change each in Settings later.
						</p>
					) : (
						<p className="text-ui text-ink">
							Pick the model it starts on. It runs all three tiers until you refine them.
						</p>
					)}
					<ul
						className="flex max-h-[min(22rem,45dvh)] flex-col divide-y divide-line-soft overflow-y-auto rounded-panel border border-line-soft"
						aria-label={`${provider.name}'s models`}
					>
						{shown.slice(0, LIMIT).map((model) => (
							<li key={model.id}>
								{/* biome-ignore lint/a11y/noLabelWithoutControl: the radio inside is the control, when it has one */}
								<label className={cn("flex items-start gap-2.5 px-3 py-2", !provider.presets && "cursor-pointer")}>
									{provider.presets ? null : (
										<input
											type="radio"
											name="start"
											className="mt-1 size-4 shrink-0 accent-current"
											checked={start === model.id}
											onChange={() => setStart(model.id)}
											aria-label={`Start with ${model.name}`}
										/>
									)}
									<span className="flex min-w-0 flex-col">
										<span className="text-ui break-all text-ink">{model.name}</span>
										<span className="text-meta break-all text-ink-2">
											{model.id} · {tokens(model.contextWindow)} context{model.images ? " · reads images" : ""}
											{model.reasoning ? " · thinks first" : ""}
										</span>
										<span className="text-meta text-ink-2">{priceOf(model.cost)}</span>
									</span>
								</label>
							</li>
						))}
					</ul>
					{shown.length > LIMIT ? (
						<span className="text-meta text-ink-2">
							Showing {LIMIT} of {shown.length}: search to narrow them.
						</span>
					) : null}
				</>
			)}
			{tried && !provider.presets && start === undefined ? (
				<span role="alert" className="text-meta text-danger">
					Pick the model it starts on.
				</span>
			) : null}
			{error === undefined ? null : (
				<p role="alert" className="text-ui break-words text-danger">
					{error}
				</p>
			)}
			<Button className="self-end" disabled={busy || listing === undefined} onClick={() => void save()}>
				{busy ? <Spinner className="size-3.5" /> : null}
				Save
			</Button>
		</div>
	);
}

/** Saved: nothing is used until the owner says so. */
function Saved({
	id,
	name,
	actions,
	onDone,
}: {
	id: string;
	name: string;
	actions: AddProviderActions;
	onDone: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	return (
		<div className="flex flex-col gap-3">
			<p className="text-ui text-ink">
				The band keeps thinking with what it uses now until you pick {name}. Only the provider in use sees what you ask.
			</p>
			{error === undefined ? null : (
				<p role="alert" className="text-ui break-words text-danger">
					{error}
				</p>
			)}
			<span className="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onClick={onDone}>
					Not now
				</Button>
				<Button
					disabled={busy}
					onClick={() => {
						setBusy(true);
						void actions.use(id).then((why) => {
							setBusy(false);
							if (why === undefined) onDone();
							else setError(why);
						});
					}}
				>
					{busy ? <Spinner className="size-3.5" /> : null}
					Use {name}
				</Button>
			</span>
		</div>
	);
}
