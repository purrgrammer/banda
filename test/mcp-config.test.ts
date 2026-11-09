import { expect, it } from "vitest";
import { parseConnection } from "../src/core/connections.ts";
import { connectionWord, hostWord, mcpConfig, mcpDefinition, serviceOf } from "../src/core/mcp-config.ts";

it("normalizes remote MCP config into one ordinary definition, with no reads by default", () => {
	const config = mcpConfig({
		url: " https://ernesto.example/mcp ",
		service: "Ernesto",
		client: "banda",
		scopes: ["mcp", "mcp"],
	});
	expect(config.scopes).toEqual(["mcp"]);
	expect(parseConnection("ernesto", mcpDefinition(config, "oauth"))).toMatchObject({
		connection: {
			service: "Ernesto",
			url: "https://ernesto.example/mcp",
			auth: "oauth",
			client: "banda",
			scopes: ["mcp"],
			reads: [],
		},
	});
});
for (const url of [
	"http://elsewhere.example/mcp",
	"https://user:password@example.com/mcp",
	"https://example.com/mcp#secret",
	"file:///etc/passwd",
])
	it(`refuses an unsafe endpoint shape: ${new URL(url).protocol}`, () => expect(() => mcpConfig({ url })).toThrow());
for (const extra of [
	{ headers: { Authorization: "Bearer private" } },
	{ command: "sh" },
	{ env: { TOKEN: "private" } },
	{ service: "Ernesto\nauth: none" },
	{ service: "[Ernesto]" },
	{ scopes: ["a,b"] },
	{ auth: "none", client: "app" },
])
	it("refuses unsupported, credential-bearing or ambiguous configuration", () =>
		expect(() => mcpConfig({ url: "https://example.com/mcp", ...extra })).toThrow());
it("allows local HTTP and leaves an explicit empty OAuth scope selection empty", () => {
	expect(mcpConfig({ url: "http://127.0.0.1:1234/mcp", scopes: [] }).scopes).toEqual([]);
});

it("names a server after its host's own word, never a generic part or a number", () => {
	expect(hostWord("https://ernesto.example.com/mcp")).toBe("ernesto");
	expect(hostWord("https://mcp.linear.app/sse")).toBe("linear");
	expect(hostWord("http://127.0.0.1:4100/mcp")).toBe("server");
	expect(serviceOf("https://ernesto.example.com/mcp")).toBe("Ernesto");
	expect(connectionWord("Ernesto test")).toBe("ernesto-test");
	expect(connectionWord("4chan")).toBe("s4chan");
	expect(mcpConfig({ url: "https://ernesto.example.com/mcp" }).service).toBe("Ernesto");
});
