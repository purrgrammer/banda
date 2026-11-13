import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BrowserPreparation, PreparedBrowser } from "../src/box/browser-preparation.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

it("authenticates owner preparation, rejects arguments, and leaves the shared job running after the request ends", async () => {
	const home = await tempHome();
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	let finish = () => {};
	let started = 0;
	let state: BrowserPreparation = { state: "idle" };
	const preparing = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const browser: PreparedBrowser = {
		state: () => state,
		watch: () => () => {},
		forAgent: () => ({ command: async () => ["unused"], login: { username: "u", password: "p" } }),
		prepare: async () => {
			started++;
			state = { state: "preparing", phase: "checking" };
			await preparing;
			state = { state: "ready" };
		},
	};
	const daemon = await startDaemon({
		home,
		port: 0,
		models: echoModels().models,
		log: () => {},
		box: { ...hostBox(home), browser },
	});
	try {
		const token = (await readDaemonFile(home))?.token;
		const url = `http://127.0.0.1:${daemon.port}/api/computer/browser/prepare`;
		const headers = { authorization: `Bearer ${token}` };
		expect((await fetch(url, { method: "POST" })).status).toBe(401);
		expect(
			(await fetch(url, { method: "POST", headers: { ...headers, origin: "https://elsewhere.test" } })).status,
		).toBe(403);
		expect(
			(await fetch(url, { method: "POST", headers, body: JSON.stringify({ url: "https://example.com" }) })).status,
		).toBe(400);
		expect((await fetch(`${url}?chat=1`, { method: "POST", headers })).status).toBe(400);
		expect(started).toBe(0);
		const response = await fetch(url, { method: "POST", headers });
		expect(response.status).toBe(202);
		await response.body?.cancel();
		await until(() => started === 1);
		expect(browser.state()).toEqual({ state: "preparing", phase: "checking" });
		finish();
		await until(() => browser.state().state === "ready");
	} finally {
		finish();
		await daemon.close();
	}
});

it("refuses preparation on a backend without a browser", async () => {
	const home = await tempHome();
	const daemon = await startDaemon({ home, port: 0, models: echoModels().models, log: () => {}, box: hostBox(home) });
	try {
		const token = (await readDaemonFile(home))?.token;
		const response = await fetch(`http://127.0.0.1:${daemon.port}/api/computer/browser/prepare`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "Browsing is not available on this computer." });
	} finally {
		await daemon.close();
	}
});
