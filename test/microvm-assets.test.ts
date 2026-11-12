import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	archiveImageDigest,
	microvmTarget,
	stageMicrovmBundle,
	verifiedMicrovmImages,
} from "../scripts/microvm-bundle.ts";
import { imageSpecs } from "../src/box/container.ts";
import {
	fileSha256,
	installedMicrovmAssets,
	MICROSANDBOX_ARCHIVE_SHA256,
	MICROSANDBOX_VERSION,
	MICROVM_PLATFORMS,
	type MicrovmManifest,
	readMicrovmAssets,
} from "../src/box/microvm-assets.ts";

const homes: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const sum = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const browser = {
	sha256: sum("browser"),
	bytes: 7,
	ref: `banda-browser:${"a".repeat(12)}`,
	digest: `sha256:${"b".repeat(64)}`,
	url: `https://github.com/purrgrammer/banda/releases/download/v0.1.0-test/banda-browser-${sum("browser")}.tar`,
};
const image = (role: "box" | "proxy"): MicrovmManifest["box"] => ({
	archive: role === "box" ? "box.tar" : "proxy.tar",
	sha256: sum(role),
	ref: `banda-${role}:${"a".repeat(12)}`,
	digest: `sha256:${"b".repeat(64)}`,
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "banda-computer-assets-"));
	homes.push(root);
	await mkdir(join(root, "notices"));
	const file = async <T extends string>(path: T) => {
		await writeFile(join(root, path), path);
		return { path, sha256: sum(path) };
	};
	const manifest: MicrovmManifest = {
		target: "darwin-arm64",
		version: MICROSANDBOX_VERSION,
		vendorArchiveSha256: MICROSANDBOX_ARCHIVE_SHA256,
		msb: await file("msb"),
		firmware: await file("libkrunfw.5.dylib"),
		entitlements: { hypervisor: true, disableLibraryValidation: true },
		box: image("box"),
		proxy: image("proxy"),
		browser,
		notices: {
			microsandbox: await file("notices/MICROSANDBOX-LICENSE"),
			firmwareGpl: await file("notices/LIBKRUNFW-GPL-2.0"),
			firmwareLgpl: await file("notices/LIBKRUNFW-LGPL-2.1"),
			inventory: await file("notices/INVENTORY.md"),
		},
		redistribution: "review-required",
	};
	await writeFile(join(root, "box.tar"), "box");
	await writeFile(join(root, "proxy.tar"), "proxy");
	await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
	return { root, manifest };
}

describe("installed computer assets", () => {
	it("rejects a configured self-hashed bundle in a writable computer export", async () => {
		const { root } = await fixture();
		const home = await mkdtemp(join(tmpdir(), "banda-computer-home-"));
		homes.push(home);
		const exported = join(home, "computer", "workspace", "computer");
		await mkdir(join(home, "computer", "workspace"), { recursive: true });
		await rename(root, exported);
		vi.stubEnv("BANDA_COMPUTER_BUNDLE", exported);
		await expect(installedMicrovmAssets()).rejects.toThrow(/BANDA_COMPUTER_BUNDLE is not supported/);
	});
	it("loads a relocated self-contained bundle without its original directory", async () => {
		const { root } = await fixture();
		const moved = `${root}-moved`;
		homes.push(moved);
		await rename(root, moved);
		const assets = await readMicrovmAssets(moved);
		expect(assets.msb).toBe(join(await realpath(moved), "msb"));
		expect(assets.box.archive).toBe(join(await realpath(moved), "box.tar"));
		expect(assets.proxy.digest).toMatch(/^sha256:/);
		expect(assets.browser.url).toBe(browser.url);
	});
	it.each(["msb", "libkrunfw.5.dylib", "box.tar", "proxy.tar", "notices/INVENTORY.md"])(
		"refuses altered %s before any runtime is executed",
		async (path) => {
			const { root } = await fixture();
			await writeFile(join(root, path), "altered");
			await expect(readMicrovmAssets(root)).rejects.toThrow(/SHA-256/);
		},
	);
	it("rejects traversal and unpinned versions in the manifest", async () => {
		const { root, manifest } = await fixture();
		await writeFile(
			join(root, "manifest.json"),
			JSON.stringify({ ...manifest, msb: { ...manifest.msb, path: "../msb" } }),
		);
		await expect(readMicrovmAssets(root)).rejects.toThrow(/manifest/);
		await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, version: "latest" }));
		await expect(readMicrovmAssets(root)).rejects.toThrow(/manifest/);
	});
	it("rejects a symlink outside the bundle even when its bytes match", async () => {
		const { root } = await fixture();
		const outside = `${root}-msb`;
		await rename(join(root, "msb"), outside);
		homes.push(outside);
		await symlink(outside, join(root, "msb"));
		await expect(readMicrovmAssets(root)).rejects.toThrow(/outside/);
	});
	it("rejects a browser descriptor outside the fixed publisher or with a mismatched content filename", async () => {
		const { root, manifest } = await fixture();
		for (const url of ["http://127.0.0.1/browser.tar", browser.url.replace(browser.sha256, "0".repeat(64))]) {
			await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, browser: { ...browser, url } }));
			await expect(readMicrovmAssets(root)).rejects.toThrow(/manifest|filename/);
		}
	});
	it("leaves other release targets operational without microVM inputs", async () => {
		for (const platform of ["freebsd", "win32"] as const) {
			expect(microvmTarget({ platform, arch: "arm64" })).toBeUndefined();
			await stageMicrovmBundle({
				root: "/missing-source",
				out: "/missing-output",
				target: { platform, arch: "arm64" },
			});
		}
		expect(microvmTarget({ platform: "darwin", arch: "x64" })).toBeUndefined();
	});
	it.each(["arm64", "x64"] as const)(
		"accepts %s archives and refuses wrong CPUs and source identities",
		async (arch) => {
			const { root } = await fixture();
			const specs = [
				...(await imageSpecs({ arch, boxTarget: "boot" })),
				...(await imageSpecs({ arch, boxTarget: "browser" })),
			];
			const tagged = async (role: "box" | "proxy" | "browser") => {
				const ref = specs.find((spec) => spec.tag.startsWith(`banda-${role}:`))?.tag;
				const context = join(root, `${role}-export`);
				await mkdir(context);
				const config = JSON.stringify({ architecture: arch === "arm64" ? "arm64" : "amd64", os: "linux" });
				const digest = sum(config);
				await writeFile(join(context, `${digest}.json`), config);
				await writeFile(
					join(context, "manifest.json"),
					JSON.stringify([{ Config: `${digest}.json`, RepoTags: [ref] }]),
				);
				execFileSync("tar", ["-cf", join(root, `${role}.tar`), "-C", context, "manifest.json", `${digest}.json`]);
				const sha256 = await fileSha256(join(root, `${role}.tar`));
				if (role === "browser") {
					const archive = `banda-browser-${sha256}.tar`;
					await rename(join(root, "browser.tar"), join(root, archive));
					return { archive, ref, sha256, digest: `sha256:${digest}`, bytes: (await stat(join(root, archive))).size };
				}
				return { ...image(role), ref, sha256, digest: `sha256:${digest}` };
			};
			await writeFile(
				join(root, "images.json"),
				JSON.stringify({
					target: `linux-${arch}`,
					box: await tagged("box"),
					proxy: await tagged("proxy"),
					browser: await tagged("browser"),
				}),
			);
			await expect(verifiedMicrovmImages(root)).resolves.toHaveProperty("target", `linux-${arch}`);
			const value = await verifiedMicrovmImages(root);
			expect(() =>
				archiveImageDigest(join(root, "box.tar"), value.box.ref, arch === "arm64" ? "x64" : "arm64"),
			).toThrow(/not a Linux/);
			await writeFile(
				join(root, "images.json"),
				JSON.stringify({ ...value, box: { ...value.box, ref: `banda-box:${"0".repeat(12)}` } }),
			);
			await expect(verifiedMicrovmImages(root)).rejects.toThrow(/different sources/);
		},
	);
	it.each(["linux-arm64", "linux-x64"] as const)(
		"loads a relocated %s bundle and refuses it on another host",
		async (target) => {
			const { root, manifest } = await fixture();
			if (manifest.target !== "darwin-arm64") throw new Error("Expected a Mac fixture");
			const { entitlements, ...common } = manifest;
			expect(entitlements.hypervisor).toBe(true);
			const vendor = MICROVM_PLATFORMS[target];
			await writeFile(join(root, vendor.firmware), vendor.firmware);
			await writeFile(
				join(root, "manifest.json"),
				JSON.stringify({
					...common,
					target,
					vendorArchiveSha256: vendor.sha256,
					firmware: { path: vendor.firmware, sha256: sum(vendor.firmware) },
				}),
			);
			const loaded = await readMicrovmAssets(root, target);
			expect(loaded.target).toBe(target);
			expect(loaded.firmware).toBe(join(await realpath(root), vendor.firmware));
			await expect(readMicrovmAssets(root, "darwin-arm64")).rejects.toThrow(/different operating system or CPU/);
		},
	);
});
