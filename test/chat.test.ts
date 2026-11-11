import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Item, ShownWait } from "../src/server/api.ts";
import { argList, failureWords, type Live, type Segment, shown, view } from "../web/src/lib/chat.ts";
import { pbtRuns } from "./pbt.ts";

const IDLE: Live = { busy: false, running: [], thinking: false };
const owner = { gateway: "web", peer: "owner" };

const user = (id: number, text: string, extra: Partial<Extract<Item, { role: "user" }>> = {}): Item => ({
	id,
	role: "user",
	text,
	...extra,
});
const said = (id: number, calls: { id: string; name: string; args: Record<string, unknown> }[], text = ""): Item => ({
	id,
	role: "assistant",
	text,
	calls,
});
const result = (id: number, call: string, text: string, error = false): Item => ({
	id,
	role: "tool",
	call,
	name: "message_user",
	text,
	error,
});

const kinds = (segments: Segment[]) => segments.map((s) => s.kind);

describe("the chat, derived", () => {
	it("shows provider failures without requiring the raw transcript", () => {
		const segments = view(
			[user(1, "Hello"), { id: 2, role: "assistant", text: "", error: "provider has no valid key" }],
			[],
			IDLE,
		);
		expect(segments.at(-1)).toMatchObject({
			kind: "notice",
			key: "2:error",
			text: "Couldn't get a reply: provider has no valid key",
		});
		expect(
			view(
				[
					{
						id: 4,
						role: "assistant",
						text: "",
						error: "OpenAI Responses stream ended before a terminal response event",
					},
				],
				[],
				IDLE,
			),
		).toMatchObject([{ kind: "notice", text: "Couldn't get a reply: the connection to the model dropped." }]);
		// a provider's raw body is never shown: a refused key says what to do, anything else its message alone
		const google = `{"error":{"message":"{\\n \\"error\\": {\\n \\"code\\": 400,\\n \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n \\"status\\": \\"INVALID_ARGUMENT\\"}}","code":400}}`;
		expect(failureWords(google)).toBe(
			"the model provider refused its key. Sign in again or change the key in Settings.",
		);
		expect(failureWords('{"error":{"message":"model gpt-9 does not exist","code":404}}')).toBe(
			"model gpt-9 does not exist",
		);
		expect(failureWords('{"error":{"code":500}}')).toBe("the model provider sent an error it did not explain.");
		expect(view([{ id: 3, role: "assistant", text: "", error: "interrupted" }], [], IDLE)).toEqual([
			{ kind: "notice", key: "3:stopped", text: "Stopped" },
		]);
	});
	it("the owner's words and the companion's messages, in order; notes, results and relays are not shown", () => {
		const items: Item[] = [
			user(1, "plan my week", { origin: owner }),
			{
				...(said(2, [{ id: "c1", name: "message_user", args: { text: "On it." } }], "notes to self") as Extract<
					Item,
					{ role: "assistant" }
				>),
				thinking: "hmm",
			},
			result(3, "c1", "Sent."),
			said(4, [{ id: "c2", name: "bash", args: { command: "ls" } }]),
			{ id: 5, role: "tool", call: "c2", name: "bash", text: "a b", error: false },
			said(7, [
				{
					id: "c3",
					name: "message_user",
					args: { text: "Here it is.", files: ["/workspace/out/week.pdf", "chart.png"] },
				},
			]),
			result(8, "c3", "Sent, with: …"),
			said(9, [], "sent: done"),
		];
		const segments = view(items, [], IDLE);
		expect(kinds(segments)).toEqual(["owner-message", "companion", "companion"]);
		expect(segments[1]).toMatchObject({ text: "On it.", undelivered: false });
		expect(segments[2]).toMatchObject({
			files: [
				{ kind: "sent", name: "week.pdf", call: "c3", n: 0, image: false, ready: true },
				{ kind: "sent", name: "chart.png", call: "c3", n: 1, image: true, ready: true },
			],
		});
	});

	it("the owner's files by blob, and images that came without a file by item", () => {
		const sha = "a".repeat(64);
		const [withFile, withImage] = view(
			[
				user(1, "see", { files: [{ sha, name: "a.png", mimeType: "image/png", size: 3 }], images: 1 }),
				user(2, "x", { images: 2 }),
			],
			[],
			IDLE,
		);
		expect(withFile).toMatchObject({ files: [{ kind: "blob", sha, name: "a.png", image: true }] });
		expect(withImage).toMatchObject({
			files: [
				{ kind: "item", item: 2, n: 0 },
				{ kind: "item", item: 2, n: 1 },
			],
		});
	});

	it("an open question pairs with its call; an ended one says what was picked, or that no answer came", () => {
		const ask = { type: "question" as const, question: "Tea or coffee?", options: ["tea", "coffee"] };
		const items: Item[] = [
			user(1, "drink?"),
			said(2, [
				{ id: "m1", name: "message_user", args: { text: "Let me ask." } },
				{ id: "q1", name: "ask_user", args: { question: ask.question, options: ask.options } },
			]),
		];
		const open: ShownWait = { key: "k2345678ab", chat: 1, ask, deadline: 9, call: "q1" };
		const now = view(items, [open], IDLE);
		expect(kinds(now)).toEqual(["owner-message", "companion", "question"]);
		expect(now[2]).toMatchObject({ open: { wait: "k2345678ab" }, ask });
		const answered = view(
			[...items, { id: 3, role: "wait", ask, call: "q1", outcome: "answered", answer: ["tea"], at: 1 }],
			[],
			IDLE,
		);
		expect(answered[2]).toMatchObject({ kind: "question", ended: { said: "tea" } });
		expect(answered[2]).not.toHaveProperty("open");
		const expired = view([...items, { id: 3, role: "wait", ask, call: "q1", outcome: "expired", at: 1 }], [], IDLE);
		expect(expired[2]).toMatchObject({ ended: { said: "No answer in time" } });
		// a form's answer by field
		const form = { type: "question" as const, question: "Where?", fields: [{ name: "days", type: "number" as const }] };
		const filled = view(
			[
				said(1, [{ id: "f", name: "ask_user", args: { question: "Where?" } }]),
				{ id: 2, role: "wait", ask: form, call: "f", outcome: "answered", answer: { days: 3, public: true }, at: 1 },
			],
			[],
			IDLE,
		);
		expect(filled[0]).toMatchObject({ ended: { said: "days: 3 · public: yes" } });
	});

	it("an answer typed in the composer appears once as the owner's message after its question", () => {
		const ask = { type: "question" as const, question: "What matters most?", options: ["time", "cost"] };
		const items: Item[] = [
			user(1, "Help me choose"),
			said(2, [{ id: "q1", name: "ask_user", args: { question: ask.question, options: ask.options } }]),
			{ id: 3, role: "wait", ask, call: "q1", outcome: "answered", answer: "A relaxed trip", message: "m1", at: 4 },
		];
		const segments = view(items, [], IDLE);
		expect(kinds(segments)).toEqual(["owner-message", "question", "owner-message"]);
		expect(segments[2]).toMatchObject({ kind: "owner-message", text: "A relaxed trip" });
		const picked = view(
			[...items.slice(0, 2), { id: 3, role: "wait", ask, call: "q1", outcome: "answered", answer: "time", at: 4 }],
			[],
			IDLE,
		);
		expect(kinds(picked)).toEqual(["owner-message", "question"]);
		const dismissed = view(
			[...items.slice(0, 2), { id: 3, role: "wait", ask, call: "q1", outcome: "dismissed", at: 4 }],
			[],
			IDLE,
		);
		expect(kinds(dismissed)).toEqual(["owner-message", "question"]);
		expect(dismissed[1]).toMatchObject({ ended: { said: "Dismissed" } });
	});

	it("an approval and its interrupted variant, with the daemon's label and the arguments as a list", () => {
		const ask = {
			type: "approval" as const,
			tool: "send_email",
			args: { to: "ana@example.com", body: { text: "hi" } },
		};
		const items: Item[] = [said(1, [{ id: "e1", name: "send_email", args: ask.args }])];
		const open = view(items, [{ key: "k2345678ab", chat: 1, ask, deadline: 9, call: "e1", label: "send email" }], IDLE);
		expect(open).toEqual([
			expect.objectContaining({
				kind: "approval",
				label: "send email",
				args: [
					["to", "ana@example.com"],
					["body › text", "hi"],
				],
				open: { wait: "k2345678ab", deadline: 9 },
			}),
		]);
		const again = view(
			[
				...items,
				{ id: 2, role: "wait", ask, call: "e1", outcome: "answered", answer: "approve", at: 1, label: "send email" },
				{
					id: 3,
					role: "wait",
					ask: { ...ask, interrupted: true },
					call: "e1",
					outcome: "answered",
					answer: "deny",
					at: 2,
				},
			],
			[],
			IDLE,
		);
		expect(again.map((s) => (s.kind === "approval" ? [s.ask.interrupted ?? false, s.ended?.said] : []))).toEqual([
			[false, "Approved"],
			[true, "Skipped"],
		]);
	});

	it("an approval as edited and with a permission says so and shows the edited draft; an effect within a permission is a line", () => {
		const ask = { type: "approval" as const, tool: "send", args: { to: "ana", body: "draft" }, editable: ["body"] };
		const segments = view(
			[
				said(1, [{ id: "e1", name: "send", args: ask.args }]),
				{
					id: 2,
					role: "wait",
					ask,
					call: "e1",
					outcome: "answered",
					answer: "approve",
					at: 1,
					label: "send a message to ana",
					edited: { to: "ana", body: "as edited" },
					permitted: { scope: "always" },
				},
				{
					id: 3,
					role: "effect",
					label: "send a message to ana",
					permission: { what: "send messages to ana", scope: "task" },
					at: 2,
				},
			],
			[],
			IDLE,
		);
		expect(segments).toEqual([
			expect.objectContaining({
				kind: "approval",
				args: [
					["to", "ana"],
					["body", "as edited"],
				],
				ended: expect.objectContaining({ said: "Approved as you edited it, and allowed always" }),
			}),
			{
				kind: "effect",
				key: "3",
				label: "send a message to ana",
				permission: { what: "send messages to ana", scope: "task" },
			},
		]);
	});

	it("an undelivered message is marked; a notice shows", () => {
		const segments = view(
			[
				said(1, [{ id: "c1", name: "message_user", args: { text: "hello" } }]),
				result(2, "c1", "Not delivered: the client is gone.", true),
				{ id: 3, role: "notice", text: "Message not delivered to web/owner." },
			],
			[],
			IDLE,
		);
		expect(segments).toEqual([
			expect.objectContaining({ kind: "companion", undelivered: true }),
			{ kind: "notice", key: "3", text: "Message not delivered to web/owner." },
		]);
	});

	it("the working line: what the running call does, else thinking, else working; none while waiting or idle", () => {
		const line = (live: Live, waits: ShownWait[] = []) => view([], waits, live).find((s) => s.kind === "working");
		expect(line({ busy: true, running: [{ call: "a", doing: "reading notes.md" }], thinking: true })).toMatchObject({
			text: "reading notes.md…",
		});
		expect(line({ busy: true, running: [{ call: "m" }], thinking: true })).toMatchObject({ text: "thinking…" });
		expect(line({ busy: true, running: [], thinking: false })).toMatchObject({ text: "working…" });
		expect(line(IDLE)).toBeUndefined();
		const ask = { type: "question" as const, question: "?" };
		expect(
			line({ busy: true, running: [], thinking: false }, [{ key: "k", chat: 1, ask, deadline: 1 }]),
		).toBeUndefined();
	});

	it("the owner's queued messages come last, marked queued; one the transcript already holds shows once, as its entry", () => {
		const busy: Live = { busy: true, running: [], thinking: false };
		const queued = [
			{ id: "s2", text: "make it Saturday", message: "m2" },
			{
				id: "s3",
				text: "window seat",
				message: "m3",
				files: [{ sha: "a".repeat(64), name: "seat.png", mimeType: "image/png", size: 1 }],
			},
		];
		const before = view([user(1, "a train to Lisbon", { message: "m1" })], [], { ...busy, queued });
		expect(before.map((s) => [s.kind, s.key, "queued" in s ? s.queued : undefined])).toEqual([
			["owner-message", "1", undefined],
			["working", "working", undefined],
			["owner", "queued:s2", true],
			["owner", "queued:s3", true],
		]);
		expect(before.at(-1)).toMatchObject({ files: [{ kind: "blob", name: "seat.png", image: true }] });
		// the run took m2: its entry came before the queue said it left, and it shows once, in place
		const taken = view(
			[user(1, "a train to Lisbon", { message: "m1" }), user(4, "make it Saturday", { message: "m2" })],
			[],
			{
				...busy,
				queued,
			},
		);
		expect(taken.filter((s) => s.kind.startsWith("owner")).map((s) => s.key)).toEqual(["1", "4", "queued:s3"]);
		// a stop withdrew them: none left
		expect(view([user(1, "a", { message: "m1" })], [], { ...IDLE, queued: [] }).map((s) => s.key)).toEqual(["1"]);
	});

	it("approval arguments are never JSON", () => {
		expect(argList({ list: [1, "a"], nested: [{ x: 1 }], empty: null })).toEqual([
			["list", "1, a"],
			["nested 1 › x", "1"],
			["empty", "—"],
		]);
	});

	it("property: no segment shows a tool name, a call id, a call's arguments, thinking or notes", () => {
		const words = fc.stringMatching(/^[A-Z][A-Z ]{0,15}$/);
		const tools = ["bash", "read", "write", "schedule"];
		const step = fc.oneof(
			words.map((text) => ({ type: "owner" as const, text })),
			words.map((text) => ({ type: "message" as const, text })),
			fc
				.record({ tool: fc.constantFrom(...tools), arg: fc.stringMatching(/^arg[a-z0-9]{1,8}$/) })
				.map((call) => ({ type: "tool" as const, ...call })),
			fc.stringMatching(/^note[a-z]{1,8}$/).map((text) => ({ type: "note" as const, text })),
			fc.stringMatching(/^ponder[a-z]{1,8}$/).map((text) => ({ type: "think" as const, text })),
		);
		fc.assert(
			fc.property(fc.array(step, { maxLength: 12 }), fc.boolean(), (steps, busy) => {
				const items: Item[] = [];
				const secret: string[] = [];
				steps.forEach((s, i) => {
					const id = i * 2 + 1;
					const call = `call_${i}x`;
					if (s.type === "owner") items.push(user(id, s.text));
					else if (s.type === "message") {
						items.push(said(id, [{ id: call, name: "message_user", args: { text: s.text } }]));
						items.push(result(id + 1, call, "Sent."));
						secret.push(call);
					} else if (s.type === "tool") {
						items.push(said(id, [{ id: call, name: s.tool, args: { path: s.arg } }]));
						items.push({ id: id + 1, role: "tool", call, name: s.tool, text: `out${s.arg}`, error: false });
						secret.push(call, s.tool, s.arg, JSON.stringify({ path: s.arg }));
					} else if (s.type === "note") {
						items.push(said(id, [], s.text));
						secret.push(s.text);
					} else {
						items.push({ id, role: "assistant", text: "", thinking: s.text });
						secret.push(s.text);
					}
				});
				const segments = view(items, [], { busy, running: [{ call: "zzz" }], thinking: busy });
				for (const text of segments.flatMap(shown))
					for (const hidden of secret) expect(text, `"${text}" shows "${hidden}"`).not.toContain(hidden);
			}),
			{ numRuns: pbtRuns(200) },
		);
	});
});
