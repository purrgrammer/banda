/**
 * Inference: one bounded model request outside any chat, for a part of the app that needs a model's judgment on the
 * spot (a face from a description, a name, a summary for a card) and nothing durable. It runs on a tier's model, under
 * a deadline and a daemon-wide cap, and its answer is data: `read` turns the text into a value or says what is wrong
 * with it, and a request with those errors follows while attempts remain. Nothing is stored, no tool runs and no chat
 * sees it; whatever the caller does with the value is the caller's own act. Work that must survive a restart, use tools
 * or answer to a chat is a turn, never an inference.
 */
import type { Api, Message, Model, MutableModels, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import { Companion, type CompanionDoc } from "../core/companion.ts";
import { context } from "../core/store.ts";
import { modelFor, type Tier } from "../core/tiers.ts";

/** Inferences at once in this daemon; another is refused as busy rather than queued behind a slow provider. */
export const INFERENCES = 4;
/** The whole inference, every attempt included, unless the caller gives its own. */
export const INFERENCE_DEADLINE_MS = 60_000;

/** What `read` makes of an answer: the value, or what is wrong with it, said so the model can fix it. */
export type Read<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly errors: readonly string[] };

/** An inference's outcome: the value, or why there is none, in the owner's words. */
export type Inferred<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

let running = 0;

/** The model `tier` runs on for the owner: the companion's choice, else the configured model. */
export async function inferenceModel(
	{ harness, models, fallback }: { harness: Harness; models: MutableModels; fallback: ModelRef },
	tier: Tier,
): Promise<Model<Api> | undefined> {
	const choice: CompanionDoc = (await harness.snapshot(Companion, context)) ?? {};
	const ref = modelFor(tier, choice, fallback);
	return models.getModel(ref.provider, ref.modelId);
}

/** The JSON object an answer holds, as text: without prose or a code fence, from its first `{` to its last `}`. */
export function answerJson(text: string): string | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start === -1 || end < start ? undefined : text.slice(start, end + 1);
}

/** Ask `model` once (or up to `attempts` times, each after `read` refused the last answer) and read its answer. */
export async function infer<T>({
	models,
	model,
	system,
	ask,
	read,
	attempts = 1,
	deadlineMs = INFERENCE_DEADLINE_MS,
	maxTokens = 4096,
	reasoning,
	signal,
}: {
	models: Pick<MutableModels, "completeSimple">;
	model: Model<Api>;
	/** banda's own instructions: shipped text, never anything a box or a page wrote. */
	system: string;
	/** The request, with the owner's words in it as data. */
	ask: string;
	read: (text: string) => Read<T> | Promise<Read<T>>;
	attempts?: number;
	deadlineMs?: number;
	maxTokens?: number;
	reasoning?: ThinkingLevel;
	signal?: AbortSignal | undefined;
}): Promise<Inferred<T>> {
	if (running >= INFERENCES) return { ok: false, why: "banda is busy thinking already. Try again in a moment." };
	running++;
	const deadline = AbortSignal.timeout(deadlineMs);
	const aborted = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
	const stopped = (): Inferred<T> => ({
		ok: false,
		why: deadline.aborted ? "It took too long. Try again." : "Stopped.",
	});
	try {
		const messages: Message[] = [{ role: "user", content: ask, timestamp: Date.now() }];
		let errors: readonly string[] = [];
		for (let attempt = 0; attempt < attempts; attempt++) {
			const answer = await models.completeSimple(
				model,
				{ systemPrompt: system, messages },
				{ signal: aborted, maxTokens, ...(reasoning === undefined ? {} : { reasoning }) },
			);
			if (aborted.aborted) return stopped();
			if (answer.stopReason === "error" || answer.stopReason === "aborted")
				return { ok: false, why: `The model couldn't answer: ${answer.errorMessage ?? "it failed"}.` };
			const text = answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			const got = await read(text);
			if (got.ok) return { ok: true, value: got.value };
			errors = got.errors;
			messages.push(answer, {
				role: "user",
				content: `That answer was refused:\n${errors.map((error) => `- ${error}`).join("\n")}\nAnswer again, fixing every one.`,
				timestamp: Date.now(),
			});
		}
		return { ok: false, why: `The answer didn't come out right (${errors[0] ?? "refused"}). Try again.` };
	} catch (error) {
		if (aborted.aborted) return stopped();
		return { ok: false, why: `The model couldn't answer: ${error instanceof Error ? error.message : String(error)}.` };
	} finally {
		running--;
	}
}
