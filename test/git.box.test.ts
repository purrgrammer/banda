/**
 * Git through the box's egress proxy, for real (DESIGN.md "The box", Network): a chat clones and pulls a private
 * repository over HTTP with the token set at the proxy (the box never holds it), and a push waits for the owner and,
 * approved, lands once; and a download of any size streams through, a credential a compressed body echoes scrubbed. Git's smart HTTP fetches with `POST …/git-upload-pack`, a read by protocol that a POST rule
 * alone takes for a write. A stand-in git server (git http-backend) on public addresses routed nowhere stands for the
 * forge, so no test needs the real network. On the box `BANDA_TEST_BOX` names (fixtures/real-box.ts).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { boxEnv, boxTools } from "../src/box/tools.ts";
import { fetchIn } from "../src/box/web-fetch.ts";
import { ActivityLog } from "../src/core/activity.ts";
import { proxyKnows, sweepReceipts } from "../src/core/egress.ts";
import { OWNER, type Received } from "../src/core/gateway.ts";
import { onPermissions, Permissions, revoke } from "../src/core/permissions.ts";
import { RELEASE, RELEASED } from "../src/core/release.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { boxSuite, realBox, type Site } from "./fixtures/real-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, until } from "./helpers.ts";

const web = { gateway: "web", peer: OWNER };

/**
 * A private forge: git http-backend behind a server that answers 401 to any request without the token, and prints
 * one line per request (its method, path and whether it carried the token).
 */
const FORGE = `
import base64, gzip, os, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
WANT = "Basic " + base64.b64encode(b"x-access-token:" + os.environ["TOKEN"].encode()).decode()
class Forge(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args): pass
    def do_GET(self): self.git()
    def do_POST(self): self.git()
    def git(self):
        authed = self.headers.get("Authorization") == WANT
        print(f"{self.command} {self.path} token={authed}", flush=True)
        if self.path == "/big":
            # larger than any body the proxy once held whole
            size = 40 * 1024 * 1024
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            for _ in range(size // 65536): self.wfile.write(b"z" * 65536)
            return
        if self.path == "/echo-gz":
            # a server that echoes the token it was sent, gzipped
            body = gzip.compress(b"echo:" + (self.headers.get("Authorization") or "").encode())
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if not authed:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="forge"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        path, _, query = self.path.partition("?")
        env = dict(os.environ, GIT_PROJECT_ROOT=os.environ["ROOT"], GIT_HTTP_EXPORT_ALL="1", PATH_INFO=path, QUERY_STRING=query,
                   REQUEST_METHOD=self.command, CONTENT_TYPE=self.headers.get("Content-Type", ""),
                   CONTENT_LENGTH=str(len(body)), HTTP_CONTENT_ENCODING=self.headers.get("Content-Encoding", ""),
                   GIT_PROTOCOL=self.headers.get("Git-Protocol", ""), REMOTE_USER="x-access-token", REMOTE_ADDR="11.0.0.1")
        out = subprocess.run(["git", "http-backend"], input=body, env=env, capture_output=True).stdout
        sep = b"\\r\\n\\r\\n" if b"\\r\\n\\r\\n" in out else b"\\n\\n"
        head, _, rest = out.partition(sep)
        status, headers = 200, []
        for line in head.replace(b"\\r\\n", b"\\n").split(b"\\n"):
            key, _, value = line.decode().partition(":")
            if key.lower() == "status": status = int(value.strip().split()[0])
            elif key: headers.append((key, value.strip()))
        self.send_response(status)
        for key, value in headers: self.send_header(key, value)
        self.send_header("Content-Length", str(len(rest)))
        self.end_headers()
        self.wfile.write(rest)
ThreadingHTTPServer((os.environ["BIND"], 8080), Forge).serve_forever()
`;

/** The forge's start: a bare repository with one commit on main that accepts pushes, then the server. */
const FORGE_START = [
	"set -e",
	'git init -q --bare -b main "$ROOT/repo.git"',
	'git -C "$ROOT/repo.git" config http.receivepack true',
	'git init -q -b main "$SEED"',
	'echo first > "$SEED/README"',
	'git -C "$SEED" add README',
	'git -C "$SEED" commit -q -m first',
	'git -C "$SEED" push -q "$ROOT/repo.git" main',
	'exec python3 -u -c "$FORGE"',
].join("\n");

async function sh(env: ExecutionEnv, command: string): Promise<{ out: string; code: number }> {
	let out = "";
	const result = await env.exec(command, { onOutput: (text) => (out += text), timeout: 60 }, context);
	if (!result.ok) return { out: `${out}${result.error.code}: ${result.error.message}`, code: -1 };
	return { out: out.trim(), code: result.value.exitCode };
}

boxSuite(`git through the box's proxy (${realBox.kind})`, { timeout: 180_000 }, () => {
	const tag = randomUUID().slice(0, 8);
	const FORGE_HOST = realBox.host("forge");
	const TOKEN = `ghp_${randomUUID().replaceAll("-", "")}`;
	const URL = `http://${FORGE_HOST}:8080/repo.git`;
	let home: string;
	let box: Box;
	let forge: Site;
	/**
	 * Why git cannot run in this box, or undefined. The computer banda ships boots without it (agents install into
	 * /tools), so its run stages one there (`BANDA_TEST_BOX_TOOLS`); without one the cases that run git skip, saying so,
	 * unless the box was named: then they fail.
	 */
	let noGit: string | undefined;
	let harness: Harness;
	let stopPermissions: (() => Promise<void>) | undefined;
	let knows!: ReturnType<typeof proxyKnows>;
	const faux = fauxProvider();
	const gateway = new FakeGateway();
	const core = defineCore({
		blobs: blobStore(),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
	});
	/** What the model runs for each owner message: bash with that command, and a held request asks by itself. */
	const commands = new Map<string, string>();

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "banda-git-test-"));
		const setup = realBox.setup(home);
		// as github.com is: a forge whose git fetches read, with the owner's token set at the proxy
		setup.egress?.source(async () => ({
			git: [FORGE_HOST],
			credentials: [
				{
					host: FORGE_HOST,
					header: "Authorization",
					value: `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
					// the stand-in forge speaks plain http, so its credential names it
					scheme: "http",
				},
			],
			permitted: await knows.permitted(),
		}));
		box = openBox(setup, () => {});
		const models = createModels();
		models.setProvider(faux.provider);
		let n = 0;
		faux.setResponses(
			Array.from({ length: 1000 }, () => (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
				const last = ctx.messages.at(-1);
				const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
				n += 1;
				const command = last?.role === "user" ? commands.get(text) : undefined;
				if (command !== undefined)
					return fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `b${n}` })], {
						stopReason: "toolUse",
					});
				return fauxAssistantMessage("Done.");
			}) as never,
		);
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(
			boxTools({
				box,
				...(box.egress === undefined ? {} : { egress: core.held(box.egress) }),
				ready: (chat) => knows.ready(chat),
			}),
		);
		harness = await openStore(home, { models, registry, env: boxEnv(box) });
		harness.resume();
		// as the daemon does: the proxy learns of a host allowed or taken back
		const tell = async () => {
			if ((await box.egress?.configure()) === "told") knows.told();
		};
		knows = proxyKnows(harness, tell);
		await harness.commit(async (tx) => {
			await tx.doc(Permissions);
		}, context);
		stopPermissions = await onPermissions(harness, tell);
		// the box up (the first run builds or loads both images), then the forge beside its proxy
		expect((await sh(box.env(), "true")).code).toBe(0);
		// a file put in /tools from outside shows in the box within a moment, not always at once
		const staged = await realBox.tools(home);
		let tries = staged ? 50 : 1;
		for (;;) {
			const git = await sh(box.env(), "git --version 2>&1");
			if (git.code === 0) break;
			tries -= 1;
			if (tries > 0) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				continue;
			}
			noGit = staged
				? `the git staged in /tools of the ${realBox.kind} box does not run: ${git.out}`
				: `the ${realBox.kind} box has no git: its image ships none, and BANDA_TEST_BOX_TOOLS names no folder ` +
					"that holds one for /tools (test/fixtures/box-git.sh stages it)";
			if (staged || realBox.named) throw new Error(noGit);
			break;
		}
		forge = await realBox.site(home, {
			labels: ["forge"],
			image: "box",
			env: { TOKEN, FORGE },
			start: FORGE_START,
		});
	}, 20 * 60_000);

	afterAll(async () => {
		await stopPermissions?.();
		await harness?.close(context);
		await box?.close();
		await forge?.close();
		if (home !== undefined) {
			await realBox.remove(home);
			rmSync(home, { recursive: true, force: true });
		}
	});

	/** Every request the forge got: method, path and whether it carried the token. */
	const requests = () => forge.output().filter((line) => /^(GET|POST) /.test(line));
	/** The commit the forge's main points at. */
	const forgeMain = () => forge.exec('git -C "$ROOT/repo.git" rev-parse main');

	const say = async (text: string, command: string, thread = randomUUID()) => {
		commands.set(text, command);
		const received: Received = await core.receive(harness, {
			id: randomUUID(),
			origin: { gateway: "fake", peer: OWNER, thread },
			text,
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		return received;
	};
	const done = async (turn: number) => {
		if ((await harness.getTask(turn as TaskId, context))?.state.status !== "terminal") return false;
		const graph = await harness.watchTaskGraph(context);
		try {
			return !Object.values(graph.value.tasks).some((node) => node.kind === RELEASE || node.kind === "banda.turn");
		} finally {
			await graph.stop();
		}
	};
	/** What the agent was woken with about the held requests of `chat`. */
	const told = async (chat: number) => {
		const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		return page.items
			.filter((e) => e.kind === RELEASED)
			.map((e) => JSON.stringify((e.model?.[0] as { content?: unknown } | undefined)?.content));
	};
	const nextAsk = (turn: number) =>
		until(async () => {
			const [wait] = await openWaits(harness);
			if (wait !== undefined) return { wait };
			return (await done(turn)) ? { wait: undefined } : undefined;
		});
	const results = async (chat: number) => {
		const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		return page.items
			.filter((e) => e.kind === "pi.tool-result")
			.map((e) =>
				((e.model?.[0] as { content?: { text?: string }[] } | undefined)?.content ?? []).map((p) => p.text).join(""),
			);
	};

	it("a chat clones and pulls a private repository without asking; the token is set at the proxy, never in the box", async (ctx) => {
		if (noGit !== undefined) ctx.skip(noGit);
		const env = box.env(undefined, box.egress?.env(91_001));
		const dir = `/tmp/clone-${tag}`;
		const clone = await sh(env, `git clone -q ${URL} ${dir} 2>&1; echo " code=$?"`);
		expect(clone.out).toMatch(/code=0$/);
		expect((await sh(env, `cat ${dir}/README`)).out).toBe("first");
		// a new commit at the forge, then a pull
		forge.exec('cd "$SEED" && echo second >> README && git commit -qam second && git push -q "$ROOT/repo.git" main');
		const pull = await sh(env, `git -C ${dir} pull -q 2>&1; echo " code=$?"`);
		expect(pull.out).toMatch(/code=0$/);
		expect((await sh(env, `git -C ${dir} rev-parse HEAD`)).out).toBe(forgeMain());
		// every request reached the forge with the token, and nothing in the box holds it
		expect(requests().length).toBeGreaterThan(0);
		expect(requests().every((line) => line.endsWith("token=True"))).toBe(true);
		expect(
			(await sh(env, `grep -rl '${TOKEN}' ${dir}/.git /work /tmp 2>/dev/null; env | grep -c '${TOKEN}'`)).out,
		).toBe("0");
	});

	it("a download larger than a body the proxy holds streams through; a token a gzipped body echoes is scrubbed", async () => {
		const env = box.env(undefined, box.egress?.env(91_003));
		const big = await sh(
			env,
			`curl -sS -m 120 -o /dev/null -w '%{http_code} %{size_download}' http://${FORGE_HOST}:8080/big`,
		);
		expect(big.out).toBe(`200 ${40 * 1024 * 1024}`);
		const echoed = await sh(env, `curl -sS -m 20 --compressed http://${FORGE_HOST}:8080/echo-gz`);
		expect(echoed.out).toBe("echo:[removed by banda]");
		expect(echoed.out).not.toContain(TOKEN);
	});

	it("web_fetch's read acts as nobody: the proxy sets no credential on it; a private address is refused", async () => {
		const env = box.env(undefined, box.egress?.env(91_005));
		const echoed = await fetchIn(env, `http://${FORGE_HOST}:8080/echo-gz`, context);
		if (!("status" in echoed)) throw new Error(echoed.failed);
		expect(echoed.status).toBe(200);
		expect(new TextDecoder().decode(echoed.body)).toBe("echo:");
		expect(requests().at(-1)).toBe("GET /echo-gz token=False");
		// a command's read of the same page still has the owner's token set
		expect((await sh(env, `curl -sS -m 20 --compressed http://${FORGE_HOST}:8080/echo-gz`)).out).toBe(
			"echo:[removed by banda]",
		);
		// the proxy refuses what is not public on its own, whatever the daemon checked before
		const inside = await fetchIn(env, "http://169.254.169.254/latest/meta-data/", context);
		expect("status" in inside ? inside.status : 0).not.toBe(200);
	});

	it("a push waits for the owner and lands nothing; approved, it lands once", async (ctx) => {
		if (noGit !== undefined) ctx.skip(noGit);
		const env = box.env(undefined, box.egress?.env(91_002));
		const dir = `/tmp/push-${tag}`;
		expect((await sh(env, `git clone -q ${URL} ${dir} 2>&1; echo " code=$?"`)).out).toMatch(/code=0$/);
		expect((await sh(env, `cd ${dir} && echo mine >> README && git commit -qam mine && git rev-parse HEAD`)).code).toBe(
			0,
		);
		const mine = (await sh(env, `git -C ${dir} rev-parse HEAD`)).out;
		const before = forgeMain();
		const push = await say("push it", `cd ${dir} && git push origin main 2>&1`);
		const { wait } = await nextAsk(push.turn);
		expect(wait?.ask).toMatchObject({ tool: "propose_send" });
		expect(String((wait!.ask as { label?: string }).label)).toContain("git-receive-pack");
		// held, not sent: the forge's main has not moved
		expect(forgeMain()).toBe(before);
		await answer(harness, wait!.key, "approve", web, "bearer");
		await until(() => done(push.turn));
		expect(forgeMain()).toBe(mine);
		// and the chat hears that it was sent
		expect((await told(push.chat)).at(-1)).toContain("Sent.");
	});

	it("a push held says to allow its host; once the owner does, git push goes straight through and lands once", async (ctx) => {
		if (noGit !== undefined) ctx.skip(noGit);
		const env = box.env(undefined, box.egress?.env(91_004));
		const dir = `/tmp/allow-${tag}`;
		const host = `http://${FORGE_HOST}:8080`;
		const receives = () => requests().filter((line) => line.startsWith("POST /repo.git/git-receive-pack")).length;
		expect((await sh(env, `git clone -q ${URL} ${dir} 2>&1; echo " code=$?"`)).out).toMatch(/code=0$/);
		const commit = async (line: string) => {
			expect((await sh(env, `cd ${dir} && echo ${line} >> README && git commit -qam ${line}`)).code).toBe(0);
			return (await sh(env, `git -C ${dir} rev-parse HEAD`)).out;
		};
		const pushing = `cd ${dir} && git push origin main 2>&1; echo " code=$?"`;
		const first = await commit("held");
		const before = forgeMain();
		const pushesBefore = receives();
		const held = await say("push, held", pushing);
		const { wait } = await nextAsk(held.turn);
		// git failed, held; the chat is told how to make the next one go: allow the host, then run it again. The card
		// opens in the commit that stores the ticket, before the command's result is stored
		await until(async () => (await results(held.chat)).at(-1)?.includes("Held, not sent"));
		const said = (await results(held.chat)).at(-1) ?? "";
		expect(said).not.toMatch(/code=0/);
		expect(said).toContain(`ask the owner to allow ${host} with ask_hosts`);
		expect(forgeMain()).toBe(before);
		expect(wait?.ask).toMatchObject({
			tool: "propose_send",
			scopes: expect.arrayContaining([expect.objectContaining({ scope: "host", host })]),
		});
		// "Always allow": this held push is sent, once, and the proxy is told the host
		await answer(harness, wait!.key, "approve", web, "bearer", { approving: { permission: { scope: "host" } } });
		await until(() => done(held.turn));
		expect(forgeMain()).toBe(first);
		expect(receives()).toBe(pushesBefore + 1);
		await until(async () => (await realBox.exec(home, "proxy", "cat /state/config.json")).includes(`"${host}"`));
		// run again, git finds nothing left to push: exit 0, nothing sent
		const again = await say("push again", pushing);
		expect((await nextAsk(again.turn)).wait).toBeUndefined();
		expect((await results(again.chat)).at(-1)).toMatch(/code=0/);
		expect(receives()).toBe(pushesBefore + 1);
		// a new commit pushes straight through, as it happens: no ticket, no ask, exit 0, landed once with the token
		const second = await commit("direct");
		const direct = await say("push the next", pushing);
		expect((await nextAsk(direct.turn)).wait).toBeUndefined();
		const pushed = (await results(direct.chat)).at(-1) ?? "";
		expect(pushed).toMatch(/code=0/);
		expect(pushed).toContain(
			`Sent POST ${host}/repo.git/git-receive-pack under the owner's permission for ${host} (HTTP 200).`,
		);
		expect(forgeMain()).toBe(second);
		expect(receives()).toBe(pushesBefore + 2);
		expect(requests().at(-1)).toMatch(/^POST \/repo\.git\/git-receive-pack token=True$/);
		const activity = (await harness.snapshot(ActivityLog, context))?.events ?? [];
		expect(activity.filter((e) => e.chat === direct.chat && e.outside === "sent")).toEqual([
			expect.objectContaining({
				what: `Sent POST ${FORGE_HOST}:8080/repo.git/git-receive-pack under your permission (HTTP 200)`,
				hash: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
		]);
		// a push by no tool call (a process the box left running) goes through too, and the sweep logs it
		const third = await commit("background");
		const quiet = await sh(box.env(undefined, box.egress?.env(direct.chat)), pushing);
		expect(quiet.out).toMatch(/code=0/);
		expect(forgeMain()).toBe(third);
		expect(await sweepReceipts(core.held(box.egress!), harness, Date.now, "settled")).toBe(1);
		const swept = (await harness.snapshot(ActivityLog, context))?.events ?? [];
		expect(swept.filter((e) => e.chat === direct.chat && e.outside === "sent")).toHaveLength(2);
		expect(await sweepReceipts(core.held(box.egress!), harness, Date.now, "settled")).toBe(0);
	});

	it("a host taken back stops taking writes at the proxy before the revoke returns", async (ctx) => {
		if (noGit !== undefined) ctx.skip(noGit);
		const [id] = Object.keys((await harness.snapshot(Permissions, context))?.permissions ?? {});
		expect(id).toBeDefined();
		expect(await revoke(harness, id!, Date.now())).toBe(true);
		// as the daemon's revoke route does: the proxy is told before the owner hears it was taken back
		expect(await box.egress!.configure()).toBe("told");
		const config = JSON.parse(await realBox.exec(home, "proxy", "cat /state/config.json")) as {
			permitted: object;
			generation: number;
		};
		expect(config.permitted).toEqual({});
		expect(config.generation).toBeGreaterThan(0);
		const env = box.env(undefined, box.egress?.env(91_004));
		const dir = `/tmp/allow-${tag}`;
		expect((await sh(env, `cd ${dir} && echo after >> README && git commit -qam after`)).code).toBe(0);
		const before = forgeMain();
		const held = await say("push after", `cd ${dir} && git push origin main 2>&1; echo " code=$?"`);
		const { wait } = await nextAsk(held.turn);
		expect(wait?.ask).toMatchObject({ tool: "propose_send" });
		expect(forgeMain()).toBe(before);
		await answer(harness, wait!.key, "deny", web, "bearer");
		await until(() => done(held.turn));
	});
});
