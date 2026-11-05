/** Provider connections live in auth/, outside the store and the box. The app only sees status and OAuth links. */
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { PRESETS } from "../../core/tiers.ts";
import { deviceId } from "../../home.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule, Deps } from "./area.ts";
import { leaveProvider, selectConnectedProvider } from "./tiers.ts";

type Pending = { url?: string; answer?: (value: string) => void };
const supported = [...new Set(PRESETS.map((preset) => preset.provider).filter((id) => id !== "openai-codex"))];

async function view(deps: Deps, pending: ReadonlyMap<string, Pending>, failures: ReadonlyMap<string, string>) {
	return (
		await Promise.all(
			supported.flatMap(async (id) => {
				const provider = deps.models.getProvider(id);
				if (provider === undefined) return [];
				const auth = provider.auth;
				const connected = await deps.models.checkAuth(id).then(
					(result) => result !== undefined,
					() => false,
				);
				return [
					{
						id,
						name: provider.name,
						apiKey: auth.apiKey?.login !== undefined,
						oauth: auth.oauth !== undefined,
						connected,
						connecting: pending.has(id),
						...(failures.get(id) === undefined ? {} : { error: failures.get(id) }),
					},
				];
			}),
		)
	).flat();
}

export const providers: AreaModule = {
	start: (deps) => {
		const pending = new Map<string, Pending>();
		const failures = new Map<string, string>();
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
			if (pending.has(id)) throw new BadRequest(`${provider.name} is already connecting`);
			const key = body.key;
			if (type === "api_key" && (typeof key !== "string" || key === "")) throw new BadRequest("key is required");
			let reveal!: (url: string) => void;
			let fail!: (error: Error) => void;
			const link = new Promise<string>((resolve, reject) => {
				reveal = resolve;
				fail = reject;
			});
			const state: Pending = {};
			pending.set(id, state);
			failures.delete(id);
			const installation = await deviceId(deps.home);
			const prompt = (ask: AuthPrompt) => {
				if (type === "api_key") return Promise.resolve(key as string);
				if (ask.type === "select") return Promise.resolve(ask.options[0]?.id ?? "");
				return new Promise<string>((resolve, reject) => {
					state.answer = resolve;
					ask.signal?.addEventListener("abort", () => reject(new Error("sign-in completed elsewhere")), { once: true });
				});
			};
			const finished = deps.models
				.login(
					id,
					type,
					{
						prompt,
						notify: (event) => {
							if (event.type !== "auth_url") return;
							state.url = event.url;
							reveal(event.url);
						},
					},
					{ getDeviceId: () => installation, agentName: "Sancho" },
				)
				.then(() => selectConnectedProvider(deps, id))
				.then(
					() => {
						pending.delete(id);
						deps.changed();
					},
					(error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						pending.delete(id);
						failures.set(id, message);
						fail(error instanceof Error ? error : new Error(message));
						deps.changed();
					},
				);
			if (type === "api_key") {
				void link.catch(() => undefined);
				await finished;
				return {};
			}
			return { url: await link };
		};
		return {
			route: async (request) => {
				if (request.path === "/providers" && request.method === "GET")
					return { body: await view(deps, pending, failures) };
				const matched = /^\/providers\/([^/]+)(?:\/(answer))?$/.exec(request.path);
				if (matched === null) return undefined;
				const id = decodeURIComponent(matched[1] ?? "");
				if (request.method === "DELETE" && matched[2] === undefined) {
					await deps.models.logout(id);
					await leaveProvider(deps, id);
					pending.delete(id);
					failures.delete(id);
					deps.changed();
					return { body: {} };
				}
				if (request.method !== "POST") return undefined;
				if (matched[2] === "answer") {
					const value = (await request.json()).value;
					if (typeof value !== "string" || pending.get(id)?.answer === undefined)
						throw new BadRequest("there is no sign-in question");
					pending.get(id)?.answer?.(value);
					return { body: {} };
				}
				return { body: await connect(id, await request.json()) };
			},
		};
	},
};
