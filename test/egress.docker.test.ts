/**
 * The box's closed network, for real (DESIGN.md "The box", Network): the box on an internal network with the egress
 * proxy alone; a write held, approved, and sent once, byte for byte; private ranges and address tricks refused; the
 * banda authority the only one the box trusts; a permission over a route that sends the next write unasked; and the
 * box destroyed mid-chat. Needs Docker, and skips without it. A test server stands for the internet: a container on a network
 * of public addresses (11.x, routed nowhere) that the proxy joins, so no test needs the real network.
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
import { Tickets } from "../src/core/egress.ts";
import { OWNER, type Received } from "../src/core/gateway.ts";
import { RELEASE, RELEASED } from "../src/core/release.ts";
import { openWaits } from "../src/core/status.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { blobStore, FAUX_MODEL, FakeGateway, until } from "./helpers.ts";

const docker = await dockerAvailable();
const MITMPROXY = "mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f";
const web = { gateway: "web", peer: OWNER };

/** A server that answers 200 to anything and prints each request's raw bytes, base64, one per line. */
const ECHO = `
import base64, socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 8080)); s.listen(16)
while True:
    c, _ = s.accept()
    data = b""
    while b"\\r\\n\\r\\n" not in data:
        chunk = c.recv(65536)
        if not chunk: break
        data += chunk
    head, _, body = data.partition(b"\\r\\n\\r\\n")
    length = 0
    for line in head.split(b"\\r\\n")[1:]:
        k, _, v = line.partition(b":")
        if k.strip().lower() == b"content-length": length = int(v.strip())
    while len(body) < length:
        chunk = c.recv(65536)
        if not chunk: break
        body += chunk
    print(base64.b64encode(head + b"\\r\\n\\r\\n" + body).decode(), flush=True)
    c.sendall(b"HTTP/1.1 200 OK\\r\\ncontent-type: text/plain\\r\\ncontent-length: 7\\r\\nconnection: close\\r\\n\\r\\nechoed\\n")
    c.close()
`;

const run = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();

async function sh(env: ExecutionEnv, command: string): Promise<{ out: string; code: number }> {
	let out = "";
	const result = await env.exec(command, { onOutput: (text) => (out += text), timeout: 60 }, context);
	if (!result.ok) return { out: `${out}${result.error.code}: ${result.error.message}`, code: -1 };
	return { out: out.trim(), code: result.value.exitCode };
}

// every step here is docker calls (each command's intake, the replay, the server's log): seconds each on a loaded machine
describe.skipIf(!docker)("the box's closed network", { timeout: 180_000 }, () => {
	const tag = randomUUID().slice(0, 8);
	const pub = `banda-test-${tag}-pub`;
	const echo = `banda-test-${tag}-echo`;
	const ECHO_HOST = `echo-${tag}.example`;
	let home: string;
	let box: Box;
	let harness: Harness;
	const faux = fauxProvider();
	const gateway = new FakeGateway();
	const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5 });
	/** What the model runs for each owner message: bash with that command, and a held request asks by itself. */
	const commands = new Map<string, string>();

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "banda-egress-test-"));
		const setup = containerBox(home);
		setup.egress?.source(async () => ({ credentials: [] }));
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
		registry.install(boxTools({ box, ...(box.egress === undefined ? {} : { egress: core.held(box.egress) }) }));
		harness = await openStore(home, { models, registry, env: boxEnv(box) });
		harness.resume();
		// the box up (the first run builds both images), then the stand-in internet beside its proxy
		expect((await sh(box.env(), "true")).code).toBe(0);
		const octet = 16 + Math.floor(Math.random() * 200);
		run(["network", "create", "--subnet", `11.${octet}.${Math.floor(Math.random() * 250)}.0/24`, pub]);
		run(["network", "connect", pub, boxParts(home).proxy]);
		run([
			"run",
			"--detach",
			"--name",
			echo,
			// swept with the home if the test dies before its own teardown
			"--label",
			`banda.home=${home}`,
			"--network",
			pub,
			"--network-alias",
			ECHO_HOST,
			"--entrypoint",
			"python3",
			MITMPROXY,
			"-u",
			"-c",
			ECHO,
		]);
		await until(() => {
			try {
				return (
					run([
						"exec",
						boxParts(home).proxy,
						"python3",
						"-c",
						`import socket; socket.create_connection(("${ECHO_HOST}", 8080), 2)`,
					]) === ""
				);
			} catch {
				return false;
			}
		});
	}, 20 * 60_000);

	afterAll(async () => {
		await harness?.close(context);
		await box?.close();
		try {
			run(["rm", "--force", echo]);
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

	/** Every request the stand-in server got, raw. */
	const echoed = () =>
		run(["logs", echo])
			.split("\n")
			.filter(Boolean)
			.map((line) => Buffer.from(line, "base64").toString("latin1"));

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

	it("the box resolves no outside name, has no route out, and trusts the banda authority alone", async () => {
		const env = box.env(undefined, box.egress?.env(90_005));
		expect((await sh(env, `getent hosts ${ECHO_HOST} || echo none`)).out).toBe("none");
		expect((await sh(env, "getent hosts example.com || echo none")).out).toBe("none");
		const ip = run(["inspect", "--format", `{{(index .NetworkSettings.Networks "${pub}").IPAddress}}`, echo]);
		expect((await sh(env, `curl -sS -m 5 --noproxy '*' http://${ip}:8080/ 2>&1; echo " code=$?"`)).out).toMatch(
			/code=(7|28)$/,
		);
		const tls = await sh(env, `curl -sv -m 20 https://${ECHO_HOST}:8080/ -o /dev/null 2>&1 || true`);
		expect(tls.out).toMatch(/issuer: (CN|O)=banda/);
		expect(tls.out).toContain("SSL certificate verify ok");
		expect((await sh(env, "grep -c 'BEGIN CERTIFICATE' /etc/ssl/certs/ca-certificates.crt")).out).toBe("1");
		expect((await sh(env, "ls /etc/ssl/certs")).out).toBe("ca-certificates.crt");
		// a server a command starts on the box's loopback (a project's own tests) is reached directly, not refused
		const local = await sh(
			env,
			"python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1; " +
				"curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8765/; kill %1",
		);
		expect(local.out).toBe("200");
	});

	it("refuses private ranges, address tricks, a Host naming another server, and a login it did not mark", async () => {
		const env = box.env(undefined, box.egress?.env(90_006));
		const before = echoed().length;
		const refused = [
			"http://127.0.0.1/",
			"http://0x7f.1/",
			"http://2130706433/",
			"http://017700000001/",
			"http://[::ffff:127.0.0.1]/",
			"http://[::ffff:7f00:1]/",
			"http://169.254.169.254/latest/meta-data/",
			"http://[64:ff9b::a9fe:a9fe]/",
			"http://10.0.0.1/",
			"http://localhost/",
			"http://proxy:8080/",
			"http://host.docker.internal/",
		];
		for (const url of refused) {
			const got = await sh(env, `curl -sS -m 20 --noproxy '' '${url}'; echo " code=$?"`);
			expect(got.out, url).toMatch(/^banda: .*(not on the public internet|not a valid address|does not resolve)/);
		}
		const mismatch = await sh(env, `curl -sS -m 20 http://${ECHO_HOST}:8080/ -H 'Host: example.com'`);
		expect(mismatch.out).toContain("its Host names example.com");
		const tunnel = await sh(env, `curl -sS -m 20 https://${ECHO_HOST}:8080/ -H 'Host: example.com'`);
		expect(tunnel.out).toContain("its Host names example.com");
		const forged = await sh(
			box.env(undefined, { http_proxy: "http://c90006:00000000000000000000000000000000@proxy:8080" }),
			`curl -sS -m 20 -o /dev/null -w '%{http_code}' http://${ECHO_HOST}:8080/`,
		);
		expect(forged.out).toBe("407");
		expect(echoed().length).toBe(before);
	});

	it("a write is held and listed; approved, the proxy sends it once, byte for byte; then its route goes unasked", async () => {
		const before = echoed().length;
		const post =
			`printf 'hello\\nworld' | curl -sS -m 20 --data-binary @- -H 'Content-Type: text/plain' -H 'X-Custom: a b' ` +
			`'http://${ECHO_HOST}:8080/v1/things/42?x=1'`;
		const thread = randomUUID();
		const first = await say("send it", post, thread);
		const { wait } = await nextAsk(first.turn);
		expect(wait?.ask).toMatchObject({
			tool: "propose_send",
			label: `send POST http://${ECHO_HOST}:8080/v1/things/42?x=1`,
			args: { method: "POST", body: "hello\nworld", _route: `POST ${ECHO_HOST}:8080/v1/things/*` },
		});
		// held, not sent: the server has seen nothing
		expect(echoed().length).toBe(before);
		// the card opens in the commit that stores the ticket, before the command's result is stored
		await until(async () => (await results(first.chat)).length > 0);
		const [bash] = await results(first.chat);
		expect(bash).toMatch(/^banda: this request writes, so it waits for the owner: ticket t[0-9a-f]{10}/);
		expect(bash).toContain(`Held, not sent: POST http://${ECHO_HOST}:8080/v1/things/42?x=1`);
		await answer(harness, wait!.key, "approve", web, "bearer", { approving: { permission: { scope: "always" } } });
		await until(() => done(first.turn));
		const sent = echoed().slice(before);
		expect(sent).toHaveLength(1);
		const ticket = String((wait!.ask as { args: { [arg: string]: unknown } }).args._ticket);
		const held = (await harness.snapshot(Tickets, context))!.tickets[ticket]!;
		const exact =
			`${held.method} ${held.path} HTTP/1.1\r\n${held.headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n` +
			Buffer.from(held.body, "base64").toString("latin1");
		expect(sent[0]).toBe(exact);
		expect(sent[0]).toMatch(/^POST \/v1\/things\/42\?x=1 HTTP\/1\.1\r\n/);
		expect(sent[0]).toContain("X-Custom: a b\r\n");
		expect(sent[0]?.endsWith("\r\n\r\nhello\nworld")).toBe(true);
		expect((await told(first.chat))[0]).toContain("Sent. The server answered 200 OK (text/plain).");

		// what came back changes nothing the chat may do: the same route goes within the permission, unasked, and its
		// reads still pass
		const second = await say("again", post.replace("/42?", "/43?"), thread);
		expect((await nextAsk(second.turn)).wait).toBeUndefined();
		expect(echoed().slice(before)).toHaveLength(2);
		const read = await sh(
			box.env(undefined, box.egress?.env(first.chat)),
			`curl -sS -m 20 -o /dev/null -w '%{http_code}' http://${ECHO_HOST}:8080/page`,
		);
		expect(read.out).toBe("200");
	});

	it("the box destroyed mid-chat: the command fails, the next one runs in a box made again", async () => {
		const thread = randomUUID();
		const first = await say("wait a while", "sleep 30; echo slept", thread);
		await until(async () => {
			const { out } = await sh(box.env(), "pgrep -f '^sleep 30$' || true");
			return out !== "";
		});
		run(["rm", "--force", boxParts(home).box]);
		await until(() => done(first.turn));
		const [lost] = await results(first.chat);
		expect(lost).not.toContain("slept");
		const second = await say("are you back?", "echo back; ls /etc/ssl/certs", thread);
		await until(() => done(second.turn));
		const after = await results(second.chat);
		expect(after.at(-1)).toContain("back\nca-certificates.crt");
		// still behind the proxy, never an open network
		expect((await sh(box.env(), "getent hosts example.com || echo none")).out).toBe("none");
	});
});
