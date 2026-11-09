/**
 * `ask_hosts` (DESIGN.md "The box", Network): an agent asks the owner, in one approval, to allow it several hosts at
 * once (a relay list, an API and its CDN), names or patterns (`*.example.com`, `*`). Approved, each is a host permission
 * for the agent that asked, as if the owner had added it to its Hosts: its writes there, WebSockets included, go
 * straight through. The owner may trim the list before approving. It offers no scope: a permission covering it would let
 * an agent grant itself hosts, so every call asks.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { Harness, JsonObject, ToolExecutionResult, Tx } from "@earendil-works/pi-durable";
import { acceptedAgent, LEAD } from "./agents.ts";
import type { EffectTool } from "./ask.ts";
import { OWNER } from "./gateway.ts";
import { allowedHost } from "./hosts.ts";
import { agentOfChat, allowHostIn } from "./permissions.ts";
import { context } from "./store.ts";
import { answerAsksOfHost, asksHostCovers } from "./wait.ts";

/** The most hosts one ask names. */
export const MAX_ASKED_HOSTS = 32;

const parameters = Type.Object({
	hosts: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: MAX_ASKED_HOSTS,
		description:
			"The hosts to allow: names (relay.example.com), patterns for every name under one (*.example.com), or * for " +
			"every host. A scheme or port only when not https on 443 (ws://, wss://, http:// are read as their HTTP ones).",
	}),
	why: Type.String({ minLength: 1, maxLength: 500, description: "What you need them for, in the owner's words." }),
});

/** The hosts of a draft, one per line, as the owner may have edited them. */
const linesOf = (text: unknown) =>
	String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

/**
 * In a commit: allow `agent` each of `typed`, and answer the held requests already waiting on the owner that they
 * cover. A request has one way out: left waiting, the card would send it again after the agent, now let through, had.
 * Each host's permission id, or why not.
 */
async function allowing(
	tx: Tx,
	agent: string,
	typed: readonly string[],
	now: number,
): Promise<readonly { readonly id: string; readonly host: string }[] | { readonly refused: string }> {
	// reads first: a transaction reads tables only until its first write
	const covers = new Map<string, number[]>();
	for (const one of typed) {
		const host = allowedHost(one);
		if (host !== undefined) covers.set(host, await asksHostCovers(tx, agent, host, now));
	}
	const given = [];
	for (const one of typed) {
		const allowed = await allowHostIn(tx, agent, one, now, 0);
		if ("refused" in allowed) return allowed;
		await answerAsksOfHost(tx, covers.get(allowed.host) ?? [], { gateway: "web", peer: OWNER }, now, allowed.id);
		given.push(allowed);
	}
	return given;
}

/** Allow agent `agent` a host, as the owner directly and not through any ask (`allowing`). */
export async function allowHost(
	harness: Harness,
	agent: string,
	typed: string,
	now: number,
	ctx: Context = context,
): Promise<{ readonly id: string; readonly host: string } | { readonly refused: string }> {
	return harness.commit(async (tx) => {
		if (agent !== LEAD && (await acceptedAgent(tx, agent)) === undefined) return { refused: "no such agent" };
		const given = await allowing(tx, agent, [typed], now);
		return "refused" in given ? given : (given[0] as { id: string; host: string });
	}, ctx);
}

export function askHostsTool(): EffectTool<typeof parameters> {
	return {
		name: "ask_hosts",
		description:
			"Ask the owner to allow you hosts, several at once, before you need them: anything you send there (any method, " +
			"WebSockets included, e.g. Nostr relays or a streaming API) then goes straight through, from any of your " +
			"chats, until the owner takes it back. Reads never need this. Ask for what the task needs: exact names first, " +
			"a pattern (*.example.com) when the names are many under one domain, * only when the owner asked for it.",
		parameters,
		effect: "idempotent",
		describe: (args) => {
			const hosts = linesOf((args as JsonObject).hosts);
			return hosts.length === 1 ? `allow ${hosts[0]}` : `allow ${hosts.length} hosts`;
		},
		editable: ["hosts"],
		// never a scope: a permission over this tool would be one to give itself any host
		permission: { lasts: [] },
		expand: async (args) => {
			const hosts: string[] = [];
			for (const typed of args.hosts) {
				const host = allowedHost(typed);
				if (host === undefined) return `${JSON.stringify(typed)} is not a host`;
				if (!hosts.includes(host)) hosts.push(host);
			}
			return { hosts: hosts.join("\n"), why: args.why };
		},
		run: async (args, { api }, ctx): Promise<ToolExecutionResult> => {
			const chat = Number(api.conversationId);
			const hosts = linesOf((args as JsonObject).hosts);
			const now = api.now();
			// every line a host before any is allowed: an edit that broke one allows none
			const bad = hosts.find((typed) => allowedHost(typed) === undefined);
			if (bad !== undefined)
				return {
					output: [{ type: "text", text: `Not allowed: ${JSON.stringify(bad)} is not a host.` }],
					isError: true,
				};
			const done = await api.commit(async (tx) => {
				const agent = await agentOfChat(tx, chat);
				if (agent === undefined) return "this chat runs no agent a host could be allowed for";
				if (hosts.length === 0) return "the owner left no host on the list";
				const given = await allowing(tx, agent, hosts, now);
				return "refused" in given ? given.refused : given.map((one) => one.host);
			}, ctx);
			if (typeof done === "string") return { output: [{ type: "text", text: `Not allowed: ${done}.` }], isError: true };
			return {
				output: [
					{
						type: "text",
						text:
							`The owner allowed ${done.join(", ")}: what you send there now goes straight through, ` +
							"WebSockets included. A request already held for one of them is being sent now, and you will be told how " +
							"it ended: do not send that one again. Run again only what was not held.",
					},
				],
			};
		},
	};
}
