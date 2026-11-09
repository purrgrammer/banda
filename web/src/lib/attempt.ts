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

/**
 * Run an action the owner took; on failure, a quiet note says `what` did not happen, why, and offers Try again. Resolves
 * with the action's result, or undefined when it failed.
 */
export async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		const retry =
			error instanceof Unauthorized ? undefined : { label: "Try again", onClick: () => void attempt(what, run) };
		toast.error(`Couldn't ${what}`, {
			description: failureWords(error),
			...(retry === undefined ? {} : { action: retry }),
		});
		return undefined;
	}
}
