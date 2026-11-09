import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createRegistry,
	type JsonObject,
	type TaskId,
	type ToolExecutionApi,
	type Tx,
} from "@earendil-works/pi-durable";
import { getExample, validateAvatar } from "open-bot-avatar";
import { describe, expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { Accepted, agentPath, chatTools, shaOf } from "../src/core/agents.ts";
import { groupMessageTool, messageTool, proposeAvatarTool, type Speaking } from "../src/core/ask.ts";
import { defaultAvatarFace, writeAvatarFace } from "../src/core/avatar-face.ts";
import { AVATAR_INSTRUCTIONS } from "../src/core/avatar-instructions.ts";
import { OWNER } from "../src/core/gateway.ts";
import { avatar } from "../src/core/parts/avatar.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore, type TurnResult } from "../src/core/turn.ts";
import { save, seed, type Workspace } from "../src/server/agents.ts";
import type { ToolCall } from "../src/server/api.ts";
import { items } from "../src/server/transcript.ts";
import { edited } from "../web/src/app/edit-file.ts";
import { shown, view } from "../web/src/lib/chat.ts";
import { avatar as segmenter } from "../web/src/lib/segments/avatar.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const checked = validateAvatar(getExample("mug"));
if (!checked.ok) throw new Error("invalid shipped example");
const definition = checked.value;
/** What the part reads: the geometry under `avatar`, as `messageArgs` gives it. */
const args = { avatar: definition } as unknown as JsonObject;
/** What the model gives `propose_avatar`: the geometry itself. */
const given = definition as unknown as JsonObject;
const call: ToolCall = { id: "face", name: "propose_avatar", args };
const occurrence = { assistant: 1, index: 0 };
const receipt = { kind: "avatar" as const, ...occurrence, definition };
const api = {
	taskId: 1,
	callId: "face",
	commit: async (read: (tx: Tx) => unknown) =>
		read({
			task: async () => ({ input: { kind: "model", assistant: 1, callId: "face" } }),
			entry: async () => ({ model: [fauxAssistantMessage([fauxToolCall("propose_avatar", given, { id: "face" })])] }),
		} as unknown as Tx),
} as unknown as ToolExecutionApi;

const noAccess = new Proxy(
	{},
	{
		get() {
			throw new Error("a candidate must not access identity or the box");
		},
	},
);

describe("generated face message parts", () => {
	it("ships a typed direct-chat tool, not a message part, a group's tool or a user-facing JSON recipe", () => {
		const speaking = {
			asking: noAccess,
			sending: noAccess,
			blobs: blobStore(),
			limit: 1000,
			venue: noAccess,
		} as Speaking;
		expect(proposeAvatarTool(speaking).parameters).toHaveProperty("properties.body");
		expect(messageTool(speaking).parameters).not.toHaveProperty("properties.avatar");
		expect(groupMessageTool(speaking).parameters).not.toHaveProperty("properties.avatar");
		expect(chatTools({ id: "mira", tools: [] }, undefined, [], false)).toContain("propose_avatar");
		expect(chatTools({ id: "mira", tools: [] }, undefined, [], true)).not.toContain("propose_avatar");
		expect(AVATAR_INSTRUCTIONS).toContain("propose_avatar's arguments");
		expect(AVATAR_INSTRUCTIONS).toContain("never as JSON in text");
		expect(AVATAR_INSTRUCTIONS).not.toContain("as text or a JSON file");
	});

	it("validates without accessing identity or the box, including on replay", async () => {
		for (let replay = 0; replay < 2; replay++)
			expect(await avatar.prepare?.(args, api, context, noAccess as never)).toEqual({ receipt });
	});

	it.each([
		{ ...definition, html: "<script>globalThis.pwned=true</script>" },
		{ ...definition, body: { path: '<svg onload="alert(1)"/>' } },
		{ ...definition, body: { path: "M".repeat(17000) } },
		{ ...definition, body: { path: "" } },
		{ ...definition, body: { path: "M10 10A.01 120 45 0 1 90 90Z" } },
		{ ...definition, eyes: { ...definition.eyes, x: -100 } },
	])("rejects malformed geometry instead of showing or applying it", async (candidate) => {
		expect(
			await avatar.prepare?.(
				{ avatar: candidate } as unknown as JsonObject,
				noAccess as never,
				context,
				noAccess as never,
			),
		).toBeTypeOf("string");
	});

	it("draws only a successful validated message, never pending, failed, group or unrelated tool arguments", () => {
		const result = {
			id: 2,
			role: "tool" as const,
			call: "face",
			name: "propose_avatar",
			text: "Sent.",
			error: false,
			receipt,
		};
		expect(segmenter.message?.(call, "1:face", {})).toEqual([]);
		expect(segmenter.message?.(call, "1:face", { result: { ...result, error: true } })).toEqual([]);
		expect(segmenter.message?.(call, "1:face", { result: { ...result, name: "bash" } })).toEqual([]);
		expect(segmenter.message?.({ ...call, name: "message_group" }, "1:face", { result })).toEqual([]);
		expect(segmenter.message?.(call, "1:face", { result })).toEqual([]);
		expect(segmenter.message?.(call, "1:face", { result, occurrence })).toEqual([
			{ kind: "avatar", key: "1:face:avatar", definition },
		]);
	});

	it("durably delivers geometry as a card; only the owner's existing edit path changes the accepted file", async () => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const registry = createRegistry();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("propose_avatar", given, { id: "face" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const gateway = new FakeGateway();
		// Delivery retries the already stored message, not a second identity effect.
		gateway.fail = (attempt) => (attempt === 1 ? "transient" : undefined);
		const core = defineCore({
			blobs: blobStore(),
			gateway: () => gateway,
			model: () => FAUX_MODEL,
			retryDelay: () => 1,
		});
		registry.install(core.extension);
		let harness = await openStore(home, { models, registry });
		const workspace: Workspace = { env: () => box.env(), root: box.workspace, tools: () => [], known: () => true };
		const changed = async () => {};
		try {
			await seed(harness, workspace);
			const face = { ...defaultAvatarFace(), color: "#123456" };
			const original = `---\nname: Mira\nface: ${writeAvatarFace(face)}\ndescription: An artist\n---\nDraw thoughtfully.\n`;
			await save(harness, workspace, "mira", original, null, changed);
			const before = await harness.snapshot(Accepted, context);
			harness.resume();
			const received = await core.receive(harness, {
				id: "make-face",
				origin: { gateway: "fake", peer: OWNER },
				agent: "mira",
				text: "Make yourself a mug face.",
			});
			if (!("turn" in received)) throw new Error("no turn");
			expect((await harness.waitForTask(received.turn as TaskId<TurnResult>, context)).state.outcome.status).toBe(
				"completed",
			);
			expect(await harness.snapshot(Accepted, context)).toEqual(before);
			expect(gateway.sent).toHaveLength(1);
			expect(JSON.stringify(gateway.sent)).not.toContain("body");
			expect(JSON.stringify(gateway.sent)).not.toContain("path");
			const page = await items(harness, received.chat, {});
			const result = page?.items.find((item) => item.role === "tool" && item.call === "face");
			if (result?.role !== "tool") throw new Error("no durable result");
			expect(result.error).toBe(false);
			if (result.receipt?.kind !== "avatar") throw new Error("no candidate receipt");
			expect(segmenter.message?.(call, "face", { result, occurrence: result.receipt })).toMatchObject([
				{ kind: "avatar", definition },
			]);
			const segments = view(page?.items ?? [], [], { busy: false, running: [], thinking: false });
			expect(segments.filter((segment) => segment.kind === "avatar")).toMatchObject([{ definition }]);
			const words = segments.flatMap(shown).join("\n");
			expect(words).toContain("Face preview");
			expect(words).not.toContain(definition.body.path);
			expect(words).not.toContain('"eyes"');

			// Closing and reopening loses no preview and still changes no identity.
			await harness.close(context);
			harness = await openStore(home, { models, registry });
			expect((await items(harness, received.chat, {}))?.items).toEqual(page?.items);
			expect(await harness.snapshot(Accepted, context)).toEqual(before);
			const ownerEdit = edited(original, { face: { definition, color: face.color } });
			await save(harness, workspace, "mira", ownerEdit, shaOf(original), changed);
			expect((await harness.snapshot(Accepted, context))?.files[agentPath("mira")]?.text).toBe(ownerEdit);
			await expect(save(harness, workspace, "mira", original, shaOf(original), changed)).rejects.toThrow(
				/changed since/,
			);
		} finally {
			await harness.close(context);
			box.close();
		}
	});
});
