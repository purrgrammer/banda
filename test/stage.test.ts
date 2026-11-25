import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	expectedSum,
	keepsPiEnv,
	NODE_VERSION,
	neverLoaded,
	nodeArchive,
	POSIX_LAUNCHER,
	prune,
	STAGED,
	targetName,
	WINDOWS_LAUNCHER,
	writeReleaseMarker,
} from "../scripts/stage.ts";
import { keychainService, RELEASE_MARKER, ReleaseMarker } from "../src/wallet/keystore.ts";

const SUM = "a".repeat(64);

describe("staging a release", () => {
	it("names targets and Node archives as nodejs.org and the release page do", () => {
		expect(targetName({ platform: "darwin", arch: "arm64" })).toBe("mac-arm64");
		expect(targetName({ platform: "win32", arch: "x64" })).toBe("win-x64");
		expect(targetName({ platform: "linux", arch: "arm64" })).toBe("linux-arm64");
		expect(nodeArchive({ platform: "darwin", arch: "arm64" })).toBe(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
		expect(() => targetName({ platform: "darwin", arch: "x64" })).toThrow(/Apple silicon/);
		expect(() => nodeArchive({ platform: "darwin", arch: "x64" })).toThrow(/Apple silicon/);
		expect(nodeArchive({ platform: "linux", arch: "arm64" })).toBe(`node-v${NODE_VERSION}-linux-arm64.tar.gz`);
		expect(nodeArchive({ platform: "win32", arch: "x64" })).toBe(`node-v${NODE_VERSION}-win-x64.zip`);
		expect(() => nodeArchive({ platform: "freebsd", arch: "x64" })).toThrow(/no Node.js build/);
	});

	it("pins an exact Node version of the major engines asks for", async () => {
		const { engines } = (await import("../package.json", { with: { type: "json" } })).default as {
			engines: { node: string };
		};
		expect(NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Number(NODE_VERSION.split(".")[0])).toBeGreaterThanOrEqual(Number(engines.node.replace(/\D/g, "")));
	});

	it("gives the desktop app the version the CLI and the tag carry", async () => {
		const root = (await import("../package.json", { with: { type: "json" } })).default as { version: string };
		const desktop = (await import("../desktop/package.json", { with: { type: "json" } })).default as {
			version: string;
		};
		expect(desktop.version).toBe(root.version);
	});

	it("checks a download only against the line that names it, and refuses a list without it", () => {
		const shasums = `${"b".repeat(64)}  node-v1-other.tar.gz\n${SUM}  node-v1-darwin-arm64.tar.gz\n`;
		expect(expectedSum(shasums, "node-v1-darwin-arm64.tar.gz")).toBe(SUM);
		expect(() => expectedSum(shasums, "node-v1-linux-x64.tar.gz")).toThrow(/does not list/);
		expect(() => expectedSum(`nothex  node-v1-linux-x64.tar.gz`, "node-v1-linux-x64.tar.gz")).toThrow();
	});

	it("keeps the box's Linux pi-env binaries and the host's own, and drops the rest", () => {
		const files = [
			"pi-env-android-arm64",
			"pi-env-darwin-arm64",
			"pi-env-darwin-x64",
			"pi-env-linux-arm64",
			"pi-env-linux-x64",
			"pi-env-windows-x64",
		];
		expect(files.filter((f) => keepsPiEnv(f, { platform: "darwin", arch: "arm64" }))).toEqual([
			"pi-env-darwin-arm64",
			"pi-env-linux-arm64",
			"pi-env-linux-x64",
		]);
		expect(files.filter((f) => keepsPiEnv(f, { platform: "win32", arch: "x64" }))).toEqual([
			"pi-env-linux-arm64",
			"pi-env-linux-x64",
			"pi-env-windows-x64",
		]);
	});

	it("drops source maps and TypeScript from the dependencies, and nothing else", async () => {
		const kept = [
			"pkg/index.js",
			"pkg/index.mjs",
			"pkg/index.cjs",
			"pkg/package.json",
			"pkg/LICENSE",
			"pkg/LICENSE.md",
			"pkg/README.md",
			"pkg/addon.darwin-arm64.node",
			"pkg/code.wasm",
			"pkg/bin/tool",
			"@scope/pkg/dist/parts.js",
			"@scope/pkg/dist/roadmap",
		];
		const dropped = [
			"pkg/index.js.map",
			"pkg/index.d.ts",
			"pkg/index.d.ts.map",
			"pkg/index.d.mts",
			"pkg/index.d.cts",
			"pkg/src/index.ts",
			"pkg/src/index.mts",
			"pkg/src/index.cts",
			"pkg/src/view.tsx",
			"@scope/pkg/dist/parts.mjs.map",
		];
		expect(kept.filter(neverLoaded)).toEqual([]);
		expect(dropped.filter((file) => !neverLoaded(file))).toEqual([]);
		const modules = await mkdtemp(join(tmpdir(), "banda-stage-"));
		try {
			for (const file of [...kept, ...dropped]) {
				await mkdir(dirname(join(modules, file)), { recursive: true });
				await writeFile(join(modules, file), "");
			}
			// a folder is never judged by its name
			await mkdir(join(modules, "pkg", "types.ts"));
			await writeFile(join(modules, "pkg", "types.ts", "index.js"), "");
			expect(await prune(modules)).toBe(dropped.length);
			const left = (await readdir(modules, { recursive: true, withFileTypes: true }))
				.filter((entry) => entry.isFile())
				.map((entry) => join(entry.parentPath, entry.name).slice(modules.length + 1));
			expect(left.sort()).toEqual([...kept, "pkg/types.ts/index.js"].sort());
		} finally {
			await rm(modules, { recursive: true, force: true });
		}
	});

	it("gives a release no package the daemon never imports", async () => {
		const { dependencies } = (await import("../package.json", { with: { type: "json" } })).default as {
			dependencies: Record<string, string>;
		};
		const files = (await readdir("src", { recursive: true })).filter((file) => file.endsWith(".ts"));
		const imported = new Set<string>();
		for (const file of files) {
			const text = await readFile(join("src", file), "utf8");
			for (const [, name] of text.matchAll(
				/(?:from|import\(|resolve\()\s*"(@[\w.-]+\/[\w.-]+|[a-z][\w.-]*)(?:\/[^"]*)?"/g,
			))
				imported.add(name ?? "");
		}
		expect(Object.keys(dependencies).filter((name) => !imported.has(name))).toEqual([]);
	});

	it("launches the bundled CLI with the bundled Node, passing every argument", () => {
		expect(POSIX_LAUNCHER.startsWith("#!/bin/sh\n")).toBe(true);
		expect(POSIX_LAUNCHER).toContain('exec "$root/node/node" "$root/app/dist/cli/index.js" "$@"');
		expect(WINDOWS_LAUNCHER).toContain('"%~dp0..\\node\\node.exe" "%~dp0..\\app\\dist\\cli\\index.js" %*');
		expect(WINDOWS_LAUNCHER.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
	});

	it("stages every folder the runtime reads from its install", async () => {
		const files = (await readdir("src", { recursive: true })).filter((file) => file.endsWith(".ts"));
		const read = new Set<string>();
		for (const file of files) {
			const text = await readFile(join("src", file), "utf8");
			for (const [, path] of text.matchAll(/new URL\("\.\.\/\.\.\/([^"]+)", import\.meta\.url\)/g))
				read.add(path ?? "");
		}
		expect(read.size).toBeGreaterThan(0);
		for (const path of read)
			expect(
				STAGED.some((staged) => path === staged || path.startsWith(`${staged}/`) || staged.startsWith(path)),
				`${path} is read at run time but not staged`,
			).toBe(true);
	});

	it("marks the staged app a release, so its wallets live under the released keychain service (H-283)", async () => {
		const root = await mkdtemp(join(tmpdir(), "banda-stage-"));
		try {
			const app = join(root, "release", "banda", "app");
			await mkdir(join(app, "dist", "wallet"), { recursive: true });
			await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.9.9-test" }));
			const built = pathToFileURL(join(app, "dist", "wallet", "keystore.js")).href;
			expect(keychainService({}, built)).toBe("banda-dev");
			await writeReleaseMarker(root, app);
			const marker: unknown = JSON.parse(await readFile(join(app, RELEASE_MARKER), "utf8"));
			expect(Value.Check(ReleaseMarker, marker)).toBe(true);
			expect(marker).toEqual({ release: "9.9.9-test" });
			expect(keychainService({}, built)).toBe("banda");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		const source = await readFile(join("scripts", "stage.ts"), "utf8");
		const start = source.indexOf("async function stageApp(");
		const stageApp = source.slice(start, source.indexOf("\n}\n", start));
		expect(stageApp).toContain("await writeReleaseMarker(root, app);");
	});
});
