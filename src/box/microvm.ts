import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { BoxSetup } from "./box.ts";
import type { BrowserPreparation } from "./browser-preparation.ts";
import { BROWSER_UID, browserStart } from "./browser-start.ts";
import { guardedProxy, type ProxyTransport, proxyReady, TRUST, TRUST_ENV } from "./guarded-proxy.ts";
import { installedMicrovmAssets, type MicrovmAssets, microvmTarget } from "./microvm-assets.ts";
import { BrowserDownloadError, downloadMicrovmBrowser } from "./microvm-download.ts";

const CacheHome = Type.Object({ home: Type.String() }, { additionalProperties: false });
const Inspection = Type.Object({
	name: Type.String(),
	status: Type.String(),
	config: Type.Object({
		labels: Type.Record(Type.String(), Type.String()),
		manifest_digest: Type.String(),
		network: Type.Object({ ports: Type.Array(Type.Unknown()) }),
	}),
});
type Inspection = Static<typeof Inspection>;
const Listing = Type.Array(Type.Object({ name: Type.String(), status: Type.String() }));
const Image = Type.Object({
	digest: Type.String(),
	config: Type.Object({ digest: Type.String() }),
	architecture: Type.Union([Type.Literal("arm64"), Type.Literal("amd64")]),
	os: Type.Literal("linux"),
});
const VM_NAME = /^banda-microvm-[a-f0-9]{10}-([a-f0-9]{12})(?:-(?:proxy|browser))?$/;
const uid = process.getuid?.() ?? 0;
const cachePrefix = `banda-msb-${uid}-`;
const endpoint = "127.0.0.1:80";
const cacheRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const cachePath = (home: string) =>
	join(cacheRoot, `${cachePrefix}${createHash("sha256").update(home).digest("hex").slice(0, 16)}`);

function parse<T extends TSchema>(schema: T, text: string): Static<T> {
	const value: unknown = JSON.parse(text);
	if (!Value.Check(schema, value)) throw new Error("The computer runtime returned an invalid response.");
	return value;
}

async function directory(path: string, mode = 0o700): Promise<void> {
	await mkdir(path, { mode }).catch((error: unknown) => {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	});
	const entry = await lstat(path);
	if (!entry.isDirectory() || entry.uid !== uid)
		throw new Error(`The computer directory must be your own directory, not a link: ${path}`);
	await chmod(path, mode);
}

async function canonicalHome(home: string): Promise<string> {
	const canonical = await realpath(resolve(home));
	if (/[,:\\\0\r\n]/.test(canonical))
		throw new Error("The computer's home path cannot contain a comma, colon or backslash.");
	return canonical;
}

function owned(vm: Inspection, home: string, generation?: string): void {
	if (
		!VM_NAME.test(vm.name) ||
		vm.config.labels["banda.home"] !== home ||
		vm.config.labels["banda.runtime"] !== "microvm" ||
		(generation !== undefined && vm.config.labels["banda.generation"] !== generation)
	)
		throw new Error("Refusing a computer that belongs to another home or daemon.");
}

type LifecycleCommand = readonly [
	"image" | "load" | "inspect" | "list" | "create" | "start" | "stop" | "remove",
	...string[],
];
type GuestCommand = {
	readonly name: string;
	readonly user: string;
	readonly argv: readonly [string, ...string[]];
};

function execution(command: GuestCommand, mode: "stream" | "detach"): string[] {
	return ["exec", "--require-running", `--${mode}`, "--user", command.user, command.name, "--", ...command.argv];
}

function runtime(assets: MicrovmAssets, home: string) {
	const cache = cachePath(home);
	const env = {
		PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: homedir(),
		LANG: "C.UTF-8",
		MSB_HOME: cache,
		MSB_PATH: assets.msb,
		MSB_LIBKRUNFW_PATH: assets.firmware,
	};
	const execute = (
		args: readonly string[],
		input?: string,
		timeoutMs = 60_000,
		signal?: AbortSignal,
	): Promise<string> =>
		new Promise((yes, no) => {
			const child = execFile(
				assets.msb,
				[...args],
				{ cwd: assets.root, env, timeout: timeoutMs, killSignal: "SIGKILL", signal, maxBuffer: 16 << 20 },
				(error, stdout, stderr) => {
					if (error === null) return yes(stdout.trim());
					const detail = (stderr.trim() || error.message).slice(-4000);
					no(new Error(`The computer could not ${args[0]}: ${detail}`));
				},
			);
			child.stdin?.on("error", () => {});
			child.stdin?.end(input);
		});
	const run = (args: LifecycleCommand, input?: string, timeoutMs?: number, signal?: AbortSignal) =>
		execute(args, input, timeoutMs, signal);
	const exec = (command: GuestCommand, input?: string, timeoutMs?: number, signal?: AbortSignal) =>
		execute(execution(command, "stream"), input, timeoutMs, signal);
	const detach = (command: GuestCommand, signal?: AbortSignal) =>
		execute(execution(command, "detach"), undefined, undefined, signal);
	const stream = (command: GuestCommand) =>
		spawn(assets.msb, execution(command, "stream"), { cwd: assets.root, env, stdio: ["pipe", "pipe", "pipe"] });
	const inspect = async (name: string, signal?: AbortSignal): Promise<Inspection | undefined> => {
		if (!VM_NAME.test(name)) throw new Error("Invalid computer identifier.");
		try {
			return parse(Inspection, await run(["inspect", name, "--format", "json"], undefined, undefined, signal));
		} catch (error) {
			if (error instanceof Error && error.message.includes(`sandbox not found: ${name}`)) return undefined;
			throw error;
		}
	};
	const remove = async (name: string) => {
		const vm = await inspect(name);
		if (vm === undefined) return;
		owned(vm, home);
		await run(["remove", "--force", name], undefined, 30_000);
	};
	return { assets, home, cache, run, exec, detach, stream, inspect, remove };
}
type Runtime = ReturnType<typeof runtime>;

async function openRuntime(home: string): Promise<Runtime> {
	const assets = await installedMicrovmAssets();
	if (process.platform === "linux") {
		await access("/dev/kvm", constants.R_OK | constants.W_OK).catch(() => {
			throw new Error(
				"The computer needs access to /dev/kvm. Enable hardware virtualization and give your account access to KVM, then reopen banda.",
			);
		});
	}
	const storage = join(home, "computer");
	for (const path of [assets.root, assets.msb, assets.firmware, assets.box.archive, assets.proxy.archive]) {
		const below = relative(storage, await realpath(path));
		if (below === "" || (below !== ".." && !below.startsWith("../") && !isAbsolute(below)))
			throw new Error("The computer's runtime bundle must stay outside its writable files.");
	}
	const computer = runtime(assets, home);
	await directory(computer.cache);
	const path = join(computer.cache, "home.json");
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
	await writeFile(temporary, JSON.stringify({ home }), { mode: 0o600, flag: "wx" });
	await rename(temporary, path);
	return computer;
}

async function image(computer: Runtime, asset: MicrovmAssets["box"], building: () => void, signal: AbortSignal) {
	signal.throwIfAborted();
	let present = await computer.run(["image", "inspect", asset.ref, "--format", "json"]).then(
		(text) => parse(Image, text),
		(error: unknown) => {
			if (error instanceof Error && /image.*not found|not found.*image|image.*does not exist/i.test(error.message))
				return undefined;
			throw error;
		},
	);
	if (present === undefined) {
		building();
		await computer.run(["load", "--input", asset.archive, "--tag", asset.ref], undefined, 300_000, signal);
		present = parse(Image, await computer.run(["image", "inspect", asset.ref, "--format", "json"]));
	}
	if (present.config.digest !== asset.digest) throw new Error("The computer image differs from its verified bundle.");
	if (present.architecture !== (computer.assets.target === "linux-x64" ? "amd64" : "arm64"))
		throw new Error("The computer image was built for a different CPU.");
	return present.digest;
}

async function exportsFor(home: string): Promise<string> {
	const storage = join(home, "computer");
	await directory(storage);
	for (const name of ["workspace", "work", "tools", "proxy"]) await directory(join(storage, name));
	for (const name of ["ca", "kept"]) await directory(join(storage, "proxy", name));
	await directory(join(storage, "proxy", "trust"), 0o755);
	return storage;
}

function forwarding(
	computer: Runtime,
	proxy: string,
	generation: string,
	role: "box" | "browser",
	signal: AbortSignal,
) {
	const path = join(computer.cache, `p-${generation}-${role}.sock`);
	const sockets = new Set<Socket>();
	const children = new Set<ChildProcessWithoutNullStreams>();
	let server: Server | undefined;
	const close = async () => {
		const current = server;
		server = undefined;
		const exiting = [...children].map(
			(child) =>
				new Promise<void>((done) => {
					child.once("close", () => done());
					child.kill("SIGKILL");
				}),
		);
		for (const socket of sockets) socket.destroy();
		if (current !== undefined) await new Promise<void>((done) => current.close(() => done()));
		await Promise.all(exiting);
		await rm(path, { force: true });
	};
	const ensure = async () => {
		signal.throwIfAborted();
		if (server?.listening) return;
		await close();
		signal.throwIfAborted();
		server = createServer((socket) => {
			if (signal.aborted || sockets.size >= 128) {
				socket.destroy();
				return;
			}
			sockets.add(socket);
			const child = computer.stream({
				name: proxy,
				user: "1000:1000",
				argv: ["/usr/local/bin/python3", "/banda/connect.py"],
			});
			children.add(child);
			child.stderr.resume();
			child.stdin.on("error", () => socket.destroy());
			child.once("error", () => socket.destroy());
			child.once("close", () => {
				children.delete(child);
				socket.destroy();
			});
			socket.on("error", () => child.kill("SIGKILL"));
			socket.once("close", () => {
				sockets.delete(socket);
				child.kill("SIGKILL");
			});
			socket.pipe(child.stdin);
			child.stdout.pipe(socket);
		});
		const current = server;
		await new Promise<void>((done, reject) => {
			current.once("error", reject);
			current.listen(path, () => {
				current.off("error", reject);
				current.on("error", () => {
					for (const socket of sockets) socket.destroy();
				});
				done();
			});
		});
		await chmod(path, 0o600);
	};
	return { ensure, close, path };
}

/** The command VM starts alone; the isolated browser VM is prepared on its first use. */
export function microvmBox(input: string): BoxSetup {
	const homeArg = resolve(input);
	const generation = randomBytes(6).toString("hex");
	const name = `banda-microvm-${createHash("sha256").update(homeArg).digest("hex").slice(0, 10)}-${generation}`;
	const names = { box: name, proxy: `${name}-proxy`, browser: `${name}-browser` };
	const launcher = fileURLToPath(
		new URL(import.meta.url.endsWith(".ts") ? "./microvm-launch.ts" : "./microvm-launch.js", import.meta.url),
	);
	let loading: Promise<Runtime> | undefined;
	let computer: Runtime | undefined;
	const bridges = new Map<"box" | "browser", ReturnType<typeof forwarding>>();
	let browserBringing: Promise<void> | undefined;
	let browserState: BrowserPreparation = { state: "idle" };
	const browserListeners = new Set<() => void>();
	const browserSet = (next: BrowserPreparation) => {
		const previous = browserState;
		browserState = next;
		if (JSON.stringify(previous) === JSON.stringify(next)) return;
		if (
			previous.state === "preparing" &&
			previous.phase === "downloading" &&
			next.state === "preparing" &&
			next.phase === "downloading" &&
			Math.floor((previous.received * 100) / previous.total) === Math.floor((next.received * 100) / next.total)
		)
			return;
		for (const listener of browserListeners) listener();
	};
	let closing: Promise<void> | undefined;
	let closed = false;
	let takenOver = false;
	let takingOver: Promise<void> | undefined;
	const startup = new AbortController();
	const assertOpen = () => {
		if (closed || startup.signal.aborted) throw new Error("This computer is closed.");
	};
	const baseWork = new Set<Promise<void>>();
	let proxyWork: Promise<void> = Promise.resolve();
	const transition = <T>(operation: () => Promise<T>): Promise<T> => {
		assertOpen();
		const next = proxyWork.then(() => {
			assertOpen();
			return operation();
		});
		proxyWork = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const loaded = () =>
		(loading ??= canonicalHome(homeArg)
			.then(openRuntime)
			.then((value) => (computer = value))
			.catch((error: unknown) => {
				loading = undefined;
				throw error;
			}));
	const transport: ProxyTransport = {
		exec: async (args, input, timeout) => {
			const current = await loaded();
			const [program, ...rest] = args;
			if (program === undefined) throw new Error("The computer expects a proxy command.");
			return current.exec(
				{ name: names.proxy, user: "1000:1000", argv: [program, ...rest] },
				input,
				timeout,
				startup.signal,
			);
		},
		running: async () => {
			if (closed) return false;
			const current = await loaded();
			const vm = await current.inspect(names.proxy);
			if (vm === undefined) return false;
			owned(vm, current.home, generation);
			return vm.status === "Running";
		},
		halt: async () => {
			const current = await loaded();
			const vm = await current.inspect(names.proxy);
			if (vm === undefined) return;
			owned(vm, current.home, generation);
			await current.run(["stop", names.proxy], undefined, 30_000);
		},
	};
	const guarded = guardedProxy({ home: homeArg, endpoint, transport });
	const bringUp = async (
		role: keyof typeof names,
		asset: MicrovmAssets["box"],
		manifest: string,
		flags: readonly string[],
	) => {
		assertOpen();
		const current = await loaded();
		assertOpen();
		const vmName = names[role];
		const existing = await current.inspect(vmName, startup.signal);
		assertOpen();
		if (existing === undefined) {
			await current.run(
				[
					"create",
					"--name",
					vmName,
					"--label",
					`banda.home=${current.home}`,
					"--label",
					"banda.runtime=microvm",
					"--label",
					`banda.generation=${generation}`,
					...flags,
					"--pull",
					"never",
					asset.ref,
				],
				undefined,
				120_000,
				startup.signal,
			);
		} else {
			owned(existing, current.home, generation);
			if (existing.config.manifest_digest !== manifest) throw new Error("The computer has a different image.");
			if (existing.status !== "Running") await current.run(["start", vmName], undefined, 120_000, startup.signal);
		}
		const running = await current.inspect(vmName, startup.signal);
		if (running === undefined) throw new Error("The computer disappeared while starting.");
		owned(running, current.home, generation);
		if (running.config.network.ports.length !== 0) throw new Error("The computer must not publish host network ports.");
		assertOpen();
	};
	const forward = async (role: "box" | "browser") => {
		assertOpen();
		const current = await loaded();
		assertOpen();
		let bridge = bridges.get(role);
		if (bridge === undefined) {
			bridge = forwarding(current, names.proxy, generation, role, startup.signal);
			bridges.set(role, bridge);
		}
		await bridge.ensure();
		assertOpen();
		return bridge.path;
	};
	const relay = async (role: "box" | "browser") => {
		assertOpen();
		const current = await loaded();
		const check: GuestCommand = {
			name: names[role],
			user: "1000:1000",
			argv: ["/bin/sh", "/banda/proxy-bridge.sh", "--check"],
		};
		try {
			await current.exec(check, undefined, 5_000, startup.signal);
		} catch {
			assertOpen();
			await current.detach(
				{ name: names[role], user: "0:0", argv: ["/bin/sh", "/banda/proxy-bridge.sh"] },
				startup.signal,
			);
			const until = Date.now() + 10_000;
			for (;;) {
				assertOpen();
				try {
					await current.exec(check, undefined, 5_000, startup.signal);
					break;
				} catch (error) {
					if (Date.now() >= until) throw error;
					await new Promise((done) => setTimeout(done, 100));
				}
			}
		}
		assertOpen();
	};
	const confinement = (socket: string, user: number) => [
		"--security",
		"restricted",
		"--user",
		`${user}:${user}`,
		"--workdir",
		"/",
		"--no-net",
		"--vsock",
		`${socket}:23456`,
		...Object.entries(TRUST_ENV).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
	];
	const retirePriorGenerations = () => {
		if (takenOver) return Promise.resolve();
		if (takingOver !== undefined) return takingOver;
		takingOver = (async () => {
			assertOpen();
			const current = await loaded();
			for (const prior of parse(Listing, await current.run(["list", "--format", "json"]))) {
				if (!VM_NAME.test(prior.name) || Object.values(names).includes(prior.name)) continue;
				const vm = await current.inspect(prior.name);
				if (vm === undefined) continue;
				owned(vm, current.home);
				await current.remove(prior.name);
			}
			takenOver = true;
		})().finally(() => {
			takingOver = undefined;
		});
		return takingOver;
	};
	const prepare = async (building: () => void) => {
		assertOpen();
		const current = await loaded();
		assertOpen();
		const storage = await exportsFor(current.home);
		assertOpen();
		await retirePriorGenerations();
		const manifests = {
			box: await image(current, current.assets.box, building, startup.signal),
			proxy: await image(current, current.assets.proxy, building, startup.signal),
		};
		await transition(async () => {
			await bringUp("proxy", current.assets.proxy, manifests.proxy, [
				"--memory",
				"512M",
				"--cpus",
				"1",
				"--user",
				"1000:1000",
				"--net-rule",
				"allow@public,allow@dns",
				"--net-default-ingress",
				"deny",
				...["ca", "trust", "kept"].flatMap((directory) => [
					"--mount-dir",
					`${join(storage, "proxy", directory)}:/${directory}:uid=1000,gid=1000`,
				]),
			]);
			if (!(await proxyReady(transport)))
				await current.detach(
					{ name: names.proxy, user: "1000:1000", argv: ["/usr/local/bin/python3", "/banda/start.py"] },
					startup.signal,
				);
			const deadline = Date.now() + 30_000;
			while (!(await proxyReady(transport))) {
				assertOpen();
				if (Date.now() >= deadline) throw new Error("The computer's network guard did not start.");
				await new Promise((done) => setTimeout(done, 150));
			}
			if ((await guarded.egress.configure()) !== "told")
				throw new Error("The computer's network guard could not be configured.");
		});
		const socket = await forward("box");
		await bringUp("box", current.assets.box, manifests.box, [
			"--memory",
			"4G",
			"--cpus",
			"2",
			...confinement(socket, 1000),
			...["workspace", "work", "tools"].flatMap((directory) => [
				"--mount-dir",
				`${join(storage, directory)}:/${directory}:uid=1000,gid=1000`,
			]),
			"--mount-dir",
			`${join(storage, "proxy", "trust")}:/etc/ssl/certs:ro,uid=1000,gid=1000`,
		]);
		await relay("box");
	};
	const ensure = (building = () => {}, shutdown?: AbortSignal): Promise<void> => {
		const abort = () => startup.abort();
		if (shutdown?.aborted) abort();
		else shutdown?.addEventListener("abort", abort, { once: true });
		const work = prepare(building);
		baseWork.add(work);
		const settled = () => {
			baseWork.delete(work);
			shutdown?.removeEventListener("abort", abort);
		};
		work.then(settled, settled);
		return work;
	};
	const ensureBrowser = () => {
		assertOpen();
		if (browserBringing !== undefined) return browserBringing;
		browserSet({ state: "preparing", phase: "checking" });
		browserBringing = (async () => {
			const current = await loaded();
			assertOpen();
			const asset = await downloadMicrovmBrowser({
				home: current.home,
				browser: current.assets.browser,
				signal: startup.signal,
				progress: (progress) => {
					if (!closed) browserSet({ state: "preparing", phase: "downloading", ...progress });
				},
			});
			assertOpen();
			browserSet({ state: "preparing", phase: "starting" });
			const manifest = await image(current, asset, () => {}, startup.signal);
			assertOpen();
			const storage = join(current.home, "computer");
			await directory(join(storage, "browser"));
			const socket = await forward("browser");
			await bringUp("browser", asset, manifest, [
				"--memory",
				"2G",
				"--cpus",
				"2",
				...confinement(socket, BROWSER_UID),
				"--mount-dir",
				`${join(storage, "browser")}:/browser:uid=${BROWSER_UID},gid=${BROWSER_UID}`,
				"--mount-dir",
				`${join(storage, "proxy", "trust")}:/etc/ssl/certs:ro,uid=1000,gid=1000`,
			]);
			await relay("browser");
			assertOpen();
			browserSet({ state: "ready" });
		})()
			.catch((error: unknown) => {
				if (!closed)
					browserSet({ state: "failed", problem: error instanceof BrowserDownloadError ? error.problem : "startup" });
				throw error;
			})
			.finally(() => {
				browserBringing = undefined;
			});
		return browserBringing;
	};
	return {
		kind: "microvm",
		workspace: "/workspace",
		attachments: "/work/attachments",
		command: [process.execPath, launcher, "env", homeArg, names.box],
		egress: {
			...guarded.egress,
			source: (from) =>
				guarded.egress.source(
					() =>
						new Promise((resolve, reject) => {
							assertOpen();
							const abort = () => reject(new Error("This computer is closed."));
							startup.signal.addEventListener("abort", abort, { once: true });
							Promise.resolve()
								.then(() => {
									assertOpen();
									return from();
								})
								.then(resolve, reject)
								.finally(() => startup.signal.removeEventListener("abort", abort));
						}),
				),
			configure: async () =>
				transition(async () => {
					await retirePriorGenerations();
					return guarded.egress.configure();
				}),
		},
		browser: {
			prepare: ensureBrowser,
			state: () => browserState,
			watch: (listener) => {
				browserListeners.add(listener);
				return () => browserListeners.delete(listener);
			},
			forAgent: (agent) => ({
				...guarded.browser(agent),
				command: async () => {
					if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agent)) throw new Error("Invalid computer browser identifier.");
					await ensureBrowser();
					assertOpen();
					return [process.execPath, launcher, "browser", homeArg, names.browser, agent];
				},
			}),
		},
		ensure,
		close: () =>
			(closing ??= (async () => {
				closed = true;
				browserSet({ state: "idle" });
				startup.abort();
				await Promise.allSettled(baseWork);
				await browserBringing?.catch(() => undefined);
				await loading?.catch(() => undefined);
				await takingOver?.catch(() => undefined);
				await proxyWork;
				if (computer === undefined) return;
				let failure: unknown;
				for (const operation of [
					() => computer?.remove(names.browser),
					() => computer?.remove(names.box),
					...[...bridges.values()].map((bridge) => () => bridge.close()),
					() => computer?.remove(names.proxy),
				]) {
					try {
						await operation();
					} catch (error) {
						failure ??= error;
					}
				}
				if (failure !== undefined) throw failure;
			})()),
	};
}

/** The trusted launch entry, shared by the source and compiled command prefixes. */
export async function launchMicrovm(argv: readonly string[]): Promise<void> {
	const [mode, homeArg, name, ...args] = argv;
	if (homeArg === undefined || name === undefined || !VM_NAME.test(name) || name.endsWith("-proxy"))
		throw new Error("Invalid computer command identifiers.");
	const home = await canonicalHome(homeArg);
	const computer = await openRuntime(home);
	const vm = await computer.inspect(name);
	if (vm === undefined || vm.status !== "Running") throw new Error("The computer is not running.");
	const generation = VM_NAME.exec(name)?.[1];
	if (generation === undefined) throw new Error("Invalid computer generation.");
	owned(vm, home, generation);
	if (vm.config.network.ports.length !== 0) throw new Error("The computer must not publish host network ports.");
	let command: GuestCommand;
	if (mode === "env") {
		if (name.endsWith("-browser")) throw new Error("The browser VM cannot run agent commands.");
		if (args.length !== 3 || args[0] !== "serve" || args[1] !== "--token" || !/^[a-f0-9]{32}$/.test(args[2] ?? ""))
			throw new Error("The computer expects pi-env serve with its connection token.");
		command = { name, user: "1000:1000", argv: ["/usr/local/bin/pi-env", ...args] };
	} else if (mode === "browser") {
		if (!name.endsWith("-browser")) throw new Error("The command VM cannot run the browser.");
		const [agent] = args;
		if (args.length !== 1 || agent === undefined || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agent))
			throw new Error("Invalid computer browser identifier.");
		command = {
			name,
			user: `${BROWSER_UID}:${BROWSER_UID}`,
			argv: ["/bin/sh", "-c", browserStart({ agent, proxy: endpoint, trust: TRUST })],
		};
	} else throw new Error("Unknown computer command.");
	const child = computer.stream(command);
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	process.stdin.pipe(child.stdin);
	child.stdin.on("error", () => {});
	let stopping: NodeJS.Timeout | undefined;
	const end = () => {
		process.stdin.unpipe(child.stdin);
		child.stdin.end();
		stopping ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
		stopping.unref();
	};
	process.stdin.once("end", end);
	process.once("SIGINT", end);
	process.once("SIGTERM", end);
	try {
		await new Promise<void>((done, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				process.exitCode = code ?? 1;
				done();
			});
		});
	} finally {
		clearTimeout(stopping);
		process.stdin.unpipe(child.stdin);
		process.stdin.off("end", end);
		process.off("SIGINT", end);
		process.off("SIGTERM", end);
		process.stdin.destroy();
	}
}

/** Only abandoned caches of this OS user, bound to their exact absent home, are swept. */
export async function sweepMicrovmBoxes(): Promise<void> {
	if (microvmTarget(process) === undefined) return;
	const entries = await readdir(cacheRoot, { withFileTypes: true });
	let assets: MicrovmAssets | undefined;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(cachePrefix)) continue;
		const cache = join(cacheRoot, entry.name);
		try {
			const stat = await lstat(cache);
			if (stat.uid !== uid) continue;
			const { home } = parse(CacheHome, await readFile(join(cache, "home.json"), "utf8"));
			if (!isAbsolute(home) || cachePath(home) !== cache) continue;
			if (
				await lstat(home).then(
					() => true,
					(error: unknown) => {
						if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
						throw error;
					},
				)
			)
				continue;
			assets ??= await installedMicrovmAssets();
			const current = runtime(assets, home);
			const listed = parse(Listing, await current.run(["list", "--format", "json"]));
			if (listed.some((item) => !VM_NAME.test(item.name))) continue;
			for (const item of listed) {
				const vm = await current.inspect(item.name);
				if (vm === undefined) continue;
				owned(vm, home);
			}
			for (const item of listed) {
				await current.remove(item.name);
			}
			await rm(cache, { recursive: true, force: true });
		} catch {
			// A missing bundle or unreadable/foreign cache authorizes no process or byte deletion.
		}
	}
}
