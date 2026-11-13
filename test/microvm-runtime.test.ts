import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { buildMicrovmRuntime } from "../scripts/microvm-runtime.ts";
import * as assets from "../src/box/microvm-assets.ts";

const execution = vi.hoisted(() => ({
	run: vi.fn<(program: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => string>(),
}));
vi.mock("node:child_process", () => ({
	execFileSync: (...args: Parameters<typeof execution.run>) => execution.run(...args),
}));

const homes: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	execution.run.mockReset();
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const target = assets.microvmTarget(process);
const sum = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
	if (target === undefined) throw new Error("The runtime producer requires a native target.");
	const root = await mkdtemp(join(tmpdir(), "banda-native-producer-"));
	homes.push(root);
	const bundle = join(root, "bundle");
	await mkdir(bundle);
	await writeFile(join(bundle, "msb"), "original vendor executable");
	await writeFile(join(bundle, assets.MICROVM_PLATFORMS[target].firmware), "verified firmware fixture");
	return { root, bundle, cache: join(root, "cache"), target };
}

it.skipIf(target === undefined)("rejects changed source bytes before extracting or executing anything", async () => {
	const f = await fixture();
	vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("not the pinned source")));
	await expect(buildMicrovmRuntime(f)).rejects.toThrow(/SHA-256/);
	expect(execution.run).not.toHaveBeenCalled();
	expect(await readFile(join(f.bundle, "msb"), "utf8")).toBe("original vendor executable");
});

it.skipIf(target === undefined)(
	"refuses a cache writable by another local user before fetching or executing",
	async () => {
		const f = await fixture();
		await mkdir(f.cache);
		await chmod(f.cache, 0o777);
		const fetcher = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetcher);
		await expect(buildMicrovmRuntime(f)).rejects.toThrow("not writable by others");
		expect(fetcher).not.toHaveBeenCalled();
		expect(execution.run).not.toHaveBeenCalled();
	},
);

async function verifiedInputs(f: Awaited<ReturnType<typeof fixture>>) {
	const platform = assets.MICROVM_PLATFORMS[f.target];
	await mkdir(join(f.cache, "downloads"), { recursive: true });
	await writeFile(
		join(f.cache, "downloads", `microsandbox-${assets.MICROVM_SOURCE.commit}.tar.gz`),
		"verified source fixture",
	);
	await writeFile(join(f.cache, "downloads", platform.agentd.asset), "verified agent fixture");
	const actual = assets.fileSha256;
	vi.spyOn(assets, "fileSha256").mockImplementation(async (path) => {
		if (path.endsWith(`/microsandbox-${assets.MICROVM_SOURCE.commit}.tar.gz`))
			return assets.MICROVM_SOURCE.archiveSha256;
		if (basename(path) === platform.agentd.asset) return platform.agentd.sha256;
		if (basename(path) === "Cargo.lock") return assets.MICROVM_SOURCE.lockSha256;
		if (basename(path) === platform.firmware) return platform.firmwareSha256;
		return actual(path);
	});
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const url = String(input);
			return url.endsWith(".sha256")
				? new Response(`${sum("verified compiler archive")}  compiler.tar.xz\n`)
				: new Response("verified compiler archive");
		}),
	);
	execution.run.mockImplementation((program, args, options) => {
		if (program === "tar" && args[0] === "-xzf") {
			const work = args[args.indexOf("-C") + 1];
			if (work === undefined) throw new Error("Missing producer work directory.");
			mkdirSync(join(work, `microsandbox-${assets.MICROVM_SOURCE.commit}`));
		}
		if (program === "patch") return "patched";
		if (program.endsWith("/bin/rustc")) return `rustc ${assets.MICROVM_SOURCE.rust} fixture`;
		if (program.endsWith("/bin/cargo") || program === "docker") {
			const work =
				program === "docker"
					? args[args.indexOf("--volume") + 1]?.replace(/:\/work$/, "")
					: options.cwd?.split(`/microsandbox-${assets.MICROVM_SOURCE.commit}`)[0];
			if (work === undefined) throw new Error("Missing compiler output directory.");
			if (program === "docker") writeFileSync(join(work, "msb"), "produced runtime");
			else {
				const output = options.env?.CARGO_TARGET_DIR;
				if (output === undefined) throw new Error("Missing Cargo output.");
				mkdirSync(join(output, platform.rustTarget, "release"), { recursive: true });
				writeFileSync(join(output, platform.rustTarget, "release/msb"), "produced runtime");
			}
		}
		if (program.endsWith("/msb") && args[0] === "--version") return `msb ${assets.MICROSANDBOX_VERSION}`;
		if (program.endsWith("/msb") && args[0] === "exec") return "--require-running";
		if (program === "/usr/bin/codesign" && args.includes("-d"))
			return "<key>com.apple.security.hypervisor</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/>";
		return "";
	});
}

it.skipIf(target === undefined)("propagates a patch failure without installing an executable", async () => {
	const f = await fixture();
	await verifiedInputs(f);
	const normal = execution.run.getMockImplementation();
	if (normal === undefined) throw new Error("Missing fixture executor.");
	execution.run.mockImplementation((program, args, options) => {
		if (program === "patch") throw new Error("patch does not apply");
		return normal(program, args, options);
	});
	await expect(buildMicrovmRuntime(f)).rejects.toThrow("patch does not apply");
	expect(execution.run.mock.calls.some(([program]) => program.endsWith("/bin/cargo") || program === "docker")).toBe(
		false,
	);
	expect((await readdir(f.cache)).some((name) => name.startsWith("build-"))).toBe(false);
});

it.skipIf(target === undefined)("rejects changed guest-agent bytes before executing build inputs", async () => {
	const f = await fixture();
	await verifiedInputs(f);
	const actual = vi.mocked(assets.fileSha256).getMockImplementation();
	if (actual === undefined) throw new Error("Missing verified input fixture.");
	vi.mocked(assets.fileSha256).mockImplementation(async (path) =>
		basename(path) === assets.MICROVM_PLATFORMS[f.target].agentd.asset ? sum("changed agent") : actual(path),
	);
	await expect(buildMicrovmRuntime(f)).rejects.toThrow(/SHA-256/);
	expect(execution.run).not.toHaveBeenCalled();
});

it.skipIf(target === undefined)("propagates compiler failure and removes its owned workspace", async () => {
	const f = await fixture();
	await verifiedInputs(f);
	const normal = execution.run.getMockImplementation();
	if (normal === undefined) throw new Error("Missing fixture executor.");
	execution.run.mockImplementation((program, args, options) => {
		if (program.endsWith("/bin/cargo") || program === "docker") throw new Error("compiler failed");
		return normal(program, args, options);
	});
	await expect(buildMicrovmRuntime(f)).rejects.toThrow("compiler failed");
	expect(await readFile(join(f.bundle, "msb"), "utf8")).toBe("original vendor executable");
	expect((await readdir(f.cache)).some((name) => name.startsWith("build-"))).toBe(false);
});

it.skipIf(target === undefined)("refuses a produced CLI without the borrowed capability", async () => {
	const f = await fixture();
	await verifiedInputs(f);
	const normal = execution.run.getMockImplementation();
	if (normal === undefined) throw new Error("Missing fixture executor.");
	execution.run.mockImplementation((program, args, options) =>
		program.endsWith("/msb") && args[0] === "exec" ? "ordinary exec only" : normal(program, args, options),
	);
	await expect(buildMicrovmRuntime(f)).rejects.toThrow(/cannot borrow/);
	expect(await readFile(join(f.bundle, "msb"), "utf8")).toBe("original vendor executable");
});

it.skipIf(target === undefined)(
	"installs only the produced executable and records its closed build provenance",
	async () => {
		const f = await fixture();
		await verifiedInputs(f);
		const built = await buildMicrovmRuntime(f);
		expect(Value.Check(assets.MicrovmRuntimeBuild, built)).toBe(true);
		expect(built.execution).toBe("require-running");
		expect(built.source.sha256).toBe(assets.MICROVM_SOURCE.archiveSha256);
		expect(built.agentdSha256).toBe(assets.MICROVM_PLATFORMS[f.target].agentd.sha256);
		expect(await readFile(join(f.bundle, "msb"), "utf8")).toBe("produced runtime");
		expect((await readdir(f.cache)).some((name) => name.startsWith("build-"))).toBe(false);
		const normal = execution.run.getMockImplementation();
		if (normal === undefined) throw new Error("Missing fixture executor.");
		execution.run.mockImplementation((program, args, options) => {
			if (program.endsWith("/bin/cargo") || program === "docker") throw new Error("rebuild is required");
			return normal(program, args, options);
		});
		await expect(buildMicrovmRuntime(f)).rejects.toThrow("rebuild is required");
	},
);

it.skipIf(target === undefined)("rejects a patch change during compilation before installing the result", async () => {
	const f = await fixture();
	await verifiedInputs(f);
	const hashes = vi.mocked(assets.fileSha256).getMockImplementation();
	const normal = execution.run.getMockImplementation();
	if (hashes === undefined || normal === undefined) throw new Error("Missing verified compiler fixture.");
	let compiled = false;
	vi.mocked(assets.fileSha256).mockImplementation(async (path) =>
		compiled && basename(path) === "microvm-runtime.patch" ? sum("new patch") : hashes(path),
	);
	execution.run.mockImplementation((program, args, options) => {
		const result = normal(program, args, options);
		if (program.endsWith("/bin/cargo") || program === "docker") compiled = true;
		return result;
	});
	await expect(buildMicrovmRuntime(f)).rejects.toThrow(/changed during compilation/);
	expect(await readFile(join(f.bundle, "msb"), "utf8")).toBe("original vendor executable");
});
