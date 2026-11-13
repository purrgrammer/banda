import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBox } from "../src/box/box.ts";
import type { BrowserPreparation } from "../src/box/browser-preparation.ts";
import { microvmBox } from "../src/box/microvm.ts";
import * as assets from "../src/box/microvm-assets.ts";
import { until } from "./helpers.ts";

vi.mock("node:fs/promises", async (original) => {
	const files = await original<typeof import("node:fs/promises")>();
	return {
		...files,
		access: (path: Parameters<typeof files.access>[0], mode?: number) =>
			path === "/dev/kvm" ? Promise.resolve() : files.access(path, mode),
	};
});

const roots: string[] = [];
const caches: string[] = [];
const bytes = "the verified browser archive";
const sha = createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const path of [...roots.splice(0), ...caches.splice(0)]) await rm(path, { recursive: true, force: true });
});

async function fixture(success = false) {
	const home = await realpath(await mkdtemp(join(tmpdir(), "banda-browser-preparation-")));
	roots.push(home);
	const bundle = join(home, "bundle");
	await mkdir(bundle);
	const file = join(bundle, "image.tar");
	await writeFile(file, "fixture");
	const msb = join(bundle, "runtime.mjs");
	if (success) {
		await mkdir(join(home, "computer"));
		await writeFile(
			msb,
			`#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
const args = process.argv.slice(2);
const path = (name) => join(process.env.MSB_HOME, name + ".json");
if (args[0] === "image") {
  const digest = args[2] === "box" ? "base" : args[2];
  process.stdout.write(JSON.stringify({ digest: "manifest", config: { digest }, architecture: "arm64", os: "linux" }));
} else if (args[0] === "list") {
  process.stdout.write("[]");
} else if (args[0] === "create") {
  const name = args[args.indexOf("--name") + 1];
  const gate = join(process.env.MSB_HOME, "create-gate.sock");
  if (!name.endsWith("-proxy") && !name.endsWith("-browser") && existsSync(gate)) {
    const socket = createConnection(gate);
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write("creating"));
      socket.once("end", resolve);
    });
    socket.destroy();
  }
  const labels = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label") { const [key, value] = args[++i].split("="); labels[key] = value; }
  }
  writeFileSync(path(name), JSON.stringify({ name, status: "Running", config: { labels, manifest_digest: "manifest", network: { ports: [] } } }));
  if (name.endsWith("-browser")) appendFileSync(join(process.env.MSB_HOME, "browser-launches"), "launched\\n");
} else if (args[0] === "stop" || args[0] === "start") {
  const vm = JSON.parse(readFileSync(path(args[1]), "utf8"));
  vm.status = args[0] === "start" ? "Running" : "Stopped";
  writeFileSync(path(args[1]), JSON.stringify(vm));
  if (args[0] === "start" && args[1].endsWith("-browser")) appendFileSync(join(process.env.MSB_HOME, "browser-launches"), "launched\\n");
} else if (args[0] === "inspect") {
  try { process.stdout.write(readFileSync(path(args[1]), "utf8")); }
  catch { process.stderr.write("sandbox not found: " + args[1]); process.exitCode = 1; }
} else if (args[0] === "remove") {
  rmSync(path(args.at(-1)), { force: true });
} else if (args[0] === "exec") {
  const name = args[args.indexOf("--") - 1];
  const vm = JSON.parse(readFileSync(path(name), "utf8"));
  const temporary = vm.status !== "Running";
  if (temporary && (args.includes("--require-running") || args.includes("--detach"))) {
    process.stderr.write("sandbox is not running");
    process.exit(1);
  }
  if (temporary) {
    vm.status = "Running";
    writeFileSync(path(name), JSON.stringify(vm));
    appendFileSync(join(process.env.MSB_HOME, "implicit-starts"), name + "\\n");
    process.once("exit", () => {
      vm.status = "Stopped";
      writeFileSync(path(name), JSON.stringify(vm));
    });
  }
  if (args.includes("/banda/ctl.py")) {
    process.stdout.write(args.at(-1) === "ping" ? JSON.stringify({ up: true }) : "{}");
  }
  if (args.includes("/banda/connect.py")) process.stdin.pipe(process.stdout);
}
`,
			{ mode: 0o700 },
		);
	}
	vi.spyOn(assets, "installedMicrovmAssets").mockResolvedValue({
		target: "darwin-arm64",
		root: bundle,
		msb: success ? msb : "/usr/bin/false",
		firmware: file,
		box: { archive: file, ref: "box", digest: "base" },
		proxy: { archive: file, ref: "proxy", digest: "proxy" },
		browser: {
			sha256: sha,
			bytes: bytes.length,
			ref: "browser",
			digest: "browser",
			url: `https://github.com/purrgrammer/banda/releases/download/v0.1.0-test/banda-browser-${sha}.tar`,
		},
	});
	const cache = join(
		process.platform === "darwin" ? "/private/tmp" : "/tmp",
		`banda-msb-${process.getuid?.() ?? 0}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`,
	);
	caches.push(cache);
	const setup = microvmBox(home);
	if (setup.browser === undefined || setup.egress === undefined) throw new Error("Missing native capability");
	const browser = setup.browser;
	const egress = setup.egress;
	const states: BrowserPreparation[] = [];
	browser.watch(() => states.push(browser.state()));
	const proxy = async () => {
		const file = (await readdir(cache)).find((entry) => entry.endsWith("-proxy.json"));
		if (file === undefined) throw new Error("Missing fixture proxy");
		return file.slice(0, -5);
	};
	return {
		setup,
		browser,
		states,
		egress,
		ensure: setup.ensure,
		stopProxy: async () => promisify(execFile)(msb, ["stop", await proxy()], { env: { MSB_HOME: cache } }),
		proxyState: async () => readFile(join(cache, `${await proxy()}.json`), "utf8"),
		browserLaunches: () => readFile(join(cache, "browser-launches"), "utf8"),
		implicitStarts: () => readFile(join(cache, "implicit-starts"), "utf8").catch(() => ""),
		vmNames: async () => (await readdir(cache)).filter((entry) => /^banda-microvm-.*\.json$/.test(entry)),
		pauseBoxCreate: async () => {
			await mkdir(cache, { recursive: true, mode: 0o700 });
			const sockets = new Set<Socket>();
			let created = () => {};
			const creating = new Promise<void>((resolve) => {
				created = resolve;
			});
			const server = createServer((socket) => {
				sockets.add(socket);
				socket.once("data", created);
				socket.once("close", () => sockets.delete(socket));
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(join(cache, "create-gate.sock"), resolve);
			});
			return {
				creating,
				release: () => {
					for (const socket of sockets) socket.end();
				},
				close: async () => {
					for (const socket of sockets) socket.destroy();
					await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
				},
			};
		},
		forwardPath: async () => {
			const path = (await readdir(cache)).find((entry) => entry.endsWith("-box.sock"));
			if (path === undefined) throw new Error("Missing fixture forwarding socket");
			return join(cache, path);
		},
		close: async () => setup.close?.().catch(() => undefined),
	};
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
	"native shared browser preparation without a VM",
	() => {
		it("public close cancels readiness waiting for policy without releasing its source", async () => {
			const { setup, egress, vmNames, close } = await fixture(true);
			const box = openBox(setup, () => {});
			let started = () => {};
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reads = 0;
			egress.source(async () => {
				reads++;
				started();
				await pending;
				return { credentials: [] };
			});
			const starting = Promise.allSettled([box.ensure()]);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let closing: Promise<void> | undefined;
			try {
				await reading;
				const queued = Promise.allSettled([egress.configure()]);
				closing = box.close();
				expect(
					await Promise.race([
						closing.then(() => "closed"),
						new Promise<string>((resolve) => {
							timer = setTimeout(() => resolve("blocked"), 3_000);
						}),
					]),
				).toBe("closed");
				expect((await starting)[0]?.status).toBe("rejected");
				expect(await queued).toEqual([
					{ status: "rejected", reason: expect.objectContaining({ message: "This computer is closed." }) },
				]);
				expect(reads).toBe(1);
				expect(await vmNames()).toEqual([]);
				release();
				await expect(box.ensure()).rejects.toThrow("The computer is closed");
				await expect(egress.configure()).rejects.toThrow("This computer is closed");
				expect(await vmNames()).toEqual([]);
			} finally {
				clearTimeout(timer);
				release();
				await starting;
				await closing;
				await box.close();
				await close();
			}
		});
		it("close cancels and drains base VM creation after proxy readiness", async () => {
			const { ensure, pauseBoxCreate, vmNames, close } = await fixture(true);
			const barrier = await pauseBoxCreate();
			let settled = false;
			const starting = ensure().then(
				() => {
					settled = true;
					return "started";
				},
				() => {
					settled = true;
					return "cancelled";
				},
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await barrier.creating;
				expect(
					await Promise.race([
						close().then(() => "closed"),
						new Promise<string>((resolve) => {
							timer = setTimeout(() => resolve("blocked"), 3_000);
						}),
					]),
				).toBe("closed");
				expect(settled).toBe(true);
				expect(await starting).toBe("cancelled");
				expect(await vmNames()).toEqual([]);
				barrier.release();
				expect(await vmNames()).toEqual([]);
			} finally {
				clearTimeout(timer);
				barrier.release();
				await starting;
				await close();
				await barrier.close();
			}
		});
		it("fails closed without starting a proxy lost between configuration admission and execution", async () => {
			const { egress, ensure, stopProxy, proxyState, implicitStarts, close } = await fixture(true);
			try {
				await ensure();
				let interrupt = true;
				egress.source(async () => {
					if (interrupt) {
						interrupt = false;
						await stopProxy();
					}
					return { credentials: [] };
				});
				expect(await egress.configure()).toBe("stopped");
				expect(await proxyState()).toContain('"status":"Stopped"');
				expect(await implicitStarts()).toBe("");
				await ensure();
				expect(await proxyState()).toContain('"status":"Running"');
				expect(await implicitStarts()).toBe("");
			} finally {
				await close();
			}
		});
		it("a forwarding connection to a lost proxy cannot start it or pass bytes", async () => {
			const { ensure, stopProxy, proxyState, implicitStarts, forwardPath, close } = await fixture(true);
			try {
				await ensure();
				await stopProxy();
				const received: string[] = [];
				const socket = createConnection(await forwardPath());
				await new Promise<void>((resolve, reject) => {
					socket.once("close", () => resolve());
					socket.once("error", reject);
					socket.once("data", (data) => {
						received.push(data.toString());
						socket.destroy();
					});
					socket.write("must not cross");
				});
				expect(received).toEqual([]);
				expect(await implicitStarts()).toBe("");
				expect(await proxyState()).toContain('"status":"Stopped"');
			} finally {
				await close();
			}
		});
		it("an active forwarding stream does not block a current policy push", async () => {
			const { ensure, egress, forwardPath, proxyState, close } = await fixture(true);
			try {
				await ensure();
				const socket = createConnection(await forwardPath());
				try {
					const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
					const echoed = new Promise<string>((resolve, reject) => {
						socket.once("data", (data) => resolve(data.toString()));
						socket.once("error", reject);
					});
					socket.write("connected");
					expect(await echoed).toBe("connected");
					expect(await egress.configure()).toBe("told");
					expect(await proxyState()).toContain('"status":"Running"');
					await close();
					await closed;
				} finally {
					socket.destroy();
				}
			} finally {
				await close();
			}
		});
		it("close cancels an unfinished policy read and drains its fail-closed stop", async () => {
			const { ensure, egress, close } = await fixture(true);
			let started = () => {};
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				await ensure();
				egress.source(async () => {
					started();
					await pending;
					return { credentials: [] };
				});
				const configured = egress.configure();
				await reading;
				const queued = expect(egress.configure()).rejects.toThrow("This computer is closed");
				await close();
				expect(await configured).toBe("stopped");
				await queued;
				await expect(ensure()).rejects.toThrow("This computer is closed");
				await expect(egress.configure()).rejects.toThrow("This computer is closed");
			} finally {
				release();
				await close();
			}
		});
		it("keeps a prepared browser available when the base runtime repairs its proxy", async () => {
			const { browser, states, ensure, stopProxy, proxyState, browserLaunches, close } = await fixture(true);
			const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
			vi.stubGlobal("fetch", fetcher);
			try {
				await ensure();
				await browser.prepare();
				expect(browser.state()).toEqual({ state: "ready" });
				expect(await browserLaunches()).toBe("launched\n");
				states.length = 0;
				await stopProxy();
				expect(await proxyState()).toContain('"status":"Stopped"');
				await ensure();
				expect(await proxyState()).toContain('"status":"Running"');
				expect(browser.state()).toEqual({ state: "ready" });
				expect(states).toEqual([]);
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(await browserLaunches()).toBe("launched\n");
			} finally {
				await close();
			}
		});
		it("keeps readiness after the job settles, reuses verified bytes, and releases watchers", async () => {
			const { browser, close } = await fixture(true);
			const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes));
			vi.stubGlobal("fetch", fetcher);
			let changed = 0;
			const unwatch = browser.watch(() => changed++);
			try {
				await browser.prepare();
				expect(browser.state()).toEqual({ state: "ready" });
				const before = changed;
				unwatch();
				expect((await browser.forAgent("mara").command()).at(-1)).toBe("mara");
				expect(browser.state()).toEqual({ state: "ready" });
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(changed).toBe(before);
				await close();
				expect(browser.state()).toEqual({ state: "idle" });
			} finally {
				await close();
			}
		});
		it("stays lazy and retains a classified 404 before any bytes arrive", async () => {
			const { browser, states, close } = await fixture();
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
			vi.stubGlobal("fetch", fetcher);
			try {
				expect(browser.state()).toEqual({ state: "idle" });
				expect(fetcher).not.toHaveBeenCalled();
				await expect(browser.prepare()).rejects.toThrow("HTTP 404");
				expect(states).toEqual([
					{ state: "preparing", phase: "checking" },
					{ state: "failed", problem: "download-unavailable" },
				]);
				expect(browser.state()).toEqual({ state: "failed", problem: "download-unavailable" });
			} finally {
				await close();
			}
		});
		it("coalesces owner and agent work, reports real byte progress, and retries after integrity failure", async () => {
			const { browser, states, close } = await fixture();
			let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
			const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
						},
					}),
				),
			);
			vi.stubGlobal("fetch", fetcher);
			try {
				const owner = browser.prepare();
				const agent = browser.forAgent("mara").command();
				const rejected = Promise.all([
					expect(owner).rejects.toThrow("SHA-256"),
					expect(agent).rejects.toThrow("SHA-256"),
				]);
				await until(() => browser.state().state === "preparing" && fetcher.mock.calls.length === 1);
				stream?.enqueue(new TextEncoder().encode("x".repeat(3)));
				await until(() =>
					states.some((state) => state.state === "preparing" && state.phase === "downloading" && state.received === 3),
				);
				stream?.enqueue(new TextEncoder().encode("x".repeat(bytes.length - 3)));
				stream?.close();
				await rejected;
				expect(fetcher).toHaveBeenCalledTimes(1);
				expect(browser.state()).toEqual({ state: "failed", problem: "integrity" });
				fetcher.mockResolvedValue(new Response(bytes));
				await expect(browser.prepare()).rejects.toThrow("computer could not image");
				expect(fetcher).toHaveBeenCalledTimes(2);
				expect(states).toContainEqual({ state: "preparing", phase: "starting" });
				expect(browser.state()).toEqual({ state: "failed", problem: "startup" });
			} finally {
				await close();
			}
		});
		it("cancels owned preparation on close without later readiness or failure publication", async () => {
			const { browser, states, close } = await fixture();
			let cancelled = false;
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>().mockResolvedValue(
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(bytes.slice(0, 3)));
							},
							cancel() {
								cancelled = true;
							},
						}),
					),
				),
			);
			const preparing = browser.prepare();
			const rejected = expect(preparing).rejects.toThrow();
			await until(() =>
				states.some((state) => state.state === "preparing" && state.phase === "downloading" && state.received === 3),
			);
			await close();
			await rejected;
			expect(cancelled).toBe(true);
			expect(browser.state()).toEqual({ state: "idle" });
			expect(states.some((state) => state.state === "ready" || state.state === "failed")).toBe(false);
		});
	},
);
