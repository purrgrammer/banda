/**
 * Git through the box's egress proxy, for real (DESIGN.md "The box", Network): a chat clones and pulls a private
 * repository over HTTP with the token set at the proxy (the box never holds it), and a push waits for the owner and,
 * approved, lands once; and a download of any size streams through, a credential a compressed body echoes scrubbed. Git's smart HTTP fetches with `POST …/git-upload-pack`, a read by protocol that a POST rule
 * alone takes for a write. A stand-in git server (git http-backend, in the box's own image) on a network of public
 * addresses routed nowhere stands for the forge, so no test needs the real network. Needs Docker, and skips without it.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Box, openBox } from "../src/box/box.ts";
import { boxParts, containerBox, dockerAvailable, removeContainerBox } from "../src/box/container.ts";
import { boxEnv, boxTools } from "../src/box/tools.ts";
import { fetchIn } from "../src/box/web-fetch.ts";
import { ActivityLog } from "../src/core/activity.ts";
import { proxyKnows, sweepSent } from "../src/core/egress.ts";
import { OWNER, type Received } from "../src/core/gateway.ts";
import { onPermissions, Permissions, revoke } from "../src/core/permissions.ts";
import { RELEASE, RELEASED } from "../src/core/release.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { blobStore, FAUX_MODEL, FakeGateway, until } from "./helpers.ts";

const docker = await dockerAvailable();
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
        env = dict(os.environ, GIT_PROJECT_ROOT="/srv", GIT_HTTP_EXPORT_ALL="1", PATH_INFO=path, QUERY_STRING=query,
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
ThreadingHTTPServer(("0.0.0.0", 8080), Forge).serve_forever()
`;

/** The forge's start: a bare repository with one commit on main that accepts pushes, then the server. */
const FORGE_START = [
	"set -e",
	"git init -q --bare -b main /srv/repo.git",
	"git -C /srv/repo.git config http.receivepack true",
	"git init -q -b main /tmp/seed",
	"echo first > /tmp/seed/README",
	"git -C /tmp/seed add README",
	"git -C /tmp/seed commit -q -m first",
	"git -C /tmp/seed push -q /srv/repo.git main",
	'exec python3 -u -c "$FORGE"',
].join("\n");

const run = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();

async function sh(env: ExecutionEnv, command: string): Promise<{ out: string; code: number }> {
	let out = "";
	const result = await env.exec(command, { onOutput: (text) => (out += text), timeout: 60 }, context);
	if (!result.ok) return { out: `${out}${result.error.code}: ${result.error.message}`, code: -1 };
	return { out: out.trim(), code: result.value.exitCode };
}

describe.skipIf(!docker)("git through the box's proxy", { timeout: 180_000 }, () => {
	const tag = randomUUID().slice(0, 8);
	const pub = `banda-test-${tag}-pub`;
	const forge = `banda-test-${tag}-forge`;
	const FORGE_HOST = `forge-${tag}.example`;
	const TOKEN = `ghp_${randomUUID().replaceAll("-", "")}`;
	const URL = `http://${FORGE_HOST}:8080/repo.git`;
	let home: string;
	let box: Box;
	let harness: Harness;
	let stopPermissions: (() => Promise<void>) | undefined;
	let knows!: ReturnType<typeof proxyKnows>;
	const faux = fauxProvider();
	const gateway = new FakeGateway();
	const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5 });
	/** What the model runs for each owner message: bash with that command, and a held request asks by itself. */
	const commands = new Map<string, string>();

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "banda-git-test-"));
		const setup = containerBox(home);
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
					return fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `b${n}` })], { stopReason: "toolUse" });
				return fauxAssistantMessage("Done.");
			}) as never,
		);
		const registry = createRegistry();
		registry.install(core.extension);
		registry.install(
			boxTools({
				workspace: box.workspace,
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
		// the box up (the first run builds both images), then the forge, in the box's own image, beside its proxy
		expect((await sh(box.env(), "true")).code).toBe(0);
		const image = run(["inspect", "--format", "{{.Config.Image}}", boxParts(home).box]);
		const octet = 16 + Math.floor(Math.random() * 200);
		run(["network", "create", "--subnet", `11.${octet}.${Math.floor(Math.random() * 250)}.0/24`, pub]);
		run(["network", "connect", pub, boxParts(home).proxy]);
		run([
			"run",
			"--detach",
			"--name",
			forge,
			// swept with the home if the test dies before its own teardown
			"--label",
			`banda.home=${home}`,
			"--network",
			pub,
			"--network-alias",
			FORGE_HOST,
			"--user",
			"0",
			"--env",
			`TOKEN=${TOKEN}`,
			"--env",
			`FORGE=${FORGE}`,
			"--entrypoint",
			"sh",
			image,
			"-c",
			FORGE_START,
		]);
		await until(() => {
			try {
				return (
					run([
						"exec",
						boxParts(home).proxy,
						"python3",
						"-c",
						`import socket; socket.create_connection(("${FORGE_HOST}", 8080), 2)`,
					]) === ""
				);
			} catch {
				return false;
			}
		});
	}, 20 * 60_000);

	afterAll(async () => {
		await stopPermissions?.();
		await harness?.close(context);
		await box?.close();
		try {
			run(["rm", "--force", forge]);
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

	/** Every request the forge got: method, path and whether it carried the token. */
	const requests = () =>
		run(["logs", forge])
			.split("\n")
			.filter((line) => /^(GET|POST) /.test(line));
	/** The commit the forge's main points at. */
	const forgeMain = () => run(["exec", forge, "git", "-C", "/srv/repo.git", "rev-parse", "main"]);

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
		const graph = await harness.taskGraph(context);
		try {
			return !Object.values(graph.value.tasks).some((node) => node.kind === RELEASE || node.kind === "banda.turn");
		} finally {
			graph.dispose();
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

	it("a chat clones and pulls a private repository without asking; the token is set at the proxy, never in the box", async () => {
		const env = box.env(undefined, box.egress?.env(91_001));
		const dir = `/tmp/clone-${tag}`;
		const clone = await sh(env, `git clone -q ${URL} ${dir} 2>&1; echo " code=$?"`);
		expect(clone.out).toMatch(/code=0$/);
		expect((await sh(env, `cat ${dir}/README`)).out).toBe("first");
		// a new commit at the forge, then a pull
		run([
			"exec",
			forge,
			"sh",
			"-c",
			"cd /tmp/seed && echo second >> README && git commit -qam second && git push -q /srv/repo.git main",
		]);
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

	it("a push waits for the owner and lands nothing; approved, it lands once", async () => {
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

	it("a push held says to allow its host; once the owner does, git push goes straight through and lands once", async () => {
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
		await until(() => run(["exec", boxParts(home).proxy, "cat", "/state/config.json"]).includes(`"${host}"`));
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
		expect(await sweepSent(box.egress!, harness, Date.now)).toBe(1);
		const swept = (await harness.snapshot(ActivityLog, context))?.events ?? [];
		expect(swept.filter((e) => e.chat === direct.chat && e.outside === "sent")).toHaveLength(2);
		expect(await sweepSent(box.egress!, harness, Date.now)).toBe(0);
	});

	it("a host taken back stops taking writes at the proxy before the revoke returns", async () => {
		const [id] = Object.keys((await harness.snapshot(Permissions, context))?.permissions ?? {});
		expect(id).toBeDefined();
		expect(await revoke(harness, id!, Date.now())).toBe(true);
		// as the daemon's revoke route does: the proxy is told before the owner hears it was taken back
		expect(await box.egress!.configure()).toBe("told");
		const config = JSON.parse(run(["exec", boxParts(home).proxy, "cat", "/state/config.json"])) as {
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
