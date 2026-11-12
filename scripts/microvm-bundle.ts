/** Build-time preparation only. Installed banda neither needs Docker nor downloads runtime artifacts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { imageSpecs } from "../src/box/container.ts";
import {
	fileSha256,
	MICROSANDBOX_ARCHIVE_SHA256,
	MICROSANDBOX_VERSION,
	MicrovmImages,
	type MicrovmManifest,
	readMicrovmAssets,
	verifyBundleFile,
} from "../src/box/microvm-assets.ts";
import type { Target } from "./stage.ts";

const VENDOR = {
	archive: "microsandbox-darwin-aarch64.tar.gz",
	url: "https://github.com/superradcompany/microsandbox/releases/download/v0.7.14/microsandbox-darwin-aarch64.tar.gz",
	msb: "825e8a1e948b8a578739d66cfddeb9dd02deb17a517eb31de09fceba8b4ab155",
	firmware: "0104316ba962bb6f4bbf6da882e4b1dc5eb0453af8153c3e636d7433508d80ef",
};
const NOTICES = [
	{
		name: "MICROSANDBOX-LICENSE",
		url: "https://raw.githubusercontent.com/superradcompany/microsandbox/60fc5071b34e6cc2671c84c8dc07709795d45d27/LICENSE",
		sha256: "a276ca3381fefb9cde42fccae847856085c76027557d62eee83f057eb6c53433",
	},
	{
		name: "LIBKRUNFW-GPL-2.0",
		url: "https://raw.githubusercontent.com/containers/libkrunfw/223f11693774646eaa8ba892e3a6ebd07653154b/LICENSE-GPL-2.0-only",
		sha256: "f6b78c087c3ebdf0f3c13415070dd480a3f35d8fc76f3d02180a407c1c812f79",
	},
	{
		name: "LIBKRUNFW-LGPL-2.1",
		url: "https://raw.githubusercontent.com/containers/libkrunfw/223f11693774646eaa8ba892e3a6ebd07653154b/LICENSE-LGPL-2.1-only",
		sha256: "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
	},
];

const ExportManifest = Type.Array(Type.Object({ Config: Type.String(), RepoTags: Type.Array(Type.String()) }));
const ImageConfig = Type.Object({ architecture: Type.Literal("arm64"), os: Type.Literal("linux") });

/** Docker's .Id may name a containerd index; msb compares the actual exported image config instead. */
export function archiveImageDigest(archive: string, ref: string): string {
	const value: unknown = JSON.parse(execFileSync("tar", ["-xOf", archive, "manifest.json"], { encoding: "utf8" }));
	if (!Value.Check(ExportManifest, value)) throw new Error("The computer archive has no Docker export manifest.");
	const config = value.find((entry) => entry.RepoTags.includes(ref))?.Config;
	if (config === undefined || !/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(config))
		throw new Error(`The computer archive does not contain ${ref}.`);
	const bytes = execFileSync("tar", ["-xOf", archive, config]);
	const data: unknown = JSON.parse(bytes.toString("utf8"));
	if (!Value.Check(ImageConfig, data)) throw new Error("The computer archive is not a Linux ARM64 image.");
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function microvmTarget(target: Target): boolean {
	return target.platform === "darwin" && target.arch === "arm64";
}

async function downloaded(path: string, url: string, sha256: string): Promise<void> {
	if ((await fileSha256(path).catch(() => "")) === sha256) return;
	await mkdir(resolve(path, ".."), { recursive: true });
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const temporary = `${path}.partial`;
	await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
	if ((await fileSha256(temporary)) !== sha256) throw new Error(`${url}: SHA-256 verification failed`);
	await rename(temporary, path);
}

/** Runs on a Linux ARM64 builder in CI, or a development Docker engine at explicit packaging time. */
export async function buildMicrovmImages(out: string): Promise<void> {
	await mkdir(out, { recursive: true });
	const boot = await imageSpecs({ arch: "arm64", boxTarget: "boot" });
	const browserSpecs = await imageSpecs({ arch: "arm64", boxTarget: "browser" });
	const build = async (spec: (typeof boot)[number], name: "box" | "proxy" | "browser") => {
		const { tag, files, target } = spec;
		const context = await mkdtemp(join(tmpdir(), "banda-computer-build-"));
		try {
			for (const [file, path] of Object.entries(files)) await copyFile(path, join(context, file));
			if ("pi-env" in files) await chmod(join(context, "pi-env"), 0o755);
			execFileSync(
				"docker",
				[
					"build",
					"--platform",
					"linux/arm64",
					...(target === undefined ? [] : ["--target", target]),
					"--tag",
					tag,
					context,
				],
				{ stdio: "inherit" },
			);
			let archive = `${name}.tar`;
			execFileSync("docker", ["save", "--output", join(out, archive), tag], { stdio: "inherit" });
			const digest = archiveImageDigest(join(out, archive), tag);
			const sha256 = await fileSha256(join(out, archive));
			if (name === "browser") {
				const immutable = `banda-browser-${sha256}.tar`;
				await rename(join(out, archive), join(out, immutable));
				archive = immutable;
			}
			return { archive, sha256, ref: tag, digest, bytes: (await stat(join(out, archive))).size };
		} finally {
			await rm(context, { recursive: true, force: true });
		}
	};
	const find = (specs: typeof boot, prefix: string) => {
		const found = specs.find((spec) => spec.tag.startsWith(prefix));
		if (found === undefined) throw new Error(`No current-source image specification for ${prefix}`);
		return found;
	};
	const box = await build(find(boot, "banda-box:"), "box");
	const proxy = await build(find(boot, "banda-proxy:"), "proxy");
	const browser = await build(find(browserSpecs, "banda-browser:"), "browser");
	const local = (archive: "box.tar" | "proxy.tar", data: typeof box) => ({
		archive,
		sha256: data.sha256,
		ref: data.ref,
		digest: data.digest,
	});
	const images: MicrovmImages = {
		target: "linux-arm64",
		box: local("box.tar", box),
		proxy: local("proxy.tar", proxy),
		browser,
	};
	await writeFile(join(out, "images.json"), `${JSON.stringify(images, null, "\t")}\n`);
}

export async function verifiedMicrovmImages(directory: string): Promise<MicrovmImages> {
	const value: unknown = JSON.parse(await readFile(join(directory, "images.json"), "utf8"));
	if (!Value.Check(MicrovmImages, value)) throw new Error("The computer image manifest is invalid.");
	const specs = [
		...(await imageSpecs({ arch: "arm64", boxTarget: "boot" })),
		...(await imageSpecs({ arch: "arm64", boxTarget: "browser" })),
	];
	if (value.browser.archive !== `banda-browser-${value.browser.sha256}.tar`)
		throw new Error("The browser archive filename differs from its SHA-256.");
	for (const role of ["box", "proxy", "browser"] as const) {
		const image = value[role];
		if (!specs.some((spec) => spec.tag === image.ref))
			throw new Error(`The ${role} image was built from different sources. Rebuild the computer images.`);
		const archive = await verifyBundleFile(directory, image.archive, image.sha256);
		if (archiveImageDigest(archive, image.ref) !== image.digest)
			throw new Error(`The ${role} image's config digest does not match its manifest.`);
		if (role === "browser" && (await stat(archive)).size !== value.browser.bytes)
			throw new Error("The browser archive has the wrong size.");
	}
	return value;
}

/** Unsupported targets retain their existing backends and need no microVM build inputs. */
export async function stageMicrovmBundle(options: { root: string; out: string; target: Target }): Promise<void> {
	if (!microvmTarget(options.target)) return;
	const cache = join(options.root, "release", "cache", "computer");
	const suppliedImages = process.env.BANDA_COMPUTER_IMAGES || undefined;
	const imageDirectory = suppliedImages ?? join(cache, "images");
	if (suppliedImages === undefined) await buildMicrovmImages(imageDirectory);
	const images = await verifiedMicrovmImages(imageDirectory);
	const pkg: unknown = JSON.parse(await readFile(join(options.root, "package.json"), "utf8"));
	const PackageVersion = Type.Object({ version: Type.String({ pattern: "^[A-Za-z0-9._-]+$" }) });
	if (!Value.Check(PackageVersion, pkg)) throw new Error("The package has no valid release version.");
	const archive = process.env.BANDA_MICROVM_ARCHIVE ?? join(cache, VENDOR.archive);
	if (process.env.BANDA_MICROVM_ARCHIVE === undefined)
		await downloaded(archive, VENDOR.url, MICROSANDBOX_ARCHIVE_SHA256);
	if ((await fileSha256(archive)) !== MICROSANDBOX_ARCHIVE_SHA256)
		throw new Error("Microsandbox's vendor archive failed SHA-256 verification.");
	const bundle = join(options.out, "app", "computer");
	await rm(bundle, { recursive: true, force: true });
	await mkdir(bundle, { recursive: true });
	execFileSync("tar", ["-xzf", archive, "-C", bundle, "msb", "libkrunfw.5.dylib"]);
	await verifyBundleFile(bundle, "msb", VENDOR.msb);
	await verifyBundleFile(bundle, "libkrunfw.5.dylib", VENDOR.firmware);
	const entitlements = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", join(bundle, "msb")], {
		encoding: "utf8",
	});
	for (const key of ["com.apple.security.hypervisor", "com.apple.security.cs.disable-library-validation"])
		if (!entitlements.includes(`<key>${key}</key><true/>`)) throw new Error(`Microsandbox is missing ${key}.`);
	for (const file of ["msb", "libkrunfw.5.dylib"])
		execFileSync("/usr/bin/codesign", ["--verify", "--strict", join(bundle, file)]);
	await mkdir(join(bundle, "notices"), { recursive: true });
	for (const notice of NOTICES) {
		const cached = join(cache, notice.name);
		await downloaded(cached, notice.url, notice.sha256);
		await copyFile(cached, join(bundle, "notices", notice.name));
	}
	await writeFile(
		join(bundle, "notices", "INVENTORY.md"),
		`# Bundled computer: distribution review pending\n\nMicrosandbox ${MICROSANDBOX_VERSION}: https://github.com/superradcompany/microsandbox/tree/60fc5071b34e6cc2671c84c8dc07709795d45d27\nVendor archive SHA-256: ${MICROSANDBOX_ARCHIVE_SHA256}\nIts libkrunfw submodule: https://github.com/containers/libkrunfw/tree/223f11693774646eaa8ba892e3a6ebd07653154b\n\nThe included license texts and source inventory do not qualify redistribution. Corresponding source, third-party dependency notices and guest-image distribution requirements remain to be reviewed before release. Local candidate testing only.\n\nBox source identity: ${images.box.ref}; proxy source identity: ${images.proxy.ref}. Their Dockerfiles and inputs are shipped beside this bundle. Guest package license files remain in each image.\n`,
	);
	for (const role of ["box", "proxy"] as const)
		await copyFile(join(imageDirectory, images[role].archive), join(bundle, images[role].archive));
	await copyFile(join(imageDirectory, images.browser.archive), join(options.root, "release", images.browser.archive));
	const notice = async <T extends string>(path: T) => ({ path, sha256: await fileSha256(join(bundle, path)) });
	const manifest: MicrovmManifest = {
		target: "darwin-arm64",
		version: MICROSANDBOX_VERSION,
		vendorArchiveSha256: MICROSANDBOX_ARCHIVE_SHA256,
		msb: await notice("msb"),
		firmware: await notice("libkrunfw.5.dylib"),
		entitlements: { hypervisor: true, disableLibraryValidation: true },
		box: images.box,
		proxy: images.proxy,
		browser: {
			url: `https://github.com/purrgrammer/banda/releases/download/v${pkg.version}/${images.browser.archive}`,
			sha256: images.browser.sha256,
			ref: images.browser.ref,
			digest: images.browser.digest,
			bytes: images.browser.bytes,
		},
		notices: {
			microsandbox: await notice("notices/MICROSANDBOX-LICENSE"),
			firmwareGpl: await notice("notices/LIBKRUNFW-GPL-2.0"),
			firmwareLgpl: await notice("notices/LIBKRUNFW-LGPL-2.1"),
			inventory: await notice("notices/INVENTORY.md"),
		},
		redistribution: "review-required",
	};
	await writeFile(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	await readMicrovmAssets(bundle);
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: { images: { type: "boolean" }, prepare: { type: "boolean" }, out: { type: "string" } },
	});
	const root = resolve(import.meta.dirname, "..");
	if (values.images) await buildMicrovmImages(resolve(values.out ?? join(root, "release", "computer-images")));
	else if (values.prepare) {
		const out = await mkdtemp(join(tmpdir(), "banda-computer-stage-"));
		try {
			await stageMicrovmBundle({ root, out, target: { platform: process.platform, arch: process.arch } });
			await cp(join(out, "app", "computer"), resolve(values.out ?? join(root, "computer")), { recursive: true });
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	} else throw new Error("Use --images to build pinned images, or --prepare for an explicit development bundle.");
}
