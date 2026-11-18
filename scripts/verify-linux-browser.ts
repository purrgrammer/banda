import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, stat, truncate, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const Observation = Type.Union([
	Type.Object({ kind: Type.Literal("read"), value: Type.String() }),
	Type.Object({ kind: Type.Literal("missing"), error: Type.String() }),
	Type.Object({ kind: Type.Literal("unreadable"), error: Type.String() }),
]);
type Observation = Static<typeof Observation>;
const Identity = Type.Object({ pid: Type.Integer({ minimum: 1 }), startTicks: Type.String() });
type Identity = Static<typeof Identity>;
const Snapshot = Type.Object({
	identity: Identity,
	exe: Observation,
	cmdline: Observation,
	stat: Observation,
	status: Observation,
	apparmor: Observation,
	namespaces: Type.Record(Type.String(), Observation),
});
type Snapshot = Static<typeof Snapshot>;
const Readiness = Type.Union([
	Type.Object({ kind: Type.Literal("failed"), error: Type.String() }),
	Type.Object({ kind: Type.Literal("ready"), browserVersion: Type.String(), constant: Type.Literal(2) }),
]);
export const LinuxBrowserResult = Type.Object({
	qualification: Type.Literal(false),
	kind: Type.Literal("browser-startup-evidence"),
	sourceCommit: Type.String(),
	setupAction: Type.Literal("48ad923757ca74d66703209fe939badbdf80f2f4"),
	platform: Type.String(),
	binary: Type.Object({ path: Type.String(), sha256: Type.String(), version: Type.String() }),
	readiness: Readiness,
	primaryFailure: Type.Union([Type.String(), Type.Null()]),
	helperExit: Type.Union([Type.String(), Type.Null()]),
	cleanup: Type.Object({
		kind: Type.Union([Type.Literal("complete"), Type.Literal("failed")]),
		errors: Type.Array(Type.String()),
		signals: Type.Array(Type.Object({ identity: Identity, signal: Type.Literal("SIGKILL") })),
		helperClose: Type.Literal("closes CDP stdin; existing helper may SIGKILL its child after 3 seconds"),
	}),
	process: Type.Object({
		wrapper: Type.Union([Snapshot, Type.Null()]),
		browser: Type.Union([Snapshot, Type.Null()]),
		browserObservation: Type.Union([Type.Literal("observed"), Type.Literal("unobserved")]),
		arguments: Type.Array(Type.String()),
		profile: Type.Union([Type.String(), Type.Null()]),
		profileMetadata: Observation,
	}),
	stderr: Type.Object({
		bytesBeforeRetention: Type.Integer(),
		retainedBytes: Type.Integer(),
		complete: Type.Boolean(),
		limit: Type.Literal(2097152),
		policy: Type.Literal("monitored cap; writes may overshoot before cleanup; retains beginning"),
	}),
	diagnosticDifferences: Type.Array(Type.String()),
	passed: Type.Boolean(),
});
export type LinuxBrowserResult = Static<typeof LinuxBrowserResult>;
const STDERR_LIMIT = 2 << 20;
const pause = () => new Promise<void>((done) => setTimeout(done, 10));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function observe(read: () => Promise<string>): Promise<Observation> {
	try {
		return { kind: "read", value: await read() };
	} catch (error) {
		return {
			kind: error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "unreadable",
			error: message(error),
		};
	}
}
const file = (path: string) => observe(() => readFile(path, "utf8"));
const link = (path: string) => observe(() => readlink(path));
const metadata = (path: string) =>
	observe(async () => {
		const value = await lstat(path);
		return JSON.stringify({ uid: value.uid, gid: value.gid, mode: value.mode.toString(8), size: value.size });
	});

function identity(text: string): Identity {
	const pid = Number(text.slice(0, text.indexOf(" ")));
	const startTicks = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
	const value = { pid, startTicks };
	if (!Value.Check(Identity, value) || !/^\d+$/.test(value.startTicks))
		throw new Error("Invalid /proc process identity");
	return value;
}

async function snapshot(owner: Identity): Promise<Snapshot | null> {
	const base = `/proc/${owner.pid}`;
	const before = await file(`${base}/stat`);
	if (before.kind !== "read" || identity(before.value).startTicks !== owner.startTicks) return null;
	const [exe, cmdline, status, apparmor] = await Promise.all([
		link(`${base}/exe`),
		file(`${base}/cmdline`),
		file(`${base}/status`),
		file(`${base}/attr/current`),
	]);
	const namespaces: Record<string, Observation> = {};
	for (const name of ["user", "pid", "mnt", "net"]) namespaces[name] = await link(`${base}/ns/${name}`);
	const after = await file(`${base}/stat`);
	if (after.kind !== "read" || identity(after.value).startTicks !== owner.startTicks) return null;
	return { identity: owner, exe, cmdline, stat: before, status, apparmor, namespaces };
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Browser preflight timed out after ${ms} ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

let launched = false;

export async function verifyLinuxBrowser({
	chrome,
	output,
}: {
	chrome: string;
	output: string;
}): Promise<LinuxBrowserResult> {
	if (launched) throw new Error("Browser preflight requires a fresh process for the helper CHROME binding");
	launched = true;
	await mkdir(output, { mode: 0o700 });
	const binary = await realpath(chrome);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(binary)) hash.update(chunk);
	const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 3_000, maxBuffer: 16 << 10 }).trim();
	const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 2_000 }).trim();
	const observations: Record<string, Observation> = {};
	for (const path of [
		"/etc/os-release",
		"/proc/self/status",
		"/proc/self/attr/current",
		"/proc/sys/kernel/unprivileged_userns_clone",
		"/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
		"/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined",
		"/proc/sys/user/max_user_namespaces",
		"/sys/module/apparmor/parameters/enabled",
	])
		observations[path] = await file(path);
	await writeFile(
		join(output, "host.json"),
		JSON.stringify(
			{
				platform: process.platform,
				kernel: release(),
				node: process.version,
				imageOS: process.env.ImageOS ?? null,
				imageVersion: process.env.ImageVersion ?? null,
				uid: process.getuid?.(),
				gid: process.getgid?.(),
				groups: process.getgroups?.(),
				observations,
				binary: await metadata(binary),
				sandboxFiles: {
					chrome_sandbox: await metadata(join(dirname(binary), "chrome_sandbox")),
					"chrome-sandbox": await metadata(join(dirname(binary), "chrome-sandbox")),
				},
			},
			null,
			2,
		),
	);
	if (process.getuid?.() === 0) throw new Error("Browser preflight must run as the ordinary runner user");
	const stderrPath = join(output, "chrome.stderr");
	await writeFile(stderrPath, "", { flag: "wx", mode: 0o600 });
	const wrapper = join(output, "chrome-wrapper.sh");
	await writeFile(
		wrapper,
		`#!/bin/sh\nexec 2>${quote(stderrPath)}\nprintf '%s\\n' "$$" >${quote(join(output, "wrapper.pid"))}\nprintf '%s\\0' "$@" >${quote(join(output, "arguments"))}\nif [ -r /proc/$$/stat ]; then\n  cat /proc/$$/stat >${quote(join(output, "wrapper.stat.tmp"))}\nmv ${quote(join(output, "wrapper.stat.tmp"))} ${quote(join(output, "wrapper.stat"))}\n  cat /proc/$$/status >${quote(join(output, "wrapper.status"))}\n  cat /proc/$$/attr/current >${quote(join(output, "wrapper.apparmor"))}\n  readlink /proc/$$/exe >${quote(join(output, "wrapper.exe"))}\nfi\nfor arg in "$@"; do\n  case "$arg" in --user-data-dir=*) ls -ldn "\${arg#--user-data-dir=}" >${quote(join(output, "profile.metadata"))} ;; esac\ndone\nexec ${quote(binary)} "$@"\n`,
		{ mode: 0o700 },
	);
	await chmod(wrapper, 0o700);
	const previousChrome = process.env.CHROME;
	process.env.CHROME = wrapper;
	const helper = await import("../test/smoke/chrome.ts").finally(() => {
		if (previousChrome === undefined) delete process.env.CHROME;
		else process.env.CHROME = previousChrome;
	});
	if (helper.CHROME !== wrapper) throw new Error("Browser helper was already imported with another CHROME binding");
	const { openChrome, COMMAND_MS } = helper;
	const browser = await openChrome();
	const result: LinuxBrowserResult = {
		qualification: false,
		kind: "browser-startup-evidence",
		sourceCommit,
		setupAction: "48ad923757ca74d66703209fe939badbdf80f2f4",
		platform: process.platform,
		binary: { path: binary, sha256: hash.digest("hex"), version },
		readiness: { kind: "failed", error: "Readiness did not finish" },
		primaryFailure: null,
		helperExit: null,
		cleanup: {
			kind: "complete",
			errors: [],
			signals: [],
			helperClose: "closes CDP stdin; existing helper may SIGKILL its child after 3 seconds",
		},
		process: {
			wrapper: null,
			browser: null,
			browserObservation: "unobserved",
			arguments: [],
			profile: null,
			profileMetadata: { kind: "missing", error: "Profile not observed" },
		},
		stderr: {
			bytesBeforeRetention: 0,
			retainedBytes: 0,
			complete: true,
			limit: 2097152,
			policy: "monitored cap; writes may overshoot before cleanup; retains beginning",
		},
		diagnosticDifferences: [
			"Fixed shell wrapper records its identity and arguments before exec",
			"Only stderr is redirected to an owned regular file from byte zero",
			"A monitored 2 MiB stderr cap can overshoot; exceeding it fails and closes the browser",
		],
		passed: false,
	};
	let owner: Identity | undefined;
	let monitoring = true;
	const monitor = (async () => {
		while (monitoring) {
			if (owner === undefined) {
				const value = await file(join(output, "wrapper.stat"));
				if (value.kind === "read" && value.value !== "") owner = identity(value.value);
			}
			if (owner !== undefined && result.process.browser === null) {
				const current = await snapshot(owner);
				if (current?.exe.kind === "read" && current.exe.value === binary) {
					result.process.browser = current;
					result.process.browserObservation = "observed";
				}
			}
			if ((await stat(stderrPath)).size > STDERR_LIMIT) throw new Error("Chrome stderr exceeded monitored 2 MiB cap");
			await pause();
		}
	})();
	const readiness = async () => {
		const send = async (method: string, params: object = {}, sessionId?: string) =>
			browser.cdp.send<unknown>(method, params, sessionId, COMMAND_MS);
		const versionReply = await send("Browser.getVersion");
		const Version = Type.Object({ product: Type.String() });
		if (!Value.Check(Version, versionReply)) throw new Error("Invalid Browser.getVersion reply");
		const target = await send("Target.createTarget", { url: "about:blank" });
		const Target = Type.Object({ targetId: Type.String() });
		if (!Value.Check(Target, target)) throw new Error("Invalid Target.createTarget reply");
		const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
		const Attached = Type.Object({ sessionId: Type.String() });
		if (!Value.Check(Attached, attached)) throw new Error("Invalid Target.attachToTarget reply");
		await send("Runtime.enable", {}, attached.sessionId);
		const evaluated = await send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true }, attached.sessionId);
		if (!Value.Check(Type.Object({ result: Type.Object({ value: Type.Literal(2) }) }), evaluated))
			throw new Error("Renderer constant check failed");
		result.readiness = { kind: "ready", browserVersion: versionReply.product, constant: 2 };
	};
	try {
		await bounded(Promise.race([readiness(), monitor]), 24_000);
	} catch (error) {
		result.primaryFailure = message(error);
		result.readiness = { kind: "failed", error: message(error) };
	} finally {
		const stop = browser.stop();
		try {
			await bounded(stop, 4_000);
		} catch (error) {
			result.cleanup.errors.push(message(error));
			try {
				if (owner !== undefined && (await snapshot(owner)) !== null) {
					process.kill(owner.pid, "SIGKILL");
					result.cleanup.signals.push({ identity: owner, signal: "SIGKILL" });
				}
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
					result.cleanup.errors.push(message(error));
			}
			await bounded(stop, 1_000).catch((error: unknown) => result.cleanup.errors.push(message(error)));
		}
		monitoring = false;
		await monitor.catch((error: unknown) => {
			result.primaryFailure ??= message(error);
		});
		result.helperExit = browser.cdp.closed ?? null;
		if (result.helperExit !== "it ended (code 0)" && result.primaryFailure === null)
			result.primaryFailure = result.helperExit ?? "Browser exit unobserved";
	}
	try {
		const args = await file(join(output, "arguments"));
		if (args.kind === "read") result.process.arguments = args.value.split("\0").filter(Boolean);
		result.process.profile =
			result.process.arguments.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ??
			null;
		if (result.process.profile === null) result.cleanup.errors.push("Chrome profile not observed");
		else {
			result.process.profileMetadata = await file(join(output, "profile.metadata"));
			if ((await metadata(result.process.profile)).kind !== "missing")
				result.cleanup.errors.push("Chrome profile remains after helper cleanup");
		}
		if (owner !== undefined) {
			result.process.wrapper = {
				identity: owner,
				exe: await file(join(output, "wrapper.exe")),
				cmdline: args,
				stat: await file(join(output, "wrapper.stat")),
				status: await file(join(output, "wrapper.status")),
				apparmor: await file(join(output, "wrapper.apparmor")),
				namespaces: {},
			};
			if ((await snapshot(owner)) !== null) result.cleanup.errors.push("Owned browser process remains after cleanup");
		}
		const bytes = (await stat(stderrPath)).size;
		const stderr = await open(stderrPath, "r");
		try {
			const beginning = Buffer.alloc(Math.min(bytes, 1024));
			const end = Buffer.alloc(Math.min(bytes, 1024));
			await stderr.read(beginning, 0, beginning.length, 0);
			await stderr.read(end, 0, end.length, Math.max(0, bytes - end.length));
			console.log(
				`Chrome stderr (${bytes} bytes), beginning:\n${beginning.toString("utf8")}\nend:\n${end.toString("utf8")}`,
			);
		} finally {
			await stderr.close();
		}
		if (bytes > STDERR_LIMIT) {
			result.primaryFailure ??= "Chrome stderr exceeded monitored 2 MiB cap";
			await truncate(stderrPath, STDERR_LIMIT);
		}
		result.stderr = {
			...result.stderr,
			bytesBeforeRetention: bytes,
			retainedBytes: Math.min(bytes, STDERR_LIMIT),
			complete: bytes <= STDERR_LIMIT,
		};
	} catch (error) {
		result.cleanup.errors.push(message(error));
	}
	result.cleanup.kind = result.cleanup.errors.length === 0 ? "complete" : "failed";
	result.passed =
		result.primaryFailure === null && result.cleanup.kind === "complete" && result.readiness.kind === "ready";
	try {
		await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
	} catch (error) {
		throw new Error(result.primaryFailure ?? "Cannot retain browser preflight result", { cause: error });
	}
	return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const output = process.argv[2];
	const chrome = process.env.CHROME;
	if (process.platform !== "linux" || output === undefined || chrome === undefined)
		throw new Error(
			"Usage on Linux: CHROME=<pinned browser> node scripts/verify-linux-browser.ts <new evidence directory>",
		);
	try {
		const result = await verifyLinuxBrowser({ chrome, output: resolve(output) });
		console.log(`Browser startup ${result.passed ? "passed" : "failed"}; native qualification remains false`);
		process.exitCode = result.passed ? 0 : 1;
	} catch (error) {
		console.error(message(error));
		process.exitCode = 1;
	}
}
