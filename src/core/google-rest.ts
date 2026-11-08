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
		const status = (error as { status?: unknown } | undefined)?.status;
		for (const reason of [
			...[...details, ...errors].map((entry) => (entry as { reason?: unknown } | null)?.reason),
			status,
		])
			if (typeof reason === "string" && /^[A-Za-z_]{1,64}$/.test(reason)) return reason;
	} catch {}
	return undefined;
}

/** A refusal from Google, with its status and its machine-readable reason when it gave one. */
export class GoogleError extends Error {
	readonly status: number;
	readonly reason: string | undefined;
	constructor(message: string, status: number, reason: string | undefined) {
		super(message);
		this.status = status;
		this.reason = reason;
	}
}

export type GoogleMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** The answer to one request, once it is a success: retried while Google is busy, refused in words otherwise. */
async function googleResponse(
	api: GoogleApi,
	fetcher: typeof fetch,
	token: string,
	path: string,
	signal: AbortSignal | undefined,
	method: GoogleMethod,
	body: unknown,
	accept: string,
	ifMatch?: string,
	/** A body that is not JSON (an upload), with its own content type; used instead of `body`. */
	raw?: { readonly type: string; readonly body: string },
): Promise<Response> {
	const { service } = api;
	let response: Response;
	for (let attempt = 0; ; attempt++) {
		response = await fetcher(`${api.base}/${path}`, {
			method,
			redirect: "error",
			headers: {
				authorization: `Bearer ${token}`,
				accept,
				...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
				...(raw !== undefined
					? { "content-type": raw.type }
					: body === undefined
						? {}
						: { "content-type": "application/json" }),
			},
			...(raw !== undefined ? { body: raw.body } : body === undefined ? {} : { body: JSON.stringify(body) }),
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
		throw new GoogleError(`${service} answered ${response.status}${said}`, response.status, reason);
	}
	return response;
}

/**
 * At most `limit` bytes of an answer. A cut answer is refused, unless `cut` says the caller takes the bytes up to the
 * limit (a file's text, which says it was truncated).
 */
async function boundedBytes(
	response: Response,
	service: string,
	limit: number,
	cut: boolean,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
	if (!cut && Number(response.headers.get("content-length")) > limit) {
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
		if (size + value.byteLength > limit) {
			await reader.cancel();
			if (!cut) throw new Error(`${service}'s answer was too large`);
			chunks.push(value.subarray(0, limit - size));
			return { bytes: Buffer.concat(chunks), truncated: true };
		}
		size += value.byteLength;
		chunks.push(value);
	}
	return { bytes: Buffer.concat(chunks), truncated: false };
}

export async function googleRequest(
	api: GoogleApi,
	fetcher: typeof fetch,
	token: string,
	path: string,
	signal?: AbortSignal,
	limit = MAX_RESPONSE_BYTES,
	method: GoogleMethod = "GET",
	body?: unknown,
	/** The version the change was made from: Google refuses it (412) when the thing changed since. */
	ifMatch?: string,
): Promise<unknown> {
	const response = await googleResponse(api, fetcher, token, path, signal, method, body, "application/json", ifMatch);
	// a deletion answers 204 with nothing to read
	if (response.status === 204) {
		await response.body?.cancel();
		return {};
	}
	const { bytes } = await boundedBytes(response, api.service, limit, false);
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		// the parser's own words quote the answer
		throw new Error(`${api.service} answered something that is not JSON`);
	}
}

/**
 * A GET whose answer is text, not JSON (a file's contents): the same bounds, retries and refusals, with the bytes past
 * `limit` left unread and a character cut at the limit dropped rather than decoded as garbage.
 */
export async function googleText(
	api: GoogleApi,
	fetcher: typeof fetch,
	token: string,
	path: string,
	signal?: AbortSignal,
	limit = MAX_RESPONSE_BYTES,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
	const response = await googleResponse(api, fetcher, token, path, signal, "GET", undefined, "*/*");
	const { bytes, truncated } = await boundedBytes(response, api.service, limit, true);
	return { text: new TextDecoder().decode(bytes, { stream: truncated }), truncated };
}

/**
 * A change whose body is text of its own type (an upload), answered in JSON. Never retried: Google may have applied
 * it. The same bounds and refusals as `googleRequest`.
 */
export async function googleUpload(
	api: GoogleApi,
	fetcher: typeof fetch,
	token: string,
	path: string,
	method: "POST" | "PATCH",
	contentType: string,
	body: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await googleResponse(
		api,
		fetcher,
		token,
		path,
		signal,
		method,
		undefined,
		"application/json",
		undefined,
		{
			type: contentType,
			body,
		},
	);
	const { bytes } = await boundedBytes(response, api.service, MAX_RESPONSE_BYTES, false);
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw new Error(`${api.service} answered something that is not JSON`);
	}
}
