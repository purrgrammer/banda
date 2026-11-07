import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, until, viteCacheDir } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

/**
 * The approval card for a service's tool that has no words of its own (github-mcp-server's `issue_write` beyond what
 * the connection's objects say): named as it is, with Allow and Don't allow, never its name split into a verb; and its
 * one scope unticked until the owner ticks it, on every ask, however the feed reuses the card's place.
 */
const fixturePath = fileURLToPath(new URL("../web/approval-card-fixture.tsx", import.meta.url));
const ask = (title: string) => ({
	type: "approval",
	tool: "github__issue_write",
	label: "Use GitHub's issue_write as @purrgrammer",
	as: "@purrgrammer on GitHub",
	args: { method: "update", owner: "purrgrammer", repo: "banda", title, account: "purrgrammer" },
	scopes: [{ scope: "task", words: "Use GitHub's issue_write as @purrgrammer without asking until this task is done" }],
});

let server: ViteDevServer;
let base = "";
let answers: { path: string; body: { [key: string]: unknown } }[] = [];

async function bodyOf(req: IncomingMessage): Promise<{ [key: string]: unknown }> {
	let body = "";
	for await (const chunk of req) body += String(chunk);
	return JSON.parse(body || "{}");
}
function json(res: ServerResponse, body: unknown) {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		cacheDir: await viteCacheDir(),
		server: { port: await freePort(), strictPort: true, host: "127.0.0.1", open: false },
		plugins: [
			{
				name: "approval-card-fixture",
				resolveId(id) {
					if (id === "/approval-card-fixture.tsx") return fixturePath;
				},
				load(id) {
					if (id !== fixturePath) return;
					// one place in the feed, whose ask changes: the first answered, the next one open in its place
					return `import React, { StrictMode, useState } from 'react';
					import { createRoot } from 'react-dom/client';
					import { DraftApproval } from '/src/app/DraftApproval.tsx';
					import '/src/styles/globals.css';
					const asks = { first: ${JSON.stringify(ask("First"))}, next: ${JSON.stringify(ask("Next"))} };
					function Fixture() {
					 const [wait, setWait] = useState('first');
					 return <main style={{maxWidth:700,margin:'auto',padding:16}}>
					  <button onClick={() => setWait('next')}>Next ask</button>
					  <DraftApproval chat={1} agent={{ id: 'sancho', name: 'Sancho' }} ask={asks[wait]} label={asks[wait].label} wait={wait} />
					 </main>;
					}
					createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						const path = (req.url ?? "").split("?")[0] ?? "";
						if (path === "/approval-card-fixture") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/approval-card-fixture.tsx"></script></body></html>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						if (!path.startsWith("/api/")) return next();
						void (async () => {
							if (path === "/api/events") {
								res.setHeader("content-type", "text/event-stream");
								res.write(": fixture\n\n");
								return;
							}
							if (path.startsWith("/api/waits/")) {
								answers.push({ path, body: await bodyOf(req) });
								return json(res, { chat: 1 });
							}
							json(res, {});
						})();
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (address === null || typeof address !== "object" || address === undefined)
		throw new Error("fixture did not listen");
	base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	await server?.close();
});

const button = (text: string) =>
	`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const ticked = `document.querySelector('[role="checkbox"]').getAttribute('aria-checked')`;

for (const width of [390, 1280])
	it.skipIf(!hasChrome())(
		`an unworded tool's card says Allow, and its scope starts unticked on every ask, at ${width}px`,
		async () => {
			answers = [];
			await withPage(`${base}/approval-card-fixture#token=approval-test`, { width, height: 900 }, async (page) => {
				await page.until(`document.querySelector('[role="checkbox"]')`);
				expect(await page.run<string>(`document.body.textContent`)).toContain(
					"Use GitHub's issue_write as @purrgrammer",
				);
				expect(await page.run(`!!(${button("Allow")}) && !!(${button("Don't allow")})`)).toBe(true);
				expect(await page.run(`!!(${button("Issue")}) || !!(${button("Don't issue")})`)).toBe(false);
				// the scope is the owner's to give: never ticked for them
				expect(await page.run(ticked)).toBe("false");
				await page.run(`${button("Allow")}.click()`);
				await until(() => answers.length === 1);
				await page.until(`!${button("Allow")}.disabled && !document.querySelector('[role="checkbox"]').disabled`);
				expect(answers[0]?.path).toBe("/api/waits/first");
				expect(answers[0]?.body).toMatchObject({ answer: "approve", type: "approval" });
				expect(answers[0]?.body).not.toHaveProperty("permission");
				// ticked on one ask, the next ask in its place starts unticked
				await page.run(`document.querySelector('[role="checkbox"]').click()`);
				await page.until(`${ticked} === 'true'`);
				await page.run(`${button("Next ask")}.click()`);
				await page.until(`document.querySelector('[role="checkbox"]') && ${ticked} === 'false'`);
				await page.run(`${button("Allow")}.click()`);
				await until(() => answers.length === 2);
				expect(page.errors()).toEqual([]);
			});
			expect(answers.map((one) => one.path)).toEqual(["/api/waits/first", "/api/waits/next"]);
			expect(answers[1]?.body).not.toHaveProperty("permission");
		},
	);
