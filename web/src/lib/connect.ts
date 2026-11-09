/**
 * What the connect card shows (`../app/ConnectFlow.tsx`), from the daemon's view of a connection and the card's own
 * sign-in, if it started one. Pure, like `chat.ts`.
 */
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

/** The access an owner chooses for a connection before signing in: one row per scope, the required one fixed. */
export type ScopeChoices = {
	readonly required?: { readonly scope: string; readonly label: string };
	readonly choices: readonly { readonly scope: string; readonly label: string }[];
	/** What changing access means, said under the choices. */
	readonly note: string;
};

const GOOGLE = "https://www.googleapis.com/auth/";

/** The connections whose access the owner manages in the permissions dialog, by their name in the daemon. */
export const SCOPE_CHOICES: { readonly [connection: string]: ScopeChoices } = {
	gmail: {
		required: { scope: `${GOOGLE}gmail.readonly`, label: "Read email" },
		choices: [
			{ scope: `${GOOGLE}gmail.send`, label: "Send email" },
			{ scope: `${GOOGLE}gmail.modify`, label: "Archive, trash, mark read and manage labels" },
		],
		note: "Changing access signs in again. Sending and mailbox changes still ask you to approve each action.",
	},
	calendar: {
		required: { scope: `${GOOGLE}calendar.readonly`, label: "Read your calendars and events" },
		choices: [{ scope: `${GOOGLE}calendar.events`, label: "Create, change and answer events" }],
		note: "Changing access signs in again. Creating, changing, answering and deleting events still ask you to approve each one.",
	},
	contacts: {
		required: { scope: `${GOOGLE}contacts.readonly`, label: "Read your contacts" },
		choices: [
			{ scope: `${GOOGLE}contacts.other.readonly`, label: "People you've emailed" },
			{ scope: `${GOOGLE}contacts`, label: "Add, change and delete contacts" },
		],
		note: "Changing access signs in again. Adding, changing and deleting contacts still ask you to approve each one.",
	},
	drive: {
		required: { scope: `${GOOGLE}drive.readonly`, label: "Find and read your files, including Docs and Sheets" },
		choices: [
			{ scope: `${GOOGLE}drive.file`, label: "Create files" },
			{ scope: `${GOOGLE}spreadsheets`, label: "Change your spreadsheets" },
			{ scope: `${GOOGLE}documents`, label: "Change your documents" },
			{ scope: `${GOOGLE}drive`, label: "Change any of your files" },
		],
		note: "Changing access signs in again. Every change (creating, replacing or adding to a Doc's text, renaming and trashing files, a Sheet's rows, cells and tabs, a reply to a comment) still asks you to approve it; banda never shares a file or deletes one for good.",
	},
	github: {
		choices: [
			{ scope: "repo", label: "Repositories, including private repositories" },
			{ scope: "read:org", label: "Organization and team information" },
			{ scope: "notifications", label: "Read and manage notifications" },
			{ scope: "gist", label: "Read and manage gists" },
			{ scope: "security_events", label: "Repository security alerts" },
			{ scope: "project", label: "Read and manage projects" },
			{ scope: "read:project", label: "Read projects" },
			{ scope: "admin:org", label: "Administer organizations" },
			{ scope: "write:org", label: "Manage organization membership and teams" },
			{ scope: "delete_repo", label: "Delete repositories" },
		],
		note: "Changing access signs in again. Actions that change GitHub still ask you to approve them.",
	},
};

export const scopeChoicesOf = (connection: string | undefined): ScopeChoices | undefined =>
	connection !== undefined && Object.hasOwn(SCOPE_CHOICES, connection) ? SCOPE_CHOICES[connection] : undefined;
