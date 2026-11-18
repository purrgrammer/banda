import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const root = resolve(import.meta.dirname, "..");
const required = ["pull", "create", "start", "inventory", "update", "plan", "install", "installed", "node", "electron"];
const Completion = Type.Object({
	role: Type.String(),
	status: Type.Union([Type.Integer(), Type.Null()]),
	signal: Type.Union([Type.String(), Type.Null()]),
	error: Type.Union([Type.String(), Type.Null()]),
	stdout: Type.String(),
	stderr: Type.String(),
});
const Identity = Type.Object({
	sourceCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	packageName: Type.String({ pattern: "^banda-[a-zA-Z0-9.+-]+-linux-amd64\\.deb$" }),
	packageSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	baseImage: Type.String({ pattern: "^debian:bookworm-slim@sha256:[a-f0-9]{64}$" }),
});
const Result = Type.Object({
	...Identity.properties,
	container: Type.String({ pattern: "^banda-dependency-smoke-[a-f0-9-]{36}$" }),
	dependencySmokePassed: Type.Boolean(),
	desktopQualified: Type.Literal(false),
	publicDelivery: Type.Literal(false),
	nativeQualified: Type.Literal(false),
	commands: Type.Array(Completion),
	cleanup: Type.Union([Type.Literal("removed"), Type.Literal("absent"), Type.Literal("failed")]),
	originalFailure: Type.Union([Type.String(), Type.Null()]),
	cleanupFailure: Type.Union([Type.String(), Type.Null()]),
	interrupted: Type.Union([Type.String(), Type.Null()]),
});
type Completion = Static<typeof Completion>;
type Result = Static<typeof Result>;
const succeeded = (command: Completion) => command.status === 0 && command.signal === null && command.error === null;

export function assertLinuxLoaderOutput(output: { stdout: string; stderr: string }) {
	assert.ok(output.stdout.trim(), "The loader did not report dependencies");
	assert.doesNotMatch(output.stdout, /=>\s+not found(?:\r?\n|$)/, "The loader reported a missing library");
	assert.equal(output.stderr, "", "The loader reported dependency errors");
}

export function parseLinuxPackageResult(value: unknown, expected: Static<typeof Identity>): Result {
	assert.ok(Value.Check(Identity, expected), "Unknown expected package or source identity");
	assert.ok(Value.Check(Result, value), "Invalid package dependency evidence");
	for (const key of ["sourceCommit", "packageName", "packageSha256", "baseImage"] as const)
		assert.equal(value[key], expected[key], `Mismatched ${key}`);
	const completed = value.commands.slice(0, required.length);
	const passed =
		completed.length === required.length &&
		completed.every((command, index) => command.role === required[index] && succeeded(command)) &&
		value.commands
			.slice(required.length)
			.map((command) => command.role)
			.join(",") === "cleanup-remove,cleanup-confirm" &&
		value.commands.every(succeeded) &&
		value.cleanup === "removed" &&
		value.originalFailure === null &&
		value.cleanupFailure === null &&
		value.interrupted === null;
	assert.equal(value.dependencySmokePassed, passed, "Dependency pass disagrees with retained evidence");
	return value;
}

async function sha256(path: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function main() {
	assert.equal(process.env.CI, "true", "This check runs only in CI");
	assert.equal(process.platform, "linux");
	assert.equal(process.arch, "x64");
	assert.notEqual(process.getuid?.(), 0, "Run the host checker as the ordinary CI user");
	const [input, destination, ...extra] = process.argv.slice(2);
	assert.ok(
		input && destination && extra.length === 0,
		"Usage: node scripts/verify-linux-package.ts <actual.deb> <fresh-output>",
	);
	const sourceCommit = process.env.GITHUB_SHA;
	assert.ok(sourceCommit && /^[a-f0-9]{40}$/.test(sourceCommit), "Missing source commit");
	assert.equal(
		execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 }).trim(),
		sourceCommit,
	);
	const candidate = resolve(input);
	assert.equal(await realpath(candidate), candidate, "The candidate must not use symlinks");
	assert.ok((await lstat(candidate)).isFile(), "The candidate must be a regular file");
	assert.ok(!candidate.includes(",") && !candidate.includes("\n"), "Invalid mount path");
	const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const Package = Type.Object({ version: Type.String() });
	assert.ok(Value.Check(Package, metadata));
	assert.equal(basename(candidate), `banda-${metadata.version}-linux-amd64.deb`);
	const dockerfile = await readFile(join(root, "box/Dockerfile"), "utf8");
	const images = [...dockerfile.matchAll(/^FROM (debian:bookworm-slim@sha256:[a-f0-9]{64}) AS packages$/gm)];
	assert.equal(images.length, 1, "Expected one pinned Debian base in box/Dockerfile");
	const baseImage = images[0]?.[1];
	assert.ok(baseImage);
	const identity = {
		sourceCommit,
		packageName: basename(candidate),
		packageSha256: await sha256(candidate),
		baseImage,
	};
	assert.ok(Value.Check(Identity, identity));
	const output = resolve(destination);
	await mkdir(output, { mode: 0o700 });
	const token = randomUUID();
	const container = `banda-dependency-smoke-${token}`;
	const label = `io.banda.dependency-smoke=${token}`;
	const result: Result = {
		...identity,
		container,
		dependencySmokePassed: false,
		desktopQualified: false,
		publicDelivery: false,
		nativeQualified: false,
		commands: [],
		cleanup: "failed",
		originalFailure: null,
		cleanupFailure: null,
		interrupted: null,
	};
	let child: ChildProcess | undefined;
	let cleaning = false;
	let createdId: string | undefined;
	let createAttempted = false;
	const interrupt = (signal: NodeJS.Signals) => {
		result.interrupted ??= signal;
		if (!cleaning) child?.kill("SIGKILL");
	};
	const onTerm = () => interrupt("SIGTERM");
	const onInt = () => interrupt("SIGINT");
	process.on("SIGTERM", onTerm);
	process.on("SIGINT", onInt);
	async function run(role: string, args: string[], timeout = 30_000) {
		assert.ok(cleaning || result.interrupted === null, "Check interrupted");
		const stdout = `${String(result.commands.length).padStart(2, "0")}-${role}.stdout.log`;
		const stderr = `${String(result.commands.length).padStart(2, "0")}-${role}.stderr.log`;
		const out = openSync(join(output, stdout), "wx", 0o600);
		const err = openSync(join(output, stderr), "wx", 0o600);
		let launchError: string | null = null;
		try {
			const completion = await new Promise<Completion>((resolve) => {
				child = spawn("docker", args, { stdio: ["ignore", out, err], timeout, killSignal: "SIGKILL" });
				child.on("error", (error) => {
					launchError = error.message;
				});
				child.on("close", (status, signal) => resolve({ role, status, signal, error: launchError, stdout, stderr }));
			});
			result.commands.push(completion);
			assert.ok(succeeded(completion), `${role} failed; see ${stdout} and ${stderr}`);
			return (await readFile(join(output, stdout), "utf8")).trim();
		} finally {
			child = undefined;
			closeSync(out);
			closeSync(err);
		}
	}
	const exec = (role: string, command: string[], timeout?: number) =>
		run(role, ["exec", container, ...command], timeout);
	try {
		await writeFile(join(output, "result.json"), JSON.stringify(parseLinuxPackageResult(result, identity), null, 2));
		await run("pull", ["pull", "--platform", "linux/amd64", baseImage], 300_000);
		createAttempted = true;
		createdId = await run("create", [
			"create",
			"--name",
			container,
			"--label",
			label,
			"--platform",
			"linux/amd64",
			"--mount",
			`type=bind,source=${candidate},target=/candidate.deb,readonly`,
			baseImage,
			"/bin/sleep",
			"1800",
		]);
		assert.match(createdId, /^[a-f0-9]{64}$/, "Invalid created container identity");
		await run("start", ["start", container]);
		const inventory = await exec("inventory", [
			"/bin/sh",
			"-ec",
			`
sha256sum /candidate.deb
cat /etc/os-release /etc/apt/sources.list.d/debian.sources
dpkg-deb --field /candidate.deb
test "$(dpkg-deb --field /candidate.deb Package)" = banda-desktop
test "$(dpkg-deb --field /candidate.deb Architecture)" = amd64
dpkg-query -W -f='\${Package}\t\${Version}\n'
`,
		]);
		assert.ok(inventory.startsWith(`${identity.packageSha256}  /candidate.deb\n`), "Mounted package hash differs");
		await exec("update", ["apt-get", "update"], 300_000);
		await exec("plan", ["apt-get", "--simulate", "--no-install-recommends", "install", "/candidate.deb"], 60_000);
		await exec(
			"install",
			[
				"/usr/bin/env",
				"DEBIAN_FRONTEND=noninteractive",
				"apt-get",
				"-y",
				"--no-install-recommends",
				"-o",
				"Dpkg::Use-Pty=0",
				"install",
				"/candidate.deb",
			],
			600_000,
		);
		await exec("installed", [
			"/bin/sh",
			"-ec",
			`
test "$(dpkg-query -W -f='\${Status}' banda-desktop)" = 'install ok installed'
dpkg-query -W -f='\${Package}\t\${Version}\t\${Status}\n'
cat /var/log/dpkg.log /var/log/apt/history.log
`,
		]);
		for (const [role, binary] of [
			["node", "/opt/banda/resources/banda/node/node"],
			["electron", "/opt/banda/banda-desktop"],
		]) {
			const stdout = await run(role, [
				"exec",
				"--user",
				"1000:1000",
				container,
				"/usr/bin/env",
				"-i",
				"HOME=/tmp",
				"PATH=/usr/bin:/bin",
				"LANG=C.UTF-8",
				"/lib64/ld-linux-x86-64.so.2",
				"--list",
				binary,
			]);
			const completion = result.commands.at(-1);
			assert.ok(completion);
			assertLinuxLoaderOutput({ stdout, stderr: await readFile(join(output, completion.stderr), "utf8") });
		}
		assert.equal(await sha256(candidate), identity.packageSha256, "Candidate changed during the check");
	} catch (error) {
		result.originalFailure = String(error);
	} finally {
		cleaning = true;
		try {
			const filters = ["--filter", `name=^/${container}$`, "--filter", `label=${label}`];
			const owned = createdId ?? (await run("cleanup-find", ["ps", "--all", "--quiet", "--no-trunc", ...filters]));
			if (owned === "") {
				result.cleanup = "absent";
				assert.ok(!createAttempted, "Create completion is unknown; absence does not establish cleanup");
			} else {
				assert.match(owned, /^[a-f0-9]{64}$/, "Container ownership is ambiguous");
				await run("cleanup-remove", ["rm", "--force", owned]);
				assert.equal(
					await run("cleanup-confirm", ["ps", "--all", "--quiet", "--no-trunc", ...filters]),
					"",
					"Owned container remains",
				);
				result.cleanup = "removed";
			}
		} catch (error) {
			result.cleanupFailure = String(error);
		}
		result.dependencySmokePassed =
			result.originalFailure === null &&
			result.cleanupFailure === null &&
			result.cleanup === "removed" &&
			result.interrupted === null;
		parseLinuxPackageResult(result, identity);
		await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
		process.off("SIGTERM", onTerm);
		process.off("SIGINT", onInt);
	}
	if (!result.dependencySmokePassed) {
		console.error(result.originalFailure ?? result.cleanupFailure ?? "Dependency smoke did not complete");
		process.exitCode = result.commands.find((command) => !succeeded(command))?.status || 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
