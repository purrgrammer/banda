import { awaitWithContext } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type JsonObject, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getExample } from "open-bot-avatar";
import { describe, expect, it } from "vitest";
import { messageTool, type Sending } from "../src/core/ask.ts";
import { avatar } from "../src/core/parts/avatar.ts";
import { context } from "../src/core/store.ts";
import type { Item } from "../src/server/api.ts";
import { items, receiptOf } from "../src/server/transcript.ts";
import { view } from "../web/src/lib/chat.ts";
import { blobStore, FAUX_MODEL, until } from "./helpers.ts";

const definition = getExample("mug")!;
const idle = { busy: false, running: [], thinking: false };
const previews = (entries: readonly Item[]) => view(entries, [], idle).filter((segment) => segment.kind === "avatar");
const candidate = (value: unknown = definition) => ({ avatar: value }) as JsonObject;
const invalid = { ...definition, body: { path: "M10 10A.01 120 45 0 1 90 90Z" } };
const round = (...args: JsonObject[]) =>
	fauxAssistantMessage(
		args.map((args) => fauxToolCall("message_user", args, { id: "repeat" })),
		{ stopReason: "toolUse" },
	);

/** Real tool intent/coercion, execution, durable results and HTTP projection; no daemon or on-disk database. */
async function run(
	responses: ReturnType<typeof fauxAssistantMessage>[],
	check: (harness: Harness, chat: number, entries: Item[]) => Promise<void> | void,
	sending: Sending = async () => ({ posted: 1 }),
) {
	const registry = createRegistry();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...responses, fauxAssistantMessage("done")]);
	registry.install({
		name: "avatar-test",
		tools: [
			messageTool(
				async () => {
					throw new Error("no question");
				},
				sending,
				blobStore(),
				1000,
			),
		],
	});
	const harness = await Harness.open(await openNodeSqliteStorage(":memory:"), { models, registry }, context);
	try {
		const chat = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } },
			context,
		);
		await (await chat.submit({ type: "input", content: "Make a face." }, context)).wait(context);
		const page = await items(harness, Number(chat.id), {});
		if (!page) throw new Error("no transcript");
		await check(harness, Number(chat.id), [...page.items]);
	} finally {
		await harness.close(context);
	}
}

describe("avatar validation receipts", () => {
	it("does not let a later text-only success attest refused geometry with the same provider ID", async () => {
		await run([round(candidate(invalid)), round({ text: "hello" })], (_harness, _chat, entries) => {
			const results = entries.filter((item) => item.role === "tool");
			expect(results.map((item) => item.error)).toEqual([true, false]);
			expect(previews(entries)).toEqual([]);
		});
	});

	it.each([false, true])(
		"keeps canonical geometry bound across reused IDs, pagination and JSON replay (valid first: %s)",
		async (validFirst) => {
			const coerced = { ...definition, name: "  My mug  ", eyes: { ...definition.eyes, x: "50" } };
			const good = round(candidate(coerced));
			const bad = round(candidate(invalid));
			await run(
				validFirst ? [good, bad, round({ text: "hello" })] : [bad, good, round({ text: "hello" })],
				async (harness, chat, entries) => {
					const cards = previews(entries);
					expect(cards).toHaveLength(1);
					expect(cards[0]?.definition.eyes.x).toBe(50);
					expect(cards[0]?.definition.name).toBe("My mug");
					const successful = entries.find((item) => item.role === "tool" && item.receipt?.kind === "avatar");
					if (successful?.role !== "tool" || successful.receipt?.kind !== "avatar") throw new Error("no receipt");
					const receipt = successful.receipt;
					const assistant = entries.find((item) => item.id === receipt.assistant);
					if (assistant?.role !== "assistant") throw new Error("no assistant");
					expect(assistant.calls?.[0]?.args.avatar).toEqual(coerced);
					// A split exactly between the call and receipt must not match a result to an earlier/later reused ID.
					const older = (await items(harness, chat, { before: successful.id }))?.items ?? [];
					const newer = (await items(harness, chat, { after: successful.id - 1 }))?.items ?? [];
					expect(previews(older)).toEqual([]);
					expect(previews(newer)).toEqual([]);
					expect(previews([...older, ...newer])).toEqual(cards);
					expect(previews(JSON.parse(JSON.stringify(entries)))).toEqual(cards);
					// Re-reading durable history is stable and requires no auxiliary store or live task state.
					expect(previews((await items(harness, chat, {}))?.items ?? [])).toEqual(cards);
				},
			);
		},
	);

	it("keeps two successful payloads separate when their provider ID is reused across entries", async () => {
		await run(
			[round(candidate({ ...definition, name: "First" })), round(candidate({ ...definition, name: "Second" }))],
			(_harness, _chat, entries) => {
				expect(previews(entries).map((card) => card.definition.name)).toEqual(["First", "Second"]);
			},
		);
	});

	it("binds multiple unique calls in one assistant entry by call position, not content-block position", async () => {
		const response = fauxAssistantMessage(
			[
				{ type: "text", text: "private notes" },
				fauxToolCall("message_user", candidate({ ...definition, name: "First" }), { id: "one" }),
				{ type: "text", text: "more private notes" },
				fauxToolCall("message_user", candidate({ ...definition, name: "Second" }), { id: "two" }),
			],
			{ stopReason: "toolUse" },
		);
		await run([response], (_harness, _chat, entries) => {
			expect(previews(entries).map((card) => card.definition.name)).toEqual(["First", "Second"]);
			expect(
				entries.flatMap((item) =>
					item.role === "tool" && item.receipt?.kind === "avatar" ? [item.receipt.index] : [],
				),
			).toEqual([0, 1]);
		});
	});

	it.each([
		[candidate(), candidate(invalid)],
		[candidate(invalid), candidate()],
		[candidate(), { text: "hello" }],
		[{ text: "hello" }, candidate(invalid)],
	])("fails closed for duplicate call IDs within one assistant entry: %j", async (first, second) => {
		await run([round(first, second)], (_harness, _chat, entries) => {
			expect(previews(entries)).toEqual([]);
			expect(entries.filter((item) => item.role === "tool").every((item) => item.receipt === undefined)).toBe(true);
		});
	});

	it("does not publish a receipt when delivery refuses, even after validation succeeded", async () => {
		await run(
			[round(candidate())],
			(_harness, _chat, entries) => {
				expect(previews(entries)).toEqual([]);
				expect(entries.find((item) => item.role === "tool")).toMatchObject({ error: true, text: "Not sent: offline." });
			},
			async () => ({ refused: "offline" }),
		);
	});

	it("rejects missing, erroneous, unrelated and mismatched occurrence receipts", async () => {
		await run([round(candidate())], (_harness, _chat, entries) => {
			const result = entries.find((item) => item.role === "tool");
			if (result?.receipt?.kind !== "avatar") throw new Error("no receipt");
			for (const changed of [
				{ ...result, receipt: undefined },
				{ ...result, error: true },
				{ ...result, name: "bash" },
				{ ...result, receipt: { ...result.receipt, assistant: result.receipt.assistant + 1 } },
				{ ...result, receipt: { ...result.receipt, index: 1 } },
			])
				expect(previews(entries.map((item) => (item.id === result.id ? changed : item)) as Item[])).toEqual([]);
			expect(receiptOf("bash", false, { receipt: result.receipt })).toBeUndefined();
			expect(receiptOf("message_user", true, { receipt: result.receipt })).toBeUndefined();
		});
	});

	it("recovers a safe tool interrupted after validation with the same occurrence and canonical receipt", async () => {
		const storage = await openNodeSqliteStorage(":memory:");
		// Keep the SQLite connection alive while replacing the harness: actual recovery, no second store.
		const retained = new Proxy(storage, {
			get(target, key) {
				if (key === "close") return async () => {};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const registry = createRegistry();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			round(candidate({ ...definition, eyes: { ...definition.eyes, x: "50" } })),
			fauxAssistantMessage("done"),
		]);
		const attempts: number[] = [];
		registry.install({
			name: "recovery",
			tools: [
				messageTool(
					async () => {
						throw new Error("no question");
					},
					async (api, _name, _said, ctx) => {
						attempts.push(Number(api.taskId));
						if (attempts.length === 1) await awaitWithContext(new Promise<never>(() => {}), ctx);
						return { posted: 1 };
					},
					blobStore(),
					1000,
				),
			],
		});
		let harness = await Harness.open(retained, { models, registry }, context);
		try {
			const chat = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } },
				context,
			);
			const submission = await chat.submit({ type: "input", content: "Make a face." }, context);
			await until(() => attempts.length === 1);
			expect(previews((await items(harness, Number(chat.id), {}))?.items ?? [])).toEqual([]);
			await harness.close(context);
			harness = await Harness.open(retained, { models, registry }, context);
			const recovered = await harness.submission(submission.id, context);
			if (!recovered) throw new Error("no recovered submission");
			await recovered.wait(context);
			expect(attempts).toHaveLength(2);
			expect(attempts[1]).toBe(attempts[0]);
			const cards = previews((await items(harness, Number(chat.id), {}))?.items ?? []);
			expect(cards).toHaveLength(1);
			expect(cards[0]?.definition.eyes.x).toBe(50);
		} finally {
			await harness.close(context);
			await storage.close(context);
		}
	});

	it("revalidates the same occurrence on execution replay and returns only normalized geometry", async () => {
		const raw = candidate({ ...definition, name: "  My mug  " });
		const api = {
			taskId: 7,
			callId: "repeat",
			commit: async (read: (tx: Tx) => unknown) =>
				read({
					task: async () => ({ input: { kind: "model", assistant: 10, callId: "repeat" } }),
					entry: async () => ({ model: [round(raw)] }),
				} as unknown as Tx),
		} as unknown as ToolExecutionApi;
		const first = await avatar.prepare?.(raw, api, context, { blobs: blobStore(), limit: 1000, to: "owner" });
		expect(first).toMatchObject({
			receipt: { kind: "avatar", assistant: 10, index: 0, definition: { name: "My mug" } },
		});
		expect(await avatar.prepare?.(raw, api, context, { blobs: blobStore(), limit: 1000, to: "owner" })).toEqual(first);
	});
});
