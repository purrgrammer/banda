/**
 * An agent's first message (DESIGN.md "The app"): `POST /api/agents/:id/greet`, which the app sends when the owner
 * opens an agent's chat that does not exist yet. The daemon makes the chat and queues the greeting's input in one
 * commit (`core.greet`), so the agent's own run says who it is; a chat that exists is left as it is, whoever asks and
 * however often.
 */
import type { AreaModule } from "./area.ts";

const PATH = /^\/agents\/([a-z0-9-]+)\/greet$/;

/** `POST /api/agents/:id/greet`'s answer: the agent's chat. */
export type Greeted = { readonly chat: number };

export const greeting: AreaModule = {
	start: (deps) => ({
		route: async (request) => {
			const agent = PATH.exec(request.path)?.[1];
			if (agent === undefined) return undefined;
			if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
			const greeted = await deps.core.greet(deps.harness, agent);
			if (greeted === undefined) return { status: 404, body: { error: "no such agent" } };
			deps.changed();
			const reply: Greeted = { chat: greeted.chat };
			return { body: reply };
		},
	}),
};
