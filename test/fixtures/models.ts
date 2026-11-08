import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { NUDGED } from "../../src/core/turn.ts";
import type { Faults } from "../fault/faults.ts";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

/** An input starting with this is answered with `REACTION` alone, a reaction as the whole reply. */
export const REACT = "react ";
export const REACTION = "👍";

/** Inputs that all start with this are answered in the final text alone, as a model that forgets `message_user` does. */
export const SAY = "say ";

/**
 * pi-ai models whose faux provider answers each input it has not answered yet (the user messages at the end of the
 * context: one, or several that steered in together) by sending `re: <its text>` with `message_user` (or, for one
 * starting with `REACT`, the reaction `REACTION` alone, with `react`), then ends the run with the notes `sent: <what it sent>`. When
 * every one starts with `SAY`, it ends the run at once with `said: <its text>` for each in its notes, a line each; nudged
 * for that, it sends `re: <its text>` for each line, or, with none, the reaction alone. Each request passes the `model`
 * point, and waits for `gate` first when given, so a run can be held going.
 */
export function echoModels(faults?: Faults, options?: RegisterFauxProviderOptions, gate?: () => Promise<void>) {
	const faux = fauxProvider(options);
	const models = createModels();
	models.setProvider(faux.provider);
	const echo = (context: { messages: readonly { role: string; content: unknown }[] }) => {
		faults?.hit("model");
		// pi-durable's compaction asks for a summary of a serialized transcript: it gets one, naming what it read
		const last = context.messages.at(-1);
		const asked = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
		if (last?.role === "user" && asked.includes(SUMMARY_ASK)) return fauxAssistantMessage(summaryOf(asked));
		const inputs = context.messages.slice(
			context.messages.length - [...context.messages].reverse().findIndex((m) => m.role !== "user"),
		);
		if (inputs.length === 0) {
			const said = [...context.messages].reverse().find((m) => m.role === "assistant")?.content;
			const sent = (Array.isArray(said) ? said : []).flatMap(
				(part: { type?: string; arguments?: { text?: string } }) =>
					part.type === "toolCall" && part.arguments?.text !== undefined ? [part.arguments.text] : [],
			);
			return fauxAssistantMessage(`sent: ${sent.join(", ")}`);
		}
		const texts = inputs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
		if (texts.every((text) => text.startsWith(SAY)))
			return fauxAssistantMessage(texts.map((text) => `said: ${text}`).join("\n"));
		// the notes the run before a nudge ended with: what it meant to say
		const before = context.messages[context.messages.length - inputs.length - 1];
		const notes = typeof before?.content === "string" ? before.content : JSON.stringify(before?.content ?? "");
		const meant = [...notes.matchAll(/said: (.*?)(?=\\n|\n|"|$)/g)].map((match) => match[1] ?? "");
		const calls = texts.flatMap((text) => {
			if (text === NUDGED)
				return meant.length === 0
					? [fauxToolCall("react", { reaction: REACTION })]
					: meant.map((said) => fauxToolCall("message_user", { text: `re: ${said}` }));
			// `react …` is answered with a reaction alone
			return [
				text.startsWith(REACT)
					? fauxToolCall("react", { reaction: REACTION })
					: fauxToolCall("message_user", { text: `re: ${text}` }),
			];
		});
		return fauxAssistantMessage(calls, { stopReason: "toolUse" });
	};
	const answer =
		gate === undefined
			? echo
			: async (context: Parameters<typeof echo>[0]) => {
					await gate();
					return echo(context);
				};
	faux.setResponses(Array.from({ length: 10_000 }, () => answer as never));
	return { models, faux };
}

/** What pi-durable's summarization prompt asks, as the faux model recognizes it. */
const SUMMARY_ASK = "Create a structured context checkpoint summary";

/** The faux summary: a heading and the owner's words it saw, so a test can tell what a compaction kept. */
export const summaryOf = (asked: string) =>
	`## Goal\nfaux summary\n\n## Critical Context\n${[...asked.matchAll(/\[User\]: ([^\n\\]{0,40})/g)].map((m) => `- ${m[1]}`).join("\n")}`;

/** The newest message that is not a system message (a memory refresh may follow an input). */
export const newestSaid = <M extends { role: string }>(messages: readonly M[]): M | undefined =>
	[...messages].reverse().find((m) => m.role !== "system");

/** Whether the newest message is the daemon's nudge to a run that left the owner unanswered. */
export const nudged = (messages: readonly { role: string; content: unknown }[]): boolean => {
	const last = newestSaid(messages);
	if (last?.role !== "user") return false;
	const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
	return text.includes(NUDGED.slice(0, 40));
};

/** What a model that heeds the nudge does when nothing more needs saying: a reaction. */
export const heedNudge = () =>
	fauxAssistantMessage([fauxToolCall("react", { reaction: REACTION })], { stopReason: "toolUse" });

/**
 * How a scripted model that heeds the daemon's nudge goes on, when the newest input is one: a reaction, then its
 * notes; undefined for any other input, which the script answers as it does.
 */
export const answerNudge = (messages: readonly { role: string; content: unknown }[]) => {
	const at = messages.length - 1 - [...messages].reverse().findIndex((m) => m.role === "user");
	if (at >= messages.length || !nudged(messages.slice(0, at + 1))) return undefined;
	// a system message (a memory refresh) may come after it
	const newest = messages.length - 1 - [...messages].reverse().findIndex((m) => m.role !== "system");
	return at === newest ? heedNudge() : fauxAssistantMessage("Reacted.");
};
