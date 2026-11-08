/**
 * A fake remote MCP server for tests and manual runs, on loopback: Streamable HTTP, and, as asked, no credentials, a
 * bearer key, or OAuth with everything a client needs to sign in by itself (resource and authorization server
 * metadata, dynamic registration, an authorize page that consents at once, a token endpoint that checks PKCE). It
 * records every tool call, and every authorization header it was sent.
 *
 * Run alone: `node test/fixtures/mcp-server.ts [--port 7801] [--auth none|key|oauth] [--key …] [--client banda-app]
 * [--user ana]`; a code is typed with `curl -d user_code=… <origin>/device`, and `POST <origin>/user` with a login names
 * whom the next sign-in is.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeTool = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: { readonly [key: string]: unknown };
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
};

export const FAKE_TOOLS: readonly FakeTool[] = [
	{
		name: "list_events",
		description: "List the events on a day.",
		inputSchema: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
		readOnlyHint: true,
	},
	{
		name: "create_event",
		description: "Put an event in the calendar.",
		inputSchema: {
			type: "object",
			properties: { title: { type: "string" }, day: { type: "string" } },
			required: ["title", "day"],
		},
	},
	{
		name: "send_payment",
		description: "Pay someone.",
		inputSchema: {
			type: "object",
			properties: { to: { type: "string" }, amount: { type: "number" } },
			required: ["to", "amount"],
		},
	},
	{
		name: "whoami",
		description: "Say who the caller is signed in as.",
		inputSchema: { type: "object", properties: {} },
		readOnlyHint: true,
	},
];

export type FakeMcp = {
	readonly url: string;
	readonly origin: string;
	/** Every tool call, in order. */
	readonly calls: { readonly tool: string; readonly args: unknown }[];
	/** Every authorization header the MCP endpoint was sent. */
	readonly authorizations: string[];
	/** The tools it lists; tests change them. */
	tools: FakeTool[];
	/** An optional service-specific answer, including delayed and failed reads. */
	onCall?: (
		tool: string,
		args: Record<string, unknown>,
		authorization: string,
	) => Promise<{ text: string; isError?: boolean }>;
	/** Tokens issued, so a test can expire them. */
	readonly tokens: Set<string>;
	/** Pause a refresh while the owner revokes a tool. */
	onRefresh?: () => Promise<void>;
	/** Answer tool calls as an event stream rather than JSON. */
	stream: boolean;
	/** The server's own notes (`instructions` in its initialize answer); tests change them. */
	instructions?: string;
	/** The scopes each sign-in asked for, in order. */
	readonly scopesAsked: string[];
	/** Tools that need a scope, by tool: called with a token not granted it, the server answers a scope challenge. */
	needs: { [tool: string]: string };
	/** Scopes the owner unticks at the consent screen: asked for, never granted. */
	withheld: string[];
	/** Who each refresh said it was: its client id, and whether it sent a secret. */
	readonly refreshed: { readonly client: string; readonly secret: boolean }[];
	/** Sign-ins by code waiting for the owner, by the code they type. */
	readonly codes: Map<string, { approved: boolean | "denied"; client: string }>;
	/** The owner types `code` on the server's page and consents (or declines). */
	typeCode(code: string, consent?: boolean): void;
	/**
	 * Who the next sign-in is: the login `get_me` answers for the tokens it is given (unlisted, as a server's own read
	 * of who the caller is). A key's is "owner".
	 */
	user: string;
	/** `get_me` answers with no login, as a server that does not say who you are. */
	anonymous: boolean;
	close(): Promise<void>;
};

export async function startFakeMcp({
	auth = "none",
	key = "fake-key-0123456789",
	port = 0,
	stream = false,
	scopes = ["calendar"],
	registeredClient,
	device = false,
	issuerParameter = false,
	redirectTo,
	answerBytes,
}: {
	auth?: "none" | "key" | "oauth";
	key?: string;
	port?: number;
	stream?: boolean;
	scopes?: string[];
	registeredClient?: string;
	/** Offer sign-in by code (RFC 8628), asking once a second. */
	device?: boolean;
	/** RFC 9207 discovery promise and authorization response issuer. */
	issuerParameter?: boolean;
	redirectTo?: string;
	answerBytes?: number;
} = {}): Promise<FakeMcp> {
	const calls: { tool: string; args: unknown }[] = [];
	const authorizations: string[] = [];
	const tokens = new Set<string>();
	const refreshes = new Map<string, string>();
	const codes = new Map<string, { challenge: string; client: string; redirect: string; scope: string }>();
	const clients = new Set<string>(registeredClient === undefined ? [] : [registeredClient]);
	const scopesAsked: string[] = [];
	const refreshed: { client: string; secret: boolean }[] = [];
	const granted = new Map<string, string[]>();
	const userCodes = new Map<string, { approved: boolean | "denied"; client: string; scope?: string }>();
	const deviceCodes = new Map<string, string>();
	let origin = "";
	const state: FakeMcp = {
		url: "",
		origin: "",
		calls,
		authorizations,
		tools: [...FAKE_TOOLS],
		tokens,
		stream,
		scopesAsked,
		needs: {},
		withheld: [],
		refreshed,
		codes: userCodes,
		user: "owner",
		anonymous: false,
		typeCode(code, consent = true) {
			const waiting = userCodes.get(code);
			if (waiting !== undefined) waiting.approved = consent ? true : "denied";
		},
		close: async () => {},
	};

	const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
		res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

	const body = async (req: IncomingMessage) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		return text;
	};

	const authorized = (req: IncomingMessage) => {
		const header = req.headers.authorization ?? "";
		if (header !== "") authorizations.push(header);
		if (auth === "none") return true;
		if (auth === "key") return header === `Bearer ${key}`;
		return header.startsWith("Bearer ") && tokens.has(header.slice(7));
	};

	const users = new Map<string, string>();
	const issue = (scope = "", user = state.user) => {
		const access = `at-${randomBytes(16).toString("hex")}`;
		users.set(access, user);
		granted.set(access, scope.split(" ").filter(Boolean));
		const refresh = `rt-${randomBytes(16).toString("hex")}`;
		tokens.add(access);
		refreshes.set(refresh, access);
		const given = (granted.get(access) ?? []).filter((each) => !state.withheld.includes(each));
		granted.set(access, given);
		return {
			access_token: access,
			refresh_token: refresh,
			token_type: "Bearer",
			expires_in: 3600,
			...(scope === "" ? {} : { scope: given.join(",") }),
		};
	};

	const answer = (res: ServerResponse, id: unknown, result: unknown, asStream: boolean) => {
		const message = { jsonrpc: "2.0", id, result };
		if (!asStream) return json(res, 200, message, { "mcp-session-id": "fake-session" });
		res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "fake-session" });
		res.write(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
		);
		res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
	};

	const server: Server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", origin);
			if (url.pathname === "/mcp" && req.method === "POST") {
				const text = await body(req);
				if (!authorized(req))
					return json(
						res,
						401,
						{ error: "unauthorized" },
						{
							"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
						},
					);
				if (redirectTo !== undefined) return res.writeHead(302, { location: redirectTo }).end();
				const message = JSON.parse(text) as { id?: unknown; method: string; params?: Record<string, unknown> };
				if (message.id === undefined) return res.writeHead(202).end();
				if (message.method === "initialize")
					return answer(
						res,
						message.id,
						{
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "fake", version: "1" },
							...(state.instructions === undefined ? {} : { instructions: state.instructions }),
						},
						false,
					);
				if (message.method === "tools/list")
					return answer(
						res,
						message.id,
						{
							tools: state.tools.map((tool) => ({
								name: tool.name,
								description: tool.description,
								inputSchema: tool.inputSchema,
								...(tool.readOnlyHint === undefined && tool.destructiveHint === undefined
									? {}
									: {
											annotations: {
												...(tool.readOnlyHint === undefined ? {} : { readOnlyHint: tool.readOnlyHint }),
												...(tool.destructiveHint === undefined ? {} : { destructiveHint: tool.destructiveHint }),
											},
										}),
							})),
						},
						false,
					);
				if (message.method === "tools/call") {
					const name = String(message.params?.name);
					const needed = state.needs[name];
					const token = (req.headers.authorization ?? "").slice(7);
					if (auth === "oauth" && needed !== undefined && !(granted.get(token) ?? []).includes(needed))
						return json(
							res,
							403,
							{ error: "Forbidden: insufficient scopes" },
							{
								"www-authenticate": `Bearer error="insufficient_scope", scope="${needed}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error_description="Additional scopes required: ${needed}"`,
							},
						);
					const args = message.params?.arguments ?? {};
					// the daemon's own read of whom a sign-in is for is not among the calls
					if (name !== "get_me") calls.push({ tool: name, args });
					if (name !== "get_me" && state.onCall !== undefined) {
						const result = await state.onCall(name, args as Record<string, unknown>, req.headers.authorization ?? "");
						return answer(
							res,
							message.id,
							{
								content: [{ type: "text", text: result.text }],
								...(result.isError === undefined ? {} : { isError: result.isError }),
							},
							state.stream,
						);
					}
					const said =
						answerBytes !== undefined
							? "x".repeat(answerBytes)
							: name === "get_me"
								? JSON.stringify(
										state.anonymous ? {} : { login: auth === "key" ? "owner" : (users.get(token) ?? "nobody") },
									)
								: name === "whoami"
									? `you sent ${req.headers.authorization ?? "nothing"}`
									: `${name} ok: ${JSON.stringify(args)}`;
					return answer(res, message.id, { content: [{ type: "text", text: said }] }, state.stream);
				}
				return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
			}
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource") && auth === "oauth")
				return json(res, 200, {
					resource: `${origin}/mcp`,
					authorization_servers: [origin],
					scopes_supported: scopes,
				});
			if (url.pathname === "/.well-known/oauth-authorization-server" && auth === "oauth")
				return json(res, 200, {
					issuer: origin,
					...(issuerParameter ? { authorization_response_iss_parameter_supported: true } : {}),
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					...(registeredClient === undefined ? { registration_endpoint: `${origin}/register` } : {}),
					...(device ? { device_authorization_endpoint: `${origin}/device/code` } : {}),
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
			if (url.pathname === "/register" && req.method === "POST") {
				const asked = JSON.parse(await body(req)) as { redirect_uris?: string[] };
				const client = `client-${randomBytes(6).toString("hex")}`;
				clients.add(client);
				return json(res, 201, { client_id: client, redirect_uris: asked.redirect_uris });
			}
			if (url.pathname === "/device/code" && req.method === "POST" && device) {
				const form = new URLSearchParams(await body(req));
				const client = form.get("client_id") ?? "";
				if (!clients.has(client)) return json(res, 400, { error: "invalid_client" });
				scopesAsked.push(form.get("scope") ?? "");
				const code = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`.toUpperCase();
				const deviceCode = `dc-${randomBytes(16).toString("hex")}`;
				userCodes.set(code, { approved: false, client, scope: form.get("scope") ?? "" });
				deviceCodes.set(deviceCode, code);
				return json(res, 200, {
					device_code: deviceCode,
					user_code: code,
					verification_uri: `${origin}/device`,
					expires_in: 900,
					interval: 1,
				});
			}
			if (url.pathname === "/user" && req.method === "POST") {
				state.user = (await body(req)).trim() || state.user;
				return json(res, 200, { user: state.user });
			}
			if (url.pathname === "/device" && req.method === "POST" && device) {
				// the owner types the code on the server's page, and consents (or declines)
				const form = new URLSearchParams(await body(req));
				const waiting = userCodes.get(form.get("user_code") ?? "");
				if (waiting === undefined) return json(res, 404, { error: "no such code" });
				waiting.approved = form.get("consent") === "no" ? "denied" : true;
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/authorize") {
				// the owner signs in and consents, at once
				const client = url.searchParams.get("client_id") ?? "";
				scopesAsked.push(url.searchParams.get("scope") ?? "");
				const redirect = url.searchParams.get("redirect_uri") ?? "";
				if (!clients.has(client) || url.searchParams.get("code_challenge_method") !== "S256")
					return json(res, 400, { error: "invalid_request" });
				const code = randomBytes(12).toString("hex");
				codes.set(code, {
					challenge: url.searchParams.get("code_challenge") ?? "",
					client,
					redirect,
					scope: url.searchParams.get("scope") ?? "",
				});
				const back = new URL(redirect);
				back.searchParams.set("code", code);
				back.searchParams.set("state", url.searchParams.get("state") ?? "");
				if (issuerParameter) back.searchParams.set("iss", origin);
				return res.writeHead(302, { location: back.toString() }).end();
			}
			if (url.pathname === "/token" && req.method === "POST") {
				const form = new URLSearchParams(await body(req));
				if (form.get("grant_type") === "refresh_token") {
					await state.onRefresh?.();
					refreshed.push({ client: form.get("client_id") ?? "", secret: form.has("client_secret") });
					const was = refreshes.get(form.get("refresh_token") ?? "");
					if (was === undefined) return json(res, 400, { error: "invalid_grant" });
					refreshes.delete(form.get("refresh_token") ?? "");
					tokens.delete(was);
					return json(res, 200, issue((granted.get(was) ?? []).join(" "), users.get(was)));
				}
				if (form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
					const typed = deviceCodes.get(form.get("device_code") ?? "");
					const waiting = typed === undefined ? undefined : userCodes.get(typed);
					if (typed === undefined || waiting === undefined || waiting.client !== form.get("client_id"))
						return json(res, 400, { error: "invalid_grant" });
					if (waiting.approved === false) return json(res, 400, { error: "authorization_pending" });
					deviceCodes.delete(form.get("device_code") ?? "");
					userCodes.delete(typed);
					if (waiting.approved === "denied") return json(res, 400, { error: "access_denied" });
					return json(res, 200, issue(waiting.scope));
				}
				const code = codes.get(form.get("code") ?? "");
				codes.delete(form.get("code") ?? "");
				const verifier = form.get("code_verifier") ?? "";
				if (
					code === undefined ||
					code.client !== form.get("client_id") ||
					code.redirect !== form.get("redirect_uri") ||
					createHash("sha256").update(verifier).digest("base64url") !== code.challenge
				)
					return json(res, 400, { error: "invalid_grant" });
				return json(res, 200, issue(code.scope));
			}
			return json(res, 404, { error: "not found" });
		})().catch((error: unknown) => {
			if (!res.headersSent) json(res, 500, { error: String(error) });
		});
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return Object.assign(state, {
		url: `${origin}/mcp`,
		origin,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const arg = (name: string) => {
		const at = process.argv.indexOf(`--${name}`);
		return at === -1 ? undefined : process.argv[at + 1];
	};
	const fake = await startFakeMcp({
		port: Number(arg("port") ?? 7801),
		auth: (arg("auth") ?? "oauth") as "none" | "key" | "oauth",
		...(arg("key") === undefined ? {} : { key: arg("key") as string }),
		// --client banda-app: a registered client that signs in by code, as GitHub does
		...(arg("client") === undefined ? {} : { registeredClient: arg("client") as string, device: true }),
	});
	if (arg("user") !== undefined) fake.user = arg("user") as string;
	console.log(`fake MCP server at ${fake.url}`);
	setInterval(() => {
		if (fake.calls.length > 0) console.log(JSON.stringify(fake.calls.splice(0)));
	}, 1000);
}
