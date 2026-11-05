/**
 * A face designed in the "+" sheet (DESIGN.md "Agents"), before the agent exists: an inference (`inference.ts`) with
 * banda's shipped avatar instructions and the owner's description, its answer validated off the event loop like any
 * candidate, and one revision against the validator's errors. Nothing is stored and nothing is accepted: the definition
 * goes back to the sheet, and only the owner adding the agent writes it, as their own pick.
 */
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { AvatarDefinition } from "open-bot-avatar";
import { SHEET_AVATAR_INSTRUCTIONS } from "../core/avatar-instructions.ts";
import { type AvatarValidation, validateAvatarCandidate } from "./avatar-validation.ts";
import { answerJson, type Inferred, infer } from "./inference.ts";

/** What the owner writes, at most. */
export const DESCRIPTION_MAX = 500;
/** Geometry is careful work: longer than an ordinary inference, and a second try against the errors. */
const FACE_DEADLINE_MS = 120_000;
const FACE_ATTEMPTS = 2;

/** Design one face for `description`, or from the agent's `name` alone, with `model`. */
export async function designFace({
	models,
	model,
	description,
	name,
	signal,
	deadlineMs = FACE_DEADLINE_MS,
	validate = validateAvatarCandidate,
}: {
	models: Pick<MutableModels, "completeSimple">;
	model: Model<Api>;
	description: string;
	name?: string | undefined;
	signal?: AbortSignal | undefined;
	deadlineMs?: number;
	validate?: (text: string) => Promise<AvatarValidation>;
}): Promise<Inferred<AvatarDefinition>> {
	const words = description.trim();
	const called = name?.trim() ?? "";
	if (words === "" && called === "") return { ok: false, why: "Describe the face, or name the agent first." };
	if (words.length > DESCRIPTION_MAX)
		return { ok: false, why: `Describe the face in at most ${DESCRIPTION_MAX} characters.` };
	const ask =
		words === ""
			? `Design a face for an agent called ${JSON.stringify(called)}: the object its name most evokes.`
			: `Design a face: ${words}${called === "" ? "" : `\n\nThe agent is called ${JSON.stringify(called)}.`}`;
	return infer({
		models,
		model,
		system: SHEET_AVATAR_INSTRUCTIONS,
		ask,
		attempts: FACE_ATTEMPTS,
		deadlineMs,
		maxTokens: 8192,
		signal,
		read: async (text) => {
			const json = answerJson(text);
			if (json === undefined) return { ok: false, errors: ["The answer held no JSON object."] };
			const checked = await validate(json);
			return checked.ok ? { ok: true, value: checked.definition } : { ok: false, errors: checked.errors };
		},
	});
}
