import { type AssistantMessage, fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, LiveState, SubmissionId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { Block, LiveEvent } from "../src/server/api.ts";
import { follow } from "../src/server/transcript.ts";

const answer = (content: AssistantMessage["content"]) =>
	({ ...fauxAssistantMessage(""), content, stopReason: "stop" }) as AssistantMessage;
const text = (t: string) => ({ type: "text", text: t }) as const;

const entry = (id: number, message: AssistantMessage | { role: "user"; content: string; timestamp: number }) =>
	({ id, conversationId: 1, kind: "pi.message", model: [message] }) as unknown as EntryRecord;
const user = (id: number, said: string) => entry(id, { role: "user", content: said, timestamp: 1 });

const view = (entries: EntryRecord[], live: LiveState, before?: number) =>
	({
		conversation: {},
		entries,
		...(before === undefined ? {} : { before }),
		docs: { "pi.live": live },
	}) as unknown as ConversationView;

const run = (task: number, inputs: number[] = [7]) =>
	({ taskId: task, inputs: inputs as unknown as SubmissionId[], turns: 0 }) as LiveState["run"];
const generating = (message: AssistantMessage) =>
	({ attempt: 1, message: message as unknown }) as LiveState["generation"];

/** What the web keeps of the answer being generated (web/src/lib/transcript.ts), applied to the events in order. */
function client() {
	let partial: Block[] = [];
	const apply = (event: LiveEvent) => {
		if (event.type === "ready" || event.type === "start") partial = [...event.partial];
		else if (event.type === "entry" && event.item.role === "assistant") partial = [];
		else if (event.type === "delta") {
			const block = partial[event.index] ?? { type: "text", text: "" };
			partial[event.index] = { ...block, text: block.text + event.text };
		} else if (event.type === "busy" && !event.busy) partial = [];
	};
	return { apply, partial: () => partial };
}

function following() {
	const events: LiveEvent[] = [];
	const shown = client();
	const f = follow(
		(event) => {
			events.push(event);
			shown.apply(event);
		},
		async (inputs) => (inputs?.[0] === undefined ? undefined : 100 + Number(inputs[0])),
		() => 1000,
	);
	return { ...f, events, shown };
}

describe("a chat's live events, from its views", () => {
	it("say an answer's entry before the next answer's blocks, when one view carries both", async () => {
		const f = following();
		await f.ready(view([user(1, "hi")], { run: run(10), generation: generating(answer([text("Hel")])) }));
		f.events.length = 0;
		// one view: the first answer was stored, and the next one has begun with a thought and some words
		const next = answer([fauxThinking("plan"), text("Wor")]);
		await f.next(
			view([user(1, "hi"), entry(2, answer([text("Hello")]))], { run: run(10), generation: generating(next) }),
		);
		const types = f.events.map((event) => event.type);
		expect(types.indexOf("entry")).toBeLessThan(types.indexOf("start"));
		expect(f.shown.partial().map((block) => [block.type, block.text])).toEqual([
			["thinking", "plan"],
			["text", "Wor"],
		]);
		await f.next(
			view([user(1, "hi"), entry(2, answer([text("Hello")]))], {
				run: run(10),
				generation: generating(answer([fauxThinking("plan"), text("World")])),
			}),
		);
		expect(f.events.at(-1)).toEqual({ type: "delta", index: 1, text: "ld" });
		expect(f.shown.partial().map((block) => [block.type, block.text])).toEqual([
			["thinking", "plan"],
			["text", "World"],
		]);
	});

	it("say it whole again when entries past the tail left the window unread, for the client to fetch them", async () => {
		const f = following();
		await f.ready(view([user(1, "a"), user(2, "b"), user(3, "c")], {}));
		expect(f.events[0]).toMatchObject({ type: "ready", tail: 3 });
		f.events.length = 0;
		// more were appended than the window keeps: it starts after entry 60, so 4 to 60 were never seen
		const window = Array.from({ length: 50 }, (_, n) => user(61 + n, `m${61 + n}`));
		expect(await f.next(view(window, {}, 60))).toBe("ready");
		expect(f.events).toEqual([{ type: "ready", tail: 110, busy: false, partial: [], running: [] }]);
		// a window that starts at what was seen is not a gap
		f.events.length = 0;
		expect(await f.next(view([...window, user(111, "n")], {}, 60))).toBeUndefined();
		expect(f.events).toMatchObject([{ type: "entry", item: { id: 111 } }]);
	});

	it("say busy once per run, not per tool round, and idle after the run's last entry", async () => {
		const f = following();
		await f.ready(view([user(1, "go")], {}));
		f.events.length = 0;
		await f.next(view([user(1, "go")], { run: run(10) }));
		expect(f.events).toEqual([{ type: "busy", busy: true, input: 107 }]);
		f.events.length = 0;
		// the run hands over to the next round's task: the same run
		await f.next(view([user(1, "go")], { run: run(11) }));
		expect(f.events).toEqual([]);
		await f.next(view([user(1, "go"), entry(2, answer([text("done")]))], {}));
		expect(f.events.map((event) => event.type)).toEqual(["entry", "busy"]);
	});

	it("say a call ended before its result entry", async () => {
		const f = following();
		const slot = { callId: "c1", name: "bash", status: "running" as const, output: "o" };
		await f.ready(view([user(1, "go")], { run: run(10), tools: [slot] }));
		f.events.length = 0;
		await f.next(view([user(1, "go")], { run: run(10), tools: [{ ...slot, output: "out" }] }));
		expect(f.events).toEqual([{ type: "output", call: "c1", append: "ut" }]);
		f.events.length = 0;
		const result = {
			id: 2,
			conversationId: 1,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [text("out")],
					isError: false,
					timestamp: 1,
				},
			],
		} as unknown as EntryRecord;
		await f.next(view([user(1, "go"), result], { run: run(10), tools: [{ ...slot, status: "done" }] }));
		const types = f.events.map((event) => event.type);
		expect(types[0]).toBe("toolEnd");
	});
});
