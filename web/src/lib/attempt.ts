/**
 * Recoverable failures (DESIGN.md "Copy": an error names who, what and the fix): every action the owner takes runs
 * through `attempt`, so none fails in silence. A failure says what did not happen and why, in words: the daemon's own
 * refusal when it answered (it says what to change), or that banda on this computer did not answer; and it offers
 * Try again, which runs the same action again.
 */
import { toast } from "sonner";
import { Refused, Unauthorized } from "./api.ts";

/** Why an action failed, in the owner's words. */
export function failureWords(error: unknown): string {
	if (error instanceof Unauthorized) return "This page lost its sign-in to banda: open the link banda printed again.";
	if (error instanceof Refused) {
		if (error.status >= 500) return "banda on this computer hit a problem. Try again in a moment.";
		return error.message.replace(/^./, (c) => c.toUpperCase());
	}
	return "banda on this computer didn't answer. Check it's still running.";
}

/** A quiet note that `what` did not happen, why, and Try again, which calls `retry`. */
export function sayFailed(what: string, error: unknown, retry: () => void): void {
	toast.error(`Couldn't ${what}`, {
		description: failureWords(error),
		...(error instanceof Unauthorized ? {} : { action: { label: "Try again", onClick: retry } }),
	});
}

/**
 * Run an action the owner took; on failure, says so (`sayFailed`). Resolves with the action's result, or undefined when
 * it failed.
 */
export async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		sayFailed(what, error, () => void attempt(what, run));
		return undefined;
	}
}
