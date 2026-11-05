/**
 * A reply with nothing in it never reaches a model. Some providers end a turn with an assistant message that carries no
 * content (OpenAI's empty final answer after a tool call: one text block of ""), and pi-ai's Anthropic conversion
 * releases a held system message ahead of such a reply before dropping the reply itself, so the system message lands
 * before a user message and Anthropic rejects the request. The daemon owns the stream between every provider and
 * pi-durable, so it leaves those replies out of each request's context; the stored transcript keeps them.
 */
import type { AssistantMessage, Message, MutableModels, Provider } from "@earendil-works/pi-ai";

/** Whether an assistant message carries nothing a model could read: no text, no tool call, no thinking. */
export function emptyReply(message: AssistantMessage): boolean {
	return message.content.every((block) => {
		if (block.type === "text") return block.text.trim().length === 0;
		if (block.type === "thinking") return block.thinking.trim().length === 0 && !block.thinkingSignature?.trim();
		return false;
	});
}

/** The messages without empty replies. */
export function withoutEmptyReplies(messages: readonly Message[]): Message[] {
	return messages.filter((message) => message.role !== "assistant" || !emptyReply(message));
}

/** Leave empty replies out of every provider's requests, in place. */
export function dropEmptyReplies(models: MutableModels): MutableModels {
	for (const provider of models.getProviders()) models.setProvider(dropping(provider));
	return models;
}

function dropping(provider: Provider): Provider {
	return new Proxy(provider, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if ((key !== "stream" && key !== "streamSimple") || typeof value !== "function") return value;
			return (model: unknown, context: { messages: Message[] }, ...rest: unknown[]) =>
				value.call(target, model, { ...context, messages: withoutEmptyReplies(context.messages) }, ...rest);
		},
	});
}
