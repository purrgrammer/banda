import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	expectedSum,
	keepsPiEnv,
	NODE_VERSION,
	nodeArchive,
	POSIX_LAUNCHER,
	STAGED,
	targetName,
	WINDOWS_LAUNCHER,
} from "../scripts/stage.ts";

const SUM = "a".repeat(64);

describe("staging a release", () => {
	it("names targets and Node archives as nodejs.org and the release page do", () => {
		expect(targetName({ platform: "darwin", arch: "arm64" })).toBe("mac-arm64");
		expect(targetName({ platform: "win32", arch: "x64" })).toBe("win-x64");
		expect(targetName({ platform: "linux", arch: "arm64" })).toBe("linux-arm64");
		expect(nodeArchive({ platform: "darwin", arch: "x64" })).toBe(`node-v${NODE_VERSION}-darwin-x64.tar.gz`);
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
});
