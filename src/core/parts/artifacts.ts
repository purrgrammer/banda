/**
 * Artifacts shown again (DESIGN.md "Messages"): ids of artifacts already in the owner's Library, each drawn as its card
 * after the message. The id is checked against the Library before anything is sent, and the version each card shows is
 * the one current then, kept in the call's receipt, so an old message keeps showing what it showed.
 */
import { Type } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { ARTIFACT_ID, Artifacts } from "../artifacts.ts";
import type { MessagePart } from "./part.ts";

/** At most this many cards in one message. */
const MAX_SHOWN = 5;

const ids = (args: JsonObject): string[] =>
	Array.isArray(args.artifacts) ? args.artifacts.filter((id): id is string => typeof id === "string") : [];

export const artifacts: MessagePart = {
	parameters: {
		artifacts: Type.Optional(
			Type.Array(Type.String({ pattern: ARTIFACT_ID.source }), {
				minItems: 1,
				maxItems: MAX_SHOWN,
				description: "Artifacts in the owner's Library to show as cards, by the id `publish` returned.",
			}),
		),
	},
	describe: "`artifacts` shows artifacts already published, by the id `publish` returned, each as its card.",
	present: (args) => ids(args).length > 0,
	refuse: (args) => {
		if (args.artifacts === undefined) return undefined;
		const given = ids(args);
		if (!Array.isArray(args.artifacts) || given.length !== args.artifacts.length)
			return "artifacts is a list of artifact ids";
		return new Set(given).size === given.length ? undefined : "each artifact once";
	},
	prepare: async (args, api, ctx) => {
		const given = ids(args);
		if (given.length === 0) return undefined;
		const library = (await api.snapshot(Artifacts, ctx))?.artifacts ?? {};
		const missing = given.filter((id) => library[id] === undefined);
		if (missing.length > 0) {
			const known = Object.entries(library)
				.filter(([, artifact]) => artifact.chat === Number(api.conversationId))
				.map(([id, artifact]) => `${id} (${artifact.title})`);
			return (
				`no artifact ${missing.join(", ")} in the Library` +
				(known.length === 0 ? "; publish it first" : `; this chat's are ${known.join(", ")}`)
			);
		}
		const shown = given.map((id) => ({ id, n: library[id]?.versions.length ?? 0 }));
		return { receipt: { kind: "artifacts", artifacts: shown } };
	},
};
