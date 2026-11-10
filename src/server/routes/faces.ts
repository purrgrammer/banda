/**
 * Faces designed in the "+" sheet (`POST /api/faces`, `../face-design.ts`): the owner's description in, a validated
 * candidate out, on the model the owner's Balanced tier runs. Nothing is stored; the sheet writes the face into the new
 * agent's file only when the owner adds it.
 */
import type { AvatarDefinition } from "open-bot-avatar";
import { usageRecorder } from "../../core/system-usage.ts";
import { designFace } from "../face-design.ts";
import { BadRequest } from "../http.ts";
import { inferenceModel } from "../inference.ts";
import type { AreaModule } from "./area.ts";

/** `POST /api/faces`' answer. */
export type DesignedFace = { readonly definition: AvatarDefinition };

export const faces: AreaModule = {
	start: (deps) => ({
		route: async (request) => {
			if (request.path !== "/faces") return undefined;
			if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
			const { description, name } = await request.json();
			if (typeof description !== "string") throw new BadRequest("description is text");
			if (name !== undefined && typeof name !== "string") throw new BadRequest("name is text");
			const model = await inferenceModel(
				{ harness: deps.harness, models: deps.models, fallback: deps.config.model },
				"balanced",
			);
			if (model === undefined) throw new BadRequest("No model is set up to design a face: pick one in Settings.");
			const designed = await designFace({
				models: deps.models,
				model,
				description,
				name,
				record: usageRecorder(deps.harness, "inference.face", deps.log),
				signal: request.signal,
			});
			if (!designed.ok) throw new BadRequest(designed.why);
			const reply: DesignedFace = { definition: designed.value };
			return { body: reply };
		},
	}),
};
