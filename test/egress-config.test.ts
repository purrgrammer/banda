/**
 * The daemon's config pushes to the egress proxy (src/box/egress-config.ts): in order, each read from the store at
 * its turn, with a generation the proxy (proxy/ctl.py `configure`) never goes back from; a push that cannot be told
 * stops the proxy, and one that can do neither throws.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configPusher } from "../src/box/egress-config.ts";

type Config = { permitted: string[] };

/** A proxy in memory, as ctl.py takes a config: refused when its generation is lower than the one held. */
function fakeProxy() {
	const proxy = {
		held: { config: { permitted: [] } as Config, generation: 0 },
		sent: [] as { config: Config; generation: number }[],
		running: true,
		halted: 0,
		fail: false,
		failHalt: false,
	};
	return proxy;
}

const later = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

describe("config pushes", () => {
	it("a push read before a revoke cannot restore the revoked host: pushes go in order, each read at its turn", async () => {
		const proxy = fakeProxy();
		// the store: a host allowed, then taken back while the first push is still on its way
		let store: Config = { permitted: ["github.com"] };
		const firstSent = later();
		let sends = 0;
		const push = configPusher<Config>({
			running: async () => proxy.running,
			read: async () => ({ permitted: [...store.permitted] }),
			send: async (config, generation) => {
				sends += 1;
				// the first push (a tab's) is slow on the wire: it lands after the revoke's would have
				if (sends === 1) await firstSent.promise;
				if (generation < proxy.held.generation) throw new Error("stale");
				proxy.held = { config, generation };
				proxy.sent.push({ config, generation });
			},
			halt: async () => {
				proxy.halted += 1;
			},
		});
		const tab = push();
		await new Promise((r) => setTimeout(r, 5));
		store = { permitted: [] };
		const revoke = push();
		firstSent.resolve();
		await Promise.all([tab, revoke]);
		// the revoke's push went after the tab's, and read the store as it was then
		expect(proxy.sent.map((one) => one.config.permitted)).toEqual([["github.com"], []]);
		expect(proxy.held.config.permitted).toEqual([]);
		expect(proxy.sent[1]!.generation).toBeGreaterThan(proxy.sent[0]!.generation);
		expect(proxy.halted).toBe(0);
	});

	it("generations go on from the clock, so a later daemon's exceed an earlier one's", async () => {
		const seen: number[] = [];
		const target = {
			running: async () => true,
			read: async () => ({ permitted: [] }),
			send: async (_config: Config, generation: number) => {
				seen.push(generation);
			},
			halt: async () => {},
		};
		const first = configPusher<Config>(target, () => 1000);
		await first();
		await first();
		const second = configPusher<Config>(target, () => 5000);
		await second();
		expect(seen).toEqual([1000, 1001, 5000]);
	});

	it("a proxy that is not running is not pushed to; one that cannot be told is stopped; neither throws", async () => {
		const proxy = fakeProxy();
		const push = configPusher<Config>({
			running: async () => proxy.running,
			read: async () => ({ permitted: [] }),
			send: async () => {
				if (proxy.fail) throw new Error("docker exec: it did not answer in time");
			},
			halt: async () => {
				if (proxy.failHalt) throw new Error("docker kill: no server");
				proxy.halted += 1;
			},
		});
		proxy.running = false;
		expect(await push()).toBe("not running");
		proxy.running = true;
		expect(await push()).toBe("told");
		proxy.fail = true;
		expect(await push()).toBe("stopped");
		expect(proxy.halted).toBe(1);
		proxy.failHalt = true;
		await expect(push()).rejects.toThrow(/neither told .* nor stopped/);
		// and a push after one that threw still goes
		proxy.fail = false;
		expect(await push()).toBe("told");
	});
});

describe("what only the proxy knows", () => {
	it("outlives its tmpfs: what a chat held and read here is still there once the proxy was killed", () => {
		const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
		const state = mkdtempSync(join(tmpdir(), "banda-proxy-kept-"));
		try {
			const script = [
				"import json, os, shutil, sys, types",
				"sys.modules['certifi'] = types.SimpleNamespace(where=lambda: '')",
				`sys.path.insert(0, ${JSON.stringify(dir)})`,
				"import ctl, state",
				"state.read(7, 'example.com')",
				"ticket = state.hold(7, {'method': 'POST'})",
				// a kill: the tmpfs and everything in it gone
				"shutil.rmtree(os.environ['BANDA_STATE'])",
				"taken = ctl.take('7')",
				"held = [h['ticket'] for h in taken['held']] == [ticket]",
				"print(json.dumps([taken['reads'], held]))",
			].join("\n");
			const out = execFileSync("python3", ["-I", "-B", "-c", script], {
				encoding: "utf8",
				env: { ...process.env, BANDA_STATE: join(state, "tmpfs"), BANDA_KEPT: join(state, "volume") },
			});
			expect(JSON.parse(out)).toEqual([["example.com"], true]);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("lets a write the browser let go pass once, its chat's alone, and never once its pass is a minute old", () => {
		const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
		const state = mkdtempSync(join(tmpdir(), "banda-proxy-pass-"));
		try {
			const script = [
				"import json, sys, time",
				`sys.path.insert(0, ${JSON.stringify(dir)})`,
				"import state",
				"out = []",
				"state.allow(7, 'h1')",
				"out += [state.passes(8, 'h1'), state.passes(7, 'h1'), state.passes(7, 'h1')]",
				"state.allow(7, 'h2')",
				"now = time.time()",
				// the browser never sent it; a minute and a second later the same bytes find no pass
				"time.time = lambda: now + 61",
				"out += [state.passes(7, 'h2')]",
				"state.allow(7, 'h3')",
				"time.time = lambda: now + 61 + 59",
				"out += [state.passes(7, 'h3')]",
				"print(json.dumps(out))",
			].join("\n");
			const out = execFileSync("python3", ["-I", "-B", "-c", script], {
				encoding: "utf8",
				env: { ...process.env, BANDA_STATE: join(state, "tmpfs"), BANDA_KEPT: join(state, "volume") },
			});
			// another chat's try uses up nothing it may not have; the pass goes once; an old one never
			expect(JSON.parse(out)).toEqual([false, true, false, false, true]);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("reads a config written again within one tick of the clock as the new one", () => {
		const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
		const state = mkdtempSync(join(tmpdir(), "banda-proxy-tick-"));
		try {
			const script = [
				"import json, os, sys",
				`sys.path.insert(0, ${JSON.stringify(dir)})`,
				"import state",
				"target = state.path('config.json')",
				"state.write_json(target, {'permitted': {'7': ['github.com']}})",
				"first = state.config()['permitted']",
				"stamp = os.stat(target).st_mtime_ns",
				"state.write_json(target, {'permitted': {}})",
				// the same time to the nanosecond: a coarse clock, or two writes in one tick
				"os.utime(target, ns=(stamp, stamp))",
				"print(json.dumps([first, state.config()['permitted']]))",
			].join("\n");
			const out = execFileSync("python3", ["-I", "-B", "-c", script], {
				encoding: "utf8",
				env: { ...process.env, BANDA_STATE: state },
			});
			expect(JSON.parse(out)).toEqual([{ "7": ["github.com"] }, {}]);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("the proxy's receipts", () => {
	it("discover held and sent chats together, leaving reads and unacknowledged ids intact", () => {
		const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
		const state = mkdtempSync(join(tmpdir(), "banda-proxy-sent-"));
		try {
			const script = [
				"import json, os, sys, types",
				"sys.modules['certifi'] = types.SimpleNamespace(where=lambda: '')",
				`sys.path.insert(0, ${JSON.stringify(dir)})`,
				"import ctl, state",
				"a = state.sent(7, {'method': 'POST'})",
				"b = state.sent(9, {'method': 'PUT'})",
				"h = state.hold(7, {'chat': 7, 'method': 'POST'})",
				"k = state.hold(11, {'chat': 11, 'method': 'POST'})",
				"state.read(13, 'example.com')",
				"state.outcome(7, a, {'status': 200})",
				"state.outcome(7, a, {'failed': 'late'})",
				"out = [ctl.receipt_chats(), [r.get('status') for r in ctl.take('7')['sent']]]",
				"ctl.ack('7', 0, [a, '../9/' + b])",
				"out += [ctl.receipt_chats(), sorted(os.listdir(os.path.join(os.environ['BANDA_KEPT'], 'sent')))]",
				"ctl.ack('7', 0, [h])",
				"ctl.ack('11', 0, [k])",
				"out += [ctl.receipt_chats(), ctl.take('13')['reads']]",
				"print(json.dumps(out))",
			].join("\n");
			const out = execFileSync("python3", ["-I", "-B", "-c", script], {
				encoding: "utf8",
				env: { ...process.env, BANDA_STATE: join(state, "tmpfs"), BANDA_KEPT: join(state, "volume") },
			});
			// the first outcome stands; an id with a path in it forgets nothing
			expect(JSON.parse(out)).toEqual([[7, 9, 11], [200], [7, 9, 11], ["7", "9"], [9], ["example.com"]]);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("the proxy's config", () => {
	it("refuses a config whose generation is lower than the one it holds, or that has none", () => {
		const dir = fileURLToPath(new URL("../proxy/", import.meta.url));
		const state = mkdtempSync(join(tmpdir(), "banda-proxy-config-"));
		try {
			const script = [
				"import json, sys, types",
				// the proxy's image has certifi, for a replay; the host need not
				"sys.modules['certifi'] = types.SimpleNamespace(where=lambda: '')",
				`sys.path.insert(0, ${JSON.stringify(dir)})`,
				"import ctl, state",
				"out = [ctl.configure(c) for c in json.load(sys.stdin)]",
				"out.append(state.read_json(state.path('config.json'), None))",
				"print(json.dumps(out))",
			].join("\n");
			const out = execFileSync("python3", ["-I", "-B", "-c", script], {
				input: JSON.stringify([
					{ generation: 5, permitted: ["a"] },
					{ generation: 7, permitted: [] },
					{ generation: 6, permitted: ["a"] },
					{ permitted: ["a"] },
					{ generation: 7, permitted: ["b"] },
				]),
				encoding: "utf8",
				env: { ...process.env, BANDA_STATE: state },
			});
			expect(JSON.parse(out)).toEqual([{}, {}, { stale: 7 }, { stale: 7 }, {}, { generation: 7, permitted: ["b"] }]);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});
