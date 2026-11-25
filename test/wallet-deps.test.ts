/**
 * The supply-chain rules of docs/wallets/stack.md section 5, read from the lockfiles. What ships is each lockfile's
 * production tree, and two closures of packages that are dev to npm but ship all the same: what the files `web/src`
 * reaches import (the daemon's sources it imports by relative path included), bundled into the web app, and the desktop
 * shell (Electron and what `desktop/src` imports). Their package names are
 * held to `production-packages.json` by equality, so an added package is a reviewed diff (H-303). To change
 * it on purpose: `BANDA_PRODUCTION_PACKAGES=update npm run test:fast -- test/wallet-deps.test.ts` rewrites the file
 * and still fails; read `git diff test/production-packages.json`, rerun, and commit it with the change. It refuses to
 * write under CI.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { bundledPackages, importedPackages } from "../scripts/imports.ts";
import {
	closure,
	copies,
	forbidden,
	ids,
	KEYCHAIN,
	type LockedPackage,
	names,
	parseLockfile,
	production,
	readLockfile,
	SIGNING,
	signingPath,
	strayCopies,
	unverified,
} from "../scripts/lockfile.ts";
import { ACCEPTED } from "../scripts/osv-audit.ts";
import { getJson, retryDelay } from "../scripts/registry-fetch.ts";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};
const TREES = ["package-lock.json", "desktop/package-lock.json", "mobile/package-lock.json"] as const;
const lockfiles = Object.fromEntries(TREES.map((file) => [file, readLockfile(new URL(file, root).pathname)]));
const locked = lockfiles["package-lock.json"];

const WEB = new URL("web/src/", root).pathname;
const webImports = bundledPackages(WEB, { alias: WEB, absent: (path) => path.includes("/iroh/pkg/") });

/** Every set of packages a build ships, by where it comes from. */
const SHIPPED: Record<string, LockedPackage[]> = {
	...Object.fromEntries(TREES.map((file) => [file, production(lockfiles[file])])),
	"web/src (bundled)": closure(locked, webImports),
	"desktop shell (Electron and desktop/src)": closure(lockfiles["desktop/package-lock.json"], [
		"electron",
		...bundledPackages(new URL("desktop/src/", root).pathname),
	]),
};

const HARNESS = { "@x402/core": "2.30.0", "@x402/evm": "2.30.0", "@x402/express": "2.30.0", express: "5.3.0" };
const KEYCHAIN_PLATFORMS = [
	"darwin-arm64",
	"darwin-x64",
	"freebsd-x64",
	"linux-arm-gnueabihf",
	"linux-arm64-gnu",
	"linux-arm64-musl",
	"linux-riscv64-gnu",
	"linux-x64-gnu",
	"linux-x64-musl",
	"win32-arm64-msvc",
	"win32-ia32-msvc",
	"win32-x64-msvc",
];

const SNAPSHOT = new URL("./production-packages.json", import.meta.url);
const Snapshot = Type.Record(Type.String(), Type.Array(Type.String()));
const UPDATE = process.env.BANDA_PRODUCTION_PACKAGES === "update";

/** This process's environment without the `npm_config_*` an `npm run` above it exports, so npm reads only the tree. */
const npmEnv = (settings: Record<string, string>) => ({
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))),
	...settings,
});

describe("the wallet's dependencies (docs/wallets/stack.md)", () => {
	test("are pinned exactly, the signer's and the keychain's in production and the x402 harness in dev", () => {
		for (const [name, version] of Object.entries({ ...SIGNING, ...KEYCHAIN })) {
			expect(manifest.dependencies[name], name).toBe(version);
			expect(manifest.devDependencies[name], name).toBeUndefined();
		}
		for (const [name, version] of Object.entries(HARNESS)) {
			expect(manifest.devDependencies[name], name).toBe(version);
			expect(manifest.dependencies[name], name).toBeUndefined();
		}
	});

	test("the production tree holds one curve library and one hash library, and nothing shipped holds another (H-308)", () => {
		for (const name of ["@noble/curves", "@noble/hashes"]) {
			expect(copies(SHIPPED["package-lock.json"], name), name).toEqual([`${name}@2.4.0`]);
			expect(strayCopies(SHIPPED, name, "2.4.0")).toEqual([]);
		}
	});

	test("the bundles' closures are read from what their sources import", () => {
		expect(webImports).toEqual(expect.arrayContaining(["react", "radix-ui", "streamdown", "tailwindcss"]));
		expect(webImports, "reached through src/core").toContain("mdast-util-from-markdown");
		expect(webImports).not.toContain("vitest");
		expect(names(SHIPPED["web/src (bundled)"])).toContain("react-dom");
		expect(names(SHIPPED["desktop shell (Electron and desktop/src)"])).toContain("electron");
	});

	test("no x402 SDK, viem, ox, ethers or keytar ships in any tree or bundle (H-244, H-303)", () => {
		for (const [set, shipped] of Object.entries(SHIPPED)) expect(forbidden(shipped), set).toEqual([]);
	});

	test("the signer's closure is the approved list, nothing more (H-301, H-303)", () => {
		expect(ids(closure(locked, Object.keys(SIGNING)))).toEqual(
			[
				"@noble/ciphers@2.4.0",
				"@noble/curves@2.4.0",
				"@noble/hashes@2.4.0",
				"@scure/base@2.4.0",
				"micro-eth-signer@0.20.1",
				"micro-packed@0.11.1",
			].sort(),
		);
	});

	test("the signing path the registry check holds to provenance is the signer's and the keychain's closures (H-301)", () => {
		expect(ids(signingPath(locked))).toEqual(
			[...closure(locked, Object.keys(SIGNING)), ...closure(locked, Object.keys(KEYCHAIN))]
				.map((p) => `${p.name}@${p.version}`)
				.sort(),
		);
		expect(ids(signingPath(locked))).toHaveLength(19);
	});

	test("no advisory accepted for dev only is on a package any set ships (scripts/osv-audit.ts)", () => {
		const shipped = new Set(Object.values(SHIPPED).flatMap((list) => list.map((p) => p.name)));
		const devOnly = Object.entries(ACCEPTED)
			.filter(([, entry]) => !entry.production)
			.map(([key]) => key.split(" ")[1]);
		expect(devOnly.length).toBeGreaterThan(0);
		for (const id of devOnly) expect(shipped.has(id.slice(0, id.lastIndexOf("@"))), id).toBe(false);
	});

	test("the keychain's closure is the module and its twelve platform packages at 2.1.2, all production (H-302)", () => {
		const keychain = closure(locked, Object.keys(KEYCHAIN));
		expect(ids(keychain)).toEqual(
			["@napi-rs/keyring@2.1.2", ...KEYCHAIN_PLATFORMS.map((p) => `@napi-rs/keyring-${p}@2.1.2`)].sort(),
		);
		for (const p of keychain) expect(p.production, p.name).toBe(true);
	});

	test("every shipped package comes from the npm registry with a sha512 integrity hash (H-302, H-303)", () => {
		for (const [set, shipped] of Object.entries(SHIPPED)) expect(unverified(shipped), set).toEqual([]);
	});

	test("the shipped package names are the reviewed set (H-303)", () => {
		const actual = Object.fromEntries(Object.entries(SHIPPED).map(([set, shipped]) => [set, names(shipped)]));
		if (UPDATE) {
			if (process.env.CI) throw new Error("BANDA_PRODUCTION_PACKAGES=update refuses to write under CI");
			writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, "\t")}\n`);
			throw new Error("test/production-packages.json rewritten: read its diff, then rerun without the update");
		}
		const reviewed = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as unknown;
		expect(Value.Check(Snapshot, reviewed)).toBe(true);
		expect(actual).toEqual(reviewed);
	});

	test("npm waits 14 days before resolving a new release in every tree, except banda's lockstep packages (H-307)", () => {
		for (const dir of ["", "desktop/", "mobile/"]) {
			const settings = readFileSync(new URL(`${dir}.npmrc`, root), "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "" && !line.startsWith("#"));
			expect(settings, `${dir}.npmrc`).toContain("min-release-age=14");
			expect(settings, `${dir}.npmrc`).toContain("min-release-age-exclude[]=@earendil-works/*");
		}
	});

	test("the root tree runs no install script, wherever it is installed (H-301)", () => {
		const settings = readFileSync(new URL(".npmrc", root), "utf8")
			.split("\n")
			.map((line) => line.trim());
		expect(settings).toContain("ignore-scripts=true");
	});

	test("the desktop and phone trees refuse an install script their allowScripts does not name (H-301)", () => {
		for (const dir of ["desktop/", "mobile/"]) {
			const settings = readFileSync(new URL(`${dir}.npmrc`, root), "utf8")
				.split("\n")
				.map((line) => line.trim());
			expect(settings, `${dir}.npmrc`).toContain("strict-allow-scripts=true");
			const manifest = JSON.parse(readFileSync(new URL(`${dir}package.json`, root), "utf8")) as {
				allowScripts?: Record<string, boolean>;
			};
			const lock = JSON.parse(readFileSync(new URL(`${dir}package-lock.json`, root), "utf8")) as {
				packages: Record<string, { version?: string; hasInstallScript?: boolean }>;
			};
			const scripted = Object.entries(lock.packages)
				.filter(([, entry]) => entry.hasInstallScript)
				.map(
					([path, entry]) =>
						`${path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`,
				);
			expect(
				scripted.filter((id) => manifest.allowScripts?.[id] !== true),
				`${dir}package.json allowScripts`,
			).toEqual([]);
		}
	});

	test("the npm the checks run with knows each tree's settings and reads them from it", () => {
		const userconfig = join(mkdtempSync(join(tmpdir(), "banda-npmrc-")), "npmrc");
		try {
			for (const dir of ["", "desktop/", "mobile/"]) {
				const keys = [
					"min-release-age",
					"min-release-age-exclude",
					dir === "" ? "ignore-scripts" : "strict-allow-scripts",
				];
				const run = spawnSync("npm", ["config", "get", ...keys], {
					cwd: new URL(dir, root),
					encoding: "utf8",
					env: npmEnv({ npm_config_userconfig: userconfig }),
				});
				expect(run.status, run.stderr).toBe(0);
				expect(run.stderr, `${dir}.npmrc`).not.toMatch(/Unknown (project|user|global) config/);
				expect(run.stdout.trim().split("\n"), `${dir}.npmrc`).toEqual([
					"min-release-age=14",
					"min-release-age-exclude=@earendil-works/*",
					dir === "" ? "ignore-scripts=true" : "strict-allow-scripts=true",
				]);
			}
		} finally {
			rmSync(dirname(userconfig), { recursive: true, force: true });
		}
	});

	test("the npm the checks run with runs no install script under the root .npmrc, and fails one allowScripts does not name under the desktop's and phone's", () => {
		const scratch = realpathSync(mkdtempSync(join(tmpdir(), "banda-scripts-")));
		try {
			const dep = join(scratch, "dep");
			mkdirSync(dep);
			writeFileSync(
				join(dep, "package.json"),
				JSON.stringify({
					name: "dep",
					version: "1.0.0",
					scripts: { postinstall: "node -e \"require('fs').writeFileSync('ran','')\"" },
				}),
			);
			for (const dir of ["", "desktop/", "mobile/"]) {
				for (const allowed of [false, true]) {
					const app = join(scratch, `${dir === "" ? "root" : dir.slice(0, -1)}-${allowed}`);
					mkdirSync(app);
					writeFileSync(join(app, ".npmrc"), readFileSync(new URL(`${dir}.npmrc`, root)));
					writeFileSync(
						join(app, "package.json"),
						JSON.stringify({
							name: "app",
							version: "1.0.0",
							dependencies: { dep: "file:../dep" },
							...(allowed ? { allowScripts: { [`file:${dep}`]: true } } : {}),
						}),
					);
					const run = spawnSync("npm", ["install", "--offline", "--install-links", "--no-audit", "--no-fund"], {
						cwd: app,
						encoding: "utf8",
						env: npmEnv({
							npm_config_userconfig: join(scratch, "npmrc"),
							npm_config_cache: join(scratch, "cache"),
						}),
					});
					const ran = existsSync(join(app, "node_modules", "dep", "ran"));
					if (dir === "") {
						expect(run.status, `root ${run.stderr}`).toBe(0);
						expect(ran, "root").toBe(false);
					} else if (allowed) {
						expect(run.status, `${dir} ${run.stderr}`).toBe(0);
						expect(ran, dir).toBe(true);
					} else {
						expect(run.status, dir).not.toBe(0);
						expect(run.stderr, dir).toContain("ESTRICTALLOWSCRIPTS");
						expect(ran, dir).toBe(false);
					}
				}
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

type Entry = Partial<{
	name: string;
	version: string;
	dev: boolean;
	optional: boolean;
	inBundle: boolean;
	resolved: string;
	integrity: string;
	dependencies: Record<string, string>;
	optionalDependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
}>;

const registry = (name: string, version: string): Entry => ({
	version,
	resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
	integrity: `sha512-${name}${version}`,
});

function lockfile(packages: Record<string, Entry>): LockedPackage[] {
	return parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "probe" }, ...packages } }));
}

describe("the lockfile rules fail where they should", () => {
	test("two copies of the curve library in production are both reported, a dev copy is not", () => {
		const list = lockfile({
			"node_modules/@noble/curves": registry("@noble/curves", "2.4.0"),
			"node_modules/viem": { ...registry("viem", "2.58.4"), dependencies: { "@noble/curves": "1.9.1" } },
			"node_modules/viem/node_modules/@noble/curves": registry("@noble/curves", "1.9.1"),
			"node_modules/ox/node_modules/@noble/curves": { ...registry("@noble/curves", "1.9.0"), dev: true },
		});
		expect(copies(production(list), "@noble/curves")).toEqual(["@noble/curves@1.9.1", "@noble/curves@2.4.0"]);
	});

	test("an x402 package, the v1 SDK, viem, ox, ethers and keytar, under any scope or as a look-alike, are refused in production only", () => {
		const list = lockfile({
			"node_modules/@x402/core": registry("@x402/core", "2.32.0"),
			"node_modules/x402": registry("x402", "1.2.0"),
			"node_modules/x402-fetch": registry("x402-fetch", "1.2.0"),
			"node_modules/ethers-v6": registry("ethers-v6", "6.0.0"),
			"node_modules/@github/keytar": registry("@github/keytar", "7.10.6"),
			"node_modules/viem": registry("viem", "2.58.4"),
			"node_modules/ox": registry("ox", "0.9.6"),
			"node_modules/ethers": registry("ethers", "6.15.0"),
			"node_modules/keytar": registry("keytar", "7.9.0"),
			"node_modules/@x402/evm": { ...registry("@x402/evm", "2.32.0"), dev: true },
			"node_modules/oxford": registry("oxford", "1.0.0"),
			"node_modules/viemish": registry("viemish", "1.0.0"),
			"node_modules/@wrenfield/viem": registry("@wrenfield/viem", "2.58.4"),
			"node_modules/@acme/ox": registry("@acme/ox", "0.9.6"),
			"node_modules/@acme/ethers": registry("@acme/ethers", "6.15.0"),
			"node_modules/@acme/keytar": registry("@acme/keytar", "7.9.0"),
			"node_modules/@ethersproject/abi": registry("@ethersproject/abi", "5.8.0"),
			"node_modules/@acme/viem-tools": registry("@acme/viem-tools", "1.0.0"),
			"node_modules/@viem/anvil": registry("@viem/anvil", "0.0.10"),
		});
		expect(forbidden(production(list))).toEqual([
			"@acme/ethers@6.15.0",
			"@acme/keytar@7.9.0",
			"@acme/ox@0.9.6",
			"@ethersproject/abi@5.8.0",
			"@github/keytar@7.10.6",
			"@wrenfield/viem@2.58.4",
			"@x402/core@2.32.0",
			"ethers-v6@6.0.0",
			"ethers@6.15.0",
			"keytar@7.9.0",
			"ox@0.9.6",
			"viem@2.58.4",
			"x402-fetch@1.2.0",
			"x402@1.2.0",
		]);
	});

	test("a dev package the web app bundles ships, and what it pulls in is refused and named", () => {
		const list = lockfile({
			"node_modules/react": { ...registry("react", "19.0.0"), dev: true },
			"node_modules/wallet-ui": {
				...registry("wallet-ui", "1.0.0"),
				dev: true,
				dependencies: { viem: "2" },
				peerDependencies: { react: "19" },
			},
			"node_modules/viem": { ...registry("viem", "2.58.4"), dev: true, dependencies: { "@noble/curves": "1" } },
			"node_modules/viem/node_modules/@noble/curves": { ...registry("@noble/curves", "1.9.1"), dev: true },
			"node_modules/@noble/curves": registry("@noble/curves", "2.4.0"),
			"node_modules/vitest": { ...registry("vitest", "4.0.0"), dev: true },
		});
		const source = [
			'import { Pay } from "wallet-ui";',
			'import "./styles.css";',
			'import { cn } from "@/lib/cn";',
			'import { readFile } from "node:fs";',
		].join("\n");
		const bundled = closure(list, importedPackages(source));
		expect(forbidden(production(list))).toEqual([]);
		expect(forbidden(bundled)).toEqual(["viem@2.58.4"]);
		expect(names(bundled)).toEqual(["@noble/curves", "react", "viem", "wallet-ui"]);
		expect(strayCopies({ production: production(list), bundled }, "@noble/curves", "2.4.0")).toEqual([
			"bundled: @noble/curves@1.9.1",
		]);
	});

	test("a package only a daemon source loads ships when the web app imports that source, a type-only import does not", () => {
		const dir = mkdtempSync(join(tmpdir(), "banda-bundle-"));
		const files: Record<string, string> = {
			"web/src/main.tsx": 'import { App } from "@/app/App";\nimport "./styles.css";\n',
			"web/src/app/App.tsx": [
				'import { parse } from "../../../src/core/parse.ts";',
				'import type { Shape } from "../../../src/core/types.ts";',
				'import { other } from "../lib";',
				'import { endpoint } from "../../iroh/pkg/endpoint.js";',
				'const s = "from \\"Gmail\\"", t = <p>from "Gmail"</p>;',
				"export const App = () => parse(other);",
			].join("\n"),
			"web/src/lib/index.ts": 'export const other = await import("lazy-chart");\n',
			"web/src/styles.css": '@import "tw-animate-css";\n@plugin "@tailwindcss/typography";\n',
			"web/src/app/App.test.tsx": 'import { test } from "vitest";\n',
			"src/core/parse.ts": 'import { fromMarkdown } from "mdast-util-from-markdown";\nexport { x } from "./more.ts";\n',
			"src/core/more.ts": 'import type { Store } from "pi-durable";\nexport const x = require("micromark");\n',
			"src/core/types.ts": 'import { Type } from "typebox";\nexport type Shape = typeof Type;\n',
		};
		try {
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(dir, path)), { recursive: true });
				writeFileSync(join(dir, path), text);
			}
			const web = join(dir, "web/src");
			const absent = (path: string) => path.includes("/iroh/pkg/");
			expect(bundledPackages(web, { alias: web, absent })).toEqual([
				"@tailwindcss/typography",
				"lazy-chart",
				"mdast-util-from-markdown",
				"micromark",
				"tw-animate-css",
			]);
			expect(() => bundledPackages(web, { alias: web })).toThrow("../../iroh/pkg/endpoint.js, which is no file");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a source's imports are read in every form a bundler follows, and only from code", () => {
		const source = [
			'import a from "a";',
			'import { b } from "@scope/b/sub";',
			'import type { C } from "c";',
			'export { d } from "d";',
			'export * from "e";',
			'import "f/side-effect.css";',
			'const g = await import("g");',
			"const h = await import(`h`);",
			'const i = require("i");',
			'import { k } from "./k";',
			'import { l } from "@/l";',
			'import m from "node:fs";',
			'import n from "virtual:n";',
			'import o from "o?raw";',
			'export type { P } from "p";',
			'const q = ["from", "where"], r = "from \\"Gmail\\"";',
			'const t = <p>import "Gmail" from "Gmail"</p>;',
		].join("\n");
		expect(importedPackages(source, "source.tsx")).toEqual(["@scope/b", "a", "d", "e", "f", "g", "h", "i", "o"]);
		expect(importedPackages('@import "i";\n@plugin "@scope/j";\n@import "./local.css";', "styles.css")).toEqual([
			"@scope/j",
			"i",
		]);
	});

	test.each([
		["a `#` import", "#internal/a"],
		["a name npm would not publish", "Legacy"],
	])("%s fails the reading instead of being left out", (_, specifier) => {
		expect(() => importedPackages(`import x from "${specifier}";`)).toThrow(`${specifier} names no package`);
	});

	test("a shipped package from elsewhere, or without a sha512 hash, is unverified", () => {
		const list = lockfile({
			"node_modules/a": registry("a", "1.0.0"),
			"node_modules/b": { ...registry("b", "1.0.0"), resolved: "https://evil.example/b-1.0.0.tgz" },
			"node_modules/c": { ...registry("c", "1.0.0"), integrity: "sha1-abc" },
			"node_modules/d": { version: "1.0.0" },
			"node_modules/e": { version: "1.0.0", dev: true },
		});
		expect(unverified(production(list))).toEqual(["node_modules/b", "node_modules/c", "node_modules/d"]);
	});

	test("the closure follows node's lookup: a nested copy shadows the root one, optional platforms are followed", () => {
		const list = lockfile({
			"node_modules/signer": {
				...registry("signer", "1.0.0"),
				dependencies: { "@noble/curves": "1.9.1", shared: "1" },
			},
			"node_modules/signer/node_modules/@noble/curves": registry("@noble/curves", "1.9.1"),
			"node_modules/@noble/curves": registry("@noble/curves", "2.4.0"),
			"node_modules/shared": registry("shared", "1.0.0"),
			"node_modules/native": {
				...registry("native", "1.0.0"),
				optionalDependencies: { "native-darwin": "1.0.0", "native-absent": "1.0.0" },
			},
			"node_modules/native-darwin": { ...registry("native-darwin", "1.0.0"), optional: true },
		});
		expect(ids(closure(list, ["signer"]))).toEqual(["@noble/curves@1.9.1", "shared@1.0.0", "signer@1.0.0"]);
		expect(ids(closure(list, ["native"]))).toEqual(["native-darwin@1.0.0", "native@1.0.0"]);
	});

	test("a required dependency missing from the lockfile fails the closure", () => {
		const list = lockfile({ "node_modules/a": { ...registry("a", "1.0.0"), dependencies: { b: "1" } } });
		expect(() => closure(list, ["a"])).toThrow("b, required from node_modules/a, is not in the lockfile");
	});

	test("the production set names a new package, so an addition is a diff", () => {
		const list = lockfile({
			"node_modules/a": registry("a", "1.0.0"),
			"node_modules/a/node_modules/b": registry("b", "1.0.0"),
			"node_modules/b": registry("b", "2.0.0"),
			"node_modules/c": { ...registry("c", "1.0.0"), dev: true },
		});
		expect(names(production(list))).toEqual(["a", "b"]);
	});
});

describe("the registry client asks again only when the fault is passing", () => {
	test("Retry-After is bounded; without one the wait doubles", () => {
		const now = Date.parse("2026-11-24T00:00:00Z");
		expect(retryDelay("86400", 1, now)).toBe(60_000);
		expect([1, 2, 3].map((attempt) => retryDelay(null, attempt, now))).toEqual([1000, 2000, 4000]);
		expect(retryDelay("soon", 2, now)).toBe(2000);
	});

	test("a 429 and a 503 are asked again, a 404 is not", async () => {
		const answers = [429, 503, 200, 404];
		let asked = 0;
		const server = createServer((_request, response) => {
			const status = answers[asked++];
			response.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
			response.end(status === 200 ? '{"ok":true}' : "{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		try {
			expect(await getJson(url)).toEqual({ ok: true });
			expect(asked).toBe(3);
			await expect(getJson(url)).rejects.toThrow(`${url} answered 404`);
			expect(asked).toBe(4);
		} finally {
			server.close();
		}
	});

	test("a fault that does not pass is given up on after five answers", async () => {
		let asked = 0;
		const server = createServer((_request, response) => {
			asked++;
			response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
			response.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		try {
			await expect(getJson(url)).rejects.toThrow(`${url} answered 503`);
			expect(asked).toBe(5);
		} finally {
			server.close();
		}
	});
});
