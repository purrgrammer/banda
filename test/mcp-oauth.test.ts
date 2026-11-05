import { expect, it } from "vitest";
import { discover } from "../src/core/oauth.ts";

function discovery({
	issuer = "https://auth.example/issuer",
	declared = issuer,
	metadata = "https://service.example/meta",
	token = "https://auth.example/token",
}: {
	issuer?: string;
	declared?: string;
	metadata?: string;
	token?: string;
} = {}) {
	const requests: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push(url);
		if (init?.method === "POST")
			return new Response(null, {
				status: 401,
				headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
			});
		const body =
			url === metadata
				? { authorization_servers: [issuer], scopes_supported: ["mcp"] }
				: {
						issuer: declared,
						authorization_endpoint: "https://auth.example/authorize",
						token_endpoint: token,
						registration_endpoint: "https://auth.example/register",
						code_challenge_methods_supported: ["S256"],
						authorization_response_iss_parameter_supported: true,
					};
		return Response.json(body);
	};
	return { run: () => discover("https://service.example/mcp", fetcher), requests };
}
it("retains the discovered issuer's RFC 9207 promise, resource scopes, and PKCE endpoints", async () => {
	expect(await discovery().run()).toMatchObject({
		issuer: "https://auth.example/issuer",
		issuerParameter: true,
		scopes: ["mcp"],
		token: "https://auth.example/token",
	});
});
it("refuses issuer substitution in discovery", async () => {
	await expect(discovery({ declared: "https://another.example" }).run()).rejects.toThrow(/issuer/);
});
for (const issuer of [
	"http://outside.example",
	"https://user:password@auth.example",
	"https://auth.example?query=1",
	"https://auth.example#fragment",
])
	it("refuses unsafe authorization-server addresses before fetching their discovery", async () => {
		const probe = discovery({ issuer });
		await expect(probe.run()).rejects.toThrow();
		expect(probe.requests).toHaveLength(2);
	});
it("does not fetch insecure metadata named in a challenge", async () => {
	const probe = discovery({ metadata: "http://outside.example/meta" });
	await expect(probe.run()).rejects.toThrow();
	expect(probe.requests).toEqual(["https://service.example/mcp"]);
});
for (const token of ["https://user:password@auth.example/token", "https://auth.example/token#fragment"])
	it("refuses embedded credentials and fragments in OAuth endpoints", async () => {
		await expect(discovery({ token }).run()).rejects.toThrow(/credentials or a fragment/);
	});
