/**
 * The container box: one container per home, made from `box/Dockerfile`, running as the owner's uid with a read-only
 * root, every capability dropped and no new privileges. Its network is closed (DESIGN.md "The box", Network): it sits
 * on an internal network whose only other member is the egress proxy (`proxy/`), so it resolves no outside name and has
 * no route out; the proxy alone reaches the internet. The proxy's certificate authority is the only one the box trusts:
 * its trust store is a volume the proxy fills, mounted read-only over the box's own.
 *
 * The workspace, `/work` and `/tools` are volumes, so the box keeps them when it is made again; nothing of the host is
 * mounted. The daemon reaches pi-env in the box, and the proxy's control script, with `docker exec` alone.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { BoxSetup } from "./box.ts";
import { BROWSER_UID, browserStart } from "./browser-start.ts";
import { guardedProxy, type ProxyTransport, proxyReady, TRUST_ENV } from "./guarded-proxy.ts";

const DOCKERFILE = fileURLToPath(new URL("../../box/Dockerfile", import.meta.url));
const PROXY = fileURLToPath(new URL("../../proxy/", import.meta.url));

export class DockerError extends Error {}

/** The oldest Docker Engine the box runs on: it joins the proxy to two networks at once, one with an alias. */
export const DOCKER_MIN = 25;
/** The most memory the box takes, swap included: its commands and browsers share it. */
export const BOX_MEMORY = "4g";

/**
 * What a failed docker command means, in plain words, when it is a trouble the owner fixes: Docker missing, not
 * running, or out of this user's reach. Undefined otherwise: then the command's own words say it.
 */
export function dockerTrouble(error: { readonly code?: unknown }, stderr: string): string | undefined {
	if (error.code === "ENOENT")
		return "Docker isn't installed: install Docker Desktop (or Docker Engine), and the computer starts by itself.";
	if (/permission denied.*docker/i.test(stderr))
		return "banda can't use Docker: this user may not reach it. On Linux, add yourself to the docker group, then sign in again.";
	if (
		/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|docker_engine/i.test(stderr)
	)
		return "Docker isn't running: start Docker Desktop (or the Docker service), and the computer starts by itself.";
	return undefined;
}

/** Why Docker Engine `version` cannot run the box, in plain words; undefined when it can. */
export function engineTooOld(version: string): string | undefined {
	const major = Number(/^(\d+)\./.exec(version.trim())?.[1]);
	if (Number.isInteger(major) && major >= DOCKER_MIN) return undefined;
	return `Docker is too old: the computer needs Docker Engine ${DOCKER_MIN} or later, and this one is ${version.trim() || "unknown"}. Update Docker, and it starts by itself.`;
}

/**
 * Why `docker exec` could not even start in the proxy, so that nothing it was asked to send left; undefined for anything
 * else (a timeout, say, after which what it sent is not known).
 */
export function proxyDown(error: unknown): string | undefined {
	return /No such container|is not running|is paused|Docker isn't (installed|running)|can't use Docker/i.test(
		String(error),
	)
		? "the computer's proxy is not running"
		: undefined;
}

/** Run docker; a failure says what it means (`dockerTrouble`), else the last `tail` lines docker wrote. */
function docker(args: readonly string[], timeoutMs = 60_000, input?: string, tail = 1): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("docker", args, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
			if (error === null) return resolve(stdout.trim());
			const plain = dockerTrouble(error, stderr);
			if (plain !== undefined) return reject(new DockerError(plain));
			if (error.killed === true) return reject(new DockerError(`docker ${args[0]}: it did not answer in time`));
			const said = (stderr.trim() || error.message)
				.split("\n")
				.filter((line) => line.trim() !== "")
				.slice(-tail)
				.join("\n");
			reject(new DockerError(`docker ${args[0]}: ${said || "it did not answer in time"}`));
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

/** Throws, in plain words, unless a Docker Engine the box runs on answers. */
export async function dockerReady(): Promise<void> {
	const version = await docker(["version", "--format", "{{.Server.Version}}"], 5_000);
	const old = engineTooOld(version);
	if (old !== undefined) throw new DockerError(old);
}

/** Whether a Docker Engine the box runs on answers. */
export async function dockerAvailable(): Promise<boolean> {
	return dockerReady().then(
		() => true,
		() => false,
	);
}

/** The container and volume names of `home`'s box; its proxy and networks are named after it. */
export function containerName(home: string): string {
	return `banda-box-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 10)}`;
}

/** The names of what `home`'s box is made of besides itself. */
export function boxParts(home: string) {
	const name = containerName(home);
	return { box: name, proxy: `${name}-proxy`, inside: `${name}-in`, outside: `${name}-out` };
}

export const VOLUMES = { workspace: "/workspace", work: "/work", tools: "/tools", browser: "/browser" } as const;
// sent: the writes sent under a host permission, kept until the daemon took them, whatever happens to the proxy
const PROXY_VOLUMES = { ca: "/ca", trust: "/trust", kept: "/kept" } as const;
const PROXY_PORT = 8080;
/** How many lines of a failed build's log its error keeps. */
const BUILD_TAIL = 30;

/**
 * An image built from `files` in a folder of their own, tagged by their hash; built only when missing, `building` told
 * first.
 */
async function build(
	repository: string,
	files: { readonly [name: string]: string },
	building: () => void,
): Promise<string> {
	const tag = await imageTag(repository, files);
	try {
		await docker(["image", "inspect", "--format", "{{.Id}}", tag], 10_000);
		return tag;
	} catch {
		// not built yet
	}
	const context = await mkdtemp(join(tmpdir(), `${repository}-`));
	try {
		for (const [name, path] of Object.entries(files)) await copyFile(path, join(context, name));
		if ("pi-env" in files) await chmod(join(context, "pi-env"), 0o755);
		building();
		await docker(["build", "--progress", "plain", "--tag", tag, context], 20 * 60_000, undefined, BUILD_TAIL);
	} finally {
		await rm(context, { recursive: true, force: true });
	}
	return tag;
}

/** An image's tag: its repository and the hash of the files it is built from, by name. */
async function imageTag(
	repository: string,
	files: { readonly [name: string]: string },
	target?: "boot" | "browser",
): Promise<string> {
	const hash = createHash("sha256");
	if (target !== undefined) hash.update(`target:${target}\n`);
	for (const [name, path] of Object.entries(files).sort()) {
		hash.update(name);
		hash.update(await readFile(path));
	}
	return `${repository}:${hash.digest("hex").slice(0, 12)}`;
}

/** The box's build files: the Dockerfile and the pi-env daemon it carries, for the Docker server's architecture. */
async function boxFiles(target?: "arm64" | "x64"): Promise<{ [name: string]: string }> {
	const arch = target ?? (await docker(["version", "--format", "{{.Server.Arch}}"], 10_000));
	const daemon = packagedDaemon({ platform: "linux", arch: arch === "arm64" || arch === "aarch64" ? "arm64" : "x64" });
	return {
		Dockerfile: DOCKERFILE,
		"pi-env": daemon,
		"proxy-bridge.sh": fileURLToPath(new URL("../../box/proxy-bridge.sh", import.meta.url)),
	};
}

/** The proxy's build files: mitmproxy, pinned, with the policy addon and the control script. */
async function proxyFiles(): Promise<{ [name: string]: string }> {
	const files: { [name: string]: string } = {};
	for (const name of (await readdir(PROXY)).filter((n) => n === "Dockerfile" || n.endsWith(".py")).sort())
		if (!name.startsWith("test_")) files[name] = join(PROXY, name);
	return files;
}

const boxImage = async (building: () => void) => build("banda-box", await boxFiles(), building);
const proxyImage = async (building: () => void) => build("banda-proxy", await proxyFiles(), building);

/**
 * The images a box is made of, each with the tag banda looks for and the files it is built from, so something else
 * (CI, with a layer cache) can build them first and banda finds them made.
 */
export async function imageSpecs({
	arch,
	boxTarget,
}: {
	readonly arch?: "arm64" | "x64";
	readonly boxTarget?: "boot" | "browser";
} = {}): Promise<
	{ readonly tag: string; readonly files: { [name: string]: string }; readonly target?: "boot" | "browser" }[]
> {
	const box = await boxFiles(arch);
	const proxy = await proxyFiles();
	return [
		{
			tag: await imageTag(boxTarget === "browser" ? "banda-browser" : "banda-box", box, boxTarget),
			files: box,
			...(boxTarget === undefined ? {} : { target: boxTarget }),
		},
		{ tag: await imageTag("banda-proxy", proxy), files: proxy },
	];
}

/**
 * Bring up container `name` as `run` says, labelled with the hash of `run`: kept if it runs so, started if it stopped,
 * made again if it was made otherwise. Whether it was made or started now.
 */
async function bringUp(name: string, home: string, run: readonly string[], restart: boolean): Promise<boolean> {
	const made = createHash("sha256").update(run.join("\0")).digest("hex").slice(0, 16);
	let state: string | undefined;
	try {
		state = await docker(
			["container", "inspect", "--format", '{{.State.Running}} {{index .Config.Labels "banda.made"}}', name],
			10_000,
		);
	} catch {
		state = undefined;
	}
	if (state !== undefined) {
		const [running, label] = state.split(" ");
		if (label === made) {
			if (running !== "true") {
				await docker(["start", name]);
				return true;
			}
			if (restart) await docker(["restart", "--time", "0", name]);
			return restart;
		}
		// made from another image or with other options: make it again; the volumes keep its files
		await docker(["rm", "--force", name]);
	}
	await docker([
		"run",
		"--detach",
		"--name",
		name,
		"--label",
		`banda.home=${resolve(home)}`,
		"--label",
		`banda.made=${made}`,
		...run,
	]);
	return true;
}

/** Network `name`, made if missing: `internal` has no route out. */
async function network(name: string, home: string, internal: boolean): Promise<void> {
	try {
		const found = await docker(["network", "inspect", "--format", "{{.Internal}}", name], 10_000);
		if (found === String(internal)) return;
		await docker(["network", "rm", name]);
	} catch {
		// not made yet
	}
	await docker([
		"network",
		"create",
		...(internal ? ["--internal"] : []),
		"--label",
		`banda.home=${resolve(home)}`,
		name,
	]);
}

export function containerBox(home: string): BoxSetup {
	const { box: name, proxy, inside, outside } = boxParts(home);
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	// whether this process brought the box up already
	let started = false;
	const transport: ProxyTransport = {
		exec: (args, input, timeoutMs) =>
			docker(["exec", ...(input === undefined ? [] : ["--interactive"]), proxy, ...args], timeoutMs, input),
		running: async () =>
			(await docker(["container", "inspect", "--format", "{{.State.Running}}", proxy], 10_000).catch(
				(error: unknown) => {
					if (String(error).includes("No such")) return "false";
					throw error;
				},
			)) === "true",
		halt: async () => {
			await docker(["kill", proxy], 20_000);
		},
	};
	const guarded = guardedProxy({ home, endpoint: `proxy:${PROXY_PORT}`, transport });
	return {
		kind: "container",
		workspace: VOLUMES.workspace,
		attachments: `${VOLUMES.work}/attachments`,
		command: ["docker", "exec", "--interactive", name, "/usr/local/bin/pi-env"],
		egress: {
			...guarded.egress,
			replay: (request, ctx) =>
				guarded.egress.replay(request, ctx).catch((error: unknown) => {
					const down = proxyDown(error);
					if (down === undefined) throw error;
					return { failed: down };
				}),
		},
		browser: (agent) => ({
			command: async () => [
				"docker",
				"exec",
				"--interactive",
				"--user",
				`${BROWSER_UID}:${BROWSER_UID}`,
				"--env",
				`HOME=/browser/agents/${agent}/home`,
				name,
				"/bin/sh",
				"-c",
				browserStart({ agent, proxy: `proxy:${PROXY_PORT}`, trust: TRUST_ENV.SSL_CERT_FILE }),
			],
			...guarded.browser(agent),
		}),
		ensure: async (building = () => {}) => {
			await dockerReady();
			const [boxTag, proxyTag] = await Promise.all([boxImage(building), proxyImage(building)]);
			await network(inside, home, true);
			await network(outside, home, false);
			// the proxy first: the box never runs without it, so it never has a network of its own
			await bringUp(
				proxy,
				home,
				[
					"--hostname",
					"proxy",
					"--network",
					`name=${outside}`,
					"--network",
					`name=${inside},alias=proxy`,
					"--user",
					`${uid}:${gid}`,
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"512",
					"--tmpfs",
					"/state:rw,nosuid,nodev,size=256m,mode=1777",
					...Object.entries(PROXY_VOLUMES).flatMap(([volume, path]) => [
						"--mount",
						`type=volume,src=${name}-${volume},dst=${path}`,
					]),
					proxyTag,
				],
				false,
			);
			// up once it trusts its own authority and listens; then it gets the daemon's config, whatever it had
			const deadline = Date.now() + 60_000;
			for (;;) {
				const ping = await proxyReady(transport).catch(() => false);
				if (ping) break;
				if (Date.now() > deadline) throw new DockerError("the egress proxy did not come up");
				await new Promise((r) => setTimeout(r, 200));
			}
			// in line with every other push, read from the store at its turn: a revoke made while it came up is in it
			if ((await guarded.egress.configure()) !== "told")
				throw new DockerError("the egress proxy could not be told its config");
			// how the box runs, which decides its confinement: a box made otherwise is made again, never reused
			const run = [
				"--hostname",
				"box",
				"--network",
				inside,
				"--user",
				`${uid}:${gid}`,
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--init",
				"--pids-limit",
				"4096",
				"--memory",
				BOX_MEMORY,
				"--memory-swap",
				BOX_MEMORY,
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,size=1g",
				...Object.entries(VOLUMES).flatMap(([volume, path]) => [
					"--mount",
					`type=volume,src=${name}-${volume},dst=${path}`,
				]),
				"--mount",
				`type=volume,src=${name}-trust,dst=/etc/ssl/certs,readonly`,
				...Object.entries(TRUST_ENV).flatMap(([variable, value]) => ["--env", `${variable}=${value}`]),
				boxTag,
			];
			const first = !started;
			started = true;
			// A daemon that starts takes the box over clean: a process a command detached from its group (setsid, a
			// daemonized server) outlives the pi-env that started it, and would outlive this daemon too.
			await bringUp(name, home, run, first);
		},
	};
}

/** Remove `home`'s box, its proxy, their networks and volumes: everything in it is gone. */
export async function removeContainerBox(home: string): Promise<void> {
	const { box: name, proxy, inside, outside } = boxParts(home);
	await docker(["rm", "--force", name, proxy]).catch(() => undefined);
	await docker(["network", "rm", inside, outside]).catch(() => undefined);
	await docker([
		"volume",
		"rm",
		...[...Object.keys(VOLUMES), ...Object.keys(PROXY_VOLUMES)].map((volume) => `${name}-${volume}`),
	]).catch(() => undefined);
}

/** Whether the daemon of `home` runs now: its `daemon.json` names a process that is alive. */
function daemonAlive(home: string): boolean {
	try {
		const { pid } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { pid?: unknown };
		if (typeof pid !== "number") return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Whether `home` is a throwaway: under the system's temporary folders. */
function temporary(home: string): boolean {
	const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map((root) => resolve(root));
	return roots.some((root) => resolve(home).startsWith(`${root}/`));
}

/**
 * Remove what boxes left behind: every container labelled with a home (`banda.home`) that is gone from disk, with its proxy, its networks and its volumes; with `idle`, also a throwaway
 * home under the temporary folders with no daemon running in it. A home whose daemon runs is never touched, nor one
 * outside the temporary folders that still exists. `idle` is for the owner's own sweep only: a test's box runs with no
 * daemon, so another run's sweep must never take it. Answers the homes swept.
 */
export async function sweepBoxes({ idle = false }: { idle?: boolean } = {}): Promise<string[]> {
	const listed = await docker(["ps", "--all", "--format", '{{.Names}}\t{{.Label "banda.home"}}'], 30_000).catch(
		() => "",
	);
	const byHome = new Map<string, string[]>();
	for (const line of listed.split("\n")) {
		const [name, home] = line.split("\t");
		if (name === undefined || name === "" || home === undefined || home === "") continue;
		byHome.set(home, [...(byHome.get(home) ?? []), name]);
	}
	const swept: string[] = [];
	for (const [home, names] of byHome) {
		if (existsSync(home) && (!idle || !temporary(home) || daemonAlive(home))) continue;
		const bases = [...new Set(names.map((name) => name.replace(/-proxy$/, "")))];
		await docker(["rm", "--force", ...names]).catch(() => undefined);
		for (const base of bases) {
			await docker(["network", "rm", `${base}-in`, `${base}-out`]).catch(() => undefined);
			const volumes = await docker(["volume", "ls", "--quiet", "--filter", `name=^${base}-`]).catch(() => "");
			const named = volumes.split("\n").filter((volume) => volume !== "");
			if (named.length > 0) await docker(["volume", "rm", "--force", ...named]).catch(() => undefined);
		}
		swept.push(home);
	}
	return swept;
}
