import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export const MICROSANDBOX_VERSION = "0.7.14";
export const MICROSANDBOX_ARCHIVE_SHA256 = "9cc2bd2874cc1aa98cb139429a9482830b1e64b48255aa9f40a25b8979a23a9f";
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
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
export const MicrovmManifest = Type.Object(
	{
		target: Type.Literal("darwin-arm64"),
		version: Type.Literal(MICROSANDBOX_VERSION),
		vendorArchiveSha256: Type.Literal(MICROSANDBOX_ARCHIVE_SHA256),
		msb: file("msb"),
		firmware: file("libkrunfw.5.dylib"),
		entitlements: Type.Object(
			{ hypervisor: Type.Literal(true), disableLibraryValidation: Type.Literal(true) },
			{ additionalProperties: false },
		),
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
	},
	{ additionalProperties: false },
);
export type MicrovmManifest = Static<typeof MicrovmManifest>;
export const MicrovmImages = Type.Object(
	{ target: Type.Literal("linux-arm64"), box: image("box"), proxy: image("proxy"), browser: BrowserArtifact },
	{ additionalProperties: false },
);
export type MicrovmImages = Static<typeof MicrovmImages>;

export type MicrovmAssets = {
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
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("The bundled computer currently supports macOS on Apple silicon only.");
	return readMicrovmAssets(fileURLToPath(new URL("../../computer/", import.meta.url)));
}

/** Data validation for staging and tests, never an executable runtime-selection API. */
export async function readMicrovmAssets(directory: string): Promise<MicrovmAssets> {
	const root = await realpath(directory).catch(() => {
		throw new Error("The bundled computer is missing. Reinstall banda, or prepare its development bundle.");
	});
	const value: unknown = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
	if (!Value.Check(MicrovmManifest, value))
		throw new Error("The computer bundle's manifest is invalid or unsupported.");
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
		root,
		msb,
		firmware,
		box: await readImage(value.box),
		proxy: await readImage(value.proxy),
		browser: value.browser,
	};
}
