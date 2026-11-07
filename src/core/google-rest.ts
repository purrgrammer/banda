/** One bounded request to a Google REST API, shared by the built-in adapters. Errors never hold a URL, body or token. */
import { Unauthorized } from "./mcp.ts";

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type GoogleApi = {
	/** The service as errors name it: "Gmail". */
	readonly service: string;
	/** The address every path is under, without a trailing slash. */
	readonly base: string;
};

const REASONS: { readonly [reason: string]: string } = {
	SERVICE_DISABLED: "the {service} API is not enabled for banda's Google Cloud project",
	ACCESS_TOKEN_SCOPE_INSUFFICIENT: "the sign-in did not grant this access; sign in again and allow it",
};

/**
 * Google's machine-readable reason for a refusal ("SERVICE_DISABLED"), from a bounded read of its error body. Only a
 * bare code word is kept: the body's message holds URLs and project details that never reach an error.
 */
async function reasonOf(response: Response): Promise<string | undefined> {
	try {
		if (Number(response.headers.get("content-length")) > 16_384) {
			await response.body?.cancel();
			return undefined;
		}
		const text = await response.text();
		if (text.length > 16_384) return undefined;
		const error = (JSON.parse(text) as { error?: { details?: unknown; errors?: unknown } }).error;
		const details = Array.isArray(error?.details) ? error.details : [];
		const errors = Array.isArray(error?.errors) ? error.errors : [];
		for (const entry of [...details, ...errors]) {
			const reason = (entry as { reason?: unknown } | null)?.reason;
			if (typeof reason === "string" && /^[A-Za-z_]{1,64}$/.test(reason)) return reason;
		}
	} catch {}
	return undefined;
}

/** Google's refusal of a request: its words, and the status a caller may treat as an answer (a 409 for an id taken). */
export class GoogleRefused extends Error {
	override name = "GoogleRefused";
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export type GoogleMethod = "GET" | "POST" | "PATCH" | "DELETE";

export async function googleRequest(
	api: GoogleApi,
	fetcher: typeof fetch,
	token: string,
	path: string,
	signal?: AbortSignal,
	limit = MAX_RESPONSE_BYTES,
	method: GoogleMethod = "GET",
	body?: unknown,
): Promise<unknown> {
	const { service } = api;
	let response: Response;
	for (let attempt = 0; ; attempt++) {
		response = await fetcher(`${api.base}/${path}`, {
			method,
			redirect: "error",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			...(signal === undefined ? {} : { signal }),
		});
		// A GET retries safely; a change never does, because Google may have applied it (a free/busy query is a POST that
		// only reads, and it is cheap enough to fail and be asked again).
		if (method !== "GET" || attempt >= 2 || ![429, 500, 502, 503, 504].includes(response.status)) break;
		await response.body?.cancel();
		const retryAfter = Number(response.headers.get("retry-after"));
		const wait =
			Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(2000, retryAfter * 1000) : 200 * (attempt + 1);
		if (signal?.aborted) throw signal.reason ?? new Error(`${service} request was cancelled.`);
		if (wait > 0)
			await new Promise<void>((resolve, reject) => {
				const finish = () => {
					signal?.removeEventListener("abort", abort);
					resolve();
				};
				const timer = setTimeout(finish, wait);
				const abort = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					reject(signal?.reason ?? new Error(`${service} request was cancelled.`));
				};
				signal?.addEventListener("abort", abort, { once: true });
			});
	}
	if (response.status === 401) throw new Unauthorized(`${service} did not take the credentials`);
	if (!response.ok) {
		const reason = await reasonOf(response);
		const meaning = reason === undefined ? undefined : REASONS[reason]?.replace("{service}", service);
		const said = reason === undefined ? "" : ` (${reason})${meaning === undefined ? "" : `: ${meaning}`}`;
		throw new GoogleRefused(`${service} answered ${response.status}${said}`, response.status);
	}
	// a deletion answers 204 with nothing to read
	if (response.status === 204) {
		await response.body?.cancel();
		return {};
	}
	if (Number(response.headers.get("content-length")) > limit) {
		await response.body?.cancel();
		throw new Error(`${service}'s answer was too large`);
	}
	if (response.body === null) throw new Error(`${service} answered no data`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new Error(`${service}'s answer was too large`);
		}
		chunks.push(value);
	}
	return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
}
