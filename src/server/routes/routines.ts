/**
 * Routines in full: the owner makes one (`POST /api/routines`), changes one (`POST /api/routines/:id/edit`, or its
 * schedule alone with `/when`) and runs one now (`POST /api/routines/:id/run`), each in effect at once and answered
 * with the control view. On start it finishes an owner's edit a restart cut short, so the box holds what the store
 * accepted. Its history (`GET /api/routines/:id/runs?before=`) reads the runs its record keeps, a page at a time; a
 * run's line in a chat names its run's conversation (`GET /api/chats/:chat/items/:entry/run`). A
 * routine's id is `<agent>/<name>` for one in its agent's folder, `<name>` for a shared one; an action's body names it
 * again (`id`), which tells an app of this build from one that named routines by name alone (`requested`).
 */

import { routineName } from "../../core/routines.ts";
import { BadRequest } from "../http.ts";
import { lineRun, routineRuns } from "../routine-runs.ts";
import { changeRoutine, createRoutine, finishEdits, requested, runNow } from "../routines.ts";
import type { AreaModule } from "./area.ts";

const PATH = /^\/routines\/((?:[a-z0-9-]+\/)?[a-z0-9-]+)\/(when|edit|run)$/;
const RUNS = /^\/routines\/((?:[a-z0-9-]+\/)?[a-z0-9-]+)\/runs$/;
const LINE = /^\/chats\/(\d+)\/items\/(\d+)\/run$/;

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
					const id = await createRoutine(
						deps.harness,
						deps.workspace,
						reconcile,
						{ agent, description, when, ask, ...(zone === undefined ? {} : { zone }) },
						Date.now(),
					);
					deps.changed();
					return { body: { id, name: routineName(id), control: await deps.control() } };
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
				const line = LINE.exec(request.path);
				if (line !== null) {
					if (request.method !== "GET") return { status: 405, body: { error: "method not allowed" } };
					const run = await lineRun(deps.harness, Number(line[1]), Number(line[2]));
					return run === undefined
						? { status: 404, body: { error: "this line has no run of its own" } }
						: { body: { run } };
				}
				const match = PATH.exec(request.path);
				if (match === null) return undefined;
				if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const [, path = "", action] = match;
				const body = await request.json();
				if (body.id !== undefined && typeof body.id !== "string")
					throw new BadRequest("id is the routine's id, as the path names it");
				// which routine: the path's id, named again in the body by an app of this build
				const id = requested(path, body.id);
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
						id,
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
					await runNow((routine, click) => deps.core.runRoutine(deps.harness, routine, click), id, key);
				}
				deps.changed();
				return { body: await deps.control() };
			},
		};
	},
};
