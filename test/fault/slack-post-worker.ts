/**
 * The process the Slack write fault suite kills: the owner adds Slack as banda ships it and signs in with "Send messages
 * as you" (or "React as you"); then one owner message whose run replies in a thread (or reacts to its first message),
 * which the owner approves. The fake Slack, in a file of the home, keeps the posts and reactions it took across kills,
 * as the real one would. A post is not idempotent (Slack takes no key), so a run a kill cut short is never repeated
 * unasked: the owner is asked again and skips it. A reaction is, so it runs again unasked. Every step is safe to
 * repeat, as each process does them again from the start. Prints a summary as its last line.
 *
 * argv: home, "react" for a reaction, fault schedule JSON (Fault[])
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { LEAD } from "../../src/core/agents.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import type { TurnResult } from "../../src/core/turn.ts";
import { openConnected } from "../fixtures/connected.ts";
import { answerNudge } from "../fixtures/models.ts";
import { fakeSlack, ROOT_TS } from "../fixtures/slack.ts";
import { type Fault, type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

const [home, ...rest] = process.argv.slice(2) as [string, ...string[]];
const scheduleJson = rest.at(-1) ?? "[]";
const react = rest.slice(0, -1).includes("react");
const faults = new Faults(JSON.parse(scheduleJson) as Fault[]);
// a developer's own app: the fixture's daemon calls back on a port the shipped app did not register
process.env.BANDA_SLACK_CLIENT_ID = "dev.slack";
const shipped = join(home, "shipped");
if (!existsSync(join(shipped, "slack.md"))) {
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "slack.md"),
		readFileSync(new URL("../../shipped/connections/slack.md", import.meta.url), "utf8"),
	);
}
const slack = fakeSlack({ file: join(home, "slack-posts.json"), stable: true });
slack.granted += ",reactions:write";

// the model: after the owner's message, reply in the thread; then done
const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
	faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
	if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
	return fauxAssistantMessage(
		[
			react
				? fauxToolCall("slack__add_reaction", { channel: "C0GENERAL", ts: ROOT_TS, name: "eyes" }, { id: "c1" })
				: fauxToolCall(
						"slack__post_message",
						{ channel: "C0GENERAL", thread_ts: ROOT_TS, text: "I'll look" },
						{ id: "c1" },
					),
		],
		{ stopReason: "toolUse" },
	);
};

const s = await openConnected({
	home,
	shipped,
	fetch: slack.fetch,
	respond: respond as never,
	wrapStorage: (storage) => faults.storage(storage),
	fault: (point) => faults.hit(point as FaultPoint),
});

const shown = async () => (await s.capabilities.view()).connections.find((c) => c.name === "slack");
// what the file says now, allowed, whatever a kill left between writing it and allowing it
const allow = async () => {
	const change = (await shown())?.change;
	if (change !== undefined && "sha" in change && change.sha !== undefined)
		await s.capabilities.acceptConnection("slack", change.sha);
};
if ((await shown())?.accepted === undefined) {
	await allow();
	if ((await shown())?.accepted === undefined) await s.capabilities.addShipped("slack");
}
await allow();
if ((await shown())?.state === "sign-in") {
	const started = await s.capabilities.signIn("slack", context, LEAD, {
		scopes: [react ? "reactions:write" : "chat:write"],
	});
	if (!("url" in started)) throw new Error("a Slack sign-in opens a page");
	const signed = await s.capabilities.callback({
		state: new URL(started.url).searchParams.get("state") ?? "",
		code: "one-use-code",
	});
	if (!signed.ok) throw new Error(signed.words);
}

const received = await s.core.receive(s.harness, {
	id: "m1",
	origin: { gateway: "fake", peer: OWNER },
	text: react ? "react with eyes to that thread" : "reply in that thread saying I'll look",
});
if (!("turn" in received)) throw new Error(`the message started no Turn: ${JSON.stringify(received)}`);
const ended = s.harness.waitForTask(received.turn as TaskId<TurnResult>, context).then(() => true);
const web = { gateway: "web", peer: OWNER };
while (!(await Promise.race([ended, new Promise<false>((r) => setTimeout(r, 10, false))]))) {
	for (const wait of await openWaits(s.harness)) {
		if (wait.ask.type !== "approval") continue;
		faults.hit("answer");
		// a post a kill may have sent is asked again, and the owner skips it
		const again = wait.ask.interrupted === true;
		appendFileSync(join(home, "answers.txt"), `${again ? "asked-again" : "approve"}\n`);
		await ownerAnswer(s.harness, wait.key, again ? "deny" : "approve", web, "bearer", { type: "approval" });
	}
}

const outcome = (await s.harness.getTask(received.turn as TaskId<TurnResult>, context))?.state.outcome;
const { parked } = await status(s.harness);
const answers = readFileSync(join(home, "answers.txt"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean);
console.log(
	JSON.stringify({
		outcome,
		parked,
		answers,
		open: (await openWaits(s.harness)).length,
		posts: slack.posts(),
		reactions: slack.reactions(),
		commits: faults.hits("commit:after"),
		points: Object.fromEntries(
			(["connection:call", "connection:answered", "answer", "model"] as const).map((point) => [
				point,
				faults.hits(point),
			]),
		),
	}),
);
await s.close();
