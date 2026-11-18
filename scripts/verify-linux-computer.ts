import assert from "node:assert/strict";
import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { MicrovmManifest } from "../src/box/microvm-assets.ts";
import {
	assertDiagnosticIdentity,
	assertKvmGroup,
	diagnosticFile,
	hostDiagnostics,
	parseDiagnosticIdentity,
} from "./native-diagnostics.ts";

const BuildIdentity = Type.Object({
	sourceCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	runtimeManifestSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	target: Type.Union([Type.Literal("linux-x64"), Type.Literal("linux-arm64")]),
	releaseRoot: Type.String({ pattern: "^/" }),
});
const Completion = Type.Object({
	status: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	signal: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	launchError: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});
const AppProof = Type.Object({
	...BuildIdentity.properties,
	widths: Type.Tuple([Type.Literal(1440), Type.Literal(390)]),
	proxyRestarts: Type.Literal(2),
	declinedPosts: Type.Literal(2),
	browserDownloads: Type.Literal(1),
	localArchiveDelivery: Type.Literal(true),
	publicBrowserDelivery: Type.Literal(false),
	passed: Type.Literal(true),
	cleaned: Type.Literal(true),
	persistence: Type.Object({
		state: Type.Literal("passed"),
		daemonRestarts: Type.Literal(1),
		folders: Type.Tuple([Type.Literal("/workspace"), Type.Literal("/work"), Type.Literal("/tools")]),
		readOnlyCheck: Type.Literal(true),
		historyRetained: Type.Literal(true),
		browserDownloadsAfterRestart: Type.Literal(1),
	}),
});
const Activation = Type.Object({
	expected: BuildIdentity,
	runner: Type.Object({
		name: Type.String({ pattern: "^[a-z_][a-z0-9_-]*[$]?$" }),
		home: Type.String({ pattern: "^/[^\\n]*$" }),
	}),
	status: Type.String(),
	kvmGid: Type.Integer({ minimum: 1, maximum: 4294967295 }),
	chrome: Type.String({ pattern: "^/" }),
});
const commandOptions = {
	encoding: "utf8",
	env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" },
	timeout: 5_000,
	maxBuffer: 64 << 10,
	killSignal: "SIGKILL",
} as const;

export function parseLinuxComputerResult(
	value: unknown,
	{
		expected,
		appCompletion,
		wrapperCompletion,
	}: { expected: Static<typeof BuildIdentity>; appCompletion: unknown; wrapperCompletion: unknown },
) {
	for (const [name, completion] of [
		["App", appCompletion],
		["Activation wrapper", wrapperCompletion],
	] as const) {
		if (!Value.Check(Completion, completion)) throw new Error(`${name} completion is missing or malformed.`);
		assert.ok(
			completion.status === 0 && completion.signal === null && completion.launchError === null,
			`${name} did not complete successfully: ${JSON.stringify(completion)}`,
		);
	}
	if (!Value.Check(AppProof, value)) throw new Error("Incomplete native app proof or unverified cleanup.");
	for (const key of ["sourceCommit", "runtimeManifestSha256", "target", "releaseRoot"] as const)
		assert.equal(value[key], expected[key], `Native app ${key} differs.`);
	return value;
}

export function parseLinuxRunnerAccount(value: unknown, identity: ReturnType<typeof parseDiagnosticIdentity>) {
	assert.ok(typeof value === "string", "Missing runner account.");
	const fields = value.trim().split(":");
	const Account = Type.Tuple([
		Activation.properties.runner.properties.name,
		Type.String(),
		Type.Literal(String(identity.uid)),
		Type.Literal(String(identity.gid)),
		Type.String(),
		Activation.properties.runner.properties.home,
		Type.String({ pattern: "^/[^\\n]*$" }),
	]);
	if (!Value.Check(Account, fields))
		throw new Error("Runner account must map to the same ordinary UID and primary GID.");
	return { name: fields[0], home: fields[5] };
}

async function save(output: string, name: string, value: unknown) {
	await writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
}

type FinalizationFailure = { operation: string; error: string };
const errorText = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));

function recordFailure(failures: FinalizationFailure[], operation: string, error: unknown) {
	failures.push({ operation, error: errorText(error) });
	console.error(`${operation}:`, error);
}

async function saveEvidence(output: string, name: string, value: unknown, failures: FinalizationFailure[]) {
	try {
		await save(output, name, value);
	} catch (error) {
		recordFailure(failures, name, error);
	}
}

function failedCompletion(completion: Static<typeof Completion> | null) {
	return (
		completion !== null && (completion.status !== 0 || completion.signal !== null || completion.launchError !== null)
	);
}

async function readJson(path: string): Promise<unknown> {
	const file = await diagnosticFile(path);
	assert.equal(file.state, "read", `Missing or incomplete evidence: ${path}`);
	assert.ok(file.state === "read");
	return JSON.parse(file.text);
}

function completionOf(child: Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">) {
	return { status: child.status, signal: child.signal, launchError: child.error?.message ?? null };
}

export function finishLinuxComputer(completion: Static<typeof Completion>) {
	if (completion.signal !== null) {
		const signal = Object.entries(osConstants.signals).find(([name]) => name === completion.signal);
		if (signal) process.kill(process.pid, signal[1]);
	}
	process.exitCode =
		completion.status === 0 && completion.launchError === null && completion.signal === null
			? 0
			: completion.status || 1;
}

async function installedBuild(releaseRoot: string, sourceCommit: string): Promise<Static<typeof BuildIdentity>> {
	const bytes = await readFile(join(releaseRoot, "app/computer/manifest.json"));
	const manifest: unknown = JSON.parse(bytes.toString("utf8"));
	if (!Value.Check(MicrovmManifest, manifest)) throw new Error("Invalid installed native runtime manifest.");
	assert.ok(manifest.target === "linux-x64" || manifest.target === "linux-arm64", "Expected a native Linux package.");
	assert.equal(manifest.target, `linux-${process.arch}`, "Installed package differs from this runner architecture.");
	return {
		sourceCommit,
		releaseRoot,
		target: manifest.target,
		runtimeManifestSha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function assertActivatedHost(
	host: Awaited<ReturnType<typeof hostDiagnostics>>,
	original: ReturnType<typeof parseDiagnosticIdentity>,
	kvmGid: number,
) {
	assert.ok(host.kvm.identity.state === "read", "Activated runner identity is unavailable.");
	assertDiagnosticIdentity(host.kvm.identity.value, original, kvmGid);
	assert.equal(assertKvmGroup(host.kvm, execFileSync("/usr/bin/getent", ["group", "kvm"], commandOptions)), kvmGid);
	assert.equal(host.kvm.open.state, "opened-and-closed", "Activated runner cannot open KVM.");
}

export async function activated(output: string) {
	const value = await readJson(join(output, "activation.json"));
	if (!Value.Check(Activation, value)) throw new Error("Invalid activation record.");
	const { expected, runner, kvmGid } = value;
	let child: Static<typeof Completion> | null = null;
	let failure: string | null = null;
	const finalizationFailures: FinalizationFailure[] = [];
	try {
		assert.equal(process.platform, "linux");
		assert.equal(await realpath(process.execPath), await realpath(join(expected.releaseRoot, "node/node")));
		assert.equal(process.env.BANDA_RELEASE_ROOT, expected.releaseRoot);
		assert.equal(process.env.BANDA_VERIFY_SOURCE_COMMIT, expected.sourceCommit);
		assert.equal(process.env.CHROME, value.chrome);
		assert.equal(process.env.HOME, runner.home);
		assert.notEqual(process.env.BANDA_VERIFY_PUBLIC_BROWSER, "1");
		assert.deepEqual(await installedBuild(expected.releaseRoot, expected.sourceCommit), expected);
		const before = await hostDiagnostics();
		await save(output, "activated-before.json", before);
		const original = parseDiagnosticIdentity(value.status);
		assertActivatedHost(before, original, kvmGid);
		assert.deepEqual(
			parseLinuxRunnerAccount(
				execFileSync("/usr/bin/getent", ["passwd", String(original.uid)], commandOptions),
				original,
			),
			runner,
		);
		child = completionOf(
			spawnSync(process.execPath, [join(import.meta.dirname, "verify-computer.ts"), join(output, "app")], {
				stdio: "inherit",
			}),
		);
	} catch (error) {
		failure = errorText(error);
		console.error(error);
	}
	if (child !== null) await saveEvidence(output, "app-completion.json", child, finalizationFailures);
	try {
		const after = await hostDiagnostics();
		await saveEvidence(output, "activated-after.json", after, finalizationFailures);
		assertActivatedHost(after, parseDiagnosticIdentity(value.status), kvmGid);
	} catch (error) {
		recordFailure(finalizationFailures, "activated-after", error);
	}
	if (failedCompletion(child) || failure !== null || finalizationFailures.length > 0)
		await saveEvidence(
			output,
			"activation-failure.json",
			{ error: failure, appCompletion: child, finalizationFailures },
			finalizationFailures,
		);
	finishLinuxComputer(
		child !== null && (failedCompletion(child) || (failure === null && finalizationFailures.length === 0))
			? child
			: { status: 1, signal: null, launchError: null },
	);
}

export async function launch(outputArgument: string) {
	assert.equal(process.platform, "linux", "This acceptance launcher requires native Linux.");
	assert.ok(
		process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true",
		"Group provisioning is limited to GitHub Actions CI.",
	);
	assert.ok(isAbsolute(outputArgument), "Evidence output must be an absolute fresh directory.");
	await mkdir(outputArgument, { mode: 0o700 });
	const output = await realpath(outputArgument);
	let wrapperCompletion: Static<typeof Completion> | null = null;
	let appCompletion: Static<typeof Completion> | null = null;
	let expected: Static<typeof BuildIdentity> | null = null;
	let proof: Static<typeof AppProof> | null = null;
	let failure: string | null = null;
	const finalizationFailures: FinalizationFailure[] = [];
	try {
		const before = await hostDiagnostics();
		await save(output, "runner-before.json", before);
		assert.ok(before.kvm.status.state === "read", "Runner process status is incomplete.");
		const identity = parseDiagnosticIdentity(before.kvm.status.text);
		assertDiagnosticIdentity(identity, identity);
		const sourceCommit = process.env.GITHUB_SHA;
		assert.ok(
			typeof sourceCommit === "string" && Value.Check(BuildIdentity.properties.sourceCommit, sourceCommit),
			"GITHUB_SHA must identify the exact CI source.",
		);
		const source = await realpath(join(import.meta.dirname, ".."));
		assert.equal(
			execFileSync("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"], commandOptions).trim(),
			sourceCommit,
			"CI source differs from the launcher checkout.",
		);
		const root = process.env.BANDA_RELEASE_ROOT;
		const chrome = process.env.CHROME;
		assert.ok(typeof root === "string" && isAbsolute(root), "BANDA_RELEASE_ROOT must be an absolute staged package.");
		assert.ok(typeof chrome === "string" && isAbsolute(chrome), "CHROME must be an absolute executable.");
		const releaseRoot = await realpath(root);
		const chromePath = await realpath(chrome);
		const node = join(releaseRoot, "node/node");
		await access(node, constants.X_OK);
		await access(chromePath, constants.X_OK);
		expected = await installedBuild(releaseRoot, sourceCommit);
		const runner = parseLinuxRunnerAccount(
			execFileSync("/usr/bin/getent", ["passwd", String(identity.uid)], commandOptions),
			identity,
		);
		assert.equal(execFileSync("/usr/bin/id", ["-un"], commandOptions).trim(), runner.name);
		assert.equal(execFileSync("/usr/bin/id", ["-u", runner.name], commandOptions).trim(), String(identity.uid));
		assert.equal(execFileSync("/usr/bin/id", ["-g", runner.name], commandOptions).trim(), String(identity.gid));
		const kvmGid = assertKvmGroup(before.kvm, execFileSync("/usr/bin/getent", ["group", "kvm"], commandOptions));
		await save(output, "activation.json", {
			expected,
			runner,
			status: before.kvm.status.text,
			kvmGid,
			chrome: chromePath,
		} satisfies Static<typeof Activation>);
		execFileSync("/usr/bin/sudo", ["-n", "/usr/sbin/usermod", "-aG", "kvm", runner.name], {
			...commandOptions,
			stdio: "inherit",
		});
		const stdout = openSync(join(output, "app-stdout.log"), "wx", 0o600);
		const stderr = openSync(join(output, "app-stderr.log"), "wx", 0o600);
		try {
			wrapperCompletion = completionOf(
				spawnSync(
					"/usr/bin/sudo",
					[
						"-n",
						"-u",
						runner.name,
						"--",
						"/usr/bin/env",
						"-i",
						"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
						`HOME=${runner.home}`,
						"LANG=C.UTF-8",
						"CI=true",
						`BANDA_RELEASE_ROOT=${releaseRoot}`,
						`BANDA_VERIFY_SOURCE_COMMIT=${sourceCommit}`,
						`CHROME=${chromePath}`,
						node,
						fileURLToPath(import.meta.url),
						"--activated",
						output,
					],
					{ stdio: ["ignore", stdout, stderr], env: commandOptions.env },
				),
			);
		} finally {
			closeSync(stdout);
			closeSync(stderr);
		}
		await saveEvidence(output, "wrapper-completion.json", wrapperCompletion, finalizationFailures);
		const completion = await readJson(join(output, "app-completion.json"));
		if (!Value.Check(Completion, completion)) throw new Error("Missing or malformed app completion.");
		appCompletion = completion;
		assert.deepEqual(
			await installedBuild(releaseRoot, sourceCommit),
			expected,
			"Installed manifest changed during verification.",
		);
		proof = parseLinuxComputerResult(await readJson(join(output, "app/result.json")), {
			expected,
			appCompletion,
			wrapperCompletion,
		});
	} catch (error) {
		failure = errorText(error);
		console.error(error);
	}
	try {
		await saveEvidence(output, "runner-after.json", await hostDiagnostics(), finalizationFailures);
	} catch (error) {
		recordFailure(finalizationFailures, "runner-after", error);
	}
	try {
		await save(output, "result.json", {
			qualification:
				proof !== null && failure === null && finalizationFailures.length === 0 ? "staged-native-app" : false,
			expected,
			desktopQualified: false,
			publicDelivery: false,
			appCompletion,
			wrapperCompletion,
			proof,
			error: failure,
			finalizationFailures,
			appFailure: await diagnosticFile(join(output, "app/failure.json")),
			appCleanup: await diagnosticFile(join(output, "app/cleanup.json")),
			appResult: await diagnosticFile(join(output, "app/result.json")),
			activationFailure: await diagnosticFile(join(output, "activation-failure.json")),
		});
	} catch (error) {
		recordFailure(finalizationFailures, "result.json", error);
	}
	const qualified = proof !== null && failure === null && finalizationFailures.length === 0;
	if (proof !== null && qualified) {
		console.log(`Native staged app verified on ${proof.target}; evidence: ${output}`);
	}
	finishLinuxComputer(
		appCompletion !== null && failedCompletion(appCompletion)
			? appCompletion
			: wrapperCompletion !== null && failedCompletion(wrapperCompletion)
				? wrapperCompletion
				: { status: qualified ? 0 : 1, signal: null, launchError: null },
	);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const args = process.argv.slice(2);
		if (args.length === 2 && args[0] === "--activated" && args[1] !== undefined) {
			assert.ok(isAbsolute(args[1]), "Activated evidence directory must be absolute.");
			await activated(args[1]);
		} else {
			assert.ok(
				args.length === 1 && args[0] !== undefined,
				"Usage: node scripts/verify-linux-computer.ts ABSOLUTE_FRESH_OUTPUT",
			);
			await launch(args[0]);
		}
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
