/**
 * Provider connections live in auth/, outside the store and the box. The app only sees status and OAuth links.
 *
 * A provider can also be configured from outside banda, by an ambient credential: ANTHROPIC_API_KEY and its kind, an
 * AWS profile, an ADC file. Those count as connected, since the band can think with them, but they are marked
 * `ambient` with the `source` pi-ai names them by: the owner did not connect them here, signing out cannot remove
 * them, and nothing has tried them, so the app offers to connect over them rather than calling them good.
 *
 * A sign-in is one attempt per provider, held in memory and ended through pi-ai's own signal: the latest attempt
 * replaces an earlier one, the owner may cancel it, it times out, and the daemon stopping ends it. Ending it closes
 * what the provider's flow opened (a loopback callback server among them), so nothing outlives the attempt.
 */
import type { AuthPrompt } from "@earendil-works/pi-ai";
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
const supported = [...new Set(PRESETS.map((preset) => preset.provider).filter((id) => id !== "openai-codex"))];

/**
 * pi-ai's label for a key it holds for the owner; every other api-key source it reports names where it found one
 * instead ("ANTHROPIC_API_KEY", "~/.aws/credentials"). A sign-in is told by its type, so this is the only label the
 * app leans on; `test/provider-ambient.test.ts` fails loudly if a pi-ai upgrade renames it.
 */
const CONNECTED_HERE = "stored credential";

async function view(deps: Deps, pending: ReadonlyMap<string, Attempt>, failures: ReadonlyMap<string, string>) {
	return (
		await Promise.all(
			supported.flatMap(async (id) => {
				const provider = deps.models.getProvider(id);
				if (provider === undefined) return [];
				const auth = provider.auth;
				const check = await deps.models.checkAuth(id).then(
					(result) => result,
					() => undefined,
				);
				const connected = check !== undefined;
				// pi-ai reports a credential it found, never one it tried: an ambient key (ANTHROPIC_API_KEY and its
				// kind) is nobody's doing here, cannot be signed out of, and is as likely stale as good. Saying only
				// "connected" leaves a dead key looking right and hides the sign-in that would replace it, so the app
				// is told where this one came from and keeps offering to connect.
				const ambient = connected && check?.type !== "oauth" && check?.source !== CONNECTED_HERE;
				const attempt = pending.get(id);
				return [
					{
						id,
						name: provider.name,
						apiKey: auth.apiKey?.login !== undefined,
						oauth: auth.oauth !== undefined,
						connected,
						...(ambient ? { ambient: true } : {}),
						...(ambient && check?.source !== undefined ? { source: check.source } : {}),
						connecting: attempt !== undefined,
						...(attempt?.question === undefined ? {} : { question: attempt.question }),
						...(attempt?.methods === undefined ? {} : { methods: attempt.methods }),
						...(attempt?.method === undefined ? {} : { method: attempt.method }),
						...(failures.get(id) === undefined ? {} : { error: failures.get(id) }),
					},
				];
			}),
		)
	).flat();
}

export function providersArea(options: { readonly timeoutMs?: number } = {}): AreaModule {
	const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
	return {
		start: (deps) => {
			const pending = new Map<string, Attempt>();
			const failures = new Map<string, string>();
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
			const connect = async (id: string, body: Record<string, unknown>) => {
				const provider = deps.models.getProvider(id);
				if (provider === undefined || !supported.includes(id))
					throw new BadRequest("that provider is not available in banda");
				const type = body.type;
				if (type !== "api_key" && type !== "oauth") throw new BadRequest("type is api_key or oauth");
				if (type === "api_key" && provider.auth.apiKey?.login === undefined)
					throw new BadRequest(`${provider.name} does not take a key here`);
				if (type === "oauth" && provider.auth.oauth === undefined)
					throw new BadRequest(`${provider.name} does not support sign-in`);
				const key = body.key;
				if (type === "api_key" && (typeof key !== "string" || key === "")) throw new BadRequest("key is required");
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
			return {
				route: async (request) => {
					if (request.path === "/providers" && request.method === "GET")
						return { body: await view(deps, pending, failures) };
					const matched = /^\/providers\/([^/]+)(?:\/(answer|sign-in))?$/.exec(request.path);
					if (matched === null) return undefined;
					const id = decodeURIComponent(matched[1] ?? "");
					if (request.method === "DELETE" && matched[2] === "sign-in") {
						await end(id, "the sign-in was cancelled");
						failures.delete(id);
						deps.changed();
						return { body: {} };
					}
					if (request.method === "DELETE" && matched[2] === undefined) {
						await end(id, "signed out");
						await deps.models.logout(id);
						await leaveProvider(deps, id);
						failures.delete(id);
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
