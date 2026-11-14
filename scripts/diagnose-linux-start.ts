import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import {
	deliverCreateResult,
	diagnosticImage,
	diagnosticInspection,
	failedCreateObserver,
	hostDiagnostics,
	ownedCreateInvocation,
} from "./native-diagnostics.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, run: { type: "boolean" } } });
if (!values.run) {
	console.log("CI=true node scripts/diagnose-linux-start.ts --out FRESH_ABSOLUTE_DIRECTORY --run");
} else {
	assert.equal(process.env.CI, "true", "This native startup diagnostic runs in CI only.");
	assert.equal(process.platform, "linux");
	assert.equal(process.arch, "x64");
	assert.ok(values.out && isAbsolute(values.out), "Supply a fresh absolute evidence directory.");
	const root = process.env.BANDA_RELEASE_ROOT ?? join(import.meta.dirname, "../release/banda");
	assert.ok(isAbsolute(root));
	const node = join(root, "node/node");
	if ((await realpath(process.execPath)) !== (await realpath(node))) {
		const child = childProcess.spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
			stdio: "inherit",
		});
		process.exit(child.status ?? 1);
	}
	await mkdir(values.out, { mode: 0o700 });
	const output = values.out;
	const tracer = "/usr/bin/strace";
	const tracerVersion = childProcess.execFileSync(tracer, ["--version"], { encoding: "utf8", timeout: 5_000 });
	const tracerHelp = childProcess.execFileSync(tracer, ["--help"], { encoding: "utf8", timeout: 5_000 });
	assert.ok(tracerHelp.includes("--kill-on-exit"), "The tracer must kill its traced children when it exits.");
	await writeFile(join(output, "strace-version.txt"), tracerVersion);
	const app = join(root, "app");
	const assetsModule: typeof import("../src/box/microvm-assets.ts") = await import(
		pathToFileURL(join(app, "dist/box/microvm-assets.js")).href
	);
	const assets = await assetsModule.installedMicrovmAssets();
	assert.equal(assets.target, "linux-x64");
	const manifestBytes = await readFile(join(app, "computer/manifest.json"));
	await writeFile(join(output, "runtime-manifest.json"), manifestBytes);
	const home = await realpath(await mkdtemp(join(tmpdir(), "banda-native-start-diagnostic-")));
	const cache = join(
		"/tmp",
		`banda-msb-${process.getuid?.() ?? 0}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`,
	);
	const runtimeEnv = {
		PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: homedir(),
		LANG: "C.UTF-8",
		MSB_HOME: cache,
		MSB_PATH: assets.msb,
		MSB_LIBKRUNFW_PATH: assets.firmware,
	};
	const originalExecFile = childProcess.execFile;
	const originalSpawn = childProcess.spawn;
	const originalExecFileSync = childProcess.execFileSync;
	const children: { pid: number | undefined; closed: boolean }[] = [];
	const observeChild = (child: ChildProcess) => {
		const entry = { pid: child.pid, closed: false };
		children.push(entry);
		child.once("close", () => {
			entry.closed = true;
		});
		return child;
	};
	const query = (args: readonly string[]): unknown =>
		JSON.parse(
			originalExecFileSync(assets.msb, [...args], {
				encoding: "utf8",
				env: runtimeEnv,
				timeout: 5_000,
				killSignal: "SIGKILL",
				maxBuffer: 1 << 20,
			}),
		);
	const boxModule: typeof import("../src/box/box.ts") = await import(pathToFileURL(join(app, "dist/box/box.js")).href);
	const nativeModule: typeof import("../src/box/microvm.ts") = await import(
		pathToFileURL(join(app, "dist/box/microvm.js")).href
	);
	const setup = nativeModule.microvmBox(home);
	const name = setup.command.at(-1);
	assert.ok(name && /^banda-microvm-[a-f0-9]{10}-[a-f0-9]{12}$/.test(name));
	const generation = name.slice(-12);
	const owner = {
		binary: assets.msb,
		cache,
		home,
		name,
		generation,
		imageRef: assets.box.ref,
		configDigest: assets.box.digest,
	};
	const names = [name, `${name}-proxy`, `${name}-browser`];
	setup.egress?.source(async () => ({ credentials: [] }));
	const log: string[] = [];
	const box = boxModule.openBox(setup, (line) => log.push(line));
	const hostBefore = await hostDiagnostics();
	let probe: unknown = { state: "not-triggered" };
	let originalFailure: unknown;
	let evidenceFailure: unknown;
	let cleanup: unknown;
	const attached = () =>
		new Promise((resolveCapture, rejectCapture) => {
			const runtimeArgv = ["exec", "--no-stdin", "--no-tty", name, "--", "/bin/true"];
			const argv = [
				"--kill-on-exit",
				"-f",
				"-ttt",
				"-s",
				"4096",
				"-o",
				"/dev/fd/3",
				"-e",
				"trace=write,writev,tgkill,tkill,kill",
				assets.msb,
				...runtimeArgv,
			];
			const child = observeChild(
				originalSpawn(tracer, argv, {
					cwd: assets.root,
					env: { ...runtimeEnv, RUST_BACKTRACE: "1" },
					detached: true,
					stdio: ["ignore", "pipe", "pipe", "pipe"],
				}),
			);
			let size = 0;
			const streams = { stdout: child.stdout, stderr: child.stderr, trace: child.stdio[3] };
			const chunks: { stdout: Buffer[]; stderr: Buffer[]; trace: Buffer[] } = { stdout: [], stderr: [], trace: [] };
			let settled = false;
			let controlError: string | undefined;
			let timer: NodeJS.Timeout;
			let termination: { reason: string; timer: NodeJS.Timeout } | undefined;
			const finish = (reason: string, code: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(termination?.timer);
				for (const stream of Object.values(streams)) stream?.destroy();
				const stdout = Buffer.concat(chunks.stdout);
				const stderr = Buffer.concat(chunks.stderr);
				const trace = Buffer.concat(chunks.trace);
				const capture = {
					binary: tracer,
					argv,
					runtimeArgv,
					tracerVersion,
					environmentDelta: { RUST_BACKTRACE: "1" },
					reason: reason === "closed" ? (termination?.reason ?? reason) : reason,
					closed: reason === "closed",
					code,
					signal,
					stdout: stdout.toString("utf8"),
					stderr: stderr.toString("utf8"),
					rawFiles: { stdout: "syscall-stdout.bin", stderr: "syscall-stderr.bin", trace: "syscall-trace.log" },
					traceBytes: trace.length,
					pid: child.pid,
					bytesObserved: size,
					bytesRetained: Math.min(size, 1 << 20),
					controlError,
				};
				void Promise.all([
					writeFile(join(output, capture.rawFiles.stdout), stdout),
					writeFile(join(output, capture.rawFiles.stderr), stderr),
					writeFile(join(output, capture.rawFiles.trace), trace),
				]).then(() => resolveCapture(capture), rejectCapture);
			};
			const stop = (reason: string) => {
				if (settled || termination) return;
				clearTimeout(timer);
				termination = { reason, timer: setTimeout(() => finish("close-timeout", null, null), 5_000) };
				if (child.pid !== undefined) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
							controlError = String(error).slice(0, 4000);
					}
				}
			};
			for (const channel of ["stdout", "stderr", "trace"] as const)
				streams[channel]?.on("data", (chunk: Buffer) => {
					const retained = chunk.subarray(0, Math.max(0, (1 << 20) - size));
					size += chunk.length;
					if (retained.length > 0) chunks[channel].push(retained);
					if (size > 1 << 20) stop("output-limit");
				});
			child.once("error", (error) => {
				controlError = error.message.slice(0, 4000);
				finish("spawn-error", null, null);
			});
			child.once("close", (code, signal) => finish("closed", code, signal));
			timer = setTimeout(() => stop("deadline"), 20_000);
		});
	const diagnose = failedCreateObserver(owner, async () => {
		const image = diagnosticImage(owner, query(["image", "inspect", assets.box.ref, "--format", "json"]));
		const admission = diagnosticInspection(owner, query(["inspect", name, "--format", "json"]), image.digest);
		const before = admission.inspection;
		const hostAtFailure = await hostDiagnostics();
		probe = { state: "owned-before-probe", image, before, hostAtFailure, canStart: admission.canStart };
		await writeFile(join(output, "before-start.json"), JSON.stringify(probe, null, 2));
		if (!admission.canStart) throw new Error("The diagnostic refuses an active command VM.");
		const capture = await attached();
		probe = { state: "captured", image, before, hostAtFailure, capture };
		await writeFile(join(output, "attached-start.json"), JSON.stringify(probe, null, 2));
		try {
			probe = {
				state: "captured",
				before,
				hostAtFailure,
				capture,
				after: query(["inspect", name, "--format", "json"]),
			};
		} catch (error) {
			probe = { state: "captured", image, before, hostAtFailure, capture, afterError: String(error) };
		}
		await writeFile(join(output, "attached-start.json"), JSON.stringify(probe, null, 2));
	});
	const matchesRuntime = (args: unknown[]) => {
		const schema = Type.Tuple([
			Type.Literal(assets.msb),
			Type.Array(Type.String()),
			Type.Object({ env: Type.Object({ MSB_HOME: Type.Literal(cache) }) }),
		]);
		return Value.Check(schema, args.slice(0, 3));
	};
	childProcess.execFile = new Proxy(originalExecFile, {
		apply(target, thisArg, args: unknown[]) {
			if (!matchesRuntime(args)) return Reflect.apply(target, thisArg, args);
			if (!ownedCreateInvocation(owner, args[0], args[1], args[2]))
				return observeChild(Reflect.apply(target, thisArg, args));
			const callback = args[3];
			assert.ok(typeof callback === "function");
			const delivered = function (this: unknown, ...result: unknown[]) {
				void deliverCreateResult({
					diagnose: () => diagnose(args[0], args[1], args[2], result[0]),
					recordFailure: async (error) => {
						probe = { state: "refused-or-failed", error: error instanceof Error ? error.stack : String(error) };
						await writeFile(join(output, "attached-start.json"), JSON.stringify(probe, null, 2));
					},
					deliver: () => {
						Reflect.apply(callback, this, result);
					},
				});
			};
			return observeChild(Reflect.apply(target, thisArg, [...args.slice(0, 3), delivered]));
		},
	});
	childProcess.spawn = new Proxy(originalSpawn, {
		apply(target, thisArg, args: unknown[]) {
			const child = Reflect.apply(target, thisArg, args);
			return matchesRuntime(args) ? observeChild(child) : child;
		},
	});
	syncBuiltinESMExports();
	let admissionTimer: NodeJS.Timeout | undefined;
	try {
		admissionTimer = setTimeout(() => {
			void box.close().catch(() => {});
		}, 180_000);
		await box.ensure();
	} catch (error) {
		originalFailure = error;
	} finally {
		clearTimeout(admissionTimer);
		try {
			await box.close();
			childProcess.execFile = originalExecFile;
			childProcess.spawn = originalSpawn;
			syncBuiltinESMExports();
			const inventory: unknown = query(["list", "--format", "json"]);
			assert.deepEqual(inventory, []);
			const deadline = Date.now() + 5_000;
			while (children.some((child) => !child.closed) && Date.now() < deadline) await delay(20);
			assert.ok(
				children.every((child) => child.closed),
				"Every observed native subprocess must close.",
			);
			const ps = originalExecFileSync("/bin/ps", ["-ax", "-o", "pid=,args="], {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 1 << 20,
			});
			const remaining = ps
				.split("\n")
				.filter((line) => line.includes(assets.msb) && (line.includes(cache) || names.some((vm) => line.includes(vm))));
			assert.deepEqual(remaining, [], "Exact owned native processes must be gone.");
			cleanup = { inventory, remaining, children, verified: true };
			if (originalFailure === undefined) {
				await rm(cache, { recursive: true, force: true });
				await rm(home, { recursive: true, force: true });
			}
		} catch (error) {
			cleanup = { verified: false, error: error instanceof Error ? error.stack : String(error), children };
		} finally {
			childProcess.execFile = originalExecFile;
			childProcess.spawn = originalSpawn;
			syncBuiltinESMExports();
			try {
				await writeFile(join(output, "box.log"), log.join("\n"));
				await writeFile(
					join(output, "result.json"),
					JSON.stringify(
						{
							qualification: false,
							sourceCommit: process.env.GITHUB_SHA ?? null,
							home,
							cache,
							owner,
							runtimeManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
							hostBefore,
							hostAfter: await hostDiagnostics(),
							probe,
							originalFailure:
								originalFailure === undefined
									? null
									: originalFailure instanceof Error
										? originalFailure.stack
										: String(originalFailure),
							cleanup,
						},
						null,
						2,
					),
				);
			} catch (error) {
				console.error("Could not retain diagnostic evidence:", error);
				evidenceFailure = error;
			}
		}
	}
	if (originalFailure !== undefined) throw originalFailure;
	if (evidenceFailure !== undefined) throw evidenceFailure;
	throw new Error(
		"Startup did not reproduce the original failure. This diagnostic is inconclusive, not qualification.",
	);
}
