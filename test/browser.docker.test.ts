/**
 * The browser, for real (DESIGN.md "The box", The browser), through a daemon: Chromium in the box behind the egress
 * proxy, driven by the agent's tools, watched and taken over through the app's API. A stand-in site (a server on a
 * network of public addresses routed nowhere, which the proxy joins) serves a sign-in page and a settings page that
 * shows a new key, so no test needs the real network. Needs Docker, and skips without it.
 *
 * - the screencast reaches the app through the box's stream; the owner's input is refused until they take the browser;
 * - while the owner holds it, the agent's call waits for them (taking it cuts a call at work short); given back, the
 *   call goes on with the page as they left it, and so does the run; Stop ends a call at once, waiting or at work;
 * - what the owner types (a password) never reaches a snapshot, a screenshot (it draws the same whatever the value),
 *   an entry, a log, the store or the agent's own files;
 * - what the owner sends while holding the browser marks its site signed in; a page's write there goes with their
 *   session, so it waits in the browser; approved, the proxy lets exactly it through, once;
 * - on a site the owner never signed in to, a page's write goes at once, through the proxy once, unasked;
 * - a key the page shows reaches auth/ and nothing else.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Message,
} from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { boxParts, containerBox, dockerAvailable, removeContainerBox } from "../src/box/container.ts";
import type { Status } from "../src/core/status.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { readDaemonFile } from "../src/home.ts";
import type { Item, ItemPage, Posted, ViewEvent } from "../src/server/api.ts";
import { until } from "./helpers.ts";

const docker = await dockerAvailable();
const MITMPROXY = "mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f";

/** The stand-in site: each request it gets printed base64 (`METHOD path body`); its key printed at the start. */
const SITE = `
import base64, http.server, secrets
KEY = "sk_live_" + secrets.token_hex(6) + "Ab" + secrets.token_hex(8) + "Zz9"
print(base64.b64encode(("KEY " + KEY).encode()).decode(), flush=True)
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def send(self, code, body, headers={}):
        data = body.encode()
        self.send_response(code)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        for k, v in headers.items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)
    def note(self, body=b""):
        print(base64.b64encode(f"{self.command} {self.path} ".encode() + body).decode(), flush=True)
    def do_GET(self):
        self.note()
        signed = "session=s1" in (self.headers.get("cookie") or "")
        # the shop, as another of its names (blog-) links to it
        shop = (self.headers.get("host") or "").replace("blog-", "shop-")
        if self.path == "/via":
            # a third party's sign-in through the shop, where the owner is signed in
            self.send(302, "", {"location": f"http://{shop}/settings"})
        elif self.path == "/embed":
            self.send(200, f'<title>Embed</title><img src="http://{shop}/whoami.gif">')
        elif self.path == "/whoami.gif":
            # who the shop takes the picture's request for; its answer tries to set another session
            print(base64.b64encode(("WHO " + ("signed" if signed else "anonymous")).encode()).decode(), flush=True)
            self.send(200, "", {"set-cookie": "session=other; Path=/; Max-Age=3600"})
        elif self.path == "/":
            self.send(200, '<title>Shop</title><h1>Account</h1><form method="post" action="/login"><label>User <input name="user"></label> <label>Password <input type="password" name="pass"></label> <button>Sign in</button></form>')
        elif self.path == "/press":
            # a page that reads six times in a row on its kept-alive connection, then waits for a press
            self.send(200, '<title>Press</title><button style="position:fixed;left:600px;top:500px;width:200px;height:100px" onclick="location.href=\\'/pressed\\'">Press</button><script>(async () => { for (let i = 1; i <= 6; i++) await fetch(\\'/read?\\' + i); })();</script>')
        elif self.path == "/challenge":
            # A page whose bootstrap write is held while the agent has it. Taking control must drop that stale write and
            # reload under the owner, so the new bootstrap request is theirs rather than an accidental replay.
            self.send(200, '<title>Challenge</title><script>fetch(\\'/bootstrap\\', {method: \\'POST\\', body: \\'challenge=1\\'});</script>')
        elif self.path == "/mail":
            # a mail list: the first row's checkbox sits over the middle of its subject, the second row is covered whole
            self.send(200, '<title>Mail</title><ul style="padding:0;margin:0">'
                '<li style="position:relative;list-style:none;width:800px;height:48px"><a href="/open/1" style="display:block;line-height:48px">Lunch on Friday</a><input type="checkbox" aria-label="Select the lunch" style="position:absolute;left:340px;top:0;width:120px;height:48px;margin:0"></li>'
                '<li style="position:relative;list-style:none;width:800px;height:48px"><a href="/open/2" style="display:block;line-height:48px">Rent is due</a><div style="position:absolute;inset:0"></div></li>'
                '</ul>')
        elif self.path.startswith("/open/"):
            self.send(200, '<title>Reading</title><h1>A message</h1>')
        elif self.path.startswith("/read?"):
            self.send(200, "read")
        elif self.path == "/settings":
            self.send(200, '<title>Settings</title><h1>Settings</h1>' + ('<form method="post" action="/keys"><label>Key name <input name="label" value="banda"></label> <button>Create key</button></form>' if signed else '<p>Sign in first</p>'))
        else:
            self.send(404, "<title>No</title>no")
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.note(body)
        if self.path == "/login":
            self.send(303, "", {"location": "/settings", "set-cookie": "session=s1; Path=/; Max-Age=3600"})
        elif self.path == "/bootstrap":
            self.send(200, "<title>Ready</title>ready")
        elif self.path == "/keys":
            self.send(200, f'<title>Your key</title><h1>Your new key</h1><p>Copy it now: <code>{KEY}</code></p>')
        else:
            self.send(404, "no")
http.server.ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
`;

const run = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();

/** A step of the model's plan: the call it makes, from the last result it read; undefined ends the run. */
type Step = (last: string) => [string, Record<string, unknown>] | undefined;

describe.skipIf(!docker)("the browser", { timeout: 300_000 }, () => {
	const tag = randomUUID().slice(0, 8);
	const pub = `banda-test-${tag}-pub`;
	const site = `banda-test-${tag}-site`;
	const HOST = `shop-${tag}.example`;
	const SHOP = `http://${HOST}:8080`;
	// the same site under another name, which the owner never signed in to
	const ANON = `http://blog-${tag}.example:8080`;
	const SECRET = `Pw-${randomUUID().slice(0, 12)}`;
	const OTHER = `Pw-${randomUUID().slice(0, 12)}`;
	const USER = `alice-${tag}`;
	const thread = randomUUID();
	const logs: string[] = [];
	/** The model's plan for each owner message, by a word it holds. */
	const plans = new Map<string, Step[]>();
	let home: string;
	let daemon: Daemon;
	let api: <T>(path: string, init?: RequestInit) => Promise<T>;
	let token: string;
	let url: string;

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "banda-browser-test-"));
		writeFileSync(join(home, "config.json"), JSON.stringify({ model: { provider: "faux", modelId: "faux-1" } }));
		const web = join(home, "web");
		mkdirSync(web);
		writeFileSync(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let n = 0;
		faux.setResponses(
			Array.from({ length: 1000 }, () => (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
				const text = (m: { content: unknown }) =>
					typeof m.content === "string"
						? m.content
						: (m.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join("");
				const lastUser = ctx.messages.length - 1 - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
				const asked = text(ctx.messages[lastUser]!);
				const plan = [...plans].find(([word]) => asked.includes(word))?.[1] ?? [];
				const results = ctx.messages
					.slice(lastUser)
					.filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName !== "tool_search");
				const step = plan[results.length];
				const call = step?.(results.length === 0 ? "" : text(results.at(-1)!));
				n += 1;
				if (call === undefined) return fauxAssistantMessage("Done.");
				if (!getCurrentTools(ctx.messages as readonly Message[]).some((tool) => tool.name === call[0]))
					return fauxAssistantMessage([fauxToolCall("tool_search", { query: call[0], limit: 1 })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage([fauxToolCall(call[0], call[1] as never, { id: `c${n}` })], {
					stopReason: "toolUse",
				});
			}) as never,
		);
		daemon = await startDaemon({
			home,
			port: 0,
			models,
			log: (line) => logs.push(line),
			box: containerBox(home),
			web,
		});
		token = (await readDaemonFile(home))!.token!;
		url = `http://127.0.0.1:${daemon.port}`;
		api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
			const response = await fetch(`${url}/api${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}`, ...init.headers },
			});
			if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
			return (await response.json()) as T;
		};
		// the box comes up (the first run builds its image), then the stand-in site beside its proxy
		const { proxy } = boxParts(home);
		await until(() => {
			try {
				return run(["inspect", "--format", "{{.State.Running}}", boxParts(home).box]) === "true";
			} catch {
				return false;
			}
		}, 500);
		const octet = 16 + Math.floor(Math.random() * 200);
		run(["network", "create", "--subnet", `11.${octet}.${Math.floor(Math.random() * 250)}.0/24`, pub]);
		run(["network", "connect", pub, proxy]);
		run([
			"run",
			"--detach",
			"--name",
			site,
			// swept with the home if the test dies before its own teardown
			"--label",
			`banda.home=${home}`,
			"--network",
			pub,
			"--network-alias",
			HOST,
			"--network-alias",
			`blog-${tag}.example`,
			"--entrypoint",
			"python3",
			MITMPROXY,
			"-u",
			"-c",
			SITE,
		]);
		await until(() => {
			try {
				return (
					run(["exec", proxy, "python3", "-c", `import socket; socket.create_connection(("${HOST}", 8080), 2)`]) === ""
				);
			} catch {
				return false;
			}
		}, 200);
	}, 20 * 60_000);

	afterAll(async () => {
		await daemon?.close();
		try {
			run(["rm", "--force", site]);
		} catch {
			// not made
		}
		if (home !== undefined) {
			try {
				run(["network", "disconnect", "--force", pub, boxParts(home).proxy]);
			} catch {
				// not joined
			}
			await removeContainerBox(home);
			rmSync(home, { recursive: true, force: true });
		}
		try {
			run(["network", "rm", pub]);
		} catch {
			// not made
		}
	});

	/** What the site got, in order: `METHOD path body`. */
	const served = () =>
		run(["logs", site])
			.split("\n")
			.filter(Boolean)
			.map((line) => Buffer.from(line, "base64").toString("utf8"));
	const siteKey = () => served()[0]!.replace(/^KEY /, "");
	const requests = () => served().slice(1);

	const say = async (word: string, plan: Step[]) => {
		plans.set(word, plan);
		runs += 1;
		return api<Extract<Posted, { turn: number }>>("/messages", {
			method: "POST",
			body: JSON.stringify({ id: randomUUID(), thread, text: `${word}, please` }),
		});
	};
	const status = () => api<Status>("/status");
	/** Runs that ended: each says "Done." last. */
	let runs = 0;
	const ended = async (chat: number) => {
		const done = (await items(chat)).filter((i) => i.role === "assistant" && i.text === "Done.").length;
		if (done < runs) return false;
		return (await status()).chats.find((c) => c.chat === chat)?.state === "idle";
	};
	const nextAsk = (chat: number) => until(async () => (await status()).waits.find((wait) => wait.chat === chat));
	/** Opening the shop, where the owner is signed in, asks: they allow it for the task. */
	const allowVisit = async (chat: number) => {
		const ask = await nextAsk(chat);
		expect(ask.ask).toMatchObject({ type: "approval", tool: "browser_navigate", label: `open ${HOST} as you` });
		await api(`/waits/${ask.key}`, {
			method: "POST",
			body: JSON.stringify({ answer: "approve", permission: { scope: "task" } }),
		});
	};
	/** The ask a call that waits for the browser shows in its chat. */
	const waitingForBrowser = (chat: number) =>
		until(async () =>
			(await status()).waits.find(
				(wait) => wait.chat === chat && wait.ask.type === "question" && wait.ask.handOver?.taken === true,
			),
		);
	const state = async (chat: number) => (await status()).chats.find((c) => c.chat === chat)?.state;
	const items = async (chat: number): Promise<Item[]> => {
		const pages: Item[][] = [];
		let before: number | undefined;
		for (;;) {
			const page = await api<ItemPage>(`/chats/${chat}/items${before === undefined ? "" : `?before=${before}`}`);
			pages.unshift([...page.items]);
			if (page.next === undefined) return pages.flat();
			before = page.next;
		}
	};
	const results = async (chat: number, tool?: string) =>
		(await items(chat)).flatMap((item) =>
			item.role === "tool" && (tool === undefined || item.name === tool) ? [item] : [],
		);
	const control = (hold: boolean) =>
		api<{ control: string }>(`/chats/${chat}/browser/control`, { method: "POST", body: JSON.stringify({ hold }) });
	const input = (body: object) => api(`/chats/${chat}/browser/input`, { method: "POST", body: JSON.stringify(body) });
	const type = async (text: string) => input({ type: "text", text });
	const key = async (name: string) => input({ type: "key", key: name });
	const watch = () => {
		const events: ViewEvent[] = [];
		const stop = new AbortController();
		const done = (async () => {
			const response = await fetch(`${url}/api/chats/${chat}/browser`, {
				headers: { authorization: `Bearer ${token}` },
				signal: stop.signal,
			});
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body!) {
				buffer += decoder.decode(chunk as Uint8Array, { stream: true });
				for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
					events.push(JSON.parse(buffer.slice(0, end).replace(/^data: /, "")) as ViewEvent);
					buffer = buffer.slice(end + 2);
				}
			}
		})().catch(() => undefined);
		return {
			events,
			close: () => {
				stop.abort();
				return done;
			},
		};
	};
	let chat = 0;
	/** On a failure, what the agent read and what the site got, to see where it went. */
	const explain = () =>
		onTestFailed(async () => {
			const said = chat === 0 ? [] : await results(chat).catch(() => []);
			console.error(
				[
					...said.map((r) => `--- ${r.name}${r.error ? " (error)" : ""}\n${r.text.slice(0, 1500)}`),
					`--- site\n${requests().join("\n")}`,
					`--- waits\n${JSON.stringify((await status().catch(() => ({ waits: [] }))).waits)}`,
					`--- log\n${logs.slice(-20).join("\n")}`,
				].join("\n"),
			);
		});

	it("the screencast reaches the app through the box's stream; the owner's input waits for them to take the browser", async () => {
		explain();
		const first = await say("open the shop", [() => ["browser_navigate", { url: `${SHOP}/` }]]);
		chat = first.chat;
		await until(() => ended(chat));
		const [opened] = await results(chat, "browser_navigate");
		expect(opened?.text).toContain('Page "Shop"');
		expect(opened?.text).toMatch(/button "Sign in" \[ref=s\d+e\d+\]/);
		const view = watch();
		try {
			await until(() => view.events.some((e) => e.type === "state" && e.view.running && e.view.chat === chat));
			const frame = await until(() => view.events.find((e) => e.type === "frame"));
			expect(frame.type === "frame" && frame.data.startsWith("/9j/")).toBe(true);
			expect(frame.type === "frame" && frame.width).toBe(1280);
		} finally {
			await view.close();
		}
		await expect(type("hello")).rejects.toThrow(/^409 /);
		expect((await control(true)).control).toBe("owner");
	});

	it("while the owner holds the browser the agent's call waits; given back, it goes on; what they type stays theirs", async () => {
		explain();
		await key("Tab");
		await type(USER);
		await key("Tab");
		await type(SECRET);
		const held = await say("look again", [() => ["browser_snapshot", {}]]);
		const waiting = await waitingForBrowser(held.chat);
		expect(waiting.ask).toMatchObject({ handOver: { site: `${HOST}:8080`, signIn: false, taken: true } });
		// it waits, as long as they hold it: no result yet, and the run is still at work
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(await results(chat, "browser_snapshot")).toHaveLength(0);
		expect(await state(chat)).toBe("waiting");
		expect((await control(false)).control).toBe("agent");
		await until(() => ended(held.chat));
		const resumed = (await results(chat, "browser_snapshot")).at(-1)!.text;
		expect(resumed).toContain("The owner gave the browser back");
		expect(resumed).toContain('textbox "User"');
		expect(resumed).not.toContain(SECRET);
		expect((await status()).waits.filter((wait) => wait.chat === chat)).toEqual([]);

		const back = await say("read the page", [() => ["browser_snapshot", {}], () => ["browser_screenshot", {}]]);
		await until(() => ended(back.chat));
		const read = (await results(chat, "browser_snapshot")).at(-1)!.text;
		expect(read).toContain('textbox "User"');
		expect(read.split("(a secret: its value is hidden)")).toHaveLength(3);
		expect(read).not.toContain(SECRET);
		expect(read).not.toContain(USER);
		const shot = async () => {
			const item = (await results(chat, "browser_screenshot")).at(-1)!;
			const response = await fetch(`${url}/api/chats/${chat}/items/${item.id}/images/0`, {
				headers: { authorization: `Bearer ${token}` },
			});
			return Buffer.from(await response.arrayBuffer());
		};
		const before = await shot();

		// another password, as long: the screenshot draws the same, so it shows nothing of either
		await control(true);
		for (const _ of SECRET) await key("Backspace");
		await type(OTHER);
		await control(false);
		const again = await say("see it again", [() => ["browser_screenshot", {}]]);
		await until(() => ended(again.chat));
		expect((await shot()).equals(before)).toBe(true);

		// the owner signs in: what they send is theirs, and goes
		await control(true);
		await key("Enter");
		await until(() => requests().some((r) => r.startsWith("POST /login ")));
		await control(false);
		expect(requests().find((r) => r.startsWith("POST /login "))).toContain(`pass=${OTHER}`);

		// signing in is a hand-over: the shop is known as signed in once the owner gives the browser back
		const handed = await say("hand it over", [() => ["browser_hand_over", { site: HOST }]]);
		const asked = await nextAsk(handed.chat);
		expect(asked.ask).toMatchObject({ type: "question", handOver: { site: HOST, signIn: true } });
		await api(`/waits/${asked.key}`, { method: "POST", body: JSON.stringify({ answer: "Done" }) });
		await until(() => ended(handed.chat));
	});

	it("the shop opens as the owner only once allowed: a redirect through it, or a picture of it, is stopped", async () => {
		explain();
		const before = requests().filter((r) => r.startsWith("GET /settings ")).length;
		// a third party's sign-in through the shop: the hop to the shop is stopped and told
		const via = await say("sign in elsewhere", [() => ["browser_navigate", { url: `${ANON}/via` }]]);
		await until(() => ended(via.chat));
		expect((await status()).waits.filter((wait) => wait.chat === via.chat)).toEqual([]);
		expect((await results(via.chat, "browser_navigate")).at(-1)?.text).toContain(
			`[banda] The page tried to open ${SHOP}/settings, on ${HOST}, where the owner is signed in`,
		);
		expect(requests().filter((r) => r.startsWith("GET /settings "))).toHaveLength(before);
		// a page elsewhere showing a picture of the shop: stopped in the browser, so the shop never hears of it
		const embed = await say("look at the embed", [() => ["browser_navigate", { url: `${ANON}/embed` }]]);
		await until(() => ended(embed.chat));
		expect(requests().filter((r) => r.startsWith("WHO "))).toEqual([]);
		// opening the shop itself asks; the next test's form shows only if the owner's session is still theirs
		const opening = await say("open the shop again", [() => ["browser_navigate", { url: `${SHOP}/settings` }]]);
		const ask = await nextAsk(opening.chat);
		expect(ask.ask).toMatchObject({
			tool: "browser_navigate",
			label: `open ${HOST} as you`,
			args: { site: HOST },
			scopes: [{ scope: "task" }],
		});
		await api(`/waits/${ask.key}`, { method: "POST", body: JSON.stringify({ answer: "deny" }) });
		await until(() => ended(opening.chat));
		expect(requests().filter((r) => r.startsWith("GET /settings "))).toHaveLength(before);
	});

	it("a page's write waits in the browser; approved, the proxy lets exactly it through, once", async () => {
		explain();
		const ref = (last: string, name: string) => new RegExp(`button "${name}" \\[ref=(s\\d+e\\d+)\\]`).exec(last)?.[1];
		const posted = await say("make a key", [
			() => ["browser_navigate", { url: `${SHOP}/settings` }],
			(last) => ["browser_click", { ref: ref(last, "Create key") ?? "s0e0" }],
			(last) => ["browser_send", { write: /\(write (w\d+)\)/.exec(last)?.[1] ?? "w0" }],
			(last) => [
				"propose_key",
				{ key: /\[key (k\d+)\]/.exec(last)?.[1] ?? "k0", host: "api.shop.example", prefix: "Bearer " },
			],
		]);
		await allowVisit(posted.chat);
		const ask = await until(async () =>
			(await status()).waits.find(
				(wait) => wait.chat === posted.chat && wait.ask.type === "approval" && wait.ask.tool === "browser_send",
			),
		);
		expect(requests().some((r) => r.startsWith("POST /keys "))).toBe(false);
		const clicked = (await results(chat, "browser_click")).at(-1)!.text;
		expect(clicked).toMatch(/The page tried to send POST http:\/\/shop-[0-9a-f]+\.example:8080\/keys \(write w\d+\)/);
		expect(ask.ask).toMatchObject({
			type: "approval",
			tool: "browser_send",
			floor: "credentials",
			args: { method: "POST", address: `${SHOP}/keys`, body: "label=banda" },
		});
		const headers = String((ask.ask as unknown as { args: { headers: string } }).args.headers);
		expect(headers).toContain("(the browser's session, hidden)");
		expect(headers).not.toContain("session=s1");
		await api(`/waits/${ask.key}`, { method: "POST", body: JSON.stringify({ answer: "approve" }) });
		const keep = await until(async () => {
			const wait = (await status()).waits.find((w) => w.chat === chat);
			return wait?.ask.type === "approval" && wait.ask.tool === "propose_key" ? wait : undefined;
		});
		const keys = requests().filter((r) => r.startsWith("POST /keys "));
		expect(keys).toEqual(["POST /keys label=banda"]);
		const sent = (await results(chat, "browser_send")).at(-1)!.text;
		expect(sent).toContain('Page "Your key"');
		expect(sent).toContain("[key k1]");
		expect(sent).not.toContain(siteKey());

		// a key the page shows reaches auth/ and nothing else
		expect(keep.ask).toMatchObject({ floor: "credentials" });
		expect(JSON.stringify(keep.ask)).not.toContain(siteKey());
		await api(`/waits/${keep.key}`, { method: "POST", body: JSON.stringify({ answer: "approve" }) });
		await until(() => ended(chat));
		expect((await results(chat, "propose_key")).at(-1)?.text).toMatch(/^The owner approved this\.\nKept/);
		const credentials = JSON.parse(readFileSync(join(home, "auth", "egress.json"), "utf8"));
		expect(credentials.credentials).toContainEqual({
			host: "api.shop.example",
			header: "Authorization",
			value: `Bearer ${siteKey()}`,
		});
	});

	it("neither the key nor what the owner typed is in the store, an entry, a log or the agent's files", async () => {
		const secrets = [siteKey(), SECRET, OTHER];
		const stored = readdirSync(home)
			.filter((name) => name.startsWith("durable.db") || name === "search.db")
			.map((name) => join(home, name))
			.filter((path) => statSync(path).isFile())
			.map((path) => readFileSync(path).toString("latin1"))
			.join("\n");
		const entries = JSON.stringify(await items(chat));
		const said = logs.join("\n");
		const { box } = boxParts(home);
		// what the agent's commands can read: everything but the browser's own volume, which its uid cannot open
		const files = run([
			"exec",
			box,
			"sh",
			"-c",
			`grep -rl -F -e '${SECRET}' -e '${OTHER}' -e '${siteKey()}' /workspace /work /tmp 2>/dev/null || true`,
		]);
		expect(run(["exec", box, "sh", "-c", "ls /browser 2>&1 || true"])).toContain("Permission denied");
		for (const secret of secrets) {
			expect(stored.includes(secret), "the store").toBe(false);
			expect(entries.includes(secret), "an entry").toBe(false);
			expect(said.includes(secret), "a log").toBe(false);
		}
		expect(files).toBe("");
	});

	it("taking over drops a page write the agent held, then reloads it as the owner's", async () => {
		explain();
		const opened = await say("open the challenge", [() => ["browser_navigate", { url: `${SHOP}/challenge` }]]);
		// allowed for the task, the page opens as the owner; its write goes with their session, so it waits
		await allowVisit(opened.chat);
		await until(() => ended(opened.chat));
		expect((await results(opened.chat, "browser_navigate")).at(-1)?.text).toContain("(write w");
		expect(requests().filter((request) => request === "POST /bootstrap challenge=1")).toEqual([]);

		await control(true);
		await until(() => requests().filter((request) => request === "POST /bootstrap challenge=1").length === 1);
		expect((await status()).waits.filter((wait) => wait.chat === opened.chat)).toEqual([]);
		await control(false);
	});

	it("the owner's click, sent as the app sends it, presses a button on a page that read before", {
		timeout: 120_000,
	}, async () => {
		explain();
		const view = watch();
		try {
			await until(() => view.events.find((e) => e.type === "frame"));
			await control(true);
			await input({ type: "navigate", url: `${SHOP}/press` }).catch((e) => {
				console.error(
					"DBG proxylog",
					execFileSync("sh", ["-c", `docker logs ${boxParts(home).proxy} 2>&1 | tail -80`], { encoding: "utf8" }),
				);
				throw e;
			});
			// the page's reads, one after another on the browser's kept-alive connection, all reach the site
			await until(() => requests().some((r) => r.startsWith("GET /read?6 ")));
			// the app: the pointer over the page, then the press and the release where it is, in the page's own pixels
			await input({ type: "mouse", action: "move", x: 700, y: 550 });
			await input({ type: "mouse", action: "down", x: 700, y: 550, button: "left" });
			await input({ type: "mouse", action: "up", x: 700, y: 550, button: "left" });
			await until(() => requests().some((r) => r.startsWith("GET /pressed ")));
			await until(() => view.events.some((e) => e.type === "state" && e.view.url === `${SHOP}/pressed`));
		} finally {
			await control(false);
			await view.close();
		}
	});

	it("the agent's click on a ref reaches that element, never what lies over its middle", async () => {
		explain();
		const refOf = (text: string, name: string) => new RegExp(`link "${name}" \\[ref=(s\\d+e\\d+)\\]`).exec(text)?.[1];
		const lunch = await say("open the lunch mail", [
			() => ["browser_navigate", { url: `${ANON}/mail` }],
			(page) => ["browser_click", { ref: refOf(page, "Lunch on Friday") }],
		]);
		await until(() => ended(lunch.chat));
		expect(requests().some((r) => r.startsWith("GET /open/1 "))).toBe(true);
		expect((await results(chat, "browser_click")).at(-1)?.text).toContain('Page "Reading"');
		// covered whole: the element clicks itself, and the cover gets nothing
		const rent = await say("open the rent mail", [
			() => ["browser_navigate", { url: `${ANON}/mail` }],
			(page) => ["browser_click", { ref: refOf(page, "Rent is due") }],
		]);
		await until(() => ended(rent.chat));
		expect(requests().some((r) => r.startsWith("GET /open/2 "))).toBe(true);
	});

	it("taken mid-call, the call waits and goes on given back; Stop ends a call at once, at work or waiting", async () => {
		explain();
		const open = await say("read it", [() => ["browser_snapshot", {}]]);
		await until(() => ended(open.chat));
		const waits = (await results(chat, "browser_wait")).length;
		const snapshots = (await results(chat, "browser_snapshot")).length;

		// taken while a call is at work: it stops where it stands and waits; given back, the run goes on
		const long = await say("wait for it", [
			() => ["browser_wait", { text: "never on this page", seconds: 30 }],
			() => ["browser_snapshot", {}],
		]);
		await until(async () => (await state(long.chat)) === "running");
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const taken = Date.now();
		await control(true);
		await waitingForBrowser(chat);
		expect(Date.now() - taken).toBeLessThan(5_000);
		expect(await results(chat, "browser_wait")).toHaveLength(waits);
		await control(false);
		await until(() => ended(chat));
		expect((await results(chat, "browser_wait")).at(-1)?.text).toContain("The owner gave the browser back");
		expect(await results(chat, "browser_snapshot")).toHaveLength(snapshots + 1);

		// Stop during a wait of thirty seconds: the call ends at once, and nothing after it runs
		const done = (await items(chat)).filter((i) => i.role === "assistant" && i.text === "Done.").length;
		const stopped = await say("wait a while", [
			() => ["browser_wait", { seconds: 30 }],
			() => ["browser_snapshot", {}],
		]);
		await until(async () => (await state(stopped.chat)) === "running");
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const stopping = Date.now();
		expect(await api<{ stopped: boolean }>(`/chats/${chat}/stop`, { method: "POST" })).toEqual({ stopped: true });
		await until(async () => (await state(chat)) === "idle");
		expect(Date.now() - stopping).toBeLessThan(2_000);
		expect(await results(chat, "browser_snapshot")).toHaveLength(snapshots + 1);
		expect((await items(chat)).filter((i) => i.role === "assistant" && i.text === "Done.").length).toBe(done);
		runs -= 1;

		// Stop while a call waits for the owner: it ends, its ask with it, and the browser stays theirs
		await control(true);
		const held = await say("look while held", [() => ["browser_snapshot", {}]]);
		await waitingForBrowser(held.chat);
		expect(await api<{ stopped: boolean }>(`/chats/${chat}/stop`, { method: "POST" })).toEqual({ stopped: true });
		await until(async () => (await state(chat)) === "idle");
		expect((await status()).waits.filter((wait) => wait.chat === chat)).toEqual([]);
		expect((await control(false)).control).toBe("agent");
		// the stopped call's result says so, and never reads the page given back after it
		const cut = (await results(chat, "browser_snapshot")).at(-1)!;
		expect(cut.error).toBe(true);
		expect(cut.text).not.toContain("The owner gave the browser back");
		runs -= 1;
	});

	it("on a site the owner never signed in to, the page's write goes at once, once, through the proxy, unasked", async () => {
		explain();
		const before = requests().filter((request) => request === "POST /bootstrap challenge=1").length;
		const opened = await say("open the anonymous challenge", [
			() => ["browser_navigate", { url: `${ANON}/challenge` }],
		]);
		await until(() => ended(opened.chat));
		expect((await status()).waits.filter((wait) => wait.chat === opened.chat)).toEqual([]);
		const said = (await results(opened.chat, "browser_navigate")).at(-1)?.text ?? "";
		expect(said).toContain(`[banda] The page sent POST ${ANON}/bootstrap`);
		expect(requests().filter((request) => request === "POST /bootstrap challenge=1")).toHaveLength(before + 1);
	});

	it("each chat of an agent has its own tab: another chat's page never blanks it, and each request is its own chat's", async () => {
		explain();
		/** A message to a chat: a new one in a thread of its own, or one that exists, by its id. */
		const tell = (to: { thread: string } | { chat: number }, word: string, plan: Step[]) => {
			plans.set(word, plan);
			return api<Extract<Posted, { turn: number }>>("/messages", {
				method: "POST",
				body: JSON.stringify({ id: randomUUID(), ...to, text: `${word}, please` }),
			});
		};
		const last = async (of: number, tool: string) => (await results(of, tool)).at(-1)?.text ?? "";
		/** A tab as its own stream first says it is. */
		const tab = async (of: number) => {
			const stop = new AbortController();
			const response = await fetch(`${url}/api/chats/${of}/browser`, {
				headers: { authorization: `Bearer ${token}` },
				signal: stop.signal,
			});
			const reader = response.body!.getReader();
			let text = "";
			while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
			stop.abort();
			return (JSON.parse(text.slice(0, text.indexOf("\n\n")).replace(/^data: /, "")) as ViewEvent & { type: "state" })
				.view;
		};
		// two chats of the same agent, each in a thread of its own
		const a = await tell({ thread: randomUUID() }, "open the mail tab", [
			() => ["browser_navigate", { url: `${ANON}/mail` }],
		]);
		await until(async () => (await last(a.chat, "browser_navigate")).includes("Lunch on Friday"));
		const b = await tell({ thread: randomUUID() }, "open the reading tab", [
			() => ["browser_navigate", { url: `${ANON}/open/1` }],
		]);
		expect(b.chat).not.toBe(a.chat);
		await until(async () => (await last(b.chat, "browser_navigate")).includes("A message"));
		// the first chat's page is as it left it: its own tab, never blanked by the second
		await tell({ chat: a.chat }, "look at the mail tab again", [() => ["browser_snapshot", {}]]);
		await until(async () => (await last(a.chat, "browser_snapshot")) !== "");
		expect(await last(a.chat, "browser_snapshot")).toContain("Lunch on Friday");
		expect(await last(a.chat, "browser_snapshot")).not.toContain("A message");
		// both tabs are open at once, each its own chat's
		expect(await tab(a.chat)).toMatchObject({ running: true, chat: a.chat, url: `${ANON}/mail` });
		expect(await tab(b.chat)).toMatchObject({ running: true, chat: b.chat, url: `${ANON}/open/1` });
	});
});
