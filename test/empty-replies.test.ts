import {
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { dropEmptyReplies, emptyReply } from "../src/core/empty-replies.ts";

const at = 1;

function reply(content: AssistantMessage["content"], from = { api: "openai-responses", provider: "openai" }) {
	return { ...fauxAssistantMessage(""), ...from, model: "m", content, stopReason: "stop" } as AssistantMessage;
}

/** What Forja's transcript held when Anthropic rejected it: an OpenAI turn that ended in an empty final answer. */
const transcript: Message[] = [
	{ role: "system", content: "You are forja.", timestamp: at },
	{ role: "user", content: "summarise the project", timestamp: at },
	reply([{ type: "toolCall", id: "c1", name: "message_group", arguments: { text: "may I?" } }]),
	{
		role: "toolResult",
		toolCallId: "c1",
		toolName: "message_group",
		content: [{ type: "text", text: "Posted." }],
		isError: false,
		timestamp: at,
	},
	{ role: "system", content: "It is Thursday.", timestamp: at },
	reply([{ type: "text", text: "", textSignature: '{"v":1,"id":"msg_1","phase":"final_answer"}' }]),
	{ role: "user", content: "you can now", timestamp: at },
];

/** The Anthropic request pi-ai builds for `messages`, captured before it would go out. */
async function anthropicPayload(models: ReturnType<typeof createModels>, messages: Message[]) {
	const model = models.getModel("anthropic", "claude-sonnet-5-5");
	if (!model) throw new Error("no claude-sonnet-5-5 in the catalog");
	const provider = models.getProviders().find((p) => p.id === "anthropic");
	let payload: { messages: { role: string }[] } | undefined;
	const stream = provider?.streamSimple(model, normalizeContext({ messages }), {
		apiKey: "sk-test",
		onPayload: (params) => {
			payload = params as typeof payload;
			throw new Error("captured");
		},
	});
	if (stream) for await (const _ of stream);
	if (!payload) throw new Error("no payload captured");
	return payload.messages.map((m) => m.role);
}

describe("empty replies", () => {
	it("are the ones with nothing a model could read", () => {
		expect(emptyReply(reply([]))).toBe(true);
		expect(emptyReply(reply([{ type: "text", text: "  " }]))).toBe(true);
		expect(emptyReply(reply([{ type: "thinking", thinking: "" }]))).toBe(true);
		expect(emptyReply(reply([{ type: "text", text: "hi" }]))).toBe(false);
		expect(emptyReply(reply([{ type: "thinking", thinking: "", thinkingSignature: "sig" }]))).toBe(false);
		expect(emptyReply(reply([{ type: "toolCall", id: "c", name: "t", arguments: {} }]))).toBe(false);
	});

	it("put a system message before a user message in pi-ai's Anthropic request (the cause)", async () => {
		const roles = await anthropicPayload(builtinModels(), transcript);
		const system = roles.indexOf("system");
		expect(roles[system + 1]).toBe("user");
	});

	it("never reach a provider, so every system message precedes an assistant message or ends the request", async () => {
		const roles = await anthropicPayload(dropEmptyReplies(builtinModels()), transcript);
		roles.forEach((role, i) => {
			if (role === "system") expect([undefined, "assistant", "system"]).toContain(roles[i + 1]);
		});
		expect(roles).toContain("system");
	});

	it("stay in what the caller holds; only the request leaves them out", async () => {
		const faux = fauxProvider();
		const plain = createModels();
		plain.setProvider(faux.provider);
		const models = dropEmptyReplies(plain);
		let seen: Message[] = [];
		const wrapped = models.getProviders().find((p) => p.id === faux.provider.id);
		faux.setResponses([
			(context) => {
				seen = context.messages;
				return fauxAssistantMessage("ok");
			},
		]);
		const messages = [...transcript];
		const model = faux.getModel();
		const stream = wrapped?.streamSimple(model, normalizeContext({ messages }));
		if (stream) for await (const _ of stream);
		expect(messages).toHaveLength(transcript.length);
		expect(seen.filter((m) => m.role === "assistant")).toHaveLength(1);
	});
});
