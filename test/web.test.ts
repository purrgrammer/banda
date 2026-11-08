import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getCurrentTools,
	type Message,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { LEAD_TEXT } from "../src/core/agents.ts";
import { writeAvatarFace } from "../src/core/avatar-face.ts";
import { DEFAULT_FACE, DEFAULT_PERSONALITY, withPersonality } from "../src/core/choices.ts";
import { MAX_MEMORY_CHARS } from "../src/core/memory.ts";
import type { Status } from "../src/core/status.ts";
import { type DaemonOptions, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type {
	AgentView,
	Block,
	ChatPrompt,
	ChatRow,
	CompanionView,
	ControlView,
	Item,
	ItemPage,
	LiveEvent,
	MemoryView,
	Posted,
	ShellEvent,
} from "../src/server/api.ts";
import { plain } from "../src/server/transcript.ts";
import { demoEffects, type Ran } from "./fixtures/effects.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

const run = promisify(execFile);

async function start(
	options: { stream?: boolean; models?: MutableModels; maxFileBytes?: number; effects?: DaemonOptions["effects"] } = {},
) {
	const home = await tempHome();
	const files = options.maxFileBytes === undefined ? {} : { files: { maxBytes: options.maxFileBytes } };
	await writeFile(
		join(home, "config.json"),
		JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, ...files }),
	);
	const web = join(home, "web");
	await mkdir(join(web, "assets"), { recursive: true });
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	await writeFile(join(web, "assets", "app.js"), "console.log(1)");
	await writeFile(join(web, "manifest.webmanifest"), JSON.stringify({ name: "sancho" }));
	await writeFile(join(web, "sw.js"), "self.addEventListener('fetch', () => {})");
	// Streaming: a few tokens a commit, as pi-durable commits the answer being generated at most every partialIntervalMs.
	const faux = options.stream ? { tokensPerSecond: 200, tokenSize: { min: 2, max: 3 } } : undefined;
	const settings = options.stream ? { progress: { partialIntervalMs: 20 } } : undefined;
	const daemon = await startDaemon({
		home,
		port: 0,
		models: options.models ?? echoModels(undefined, faux).models,
		log: () => {},
		box: hostBox(home),
		web,
		...(settings === undefined ? {} : { settings }),
		...(options.effects === undefined ? {} : { effects: options.effects }),
	});
	const token = (await readDaemonFile(home))!.token!;
	const url = `http://127.0.0.1:${daemon.port}`;
	const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await fetch(`${url}/api${path}`, {
			...init,
			headers: { authorization: `Bearer ${token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	};
	/** A message that starts a Turn. */
	const post = (text: string, thread: string, id = randomUUID()) =>
		api<Extract<Posted, { turn: number }>>("/messages", { method: "POST", body: JSON.stringify({ id, thread, text }) });
	return { home, daemon, token, url, api, post };
}

/** Every item of a transcript, read newest page first, back to the start. */
async function everything(api: <T>(path: string) => Promise<T>, chat: number): Promise<Item[]> {
	const pages: Item[][] = [];
	let before: number | undefined;
	for (;;) {
		const page = await api<ItemPage>(`/chats/${chat}/items${before === undefined ? "" : `?before=${before}`}`);
		pages.unshift([...page.items]);
		if (page.next === undefined) return pages.flat();
		before = page.next;
	}
}

/** A server-sent event stream, read with fetch as the UI reads it (EventSource cannot send the token). */
function listen<E = LiveEvent>(url: string, token: string) {
	const events: E[] = [];
	const waiters: (() => void)[] = [];
	const stop = new AbortController();
	const done = (async () => {
		const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: stop.signal });
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of response.body!) {
			buffer += decoder.decode(chunk as Uint8Array, { stream: true });
			for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
				events.push(JSON.parse(buffer.slice(0, end).replace(/^data: /, "")) as E);
				buffer = buffer.slice(end + 2);
				for (const wake of waiters.splice(0)) wake();
			}
		}
	})().catch(() => undefined);
	const until = async (test: (events: E[]) => boolean) => {
		// on state: the test's timeout bounds it
		while (!test(events)) {
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
	};
	const close = () => {
		stop.abort();
		return done;
	};
	return { events, until, close };
}

describe("web", () => {
	it("bounded reads follow displayed replies without consuming later ones or regressing after a stale read", async () => {
		const { daemon, api, post, token, url } = await start();
		const shell = listen<ShellEvent>(`${url}/api/events`, token);
		let transcript: ReturnType<typeof listen<LiveEvent>> | undefined;
		try {
			const thread = randomUUID();
			const { chat } = await post("before opening", thread);
			const row = async () => (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat);
			await until(async () => (await row())?.state === "idle");
			expect((await row())?.unread).toBe(1);
			const shown = await everything(api, chat);
			const through = shown.at(-1)?.id ?? 0;
			transcript = listen(`${url}/api/chats/${chat}/events`, token);
			await transcript.until((events) => events.some((event) => event.type === "ready"));
			expect((await row())?.unread).toBe(1);
			await shell.until((events) =>
				events.some(
					(event) => event.type === "chats" && event.rows.some((row) => row.chat === chat && row.unread === 1),
				),
			);
			const beforeRead = shell.events.length;
			expect(await api(`/chats/${chat}/read`, { method: "POST", body: JSON.stringify({ through }) })).toEqual({
				read: true,
			});
			// No task graph change: the read doc itself must wake the shell stream.
			await shell.until((events) =>
				events
					.slice(beforeRead)
					.some((event) => event.type === "chats" && event.rows.some((row) => row.chat === chat && row.unread === 0)),
			);
			await post("after opening", thread);
			await until(async () => (await row())?.state === "idle");
			const later = await everything(api, chat);
			expect((await row())?.unread).toBe(1);
			// A delayed read from the old screen cannot mark a reply it never displayed.
			await api(`/chats/${chat}/read`, { method: "POST", body: JSON.stringify({ through }) });
			expect((await row())?.unread).toBe(1);
			await api(`/chats/${chat}/read`, {
				method: "POST",
				body: JSON.stringify({ through: later.at(-1)?.id ?? 0 }),
			});
			expect((await row())?.unread).toBe(0);
			await api(`/chats/${chat}/read`, { method: "POST", body: JSON.stringify({ through }) });
			expect((await row())?.unread).toBe(0); // an older tab cannot move the cursor backwards
			await expect(api("/chats/999999999/read", { method: "POST", body: JSON.stringify({ through }) })).rejects.toThrow(
				"404",
			);
			await expect(
				api(`/chats/${chat}/read`, { method: "POST", body: JSON.stringify({ through: -1 }) }),
			).rejects.toThrow("400");
		} finally {
			await transcript?.close();
			await shell.close();
			await daemon.close();
		}
	});

	it("a message on a new thread starts a chat the list and its transcript show", async () => {
		const { daemon, api, post } = await start();
		try {
			const thread = randomUUID();
			const id = randomUUID();
			const first = await post("hello web", thread, id);
			expect(await post("hello web", thread, id)).toEqual(first);
			// answered before the next comes, so that one is a run of its own, not a follow-up batched into it
			await until(async () => (await everything(api, first.chat)).length === 4);
			const second = await post("and again", thread);
			expect(second.chat).toBe(first.chat);
			const other = await post("elsewhere", randomUUID());
			expect(other.chat).not.toBe(first.chat);
			await until(async () => (await api<ChatRow[]>("/chats")).every((c) => c.state === "idle"));
			await until(async () => (await everything(api, first.chat)).length === 8);
			const rows = await api<ChatRow[]>("/chats");
			// each says when it last heard or said something
			for (const row of rows) expect(row.at).toBeGreaterThan(Date.now() - 60_000);
			expect(rows.map((r) => [r.title, r.origin.gateway, r.origin.thread])).toEqual([
				["elsewhere", "web", expect.any(String)],
				["hello web", "web", thread],
			]);
			const transcript = await everything(api, first.chat);
			// each answer: the message, its result, then the run's notes
			expect(transcript.map((item) => [item.role, "text" in item ? item.text : undefined])).toEqual([
				["user", "hello web"],
				["assistant", ""],
				["tool", "Sent."],
				["assistant", "sent: re: hello web"],
				["user", "and again"],
				["assistant", ""],
				["tool", "Sent."],
				["assistant", "sent: re: and again"],
			]);
			const message = transcript[1];
			expect(message?.role === "assistant" && message.calls).toEqual([
				{ id: expect.any(String), name: "message_user", args: { text: "re: hello web" } },
			]);
		} finally {
			await daemon.close();
		}
	});

	it("pushes the chat list whole, again when a chat starts or ends", async () => {
		const { daemon, token, url, post } = await start();
		const shell = listen<ShellEvent>(`${url}/api/events`, token);
		try {
			await shell.until((events) => events.some((e) => e.type === "chats"));
			expect(shell.events[0]).toEqual({ type: "chats", rows: [] });
			await post("pushed", randomUUID());
			await shell.until((events) =>
				events.some((e) => e.type === "chats" && e.rows[0]?.title === "pushed" && e.rows[0].state === "idle"),
			);
		} finally {
			await shell.close();
			await daemon.close();
		}
	});

	it("agent files: a box change shows, takes effect once accepted as shown, and decline puts the accepted one back", async () => {
		const { home, daemon, api } = await start();
		const dir = join(home, "workspace", "agents");
		const agents = () => api<AgentView[]>("/agents");
		const send = (path: string, body: unknown, method = "POST") =>
			api<AgentView[]>(path, { method, body: JSON.stringify(body) });
		try {
			// a new box gets the lead, accepted
			await until(async () => existsSync(join(dir, "sancho.md")));
			const [lead] = await agents();
			expect(lead).toMatchObject({ name: "sancho", accepted: { agent: { name: "sancho" } } });
			expect(lead?.change).toBeUndefined();
			// the box writes a specialist: a change, in effect only once accepted
			const text = "---\ndescription: Reads\ntools: [read]\n---\nRead only.\n";
			await writeFile(join(dir, "reader.md"), text);
			const added = (await agents()).find((agent) => agent.name === "reader");
			expect(added).toEqual({
				name: "reader",
				change: {
					kind: "added",
					sha: added?.change && "sha" in added.change ? added.change.sha : "",
					text,
					agent: {
						id: "reader",
						name: "reader",
						face: DEFAULT_FACE,
						state: "active",
						description: "Reads",
						tools: ["read"],
						instructions: "Read only.",
					},
				},
			});
			const thread = () => ({ id: randomUUID(), thread: randomUUID(), text: "hi", agent: "reader" });
			await expect(api("/messages", { method: "POST", body: JSON.stringify(thread()) })).resolves.toEqual({
				refused: "there is no agent named reader",
			});
			const sha = (added?.change as { sha: string } | undefined)?.sha;
			// what the owner saw is what is accepted: a file changed since is refused
			await writeFile(join(dir, "reader.md"), text.replace("Read only.", "Write too."));
			await expect(send("/agents/reader/accept", { sha })).rejects.toThrow(/^409 .*changed since you saw it/);
			await writeFile(join(dir, "reader.md"), text);
			const accepted = await send("/agents/reader/accept", { sha });
			expect(accepted.find((agent) => agent.name === "reader")).toMatchObject({
				accepted: { sha, agent: { tools: ["read"] } },
			});
			const posted = await api<Posted>("/messages", { method: "POST", body: JSON.stringify(thread()) });
			expect(posted).toMatchObject({ turn: expect.any(Number) });
			await until(async () => (await api<ChatRow[]>("/chats")).some((row) => row.agent === "reader"));
			// one that does not parse is refused, each problem said
			await writeFile(join(dir, "reader.md"), "---\ntools: [nope]\n---\n");
			const broken = (await agents()).find((agent) => agent.name === "reader");
			expect(broken?.change).toMatchObject({
				kind: "changed",
				errors: [expect.stringMatching(/description/), expect.stringMatching(/"nope" is not a tool/)],
			});
			await expect(
				send("/agents/reader/accept", { sha: (broken?.change as { sha?: string } | undefined)?.sha }),
			).rejects.toThrow(/^400 /);
			// declined, the accepted file is written back
			await send("/agents/reader/decline", {});
			expect(await readFile(join(dir, "reader.md"), "utf8")).toBe(text);
			// a removal is accepted like any change; the lead's never is
			await run("rm", [join(dir, "reader.md"), join(dir, "sancho.md")]);
			expect((await agents()).map((agent) => [agent.name, agent.change?.kind])).toEqual([
				["sancho", "removed"],
				["reader", "removed"],
			]);
			await expect(send("/agents/sancho/accept", { sha: null })).rejects.toThrow(/^400 .*cannot be removed/);
			await send("/agents/sancho/decline", {});
			expect((await send("/agents/reader/accept", { sha: null })).map((agent) => agent.name)).toEqual(["sancho"]);
			// The owner's direct path saves only the reviewed preview and accepts those same bytes at once.
			const planner = "---\nname: Mira\ndescription: Plans trips\ntier: balanced\ntools: [read]\n---\nBe practical.\n";
			const created = await send("/agents/trip-planner", { text: planner, base: null }, "PUT");
			expect(created.find((agent) => agent.name === "trip-planner")).toMatchObject({
				accepted: { text: planner, agent: { id: "trip-planner", name: "Mira", tools: ["read"] } },
			});
			expect(await readFile(join(dir, "trip-planner.md"), "utf8")).toBe(planner);
			await expect(send("/agents/trip-planner", { text: planner, base: null }, "PUT")).rejects.toThrow(
				/^409 .*already an agent/,
			);
		} finally {
			await daemon.close();
		}
	});

	it("memory: the owner's facts and the box's in effect at once, a deletion real; a source's message", async () => {
		const { home, daemon, url, token, api, post } = await start();
		const shell = listen<ShellEvent>(`${url}/api/events`, token);
		const send = (path: string, body?: unknown, method = "POST") =>
			api<MemoryView>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		try {
			expect(await api<MemoryView>("/memory")).toEqual({ facts: [], budget: MAX_MEMORY_CHARS });
			// the owner's own fact, always in mind: in effect at once
			const added = await send("/memory", { text: "Never books flights before 9am", scope: "global" });
			expect(added.facts).toEqual([
				expect.objectContaining({
					text: "Never books flights before 9am",
					scope: "global",
					from: { owner: true },
					size: expect.any(Number),
				}),
			]);
			await expect(send("/memory", { text: "  " })).rejects.toThrow(/^400 /);
			await expect(send("/memory", { text: "x", scope: "unknown" })).rejects.toThrow(/^400 /);
			// whom a fact is about is declared by the owner, never detected; shared memory refuses it
			await expect(send("/memory", { text: "Sarah is vegetarian", scope: "global", about: "Sarah" })).rejects.toThrow(
				/^400 .*stays with an agent/,
			);
			// the box adds a core fact of its own: in effect at once, and the app is told
			const core = join(home, "workspace", "memory", "global.md");
			await writeFile(core, `${await readFile(core, "utf8")}- Allergic to peanuts\n`);
			const remembered = await api<MemoryView>("/memory");
			expect(remembered.facts.map((fact) => fact.text)).toEqual([
				"Never books flights before 9am",
				"Allergic to peanuts",
			]);
			const change = remembered.facts.find((fact) => fact.text === "Allergic to peanuts");
			await shell.until((events) => events.some((event) => event.type === "memory" && event.memory.facts.length === 2));
			// edited and deleted, as the owner
			const edited = await send(`/memory/${change?.id}`, { text: "Allergic to peanuts and cashews" }, "PUT");
			const fact = edited.facts.find((one) => one.text === "Allergic to peanuts and cashews");
			expect(fact).toMatchObject({ edited: expect.any(Number) });
			const gone = await send(`/memory/${fact?.id}`, undefined, "DELETE");
			expect(gone.facts.map((one) => one.text)).toEqual(["Never books flights before 9am"]);
			expect(await readFile(core, "utf8")).not.toContain("peanuts");
			expect((await readFile(join(home, "search.db"))).toString("latin1")).not.toContain("cashews");
			await expect(send(`/memory/${fact?.id}`, undefined, "DELETE")).rejects.toThrow(/^409 /);
			// a fact's source: the message it came from, one item of a transcript
			const { chat } = await post("hello there", randomUUID());
			await until(async () => (await everything(api, chat)).some((item) => item.role === "assistant"));
			const [first] = await everything(api, chat);
			expect(await api<Item>(`/chats/${chat}/items/${first?.id}`)).toMatchObject({
				role: "user",
				text: "hello there",
			});
			await expect(api(`/chats/${chat}/items/999999`)).rejects.toThrow(/^404 /);
		} finally {
			await shell.close();
			await daemon.close();
		}
	});

	it("the companion: named by default, each pick stored, a bad one refused with why", async () => {
		const { daemon, api, home } = await start();
		try {
			const idle = {
				name: "Sancho",
				face: DEFAULT_FACE,
				personality: DEFAULT_PERSONALITY,
				tier: "quick",
			};
			expect(await api<CompanionView>("/companion")).toEqual(idle);
			const put = (body: unknown) => api<CompanionView>("/companion", { method: "PUT", body: JSON.stringify(body) });
			expect(await put({ name: "  Rocinante " })).toEqual({ ...idle, name: "Rocinante" });
			await expect(put({ name: "   " })).rejects.toThrow(/^400 .*at least one letter/);
			await expect(put({ name: "x".repeat(41) })).rejects.toThrow(/^400 .*at most 40 characters/);
			await expect(put({ name: "two\nlines" })).rejects.toThrow(/^400 .*one line of plain characters/);
			await expect(put({ name: 7 })).rejects.toThrow(/^400 .*as text/);
			// An avatar is validated geometry and colour, not emoji or markup.
			const face = { ...DEFAULT_FACE, color: "#abcdef" };
			expect((await put({ face })).face).toEqual(face);
			await expect(put({ face: { emoji: "🛡️" } })).rejects.toThrow(/^400 /);
			await expect(put({ face: { ...face, color: "url(https://example.com)" } })).rejects.toThrow(/^400 /);
			await expect(put({ personality: 7 })).rejects.toThrow(/^400 .*as text/);
			await expect(put({ personality: "Brief.\n## Tools\nall" })).rejects.toThrow(/^400 .*no headings/);
			// a refused pick stores none of the others given with it
			await expect(put({ name: "Dapple", face: { emoji: "ab" } })).rejects.toThrow(/^400 /);
			expect((await api<CompanionView>("/companion")).name).toBe("Rocinante");
			// the personality, in the owner's words, is written into the lead's file, their change, accepted at once
			const changed = await put({ personality: "  Be brief,\nand dry.  " });
			expect(changed).toMatchObject({ personality: "Be brief,\nand dry." });
			const file = await readFile(join(home, "workspace", "agents", "sancho.md"), "utf8");
			expect(file).toBe(
				withPersonality(LEAD_TEXT.replace(writeAvatarFace(DEFAULT_FACE), writeAvatarFace(face)), "Be brief,\nand dry."),
			);
			const lead = (await api<AgentView[]>("/agents")).find((agent) => agent.name === "sancho");
			expect(lead?.accepted?.text).toBe(file);
			expect(lead?.change).toBeUndefined();
			// words written into the file itself, once accepted, are what Identity shows
			await writeFile(
				join(home, "workspace", "agents", "sancho.md"),
				file.replace("Be brief,\nand dry.", "Talk like a pirate."),
			);
			const own = (await api<AgentView[]>("/agents")).find((agent) => agent.name === "sancho");
			await api("/agents/sancho/accept", {
				method: "POST",
				body: JSON.stringify({ sha: (own?.change as { sha?: string } | undefined)?.sha }),
			});
			expect((await api<CompanionView>("/companion")).personality).toBe("Talk like a pirate.");
		} finally {
			await daemon.close();
		}
	});

	it("titles a chat with its first message as plain text", () => {
		expect(plain("# banda: design\nA **personal** agent, see [the plan](PLAN.md) and `code`")).toBe(
			"banda: design A personal agent, see the plan and code",
		);
		expect(plain("- one\n- two\n```ts\nx()\n```")).toBe("one two x()");
		expect(plain("snake_case_name stays")).toBe("snake_case_name stays");
	});

	it("reads the prompt and whole unused toolset of the selected historical request, not today's definition", async () => {
		const { daemon, api, post } = await start();
		try {
			const firstText = "---\ndescription: Reader\ntools: [read]\n---\nHistorical instruction: FIRST.\n";
			await api("/agents/reader", { method: "PUT", body: JSON.stringify({ text: firstText, base: null }) });
			const thread = randomUUID();
			const send = () =>
				api<Extract<Posted, { turn: number }>>("/messages", {
					method: "POST",
					body: JSON.stringify({ id: randomUUID(), thread, agent: "reader", text: "hello" }),
				});
			const { chat } = await send();
			await expect.poll(() => everything(api, chat), { timeout: 3000 }).toHaveLength(4);
			const first = (await everything(api, chat)).find((item) => item.role === "assistant")!;
			const original = await api<ChatPrompt>(`/chats/${chat}/prompt?at=${first.id}`);
			expect(original.system).toContain("FIRST");
			expect(original.tools.some((tool) => tool.name === "read" && Object.keys(tool.parameters).length > 0)).toBe(true);
			expect(first.role === "assistant" && first.calls?.some((call) => call.name === "read")).toBe(false);
			const reader = (await api<AgentView[]>("/agents")).find((agent) => agent.name === "reader")!;
			await api("/agents/reader", {
				method: "PUT",
				body: JSON.stringify({
					text: firstText.replace("[read]", "[read, bash]").replace("FIRST", "SECOND"),
					base: reader.accepted?.sha,
				}),
			});
			await send();
			await until(
				async () =>
					(await everything(api, chat)).filter((item) => item.role === "user").length === 2 &&
					(await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle",
			);
			const newest = await api<ChatPrompt>(`/chats/${chat}/prompt`);
			expect(newest.system).toContain("SECOND");
			expect(newest.tools.some((tool) => tool.name === "bash")).toBe(true);
			expect(await api(`/chats/${chat}/prompt?at=${first.id}`)).toEqual(original);
			const other = await post("other chat", randomUUID());
			await until(async () => (await everything(api, other.chat)).length === 4);
			const foreign = (await everything(api, other.chat))[0]!;
			await expect(api(`/chats/${chat}/prompt?at=${foreign.id}`)).rejects.toThrow(/^404 /);
			for (const at of ["0", "-1", "oops", "1.5", "9007199254740993"])
				await expect(api(`/chats/${chat}/prompt?at=${at}`)).rejects.toThrow(/^400 /);
			await expect(api(`/chats/${chat}/prompt?at=99999999`)).rejects.toThrow(/^404 /);
		} finally {
			await daemon.close();
		}
	});

	it("pages a long transcript back to its start, and forward from any entry", async () => {
		const { daemon, api, post } = await start();
		try {
			const thread = randomUUID();
			let chat = 0;
			// each answered before the next comes, so each is a run of its own
			for (let i = 0; i < 40; i++) {
				chat = (await post(`m${i}`, thread)).chat;
				await until(async () => (await everything(api, chat)).length === 4 * (i + 1));
			}
			await until(async () => (await everything(api, chat)).length === 160);
			const all = await everything(api, chat);
			expect(all.filter((item) => item.role === "user").map((item) => item.text)).toEqual(
				Array.from({ length: 40 }, (_, i) => `m${i}`),
			);
			const latest = await api<ItemPage>(`/chats/${chat}/items`);
			expect(latest.next).toBeDefined();
			expect(latest.items.at(-1)).toEqual(all.at(-1));
			const middle = all.at(-30)!;
			const forward = await api<ItemPage>(`/chats/${chat}/items?after=${middle.id}`);
			expect(forward.items).toEqual(all.slice(-29));
			const bounded = await api<ItemPage>(`/chats/${chat}/items?after=${all[10]!.id}&through=${all[12]!.id}`);
			expect(bounded.items).toEqual(all.slice(11, 13));
		} finally {
			await daemon.close();
		}
	});

	it("streams the available tool-call blocks and active input through reconnect without inventing arguments", async () => {
		const value = "recorded argument ".repeat(60);
		const faux = fauxProvider({ tokensPerSecond: 1200, tokenSize: { min: 8, max: 8 } });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("sent"),
			fauxAssistantMessage([fauxToolCall("not_offered", { nested: { value }, values: [value] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("sent"),
		]);
		const { daemon, api, post, token, url } = await start({ models, stream: true });
		const streams: ReturnType<typeof listen>[] = [];
		try {
			const thread = randomUUID();
			const { chat } = await post("warm up", thread);
			await until(async () => (await everything(api, chat)).length === 4);
			const stream = listen(`${url}/api/chats/${chat}/events`, token);
			streams.push(stream);
			await stream.until((events) => events.some((event) => event.type === "ready"));
			await post("stream arguments", thread);
			// Faux exposes the identity immediately, but no parsed arguments until toolcall_end.
			await stream.until((events) =>
				events.some(
					(event) =>
						event.type === "start" &&
						event.partial.some(
							(block) => block.call?.name === "not_offered" && Object.keys(block.call.args).length === 0,
						),
				),
			);
			const again = listen(`${url}/api/chats/${chat}/events`, token);
			streams.push(again);
			await again.until((events) => events.some((event) => event.type === "ready"));
			const ready = again.events.find((event) => event.type === "ready") as Extract<LiveEvent, { type: "ready" }>;
			expect(ready.busy).toBe(true);
			expect(ready.input).toBeDefined();
			expect(ready.partial.some((block) => block.call?.name === "not_offered")).toBe(true);
			await until(async () => (await api<ChatRow[]>("/chats")).find((row) => row.chat === chat)?.state === "idle");
			const items = await everything(api, chat);
			expect(items.find((item) => item.id === ready.input)).toMatchObject({ role: "user", text: "stream arguments" });
			const called = items
				.flatMap((item) => (item.role === "assistant" ? (item.calls ?? []) : []))
				.find((call) => call.name === "not_offered");
			expect(called?.args).toEqual({ nested: { value }, values: [value] });
		} finally {
			for (const stream of streams) stream.close();
			await daemon.close();
		}
	});

	it("streams the notes as they are generated, then the entries, to a live client", async () => {
		const { daemon, api, post, token, url } = await start({ stream: true });
		try {
			const thread = randomUUID();
			const { chat } = await post("one", thread);
			await until(async () => (await everything(api, chat)).length === 4);
			const stream = listen(`${url}/api/chats/${chat}/events`, token);
			await stream.until((events) => events.some((e) => e.type === "ready"));
			const ready = stream.events[0] as Extract<LiveEvent, { type: "ready" }>;
			expect(ready).toMatchObject({ type: "ready", busy: false, partial: [] });
			expect((await everything(api, chat)).at(-1)!.id).toBe(ready.tail);
			const long = "a longer message, so that its echo streams in several deltas";
			await post(long, thread);
			await stream.until((events) =>
				events.some((e) => e.type === "entry" && e.item.role === "assistant" && e.item.text !== ""),
			);
			await stream.until((events) => events.some((e) => e.type === "busy" && !e.busy));
			const types = stream.events.map((e) => e.type);
			expect(types).toContain("delta");
			expect(types.indexOf("busy")).toBeLessThan(types.indexOf("delta"));
			let partial: string[] = [];
			for (const event of stream.events) {
				if (event.type === "start") partial = event.partial.map((block) => block.text);
				if (event.type === "delta") partial[event.index] = (partial[event.index] ?? "") + event.text;
			}
			// The partial is a prefix of the notes; the rest arrives with their entry, which replaces it.
			expect(partial.join("").length).toBeGreaterThan(0);
			expect(`sent: re: ${long}`.startsWith(partial.join(""))).toBe(true);
			const entries = stream.events.flatMap((e) => (e.type === "entry" ? [e.item] : []));
			expect(entries.map((item) => [item.role, "text" in item ? item.text : undefined])).toEqual([
				["user", long],
				["assistant", ""],
				["tool", "Sent."],
				["assistant", `sent: re: ${long}`],
			]);
			expect(entries.every((item) => item.id > ready.tail)).toBe(true);
			await stream.close();
		} finally {
			await daemon.close();
		}
	});

	it("a message carries files uploaded first: documents into the box and named by blob, images also seen", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const seen: string[] = [];
		faux.setResponses([
			(request: { messages: readonly { role: string; content: unknown }[] }) => {
				seen.push(JSON.stringify(request.messages.at(-1)?.content));
				return fauxAssistantMessage("noted");
			},
		]);
		const { daemon, api, home, token, url } = await start({ models });
		try {
			const put = async (name: string, body: Buffer) => {
				const response = await fetch(`${url}/api/blobs`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "x-file-name": encodeURIComponent(name) },
					body,
				});
				return (await response.json()) as { sha: string; name: string; mimeType: string; size: number };
			};
			const pdf = Buffer.from("%PDF-1.4 a report");
			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			);
			const report = await put("report.pdf", pdf);
			const dot = await put("dot.png", png);
			expect(report).toMatchObject({ name: "report.pdf", mimeType: "application/pdf", size: pdf.length });
			// uploaded, held by no chat yet: not served
			const blob = (sha: string) =>
				fetch(`${url}/api/blobs/${sha}?name=x`, { headers: { authorization: `Bearer ${token}` } });
			expect((await blob(report.sha)).status).toBe(404);
			const posted = await api<{ chat: number }>("/messages", {
				method: "POST",
				body: JSON.stringify({
					id: randomUUID(),
					thread: randomUUID(),
					text: "read these",
					files: [
						{ sha: report.sha, name: "report.pdf" },
						{ sha: dot.sha, name: "dot.png" },
					],
				}),
			});
			await until(async () => seen.length > 0);
			await until(async () => (await api<ChatRow[]>("/chats"))[0]?.state === "idle");
			// the model reads the files as links to their blobs and their paths in the box, and sees the image
			const placed = join(home, "work", "attachments", report.sha.slice(0, 8), "report.pdf");
			expect(seen[0]).toContain(
				`Attached: [report.pdf](sha256:${report.sha}) (application/pdf, 1 KB), in your box at ${placed}`,
			);
			expect(seen[0]).toContain("read these");
			expect(seen[0]).toContain('"type":"image"');
			expect(await readFile(placed)).toEqual(pdf);
			// the owner's bubble: their words, the image, and the files by blob
			const [user] = (await everything(api, posted.chat)) as Extract<Item, { role: "user" }>[];
			expect(user).toMatchObject({ text: "read these", images: 1 });
			expect(user?.files?.map((file) => file.name)).toEqual(["report.pdf", "dot.png"]);
			const served = await blob(report.sha);
			expect(served.headers.get("content-type")).toBe("application/octet-stream");
			expect(Buffer.from(await served.arrayBuffer())).toEqual(pdf);
			// a blob that is not there is refused, not taken as a message
			const missing = await fetch(`${url}/api/messages`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({
					id: randomUUID(),
					thread: randomUUID(),
					text: "",
					files: [{ sha: "0".repeat(64), name: "gone.pdf" }],
				}),
			});
			expect(missing.status).toBe(400);
			expect(await missing.json()).toEqual({ error: "gone.pdf is no longer uploaded: attach it again" });
		} finally {
			await daemon.close();
		}
	});

	it("a file past the configured limit is refused with its size and the limit, before it is stored", async () => {
		const { daemon, api, home, token, url } = await start({ maxFileBytes: 1024 });
		try {
			expect(await api("/limits")).toEqual({ fileBytes: 1024 });
			const put = (body: Buffer) =>
				fetch(`${url}/api/blobs`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "x-file-name": "big.bin" },
					body,
				});
			const refused = await put(Buffer.alloc(4096));
			expect(refused.status).toBe(413);
			expect(await refused.json()).toEqual({ error: "big.bin is 4 KB; a file may be 1 KB at most" });
			expect(existsSync(join(home, "blobs"))).toBe(false);
			expect((await put(Buffer.alloc(1024))).status).toBe(200);
		} finally {
			await daemon.close();
		}
	});

	it("serves a message's files as sent: an image inline, anything else only as a download", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("message_user", { text: "Both.", files: ["plot.png", "page.html"] }, { id: "m1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("noted"),
		]);
		const { daemon, api, post, home, token, url } = await start({ models });
		try {
			await mkdir(join(home, "workspace"), { recursive: true });
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
			await writeFile(join(home, "workspace", "plot.png"), png);
			await writeFile(join(home, "workspace", "page.html"), "<script>alert(1)</script>");
			const { chat } = await post("send both", randomUUID());
			await until(async () => (await api<ChatRow[]>("/chats"))[0]?.state === "idle");
			const get = (path: string) =>
				fetch(`${url}/api/chats/${chat}/messages/m1/files/${path}`, {
					headers: { authorization: `Bearer ${token}` },
				});
			const image = await get("0");
			expect(image.headers.get("content-type")).toBe("image/png");
			expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
			const page = await get("1");
			// never rendered on the daemon's origin
			expect(page.headers.get("content-type")).toBe("application/octet-stream");
			expect(page.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
			expect(await page.text()).toBe("<script>alert(1)</script>");
			expect((await get("2")).status).toBe(404);
			expect((await fetch(`${url}/api/chats/${chat}/messages/m1/files/0`)).status, "without the token").toBe(401);
		} finally {
			await daemon.close();
		}
	});

	it("tool calls: the call in its answer, live output, then the result", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const command = "echo one; sleep 0.4; echo two; sleep 0.4; echo three";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Ran it."),
		]);
		const { daemon, api, post, token, url } = await start({ models, stream: true });
		try {
			const { chat } = await post("run it", randomUUID());
			const stream = listen(`${url}/api/chats/${chat}/events`, token);
			await stream.until((events) => events.some((e) => e.type === "toolEnd" && e.call === "c1"));
			await stream.until((events) => events.some((e) => e.type === "busy" && !e.busy));
			// what it printed before the client came arrives in `ready`'s running call, the rest as output events
			const outputs = stream.events.flatMap((e) =>
				e.type === "output" && e.call === "c1"
					? [e.set ?? e.append ?? ""]
					: e.type === "ready"
						? e.running.flatMap((tool) => (tool.call === "c1" && tool.output !== "" ? [tool.output] : []))
						: [],
			);
			// started before or after the client came: in `ready`'s running calls, or as its own event, with its line
			expect(
				stream.events.some(
					(e) =>
						(e.type === "tool" && e.call === "c1" && e.name === "bash" && e.doing === "running a command") ||
						(e.type === "ready" && e.running.some((tool) => tool.call === "c1" && tool.doing === "running a command")),
				),
			).toBe(true);
			// the output arrived while it ran, in more than one piece
			expect(outputs.length).toBeGreaterThan(1);
			expect(outputs.join("")).toContain("one");
			await stream.close();
			const items = await everything(api, chat);
			const calls = items.flatMap((item) => (item.role === "assistant" ? (item.calls ?? []) : []));
			expect(calls).toEqual([{ id: "c1", name: "bash", args: { command } }]);
			expect(items.find((item) => item.role === "wait")).toBeUndefined();
			expect(items.find((item) => item.role === "tool")).toMatchObject({
				call: "c1",
				name: "bash",
				text: "one\ntwo\nthree\n",
				error: false,
			});
		} finally {
			await daemon.close();
		}
	});

	it("work in progress is one plain line: the live call and a client that came late both carry it", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			// the first run answers with a reaction, so it is not left unanswered
			fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" }, { id: "h1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("hello"),
			fauxAssistantMessage([fauxToolCall("read", { path: "/workspace/x/notes.md" }, { id: "r1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "sleep 2; echo done" }, { id: "b1" }),
					fauxToolCall("message_user", { text: "hi" }, { id: "m1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Read it."),
		]);
		const { daemon, api, post, token, url } = await start({ models });
		try {
			const thread = randomUUID();
			const { chat } = await post("hi", thread);
			await until(async () => (await everything(api, chat)).length === 4);
			const stream = listen(`${url}/api/chats/${chat}/events`, token);
			await stream.until((events) => events.some((e) => e.type === "ready"));
			await post("read my notes", thread);
			await stream.until((events) => events.some((e) => e.type === "tool" && e.call === "b1"));
			expect(stream.events.find((e) => e.type === "tool" && e.call === "r1")).toMatchObject({
				name: "read",
				doing: "reading notes.md",
			});
			// a client that comes while the command runs finds it in `ready`, with its line
			const late = listen(`${url}/api/chats/${chat}/events`, token);
			await late.until((events) => events.some((e) => e.type === "ready"));
			const ready = late.events.find((e) => e.type === "ready");
			expect(ready?.type === "ready" && ready.running.find((tool) => tool.call === "b1")).toMatchObject({
				doing: "running a command",
			});
			await stream.until((events) => events.some((e) => e.type === "tool" && e.call === "m1"));
			const message = stream.events.find((e) => e.type === "tool" && e.call === "m1");
			expect(message?.type === "tool" && "doing" in message).toBe(false);
			await late.close();
			await stream.close();
		} finally {
			await daemon.close();
		}
	});

	it("a stopped answer still says how long it thought", async () => {
		const faux = fauxProvider({ tokensPerSecond: 50, tokenSize: { min: 2, max: 2 } });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([
				fauxThinking("a very long and slow line of thought that goes on and on ".repeat(10)),
				fauxText("never"),
			]),
		]);
		const { daemon, api, post, url, token } = await start({ models, stream: true });
		try {
			const { chat } = await post("think", randomUUID());
			// stopped once thinking has streamed for a while, however late a loaded machine starts it
			const stream = listen(`${url}/api/chats/${chat}/events`, token);
			let thinking: number | undefined;
			await stream.until((events) => {
				if (thinking === undefined && events.some((e) => e.type === "start" && e.partial[0]?.type === "thinking"))
					thinking = Date.now();
				return thinking !== undefined && Date.now() - thinking >= 400;
			});
			await stream.close();
			await api(`/chats/${chat}/stop`, { method: "POST" });
			await until(async () => (await everything(api, chat)).some((item) => item.role === "assistant"));
			const reply = (await everything(api, chat)).find((item) => item.role === "assistant");
			expect(reply).toMatchObject({ role: "assistant", error: "interrupted" });
			expect(reply?.role === "assistant" && reply.thinkingMs).toBeGreaterThan(200);
		} finally {
			await daemon.close();
		}
	});

	it("shows the model's thinking, and how long it thought", async () => {
		// Slow enough that the thinking block takes a measurable while to stream.
		const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 2, max: 2 } });
		const models = createModels();
		models.setProvider(faux.provider);
		// each run answers the owner with a reaction, so none is left unanswered
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("message_user", { reaction: "👍" }, { id: "w1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("warm"),
		]);
		const { daemon, api, post, url, token } = await start({ models, stream: true });
		try {
			const thread = randomUUID();
			const { chat } = await post("warm up", thread);
			// The answer streams for a while too, so a live client sees the thinking end before the entry lands.
			faux.appendResponses([
				fauxAssistantMessage(
					[
						fauxThinking("weighing the options, slowly"),
						fauxText("done, after weighing it all"),
						fauxToolCall("message_user", { reaction: "👍" }, { id: "t1" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("noted"),
			]);
			await until(async () => (await everything(api, chat)).length === 4);
			const stream = listen(`${url}/api/chats/${chat}/events`, token);
			await stream.until((events) => events.some((e) => e.type === "ready"));
			const blocks: { thinking?: Block; firstSeen?: number } = {};
			const seen = setInterval(() => {
				for (const event of stream.events)
					if (event.type === "start")
						for (const block of event.partial)
							if (block.type === "thinking") {
								blocks.firstSeen ??= Date.now();
								blocks.thinking = block;
							}
			}, 5);
			await post("think first", thread);
			await until(async () => (await everything(api, chat)).length === 8);
			await stream.close();
			clearInterval(seen);
			const reply = (await everything(api, chat)).find((item) => item.role === "assistant" && item.thinking)!;
			expect(reply).toMatchObject({
				role: "assistant",
				text: "done, after weighing it all",
				thinking: "weighing the options, slowly",
			});
			expect(reply.role === "assistant" && reply.thinkingMs).toBeGreaterThan(50);
			// A live client sees the block's start and end as the daemon stamped them: no later than it first saw the
			// block, and spanning what was stored.
			const thought = reply.role === "assistant" ? reply.thinkingMs! : 0;
			expect(blocks.thinking?.startedAt).toBeLessThanOrEqual(blocks.firstSeen!);
			expect(blocks.thinking!.endedAt! - blocks.thinking!.startedAt!).toBeGreaterThanOrEqual(thought - 5);
			expect(blocks.thinking!.endedAt! - blocks.thinking!.startedAt!).toBeLessThan(thought + 250);
		} finally {
			await daemon.close();
		}
	});

	it("a typed question answer remains visible as the owner's words; dismissing a question is not an answer", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const call = (args: object) =>
			fauxAssistantMessage([fauxToolCall("message_user", args as never)], { stopReason: "toolUse" });
		faux.setResponses([
			call({ question: "What matters most?", options: ["time", "cost"] }),
			call({ text: "Got it." }),
			fauxAssistantMessage("Done."),
			call({ question: "Another question?", options: ["yes", "no"] }),
			call({ text: "I’ll carry on without that answer." }),
			fauxAssistantMessage("Done."),
		]);
		const s = await start({ models });
		try {
			const first = await s.post("Help me choose", randomUUID());
			const wait = await until(async () => (await s.api<Status>("/status")).waits.find((w) => w.chat === first.chat));
			const id = randomUUID();
			const answer = () =>
				s.api<Posted>("/messages", {
					method: "POST",
					body: JSON.stringify({ id, chat: first.chat, text: "A relaxed trip" }),
				});
			expect(await answer()).toMatchObject({ answered: expect.any(Number), chat: first.chat });
			expect(await answer()).toMatchObject({ answered: expect.any(Number), chat: first.chat });
			const answered = await until(async () =>
				(await everything(s.api, first.chat)).find((item) => item.role === "wait"),
			);
			expect(answered).toMatchObject({ role: "wait", outcome: "answered", answer: "A relaxed trip", message: id });
			await until(
				async () => (await s.api<ChatRow[]>("/chats")).find((row) => row.chat === first.chat)?.state === "idle",
			);
			const second = await s.post("One more", randomUUID());
			const next = await until(async () => (await s.api<Status>("/status")).waits.find((w) => w.chat === second.chat));
			expect(next.key).not.toBe(wait.key);
			expect(await s.api(`/waits/${next.key}/dismiss`, { method: "POST" })).toEqual({ chat: second.chat });
			const dismissed = await until(async () =>
				(await everything(s.api, second.chat)).find((item) => item.role === "wait"),
			);
			expect(dismissed).toMatchObject({ role: "wait", outcome: "dismissed" });
			expect(dismissed).not.toHaveProperty("answer");
			await expect(s.api(`/waits/${next.key}/dismiss`, { method: "POST" })).rejects.toThrow(/400/);
		} finally {
			await s.daemon.close();
		}
	});

	it("answers asks as the web does: a typed form, several picks, and refusals that say why", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const call = (args: object, id: string) =>
			fauxAssistantMessage([fauxToolCall("message_user", args as never, { id })], { stopReason: "toolUse" });
		faux.setResponses([
			call(
				{
					question: "Export where?",
					fields: [
						{ name: "bucket" },
						{ name: "days", type: "number" },
						{ name: "public", type: "boolean" },
						{ name: "prefix", optional: true },
					],
				},
				"c1",
			),
			call({ question: "Which checks?", options: ["unit", "fault", "audit"], multiple: true }, "c2"),
			fauxAssistantMessage("Done."),
		]);
		const { daemon, api, post } = await start({ models });
		try {
			const { chat } = await post("export it", randomUUID());
			const open = () => until(async () => (await api<Status>("/status")).waits[0]);
			// what web/src/lib/api.ts answerWait sends
			const answer = (key: string, value: unknown, type: string) =>
				api(`/waits/${key}`, { method: "POST", body: JSON.stringify({ answer: value, type, via: "web" }) });
			const form = await open();
			await expect(answer(form.key, { bucket: "archive", days: "many", public: false }, "question")).rejects.toThrow(
				/400 .*days is a number/,
			);
			await expect(answer(form.key, { bucket: "archive", days: 30, public: false }, "approval")).rejects.toThrow(
				/400 .*this ask is a question/,
			);
			expect(await answer(form.key, { bucket: "archive", days: 30, public: false }, "question")).toEqual({
				chat,
			});
			for (let picks = await open(); ; picks = await open()) {
				if (picks.key === form.key) continue;
				expect(await answer(picks.key, ["unit", "audit"], "question")).toEqual({ chat });
				break;
			}
			const waits = async () => (await everything(api, chat)).filter((item) => item.role === "wait");
			await until(async () => (await waits()).length >= 2);
			expect((await waits()).map((item) => (item.role === "wait" ? item.answer : undefined))).toEqual([
				{ bucket: "archive", days: 30, public: false },
				["unit", "audit"],
			]);
		} finally {
			await daemon.close();
		}
	});

	it("drafts and permissions: an edited approval with a permission, an effect within it, the floor refused, a revoke", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const plans: { [said: string]: [string, object] } = {
			"tell ana": ["send_message", { to: "ana@example.com", text: "Running late" }],
			"tell ana again": ["send_message", { to: "ana@example.com", text: "Here now" }],
			"pay ana": ["pay", { to: "ana@example.com", amount: "20 EUR" }],
		};
		faux.setResponses(
			Array.from({ length: 50 }, () => (context: { messages: readonly { role: string; content: unknown }[] }) => {
				const last = [...context.messages].reverse().find((message) => message.role !== "system");
				const input = [...context.messages].reverse().find((message) => message.role === "user");
				const searched = last?.role === "toolResult" && (last as { toolName?: string }).toolName === "tool_search";
				const plan = last?.role === "user" || searched ? plans[String(input?.content)] : undefined;
				if (plan === undefined) return fauxAssistantMessage("ok");
				if (!getCurrentTools(context.messages as readonly Message[]).some((tool) => tool.name === plan[0]))
					return fauxAssistantMessage([fauxToolCall("tool_search", { query: plan[0], limit: 1 })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage([fauxToolCall(plan[0], plan[1] as never)], { stopReason: "toolUse" });
			}) as never,
		);
		const ran: Ran[] = [];
		const { daemon, api, post } = await start({ models, effects: demoEffects((run) => ran.push(run)) });
		try {
			const open = () =>
				until(async () => (await api<Status>("/status")).waits.find((each) => each.ask.type === "approval"));
			const answer = (key: string, body: object) =>
				api(`/waits/${key}`, {
					method: "POST",
					body: JSON.stringify({ answer: "approve", type: "approval", ...body }),
				});
			const thread = randomUUID();
			const { chat } = await post("tell ana", thread);
			const draft = await open();
			expect(draft.ask).toMatchObject({
				label: "send a message to ana@example.com",
				editable: ["text"],
				permission: { what: "send messages to ana@example.com" },
			});
			await expect(api(`/waits/${draft.key}/dismiss`, { method: "POST" })).rejects.toThrow(
				/400 .*approval cannot be dismissed/,
			);
			await expect(answer(draft.key, { permission: { scope: "sometimes" } })).rejects.toThrow(/400 .*permission is/);
			await expect(answer(draft.key, { edits: { to: "eve@example.com" } })).rejects.toThrow(
				/400 .*to cannot be edited/,
			);
			await answer(draft.key, { edits: { text: "Running 10 min late" }, permission: { scope: "always" } });
			await until(async () => ran.length === 1);
			expect(ran[0]).toEqual({ tool: "send_message", args: { to: "ana@example.com", text: "Running 10 min late" } });
			const control = await api<ControlView>("/control");
			expect(control.permissions).toEqual([
				{
					id: "1",
					what: "send messages to ana@example.com",
					scope: "always",
					agent: "sancho",
					at: expect.any(Number),
					serves: { kind: "task", chat: expect.any(Number), input: expect.any(Number), title: "tell ana" },
				},
			]);
			// within the permission: it runs without asking, in the activity and the chat
			await post("tell ana again", randomUUID());
			await until(async () => ran.length === 2);
			expect((await api<Status>("/status")).waits).toEqual([]);
			const activity = (await api<ControlView>("/control")).activity.map((event) => event.what);
			expect(activity).toContain("Ran without asking: send a message to ana@example.com");
			// the floor: a permission through the API is refused, approving once is not
			await post("pay ana", randomUUID());
			const paying = await open();
			expect(paying.ask).toMatchObject({ floor: "money", label: "pay ana@example.com 20 EUR" });
			await expect(answer(paying.key, { permission: { scope: "always" } })).rejects.toThrow(
				/400 .*never allowed ahead: it asks every time, as it moves money/,
			);
			await answer(paying.key, {});
			await until(async () => ran.length === 3);
			expect((await api<ControlView>("/control")).permissions).toHaveLength(1);
			// revoked: gone from the control room at once, and the next send asks
			const after = await api<ControlView>("/permissions/1/revoke", { method: "POST" });
			expect(after.permissions).toEqual([]);
			await expect(api("/permissions/1/revoke", { method: "POST" })).rejects.toThrow(/404/);
			await post("tell ana again", randomUUID());
			expect((await open()).ask).toMatchObject({ tool: "send_message", args: { text: "Here now" } });
			expect(ran).toHaveLength(3);
			const items = await everything(api, chat);
			expect(items.filter((item) => item.role === "wait").map((item) => item.role === "wait" && item.edited)).toEqual([
				{ to: "ana@example.com", text: "Running 10 min late" },
			]);
		} finally {
			await daemon.close();
		}
	});

	it("stops a chat that waits on an ask, from the web", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("message_user", { question: "Colour?" }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
		]);
		const { daemon, api, post } = await start({ models });
		try {
			const { chat, turn } = await post("pick", randomUUID());
			await until(async () => (await api<Status>("/status")).waits.length > 0);
			expect(await api(`/chats/${chat}/stop`, { method: "POST" })).toEqual({ stopped: true });
			await expect(api("/chats/999/stop", { method: "POST" })).rejects.toThrow(/404/);
			expect(turn).toEqual(expect.any(Number));
			await until(async () => {
				const [row] = await api<ChatRow[]>("/chats");
				return row?.state === "idle" && row.unanswered === 0;
			});
			const items = await everything(api, chat);
			expect(items.find((item) => item.role === "wait")).toMatchObject({ outcome: "cancelled" });
			expect((await api<Status>("/status")).waits).toEqual([]);
		} finally {
			await daemon.close();
		}
	});

	it("runs again only a task that is parked", async () => {
		const { daemon, api } = await start();
		try {
			await expect(api("/tasks/999/retry", { method: "POST" })).rejects.toThrow("404 ");
		} finally {
			await daemon.close();
		}
	});

	it("streams the shell and the chat on screen in one stream, the chat's events tagged with it", async () => {
		const { daemon, token, url, post } = await start();
		const stop = new AbortController();
		try {
			const { chat } = await post("hello", randomUUID());
			const read = async (path: string, until: (text: string) => boolean) => {
				const response = await fetch(`${url}/api${path}`, {
					headers: { authorization: `Bearer ${token}` },
					signal: stop.signal,
				});
				const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
				let text = "";
				while (!until(text)) text += (await reader.read()).value ?? "";
				await reader.cancel();
				return text;
			};
			const both = await read(
				`/events?chat=${chat}`,
				(text) => text.includes('"type":"chats"') && text.includes('"type":"live"'),
			);
			expect(both).toContain(`"type":"live","chat":${chat},"event":{"type":"ready"`);
			const gone = await read("/events?chat=999999", (text) => text.includes('"chat":999999'));
			expect(gone).toContain('"type":"live","chat":999999,"event":{"type":"gone"}');
		} finally {
			stop.abort();
			await daemon.close();
		}
	});

	it("rejects bad posts and unknown chats", async () => {
		const { daemon, api, url } = await start();
		try {
			const bad = (body: unknown) =>
				api("/messages", { method: "POST", body: JSON.stringify(body) }).catch((e: Error) => e.message);
			expect(await bad({ id: "reply:x", thread: randomUUID(), text: "hi" })).toMatch(/^400/);
			expect(await bad({ id: randomUUID(), thread: "../x", text: "hi" })).toMatch(/^400/);
			expect(await bad({ id: randomUUID(), thread: randomUUID(), text: " " })).toMatch(/^400/);
			expect(await api("/messages", { method: "POST", body: "{" }).catch((e: Error) => e.message)).toMatch(/^400/);
			expect(await api("/chats/999/items").catch((e: Error) => e.message)).toMatch(/^404/);
			expect(await api("/chats/999/events").catch((e: Error) => e.message)).toMatch(/^404/);
			expect((await fetch(`${url}/api/chats`)).status).toBe(401);
		} finally {
			await daemon.close();
		}
	});

	it("serves the UI without the token, nothing outside it, and status links to it", async () => {
		const { daemon, url, home } = await start();
		try {
			const index = await fetch(`${url}/`);
			expect(index.status).toBe(200);
			expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
			expect(await index.text()).toContain("<title>banda</title>");
			expect(await (await fetch(`${url}/c/12`)).text()).toContain("<title>banda</title>");
			const asset = await fetch(`${url}/assets/app.js`);
			expect(asset.headers.get("content-type")).toContain("text/javascript");
			expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
			for (const path of ["/../daemon.json", "/%2e%2e/daemon.json", "/..%2fdaemon.json"]) {
				const response = await fetch(`${url}${path}`);
				expect(await response.text()).not.toContain("token");
			}
			// the installed app's files: public, typed, and never kept stale
			const manifest = await fetch(`${url}/manifest.webmanifest`);
			expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
			expect(manifest.headers.get("cache-control")).toBe("private, no-cache");
			expect(await manifest.json()).toMatchObject({ name: "banda", icons: expect.any(Array) });
			const worker = await fetch(`${url}/sw.js`);
			expect(worker.headers.get("content-type")).toContain("text/javascript");
			expect(worker.headers.get("cache-control")).toBe("no-cache");
			expect(worker.headers.get("content-security-policy")).toBe(index.headers.get("content-security-policy"));
			expect(index.headers.get("content-security-policy")).toBe(
				"default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'",
			);
			expect((await fetch(`${url}/api/companion`)).status).toBe(401);
			expect((await fetch(`${url}/`, { method: "POST" })).status).toBe(405);
			const { stdout } = await run(process.execPath, ["src/cli/index.ts", "status", "--home", home]);
			const { token } = (await readDaemonFile(home))!;
			expect(stdout.split("\n")[0]).toBe(`web: ${url}/#token=${token}`);
		} finally {
			await daemon.close();
		}
	});
});
