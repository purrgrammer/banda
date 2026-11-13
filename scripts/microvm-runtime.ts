import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fileSha256,
	MICROSANDBOX_VERSION,
	MICROVM_PLATFORMS,
	MICROVM_SOURCE,
	type MicrovmRuntimeBuild,
	type MicrovmTarget,
} from "../src/box/microvm-assets.ts";

const defaultCache = resolve(import.meta.dirname, "../release/cache/computer/runtime");
const patch = fileURLToPath(new URL("microvm-runtime.patch", import.meta.url));
const componentNames = ["rustc", "cargo", "rust-std"] as const;
const timeout = 60 * 60 * 1000;

function command(
	program: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): string {
	const output = execFileSync(program, [...args], {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		stdio: options.inherit ? "inherit" : "pipe",
		maxBuffer: 32 << 20,
		timeout,
		killSignal: "SIGKILL",
	});
	return output?.trim() ?? "";
}

async function ownDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const entry = await lstat(path);
	if (
		!entry.isDirectory() ||
		entry.isSymbolicLink() ||
		(entry.mode & 0o022) !== 0 ||
		(process.getuid !== undefined && entry.uid !== process.getuid())
	)
		throw new Error(`The native build directory must be owned and not writable by others: ${path}`);
}

async function download(path: string, url: string, expected: string): Promise<void> {
	if ((await fileSha256(path).catch(() => "")) === expected) return;
	const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Native runtime input ${url}: HTTP ${response.status}`);
	const temporary = `${path}.${randomUUID()}.partial`;
	try {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: "wx", mode: 0o600 });
		if ((await fileSha256(temporary)) !== expected) throw new Error(`Native runtime input failed SHA-256: ${url}`);
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function rustComponent(
	directory: string,
	component: (typeof componentNames)[number],
	target: string,
): Promise<{ archive: string; sha256: string }> {
	const name = `${component}-${MICROVM_SOURCE.rust}-${target}.tar.xz`;
	const url = `https://static.rust-lang.org/dist/${name}`;
	const response = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`Rust checksum ${url}: HTTP ${response.status}`);
	const checksum = await response.text();
	if (checksum.length > 4096) throw new Error("The Rust component checksum is too large.");
	const expected = checksum.trim().split(/\s+/)[0];
	if (expected === undefined || !/^[a-f0-9]{64}$/.test(expected))
		throw new Error("The Rust component checksum is invalid.");
	const archive = join(directory, name);
	await download(archive, url, expected);
	return { archive, sha256: expected };
}

async function installRust(
	work: string,
	components: readonly { archive: string; sha256: string }[],
	target: string,
): Promise<string> {
	const inputs = join(work, "rust-inputs");
	await mkdir(inputs);
	const prefix = join(work, "toolchain");
	for (const component of components) {
		if ((await fileSha256(component.archive)) !== component.sha256) throw new Error("A verified Rust archive changed.");
		command("tar", ["-xJf", component.archive, "-C", inputs]);
		const name = component.archive.slice(component.archive.lastIndexOf("/") + 1).replace(/\.tar\.xz$/, "");
		command("sh", [join(inputs, name, "install.sh"), `--prefix=${prefix}`, "--disable-ldconfig"]);
	}
	if (target === "aarch64-apple-darwin") {
		const library = join(prefix, "lib/libLLVM.dylib");
		if ((await lstat(library).catch(() => undefined))?.isFile()) {
			const relative = join(prefix, `lib/rustlib/${target}/lib/libLLVM.dylib`);
			if ((await lstat(relative).catch(() => undefined)) === undefined)
				await symlink("../../../libLLVM.dylib", relative);
		}
	}
	return prefix;
}

function verifyCli(binary: string, env: NodeJS.ProcessEnv): void {
	if (command(binary, ["--version"], { env }) !== `msb ${MICROSANDBOX_VERSION}`)
		throw new Error("The produced native runtime has the wrong version.");
	if (!command(binary, ["exec", "--help"], { env }).includes("--require-running"))
		throw new Error("The produced native runtime cannot borrow an existing VM.");
}

export async function buildMicrovmRuntime({
	bundle,
	target,
	cache = defaultCache,
}: {
	bundle: string;
	target: MicrovmTarget;
	cache?: string;
}): Promise<MicrovmRuntimeBuild> {
	const cacheRoot = resolve(cache);
	const platform = MICROVM_PLATFORMS[target];
	if (
		process.arch !== platform.arch ||
		(target === "darwin-arm64" ? process.platform !== "darwin" : process.platform !== "linux")
	)
		throw new Error("The native runtime must be packaged on its own operating system and CPU.");
	await ownDirectory(cacheRoot);
	const downloads = join(cacheRoot, "downloads");
	await ownDirectory(downloads);
	const sourceArchive = join(downloads, `microsandbox-${MICROVM_SOURCE.commit}.tar.gz`);
	await download(
		sourceArchive,
		`https://codeload.github.com/superradcompany/microsandbox/tar.gz/${MICROVM_SOURCE.commit}`,
		MICROVM_SOURCE.archiveSha256,
	);
	const agentd = join(downloads, platform.agentd.asset);
	await download(
		agentd,
		`https://github.com/superradcompany/microsandbox/releases/download/v${MICROSANDBOX_VERSION}/${platform.agentd.asset}`,
		platform.agentd.sha256,
	);
	const components = await Promise.all(
		componentNames.map((component) => rustComponent(downloads, component, platform.rustTarget)),
	);
	const [rustc, cargo, std] = components;
	if (rustc === undefined || cargo === undefined || std === undefined)
		throw new Error("The Rust toolchain is incomplete.");
	const patchSha256 = await fileSha256(patch);
	const recipeSha256 = await fileSha256(fileURLToPath(import.meta.url));
	const environment: MicrovmRuntimeBuild["environment"] =
		"manylinux" in platform
			? { platform: "linux", image: platform.manylinux, glibc: "2.28" }
			: { platform: "darwin", minimumVersion: "14.0" };
	const identity = {
		source: MICROVM_SOURCE,
		platform,
		patchSha256,
		recipeSha256,
		target,
		components: components.map((entry) => entry.sha256),
	};
	const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
	const cargoHome = join(cacheRoot, "cargo");
	const targetDirectory = join(cacheRoot, "targets", key);
	await ownDirectory(cargoHome);
	await ownDirectory(targetDirectory);
	const work = await mkdtemp(join(cacheRoot, "build-"));
	try {
		if ((await fileSha256(sourceArchive)) !== MICROVM_SOURCE.archiveSha256)
			throw new Error("A verified runtime source archive changed.");
		command("tar", ["-xzf", sourceArchive, "-C", work]);
		const source = join(work, `microsandbox-${MICROVM_SOURCE.commit}`);
		if ((await fileSha256(join(source, "Cargo.lock"))) !== MICROVM_SOURCE.lockSha256)
			throw new Error("The native runtime lockfile differs from its pinned source.");
		command("patch", ["--batch", "--fuzz=0", "-p1", "-i", patch], { cwd: source });
		if ((await fileSha256(join(source, "Cargo.lock"))) !== MICROVM_SOURCE.lockSha256)
			throw new Error("The runtime patch changed its locked dependency graph.");
		const embeds = join(work, "embeds");
		await mkdir(embeds);
		if ((await fileSha256(agentd)) !== platform.agentd.sha256) throw new Error("The embedded guest agent changed.");
		await copyFile(agentd, join(embeds, "agentd"));
		if ((await fileSha256(join(bundle, platform.firmware))) !== platform.firmwareSha256)
			throw new Error("The verified firmware changed.");
		await copyFile(join(bundle, platform.firmware), join(embeds, platform.firmware));
		await chmod(join(embeds, "agentd"), 0o755);
		const prefix = await installRust(work, components, platform.rustTarget);
		const binary = join(work, "msb");
		const buildArgs = [
			"build",
			"--locked",
			"--release",
			"--no-default-features",
			"--features",
			MICROVM_SOURCE.features,
			"--target",
			platform.rustTarget,
			"-p",
			"microsandbox-cli",
		];
		const env = {
			PATH: `${join(prefix, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`,
			CARGO_HOME: cargoHome,
			CARGO_TARGET_DIR: targetDirectory,
			CARGO_BUILD_JOBS: "2",
			CARGO_INCREMENTAL: "0",
			MSB_EMBED_ARTIFACTS_DIR: embeds,
			MSB_HOME: join(work, "msb-home"),
			MACOSX_DEPLOYMENT_TARGET: "14.0",
		};
		if (target === "darwin-arm64") {
			if (!command(join(prefix, "bin/rustc"), ["--version"], { env }).startsWith(`rustc ${MICROVM_SOURCE.rust} `))
				throw new Error("The native runtime compiler has the wrong version.");
			command(join(prefix, "bin/cargo"), buildArgs, { cwd: source, env, inherit: true });
			await copyFile(join(targetDirectory, platform.rustTarget, "release/msb"), binary);
			command("/usr/bin/codesign", [
				"--force",
				"--sign",
				"-",
				"--entitlements",
				join(source, "msb-entitlements.plist"),
				binary,
			]);
			command("/usr/bin/codesign", ["--verify", "--strict", binary]);
			const entitlements = command("/usr/bin/codesign", ["-d", "--entitlements", ":-", binary]);
			for (const name of ["com.apple.security.hypervisor", "com.apple.security.cs.disable-library-validation"])
				if (!entitlements.includes(`<key>${name}</key><true/>`)) throw new Error(`The built runtime lacks ${name}.`);
			const libraries = command("/usr/bin/otool", ["-L", binary]);
			for (const line of libraries.split("\n").slice(1))
				if (line.trim() !== "" && !/^\s*\/(?:usr\/lib|System\/Library)\//.test(line))
					throw new Error(`The runtime depends on a non-system library: ${line}`);
			verifyCli(binary, env);
		} else {
			if (!("manylinux" in platform)) throw new Error("The Linux runtime has no baseline builder.");
			const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
			const script = [
				"set -euo pipefail",
				`trap 'chown -R ${owner} /work /cache' EXIT`,
				"dnf install -y libcap-ng-devel",
				"export PATH=/work/toolchain/bin:/usr/local/bin:/usr/bin:/bin",
				"export CARGO_HOME=/cache/cargo CARGO_TARGET_DIR=/cache/target CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0",
				"export MSB_HOME=/work/msb-home MSB_EMBED_ARTIFACTS_DIR=/work/embeds",
				`test "$(rustc --version | cut -d' ' -f2)" = ${MICROVM_SOURCE.rust}`,
				`cd /work/microsandbox-${MICROVM_SOURCE.commit}`,
				`cargo ${buildArgs.join(" ")}`,
				`cp /cache/target/${platform.rustTarget}/release/msb /work/msb`,
				`python3 scripts/ci/validate_linux_glibc.py --max-version 2.28 /work/msb /work/embeds/agentd /work/embeds/${platform.firmware}`,
				`python3 scripts/smoke/cli/runtime-discovery.py --msb /work/msb --libkrunfw /work/embeds/${platform.firmware}`,
			].join("\n");
			const container = `banda-native-build-${randomUUID()}`;
			try {
				command(
					"docker",
					[
						"run",
						"--rm",
						"--name",
						container,
						"--volume",
						`${work}:/work`,
						"--volume",
						`${cargoHome}:/cache/cargo`,
						"--volume",
						`${targetDirectory}:/cache/target`,
						platform.manylinux,
						"bash",
						"-c",
						script,
					],
					{ inherit: true },
				);
			} catch (error) {
				if (error instanceof Error && "signal" in error && error.signal !== null) {
					try {
						execFileSync("docker", ["rm", "--force", container], {
							stdio: "ignore",
							timeout: 30_000,
							killSignal: "SIGKILL",
						});
					} catch (cleanup) {
						throw new AggregateError(
							[error, cleanup],
							"The native build was interrupted and its owned container could not be removed.",
						);
					}
				}
				throw error;
			}
			verifyCli(binary, {
				PATH: "/usr/bin:/bin",
				MSB_HOME: join(work, "msb-home"),
				MSB_LIBKRUNFW_PATH: join(embeds, platform.firmware),
			});
		}
		if ((await fileSha256(join(source, "Cargo.lock"))) !== MICROVM_SOURCE.lockSha256)
			throw new Error("The runtime build changed its locked dependency graph.");
		if (
			(await fileSha256(patch)) !== patchSha256 ||
			(await fileSha256(fileURLToPath(import.meta.url))) !== recipeSha256
		)
			throw new Error("The native runtime patch or producer changed during compilation.");
		await copyFile(binary, join(bundle, "msb"));
		await chmod(join(bundle, "msb"), 0o755);
		return {
			execution: "require-running",
			source: { commit: MICROVM_SOURCE.commit, sha256: MICROVM_SOURCE.archiveSha256 },
			patchSha256,
			lockSha256: MICROVM_SOURCE.lockSha256,
			recipeSha256,
			environment,
			compiler: {
				version: MICROVM_SOURCE.rust,
				target: platform.rustTarget,
				rustc: rustc.sha256,
				cargo: cargo.sha256,
				std: std.sha256,
			},
			agentdSha256: platform.agentd.sha256,
			features: MICROVM_SOURCE.features,
		};
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}
