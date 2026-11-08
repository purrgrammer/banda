/**
 * Slack through the capabilities, against a fake Slack: the sign-in by PKCE names the account by its handle, and a post
 * is a draft on the private floor in the owner's words, its text editable and who it notifies resolved; approving runs
 * it once, as edited; declining runs nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { openConnected } from "./fixtures/connected.ts";
import { answerNudge } from "./fixtures/models.ts";
import { fakeSlack, ROOT_TS } from "./fixtures/slack.ts";
import { tempHome } from "./helpers.ts";

const web = { gateway: "web", peer: OWNER };
const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
beforeEach(() => {
	// a developer's own Slack app registers its own redirects; the shipped one only port 7788's
	process.env.BANDA_SLACK_CLIENT_ID = "dev.slack";
});
afterEach(async () => {
	delete process.env.BANDA_SLACK_CLIENT_ID;
	for (const connected of opened.splice(0)) await connected.close();
});

/** A daemon with Slack shipped and added, whose lead makes `call` once (when given), then says it is done. */
async function connectedWith(call?: { tool: string; args: JsonObject }) {
	const home = await tempHome();
	const shipped = join(home, "shipped");
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "slack.json"),
		readFileSync(new URL("../shipped/connections/slack.json", import.meta.url), "utf8"),
	);
	const slack = fakeSlack();
	const s = await openConnected({
		home,
		shipped,
		fetch: slack.fetch,
		respond: ((ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const heed = answerNudge(ctx.messages);
			if (heed !== undefined) return heed;
			const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
			if (call === undefined || ctx.messages.slice(after).some((m) => m.role === "toolResult"))
				return fauxAssistantMessage("Done.");
			return fauxAssistantMessage([fauxToolCall(`slack__${call.tool}`, call.args, { id: "c1" })], {
				stopReason: "toolUse",
			});
		}) as never,
	});
	opened.push(s);
	await s.capabilities.addShipped("slack");
	return { s, slack };
}

async function signedIn(s: Awaited<ReturnType<typeof openConnected>>, scopes: string[]) {
	const started = await s.capabilities.signIn("slack", context, LEAD, { scopes });
	if (!("url" in started)) throw new Error("a Slack sign-in opens a page");
	const url = new URL(started.url);
	expect(await s.capabilities.callback({ state: url.searchParams.get("state") ?? "", code: "one-use-code" })).toEqual({
		ok: true,
		words: "Signed in to Slack as @ana at Acme.",
	});
	return url;
}

async function run(s: Awaited<ReturnType<typeof openConnected>>) {
	const received = await s.core.receive(s.harness, {
		id: "m1",
		origin: { gateway: "fake", peer: OWNER },
		text: "please",
	});
	if (!("turn" in received)) throw new Error(JSON.stringify(received));
	const turn = received.turn as TaskId<TurnResult>;
	while (true) {
		const open = (await openWaits(s.harness)).find((wait) => wait.ask.type === "approval");
		if (open !== undefined) return { turn, wait: open };
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("Slack through the daemon", () => {
	it("signs in by PKCE with user scopes and names the account by its handle", async () => {
		const { s, slack } = await connectedWith();
		const url = await signedIn(s, [
			"channels:read",
			"search:read",
			"im:read",
			"mpim:read",
			"im:history",
			"mpim:history",
		]);
		expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
		expect(url.searchParams.get("client_id")).toBe("dev.slack");
		expect(url.searchParams.get("user_scope")?.split(",").sort()).toEqual(
			[
				"channels:history",
				"channels:read",
				"groups:history",
				"groups:read",
				"users:read",
				"search:read",
				"im:read",
				"mpim:read",
				"im:history",
				"mpim:history",
			].sort(),
		);
		expect(url.searchParams.has("scope")).toBe(false);
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9/oauth/callback");
		expect(slack.tokenBodies[0]?.has("client_secret")).toBe(false);
		const view = (await s.capabilities.view()).connections.find((each) => each.name === "slack");
		expect(view?.accounts?.map((account) => account.label)).toEqual(["@ana at Acme"]);
	});

	it("refuses to start the shipped app's sign-in on a port Slack did not register, and says which one it takes", async () => {
		delete process.env.BANDA_SLACK_CLIENT_ID;
		const { s } = await connectedWith();
		await expect(s.capabilities.signIn("slack", context, LEAD, {})).rejects.toThrow(
			"Slack signs in only to a banda on port 7788, and this one runs on port 9: start banda with --port 7788 to connect Slack.",
		);
	});

	it("a reply is a draft on the private floor, in the owner's words, its text editable; approved as edited, it posts once", async () => {
		const { s, slack } = await connectedWith({
			tool: "post_message",
			args: { channel: "C0GENERAL", thread_ts: ROOT_TS, text: "<!here> <@U0BOB> I'll look", _channel_name: "ceo-only" },
		});
		await signedIn(s, ["chat:write"]);
		const { turn, wait } = await run(s);
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			tool: "slack__post_message",
			label: "Reply in thread in #general",
			verb: "Send",
			floor: "private",
			editable: ["text"],
			args: {
				channel: "C0GENERAL",
				thread_ts: ROOT_TS,
				text: "<!here> <@U0BOB> I'll look",
				_channel_name: "general",
				_names: { U0BOB: "@bob" },
			},
			on: { refs: ["slack:thread:slack/C0GENERAL/p1700000000.000100", "slack:channel:slack/C0GENERAL"] },
		});
		expect(wait.ask).not.toHaveProperty("permission");
		expect(slack.posts()).toEqual([]);
		await answer(s.harness, wait.key, "approve", web, "bearer", {
			type: "approval",
			approving: { edits: { text: "I'll look after lunch" } },
		});
		await s.harness.waitForTask(turn, context);
		expect(slack.posts()).toEqual([
			{ channel: "C0GENERAL", text: "I'll look after lunch", thread_ts: ROOT_TS, ts: "1700001000.000000" },
		]);
		expect(slack.calls.filter((each) => each.method === "chat.postMessage")).toHaveLength(1);
	});

	it("a declined post sends nothing, and a post to a channel the owner cannot see is refused before it asks", async () => {
		const { s, slack } = await connectedWith({ tool: "post_message", args: { channel: "C0GENERAL", text: "hello" } });
		await signedIn(s, ["chat:write"]);
		const { turn, wait } = await run(s);
		expect(wait.ask).toMatchObject({ label: "Post in #general", verb: "Send" });
		await answer(s.harness, wait.key, "deny", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(slack.posts()).toEqual([]);

		const unseen = await connectedWith({ tool: "post_message", args: { channel: "C0NOPE", text: "hello" } });
		await signedIn(unseen.s, ["chat:write"]);
		const received = await unseen.s.core.receive(unseen.s.harness, {
			id: "m2",
			origin: { gateway: "fake", peer: OWNER },
			text: "please",
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		await unseen.s.harness.waitForTask(received.turn as TaskId<TurnResult>, context);
		expect((await openWaits(unseen.s.harness)).filter((each) => each.ask.type === "approval")).toEqual([]);
		expect(unseen.slack.posts()).toEqual([]);
	});
});
