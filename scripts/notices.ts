/**
 * The third-party notices a release carries inside itself, written into `app/licenses/` when it is staged:
 *
 *   README.txt         what every file here covers, and where the notices that live elsewhere in the release are
 *   npm-packages.txt   every npm package staged in `app/node_modules`, with the license texts they ship
 *   rust-crates.txt    every registry package of the Cargo.lock that `msb` and its guest agent are built from
 *   guest-images.txt   every package of the box and proxy images, with where its copyright file is inside the image
 *
 * The npm packages are read from the staged tree itself, the crates from the archives Cargo downloaded for the build
 * (each checked against the pinned Cargo.lock; one Cargo did not need is fetched by the same checksum), the images from
 * the archives the bundle carries. A package with no license text and no place on the lists below stops the staging:
 * a notice is never left out silently.
 */
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { Value } from "typebox/value";
import {
	fileSha256,
	MICROVM_PLATFORMS,
	MICROVM_SOURCE,
	MicrovmManifest,
	type MicrovmTarget,
	microvmTarget,
} from "../src/box/microvm-assets.ts";
import {
	dpkgPackages,
	ELECTRON_SOURCE,
	lockCrates,
	noticeFile,
	pythonDistribution,
	tarEntries,
} from "./release-materials.ts";
import { each, fetched, type ImageFile, imageNotices, resolved } from "./release-sources.ts";

export type Component = {
	readonly name: string;
	readonly version: string;
	/** What the package's own manifest declares; empty when it declares nothing. */
	readonly license: string;
	readonly texts: readonly { readonly file: string; readonly text: string }[];
};

/**
 * npm packages whose published tarball carries no license file, so they are listed by the license their manifest
 * declares and nothing more. A new one stops the staging until it is named here, having been looked at.
 */
export const NPM_WITHOUT_LICENSE_FILE: readonly (string | RegExp)[] = [
	"@aws-sdk/credential-provider-http",
	"@aws-sdk/credential-provider-login",
	"@aws-sdk/nested-clients",
	"@earendil-works/chord",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-codemode",
	"@earendil-works/pi-durable",
	"@earendil-works/pi-env",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-telemetry",
	"@number0/iroh",
	// the native addons, one package per platform
	/^@number0\/iroh-[a-z0-9-]+$/,
	/^@resvg\/resvg-js-[a-z0-9-]+$/,
	"data-uri-to-buffer",
	"proxy-agent-negotiate",
	"standardwebhooks",
];

const listed = (list: readonly (string | RegExp)[], name: string) =>
	list.some((entry) => (typeof entry === "string" ? entry === name : entry.test(name)));

/** A license text as it is compared and printed: one kind of line ending, no trailing blank space. */
const normal = (text: string) =>
	text
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.trim();

/**
 * A listed component, or the reason the staging stops: it declares no license and carries no text; or, where a list
 * of known cases is given, it carries no text and is not on it.
 */
function checked(component: Component, what: string, withoutFile?: readonly (string | RegExp)[]): Component {
	const { name, version, license, texts } = component;
	if (texts.length === 0 && license === "")
		throw new Error(`${what} ${name} ${version} declares no license and carries no license file.`);
	if (texts.length === 0 && withoutFile !== undefined && !listed(withoutFile, name))
		throw new Error(
			`${what} ${name} ${version} (${license}) carries no license file. Read its terms, then name it in scripts/notices.ts.`,
		);
	return component;
}

/** The license a package.json declares, in the current form or either retired one. */
export function npmLicense(manifest: object): string {
	const one = (value: unknown): string =>
		typeof value === "string"
			? value
			: typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
				? value.type
				: "";
	const declared = one("license" in manifest ? manifest.license : undefined);
	if (declared !== "") return declared;
	const retired = "licenses" in manifest ? manifest.licenses : undefined;
	return Array.isArray(retired) ? retired.map(one).filter(Boolean).join(" OR ") : "";
}

/** Every package under a `node_modules`, nested ones included, each once by name and version. */
export async function npmComponents(modules: string): Promise<Component[]> {
	const found = new Map<string, Component>();
	const visit = async (path: string): Promise<void> => {
		const manifest: unknown = JSON.parse(await readFile(join(path, "package.json"), "utf8").catch(() => "null"));
		if (
			typeof manifest !== "object" ||
			manifest === null ||
			!("name" in manifest) ||
			typeof manifest.name !== "string" ||
			!("version" in manifest) ||
			typeof manifest.version !== "string"
		)
			throw new Error(`${path} is not a package with a name and a version.`);
		const entries = await readdir(path, { withFileTypes: true });
		const texts: { file: string; text: string }[] = [];
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1)))
			if (entry.isFile() && noticeFile(entry.name))
				texts.push({ file: entry.name, text: normal(await readFile(join(path, entry.name), "utf8")) });
		const component = checked(
			{ name: manifest.name, version: manifest.version, license: npmLicense(manifest), texts },
			"npm package",
			NPM_WITHOUT_LICENSE_FILE,
		);
		const key = `${component.name}@${component.version}`;
		const earlier = found.get(key);
		// the same release installed twice carries the same files: keep the copy that has more of them
		if (earlier === undefined || earlier.texts.length < texts.length) found.set(key, component);
		if (entries.some((entry) => entry.name === "node_modules" && entry.isDirectory()))
			await walk(join(path, "node_modules"));
	};
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (!entry.name.startsWith("@")) await visit(join(directory, entry.name));
			else
				for (const scoped of await readdir(join(directory, entry.name), { withFileTypes: true }))
					if (scoped.isDirectory()) await visit(join(directory, entry.name, scoped.name));
		}
	};
	await walk(modules);
	if (found.size === 0) throw new Error(`${modules} holds no package.`);
	return sorted([...found.values()]);
}

const sorted = (components: readonly Component[]) =>
	[...components].sort((a, b) =>
		a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
	);

/** One registry package, from its `.crate` archive: the license its manifest declares and its top-level license files. */
export async function crateComponent(archive: string, name: string, version: string): Promise<Component> {
	const top = `${name}-${version}`;
	const read = async (wanted: (member: string) => boolean) => {
		const members = new Map<string, string>();
		for await (const entry of tarEntries(createReadStream(archive).pipe(createGunzip()))) {
			const [folder, member, ...deeper] = entry.path.split("/");
			if (entry.type !== "file" || folder !== top || member === undefined || deeper.length > 0 || !wanted(member))
				continue;
			if (entry.size > 8 << 20) throw new Error(`${entry.path} is too large for a notice.`);
			members.set(member, (await entry.bytes()).toString("utf8"));
		}
		return members;
	};
	const members = await read((member) => member === "Cargo.toml" || noticeFile(member));
	const manifest = members.get("Cargo.toml");
	if (manifest === undefined) throw new Error(`${archive} is not the crate ${top}.`);
	members.delete("Cargo.toml");
	const field = (key: string) => new RegExp(`^${key} = "([^"\\n]*)"$`, "m").exec(manifest)?.[1];
	const file = field("license-file");
	// a crate may name its license file anything; one at the top level is read whatever it is called
	if (file !== undefined && !file.includes("/") && !members.has(file))
		for (const [member, text] of await read((member) => member === file)) members.set(member, text);
	return checked(
		{
			name,
			version,
			license: field("license") ?? (file === undefined ? "" : `see ${file}`),
			texts: [...members]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([member, text]) => ({ file: member, text: normal(text) })),
		},
		"Rust crate",
	);
}

const rule = "-".repeat(78);

/**
 * One readable file for a set of components: each with its declared license and the numbers of its texts, then every
 * distinct text once, with the components that ship it. The same components always make the same bytes.
 */
export function noticeText(title: string, intro: string, components: readonly Component[]): string {
	const numbers = new Map<string, number>();
	const texts: { text: string; file: string; users: string[] }[] = [];
	const lines = [title, "=".repeat(title.length), "", intro, "", `Packages (${components.length})`, rule, ""];
	for (const component of sorted(components)) {
		const refs: string[] = [];
		for (const { file, text } of component.texts) {
			let number = numbers.get(text);
			if (number === undefined) {
				number = texts.push({ text, file, users: [] });
				numbers.set(text, number);
			}
			texts[number - 1]?.users.push(`${component.name} ${component.version}`);
			refs.push(`[${number}] ${file}`);
		}
		lines.push(
			`${component.name} ${component.version}`,
			`  License: ${component.license === "" ? "see its text" : component.license}`,
			`  Text: ${refs.length === 0 ? "the package ships no license file" : refs.join(", ")}`,
			"",
		);
	}
	lines.push(`License texts (${texts.length})`);
	for (const [index, { text, file, users }] of texts.entries())
		lines.push(rule, `[${index + 1}] ${file}, as shipped by: ${[...new Set(users)].join(", ")}`, rule, "", text, "");
	return `${lines.join("\n")}\n`;
}

/** What one guest image holds, and where each package's copyright file is inside it. */
export function imageListing(
	role: string,
	image: { archive: string; ref: string; digest: string },
	files: ReadonlyMap<string, ImageFile>,
): string {
	const status = files.get("var/lib/dpkg/status");
	if (status?.kind !== "file") throw new Error(`The ${role} image has no package database.`);
	const packages = dpkgPackages(status.data.toString("utf8"));
	const lines = [
		`The ${role} image: ${image.archive}`,
		`  ${image.ref}, configuration ${image.digest}`,
		"",
		`  Debian packages (${packages.length}), each with its copyright file inside the image:`,
	];
	for (const entry of [...packages].sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const copyright = resolved(files, `usr/share/doc/${entry.name.split(":")[0]}/copyright`);
		lines.push(
			`    ${entry.name} ${entry.version}: ${copyright === undefined ? "the image holds no copyright file for it" : `/${copyright}`}`,
		);
	}
	const python: string[] = [];
	for (const [path, file] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (file.kind !== "file" || !path.endsWith(".dist-info/METADATA")) continue;
		const { name, version, license } = pythonDistribution(file.data.toString("utf8"));
		const folder = path.slice(0, -"METADATA".length);
		const texts = [...files.keys()].filter((other) => other.startsWith(folder) && other !== path).sort();
		python.push(
			`    ${name} ${version}${license === "" ? "" : ` (${license.split("\n")[0]?.slice(0, 80)})`}: ${
				texts.length === 0 ? `/${path}` : texts.map((text) => `/${text}`).join(", ")
			}`,
		);
	}
	if (python.length > 0)
		lines.push(
			"",
			`  Python distributions (${python.length}), each with its license files inside the image:`,
			...python,
		);
	return `${lines.join("\n")}\n`;
}

/** The index: every notice a release carries, by where it is. Paths are from the release's top folder. */
export function noticesIndex(facts: {
	version: string;
	target: string;
	node: string;
	npm: number;
	crates?: number;
	images?: readonly string[];
}): string {
	const { ffmpeg, chromium } = ELECTRON_SOURCE;
	const item = (what: string, ...where: string[]) => [`  ${what}`, ...where.map((path) => `      ${path}`)];
	const computer =
		facts.crates === undefined
			? []
			: [
					"",
					"The computer (app/computer)",
					...item("Microsandbox's msb, built from its source", "app/computer/notices/MICROSANDBOX-LICENSE"),
					...item(`The ${facts.crates} Rust crates of Microsandbox's Cargo.lock`, "app/licenses/rust-crates.txt"),
					...item(
						"The libkrunfw firmware (LGPL-2.1) and the Linux kernel inside it (GPL-2.0)",
						"app/computer/notices/LIBKRUNFW-LGPL-2.1",
						"app/computer/notices/LIBKRUNFW-GPL-2.0",
					),
					...item("What exactly was built, and from what", "app/computer/notices/INVENTORY.md"),
					...item(`The guest images (${(facts.images ?? []).join(", ")})`, "app/licenses/guest-images.txt"),
					"    Each image is a Debian system. Its packages' copyright files are inside the image, at",
					"    /usr/share/doc/<package>/copyright, where Debian puts them, and guest-images.txt lists every",
					"    package with that path. In a running computer, `cat /usr/share/doc/<package>/copyright`",
					"    prints one. The browser's image is downloaded on first use and holds its own the same way.",
					`    A published release also has them unpacked, in banda-${facts.version}-notices.tar.`,
				];
	return `${[
		`Third-party notices for banda ${facts.version} (${facts.target})`,
		"",
		"banda itself is licensed under the AGPL-3.0: app/LICENSE. It carries the work of others, each under its own",
		"license. This file says where each of those licenses is. Paths start at the folder that holds `app` and `node`:",
		"the top of the command-line archive, and `resources/banda` (`Resources/banda` on a Mac) inside the desktop app.",
		"",
		"The application (app)",
		...item(`The ${facts.npm} npm packages in app/node_modules`, "app/licenses/npm-packages.txt"),
		...item(
			"Material copied into banda's own source",
			"app/THIRD_PARTY_NOTICES.md, and the text it names:",
			"app/licenses/open-bot-avatar-MIT.txt",
		),
		...item(`Node.js ${facts.node}, which runs it`, "node/LICENSE"),
		...computer,
		"",
		"The desktop app only (none of this is in the command-line archive)",
		...item(`Electron ${ELECTRON_SOURCE.version}`, "LICENSE.electron.txt"),
		...item(`Chromium ${chromium.version} and everything it contains`, "LICENSES.chromium.html"),
		"    On a Mac both files are in banda.app/Contents/Resources; on Linux, in /opt/banda.",
		"",
		"  FFmpeg. The desktop app includes FFmpeg's libavcodec, libavformat and libavutil as a shared library of",
		"  its own, which Electron loads when it starts: libffmpeg.dylib in banda.app/Contents/Frameworks/",
		"  Electron Framework.framework/Libraries on a Mac, /opt/banda/libffmpeg.so on Linux. It is the library",
		`  Electron ${ELECTRON_SOURCE.version} distributes, built by Electron from Chromium's copy of FFmpeg at commit`,
		`  ${ffmpeg.commit}, and it is licensed under the GNU Lesser General Public`,
		'  License, version 2.1 or later. The text of that license is in LICENSES.chromium.html, under "ffmpeg".',
		"  Its source code is published with every release of banda, in the same place as the downloads:",
		"  RELEASE-SOURCES.md there says which files hold it.",
		"",
		"Source code",
		"  banda: https://github.com/purrgrammer/banda",
		"  Every release publishes, beside its downloads, the source code of the kernel, the firmware, Microsandbox,",
		"  the Rust crates, the guest images' packages and FFmpeg, with release-materials.json naming each file by",
		"  SHA-256: https://github.com/purrgrammer/banda/releases",
	].join("\n")}\n`;
}

/** Every registry package of the pinned Cargo.lock, from Cargo's own downloads where it has them. */
async function crateComponents(root: string): Promise<Component[]> {
	const cache = join(root, "release", "cache", "computer");
	const source = join(cache, "runtime", "downloads", `microsandbox-${MICROVM_SOURCE.commit}.tar.gz`);
	if ((await fileSha256(source).catch(() => "")) !== MICROVM_SOURCE.archiveSha256)
		throw new Error("The Microsandbox source the computer was built from is missing or changed.");
	let lock: Buffer | undefined;
	for await (const entry of tarEntries(createReadStream(source).pipe(createGunzip())))
		if (entry.type === "file" && entry.path === `microsandbox-${MICROVM_SOURCE.commit}/Cargo.lock`)
			lock = Buffer.from(await entry.bytes());
	if (lock === undefined) throw new Error("The Microsandbox source has no Cargo.lock.");
	const registry = join(cache, "runtime", "cargo", "registry", "cache");
	const downloaded = new Map<string, string>();
	for (const index of await readdir(registry).catch(() => []))
		for (const file of await readdir(join(registry, index))) downloaded.set(file, join(registry, index, file));
	const components: Component[] = [];
	await each(lockCrates(lock.toString("utf8")), 8, async (crate) => {
		const file = `${crate.name}-${crate.version}.crate`;
		const cargo = downloaded.get(file);
		const archive =
			cargo !== undefined && (await fileSha256(cargo)) === crate.sha256
				? cargo
				: await fetched(cache, `crates/${file}`, [`https://static.crates.io/crates/${crate.name}/${file}`], {
						sha256: crate.sha256,
					});
		components.push(await crateComponent(archive, crate.name, crate.version));
	});
	return components;
}

async function imageListings(bundle: string, target: MicrovmTarget): Promise<{ roles: string[]; text: string }> {
	const manifest: unknown = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
	if (!Value.Check(MicrovmManifest, manifest)) throw new Error("The staged computer's manifest is invalid.");
	const roles = ["box", "proxy"] as const;
	const parts: string[] = [];
	for (const role of roles) {
		const image = manifest[role];
		const { digest, files } = await imageNotices(
			join(bundle, image.archive),
			image.ref,
			MICROVM_PLATFORMS[target].arch,
		);
		if (digest !== image.digest) throw new Error(`The staged ${role} image differs from its manifest.`);
		parts.push(imageListing(role, { ...image, archive: `app/computer/${image.archive}` }, files));
	}
	const title = "The guest images' packages";
	return {
		roles: [...roles],
		text: `${title}\n${"=".repeat(title.length)}\n\nThe computer's images are Debian systems, carried as image archives. Every package installed in one has its\ncopyright and license file inside the image, at the path given here.\n\n${parts.join("\n")}`,
	};
}

/** Writes the notices of a staged release into its `app/licenses/`, and returns the index's text. */
export async function stageNotices(options: {
	root: string;
	out: string;
	target: { platform: string; arch: string };
	node: string;
}): Promise<string> {
	const { root, out } = options;
	const licenses = join(out, "app", "licenses");
	await mkdir(licenses, { recursive: true });
	const read = async (path: string) => JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
	const version = String((await read("package.json")).version);
	const desktop = (await read("desktop/package.json")).devDependencies as Record<string, string> | undefined;
	if (desktop?.electron !== ELECTRON_SOURCE.version)
		throw new Error(
			`The desktop app is built on Electron ${desktop?.electron}, and the notices name ${ELECTRON_SOURCE.version}. Pin its FFmpeg source in scripts/release-materials.ts.`,
		);
	const npm = await npmComponents(join(out, "app", "node_modules"));
	await writeFile(
		join(licenses, "npm-packages.txt"),
		noticeText(
			"npm packages",
			"The packages in app/node_modules, which banda runs on. Each is listed with the license its own package.json\ndeclares and the license files it ships; each distinct text is printed once, below the list.",
			npm,
		),
	);
	const computer = microvmTarget(options.target);
	let crates: number | undefined;
	let images: string[] | undefined;
	if (computer !== undefined) {
		const components = await crateComponents(root);
		crates = components.length;
		await writeFile(
			join(licenses, "rust-crates.txt"),
			noticeText(
				"Rust crates",
				`The registry packages of the Cargo.lock that Microsandbox's msb (app/computer/msb) and the guest agent inside it\nare built from, at Microsandbox ${MICROVM_SOURCE.commit}. The lock names every package any platform\nor feature could need, so this list holds more than either program contains. Each is listed with the license its\nCargo.toml declares and the license files its archive ships; each distinct text is printed once, below the list.`,
				components,
			),
		);
		const listings = await imageListings(join(out, "app", "computer"), computer);
		images = listings.roles;
		await writeFile(join(licenses, "guest-images.txt"), listings.text);
	}
	const index = noticesIndex({
		version,
		target: `${options.target.platform}-${options.target.arch}`,
		node: options.node,
		npm: npm.length,
		crates,
		images,
	});
	await writeFile(join(licenses, "README.txt"), index);
	return index;
}
