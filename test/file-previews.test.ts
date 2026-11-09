/**
 * Files drawn by the daemon from their bytes (src/server/http.ts):
 * a preview needs the token and a blob a chat holds. Install icons are covered in avatar-icon.test.ts.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Attachment } from "../src/core/blobs.ts";
import { handler, type Routes } from "../src/server/http.ts";

const SHA = "a".repeat(64);
const CSV = Buffer.from("Flight,Leaves\nTP 1351,9:15\nFR 6342,6:30\n");

async function serving(routes: Partial<Routes>, run: (base: string) => Promise<void>) {
	let port = 0;
	const server = createServer(handler(routes as Routes, () => port, "secret"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	try {
		await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

const auth = { authorization: "Bearer secret" };

describe("previews", () => {
	const routes: Partial<Routes> = {
		limits: () => ({ fileBytes: 1024 }),
		blob: async (sha) => (sha === SHA ? { mimeType: "text/csv", bytes: CSV } : undefined),
		file: async (chat, call, n) =>
			chat === 4 && call === "c1" && n === 0
				? {
						attachment: { sha: SHA, name: "flights.csv", mimeType: "text/csv", size: CSV.length } as Attachment,
						bytes: CSV,
					}
				: undefined,
	};

	it("draws a blob a chat holds, by the name it is shown by, and only with the token", async () => {
		await serving(routes, async (base) => {
			const got = await fetch(`${base}/api/blobs/${SHA}/preview?name=flights.csv`, { headers: auth });
			expect(got.status).toBe(200);
			expect(await got.json()).toMatchObject({
				sha: SHA,
				name: "flights.csv",
				size: CSV.length,
				preview: {
					kind: "sheet",
					total: 3,
					rows: [
						["Flight", "Leaves"],
						["TP 1351", "9:15"],
						["FR 6342", "6:30"],
					],
				},
			});
			expect((await fetch(`${base}/api/blobs/${SHA}/preview?name=flights.csv`)).status).toBe(401);
			expect((await fetch(`${base}/api/blobs/${"b".repeat(64)}/preview`, { headers: auth })).status).toBe(404);
		});
	});

	it("draws a file a message sent, and one attached in the composer without keeping it", async () => {
		await serving(routes, async (base) => {
			const sent = await fetch(`${base}/api/chats/4/messages/c1/files/0/preview?full=1`, { headers: auth });
			expect(await sent.json()).toMatchObject({ name: "flights.csv", preview: { kind: "sheet" } });
			expect((await fetch(`${base}/api/chats/4/messages/c2/files/0/preview`, { headers: auth })).status).toBe(404);
			const local = await fetch(`${base}/api/previews`, {
				method: "POST",
				headers: { ...auth, "x-file-name": encodeURIComponent("notes.py") },
				body: "def hello():\n    return 1\n",
			});
			expect(await local.json()).toEqual({
				preview: { kind: "text", language: "python", total: 2, lines: ["def hello():", "    return 1"] },
			});
			const big = await fetch(`${base}/api/previews`, {
				method: "POST",
				headers: { ...auth, "x-file-name": "big.txt" },
				body: "x".repeat(2048),
			});
			expect(big.status).toBe(413);
		});
	});
});
