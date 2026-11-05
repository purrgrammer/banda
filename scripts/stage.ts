/**
 * `npm run cli:pack` (and the first half of `npm run desktop:pack`): lay out what a release runs, for this computer's
 * platform and architecture, in `release/banda/`:
 *
 *   node/node[.exe]  the official Node.js binary, checked against the release's SHASUMS256.txt
 *   app/             the built daemon and web UI with their runtime dependencies only
 *   bin/banda        the launcher (`bin/banda.cmd` on Windows): the bundled Node runs the bundled CLI
 *
 * With `--archive` it also writes `release/banda-cli-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows). The desktop app
 * carries the same tree in its resources, so the CLI and the app run identical bytes. Run `npm run build` first.
 * Native pieces (resvg's addon, pi-env's binaries) are per platform, so each target is staged on its own machine.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The Node.js every release bundles: exact, an LTS of the major `engines` asks for. */
export const NODE_VERSION = "26.13.0";

export type Target = { readonly platform: NodeJS.Platform; readonly arch: string };

/** The name a target goes by in release file names, as electron-builder names the desktop installers. */
export function targetName({ platform, arch }: Target): string {
	const os = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
	return `${os}-${arch}`;
}

/** The official Node.js archive for a target, as nodejs.org/dist names it. */
export function nodeArchive({ platform, arch }: Target, version = NODE_VERSION): string {
	if (platform === "win32") return `node-v${version}-win-${arch}.zip`;
	if (platform === "darwin" || platform === "linux") return `node-v${version}-${platform}-${arch}.tar.gz`;
	throw new Error(`no Node.js build is bundled for ${platform}`);
}

/** The sha256 SHASUMS256.txt gives `name`; a list without it is refused, never read as "nothing to check". */
export function expectedSum(shasums: string, name: string): string {
	for (const line of shasums.split("\n")) {
		const [sum, file] = line.trim().split(/\s+/);
		if (file === name && sum !== undefined && /^[0-9a-f]{64}$/.test(sum)) return sum;
	}
	throw new Error(`SHASUMS256.txt does not list ${name}`);
}

/** The pi-env binaries a target needs: the box's (always Linux, either architecture) and the host's own. */
export function keepsPiEnv(file: string, { platform, arch }: Target): boolean {
	const os = platform === "win32" ? "windows" : platform;
	return file.startsWith("pi-env-linux-") || file === `pi-env-${os}-${arch}` || file === `pi-env-${os}-${arch}.exe`;
}

/** The POSIX launcher. It follows its own symlinks, so `ln -s …/bin/banda /usr/local/bin/banda` works. */
export const POSIX_LAUNCHER = `#!/bin/sh
# banda: the bundled Node.js runs the bundled CLI.
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case $link in
	/*) self=$link ;;
	*) self=$(dirname "$self")/$link ;;
	esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$root/node/node" "$root/app/dist/cli/index.js" "$@"
`;

export const WINDOWS_LAUNCHER = `@echo off\r
rem banda: the bundled Node.js runs the bundled CLI.\r
"%~dp0..\\node\\node.exe" "%~dp0..\\app\\dist\\cli\\index.js" %*\r
`;

/** What of the checkout a release runs: the build, the box's and proxy's sources it builds images from, the licenses. */
const SHIPPED = [
	"dist",
	"web/dist",
	"box",
	"proxy",
	"package.json",
	"package-lock.json",
	"LICENSE",
	"licenses",
	"THIRD_PARTY_NOTICES.md",
];

const run = (command: string, args: string[], cwd?: string) =>
	execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && command === "npm" });

// Windows' own bsdtar reads and writes zip; Git's GNU tar, often first on a runner's PATH, does neither
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

async function stageApp(root: string, out: string, target: Target): Promise<void> {
	await stat(join(root, "dist", "cli", "index.js")).catch(() => {
		throw new Error("dist/ is missing: run `npm run build` first");
	});
	await stat(join(root, "web", "dist", "index.html")).catch(() => {
		throw new Error("web/dist/ is missing: run `npm run build` first");
	});
	const app = join(out, "app");
	for (const path of SHIPPED) await cp(join(root, path), join(app, path), { recursive: true });
	run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);
	const bin = join(app, "node_modules", "@earendil-works", "pi-env", "bin");
	for (const file of await readdir(bin))
		if (!keepsPiEnv(file, target)) await rm(join(bin, file), { recursive: true, force: true });
}

async function stageNode(out: string, target: Target, cache: string): Promise<void> {
	const name = nodeArchive(target);
	const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
	await mkdir(cache, { recursive: true });
	const archive = join(cache, name);
	const shasums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text();
	const want = expectedSum(shasums, name);
	let bytes = await readFile(archive).catch(() => undefined);
	if (bytes === undefined || sha256(bytes) !== want) {
		bytes = Buffer.from(await (await fetchOk(`${base}/${name}`)).arrayBuffer());
		if (sha256(bytes) !== want) throw new Error(`${name} does not match its SHASUMS256.txt entry`);
		await writeFile(archive, bytes);
	}
	const unpacked = join(cache, `unpacked-${targetName(target)}`);
	await rm(unpacked, { recursive: true, force: true });
	await mkdir(unpacked, { recursive: true });
	run(tar, ["-xf", archive, "-C", unpacked]);
	const top = join(unpacked, name.replace(/\.(tar\.gz|zip)$/, ""));
	const node = join(out, "node");
	await mkdir(node, { recursive: true });
	if (target.platform === "win32") await rename(join(top, "node.exe"), join(node, "node.exe"));
	else await rename(join(top, "bin", "node"), join(node, "node"));
	await rename(join(top, "LICENSE"), join(node, "LICENSE"));
	await rm(unpacked, { recursive: true, force: true });
}

async function stageLaunchers(out: string, target: Target): Promise<void> {
	const bin = join(out, "bin");
	await mkdir(bin, { recursive: true });
	if (target.platform === "win32") await writeFile(join(bin, "banda.cmd"), WINDOWS_LAUNCHER);
	else {
		await writeFile(join(bin, "banda"), POSIX_LAUNCHER);
		await chmod(join(bin, "banda"), 0o755);
	}
}

async function fetchOk(url: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
	return response;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Stage `release/banda/` for this computer, and with `archive`, pack it; returns the archive's path, if any. */
export async function stage(root: string, options: { archive?: boolean } = {}): Promise<string | undefined> {
	const target: Target = { platform: process.platform, arch: process.arch };
	const release = join(root, "release");
	const out = join(release, "banda");
	await rm(out, { recursive: true, force: true });
	await mkdir(out, { recursive: true });
	await stageApp(root, out, target);
	await stageNode(out, target, join(release, "cache"));
	await stageLaunchers(out, target);
	const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
	console.log(`staged banda ${version} for ${targetName(target)} in ${out}`);
	if (!options.archive) return undefined;
	const extension = target.platform === "win32" ? "zip" : "tar.gz";
	const archive = join(release, `banda-cli-${version}-${targetName(target)}.${extension}`);
	await rm(archive, { force: true });
	run(
		tar,
		target.platform === "win32"
			? ["-a", "-cf", archive, "-C", release, "banda"]
			: ["-czf", archive, "-C", release, "banda"],
	);
	console.log(`packed ${archive}`);
	return archive;
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { archive: { type: "boolean" } } });
	await stage(join(import.meta.dirname, ".."), { archive: values.archive ?? false });
}
