import { createModels, type fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { FAUX_MODEL } from "./models.ts";

export type Asked = { messages: readonly { role: string; content: unknown }[] };

/** pi-ai models whose faux provider gives `answers` in turn, and every context it was asked with. */
export function scripted(...answers: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const asked: Asked[] = [];
	faux.setResponses(
		answers.map((answer) => (context: Asked) => {
			asked.push(structuredClone(context));
			return answer;
		}) as never,
	);
	const model = models.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId);
	if (model === undefined) throw new Error("no faux model");
	return { models, model, asked };
}

/** Everything a context said, system prompt included, as one text. */
export const said = (context: Asked | undefined) =>
	(context?.messages ?? [])
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
