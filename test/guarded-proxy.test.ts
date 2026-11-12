import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	browserLogin,
	browserMark,
	guardedProxy,
	type ProxyTransport,
	proxyMark,
	proxyReady,
	tabStamp,
} from "../src/box/guarded-proxy.ts";
import type { HeldRequest } from "../src/core/egress.ts";
import { context } from "../src/core/store.ts";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setup() {
	const home = await mkdtemp(join(tmpdir(), "banda-guarded-proxy-"));
	homes.push(home);
	const calls: { args: readonly string[]; input: string | undefined; timeoutMs: number | undefined }[] = [];
	let answer = "{}";
	let halted = 0;
	const transport: ProxyTransport = {
		exec: async (args, input, timeoutMs) => {
			calls.push({ args, input, timeoutMs });
			return answer;
		},
		running: async () => true,
		halt: async () => {
			halted += 1;
		},
	};
	const proxy = guardedProxy({ home, endpoint: "127.0.0.1:80", transport });
	return {
		home,
		calls,
		transport,
		proxy,
		answer: (value: unknown) => {
			answer = JSON.stringify(value);
		},
		halted: () => halted,
	};
}

const request: HeldRequest = {
	ticket: "t0123456789",
	chat: 7,
	at: 1,
	method: "POST",
	scheme: "https",
	host: "example.com",
	port: 443,
	path: "/send",
	headers: [["content-type", "text/plain"]],
	body: Buffer.from("hello").toString("base64"),
};

describe("the shared guarded proxy", () => {
	it("keeps its stable key and provider credentials on the private control side", async () => {
		const { home, proxy, calls, transport } = await setup();
		const key = (await readFile(join(home, "auth/egress.key"), "utf8")).trim();
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		if (process.platform !== "win32") expect((await stat(join(home, "auth/egress.key"))).mode & 0o777).toBe(0o600);
		const credentials = [{ host: "example.com", header: "Authorization", value: "Bearer owner-secret" }];
		proxy.egress.source(async () => ({ credentials, daemonPort: 7788, permitted: { 7: ["example.com"] } }));
		expect(await proxy.egress.configure()).toBe("told");
		const sent: unknown = JSON.parse(calls[0]?.input ?? "null");
		expect(calls[0]?.args).toEqual(["python3", "/banda/ctl.py", "config"]);
		expect(sent).toMatchObject({ key, credentials, daemonPort: 7788, generation: expect.any(Number) });
		const env = proxy.egress.env(7);
		expect(env.https_proxy).toBe(`http://c7:${proxyMark(key, 7)}@127.0.0.1:80`);
		expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
		expect(JSON.stringify(env)).not.toContain(key);
		expect(JSON.stringify(env)).not.toContain("owner-secret");
		const browser = proxy.browser("mara-two");
		expect(browser.login).toEqual({ username: browserLogin("mara-two"), password: browserMark(key, "mara-two") });
		expect(browser.stamp(7)).toBe(tabStamp(key, "mara-two", 7));
		const restarted = guardedProxy({ home, endpoint: "proxy:8080", transport }).browser("mara-two");
		expect(restarted.login).toEqual(browser.login);
		expect(restarted.stamp(7)).toBe(browser.stamp(7));
	});

	it("uses real pass, receipt, ack and replay operations over the supplied private transport", async () => {
		const { proxy, answer, calls, transport } = await setup();
		answer({ up: true });
		expect(await proxyReady(transport)).toBe(true);
		answer({});
		await proxy.egress.pass(7, "abc123");
		answer({ held: [request], sent: [], reads: ["example.com"], readBytes: 12 });
		expect(await proxy.egress.take(7, context)).toEqual({
			held: [request],
			sent: [],
			reads: ["example.com"],
			readBytes: 12,
		});
		answer([7, 9]);
		expect(await proxy.egress.sentChats(context)).toEqual([7, 9]);
		answer({});
		await proxy.egress.ack(7, 12, [request.ticket], context);
		answer({
			status: 201,
			reason: "Created",
			headers: [["content-type", "text/plain"]],
			body: "b2s=",
			truncated: false,
		});
		expect(await proxy.egress.replay(request, context)).toMatchObject({ status: 201, body: "b2s=" });
		expect(calls.map((call) => call.args)).toEqual([
			["python3", "/banda/ctl.py", "ping"],
			["python3", "/banda/ctl.py", "pass", "7", "abc123"],
			["python3", "/banda/ctl.py", "take", "7"],
			["python3", "/banda/ctl.py", "sent"],
			["python3", "/banda/ctl.py", "ack", "7", "12", request.ticket],
			["python3", "/banda/ctl.py", "replay"],
		]);
		expect(calls.at(-1)?.input).toBe(JSON.stringify(request));
		expect(calls.at(-1)?.timeoutMs).toBe(120_000);
	});

	it("rejects malformed control replies instead of treating them as permission or receipts", async () => {
		const { proxy, answer, transport } = await setup();
		answer({ allowed: true });
		await expect(proxy.egress.pass(7, "abc123")).rejects.toThrow("Invalid proxy pass response");
		answer({ held: [{ ...request, headers: ["not a pair"] }], reads: [], readBytes: 0 });
		await expect(proxy.egress.take(7, context)).rejects.toThrow("Invalid proxy take response");
		answer(["7"]);
		await expect(proxy.egress.sentChats(context)).rejects.toThrow("Invalid proxy sent response");
		answer({ status: "201", body: "" });
		await expect(proxy.egress.replay(request, context)).rejects.toThrow("Invalid proxy replay response");
		answer({ up: "yes" });
		await expect(proxyReady(transport)).rejects.toThrow("Invalid proxy ping response");
	});

	it("preserves an uncertain send outcome and rejects a malformed reached flag", async () => {
		const { proxy, answer } = await setup();
		answer({ failed: "connection interrupted", reached: true });
		expect(await proxy.egress.replay(request, context)).toEqual({ failed: "connection interrupted", reached: true });
		answer({ failed: "connection interrupted", reached: "no" });
		await expect(proxy.egress.replay(request, context)).rejects.toThrow("Invalid proxy replay response");
	});

	it("stops the proxy when its config is malformed or stale", async () => {
		const { proxy, answer, halted } = await setup();
		answer({ stale: Date.now() + 60_000 });
		expect(await proxy.egress.configure()).toBe("stopped");
		answer({ stale: "newer" });
		expect(await proxy.egress.configure()).toBe("stopped");
		expect(halted()).toBe(2);
	});
});
