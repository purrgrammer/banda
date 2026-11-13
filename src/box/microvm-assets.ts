import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export const MICROSANDBOX_VERSION = "0.7.14";
export const MICROSANDBOX_ARCHIVE_SHA256 = "9cc2bd2874cc1aa98cb139429a9482830b1e64b48255aa9f40a25b8979a23a9f";
export const MICROVM_SOURCE = {
	commit: "60fc5071b34e6cc2671c84c8dc07709795d45d27",
	archiveSha256: "7b733474c8b540f53854f85c476ebe397392c023335eb7faab27bf6e93098a66",
	lockSha256: "11825ddbb8eb7f1f9bde497521c4a315fc46c1eb428b2c220cda422457f9bf47",
	rust: "1.99.1",
	features: "embed-binaries,net,ssh,keyring",
} as const;
const ARM_AGENTD = {
	asset: "agentd-aarch64",
	sha256: "6eb84756979eb1310b7dd54c5684b108ff7a4c0de643337a8462729b04cb770d",
} as const;
const X64_AGENTD = {
	asset: "agentd-x86_64",
	sha256: "743ba6497d7006838e1276bc4965b524ca6718a638d613e9cfc8240c8f5f5276",
} as const;
export const MICROVM_PLATFORMS = {
	"darwin-arm64": {
		rustTarget: "aarch64-apple-darwin",
		agentd: ARM_AGENTD,
		arch: "arm64",
		archive: "microsandbox-darwin-aarch64.tar.gz",
		sha256: MICROSANDBOX_ARCHIVE_SHA256,
		msb: "825e8a1e948b8a578739d66cfddeb9dd02deb17a517eb31de09fceba8b4ab155",
		firmware: "libkrunfw.5.dylib",
		firmwareSha256: "0104316ba962bb6f4bbf6da882e4b1dc5eb0453af8153c3e636d7433508d80ef",
	},
	"linux-arm64": {
		rustTarget: "aarch64-unknown-linux-gnu",
		agentd: ARM_AGENTD,
		manylinux:
			"quay.io/pypa/manylinux_2_28_aarch64@sha256:561427136aabf3787bffb294b3515748241e0962d1527ae28bea1e076bfb9d99",
		arch: "arm64",
		archive: "microsandbox-linux-aarch64.tar.gz",
		sha256: "a0c54cd06bea4d2a5bd3fc291063f8f2f5e073232db78f6860c527922ec71906",
		msb: "1c771c485dbb0bcb7c738b035c9a7e2afa6baa50b673251961f3e8ae0be511ac",
		firmware: "libkrunfw.so.5.6.1",
		firmwareSha256: "aa1234f0f4c94cb3d2d68bfdc08fbab6602c8635ae1d5fcab9e0f16b8ff3276b",
	},
	"linux-x64": {
		rustTarget: "x86_64-unknown-linux-gnu",
		agentd: X64_AGENTD,
		manylinux:
			"quay.io/pypa/manylinux_2_28_x86_64@sha256:0c87ccb5996dab6c3b7612ee4fda7b80c4ab3c44a86c2541e4a872afdf4f131b",
		arch: "x64",
		archive: "microsandbox-linux-x86_64.tar.gz",
		sha256: "34d49a7388685f0ea24bfbeecf6864a44718959b57087f1d7481775672db9585",
		msb: "cd9fa9270987f1627cf1fd04205e5e9d8ad3d3075ffc0e98236a2398d8636f3e",
		firmware: "libkrunfw.so.5.6.1",
		firmwareSha256: "e5480f2feb911c5d9a508559cc13e35983c9811acc2f136e24bb8040461a7a52",
	},
} as const;
export type MicrovmTarget = keyof typeof MICROVM_PLATFORMS;

export function microvmTarget({ platform, arch }: { platform: string; arch: string }): MicrovmTarget | undefined {
	if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
	if (platform === "linux" && arch === "arm64") return "linux-arm64";
	if (platform === "linux" && arch === "x64") return "linux-x64";
	return undefined;
}
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const MicrovmRuntimeBuild = Type.Object(
	{
		execution: Type.Literal("require-running"),
		source: Type.Object(
			{ commit: Type.Literal(MICROVM_SOURCE.commit), sha256: Type.Literal(MICROVM_SOURCE.archiveSha256) },
			{ additionalProperties: false },
		),
		patchSha256: hash,
		lockSha256: Type.Literal(MICROVM_SOURCE.lockSha256),
		recipeSha256: hash,
		environment: Type.Union([
			Type.Object(
				{ platform: Type.Literal("darwin"), minimumVersion: Type.Literal("14.0") },
				{ additionalProperties: false },
			),
			Type.Object(
				{
					platform: Type.Literal("linux"),
					image: Type.Union([
						Type.Literal(MICROVM_PLATFORMS["linux-arm64"].manylinux),
						Type.Literal(MICROVM_PLATFORMS["linux-x64"].manylinux),
					]),
					glibc: Type.Literal("2.28"),
				},
				{ additionalProperties: false },
			),
		]),
		compiler: Type.Object(
			{
				version: Type.Literal(MICROVM_SOURCE.rust),
				target: Type.String({
					pattern: `^(?:${Object.values(MICROVM_PLATFORMS)
						.map((entry) => entry.rustTarget)
						.join("|")})$`,
				}),
				rustc: hash,
				cargo: hash,
				std: hash,
			},
			{ additionalProperties: false },
		),
		agentdSha256: hash,
		features: Type.Literal(MICROVM_SOURCE.features),
	},
	{ additionalProperties: false },
);
export type MicrovmRuntimeBuild = Static<typeof MicrovmRuntimeBuild>;
const file = <T extends string>(path: T) =>
	Type.Object({ path: Type.Literal(path), sha256: hash }, { additionalProperties: false });
const image = (name: "box" | "proxy") =>
	Type.Object(
		{
			archive: Type.Literal(`${name}.tar`),
			sha256: hash,
			ref: Type.String({ pattern: `^banda-${name}:[a-f0-9]{12}$` }),
			digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
		},
		{ additionalProperties: false },
	);

const browserIdentity = {
	sha256: hash,
	ref: Type.String({ pattern: "^banda-browser:[a-f0-9]{12}$" }),
	digest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
	bytes: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 * 1024 }),
};
export const BrowserArtifact = Type.Object(
	{ ...browserIdentity, archive: Type.String({ pattern: "^banda-browser-[a-f0-9]{64}\\.tar$" }) },
	{ additionalProperties: false },
);
export type BrowserArtifact = Static<typeof BrowserArtifact>;
export const MicrovmBrowser = Type.Object(
	{
		...browserIdentity,
		url: Type.String({
			pattern:
				"^https://github\\.com/purrgrammer/banda/releases/download/v[A-Za-z0-9._-]+/banda-browser-[a-f0-9]{64}\\.tar$",
		}),
	},
	{ additionalProperties: false },
);
export type MicrovmBrowser = Static<typeof MicrovmBrowser>;

/** Installed data, checked on every read; paths are fixed so no manifest can select outside its bundle. */
const manifest = {
	version: Type.Literal(MICROSANDBOX_VERSION),
	runtimeBuild: MicrovmRuntimeBuild,
	msb: file("msb"),
	box: image("box"),
	proxy: image("proxy"),
	browser: MicrovmBrowser,
	notices: Type.Object(
		{
			microsandbox: file("notices/MICROSANDBOX-LICENSE"),
			firmwareGpl: file("notices/LIBKRUNFW-GPL-2.0"),
			firmwareLgpl: file("notices/LIBKRUNFW-LGPL-2.1"),
			inventory: file("notices/INVENTORY.md"),
		},
		{ additionalProperties: false },
	),
	redistribution: Type.Literal("review-required"),
};
export const MicrovmManifest = Type.Union([
	Type.Object(
		{
			...manifest,
			target: Type.Literal("darwin-arm64"),
			redistribution: Type.Union([Type.Literal("review-required"), Type.Literal("reviewed")]),
			vendorArchiveSha256: Type.Literal(MICROVM_PLATFORMS["darwin-arm64"].sha256),
			firmware: file("libkrunfw.5.dylib"),
			entitlements: Type.Object(
				{ hypervisor: Type.Literal(true), disableLibraryValidation: Type.Literal(true) },
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...manifest,
			target: Type.Literal("linux-arm64"),
			vendorArchiveSha256: Type.Literal(MICROVM_PLATFORMS["linux-arm64"].sha256),
			firmware: file("libkrunfw.so.5.6.1"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...manifest,
			target: Type.Literal("linux-x64"),
			vendorArchiveSha256: Type.Literal(MICROVM_PLATFORMS["linux-x64"].sha256),
			firmware: file("libkrunfw.so.5.6.1"),
		},
		{ additionalProperties: false },
	),
]);
export type MicrovmManifest = Static<typeof MicrovmManifest>;
export const MicrovmImages = Type.Object(
	{
		target: Type.Union([Type.Literal("linux-arm64"), Type.Literal("linux-x64")]),
		box: image("box"),
		proxy: image("proxy"),
		browser: BrowserArtifact,
	},
	{ additionalProperties: false },
);
export type MicrovmImages = Static<typeof MicrovmImages>;

export type MicrovmAssets = {
	readonly target: MicrovmTarget;
	readonly root: string;
	readonly msb: string;
	readonly firmware: string;
	readonly box: { readonly archive: string; readonly ref: string; readonly digest: string };
	readonly proxy: { readonly archive: string; readonly ref: string; readonly digest: string };
	readonly browser: MicrovmBrowser;
};

export async function fileSha256(path: string): Promise<string> {
	const digest = createHash("sha256");
	for await (const bytes of createReadStream(path)) digest.update(bytes);
	return digest.digest("hex");
}

export async function verifyBundleFile(root: string, path: string, sha256: string): Promise<string> {
	const actualRoot = await realpath(root);
	const actual = await realpath(resolve(actualRoot, path));
	const below = relative(actualRoot, actual);
	if (below === "" || below === ".." || below.startsWith("../") || isAbsolute(below))
		throw new Error(`The computer bundle's ${path} is outside its folder.`);
	if (!(await stat(actual)).isFile() || (await fileSha256(actual)) !== sha256)
		throw new Error(`The computer bundle's ${path} failed SHA-256 verification.`);
	return actual;
}

/** Runtime assets belong to this installation; configuration can never select host-executable bytes. */
export async function installedMicrovmAssets(): Promise<MicrovmAssets> {
	if (process.env.BANDA_COMPUTER_BUNDLE !== undefined)
		throw new Error(
			"BANDA_COMPUTER_BUNDLE is not supported. The computer runtime must come from banda's installation.",
		);
	const target = microvmTarget(process);
	if (target === undefined)
		throw new Error("The bundled computer currently supports Apple silicon Macs and Linux on x64 or ARM64.");
	return readMicrovmAssets(fileURLToPath(new URL("../../computer/", import.meta.url)), target);
}

/** Data validation for staging and tests, never an executable runtime-selection API. */
export async function readMicrovmAssets(directory: string, expectedTarget?: MicrovmTarget): Promise<MicrovmAssets> {
	const root = await realpath(directory).catch(() => {
		throw new Error("The bundled computer is missing. Reinstall banda, or prepare its development bundle.");
	});
	const value: unknown = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
	if (!Value.Check(MicrovmManifest, value))
		throw new Error("The computer bundle's manifest is invalid or unsupported.");
	if (expectedTarget !== undefined && value.target !== expectedTarget)
		throw new Error("The bundled computer was built for a different operating system or CPU.");
	const buildInput = MICROVM_PLATFORMS[value.target];
	if (
		value.runtimeBuild.compiler.target !== buildInput.rustTarget ||
		value.runtimeBuild.agentdSha256 !== buildInput.agentd.sha256
	)
		throw new Error("The computer runtime was built for different native inputs.");
	if (
		"manylinux" in buildInput
			? value.runtimeBuild.environment.platform !== "linux" ||
				value.runtimeBuild.environment.image !== buildInput.manylinux
			: value.runtimeBuild.environment.platform !== "darwin"
	)
		throw new Error("The computer runtime was built for a different platform baseline.");
	if (!value.browser.url.endsWith(`/banda-browser-${value.browser.sha256}.tar`))
		throw new Error("The browser download's filename differs from its pinned SHA-256.");
	const check = (entry: { path: string; sha256: string }) => verifyBundleFile(root, entry.path, entry.sha256);
	const msb = await check(value.msb);
	const firmware = await check(value.firmware);
	for (const entry of Object.values(value.notices)) await check(entry);
	const readImage = async (entry: typeof value.box) => ({
		archive: await verifyBundleFile(root, entry.archive, entry.sha256),
		ref: entry.ref,
		digest: entry.digest,
	});
	return {
		target: value.target,
		root,
		msb,
		firmware,
		box: await readImage(value.box),
		proxy: await readImage(value.proxy),
		browser: value.browser,
	};
}
