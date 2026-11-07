/**
 * OAuth for a connection (DESIGN.md "Connections"): the daemon signs in on the owner's behalf with the authorization
 * code flow and PKCE, as the MCP authorization spec asks. It finds the authorization server from the resource's
 * metadata, registers itself as a client when the server lets it, and sends the owner's browser to sign in; the
 * server sends it back to the daemon's own callback on loopback, which trades the code for tokens. A connection whose
 * file names its client (a server that registers none) signs in by code instead when the server offers it (RFC 8628):
 * the owner types a short code on the server's own page, from any device, while the daemon asks for the tokens. Tokens are
 * credentials: they live in `auth/` with the rest, never in the store, the box, a prompt or a log.
 */
import { createHash, randomBytes } from "node:crypto";

/** Where the daemon signs in, as discovered: the authorization server's endpoints and the scopes the resource wants. */
export type OAuthServer = {
	readonly issuer: string;
	/** RFC 9207: this issuer promises to identify itself in the authorization response. */
	readonly issuerParameter?: true;
	/** Google OAuth's RFC 8693 resource parameter is not part of this API's token exchange. */
	readonly resourceParameter?: false;
	readonly authorize: string;
	readonly token: string;
	readonly register?: string;
	/** Where a sign-in by code starts (RFC 8628), when the server offers one. */
	readonly device?: string;
	readonly scopes?: readonly string[];
};

/** The client the daemon is at that server. */
export type OAuthClient = { readonly id: string; readonly secret?: string };

/** Banda's public Google OAuth client id; it identifies the app and is safe to ship with the daemon. */
export const DEFAULT_GOOGLE_CLIENT_ID = "199878157109-ge1kebauu0ec88f69ksn1skpacf8l7q1.apps.googleusercontent.com";

/** The installed Google client is public: desktop OAuth uses PKCE and cannot keep a client secret confidential. */
export function googleOAuthClient(id: string | undefined, secret: string | undefined): OAuthClient {
	const clientId = id || DEFAULT_GOOGLE_CLIENT_ID;
	return { id: clientId, ...(secret === undefined || secret === "" ? {} : { secret }) };
}

export type Tokens = {
	readonly access: string;
	readonly refresh?: string;
	/** When the access token stops working (epoch ms), if the server said. */
	readonly expires?: number;
	/** The scopes the server says it granted (RFC 6749 §5.1), when it said: the owner may have given less than asked. */
	readonly scopes?: readonly string[];
};

/** A sign-in in progress: what the callback needs to finish it. The state names it; the verifier proves it. */
export type Pending = {
	readonly connection: string;
	readonly state: string;
	readonly verifier: string;
	readonly redirect: string;
	readonly resource: string;
	readonly server: OAuthServer;
	readonly client: OAuthClient;
	readonly at: number;
	/** The agent the sign-in is for: the account is switched on for it once signed in. */
	readonly agent?: string;
};

const base64url = (bytes: Buffer) => bytes.toString("base64url");

function responseProblem(url: string, status: number, body: unknown): Error {
	const code =
		typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
			? body.error
			: undefined;
	const safeCode = code !== undefined && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? ` (${code})` : "";
	return new Error(`${new URL(url).host} answered ${status}${safeCode}`);
}

/** A fetch that never follows a redirect, and an answer read as JSON, or why not. */
async function json(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
	const response = await fetcher(url, { ...init, redirect: "error" });
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch {
		if (!response.ok) throw responseProblem(url, response.status, undefined);
		throw new Error(`${new URL(url).host} did not answer JSON`);
	}
	if (!response.ok) throw responseProblem(url, response.status, parsed);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${new URL(url).host} did not answer JSON`);
	return parsed as Record<string, unknown>;
}

/** A URL a server named, only https (or http on loopback, for a server on this machine). */
function endpoint(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`the server names no ${what}`);
	const url = new URL(value);
	if (url.username || url.password || url.hash)
		throw new Error(`The server's ${what} contains credentials or a fragment`);
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		throw new Error(`the server's ${what} is not https`);
	return url.toString();
}

/** The resource's metadata (RFC 9728): from the 401's header, else at its well-known place; undefined when none. */
async function resourceMetadata(fetcher: typeof fetch, resource: string): Promise<Record<string, unknown> | undefined> {
	const probe = await fetcher(resource, {
		method: "POST",
		redirect: "error",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
	}).catch(() => undefined);
	await probe?.body?.cancel();
	const header = probe?.headers.get("www-authenticate") ?? "";
	const named = /resource_metadata="([^"]+)"/.exec(header)?.[1];
	const url = new URL(resource);
	const candidates = [
		...(named === undefined ? [] : [new URL(named, resource).toString()]),
		`${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`,
		`${url.origin}/.well-known/oauth-protected-resource`,
	];
	for (const candidate of candidates) {
		const found = await json(fetcher, endpoint(candidate, "resource metadata")).catch(() => undefined);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Find where to sign in for `resource` (an MCP server's URL). */
export async function discover(resource: string, fetcher: typeof fetch = fetch): Promise<OAuthServer> {
	// Gmail's API is a first-party Google resource, not an RFC 9728 MCP server. Its user consent and token
	// endpoints are fixed by Google; tool access remains restricted to the scopes in the shipped connection file.
	const google = new URL(resource);
	if (
		google.protocol === "https:" &&
		google.hostname === "gmail.googleapis.com" &&
		google.pathname === "/gmail/v1/users/me"
	)
		return {
			issuer: "https://accounts.google.com",
			authorize: "https://accounts.google.com/o/oauth2/v2/auth",
			token: "https://oauth2.googleapis.com/token",
			resourceParameter: false,
		};
	const metadata = await resourceMetadata(fetcher, resource);
	const servers = Array.isArray(metadata?.authorization_servers) ? metadata.authorization_servers : [];
	const issuer = typeof servers[0] === "string" ? servers[0] : new URL(resource).origin;
	const at = new URL(endpoint(issuer, "authorization server"));
	if (at.search) throw new Error("The authorization server's issuer contains a query");
	const path = at.pathname === "/" ? "" : at.pathname.replace(/\/$/, "");
	let server: Record<string, unknown> | undefined;
	for (const candidate of [
		`${at.origin}/.well-known/oauth-authorization-server${path}`,
		`${at.origin}/.well-known/openid-configuration${path}`,
		`${at.origin}${path}/.well-known/openid-configuration`,
	]) {
		server = await json(fetcher, candidate).catch(() => undefined);
		if (server !== undefined) break;
	}
	if (server === undefined) throw new Error(`${at.host} says nothing of how to sign in`);
	if (server.issuer !== undefined && server.issuer !== issuer)
		throw new Error("The authorization server's issuer does not match its discovery address");
	const methods = server.code_challenge_methods_supported;
	if (Array.isArray(methods) && !methods.includes("S256")) throw new Error(`${at.host} does not take PKCE (S256)`);
	const scopes = Array.isArray(metadata?.scopes_supported)
		? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string")
		: undefined;
	return {
		issuer,
		...(server.authorization_response_iss_parameter_supported === true ? { issuerParameter: true as const } : {}),
		authorize: endpoint(server.authorization_endpoint, "sign-in page"),
		token: endpoint(server.token_endpoint, "token endpoint"),
		...(server.registration_endpoint === undefined
			? {}
			: { register: endpoint(server.registration_endpoint, "registration endpoint") }),
		...(server.device_authorization_endpoint === undefined
			? {}
			: { device: endpoint(server.device_authorization_endpoint, "device endpoint") }),
		...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
	};
}

/** Register the daemon as a public client that comes back to `redirect` (RFC 7591). */
export async function register(
	server: OAuthServer,
	redirect: string,
	fetcher: typeof fetch = fetch,
): Promise<OAuthClient> {
	if (server.register === undefined) throw new Error("the server lets no app register: it cannot be signed in to yet");
	const body = await json(fetcher, server.register, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "banda",
			redirect_uris: [redirect],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	if (typeof body.client_id !== "string") throw new Error("the server gave no client id");
	return { id: body.client_id, ...(typeof body.client_secret === "string" ? { secret: body.client_secret } : {}) };
}

/** A new sign-in: its state and verifier, and the page the owner's browser opens. */
export function begin(
	connection: string,
	resource: string,
	server: OAuthServer,
	client: OAuthClient,
	redirect: string,
	now: number,
	agent?: string,
): { readonly pending: Pending; readonly url: string } {
	const state = base64url(randomBytes(32));
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const url = new URL(server.authorize);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.id);
	url.searchParams.set("redirect_uri", redirect);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	if (server.resourceParameter !== false) url.searchParams.set("resource", resource);
	if (server.issuer === "https://accounts.google.com") {
		url.searchParams.set("access_type", "offline");
		url.searchParams.set("prompt", "consent");
	}
	if (server.scopes !== undefined) url.searchParams.set("scope", server.scopes.join(" "));
	return {
		pending: {
			connection,
			state,
			verifier,
			redirect,
			resource,
			server,
			client,
			at: now,
			...(agent === undefined ? {} : { agent }),
		},
		url: url.toString(),
	};
}

/** The tokens in a token endpoint's answer. */
function tokensOf(body: Record<string, unknown>, now: number, previous?: Tokens): Tokens {
	if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("the server gave no token");
	const refresh = typeof body.refresh_token === "string" ? body.refresh_token : previous?.refresh;
	// space-separated, as the RFC says; GitHub separates them with commas
	const scopes =
		typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter((scope) => scope !== "") : previous?.scopes;
	return {
		access: body.access_token,
		...(refresh === undefined ? {} : { refresh }),
		...(typeof body.expires_in === "number" ? { expires: now + body.expires_in * 1000 } : {}),
		...(scopes === undefined ? {} : { scopes }),
	};
}

async function tokenRequest(
	fetcher: typeof fetch,
	server: OAuthServer,
	client: OAuthClient,
	form: Record<string, string>,
): Promise<Record<string, unknown>> {
	const params = new URLSearchParams({ ...form, client_id: client.id });
	if (client.secret !== undefined) params.set("client_secret", client.secret);
	return json(fetcher, server.token, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: params.toString(),
	});
}

/** Trade the code the owner's browser came back with for tokens. */
export async function exchange(pending: Pending, code: string, now: number, fetcher: typeof fetch = fetch) {
	const body = await tokenRequest(fetcher, pending.server, pending.client, {
		grant_type: "authorization_code",
		code,
		redirect_uri: pending.redirect,
		code_verifier: pending.verifier,
		...(pending.server.resourceParameter === false ? {} : { resource: pending.resource }),
	});
	return tokensOf(body, now);
}

/** New tokens from the refresh token. */
export async function refresh(
	server: OAuthServer,
	client: OAuthClient,
	tokens: Tokens,
	resource: string,
	now: number,
	fetcher: typeof fetch = fetch,
): Promise<Tokens> {
	if (tokens.refresh === undefined) throw new Error("there is no refresh token: sign in again");
	const body = await tokenRequest(fetcher, server, client, {
		grant_type: "refresh_token",
		refresh_token: tokens.refresh,
		...(server.resourceParameter === false ? {} : { resource }),
	});
	return tokensOf(body, now, tokens);
}

/** A sign-in by code in progress: what the owner types, where, and what the daemon asks with until then. */
export type Device = {
	readonly code: string;
	readonly page: string;
	readonly deviceCode: string;
	/** Seconds between asks, as the server said. */
	readonly interval: number;
	/** When the code stops working (epoch ms). */
	readonly expires: number;
};

/** Start a sign-in by code (RFC 8628): the code the owner types, and where. */
export async function startDevice(
	server: OAuthServer,
	client: OAuthClient,
	resource: string,
	now: number,
	fetcher: typeof fetch = fetch,
): Promise<Device> {
	if (server.device === undefined) throw new Error("the server offers no sign-in by code");
	const params = new URLSearchParams({ client_id: client.id, resource });
	if (server.scopes !== undefined) params.set("scope", server.scopes.join(" "));
	const body = await json(fetcher, server.device, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: params.toString(),
	});
	if (typeof body.device_code !== "string" || typeof body.user_code !== "string")
		throw new Error(`the server gave no code${typeof body.error === "string" ? `: ${body.error}` : ""}`);
	const interval = typeof body.interval === "number" && body.interval >= 1 ? Math.min(body.interval, 60) : 5;
	const lasts = typeof body.expires_in === "number" && body.expires_in > 0 ? Math.min(body.expires_in, 3600) : 900;
	return {
		code: body.user_code,
		page: endpoint(body.verification_uri, "page to type the code at"),
		deviceCode: body.device_code,
		interval,
		expires: now + lasts * 1000,
	};
}

/**
 * Ask once whether the owner typed the code: the tokens, or how long to wait before asking again. A refusal (denied,
 * expired, any other error) throws, in words.
 */
export async function pollDevice(
	server: OAuthServer,
	client: OAuthClient,
	device: Device,
	resource: string,
	now: number,
	fetcher: typeof fetch = fetch,
): Promise<{ readonly tokens: Tokens } | { readonly wait: number }> {
	const params = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		device_code: device.deviceCode,
		client_id: client.id,
		resource,
	});
	if (client.secret !== undefined) params.set("client_secret", client.secret);
	const response = await fetcher(server.token, {
		method: "POST",
		redirect: "error",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: params.toString(),
	});
	// RFC 8628 answers "not yet" as an error, with 400; some servers say it with 200
	let body: Record<string, unknown>;
	try {
		const parsed = JSON.parse(await response.text()) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
		body = parsed as Record<string, unknown>;
	} catch {
		throw new Error(`${new URL(server.token).host} answered ${response.status}`);
	}
	if (typeof body.access_token === "string") return { tokens: tokensOf(body, now) };
	if (body.error === "authorization_pending") return { wait: device.interval };
	if (body.error === "slow_down")
		return { wait: typeof body.interval === "number" ? Math.min(body.interval, 60) : device.interval + 5 };
	if (body.error === "access_denied") throw new Error("the sign-in was declined");
	if (body.error === "expired_token") throw new Error("the code expired before it was typed");
	throw new Error(
		`${new URL(server.token).host} answered ${typeof body.error === "string" ? body.error : response.status}`,
	);
}
