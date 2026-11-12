/**
 * Routines in full: the owner makes one (`POST /api/routines`), changes one (`POST /api/routines/:name/edit`, or its
 * schedule alone with `/when`) and runs one now (`POST /api/routines/:name/run`), each in effect at once and answered
 * with the control view. On start it finishes an owner's edit a restart cut short, so the box holds what the store
 * accepted. Its history (`GET /api/routines/:name/runs?before=`) reads the runs its record keeps, a page at a time.
 */

import { BadRequest } from "../http.ts";
import { routineRuns } from "../routine-runs.ts";
import { changeRoutine, createRoutine, finishEdits, runNow } from "../routines.ts";
import type { AreaModule } from "./area.ts";

const PATH = /^\/routines\/([a-z0-9-]+)\/(when|edit|run)$/;
const RUNS = /^\/routines\/([a-z0-9-]+)\/runs$/;

const SHA = /^[0-9a-f]{64}$/;

/** An optional string field of a body, at most `max` long. */
const optional = (body: Record<string, unknown>, key: string, max: number): string | undefined => {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > max) throw new BadRequest(`${key} is text, at most ${max} long`);
	return value;
};

export const routines: AreaModule = {
	start: (deps) => {
		const reconcile = deps.core.reconcile;
		void finishEdits(deps.harness, deps.workspace).catch((error: unknown) =>
			deps.log(`routines: an edit is not in the box yet: ${(error as Error).message}`),
		);
		return {
			route: async (request) => {
				if (request.path === "/routines") {
					if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
					const body = await request.json();
					const agent = optional(body, "agent", 64);
					const description = optional(body, "description", 200);
					const when = optional(body, "when", 200);
					const ask = optional(body, "ask", 8000);
					const zone = optional(body, "zone", 64);
					if (agent === undefined || description === undefined || when === undefined || ask === undefined)
						throw new BadRequest("a routine names its agent, what it is for, when it runs and what it does");
					const name = await createRoutine(
						deps.harness,
						deps.workspace,
						reconcile,
						{ agent, description, when, ask, ...(zone === undefined ? {} : { zone }) },
						Date.now(),
					);
					deps.changed();
					return { body: { name, control: await deps.control() } };
				}
				const history = RUNS.exec(request.path);
				if (history !== null) {
					if (request.method !== "GET") return { status: 405, body: { error: "method not allowed" } };
					const given = request.url.searchParams.get("before");
					const before = given === null ? undefined : Number(given);
					if (before !== undefined && !Number.isSafeInteger(before)) throw new BadRequest("before is when a run was");
					const page = await routineRuns(deps.harness, history[1] ?? "", before);
					return page === undefined ? { status: 404, body: { error: "no such routine" } } : { body: page };
				}
				const match = PATH.exec(request.path);
				if (match === null) return undefined;
				if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const [, name = "", action] = match;
				const body = await request.json();
				if (action === "when" || action === "edit") {
					const { sha } = body;
					if (typeof sha !== "string" || !SHA.test(sha)) throw new BadRequest("sha is the hash of the version you saw");
					const when = optional(body, "when", 200);
					const description = optional(body, "description", 200);
					const ask = optional(body, "ask", 8000);
					if (action === "when" && when === undefined) throw new BadRequest("when is one schedule line");
					await changeRoutine(
						deps.harness,
						deps.workspace,
						reconcile,
						name,
						{
							...(when === undefined ? {} : { when }),
							...(description === undefined ? {} : { description }),
							...(ask === undefined ? {} : { ask }),
						},
						sha,
						Date.now(),
					);
				} else {
					const { key } = body;
					if (typeof key !== "string") throw new BadRequest("key names the click");
					await runNow((routine, click) => deps.core.runRoutine(deps.harness, routine, click), name, key);
				}
				deps.changed();
				return { body: await deps.control() };
			},
		};
	},
};
