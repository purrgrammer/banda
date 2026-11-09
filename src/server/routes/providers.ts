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
import {
	accountSlug,
	backendOf,
	formatAccount,
	isClone,
	MAX_LABEL,
	parseAccount,
} from "../../core/provider-accounts.ts";
import { FileCredentialStore } from "../../core/provider-credentials.ts";
import { PRESETS } from "../../core/tiers.ts";
import { deviceId } from "../../home.ts";
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
const supported = [...new Set(PRESETS.map((preset) => preset.provider).filter((id) => id !== "openai-codex"))];

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
): Promise<{ readonly connected: boolean; readonly ambient?: true; readonly source?: string }> {
	const check = await models.checkAuth(id).then(
		(result) => result,
		() => undefined,
	);
	if (check === undefined) return { connected: false };
	if (check.type === "oauth" || check.source === CONNECTED_HERE) return { connected: true };
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
			supported.flatMap(async (backend) => {
				const provider = deps.models.getProvider(backend);
				if (provider === undefined) return [];
				const auth = provider.auth;
				const accounts = await Promise.all(
					accountsOf(deps.models, backend).map(async (id) => {
						const { connected, ambient, source } = await credentialOf(deps.models, id);
						const attempt = pending.get(id);
						return {
							id,
							label: labels[id] ?? adding.get(id) ?? parseAccount(id).account ?? provider.name,
							connected,
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
				return [
					{
						id: backend,
						name: provider.name,
						apiKey: auth.apiKey?.login !== undefined,
						oauth: auth.oauth !== undefined,
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
				if (provider === undefined || !supported.includes(backendOf(id)))
					throw new BadRequest("that provider is not available in banda");
				const type = body.type;
				if (type !== "api_key" && type !== "oauth") throw new BadRequest("type is api_key or oauth");
				if (type === "api_key" && provider.auth.apiKey?.login === undefined)
					throw new BadRequest(`${provider.name} does not take a key here`);
				if (type === "oauth" && provider.auth.oauth === undefined)
					throw new BadRequest(`${provider.name} does not support sign-in`);
				const key = body.key;
				if (type === "api_key" && (typeof key !== "string" || key === "")) throw new BadRequest("key is required");
				if (type === "api_key") {
					const already = await holding(deps, id, key as string);
					if (already !== undefined) throw new BadRequest(`that key is connected already, as ${already}`, 409);
				}
				const method = typeof body.method === "string" ? body.method : undefined;
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
					if (type === "api_key") return Promise.resolve(key as string);
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
						const label = adding.get(id);
						if (label !== undefined) {
							await store.label(id, label);
							adding.delete(id);
						}
						if (attempt.quiet !== true) await selectConnectedProvider(deps, id);
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
				if (!supported.includes(backend) || deps.models.getProvider(backend) === undefined)
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
						if (deps.models.getProvider(id) === undefined || !supported.includes(backendOf(id)))
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
