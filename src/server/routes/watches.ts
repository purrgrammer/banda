/**
 * Watches in full: the owner follows an object (`POST /api/watches`), allows or declines the box's change to one
 * (`POST /api/watches/:name/accept` with the `sha` shown or null, `/decline`), changes what ends one and what matters
 * (`/edit` with the `sha` shown; `until: null` is any end), pauses, resumes or removes one, and looks now (`/check`),
 * each in effect at once and answered with the control view. On start it finishes an owner's edit a restart cut
 * short, so the box holds what the store accepted.
 */

import { BadRequest } from "../http.ts";
import { accept, changeWatch, checkNow, createWatch, decline, finishEdits, pause, remove } from "../watches.ts";
import type { AreaModule } from "./area.ts";

const PATH = /^\/watches\/([a-z0-9-]+)\/(accept|decline|edit|pause|resume|remove|check)$/;
const SHA = /^[0-9a-f]{64}$/;

/** An optional string field of a body, at most `max` long. */
const optional = (body: Record<string, unknown>, key: string, max: number): string | undefined => {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > max) throw new BadRequest(`${key} is text, at most ${max} long`);
	return value;
};

export const watches: AreaModule = {
	start: (deps) => {
		const reconcile = deps.core.reconcile;
		void finishEdits(deps.harness, deps.workspace).catch((error: unknown) =>
			deps.log(`watches: an edit is not in the box yet: ${(error as Error).message}`),
		);
		return {
			route: async (request) => {
				if (request.path === "/watches") {
					if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
					const body = await request.json();
					const agent = optional(body, "agent", 64);
					const object = optional(body, "object", 500);
					const account = optional(body, "account", 200);
					const until = optional(body, "until", 32);
					const ask = optional(body, "ask", 8000);
					if (agent === undefined || object === undefined)
						throw new BadRequest("a watch names its agent and the link it follows");
					const name = await createWatch(
						deps.harness,
						deps.workspace,
						reconcile,
						(harness, watch, ctx) => deps.core.lookWatch(harness, watch, ctx),
						{
							agent,
							object,
							...(account === undefined ? {} : { account }),
							...(until === undefined ? {} : { until }),
							...(ask === undefined ? {} : { ask }),
						},
						Date.now(),
					);
					deps.changed();
					return { body: { name, control: await deps.control() } };
				}
				const match = PATH.exec(request.path);
				if (match === null) return undefined;
				if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const [, name = "", action] = match;
				const body = await request.json();
				const now = Date.now();
				if (action === "accept") {
					const { sha } = body;
					if (sha !== null && (typeof sha !== "string" || !SHA.test(sha)))
						throw new BadRequest("sha is the hash of the version you saw, or null for a removal");
					await accept(
						deps.harness,
						deps.workspace,
						reconcile,
						(harness, watch, ctx) => deps.core.lookWatch(harness, watch, ctx),
						name,
						sha,
						now,
					);
				} else if (action === "edit") {
					const { sha, until } = body;
					if (typeof sha !== "string" || !SHA.test(sha)) throw new BadRequest("sha is the hash of the version you saw");
					if (until !== undefined && until !== null && (typeof until !== "string" || until.length > 32))
						throw new BadRequest("until is one of its ends, or null for any of them");
					const ask = optional(body, "ask", 8000);
					await changeWatch(
						deps.harness,
						deps.workspace,
						reconcile,
						name,
						{
							...(until === undefined ? {} : { until: until as string | null }),
							...(ask === undefined ? {} : { ask }),
						},
						sha,
						now,
					);
				} else if (action === "decline") await decline(deps.harness, deps.workspace, name);
				else if (action === "remove") await remove(deps.harness, deps.workspace, reconcile, name, now);
				else if (action === "pause" || action === "resume") {
					const found = await pause(deps.harness, reconcile, name, action === "pause", now);
					if (!found) throw new BadRequest(`there is no watch named ${name}`, 404);
				} else {
					const { key } = body;
					if (typeof key !== "string") throw new BadRequest("key names the click");
					const looked = await checkNow((watch, click) => deps.core.checkWatch(deps.harness, watch, click), name, key);
					deps.changed();
					return { body: { looked, control: await deps.control() } };
				}
				deps.changed();
				return { body: await deps.control() };
			},
		};
	},
};
