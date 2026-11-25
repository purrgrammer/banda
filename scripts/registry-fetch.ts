import { parseRetryAfter } from "../src/core/retry-after.ts";

/**
 * HTTP for the supply-chain scripts (the npm registry, OSV), asking again on a rate limit (429) or a server fault (5xx)
 * a bounded number of times, after the wait the server names or a doubling backoff.
 */
const ATTEMPTS = 5;
const MAX_WAIT = 60_000;

/**
 * How long to wait before asking again: the registry's `Retry-After` (seconds or a date) when it sends one, bounded.
 */
export function retryDelay(retryAfter: string | null, attempt: number, now = Date.now()): number {
	const asked = parseRetryAfter(retryAfter, now);
	return asked === undefined ? 1000 * 2 ** (attempt - 1) : Math.min(asked, MAX_WAIT);
}

/** The answer to `url`, asked again while the fault is passing; any other status than 2xx fails. */
export async function fetchRetrying(url: string, init: RequestInit = {}): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(url, init);
		if (response.ok) return response;
		const transient = response.status === 429 || response.status >= 500;
		if (attempt === ATTEMPTS || !transient) throw new Error(`${url} answered ${response.status}`);
		await response.body?.cancel();
		await new Promise((resolve) => setTimeout(resolve, retryDelay(response.headers.get("retry-after"), attempt)));
	}
}

async function json<T>(url: string, response: Response): Promise<T> {
	const text = await response.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${url} answered ${response.headers.get("content-type")}, not JSON: ${text.slice(0, 40)}`);
	}
}

export async function getJson<T>(url: string): Promise<T> {
	return json<T>(url, await fetchRetrying(url, { headers: { accept: "application/json" } }));
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
	const response = await fetchRetrying(url, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return json<T>(url, response);
}

export async function getBytes(url: string): Promise<Buffer> {
	return Buffer.from(await (await fetchRetrying(url)).arrayBuffer());
}
