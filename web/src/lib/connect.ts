/**
 * What the connect card shows (`../app/ConnectFlow.tsx`), from the daemon's view of a connection and the card's own
 * sign-in, if it started one. Pure, like `chat.ts`.
 */
import type { Access } from "../../../src/core/connections.ts";
import type { AccountView, ConnectionView } from "../../../src/server/api.ts";
import type { ConnectState } from "../chat/Connect.tsx";

/** The accounts of a connection that can be used now: signed in, and not waiting to sign in again. */
export const freshAccounts = (view: ConnectionView | undefined): readonly AccountView[] =>
	(view?.accounts ?? []).filter((account) => account.stale !== true);

export type Phase =
	| { readonly kind: "idle" }
	/** `before`: when the sign-in the daemon last finished was, as this card started its own (clocks may differ). */
	| { readonly kind: "started"; readonly before?: number | undefined; readonly url?: string | undefined }
	| { readonly kind: "failed"; readonly why: string };

/** What the card shows, from the daemon's view of the connection and this card's own sign-in, if it started one. */
export function connectState(
	view: ConnectionView | undefined,
	phase: Phase,
	agent: string | undefined,
	why: string,
): ConnectState {
	if (phase.kind === "failed") return { kind: "failed", why: phase.why };
	const fresh = freshAccounts(view);
	const label = (key: string) => fresh.find((account) => account.account === key)?.label ?? key;
	if (phase.kind === "started") {
		const finished = view?.finished;
		if (finished !== undefined && finished.at !== phase.before && finished.agent === agent) {
			if (finished.enabled === false)
				return {
					kind: "share",
					login: label(finished.account),
					...(finished.problem === undefined ? {} : { why: finished.problem }),
				};
			return { kind: finished.known ? "already" : "done", login: label(finished.account) };
		}
		if (view?.state === "signing-in" && view.code !== undefined)
			return { kind: "code", code: view.code.code, url: view.code.page };
		if (view?.state === "problem") return { kind: "failed", why: view.problem ?? "The sign-in did not finish." };
		if (phase.url !== undefined) return { kind: "code", url: phase.url };
	}
	// a sign-in by code started elsewhere for this agent (the phone came back to it): the same card
	if (view?.state === "signing-in" && view.code !== undefined && view.code.agent === agent)
		return { kind: "code", code: view.code.code, url: view.code.page };
	if (agent !== undefined) {
		const mine = fresh.filter((account) => account.agents.includes(agent));
		if (mine.length > 0) return { kind: "done", login: mine.map((account) => account.label).join(", ") };
		if (fresh.length === 1) return { kind: "share", login: (fresh[0] as AccountView).label };
		if (fresh.length > 1) return { kind: "known", logins: fresh.map((account) => account.label) };
	}
	return { kind: "connect", why };
}

/** One row of access: the scopes it stands for, taken together, and its words. */
export type ScopeChoice = { readonly label: string; readonly note?: string; readonly scopes: readonly string[] };

/** The scopes a row stands for. */
export const scopesOfChoice = (choice: ScopeChoice): readonly string[] => choice.scopes;

/** The access an owner chooses for a connection before signing in: one row per scope or bundle, the required one fixed. */
export type ScopeChoices = {
	readonly required?: ScopeChoice;
	readonly choices: readonly ScopeChoice[];
	/** What changing access means, said under the choices. */
	readonly note: string;
};

/**
 * The access a connection banda ships offers, as its definition words it: `required` the scopes every account of it
 * asks for, which its required row stands for. Undefined for a connection without choices.
 */
export function scopeChoicesOf(access: Access | undefined, required: readonly string[] = []): ScopeChoices | undefined {
	if (access === undefined) return undefined;
	return {
		...(access.required === undefined ? {} : { required: { label: access.required, scopes: required } }),
		choices: access.choices,
		note: access.note,
	};
}
