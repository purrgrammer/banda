/**
 * What Anthropic's prompt cache would do with banda's requests, offline: a real chat on the faux provider gives the
 * contexts, pi-ai's real Anthropic converter turns each into its wire payload (aborted before anything is sent), and
 * `simulate` applies the documented rule to the sequence, in characters.
 */
import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, type Harness, type ModelRef, type TaskId } from "@earendil-works/pi-durable";
import { vi } from "vitest";
import { defineTierSwitch } from "../../src/core/agents.ts";
import { type Origin, OWNER } from "../../src/core/gateway.ts";
import { nowExtension } from "../../src/core/now.ts";
import { context, openStore } from "../../src/core/store.ts";
import { presetOf, TIERS } from "../../src/core/tiers.ts";
import { defineCore, type TurnResult } from "../../src/core/turn.ts";
import { blobStore, FakeGateway, tempHome } from "../helpers.ts";

const ANTHROPIC = presetOf("anthropic");
if (ANTHROPIC === undefined) throw new Error("no Anthropic preset");
export const QUICK = ANTHROPIC.models.quick;
const CONFIGURED: ModelRef = { provider: "anthropic", modelId: ANTHROPIC.models.deep };
const owner = (thread: string): Origin => ({ gateway: "fake", peer: OWNER, thread });

export type Captured = {
	readonly model: string;
	readonly context: { readonly messages: readonly unknown[] };
	readonly options: { readonly reasoning?: string };
};

/** A chat on a faux Anthropic, the status line really installed, that keeps every request it was asked. */
export function fauxChat(clock: () => number = () => 1_800_000_000_000) {
	const requests: Captured[] = [];
	const faux = fauxProvider({
		provider: "anthropic",
		models: [...new Set(TIERS.map((tier) => ANTHROPIC?.models[tier] ?? ""))].map((id) => ({ id })),
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (
		ctx: { messages: readonly { role: string }[] },
		options: { reasoning?: string } | undefined,
		_state: unknown,
		model: { id: string },
	) => {
		requests.push({
			model: model.id,
			context: JSON.parse(JSON.stringify(ctx)),
			options: options?.reasoning === undefined ? {} : { reasoning: options.reasoning },
		});
		if (ctx.messages.at(-1)?.role === "user")
			return fauxAssistantMessage([fauxToolCall("message_user", { text: "on it" })], { stopReason: "toolUse" });
		return fauxAssistantMessage("done");
	};
	faux.setResponses(Array.from({ length: 1000 }, () => respond as never));
	const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => CONFIGURED });
	const open = async (home?: string) => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(defineTierSwitch(() => CONFIGURED).extension);
		registry.install(nowExtension(clock));
		const harness = await openStore(home ?? (await tempHome()), { models, registry });
		harness.resume();
		return harness;
	};
	const say = async (harness: Harness, text: string) => {
		const got = await core.receive(harness, { id: randomUUID(), origin: owner("a"), text });
		if (!("turn" in got)) throw new Error(JSON.stringify(got));
		await harness.waitForTask(got.turn as TaskId<TurnResult>, context);
		return got.chat;
	};
	return { requests, models, open, say };
}

type Block = { readonly type?: string; readonly cache_control?: unknown };
export type Payload = {
	readonly tools?: readonly Block[];
	readonly system?: readonly Block[];
	readonly messages: readonly { readonly role: string; readonly content: string | readonly Block[] }[];
};

/** What pi-ai's real Anthropic converter sends for one captured request. Nothing leaves: it aborts on the payload. */
export async function wirePayload({ model: id, context: ctx, options }: Captured): Promise<Payload> {
	const provider = anthropicProvider();
	const model = provider.getModels().find((candidate) => candidate.id === id);
	if (model === undefined) throw new Error(`no such model: ${id}`);
	const fetched = vi.fn(() => {
		throw new Error("the network was reached");
	});
	vi.stubGlobal("fetch", fetched);
	const abort = new AbortController();
	let payload: Payload | undefined;
	try {
		const stream = provider.streamSimple(model, ctx as never, {
			apiKey: "sk-ant-api-dummy",
			signal: abort.signal,
			maxTokens: 1,
			...(options.reasoning === undefined ? {} : { reasoning: options.reasoning as never }),
			onPayload: (params: unknown) => {
				payload = params as Payload;
				abort.abort();
				return undefined;
			},
		});
		for await (const _event of stream) {
			// drained until the abort ends it
		}
	} finally {
		vi.unstubAllGlobals();
	}
	if (fetched.mock.calls.length > 0) throw new Error("the network was reached");
	if (payload === undefined) throw new Error("the converter never produced a payload");
	return payload;
}

const LOOKBACK = 20;

type Flat = { readonly key: string; readonly chars: number; readonly breakpoint: boolean; readonly status: boolean };

function flatten(payload: Payload): Flat[] {
	const flat: Flat[] = [];
	const push = (section: string, block: Block, status = false) => {
		const { cache_control, ...rest } = block;
		const text = JSON.stringify(rest);
		flat.push({ key: `${section}:${text}`, chars: text.length, breakpoint: cache_control !== undefined, status });
	};
	for (const tool of payload.tools ?? []) push("tools", tool);
	for (const block of payload.system ?? []) push("system", block);
	for (const message of payload.messages) {
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		for (const block of blocks) push(message.role, block, message.role === "system");
	}
	return flat;
}

export type Prediction = {
	readonly read: number;
	readonly written: number;
	readonly uncached: number;
	/** Everything in the request but its mid-conversation system messages: the history a later turn should find. */
	readonly history: number;
};

/**
 * Predicts each request of a sequence: order is tools, system, messages, and a read needs an exact prefix up to a block
 * where an earlier request placed `cache_control`, looked up from each of this request's breakpoints back up to 20
 * blocks. Writes run from the longest read to this request's last breakpoint; what follows it is uncached. No TTL, no
 * minimum length: the sequence is taken to fall within one cache lifetime.
 */
export function simulate(payloads: readonly Payload[]): Prediction[] {
	const cached = new Set<string>();
	return payloads.map((payload) => {
		const blocks = flatten(payload);
		const prefixes: string[] = [];
		for (const [at, block] of blocks.entries()) prefixes.push(`${prefixes[at - 1] ?? ""}\n${block.key}`);
		const breakpoints = blocks.flatMap((block, at) => (block.breakpoint ? [at] : []));
		let hit = -1;
		for (const breakpoint of breakpoints)
			for (let at = breakpoint; at >= Math.max(0, breakpoint - LOOKBACK); at--)
				if (cached.has(prefixes[at] ?? "")) {
					hit = Math.max(hit, at);
					break;
				}
		const last = breakpoints.at(-1) ?? -1;
		const sum = (from: number, to: number) => blocks.slice(from, to).reduce((total, block) => total + block.chars, 0);
		for (const breakpoint of breakpoints) cached.add(prefixes[breakpoint] ?? "");
		return {
			read: sum(0, hit + 1),
			written: sum(hit + 1, last + 1),
			uncached: sum(last + 1, blocks.length),
			history: blocks.reduce((total, block) => total + (block.status ? 0 : block.chars), 0),
		};
	});
}
