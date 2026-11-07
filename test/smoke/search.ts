/** Manual app walkthrough on throwaway homes: cross-agent search, source reading, Cmd+K and recoverable tool errors. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { startDaemon } from "../../src/daemon.ts";
import { readDaemonFile } from "../../src/home.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { type Page, withPage } from "./chrome.ts";

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n")
			: "";
async function fill(page: Page, selector: string, value: string, tag = "HTMLInputElement") {
	await page.until(selector, 30_000);
	await page.run(
		`(() => { const el=${selector}; Object.getOwnPropertyDescriptor(${tag}.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`,
	);
}
async function click(page: Page, selector: string) {
	await page.until(selector, 30_000);
	await page.run(`(() => { const el=${selector}; el.scrollIntoView({block:'center'}); el.click(); })()`);
}
for (const width of [1440, 390]) {
	const home = await mkdtemp(join(tmpdir(), "banda-search-manual-"));
	await writeFile(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
	await mkdir(join(home, "workspace"), { recursive: true });
	await writeFile(
		join(home, "workspace", "itinerary.md"),
		"# Lisbon\n\nTake the 09:15 train. The booking reference is SUNRISE.\n",
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const searched: string[][] = [];
	let references: { href: string; kind: string }[] = [];
	const call = (name: string, args: JsonObject) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const respond = (ctx: Context) => {
		const last = ctx.messages.filter((message) => message.role !== "system").at(-1);
		if (last?.role === "toolResult") {
			if (last.toolName === "message_user") return fauxAssistantMessage("Done.");
			if (last.isError) return call("message_user", { text: "Search failed. Please try the query again." });
			if (last.toolName === "search") {
				const found = JSON.parse(textOf(last.content));
				references = found.results;
				searched.push(found.results.map((result: { kind: string }) => result.kind));
				const artifact = found.results.find((result: { kind: string }) => result.kind === "artifact");
				if (!artifact) return call("message_user", { text: "No itinerary found." });
				return call("read_search_result", { source: artifact.source });
			}
			if (last.toolName === "read_search_result") {
				const read = JSON.parse(textOf(last.content));
				return call("message_user", {
					text: `Found our train decision: ${read.text}\n\n[Open itinerary](#/artifact/${read.source.id})\n\n${references.map((ref) => `[](${ref.href})`).join(" · ")}\n\n[](#/artifact/0000000000000000)`,
				});
			}
		}
		const said = textOf(last?.content);
		if (said.includes("Find our train decision")) return call("search", { query: "Lisbon" });
		if (said.includes("Invalid cursor")) return call("search", { query: "Lisbon", cursor: "invalid" });
		if (said.includes("Publish itinerary"))
			return call("message_user", {
				text: "Here is the itinerary.",
				artifact: { path: "itinerary.md", title: "Lisbon itinerary" },
			});
		return call("message_user", { text: "Noted the Lisbon train decision." });
	};
	faux.setResponses(Array.from({ length: 100 }, () => respond as never));
	const daemon = await startDaemon({
		home,
		port: 0,
		models,
		box: hostBox(home),
		web: join(import.meta.dirname, "../../web/dist"),
		log: () => {},
	});
	const base = `http://127.0.0.1:${daemon.port}`;
	const token = (await readDaemonFile(home))!.token!;
	const api = async (path: string, method = "GET", body?: unknown) => {
		const response = await fetch(`${base}/api${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
		return response.json();
	};
	try {
		await api("/skills/shipped", "POST", { add: [] });
		for (const name of ["mara", "atlas"])
			await api(`/agents/${name}`, "PUT", {
				base: null,
				text: `---\nname: ${name === "mara" ? "Mara" : "Atlas"}\ndescription: Search walkthrough\n---\nHelp the owner.\n`,
			});
		await api("/messages", "POST", {
			id: crypto.randomUUID(),
			thread: "agent:mara",
			text: "We chose Lisbon by train. Publish itinerary",
		});
		const { room } = (await api("/groups", "POST", { members: ["mara", "atlas"] })) as { room: number };
		await api(`/groups/${room}/messages`, "POST", {
			key: crypto.randomUUID(),
			text: "Lisbon: the group agreed on a morning train.",
		});
		await withPage(`${base}/#token=${token}`, { width, height: width < 768 ? 844 : 900 }, async (page) => {
			await page.until("document.body.textContent.includes('Atlas')", 30_000);
			await page.run("location.hash='#/a/atlas'");
			const composer = "document.querySelector('textarea[placeholder^=\"Message \"]')";
			await fill(page, composer, "Find our train decision", "HTMLTextAreaElement");
			await click(page, "document.querySelector('button[aria-label=\"Send\"]')");
			await page.until("document.body.textContent.includes('SUNRISE')", 30_000);
			if (!searched.some((kinds) => ["message", "group", "artifact"].every((kind) => kinds.includes(kind))))
				throw new Error("search did not cover every source kind");
			await page.until(
				"[...document.querySelectorAll('[data-source-kind=\"artifact\"]')].some(el=>el.textContent.includes('Lisbon itinerary'))",
				30_000,
			);
			for (const kind of ["message", "group", "artifact"]) {
				await page.until(`document.querySelector('[data-source-kind="${kind}"] svg')`, 30_000);
			}
			await page.until(
				"[...document.querySelectorAll('[data-source-kind=\"group\"]')].some(el=>el.textContent.includes('group agreed'))",
				30_000,
			);
			await page.until(
				"[...document.querySelectorAll('[data-source-kind=\"message\"]')].some(el=>el.textContent.includes('Lisbon'))",
				30_000,
			);
			await page.until(
				"document.querySelector('a[href=\"#/artifact/0000000000000000\"]')?.textContent.includes('Artifact')",
				30_000,
			);
			await page.shoot(`/tmp/banda-search-chat-${width}.png`);
			await click(page, "[...document.querySelectorAll('a')].find(el => el.textContent.endsWith('Open itinerary'))");
			await page.until("location.hash.startsWith('#/artifact/')", 30_000);
			await page.until("document.body.textContent.includes('SUNRISE')", 30_000);
			await page.run("location.hash='#/a/atlas'");
			await fill(page, composer, "Invalid cursor", "HTMLTextAreaElement");
			await click(page, "document.querySelector('button[aria-label=\"Send\"]')");
			await page.until("document.body.textContent.includes('Search failed.')", 30_000);
			await fill(page, composer, "Find our train decision", "HTMLTextAreaElement");
			await click(page, "document.querySelector('button[aria-label=\"Send\"]')");
			await page.until(
				"[...document.querySelectorAll('a')].filter(el => el.textContent.endsWith('Open itinerary')).length === 2",
				30_000,
			);
			await page.input("Input.dispatchKeyEvent", { type: "keyDown", key: "k", code: "KeyK", modifiers: 4 });
			await page.input("Input.dispatchKeyEvent", { type: "keyUp", key: "k", code: "KeyK", modifiers: 4 });
			await fill(page, "document.querySelector('input[aria-label=\"Search your chats\"]')", "Lisbon");
			await page.until("document.querySelector('[role=\"dialog\"]')?.textContent.includes('Lisbon itinerary')", 30_000);
			await page.shoot(`/tmp/banda-search-cmdk-${width}.png`);
			if (await page.run("document.documentElement.scrollWidth > innerWidth")) throw new Error("horizontal overflow");
			await page.run("location.hash='#/specimen/toolsets'");
			await page.until("document.querySelector('[aria-label=\"Files tools\"]')", 30_000);
			const headings = await page.run<string[]>(
				"[...document.querySelectorAll('h2')].map(el=>el.textContent).filter(text=>['Connections','Permissions','Tools'].includes(text))",
			);
			if (headings.join() !== "Connections,Permissions,Tools") throw new Error(`wrong section order: ${headings}`);
			if (await page.run("document.body.textContent.includes('Always available')")) throw new Error("stale copy");
			await click(page, "[...document.querySelectorAll('button')].find(el=>el.textContent==='Simulate save failure')");
			await click(page, "document.querySelector('[aria-label=\"Mara: Files\"]')");
			await page.until("document.querySelector('[role=\"alert\"]')");
			await click(page, "document.querySelector('[aria-label=\"Files tools\"]')");
			await click(page, "document.querySelector('summary')");
			await page.until("document.querySelector('[data-code-block=\"json\"] code span[style]')", 30_000);
			await page.run("document.querySelector('[data-code-block]').scrollIntoView({block:'center'})");
			await page.shoot(`/tmp/banda-search-schema-${width}.png`);
			if (await page.run("document.documentElement.scrollWidth > innerWidth")) throw new Error("preview overflow");
			if (page.errors().length) throw new Error(JSON.stringify(page.errors()));
		});
		console.log(JSON.stringify({ width, home, result: "passed", kinds: searched[0] }));
	} finally {
		await daemon.close();
	}
}
