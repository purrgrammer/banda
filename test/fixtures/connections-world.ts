/**
 * The world the connections tests share: a daemon core over a temp home with a fake MCP server, a scripted model,
 * and what a test opened, closed after it (`closeAll`).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { OWNER } from "../../src/core/gateway.ts";
import { context } from "../../src/core/store.ts";
import { toolDiscoveryExtension, toolRegistry, toolSearchExtension } from "../../src/core/tool-discovery.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { tempHome } from "../helpers.ts";
import { type Connected as Opened, openConnected } from "./connected.ts";
import type { FakeMcp } from "./mcp-server.ts";

export const opened: Opened[] = [];
export const fakes: FakeMcp[] = [];

/** Close what a test opened: run after each test that uses `open` or a fake. */
export async function closeAll(): Promise<void> {
	for (const s of opened.splice(0)) await s.close();
	for (const fake of fakes.splice(0)) await fake.close();
}

export const web = { gateway: "web", peer: OWNER };

/** A model that makes the calls a script names, one round each, then ends the run; and every request it was sent. */
export function scripted() {
	const queue: AssistantMessage[][] = [];
	const requests: ModelContext[] = [];
	let n = 0;
	const respond = (request: ModelContext) => {
		requests.push(request);
		const last = request.messages.at(-1);
		// told it ended without answering the owner: it ends again, taking nothing queued for the next message
		if (last?.role === "user" && String(last.content).startsWith("You ended your turn without answering"))
			return fauxAssistantMessage("Done.");
		// a run answers the owner's message with the next round queued for it, and ends after its results
		if (last?.role === "toolResult") {
			const next = queue[0]?.shift();
			if (next !== undefined) return next;
			queue.shift();
			return fauxAssistantMessage("Done.");
		}
		const next = queue[0]?.shift();
		return next ?? fauxAssistantMessage("Done.");
	};
	/** The rounds the next owner message's run makes: each a list of tool calls. */
	const plan = (...rounds: { tool: string; args?: Record<string, unknown> }[][]) =>
		queue.push(
			rounds.map((calls) =>
				fauxAssistantMessage(
					calls.map((call) => fauxToolCall(call.tool, (call.args ?? {}) as never, { id: `c${++n}` })),
					{ stopReason: "toolUse" },
				),
			),
		);
	return { respond, plan, requests };
}

export async function open(fake?: FakeMcp, shipped?: string, discovery = false, fetcher?: typeof fetch) {
	const home = await tempHome();
	const model = scripted();
	const registry = discovery ? toolRegistry() : undefined;
	registry?.install(toolSearchExtension);
	registry?.install(toolDiscoveryExtension);
	const s = await openConnected({
		...(registry === undefined ? {} : { registry }),
		home,
		respond: model.respond as never,
		...(shipped === undefined ? {} : { shipped }),
		...(fetcher === undefined ? {} : { fetch: fetcher }),
	});
	opened.push(s);
	const say = async (text: string) => {
		const received = await s.core.receive(s.harness, {
			id: crypto.randomUUID(),
			origin: { gateway: "fake", peer: OWNER },
			text,
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		return received;
	};
	const done = (turn: number) => s.harness.waitForTask(turn as TaskId<TurnResult>, context);
	const results = async (chat: number) => {
		const page = await (await s.harness.conversation(chat as ConversationId, context))!.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		return page.items
			.filter((e) => e.kind === "pi.tool-result")
			.map((e) => {
				const m = e.model?.[0] as { content: { text?: string }[]; isError?: boolean; toolName?: string };
				const diagnostics = (e.data as { diagnostics?: { code?: string; message: string }[] } | undefined)?.diagnostics;
				const notes = (diagnostics ?? []).flatMap((d) => (d.code === "awaits-acceptance" ? [d.message] : []));
				return {
					text: m.content.map((c) => c.text ?? "").join(""),
					error: m.isError === true,
					...(notes.length === 0 ? {} : { notes }),
				};
			});
	};
	const writeBox = (path: string, text: string) => writeFileSync(join(s.box.workspace, path), text);
	return { ...s, model, say, done, results, writeBox, fake };
}

/** The owner allowing `tools` as reads on connection `name`, at the version they saw (their latest, unless said). */
export const allowReads = async (
	s: Awaited<ReturnType<typeof open>>,
	name: string,
	tools: readonly string[],
	version?: string,
) => {
	const seen = version ?? (await s.capabilities.view()).connections.find((c) => c.name === name)?.accepted?.version;
	await s.capabilities.setTools(name, Object.fromEntries(tools.map((tool) => [tool, "allow"])), seen);
};
