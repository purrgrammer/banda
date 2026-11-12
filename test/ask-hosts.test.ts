/**
 * `ask_hosts`: an agent asks for several hosts in one approval; approved (as the owner trimmed it), each is a host
 * permission for that agent, which the proxy is told. It offers no scope, so no permission ever covers it.
 */
import { randomUUID } from "node:crypto";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	type Harness,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { ActivityLog } from "../src/core/activity.ts";
import { LEAD } from "../src/core/agents.ts";
import { askHostsTool } from "../src/core/ask-hosts.ts";
import { permittedHosts } from "../src/core/egress.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Permissions } from "../src/core/permissions.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { type Approving, answer } from "../src/core/wait.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome, until } from "./helpers.ts";

const owner = { gateway: "fake", peer: OWNER };
const web = { gateway: "web", peer: OWNER };

/** A model that calls `ask_hosts` with the hosts `say` names, then is done. */
function setup() {
	const gateway = new FakeGateway();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5 });
	let n = 0;
	// the hosts the next owner message asks the model for
	let asked: string[] = [];
	faux.setResponses(
		Array.from({ length: 100 }, () => (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const last = ctx.messages.at(-1);
			n += 1;
			if (last?.role === "user") {
				const hosts = asked;
				return fauxAssistantMessage(
					[fauxToolCall("ask_hosts", { hosts, why: "read and post to my relays" }, { id: `a${n}` })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Done.");
		}) as never,
	);
	const open = async (home: string) => {
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(defineExtension({ name: "effects", tools: [core.effect(askHostsTool())] }));
		const harness = await openStore(home, { models, registry });
		harness.resume();
		return harness;
	};
	const say = async (harness: Harness, hosts: string[]) => {
		asked = hosts;
		const received = await core.receive(harness, {
			id: randomUUID(),
			origin: { ...owner, thread: "t" },
			text: `allow ${JSON.stringify(hosts)}`,
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		return received;
	};
	return { open, say };
}

const done = async (harness: Harness, turn: number) =>
	(await harness.getTask(turn as TaskId, context))?.state.status === "terminal";

const nextAsk = (harness: Harness, turn: number) =>
	until(async () => {
		const [wait] = await openWaits(harness);
		if (wait !== undefined) return { wait };
		return (await done(harness, turn)) ? { wait: undefined } : undefined;
	});

async function results(harness: Harness, chat: number): Promise<string[]> {
	const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
		{ order: "ascending" },
		1000,
		undefined,
		context,
	);
	return page.items
		.filter((e) => e.kind === "pi.tool-result")
		.map((e) =>
			((e.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((p) => p.text).join(""),
		);
}

describe("ask_hosts", () => {
	it("asks once for the list, offers no scope, and allows what the owner left on it", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		try {
			const first = await s.say(harness, ["wss://nos.lol", "*.Damus.io", "nos.lol", "relay.primal.net"]);
			const { wait } = await nextAsk(harness, first.turn);
			// spelled as the proxy reads them, once each; editable; and never a scope to give
			expect(wait?.ask).toMatchObject({
				type: "approval",
				tool: "ask_hosts",
				label: "allow 3 hosts",
				args: { hosts: "nos.lol\n*.damus.io\nrelay.primal.net", why: "read and post to my relays" },
				editable: ["hosts"],
				scopes: [],
			});
			// a permission is refused: none was offered
			const scoped: Approving = { permission: { scope: "always" } };
			expect(await answer(harness, wait!.key, "approve", web, "bearer", { approving: scoped })).toMatchObject({
				refused: expect.any(String),
			});
			// the owner trims the list, then approves
			const trimmed: Approving = { edits: { hosts: "nos.lol\n*.damus.io" } };
			expect(await answer(harness, wait!.key, "approve", web, "bearer", { approving: trimmed })).toMatchObject({
				answered: expect.any(Number),
			});
			await until(() => done(harness, first.turn));
			const stored = Object.values((await harness.snapshot(Permissions, context))!.permissions);
			expect(stored.map((p) => [p.tool, p.match, p.scope, p.agent])).toEqual([
				["propose_send", { _host: "nos.lol" }, "host", LEAD],
				["propose_send", { _host: "*.damus.io" }, "host", LEAD],
			]);
			expect(await permittedHosts(harness)).toEqual({ [String(first.chat)]: ["*.damus.io", "nos.lol"] });
			expect((await results(harness, first.chat)).at(-1)).toContain("The owner allowed nos.lol, *.damus.io");
			// nothing held waited on the owner for them: what was held is run again
			expect((await results(harness, first.chat)).at(-1)).toContain("Run the command again.");
			const events = (await harness.snapshot(ActivityLog, context))!.events.map((e) => e.what);
			expect(events).toContain("You allowed: Sancho may send anything to nos.lol");

			// asking again asks again: nothing covers it
			const again = await s.say(harness, ["relay.primal.net"]);
			expect((await nextAsk(harness, again.turn)).wait?.ask).toMatchObject({ tool: "ask_hosts", scopes: [] });
		} finally {
			await harness.close(context);
		}
	});

	it("refuses what is not a host before asking, and an edit that breaks one allows none", async () => {
		const s = setup();
		const harness = await s.open(await tempHome());
		try {
			const bad = await s.say(harness, ["nos.lol", "example.com/path"]);
			await until(() => done(harness, bad.turn));
			expect((await openWaits(harness)).length).toBe(0);
			expect((await results(harness, bad.chat)).at(-1)).toContain('"example.com/path" is not a host');

			const next = await s.say(harness, ["nos.lol"]);
			const { wait } = await nextAsk(harness, next.turn);
			const broken: Approving = { edits: { hosts: "nos.lol\na.*.example" } };
			await answer(harness, wait!.key, "approve", web, "bearer", { approving: broken });
			await until(() => done(harness, next.turn));
			expect((await results(harness, next.chat)).at(-1)).toContain('"a.*.example" is not a host');
			expect((await harness.snapshot(Permissions, context))?.permissions ?? {}).toEqual({});
		} finally {
			await harness.close(context);
		}
	});
});
