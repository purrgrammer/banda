import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BadRequest, handler, type Routes } from "../src/server/http.ts";
import type { Area } from "../src/server/routes/area.ts";

/** A server whose routes are only the given areas': the daemon's own are never reached for these paths. */
async function serve(areas: readonly Area[]) {
	let port = 0;
	const server = createServer(handler({} as Routes, () => port, "secret", "/nonexistent", areas));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	const call = (path: string, init: RequestInit = {}) =>
		fetch(`http://127.0.0.1:${port}/api${path}`, {
			...init,
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
		});
	return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("an area's routes", () => {
	it("answers its own paths, in order, after the daemon's, with JSON, a file or a refusal", async () => {
		const seen: string[] = [];
		const areas: Area[] = [
			{
				route: async ({ method, path, json }) => {
					seen.push(`a ${method} ${path}`);
					if (path === "/a") return { body: { from: "a", body: method === "POST" ? await json() : null } };
					if (path === "/refused") throw new BadRequest("not like that", 409);
					return undefined;
				},
			},
			{
				route: async ({ path }) =>
					path === "/file"
						? { file: { name: "notes.html", mimeType: "text/html", bytes: Buffer.from("<b>hi</b>") } }
						: undefined,
			},
		];
		const { call, close } = await serve(areas);
		try {
			const posted = await call("/a", { method: "POST", body: JSON.stringify({ x: 1 }) });
			expect(await posted.json()).toEqual({ from: "a", body: { x: 1 } });
			const refused = await call("/refused");
			expect(refused.status).toBe(409);
			expect(await refused.json()).toEqual({ error: "not like that" });
			// a file is never rendered on the daemon's origin: HTML downloads
			const file = await call("/file");
			expect(file.headers.get("content-type")).toBe("application/octet-stream");
			expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
			expect(await file.text()).toBe("<b>hi</b>");
			expect((await call("/nothing")).status).toBe(404);
			expect(seen).toContain("a GET /file");
		} finally {
			await close();
		}
	});
});
