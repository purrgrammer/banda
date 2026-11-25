/**
 * An act on a wallet's key the owner takes through banda's desktop app (show, restore, export or delete a key, move
 * signing here): none fails in silence (web/src/lib/attempt.ts). The app answers `{ ok }` or a refusal's code, said in
 * the owner's words (`desktopFailure`); a call that throws instead (the bridge refused this page, the signer would
 * not start) says what did not happen and offers Try again, which runs the whole act again, its answer included.
 */
import { toast } from "sonner";
import { sayFailed } from "../lib/attempt.ts";
import { desktopFailure } from "./wallets.ts";

/** What the desktop app answers a wallet act. */
export type DesktopAnswer = { readonly ok: true } | { readonly ok: false; readonly code: string };

export type DesktopAct = {
	/** What the act does, as "Couldn't …" says it when the call throws: "show the key". */
	readonly what: string;
	/** What the app's refusal says did not happen: "The key wasn't shown". */
	readonly refused: string;
	readonly run: () => Promise<DesktopAnswer>;
	/** The act was done. */
	readonly onDone?: () => void;
	/** The app refused with `code`; true when the page says so itself, so no note is shown. */
	readonly onRefused?: (code: string) => boolean;
	/** After any answer or failure: a busy state ends. */
	readonly onSettled?: () => void;
};

/** Runs `act`, saying its refusal or failure in words. */
export function desktopAct(act: DesktopAct): Promise<void> {
	return act
		.run()
		.then(
			(answer) => {
				if (answer.ok) act.onDone?.();
				else if (act.onRefused?.(answer.code) !== true)
					toast.error(act.refused, { description: desktopFailure(answer.code) });
			},
			(error: unknown) => sayFailed(act.what, error, () => void desktopAct(act)),
		)
		.finally(() => act.onSettled?.());
}
