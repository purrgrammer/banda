/**
 * The single-importer rule (H-306): the signing libraries load only in src/wallet/sign.ts, the keychain module only
 * in src/wallet/keystore.ts, and the x402 SDK, viem and ethers only in tests. Biome's noRestrictedImports holds
 * static, type-only, re-exported, side-effect and dynamic imports by a string literal everywhere but tests, and the
 * two owners carry a suppression of it on each import of theirs; this file runs the repo's own biome.json on a probe of
 * each form, so a Biome upgrade or a lost override shows here, holds those suppressions to the owners, and scans the
 * sources for what the rule cannot see: `require`, `createRequire(...)`, `import.meta.resolve` and an `import()` of a
 * template literal naming a restricted package. The modules that hold a key (the signer, its protocol, the signing
 * module, the keystore, the home's id) are held to more (H-010): no console call, no memo, checkpoint, step or log
 * call, no import of pi-durable, the store, the activity log or the server, and no random source of their own (H-002:
 * a key comes from noble alone, any other draw from src/wallet/draws.ts), each form probed here too.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;
const BIOME = join(ROOT, "node_modules", ".bin", "biome");

const SIGNING = ["@noble/curves", "@noble/hashes", "@scure/base", "micro-eth-signer", "micro-packed"];
const KEYCHAIN = ["@napi-rs/keyring"];
const SDK = [
	"@x402/core",
	"x402",
	"x402-fetch",
	"viem",
	"ox",
	"ethers",
	"ethers-v6",
	"keytar",
	"keytar/sub",
	"@github/keytar",
	"@ethersproject/abi",
	"@wrenfield/viem",
	"@acme/ox",
	"@acme/ethers",
	"@acme/keytar",
	"@acme/keytar/sub",
];

/** Each way a module names another, one per line; the rule must flag each, and `export { m }` only uses the first. */
const FORMS = [
	(name: string, i: number) => `import * as m${i} from "${name}";`,
	(_: string, i: number) => `export { m${i} };`,
	(name: string, i: number) => `export { x as r${i} } from "${name}";`,
	(name: string) => `export * from "${name}";`,
	(name: string, i: number) => `import type { T as t${i} } from "${name}";`,
	(name: string) => `import "${name}";`,
	(name: string, i: number) => `export const d${i} = await import("${name}");`,
];
const NOT_AN_IMPORT = 1;
const NAMES = [...SIGNING, ...KEYCHAIN, ...SDK];
const PROBE = NAMES.map((name, i) => FORMS.map((form) => `${form(name, i)}\n`).join("")).join("");
/** The lines of the probe that import `name`. */
const lines = (name: string) =>
	FORMS.map((_, form) => NAMES.indexOf(name) * FORMS.length + form + 1).filter((_, form) => form !== NOT_AN_IMPORT);

const PLACES = [
	"src/x.ts",
	"src/wallet/sign.ts",
	"src/wallet/keystore.ts",
	"src/wallet/signer.ts",
	"test/x.ts",
	"web/src/x.tsx",
	"web/src/components/ui/x.tsx",
	"web/src/components/ai-elements/x.tsx",
	"web/src/hooks/x.ts",
];
const ALLOWED: Record<string, string[]> = {
	"src/x.ts": [],
	"src/wallet/sign.ts": [],
	"src/wallet/keystore.ts": [],
	"src/wallet/signer.ts": [],
	"test/x.ts": SDK,
	"web/src/x.tsx": [],
	"web/src/components/ui/x.tsx": [],
	"web/src/components/ai-elements/x.tsx": [],
	"web/src/hooks/x.ts": [],
};

let dir: string;
let flagged: Map<string, number[]>;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "banda-imports-"));
	const config = JSON.parse(await readFile(join(ROOT, "biome.json"), "utf8")) as {
		$schema?: string;
		overrides: { plugins?: string[] }[];
	};
	delete config.$schema;
	for (const override of config.overrides) delete override.plugins;
	await writeFile(join(dir, "biome.json"), JSON.stringify(config));
	for (const place of PLACES) {
		await mkdir(dirname(join(dir, place)), { recursive: true });
		await writeFile(join(dir, place), PROBE);
	}
	const { stdout } = await promisify(execFile)(
		BIOME,
		["lint", "--reporter=json", "--max-diagnostics=none", ...PLACES],
		{
			cwd: dir,
			maxBuffer: 16 * 1024 * 1024,
		},
	).catch((error: { stdout: string }) => error);
	const report = JSON.parse(stdout) as {
		diagnostics: { category: string; location: { path: string; start: { line: number } } }[];
	};
	flagged = new Map(PLACES.map((place) => [place, []]));
	for (const d of report.diagnostics) {
		if (d.category === "lint/style/noRestrictedImports") flagged.get(d.location.path)?.push(d.location.start.line);
	}
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("biome.json's single-importer rule (H-306)", () => {
	test.each(PLACES)("%s may import exactly what it is allowed", (place) => {
		const expected = NAMES.filter((name) => !ALLOWED[place].includes(name)).flatMap(lines);
		expect(flagged.get(place)?.sort((a, b) => a - b)).toEqual(expected);
	});

	test("an override restates only groups the whole tree is held to, word for word", async () => {
		type Restricted = { options: { patterns: { group: string[]; message: string }[] } };
		type Rules = { style?: { noRestrictedImports?: Restricted } };
		const config = JSON.parse(await readFile(join(ROOT, "biome.json"), "utf8")) as {
			linter: { rules: Rules };
			overrides: { includes: string[]; linter?: { rules?: Rules } }[];
		};
		const everywhere = config.linter.rules.style?.noRestrictedImports?.options.patterns ?? [];
		expect(everywhere).toHaveLength(3);
		const restated = config.overrides.flatMap(
			(o) => o.linter?.rules?.style?.noRestrictedImports?.options.patterns ?? [],
		);
		expect(restated.length).toBeGreaterThan(0);
		// besides the key-holding modules' own group (H-010), whose override restates every group of the whole tree too
		const keyed = config.overrides.find((o) => o.includes.includes("src/wallet/signer.ts"));
		const own = keyed?.linter?.rules?.style?.noRestrictedImports?.options.patterns ?? [];
		for (const pattern of everywhere) expect(own).toContainEqual(pattern);
		const theirs = own.filter((pattern) => !everywhere.some((each) => each.message === pattern.message));
		expect(theirs).toHaveLength(1);
		for (const pattern of restated) if (!theirs.includes(pattern)) expect(everywhere).toContainEqual(pattern);
	});
});

const RESTRICTED = [
	{ owner: "src/wallet/sign.ts", pattern: /^(@noble\/|@scure\/|micro-eth-signer|micro-packed)/ },
	{ owner: "src/wallet/keystore.ts", pattern: /^@napi-rs\/keyring/ },
	{
		owner: "test/",
		pattern:
			/^(@x402\/|x402(-|\/|$)|(@[^/]+\/)?(viem|ox|ethers)(\/|$)|ethers-|(@[^/]+\/)?keytar(\/|$)|@ethersproject\/)/,
	},
];
const LOAD =
	/\b(?:require|createRequire\([^)]*\)|import\.meta\.resolve|require\.resolve|import)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const SOURCES = ["src", "scripts", "test", "web/src", "desktop/src", "mobile"];
const SELF = relative(ROOT, new URL(import.meta.url).pathname);
const SKIP = new Set(["node_modules", "android", "dist", "fixtures"]);

async function* sources(path: string): AsyncGenerator<string> {
	for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP.has(entry.name)) yield* sources(full);
		} else if (/\.(c|m)?(t|j)sx?$/.test(entry.name)) yield full;
	}
}

describe("no source loads a restricted package around the lint rule", () => {
	test("require, createRequire, import.meta.resolve and import() name restricted packages only in their owners", async () => {
		const found: string[] = [];
		for (const top of SOURCES) {
			for await (const file of sources(join(ROOT, top))) {
				const path = relative(ROOT, file);
				if (path === SELF) continue;
				for (const match of (await readFile(file, "utf8")).matchAll(LOAD)) {
					const rule = RESTRICTED.find((r) => r.pattern.test(match[1]));
					if (rule && !path.startsWith(rule.owner)) found.push(`${path}: ${match[0]}`);
				}
			}
		}
		expect(found).toEqual([]);
	});

	test("only the owners suppress the rule, and only for their own package", async () => {
		// a suppression of the rule, of its group or of all lint, and the line it covers
		const SUPPRESSION = /biome-ignore\S*\s+lint(?:\/style(?:\/noRestrictedImports)?)?(?=[\s:])[^\n]*\n([^\n]*)/g;
		const found: string[] = [];
		for (const top of SOURCES) {
			for await (const file of sources(join(ROOT, top))) {
				const path = relative(ROOT, file);
				if (path === SELF) continue;
				for (const match of (await readFile(file, "utf8")).matchAll(SUPPRESSION)) {
					const rule = RESTRICTED.find((r) => r.owner === path);
					const named = /["'`]([^"'`]+)["'`]/.exec(match[1] ?? "")?.[1] ?? "";
					if (rule === undefined || !rule.pattern.test(named)) found.push(`${path}: ${match[0].trim()}`);
				}
			}
		}
		expect(found).toEqual([]);
	});

	test("the scan sees each way of loading", () => {
		const probe = [
			'require("@noble/curves")',
			'createRequire(import.meta.url)("@napi-rs/keyring")',
			'require.resolve("micro-eth-signer")',
			'import.meta.resolve("viem")',
			"await import(`@noble/hashes`)",
			'await import ( "ethers" )',
		].join("\n");
		expect([...probe.matchAll(LOAD)].map((m) => m[1])).toEqual([
			"@noble/curves",
			"@napi-rs/keyring",
			"micro-eth-signer",
			"viem",
			"@noble/hashes",
			"ethers",
		]);
	});
});

/** The modules that hold a key (H-010), and one beside them that holds none. */
const KEYED = [
	"src/wallet/signer.ts",
	"src/wallet/signer-protocol.ts",
	"src/wallet/sign.ts",
	"src/wallet/keystore.ts",
	"src/wallet/home-id.ts",
];
const UNKEYED = "src/wallet/rpc.ts";
/**
 * Each form the key-holding modules may not have, one per line, then one they may: line 13 imports a whole module, and
 * only its random call on line 16 is flagged; line 19 calls a renamed import, flagged at the import on line 12 (H-002:
 * a random source of their own, by any name).
 */
const KEPT_OUT = [
	'import { memo } from "@earendil-works/pi-durable";',
	'import type { Harness } from "@earendil-works/pi-durable/harness";',
	'import { context } from "../core/store.ts";',
	'import { log as said } from "../core/activity.ts";',
	'import { BadRequest } from "../server/http.ts";',
	"console.log(said, memo, context, BadRequest);",
	'export const a = (ctx: Harness) => ctx.memo("key", () => 1);',
	"export const b = (ctx: Harness) => ctx.checkpoint(1);",
	'export const c = (ctx: Harness) => ctx.step("key", 1);',
	"export const d = (logger: { warn: (x: unknown) => void }) => logger.warn(1);",
	"export const e = (log: (x: unknown) => void) => log(1);",
	'import { randomBytes as bytes } from "node:crypto";',
	'import * as nodeCrypto from "crypto";',
	"export const g = Math.random();",
	"export const h = crypto.getRandomValues(new Uint8Array(32));",
	"export const i = nodeCrypto.randomBytes(32);",
	"export const j = (randomInt: (n: number) => number) => randomInt(8);",
	"export const k = globalThis.crypto.randomUUID();",
	"export const l = bytes(32);",
	"export const f = Math.max(1, 2);",
].join("\n");

describe("the modules that hold a key keep nothing in the store and write no log line (H-010)", () => {
	let keyed: string;
	let lines: Map<string, number[]>;
	beforeAll(async () => {
		keyed = await mkdtemp(join(tmpdir(), "banda-keyed-"));
		const config = JSON.parse(await readFile(join(ROOT, "biome.json"), "utf8")) as { $schema?: string };
		delete config.$schema;
		await writeFile(join(keyed, "biome.json"), JSON.stringify(config));
		await cp(join(ROOT, "biome"), join(keyed, "biome"), { recursive: true });
		for (const place of [...KEYED, UNKEYED]) {
			await mkdir(dirname(join(keyed, place)), { recursive: true });
			await writeFile(join(keyed, place), KEPT_OUT);
		}
		const { stdout } = await promisify(execFile)(
			BIOME,
			["lint", "--reporter=json", "--max-diagnostics=none", ...KEYED, UNKEYED],
			{ cwd: keyed, maxBuffer: 16 * 1024 * 1024 },
		).catch((error: { stdout: string }) => error);
		const report = JSON.parse(stdout) as {
			diagnostics: { category: string; location: { path: string; start: { line: number } } }[];
		};
		lines = new Map([...KEYED, UNKEYED].map((place) => [place, []]));
		for (const d of report.diagnostics)
			if (["lint/style/noRestrictedImports", "lint/suspicious/noConsole", "plugin"].includes(d.category))
				lines.get(d.location.path)?.push(d.location.start.line);
	});
	afterAll(async () => {
		await rm(keyed, { recursive: true, force: true });
	});

	test.each(KEYED)("%s is flagged for each form, and for nothing else", (place) => {
		expect([...new Set(lines.get(place))].sort((a, b) => a - b)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18,
		]);
	});

	test("a module that holds no key is held to none of it", () => {
		expect(lines.get(UNKEYED)).toEqual([]);
	});
});

/** What starts a child process, in any form a module can name it. */
const CHILD =
	/\b(?:from\s*|require\s*\(\s*|import\s*\(\s*)["'`](?:node:)?child_process["'`]|\bprocess\.binding\s*\(\s*["'`]spawn_sync/g;
/** A keychain tool named as a command: macOS's `security`, its keychain verbs, or libsecret's `secret-tool`. */
const KEYCHAIN_TOOL =
	/["'`](?:\/usr\/bin\/)?(?:security|secret-tool)["'`\s]|\b(?:add|find|delete)-generic-password\b|\bsecret-tool\s+(?:store|lookup|clear)\b/g;
/** Where keys are read, written or handed to the desktop app: src/wallet and the desktop's wallet acts. */
const WALLET_SOURCES = ["src/wallet", "desktop/src/wallets.ts"];
/** The one module that starts a child: the signer's, of the daemon's own node (`signerNode`). */
const SPAWNER = "src/wallet/signer-client.ts";

async function* walletSources(): AsyncGenerator<string> {
	for (const top of WALLET_SOURCES) {
		const full = join(ROOT, top);
		if (/\.(c|m)?(t|j)sx?$/.test(top)) yield full;
		else yield* sources(full);
	}
}

describe("keys reach the keychain through banda's own binary, never a keychain tool's child (H-015, H-038)", () => {
	test("no module that holds a key, nor any other wallet module but the signer's client, starts a child process", async () => {
		const found: string[] = [];
		for await (const file of walletSources()) {
			const path = relative(ROOT, file);
			const text = await readFile(file, "utf8");
			if ([...text.matchAll(CHILD)].length > 0 && path !== SPAWNER) found.push(path);
			if (KEYED.includes(path) && /child_process/.test(text)) found.push(`${path}: names child_process`);
		}
		expect(found).toEqual([]);
	});

	test("the signer's client starts one child, of the daemon's own node", async () => {
		const text = await readFile(join(ROOT, SPAWNER), "utf8");
		expect([...text.matchAll(/\bspawn\s*\(/g)]).toHaveLength(1);
		expect(text).toMatch(/const node = signerNode\(this\.#node\);[\s\S]*?\bspawn\(node,/);
		const { signerNode } = await import("../src/wallet/signer-client.ts");
		expect(signerNode(undefined, { node: "26" } as NodeJS.ProcessVersions, "/opt/banda/node")).toBe("/opt/banda/node");
	});

	test("no wallet source names `security` or `secret-tool` as a command", async () => {
		const found: string[] = [];
		for await (const file of walletSources())
			for (const match of (await readFile(file, "utf8")).matchAll(KEYCHAIN_TOOL))
				found.push(`${relative(ROOT, file)}: ${match[0]}`);
		expect(found).toEqual([]);
	});

	test("the scans see each form", () => {
		const children = [
			'import { spawn } from "node:child_process";',
			"import { execFile } from 'child_process';",
			'const cp = require("child_process");',
			"await import(`node:child_process`);",
		].join("\n");
		expect([...children.matchAll(CHILD)]).toHaveLength(4);
		const tools = [
			'execFile("security", ["add-generic-password", "-s", "banda"])',
			"spawn('/usr/bin/security', args)",
			'run("secret-tool store --label banda")',
			'"find-generic-password"',
		].join("\n");
		expect([...tools.matchAll(KEYCHAIN_TOOL)].length).toBeGreaterThanOrEqual(4);
		expect([..."the keychain's security, a secret".matchAll(KEYCHAIN_TOOL)]).toEqual([]);
	});
});

/**
 * Who calls the signer (H-067): the modules that load its client or its host, and, in each, the ops it calls, pinned
 * here, so a new caller, or a module that starts calling an op it did not, fails until it is reviewed. Slice 1 ships the
 * spend ops (`transfer`, `authorization`) in the protocol and the client, and nothing calls them: no source does at all.
 */
const SIGNER_MODULES = ["src/wallet/signer-client.ts", "src/wallet/signer-host.ts"];
/** A module naming the signer's client or host as a string: an import, or the desktop app's `load("signer-host")`. */
const NAMES_SIGNER = /["'`][^"'`\n]*\bsigner-(?:client|host)(?:\.[cm]?[jt]s)?["'`]/;
const IMPORTERS = [
	"desktop/src/wallets.ts",
	"src/server/routes/wallets.ts",
	"src/wallet/lifecycle.ts",
	"src/wallet/signer-host.ts",
];
/** Each op of the signer's protocol, and the importers that call it (by its method's name: `.op(`). */
const CALLERS: Record<string, string[]> = {
	canary: ["src/server/routes/wallets.ts"],
	lease: ["desktop/src/wallets.ts", "src/wallet/lifecycle.ts"],
	leased: ["desktop/src/wallets.ts", "src/server/routes/wallets.ts", "src/wallet/lifecycle.ts"],
	create: ["src/server/routes/wallets.ts", "src/wallet/lifecycle.ts"],
	reveal: ["src/server/routes/wallets.ts"],
	confirm: ["src/server/routes/wallets.ts"],
	derive: ["src/wallet/lifecycle.ts"],
	transfer: [],
	authorization: [],
	remove: ["desktop/src/wallets.ts", "src/server/routes/wallets.ts", "src/wallet/lifecycle.ts"],
	find: ["desktop/src/wallets.ts", "src/server/routes/wallets.ts", "src/wallet/lifecycle.ts"],
	restore: ["desktop/src/wallets.ts"],
	move: ["desktop/src/wallets.ts"],
	export: ["desktop/src/wallets.ts"],
};
const SPEND_OPS = ["transfer", "authorization"];
const called = (op: string) => new RegExp(`\\.${op}\\s*\\(`);

/** Every source that ships (tests left out), with its text. */
async function shipped(): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const top of SOURCES.filter((each) => each !== "test"))
		for await (const file of sources(join(ROOT, top))) {
			const path = relative(ROOT, file);
			if (!/\.test\.[cm]?[jt]sx?$/.test(path)) found.set(path, await readFile(file, "utf8"));
		}
	return found;
}

describe("the signer's callers are the ones reviewed (H-067)", () => {
	test("its protocol's ops are the ones pinned here", async () => {
		const protocol = await readFile(join(ROOT, "src/wallet/signer-protocol.ts"), "utf8");
		const ops = [...protocol.matchAll(/\.\.\.base\("([a-z]+)"\)/g)].map((match) => match[1]);
		expect(ops.sort()).toEqual(Object.keys(CALLERS).sort());
	});

	test("only the pinned modules load its client or its host", async () => {
		const loaders = [...(await shipped())]
			.filter(([path, text]) => NAMES_SIGNER.test(text) && path !== "src/wallet/signer-client.ts")
			.map(([path]) => path);
		expect(loaders.sort()).toEqual(IMPORTERS);
	});

	test("each importer calls only the ops pinned for it", async () => {
		const all = await shipped();
		for (const [op, pinned] of Object.entries(CALLERS)) {
			const callers = IMPORTERS.filter(
				(path) => !SIGNER_MODULES.includes(path) && called(op).test(all.get(path) ?? ""),
			);
			expect(callers, op).toEqual(pinned);
		}
	});

	test("no shipped source calls a spend op", async () => {
		const found = [...(await shipped())]
			.filter(([path]) => !SIGNER_MODULES.includes(path))
			.flatMap(([path, text]) => SPEND_OPS.filter((op) => called(op).test(text)).map((op) => `${path}: .${op}(`));
		expect(found).toEqual([]);
	});

	test("the scans see each form", () => {
		expect(NAMES_SIGNER.test('import { Signer } from "../../wallet/signer-client.ts";')).toBe(true);
		expect(NAMES_SIGNER.test('await load("signer-host")')).toBe(true);
		expect(NAMES_SIGNER.test("the host process (src/wallet/signer-host.ts) starts it")).toBe(false);
		expect(called("transfer").test("signer.transfer (lease, address, fields)")).toBe(true);
		expect(called("transfer").test("a transfer(")).toBe(false);
	});
});
