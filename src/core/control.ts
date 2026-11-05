/**
 * Pause (DESIGN.md "The app"): the control room's one switch that stops everything at once: every chat's run
 * and the inputs queued behind it, and every routine, which fires nothing until the owner
 * resumes. The switch is the `Control` doc's `paused`, written first, so a routine that wakes while the rest is being
 * stopped already finds it set; routines' due times missed meanwhile come together as one wake each after the resume. The
 * owner's own messages still run: they are the owner's decision.
 */
import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { log } from "./activity.ts";
import { agentWords, isArchived } from "./agents.ts";
import { Control, RoutineRefused, Routines, routineAgent } from "./routines.ts";
import { context } from "./store.ts";
import { Routes, stop } from "./turn.ts";

type Reconcile = (harness: Harness, ctx?: Context) => Promise<void>;

/** Pause everything: routines hold, and every chat stops what it is doing. */
export async function pause(harness: Harness, reconcile: Reconcile, now: number, ctx: Context = context) {
	await harness.commit(async (tx) => {
		const control = await tx.doc(Control);
		if (control.paused !== undefined) return;
		control.paused = now;
		await log(tx, { at: now, what: "You paused everything" });
	}, ctx);
	// no routine runs while paused: their tasks go
	await reconcile(harness, ctx);
	const homes = Object.keys((await harness.snapshot(Routes, ctx))?.chats ?? {});
	for (const chat of homes) await stop(harness, Number(chat), ctx);
}

/** Resume: routines run again, each due time missed meanwhile as one wake. */
export async function resume(harness: Harness, reconcile: Reconcile, now: number, ctx: Context = context) {
	await harness.commit(async (tx) => {
		const control = await tx.doc(Control);
		if (control.paused === undefined) return;
		delete control.paused;
		await log(tx, { at: now, what: "You resumed" });
	}, ctx);
	await reconcile(harness, ctx);
}

/** Pause or resume one routine, as the owner; false when there is no such routine. */
export async function pauseRoutine(
	harness: Harness,
	reconcile: Reconcile,
	name: string,
	paused: boolean,
	now: number,
	ctx: Context = context,
): Promise<boolean> {
	const found = await harness.commit(async (tx) => {
		const record = (await tx.doc(Routines)).routines[name];
		if (record === undefined) return false;
		// an archived agent's routines stay paused: restoring it is the owner's first step
		const agent = routineAgent(record);
		if (!paused && (await isArchived(tx, agent)))
			throw new RoutineRefused(`${await agentWords(tx, agent)} is archived: restore it from Settings first`, 409);
		if (paused) record.paused = "owner";
		else {
			delete record.paused;
			// its runs a day count from the resume
			record.wakes = [];
		}
		await log(tx, { at: now, routine: name, what: paused ? "You paused it" : "You resumed it" });
		return true;
	}, ctx);
	if (found) await reconcile(harness, ctx);
	return found;
}
