/**
 * Provider connections live in auth/, outside the store and the box. The app only sees status and OAuth links.
 *
 * A provider can also be configured from outside banda, by an ambient credential: ANTHROPIC_API_KEY and its kind, an
 * AWS profile, an ADC file. Those count as connected, since the band can think with them, but they are marked
 * `ambient` with the `source` pi-ai names them by: the owner did not connect them here, signing out cannot remove
 * them, and nothing has tried them, so the app offers to connect over them rather than calling them good.
 *
 * A backend may have several accounts (`../../core/provider-accounts.ts`): the first is its plain id, another is added
 * with a label the owner types and signs in under an id of its own. An account being added is registered from then on,
 * a failed sign-in included, so the owner sees why and may try again or remove it (it resolves no ambient credential,
 * so it is harmless meanwhile); it outlives the daemon only once a credential is stored for it. Signing out of an
 * account forgets it, label and all.
 *
 * A sign-in is one attempt per account, held in memory and ended through pi-ai's own signal: the latest attempt
 * replaces an earlier one, the owner may cancel it, it times out, and the daemon stopping ends it. Ending it closes
 * what the provider's flow opened (a loopback callback server among them), so nothing outlives the attempt.
 */
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { accountsOf, registerAccount } from "../../core/account-provider.ts";
import { redact } from "../../core/custom-provider.ts";
import { isCustomProvider } from "../../core/custom-providers.ts";
import {
	accountSlug,
	backendOf,
	formatAccount,
	isClone,
	MAX_LABEL,
	parseAccount,
} from "../../core/provider-accounts.ts";
import { FileCredentialStore } from "../../core/provider-credentials.ts";
import { answersOf, PROVIDER_FORMS } from "../../core/provider-forms.ts";
import { PRESETS, presetOf } from "../../core/tiers.ts";
import { deviceId } from "../../home.ts";
import type { ModelsListView } from "../api/custom-providers.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule, Deps } from "./area.ts";
import { leaveProvider, selectConnectedProvider } from "./tiers.ts";

/** How long a sign-in waits for the owner before it ends on its own. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

type Method = { readonly id: string; readonly label: string };
type Attempt = {
	readonly controller: AbortController;
	/** Settles once the attempt has ended, its flow's own cleanup run. */
	ended: Promise<void>;
	/** Why it was ended from outside; a cancelled, replaced or stopped attempt is no failure. */
	quiet?: boolean;
	/** The ways the provider offers to sign in, and the one this attempt takes. */
	methods?: readonly Method[];
	method?: string;
	/** What the flow asks the owner to paste (a code or the address the browser came back to), while it asks. */
	question?: string;
	answer?: (value: string) => void;
};

/** An account the owner is adding: its label, until its credential is stored. */
type Adding = ReadonlyMap<string, string>;
/**
 * pi-ai's providers banda offers: every one built in with chat models, those with presets first in their order, the
 * rest by name. Not OpenAI Codex, which pi-ai keeps as a legacy duplicate of OpenAI's own sign-in; nor the owner's own
 * servers (`./custom-providers.ts`) or an account beyond a backend's first, which are listed with what they belong to.
 */
export function builtIns(models: Deps["models"]): string[] {
	const order = PRESETS.map((preset) => preset.provider);
	return models
		.getProviders()
		.filter(
			(provider) =>
				provider.id !== "openai-codex" &&
				!isCustomProvider(provider.id) &&
				!isClone(provider.id) &&
				provider.getModels().length > 0,
		)
		.sort((a, b) => {
			const [x, y] = [order.indexOf(a.id), order.indexOf(b.id)];
			if (x !== -1 || y !== -1) return (x === -1 ? order.length : x) - (y === -1 ? order.length : y);
			return a.name.localeCompare(b.name);
		})
		.map((provider) => provider.id);
}
const supportedIn = (deps: Deps, backend: string) => builtIns(deps.models).includes(backend);

/**
 * pi-ai's label for a key it holds for the owner; every other api-key source it reports names where it found one
 * instead ("ANTHROPIC_API_KEY", "~/.aws/credentials"). A sign-in is told by its type, so this is the only label the
 * app leans on; `test/provider-ambient.test.ts` fails loudly if a pi-ai upgrade renames it.
 */
const CONNECTED_HERE = "stored credential";

/**
 * The credential provider `id` has, as the app tells it: none, one connected here, or an ambient one with the `source`
 * that set it. pi-ai reports a credential it found, never one it tried: an ambient key (ANTHROPIC_API_KEY and its kind)
 * is nobody's doing here, cannot be signed out of, and is as likely stale as good. Saying only "connected" leaves a
 * dead key looking right and hides the sign-in that would replace it, so the app is told where it came from.
 */
export async function credentialOf(
	models: Deps["models"],
	id: string,
): Promise<{
	readonly connected: boolean;
	readonly ambient?: true;
	readonly source?: string;
	/** A sign-in finished: the provider itself said yes. A key or a cloud's settings is only saved, never tried. */
	readonly signedIn?: true;
}> {
	const check = await models.checkAuth(id).then(
		(result) => result,
		() => undefined,
	);
	if (check === undefined) return { connected: false };
	if (check.type === "oauth") return { connected: true, signedIn: true };
	if (check.source === CONNECTED_HERE) return { connected: true };
	return { connected: true, ambient: true, ...(check.source === undefined ? {} : { source: check.source }) };
}

async function view(
	deps: Deps,
	pending: ReadonlyMap<string, Attempt>,
	failures: ReadonlyMap<string, string>,
	adding: Adding,
) {
	const labels = await new FileCredentialStore(deps.home).labels();
	return (
		await Promise.all(
			builtIns(deps.models).flatMap(async (backend) => {
				const provider = deps.models.getProvider(backend);
				if (provider === undefined) return [];
				const auth = provider.auth;
				const accounts = await Promise.all(
					accountsOf(deps.models, backend).map(async (id) => {
						const { connected, ambient, source, signedIn } = await credentialOf(deps.models, id);
						const attempt = pending.get(id);
						return {
							id,
							label: labels[id] ?? adding.get(id) ?? parseAccount(id).account ?? provider.name,
							connected,
							...(signedIn ? { signedIn } : {}),
							...(ambient ? { ambient } : {}),
							...(source === undefined ? {} : { source }),
							connecting: attempt !== undefined,
							...(attempt?.question === undefined ? {} : { question: attempt.question }),
							...(attempt?.methods === undefined ? {} : { methods: attempt.methods }),
							...(attempt?.method === undefined ? {} : { method: attempt.method }),
							...(failures.get(id) === undefined ? {} : { error: failures.get(id) }),
						};
					}),
				);
				const form = PROVIDER_FORMS[backend];
				return [
					{
						id: backend,
						name: provider.name,
						apiKey: auth.apiKey?.login !== undefined,
						oauth: auth.oauth !== undefined,
						...(form === undefined ? {} : { form }),
						models: provider.getModels().length,
						presets: presetOf(backend) !== undefined,
						...(provider.refreshModels === undefined ? {} : { refresh: true as const }),
						accounts,
					},
				];
			}),
		)
	).flat();
}

/** The label the owner typed, checked: words of their own, unique among the backend's accounts. */
async function labelOf(deps: Deps, backend: string, value: unknown, adding: Adding, except?: string): Promise<string> {
	if (typeof value !== "string" || value.trim() === "") throw new BadRequest("label is the account's name, as text");
	const label = value.trim();
	if (label.length > MAX_LABEL) throw new BadRequest(`label is at most ${MAX_LABEL} characters`);
	const labels = await new FileCredentialStore(deps.home).labels();
	const clash = accountsOf(deps.models, backend).some(
		(id) => id !== except && (labels[id] ?? adding.get(id))?.toLowerCase() === label.toLowerCase(),
	);
	if (clash) throw new BadRequest(`there is an account called ${label} already: name this one differently`);
	return label;
}

/** The label of another account of the same backend that holds `key` already, if any. */
async function holding(deps: Deps, id: string, key: string): Promise<string | undefined> {
	const backend = backendOf(id);
	for (const other of accountsOf(deps.models, backend)) {
		if (other === id || (await deps.models.checkAuth(other).catch(() => undefined))?.type !== "api_key") continue;
		const auth = await deps.models.getAuth(other).catch(() => undefined);
		if (auth?.auth.apiKey === key)
			return (
				(await new FileCredentialStore(deps.home).labels())[other] ??
				parseAccount(other).account ??
				deps.models.getProvider(backend)?.name ??
				backend
			);
	}
	return undefined;
}

/** When each provider's list was last refreshed from the provider itself, in this daemon's life. */
const refreshed = new Map<string, number>();

/**
 * A built-in provider's models as pi-ai lists them, with what pi-ai says of each: a catalog, not a promise that the
 * owner's account reaches every one, nor of a price their plan may change. `refreshed` when the provider's own list
 * (pi-ai's refresh) has been read since the daemon started.
 */
function catalogOf(deps: Deps, id: string): ModelsListView {
	const at = refreshed.get(backendOf(id));
	return {
		source: at === undefined ? "catalog" : "refreshed",
		...(at === undefined ? {} : { at }),
		models: deps.models.getModels(id).map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			images: model.input.includes("image"),
			reasoning: model.reasoning,
			cost: { input: model.cost.input, output: model.cost.output },
		})),
	};
}

export function providersArea(options: { readonly timeoutMs?: number } = {}): AreaModule {
	const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
	return {
		start: (deps) => {
			const pending = new Map<string, Attempt>();
			const failures = new Map<string, string>();
			const adding = new Map<string, string>();
			const store = new FileCredentialStore(deps.home);
			/** End `id`'s attempt, if any, quietly, and wait until its flow has let go of what it opened. */
			const end = async (id: string, why: string) => {
				const attempt = pending.get(id);
				if (attempt === undefined) return;
				attempt.quiet = true;
				pending.delete(id);
				attempt.controller.abort(new Error(why));
				await attempt.ended;
				// the flow's own cleanup (closing its callback server) runs in the promise jobs its abort set off, all
				// done before the next turn of the event loop
				await new Promise((resolve) => setImmediate(resolve));
			};
			/** Forget an account being added that never got a credential: it leaves the view and the models. */
			const drop = (id: string) => {
				if (!adding.has(id)) return;
				adding.delete(id);
				if (isClone(id)) deps.models.deleteProvider(id);
			};
			const connect = async (id: string, body: Record<string, unknown>) => {
				const provider = deps.models.getProvider(id);
				if (provider === undefined || !supportedIn(deps, backendOf(id)))
					throw new BadRequest("that provider is not available in banda");
				const type = body.type;
				if (type !== "api_key" && type !== "oauth") throw new BadRequest("type is api_key or oauth");
				if (type === "api_key" && provider.auth.apiKey?.login === undefined)
					throw new BadRequest(`${provider.name} does not take a key here`);
				if (type === "oauth" && provider.auth.oauth === undefined)
					throw new BadRequest(`${provider.name} does not support sign-in`);
				const method = typeof body.method === "string" ? body.method : undefined;
				// a cloud's form answers its login's prompts in order; any other key login asks for the key alone
				const form = PROVIDER_FORMS[backendOf(id)];
				let answers: string[] = [];
				let settings: Readonly<Record<string, string>> = {};
				let key: string | undefined;
				if (type === "api_key" && form !== undefined) {
					const fields = (typeof body.fields === "object" && body.fields !== null ? body.fields : {}) as Record<
						string,
						unknown
					>;
					const read = answersOf(form, method, fields);
					if ("missing" in read) throw new BadRequest(read.missing);
					answers = [...read.answers];
					settings = read.env;
					key = read.key;
				} else if (type === "api_key") {
					if (typeof body.key !== "string" || body.key === "") throw new BadRequest("key is required");
					key = body.key;
					answers = [key];
				}
				if (type === "api_key" && key !== undefined) {
					const already = await holding(deps, id, key);
					if (already !== undefined) throw new BadRequest(`that key is connected already, as ${already}`, 409);
				}
				// connecting from Add a provider says nothing about using it: the owner picks Use after
				const use = body.use !== false;
				// the latest attempt wins: the earlier one ends, and its callback server with it, before this one binds
				await end(id, "a newer sign-in replaced this one");
				let reveal!: (url: string) => void;
				let fail!: (error: Error) => void;
				const link = new Promise<string>((resolve, reject) => {
					reveal = resolve;
					fail = reject;
				});
				const controller = new AbortController();
				const attempt: Attempt = { controller, ended: Promise.resolve() };
				pending.set(id, attempt);
				failures.delete(id);
				const timer = setTimeout(
					() => controller.abort(new Error(`the sign-in timed out after ${Math.round(timeoutMs / 60_000)} minutes`)),
					timeoutMs,
				);
				// a timer never keeps the daemon alive on its own
				timer.unref();
				const installation = await deviceId(deps.home);
				const prompt = (ask: AuthPrompt) => {
					if (type === "api_key") {
						// a form's chosen method answers the login's choice; its fields, in order, the rest
						if (ask.type === "select") return Promise.resolve(method ?? ask.options[0]?.id ?? "");
						return Promise.resolve(answers.shift() ?? "");
					}
					if (ask.type === "select") {
						attempt.methods = ask.options.map((option) => ({ id: option.id, label: option.label }));
						const chosen = ask.options.find((option) => option.id === method) ?? ask.options[0];
						if (chosen !== undefined) attempt.method = chosen.id;
						return Promise.resolve(chosen?.id ?? "");
					}
					return new Promise<string>((resolve, reject) => {
						attempt.question = ask.message;
						attempt.answer = resolve;
						const asked = () => {
							attempt.question = undefined;
							attempt.answer = undefined;
							reject(new Error("sign-in completed elsewhere"));
						};
						if (ask.signal?.aborted) asked();
						ask.signal?.addEventListener("abort", asked, { once: true });
					});
				};
				const settle = () => {
					clearTimeout(timer);
					if (pending.get(id) === attempt) pending.delete(id);
				};
				attempt.ended = deps.models
					.login(
						id,
						type,
						{
							signal: controller.signal,
							prompt,
							notify: (event) => {
								if (event.type === "auth_url") reveal(event.url);
							},
						},
						{ getDeviceId: () => installation, agentName: "Sancho" },
					)
					.then(async () => {
						settle();
						// a form's settings that are no prompt (Azure's resource) go with the credential, as pi-ai reads them
						if (Object.keys(settings).length > 0)
							await store.modify(id, async (current) =>
								current?.type === "api_key" ? { ...current, env: { ...current.env, ...settings } } : undefined,
							);
						const label = adding.get(id);
						if (label !== undefined) {
							await store.label(id, label);
							adding.delete(id);
						}
						// a provider with presets thinks at once, as first run expects; one without waits for the owner to
						// start it on a model they pick
						if (attempt.quiet !== true && use && presetOf(backendOf(id)) !== undefined)
							await selectConnectedProvider(deps, id);
					})
					.then(
						() => deps.changed(),
						(error: unknown) => {
							settle();
							const message = error instanceof Error ? error.message : String(error);
							if (attempt.quiet !== true) failures.set(id, message);
							fail(error instanceof Error ? error : new Error(message));
							deps.changed();
						},
					);
				if (type === "api_key") {
					void link.catch(() => undefined);
					await attempt.ended;
					return {};
				}
				return { url: await link };
			};
			/**
			 * Add an account to `backend` labelled as the owner says: the plain id while it has no credential at all,
			 * else an id of its own. It signs in as `connect` does.
			 */
			const add = async (backend: string, body: Record<string, unknown>) => {
				if (!supportedIn(deps, backend) || deps.models.getProvider(backend) === undefined)
					throw new BadRequest("that provider is not available in banda");
				const label = await labelOf(deps, backend, body.label, adding);
				const accounts = accountsOf(deps.models, backend);
				const id =
					(await deps.models.checkAuth(backend).catch(() => undefined)) === undefined
						? backend
						: formatAccount({
								provider: backend,
								account: accountSlug(label, new Set(accounts.flatMap((each) => parseAccount(each).account ?? []))),
							});
				if (isClone(id)) registerAccount(deps.models, id);
				adding.set(id, label);
				try {
					return { id, ...(await connect(id, body)) };
				} catch (error) {
					if (!pending.has(id)) drop(id);
					throw error;
				}
			};
			return {
				route: async (request) => {
					if (request.path === "/providers" && request.method === "GET")
						return { body: await view(deps, pending, failures, adding) };
					const listing = /^\/providers\/([^/]+)\/(models|refresh)$/.exec(request.path);
					if (listing !== null) {
						const id = decodeURIComponent(listing[1] ?? "");
						const provider = deps.models.getProvider(id);
						if (provider === undefined || !supportedIn(deps, backendOf(id)))
							throw new BadRequest("that provider is not available in banda", 404);
						if (listing[2] === "models" && request.method === "GET") return { body: catalogOf(deps, id) };
						if (listing[2] === "refresh" && request.method === "POST") {
							if (provider.refreshModels === undefined)
								throw new BadRequest(`${provider.name}'s list is pi-ai's catalog: there is nothing to refresh`);
							if ((await deps.models.checkAuth(id).catch(() => undefined)) === undefined)
								throw new BadRequest(`Connect ${provider.name} first: its list comes with your account`);
							// the provider's own refresh, through pi-ai: a list of models, which runs none
							const { errors } = await deps.models.refresh({ providers: [id], allowNetwork: true, force: true });
							const error = errors.get(id);
							if (error !== undefined)
								throw new BadRequest(`${provider.name} didn't list its models: ${redact(error.message)}`, 502);
							refreshed.set(id, Date.now());
							deps.changed();
							return { body: catalogOf(deps, id) };
						}
						return undefined;
					}
					const matched = /^\/providers\/([^/]+)(?:\/(answer|sign-in|accounts|label))?$/.exec(request.path);
					if (matched === null) return undefined;
					const id = decodeURIComponent(matched[1] ?? "");
					if (request.method === "DELETE" && matched[2] === "sign-in") {
						await end(id, "the sign-in was cancelled");
						failures.delete(id);
						drop(id);
						deps.changed();
						return { body: {} };
					}
					if (request.method === "DELETE" && matched[2] === undefined) {
						await end(id, "signed out");
						await deps.models.logout(id);
						// the label goes with the credential; an account of its own goes from the models too
						await store.delete(id);
						adding.delete(id);
						if (isClone(id)) deps.models.deleteProvider(id);
						await leaveProvider(deps, id);
						failures.delete(id);
						deps.changed();
						return { body: {} };
					}
					if (request.method === "PUT" && matched[2] === "label") {
						if (deps.models.getProvider(id) === undefined || !supportedIn(deps, backendOf(id)))
							throw new BadRequest("there is no such account", 404);
						const label = await labelOf(deps, backendOf(id), (await request.json()).label, adding, id);
						if (adding.has(id)) adding.set(id, label);
						else await store.label(id, label);
						deps.changed();
						return { body: {} };
					}
					if (request.method !== "POST") return undefined;
					if (matched[2] === "answer") {
						const value = (await request.json()).value;
						const answer = pending.get(id)?.answer;
						if (typeof value !== "string" || answer === undefined) throw new BadRequest("there is no sign-in question");
						answer(value);
						return { body: {} };
					}
					if (matched[2] === "accounts") return { body: await add(id, await request.json()) };
					if (matched[2] !== undefined) return undefined;
					return { body: await connect(id, await request.json()) };
				},
				stop: async () => {
					await Promise.all([...pending.keys()].map((id) => end(id, "the daemon is stopping")));
				},
			};
		},
	};
}

export const providers: AreaModule = providersArea();
