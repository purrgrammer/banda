/**
 * A service's "ask again later": `Retry-After` (RFC 9110 §10.2.3) read the one way, and carried from where a request was
 * refused to whoever made it, so a watch, a card or an agent's read waits until then rather than asking again sooner.
 */

/** `Retry-After` as milliseconds from `now`: delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const at = Date.parse(trimmed);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The longest a refusal may hold anything off: a service that says a day is asked again in an hour. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** When a refused answer (`status`) says to ask again, as a time: a 429 or a 503 with `Retry-After`; else undefined. */
export function retryAtOf(status: number, header: string | null | undefined, now = Date.now()): number | undefined {
	if (status !== 429 && status !== 503) return undefined;
	const ms = parseRetryAfter(header, now);
	return ms === undefined ? undefined : now + Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** The service refused for now and said when to ask again (`retryAt`, ms). */
export class RetryLater extends Error {
	readonly retryAt: number;
	constructor(message: string, retryAt: number) {
		super(message);
		this.retryAt = retryAt;
	}
}

/** When `error` says to ask again, as a result's `retryAt`: any error that carries one. */
export const retryOf = (error: unknown): { readonly retryAt?: number } => {
	const at = error instanceof Error ? (error as { retryAt?: unknown }).retryAt : undefined;
	return typeof at === "number" && Number.isFinite(at) ? { retryAt: at } : {};
};
