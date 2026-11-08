/**
 * Provider accounts: several sign-ins or keys of one backend, as connections have several accounts. The first account
 * of a backend is its plain id (`anthropic`); another is `<backend>@<account>` (`anthropic@work`), a clone of the
 * backend's pi-ai provider under that id. pi-ai keys credentials, auth and usage by provider id, so a clone's
 * credential is its own and a run on it is counted as its own (`anthropic@work/<model>` in the usage ledger).
 *
 * The ids and names here are plain data, shared with the web; the clone itself is `./account-provider.ts`.
 */
const SEPARATOR = "@";

/** An account by its parts: the backend's provider id, and the account's slug for any but the first. */
export type AccountRef = { readonly provider: string; readonly account?: string };

export function parseAccount(id: string): AccountRef {
	const at = id.indexOf(SEPARATOR);
	if (at === -1) return { provider: id };
	return { provider: id.slice(0, at), account: id.slice(at + 1) };
}

export const formatAccount = ({ provider, account }: AccountRef): string =>
	account === undefined ? provider : `${provider}${SEPARATOR}${account}`;

/** The backend an account belongs to: `anthropic` for `anthropic@work` and for `anthropic`. */
export const backendOf = (id: string): string => parseAccount(id).provider;

export const isClone = (id: string): boolean => parseAccount(id).account !== undefined;

/** The most characters an account's label takes. */
export const MAX_LABEL = 60;

/** An account slug for `label`, unique among `taken` (slugs already used by the backend). */
export function accountSlug(label: string, taken: ReadonlySet<string>): string {
	const base =
		label
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "account";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** How an account is named to the owner: the backend's name, with its label once the backend has more than one. */
export const accountTitle = (name: string, label: string | undefined, many: boolean): string =>
	many && label !== undefined && label !== name ? `${name} · ${label}` : name;
