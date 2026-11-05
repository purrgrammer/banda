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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { EgressControl, HeldRequest, Replayed, Taken } from "../core/egress.ts";
import type { BoxEgress, BoxSetup, EgressConfig } from "./box.ts";
import { configPusher } from "./egress-config.ts";

const DOCKERFILE = fileURLToPath(new URL("../../box/Dockerfile", import.meta.url));
const PROXY = fileURLToPath(new URL("../../proxy/", import.meta.url));

export class DockerError extends Error {}

function docker(args: readonly string[], timeoutMs = 60_000, input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("docker", args, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
			if (error === null) resolve(stdout.trim());
			else
				reject(
					new DockerError(
						`docker ${args[0]}: ${(stderr.trim() || error.message).split("\n").at(-1) || "it did not answer in time"}`,
					),
				);
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

/** Whether a Docker (or Podman's docker) server answers. */
export async function dockerAvailable(): Promise<boolean> {
	try {
		await docker(["version", "--format", "{{.Server.Version}}"], 5_000);
		return true;
	} catch {
		return false;
	}
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
/** What a command in the box reaches without the proxy: the box's own loopback, nothing else. */
const LOOPBACK = "localhost,127.0.0.1,::1";
/** Where the box finds the one authority it trusts; the variables toolchains read it from. */
const TRUST = "/etc/ssl/certs/ca-certificates.crt";
const TRUST_ENV = {
	SSL_CERT_FILE: TRUST,
	SSL_CERT_DIR: "/etc/ssl/certs",
	CURL_CA_BUNDLE: TRUST,
	REQUESTS_CA_BUNDLE: TRUST,
	NODE_EXTRA_CA_CERTS: TRUST,
	NODE_OPTIONS: "--use-openssl-ca",
	GIT_SSL_CAINFO: TRUST,
	PIP_CERT: TRUST,
	CARGO_HTTP_CAINFO: TRUST,
	DENO_CERT: TRUST,
	AWS_CA_BUNDLE: TRUST,
} as const;

/** An image built from `files` in a folder of their own, tagged by their hash; built only when missing. */
async function build(repository: string, files: { readonly [name: string]: string }): Promise<string> {
	const hash = createHash("sha256");
	for (const [name, path] of Object.entries(files).sort()) {
		hash.update(name);
		hash.update(await readFile(path));
	}
	const tag = `${repository}:${hash.digest("hex").slice(0, 12)}`;
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
		await docker(["build", "--quiet", "--tag", tag, context], 20 * 60_000);
	} finally {
		await rm(context, { recursive: true, force: true });
	}
	return tag;
}

/** The box's image: the Dockerfile and the pi-env daemon it carries. */
async function boxImage(): Promise<string> {
	const arch = await docker(["version", "--format", "{{.Server.Arch}}"], 10_000);
	const daemon = packagedDaemon({ platform: "linux", arch: arch === "arm64" || arch === "aarch64" ? "arm64" : "x64" });
	return build("banda-box", { Dockerfile: DOCKERFILE, "pi-env": daemon });
}

/** The proxy's image: mitmproxy, pinned, with the policy addon and the control script. */
async function proxyImage(): Promise<string> {
	const files: { [name: string]: string } = {};
	for (const name of (await readdir(PROXY)).filter((n) => n === "Dockerfile" || n.endsWith(".py")).sort())
		if (!name.startsWith("test_")) files[name] = join(PROXY, name);
	return build("banda-proxy", files);
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

/** The key the daemon marks proxy logins with, made once, kept in `auth/` beside the owner's token. */
function egressKey(home: string): string {
	const path = join(home, "auth", "egress.key");
	try {
		const key = readFileSync(path, "utf8").trim();
		if (/^[0-9a-f]{64}$/.test(key)) return key;
	} catch {
		// not made yet
	}
	mkdirSync(join(home, "auth"), { recursive: true, mode: 0o700 });
	const key = randomBytes(32).toString("hex");
	writeFileSync(path, `${key}\n`, { mode: 0o600 });
	return key;
}

/** The password of chat `chat`'s proxy login (0: nobody's, the daemon's own listing, which only reads), as the proxy checks it. */
export function proxyMark(key: string, chat: number): string {
	return createHmac("sha256", Buffer.from(key, "hex")).update(`banda-egress:c${chat}`).digest("hex").slice(0, 32);
}

/** Agent `agent`'s browser's proxy login, which the proxy maps to the chat holding that browser. */
export const browserLogin = (agent: string) => `b-${agent}`;

/**
 * What agent `agent`'s browser tab of chat `chat` stamps its requests with (`TAB_HEADER`): the chat and its mark for that
 * agent and chat, which only the
 * daemon makes, so a page never names a chat; the proxy takes the request as that chat's, from that agent's browser alone.
 */
export function tabStamp(key: string, agent: string, chat: number): string {
	const mark = createHmac("sha256", Buffer.from(key, "hex"))
		.update(`banda-egress:t${agent}:${chat}`)
		.digest("hex")
		.slice(0, 32);
	return `${chat}.${mark}`;
}

/** The password of agent `agent`'s browser's proxy login, as the proxy checks it. */
export function browserMark(key: string, agent: string): string {
	return createHmac("sha256", Buffer.from(key, "hex"))
		.update(`banda-egress:${browserLogin(agent)}`)
		.digest("hex")
		.slice(0, 32);
}

/**
 * The browsers' own uid in the box, and their volume, which only that uid reads: the agent's commands run as another, so
 * they never read a browser's sessions, its cache, its memory or the login it answers the proxy with. Each agent's
 * browser has a directory of its own there, its profile and its trust store in it.
 */
const BROWSER_UID = 65533;
const BROWSER_HOME = "/browser";
const browserRoot = (agent: string) => `${BROWSER_HOME}/agents/${agent}`;
/** Settings that keep what the owner types out of the profile: no saved passwords, no autofill, no restored session. */
const PREFERENCES = JSON.stringify({
	credentials_enable_service: false,
	credentials_enable_autosignin: false,
	profile: { password_manager_enabled: false },
	autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
	session: { restore_on_startup: 5 },
	// Chromium's own sign-in to Google sends requests of its own (accounts.google.com) that are nobody's
	signin: { allowed: false },
	browser: { enable_spellchecking: false },
	search: { suggest_enabled: false },
});

/**
 * Agent `agent`'s Chromium's start in the box, as the browsers' uid: the browser of this agent the box left running (a
 * daemon that died) closed first, never another agent's, its settings set, the proxy's authority put in its trust
 * store, then Chromium, headless, with DevTools on the pipe its stdin and stdout become, through the proxy. Its sandbox
 * needs privileges the box drops, so it runs without one: the container and its uid are the boundary. Site isolation
 * is off, so a page and its frames are one tree the daemon reads and masks in one place. `agent` is an agent's id
 * (lowercase words and dashes), safe in the script as it is.
 */
const browserStart = (agent: string) => {
	const PROFILE = `${browserRoot(agent)}/profile`;
	// only this agent's: a chromium whose command line names this profile
	const mine = `tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "--user-data-dir=${PROFILE} "`;
	return [
		"set -e",
		"umask 077",
		`export HOME=${browserRoot(agent)}/home`,
		`for i in 1 2 3 4 5 6 7 8 9 10; do found=; for pid in $(pgrep -x chromium || true); do if ${mine}; then kill "$pid" 2>/dev/null || true; found=1; fi; done; [ -n "$found" ] || break; sleep 0.3; done`,
		`mkdir -p ${PROFILE}/Default "$HOME/.pki/nssdb"`,
		`rm -f ${PROFILE}/Singleton*`,
		`prefs=${PROFILE}/Default/Preferences`,
		`if [ -s "$prefs" ] && jq -e . "$prefs" >/dev/null 2>&1; then jq '. * ${PREFERENCES}' "$prefs" > "$prefs.new"; else echo '${PREFERENCES}' > "$prefs.new"; fi`,
		'mv "$prefs.new" "$prefs"',
		'[ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password',
		'certutil -d "sql:$HOME/.pki/nssdb" -D -n banda >/dev/null 2>&1 || true',
		`certutil -d "sql:$HOME/.pki/nssdb" -A -n banda -t C,, -i ${TRUST}`,
		"exec 3<&0 4>&1 1>&2",
		[
			"exec chromium --headless=new --remote-debugging-pipe --no-sandbox --disable-dev-shm-usage",
			`--user-data-dir=${PROFILE} --proxy-server=http://proxy:${PROXY_PORT} --no-first-run --no-default-browser-check`,
			"--disable-background-networking --disable-component-update --disable-sync --disable-breakpad",
			"--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,AccountConsistency",
			"--disable-site-isolation-trials --password-store=basic --use-mock-keychain --window-size=1280,800",
			// every tab runs as if in front: a chat's page in a tab behind another's is never slowed or left unpainted
			"--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
			"--hide-scrollbars --mute-audio about:blank",
		].join(" "),
	].join("\n");
};

/** The proxy's control script, run in the proxy container: what it printed, as JSON. */
async function control<T>(proxy: string, args: readonly string[], input?: unknown, timeoutMs = 30_000): Promise<T> {
	const out = await docker(
		["exec", ...(input === undefined ? [] : ["--interactive"]), proxy, "python3", "/banda/ctl.py", ...args],
		timeoutMs,
		input === undefined ? undefined : JSON.stringify(input),
	);
	return JSON.parse(out.split("\n").at(-1) ?? "null") as T;
}

export function containerBox(home: string): BoxSetup {
	const { box: name, proxy, inside, outside } = boxParts(home);
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	// whether this process brought the box up already
	let started = false;
	const key = egressKey(home);
	let source: (() => Promise<Omit<EgressConfig, "key">>) | undefined;
	const configure = configPusher({
		running: async () =>
			(await docker(["container", "inspect", "--format", "{{.State.Running}}", proxy], 10_000).catch(
				(error: unknown) => {
					// a proxy that was never made runs nowhere; anything else is not known
					if (String(error).includes("No such")) return "false";
					throw error;
				},
			)) === "true",
		read: async () => ({ key, ...(source === undefined ? {} : await source()) }),
		send: async (config, generation) => {
			const answered = await control<{ stale?: number }>(proxy, ["config"], { ...config, generation });
			if (answered.stale !== undefined)
				throw new DockerError(`the proxy holds a later config (generation ${answered.stale})`);
		},
		// killed, its tmpfs and the config in it go: brought up again, it holds everything until it is told
		halt: async () => {
			await docker(["kill", proxy], 20_000);
		},
	});
	const egress: BoxEgress = {
		env: (chat): Record<string, string> => {
			const url = `http://c${chat}:${proxyMark(key, chat)}@proxy:${PROXY_PORT}`;
			return {
				http_proxy: url,
				https_proxy: url,
				HTTP_PROXY: url,
				HTTPS_PROXY: url,
				ALL_PROXY: url,
				all_proxy: url,
				// the box's own loopback is the box: a server a command starts there (a project's tests) is reached
				// directly; anything else, the box's other addresses included, goes through the proxy
				NO_PROXY: LOOPBACK,
				no_proxy: LOOPBACK,
				NODE_USE_ENV_PROXY: "1",
			};
		},
		source: (from) => {
			source = from;
		},
		configure,
		pass: async (chat, hash) => {
			await control(proxy, ["pass", String(chat), hash]);
		},
		take: (chat: number, _ctx: Context) => control<Taken>(proxy, ["take", String(chat)]),
		sentChats: (_ctx: Context) => control<number[]>(proxy, ["sent"]),
		ack: async (chat, readBytes, tickets, _ctx) => {
			await control(proxy, ["ack", String(chat), String(readBytes), ...tickets]);
		},
		replay: (request: HeldRequest, _ctx: Context) => control<Replayed>(proxy, ["replay"], request, 120_000),
	} satisfies BoxEgress & EgressControl;
	return {
		workspace: VOLUMES.workspace,
		attachments: `${VOLUMES.work}/attachments`,
		command: ["docker", "exec", "--interactive", name, "/usr/local/bin/pi-env"],
		egress,
		browser: (agent) => ({
			command: [
				"docker",
				"exec",
				"--interactive",
				"--user",
				`${BROWSER_UID}:${BROWSER_UID}`,
				"--env",
				`HOME=${browserRoot(agent)}/home`,
				name,
				"/bin/sh",
				"-c",
				browserStart(agent),
			],
			login: { username: browserLogin(agent), password: browserMark(key, agent) },
			stamp: (chat) => tabStamp(key, agent, chat),
		}),
		ensure: async () => {
			const [boxTag, proxyTag] = await Promise.all([boxImage(), proxyImage()]);
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
				const ping = await control<{ up: boolean }>(proxy, ["ping"]).catch(() => ({ up: false }));
				if (ping.up) break;
				if (Date.now() > deadline) throw new DockerError("the egress proxy did not come up");
				await new Promise((r) => setTimeout(r, 200));
			}
			// in line with every other push, read from the store at its turn: a revoke made while it came up is in it
			if ((await configure()) !== "told") throw new DockerError("the egress proxy could not be told its config");
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
 * Remove what boxes left behind: every container labelled with a home (`banda.home`, and the earlier name's
 * `sancho.home`) that is gone from disk, with its proxy, its networks and its volumes; with `idle`, also a throwaway
 * home under the temporary folders with no daemon running in it. A home whose daemon runs is never touched, nor one
 * outside the temporary folders that still exists. `idle` is for the owner's own sweep only: a test's box runs with no
 * daemon, so another run's sweep must never take it. Answers the homes swept.
 */
export async function sweepBoxes({ idle = false }: { idle?: boolean } = {}): Promise<string[]> {
	const listed = await docker(
		["ps", "--all", "--format", '{{.Names}}\t{{.Label "banda.home"}}{{.Label "sancho.home"}}'],
		30_000,
	).catch(() => "");
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
