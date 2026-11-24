/**
 * The private activity specimen's data, as the web app's dev server serves it: no browser, only its HTTP answers.
 * What the page draws from it is test/recorded-activity.browser.test.ts.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RecordedActivity } from "../web/src/specimen/agent/recorded-types.ts";
import { fixture } from "./fixtures/recorded-activity.ts";
import { type WebServer, webServer } from "./helpers.ts";

let server: WebServer;
let home: string;
let base: string;

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "banda-recorded-data-"));
	const path = join(home, "private.json");
	await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
	const before = process.env.BANDA_ACTIVITY_FIXTURE;
	process.env.BANDA_ACTIVITY_FIXTURE = path;
	try {
		server = await webServer();
	} finally {
		if (before === undefined) delete process.env.BANDA_ACTIVITY_FIXTURE;
		else process.env.BANDA_ACTIVITY_FIXTURE = before;
	}
	base = server.origin;
});
afterAll(async () => {
	await server?.close();
	if (home) await rm(home, { recursive: true, force: true });
});

it("private data is same-origin, no-store, and inaccessible to another origin", async () => {
	const response = await fetch(`${base}/__specimen/activity`);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
	expect(((await response.json()) as RecordedActivity).runs[0]?.prompt.tools).toHaveLength(22);
	expect((await fetch(`${base}/__specimen/activity`, { headers: { origin: "https://example.test" } })).status).toBe(
		403,
	);
	expect((await fetch(`${base}/__specimen/activity`, { method: "POST" })).status).toBe(404);
});
