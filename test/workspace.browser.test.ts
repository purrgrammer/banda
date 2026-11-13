/** Tool completion refreshes the running app; no filesystem watcher is needed. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	Type,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { shaOf } from "../src/core/agents.ts";
import { startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { skipShippedSkills, tempHome, until, webServer } from "./helpers.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const Status = Type.Object({ chats: Type.Array(Type.Object({ state: Type.String() })) });

for (const width of [390, 1440])
	it.skipIf(!hasChrome())(`workspace changes reach the app at ${width}px without polling`, async () => {
		const home = await tempHome();
		await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		let made = false;
		faux.setResponses(
			Array.from({ length: 8 }, () => (request) => {
				if (made) return fauxAssistantMessage("");
				if (!getCurrentTools(request.messages).some((tool) => tool.name === "bash"))
					return fauxAssistantMessage([fauxToolCall("tool_search", { query: "bash", limit: 1 })], {
						stopReason: "toolUse",
					});
				made = true;
				// A nonzero exit still leaves a definition the owner must be shown, without accepting it.
				return fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command:
								"mkdir -p agents; printf '%s\\n' '---' 'description: Reads carefully' '---' 'Read carefully.' > agents/reader.md; exit 3",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}),
		);
		const daemon = await startDaemon({ home, port: 0, models, box: hostBox(home), log: () => {} });
		const token = (await readDaemonFile(home))!.token!;
		const base = `http://127.0.0.1:${daemon.port}`;
		const server = await webServer({
			server: {
				proxy: {
					"/api": { target: base, changeOrigin: true, headers: { origin: base } },
					"^/(?:icon.*|manifest\\.webmanifest)$": { target: base, changeOrigin: true },
				},
			},
		});
		try {
			await skipShippedSkills(daemon.port, token);
			await withPage(`${server.origin}/#token=${token}`, { width, height: 900 }, async (page) => {
				await page.until("!location.hash.includes('token=')");
				await page.run("location.hash='#/a/sancho'");
				await page.until("document.querySelector('textarea[name=message]')");
				await page.run("document.querySelector('textarea[name=message]').focus()");
				await page.input("Input.insertText", { text: "Make a reader." });
				await page.until("document.querySelector('button[aria-label=Send]:not([disabled])')");
				await page.run("document.querySelector('button[aria-label=Send]').click()");
				await page.until(
					"document.body.innerText.includes('its file: Reader') && document.body.innerText.includes('Read carefully.') && [...document.querySelectorAll('button')].some(el=>el.innerText==='Keep as is')",
				);
				await until(async () => {
					const response = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
					const status = await response.json();
					if (!Value.Check(Status, status)) throw new Error("invalid status response");
					return status.chats.length > 0 && status.chats.every((chat) => chat.state === "idle");
				});
				// Another client keeps the accepted file; this page must hear the file-only change too.
				const kept = await fetch(`${base}/api/agents/reader/decline`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ sha: shaOf("---\ndescription: Reads carefully\n---\nRead carefully.\n") }),
				});
				expect(kept.ok).toBe(true);
				await page.until("![...document.querySelectorAll('button')].some(el=>el.innerText==='Keep as is')");
				expect(page.errors()).toEqual([]);
			});
		} finally {
			await server.close();
			await daemon.close();
		}
	});
