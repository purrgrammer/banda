/* A disposable protocol spike: can pi-mcp replace banda's hand-written MCP client against its existing fixture? */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSession } from "../src/core/mcp-remote.ts";
import { type FakeMcp, startFakeMcp } from "./fixtures/mcp-server.ts";

const servers: FakeMcp[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

function client(url: string, options: ConstructorParameters<typeof StreamableHttpTransport>[0] = { url }) {
	const session = new McpClient({ name: "banda-spike", version: "0.1.0" });
	return { session, transport: new StreamableHttpTransport({ ...options, url, openGetStream: false }) };
}

describe("pi-mcp against the existing banda fake MCP service", () => {
	it("negotiates, lists tools, and handles JSON and SSE replies over a fresh connection", async () => {
		const server = await startFakeMcp({ stream: true });
		servers.push(server);
		const { session, transport } = client(server.url);
		try {
			await session.connect(transport);
			expect(session.protocolVersion).toBe("2025-06-18");
			const tools = await session.listTools();
			expect(tools.map((tool) => tool.name)).toContain("list_events");
			const result = await session.callTool("list_events", { day: "Monday" });
			expect(result.content).toEqual([{ type: "text", text: 'list_events ok: {"day":"Monday"}' }]);
			expect(server.calls).toEqual([{ tool: "list_events", args: { day: "Monday" } }]);
		} finally {
			await session.close();
		}
	});

	it("can keep OAuth credentials outside pi-mcp's transport and recover a signed-in session", async () => {
		const server = await startFakeMcp({ auth: "oauth" });
		servers.push(server);
		const home = await mkdtemp(join(tmpdir(), "banda-mcp-spike-"));
		const path = join(home, "oauth.json");
		const store = {
			load: async () => JSON.parse(await readFile(path, "utf8")) as McpOAuthState,
			save: async (state: McpOAuthState) => {
				await writeFile(path, JSON.stringify(state), { mode: 0o600 });
			},
		};
		let authorizationUrl: URL | undefined;
		const provider = () =>
			new McpOAuthProvider({
				serverUrl: server.url,
				redirectUrl: "http://127.0.0.1:7788/oauth/callback",
				clientMetadata: { client_name: "banda-spike" },
				store: { ...store, load: async () => store.load().catch(() => undefined) },
				onRedirect: (url) => {
					authorizationUrl = url;
				},
			});
		const oauth = provider();
		const connect = async (signedInAs: McpOAuthProvider) => {
			const { session, transport } = client(server.url, {
				url: server.url,
				authProvider: adaptOAuthProvider(signedInAs),
			});
			try {
				await session.connect(transport);
				return session;
			} catch (error) {
				await session.close();
				throw error;
			}
		};
		await expect(connect(oauth)).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
		const redirect = await fetch(authorizationUrl!, { redirect: "manual" });
		const callback = new URL(redirect.headers.get("location")!);
		expect(callback.searchParams.get("state")).toBe(await oauth.state());
		expect(
			await authorizeMcp(oauth, { serverUrl: server.url, authorizationCode: callback.searchParams.get("code")! }),
		).toBe("AUTHORIZED");
		try {
			// Simulate restart: the provider object is new; only the file-backed store survives.
			const signedIn = await connect(provider());
			try {
				const before = (await signedIn.callTool("whoami")).content[0];
				expect(before).toMatchObject({ type: "text", text: expect.stringContaining("Bearer at-") });
				const token = (await store.load()).tokens?.access_token;
				expect(token).toBeTruthy();
				server.tokens.delete(token!);
				const after = (await signedIn.callTool("whoami")).content[0];
				expect(after).toMatchObject({ type: "text", text: expect.stringContaining("Bearer at-") });
				expect((await store.load()).tokens?.access_token).not.toBe(token);
			} finally {
				await signedIn.close();
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it.each([false, true])("bounds remote responses (SSE: %s) before they can reach the model", async (stream) => {
		const server = await startFakeMcp({ answerBytes: 4 * 1024 * 1024 + 1, stream });
		servers.push(server);
		await expect(
			remoteSession(
				server.url,
				async () => undefined,
				fetch,
				undefined,
				(c) => c.callTool("list_events", {}),
			),
		).rejects.toThrow("too large");
	});

	it("refuses a credentialed redirect without making any request to its target", async () => {
		const reached: string[] = [];
		const target = createServer((request, response) => {
			reached.push(request.headers.authorization ?? "no authorization");
			response.writeHead(200).end();
		});
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
		try {
			const address = target.address() as AddressInfo;
			const server = await startFakeMcp({
				auth: "key",
				redirectTo: `http://127.0.0.1:${address.port}/mcp`,
			});
			servers.push(server);
			await expect(
				remoteSession(
					server.url,
					async () => "Bearer fake-key-0123456789",
					fetch,
					undefined,
					(c) => c.listTools(),
				),
			).rejects.toThrow();
			expect(reached).toEqual([]);
		} finally {
			await new Promise<void>((resolve) => target.close(() => resolve()));
		}
	});

	it("signs in without dynamic registration when the owner has a pre-registered client ID", async () => {
		const server = await startFakeMcp({ auth: "oauth", registeredClient: "registered-banda" });
		servers.push(server);
		let authorizationUrl: URL | undefined;
		const oauth = new McpOAuthProvider({
			serverUrl: server.url,
			redirectUrl: "http://127.0.0.1:7788/oauth/callback",
			clientMetadata: { client_name: "banda-spike" },
			clientId: "registered-banda",
			onRedirect: (url) => {
				authorizationUrl = url;
			},
		});
		expect(await authorizeMcp(oauth, { serverUrl: server.url, scope: "calendar" })).toBe("REDIRECT");
		expect(authorizationUrl?.searchParams.get("client_id")).toBe("registered-banda");
		const redirected = await fetch(authorizationUrl!, { redirect: "manual" });
		const callback = new URL(redirected.headers.get("location")!);
		expect(
			await authorizeMcp(oauth, {
				serverUrl: server.url,
				authorizationCode: callback.searchParams.get("code")!,
				scope: "calendar",
			}),
		).toBe("AUTHORIZED");
		const { session, transport } = client(server.url, { url: server.url, authProvider: adaptOAuthProvider(oauth) });
		try {
			await session.connect(transport);
			expect((await session.callTool("list_events", { day: "Monday" })).isError).not.toBe(true);
		} finally {
			await session.close();
		}
	});

	it("uses only the accepted scope when authorization is started explicitly", async () => {
		const server = await startFakeMcp({ auth: "oauth", scopes: ["calendar", "payments"] });
		servers.push(server);
		let authorizationUrl: URL | undefined;
		const oauth = new McpOAuthProvider({
			serverUrl: server.url,
			redirectUrl: "http://127.0.0.1:7788/oauth/callback",
			clientMetadata: { client_name: "banda-spike" },
			onRedirect: (url) => {
				authorizationUrl = url;
			},
		});
		expect(await authorizeMcp(oauth, { serverUrl: server.url, scope: "calendar" })).toBe("REDIRECT");
		expect(authorizationUrl?.searchParams.get("scope")).toBe("calendar");
	});

	it("exposes why automatic MCP OAuth scope selection is not owner consent", async () => {
		const server = await startFakeMcp({ auth: "oauth", scopes: ["calendar", "payments"] });
		servers.push(server);
		let authorizationUrl: URL | undefined;
		const oauth = new McpOAuthProvider({
			serverUrl: server.url,
			redirectUrl: "http://127.0.0.1:7788/oauth/callback",
			clientMetadata: { client_name: "banda-spike", scope: "calendar" },
			onRedirect: (url) => {
				authorizationUrl = url;
			},
		});
		const { session, transport } = client(server.url, { url: server.url, authProvider: adaptOAuthProvider(oauth) });
		try {
			await expect(session.connect(transport)).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
			// The server's *supported* scopes are not the owner's requested scopes. Do not adopt the
			// default adapter unchanged: banda must supply an explicitly accepted scope itself.
			expect(authorizationUrl?.searchParams.get("scope")).toBe("calendar payments");
		} finally {
			await session.close();
		}
	});
});
