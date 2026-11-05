/** Who a request is comes from its transport: an Iroh socket's endpoint id, never a header; loopback is as it was. */
import { createServer } from "node:http";
import { duplexPair } from "node:stream";
import { describe, expect, it } from "vitest";
import { handler, type RemoteGate, type Routes } from "../src/server/http.ts";
import { markEndpoint } from "../src/server/remote.ts";

const PHONE = "a".repeat(64);
const OTHER = "b".repeat(64);

/** One raw HTTP request on a socket the server takes as a connection, marked as from endpoint `from` or unmarked. */
async function ask(
	gate: RemoteGate,
	request: string,
	from?: string,
): Promise<{ status: number; body: unknown; headers: string }> {
	const server = createServer(
		handler({ status: async () => ({ ok: true }) } as Routes, () => 7787, "secret", "/nonexistent", [], gate),
	);
	const [mine, theirs] = duplexPair();
	if (from !== undefined) markEndpoint(theirs, from);
	server.emit("connection", theirs);
	// written, not ended: node:http ends a socket that half-closes under a response it is still making
	mine.write(request);
	let text = "";
	for await (const chunk of mine) text += String(chunk);
	const [head = "", raw = ""] = text.split("\r\n\r\n");
	// a chunked body is the chunks' data, each after its length line
	const body = /transfer-encoding: chunked/i.test(head)
		? raw
				.split("\r\n")
				.filter((_, n) => n % 2 === 1)
				.join("")
		: raw;
	return { status: Number(head.split(" ")[1]), body: body === "" ? undefined : JSON.parse(body), headers: head };
}

describe("who a request is, by its transport", () => {
	const gate: RemoteGate = {
		paired: async (id) => id === PHONE,
		pair: async (id) => ({ status: 202, body: { asked: id } }),
	};
	// the request asks to close, so loopback's keep-alive ends the socket too
	const get = (path: string, headers: string) => `GET ${path} HTTP/1.1\r\nconnection: close\r\n${headers}\r\n`;

	it("lets a paired device in as the owner by its endpoint id: no token, any Host, one request a stream", async () => {
		const answered = await ask(gate, get("/api/status", "host: banda.iroh\r\n"), PHONE);
		expect(answered).toMatchObject({ status: 200, body: { ok: true } });
		expect(answered.headers.toLowerCase()).toContain("connection: close");
	});

	it("lets an endpoint that is not a paired device reach the pairing route alone, whatever it presents", async () => {
		const token = "host: 127.0.0.1:7787\r\nauthorization: Bearer secret\r\n";
		expect(await ask(gate, get("/api/status", token), OTHER)).toMatchObject({
			status: 403,
			body: { error: "this device is not paired" },
		});
		expect((await ask(gate, get("/", token), OTHER)).status).toBe(403);
		expect(await ask(gate, get("/api/devices/pair", "host: x\r\n"), OTHER)).toMatchObject({
			status: 202,
			body: { asked: OTHER },
		});
	});

	it("tells the gate of each request a paired device makes, by path alone, and of none other", async () => {
		const heard: string[] = [];
		const told: RemoteGate = {
			...gate,
			heard: (id, method, path) => heard.push(`${id.slice(0, 1)} ${method} ${path}`),
		};
		await ask(told, get("/api/status?token=never-logged", "host: banda.iroh\r\n"), PHONE);
		await ask(told, get("/api/status", "host: x\r\n"), OTHER);
		await ask(told, get("/api/devices/pair", "host: x\r\n"), OTHER);
		await ask(told, get("/api/status", "host: 127.0.0.1:7787\r\nauthorization: Bearer secret\r\n"));
		expect(heard).toEqual(["a GET /api/status"]);
	});

	it("keeps loopback as it was: the Host checked, the token needed, no pairing route without it", async () => {
		expect((await ask(gate, get("/api/status", "host: banda.iroh\r\nauthorization: Bearer secret\r\n"))).status).toBe(
			403,
		);
		expect((await ask(gate, get("/api/status", "host: 127.0.0.1:7787\r\n"))).status).toBe(401);
		expect((await ask(gate, get("/api/devices/pair", "host: 127.0.0.1:7787\r\n"))).status).toBe(401);
		expect(
			await ask(gate, get("/api/status", "host: 127.0.0.1:7787\r\nauthorization: Bearer secret\r\n")),
		).toMatchObject({ status: 200, body: { ok: true } });
	});
});
