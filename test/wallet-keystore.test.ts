/**
 * The keystore (src/wallet/keystore.ts): every keychain message the spike saw classified into its fixed code, every
 * entry pinned to Linux's Secret Service, the native message never passed on, and the test keystores refused to a
 * build. The real keychain is never reached: the native module is a fake that records what it was asked.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	classify,
	ENTRY_OPTIONS,
	FileKeystore,
	KeychainStore,
	KeystoreError,
	keychainService,
	keystoreFor,
	MemoryKeystore,
	RELEASE_MARKER,
	testKeystore,
} from "../src/wallet/keystore.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("classify", () => {
	it.each([
		["Couldn't access platform storage: Secret Service: unlock prompt was dismissed", "locked"],
		["Couldn't access platform storage: IsLocked", "locked"],
		["Platform failure: User interaction is not allowed.", "locked"],
		["Couldn't access platform storage: Secret Service: no result found", "no_keychain"],
		[
			"Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files",
			"no_keychain",
		],
		[
			"Platform failure: DBus error: Using X11 for dbus-daemon autolaunch was disabled at compile time, set your DBUS_SESSION_BUS_ADDRESS instead",
			"no_keychain",
		],
		["Couldn't access platform storage: PermissionDenied", "no_keychain"],
		["Platform failure: A default keychain could not be found.", "no_keychain"],
		["Platform failure: User canceled the operation.", "denied"],
		["Platform failure: The specified item already exists in the keychain.", "exists"],
		["Entry is matched by 2 credentials: ambiguous", "ambiguous"],
		["Password data is not valid UTF-8", "other"],
		["", "other"],
	])("%s → %s", (message, code) => {
		expect(classify(message)).toBe(code);
	});
});

type Made = { service: string; account: string; options: unknown };

/** A stand-in for `@napi-rs/keyring` that records every entry and throws `fail` from every call when set. */
function fakeKeyring(fail?: string) {
	const made: Made[] = [];
	const items = new Map<string, string>();
	const check = () => {
		if (fail !== undefined) throw new Error(fail);
	};
	class AsyncEntry {
		readonly key: string;
		constructor(service: string, account: string, options?: unknown) {
			made.push({ service, account, options });
			this.key = `${service}\0${account}`;
		}
		async getPassword() {
			check();
			return items.get(this.key) ?? null;
		}
		async setPassword(password: string) {
			check();
			items.set(this.key, password);
		}
		async deletePassword() {
			check();
			return items.delete(this.key);
		}
	}
	const findCredentialsAsync = async (service: string) => {
		check();
		return [...items]
			.filter(([key]) => key.startsWith(`${service}\0`))
			.map(([key, password]) => ({ account: key.split("\0")[1] ?? "", password }));
	};
	const load = async () => ({ AsyncEntry, findCredentialsAsync }) as never;
	return { made, load };
}

describe("KeychainStore", () => {
	it("pins every entry to Linux's Secret Service, never the kernel keyring (H-029)", async () => {
		const { made, load } = fakeKeyring();
		const store = new KeychainStore("banda-test-x", { load, platform: "darwin" });
		await store.write("h/wallet/a", "one");
		expect(await store.read("h/wallet/a")).toBe("one");
		expect(await store.find("h/wallet/")).toEqual(["h/wallet/a"]);
		expect(await store.remove("h/wallet/a")).toBe(true);
		expect(await store.remove("h/wallet/a")).toBe(false);
		expect(await store.read("h/wallet/a")).toBeNull();
		expect(made.length).toBe(5);
		for (const entry of made) {
			expect(entry.options).toEqual({ linux: { store: "secret-service" } });
			expect(entry.service).toBe("banda-test-x");
		}
		expect(ENTRY_OPTIONS.linux.store).toBe("secret-service");
	});

	it("lists only the accounts under the prefix", async () => {
		const { load } = fakeKeyring();
		const store = new KeychainStore("banda-test-x", { load, platform: "darwin" });
		await store.write("h/wallet/a", "1");
		await store.write("h/lease", "2");
		await store.write("g/wallet/b", "3");
		expect(await store.find("h/wallet/")).toEqual(["h/wallet/a"]);
	});

	it("rethrows a failure as its fixed code, never the native message (H-010)", async () => {
		const native = "Couldn't access platform storage: Secret Service: unlock prompt was dismissed 0xdeadbeef";
		const { load } = fakeKeyring(native);
		const store = new KeychainStore("banda-test-x", { load, platform: "darwin" });
		for (const call of [
			() => store.read("a"),
			() => store.write("a", "s"),
			() => store.remove("a"),
			() => store.find(""),
		]) {
			const error = await call().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(KeystoreError);
			expect((error as KeystoreError).code).toBe("locked");
			expect((error as Error).message).not.toContain("deadbeef");
			expect((error as Error).message).not.toContain("Secret Service");
		}
	});

	it("gives every call an AbortSignal, and refuses the listing on Linux, which may read the wrong store", async () => {
		const signals: unknown[] = [];
		class AsyncEntry {
			async getPassword(signal?: AbortSignal) {
				signals.push(signal);
				return null;
			}
			async setPassword(_: string, signal?: AbortSignal) {
				signals.push(signal);
			}
			async deletePassword(signal?: AbortSignal) {
				signals.push(signal);
				return false;
			}
		}
		const findCredentialsAsync = async (_: string, __: unknown, signal?: AbortSignal) => {
			signals.push(signal);
			return [];
		};
		const load = async () => ({ AsyncEntry, findCredentialsAsync }) as never;
		const store = new KeychainStore("banda-test-x", { load, platform: "darwin" });
		await store.read("a");
		await store.write("a", "s");
		await store.remove("a");
		await store.find("");
		expect(signals).toHaveLength(4);
		for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
		const linux = new KeychainStore("banda-test-x", { load, platform: "linux" });
		await expect(linux.find("")).rejects.toMatchObject({ code: "no_keychain" });
		expect(signals).toHaveLength(4);
	});

	it("is made under vitest only for a banda-test- service (H-031)", () => {
		expect(() => new KeychainStore("banda-dev")).toThrow("banda-test-");
		expect(() => new KeychainStore("banda")).toThrow("banda-test-");
		expect(() => keystoreFor({})).toThrow("banda-test-");
	});

	it("loads the native module only when first used", async () => {
		let loads = 0;
		const { load } = fakeKeyring();
		const store = new KeychainStore("banda-test-x", {
			load: () => {
				loads++;
				return load();
			},
		});
		expect(loads).toBe(0);
		await store.read("a");
		await store.read("b");
		expect(loads).toBe(1);
	});
});

describe("the memory keystore", () => {
	it("refuses a kill fault before its effect, which would end the test runner", async () => {
		const store = new MemoryKeystore();
		store.state.faults.push({ point: "keychain:write", kill: true });
		await expect(store.write("a", "s")).rejects.toThrow("a kill fault is for a signer child's file keystore");
		expect(store.state.items).toEqual({});
	});
});

describe("which keystore a process gets", () => {
	it("is the keychain unless a test asks, under banda in a release and banda-dev in every other run", async () => {
		expect(testKeystore({})).toBeUndefined();
		expect(keychainService({})).toBe("banda-dev");
		const app = await mkdtemp(join(tmpdir(), "banda-app-"));
		dirs.push(app);
		const built = pathToFileURL(join(app, "dist", "wallet", "keystore.js")).href;
		await mkdir(join(app, "dist", "wallet"), { recursive: true });
		expect(keychainService({}, built)).toBe("banda-dev");
		const checkout = pathToFileURL(join(process.cwd(), "dist", "wallet", "keystore.js")).href;
		expect(keychainService({}, checkout)).toBe("banda-dev");
		await writeFile(join(app, RELEASE_MARKER), JSON.stringify({ release: "0.1.0" }));
		expect(keychainService({}, built)).toBe("banda");
		await writeFile(join(app, RELEASE_MARKER), "{}");
		expect(() => keychainService({}, built)).toThrow("not a release's marker");
	});

	it("refuses a test home the keychain, whatever environment it was given (H-031)", () => {
		expect(() => keystoreFor({}, undefined, { test: true })).toThrow("a test home never opens the keychain");
		expect(keystoreFor({ BANDA_TEST_KEYSTORE: "/tmp/k.json" }, undefined, { test: true })).toBeInstanceOf(FileKeystore);
	});

	it("gives a test the memory or a file keystore from the sources only (H-030)", () => {
		expect(testKeystore({ BANDA_TEST_KEYSTORE: "1" })).toEqual({ kind: "memory" });
		expect(keystoreFor({ BANDA_TEST_KEYSTORE: "1" })).toBeInstanceOf(MemoryKeystore);
		expect(keystoreFor({ BANDA_TEST_KEYSTORE: "/tmp/k.json" })).toBeInstanceOf(FileKeystore);
		expect(() => testKeystore({ BANDA_TEST_KEYSTORE: "k.json" })).toThrow("1 or an absolute path");
		for (const build of [
			"file:///Applications/banda.app/Contents/Resources/banda/app/dist/wallet/keystore.js",
			"file:///repo/release/banda/app/dist/wallet/keystore.js",
		]) {
			expect(() => testKeystore({ BANDA_TEST_KEYSTORE: "1" }, build)).toThrow("a build never offers a test keystore");
			expect(() => keystoreFor({ BANDA_TEST_KEYSTORE: "/tmp/k.json" }, build)).toThrow("a build never");
		}
	});

	it("takes a keychain test's service only if it is a banda-test- one, and never in a build", () => {
		expect(keychainService({ BANDA_TEST_KEYCHAIN_SERVICE: "banda-test-1-ab" })).toBe("banda-test-1-ab");
		expect(() => keychainService({ BANDA_TEST_KEYCHAIN_SERVICE: "banda" })).toThrow("banda-test-");
		expect(() =>
			keychainService({ BANDA_TEST_KEYCHAIN_SERVICE: "banda-test-1" }, "file:///app/dist/wallet/keystore.js"),
		).toThrow("a build never");
	});
});

describe("the test keystores", () => {
	it("keep items in memory or a file, and inject faults", async () => {
		const dir = await mkdtemp(join(tmpdir(), "banda-keystore-"));
		dirs.push(dir);
		for (const store of [new MemoryKeystore(), new FileKeystore(join(dir, "keys.json"))]) {
			await store.write("h/wallet/a", "one");
			expect(await store.read("h/wallet/a")).toBe("one");
			expect(await store.find("h/")).toEqual(["h/wallet/a"]);
			expect(await store.remove("h/wallet/a")).toBe(true);
			expect(await store.read("h/wallet/a")).toBeNull();
		}
		const memory = new MemoryKeystore();
		memory.state.faults.push(
			{ point: "keychain:read", throw: "Couldn't access platform storage: Secret Service: no result found", times: 1 },
			{ point: "keychain:read", account: "other", answer: "not it" },
		);
		await expect(memory.read("a")).rejects.toMatchObject({ code: "no_keychain" });
		expect(await memory.read("a")).toBeNull();
		expect(await memory.read("h/other")).toBe("not it");
		const file = new FileKeystore(join(dir, "keys.json"));
		await file.write("x", "1");
		const state = JSON.parse(await readFile(file.path, "utf8"));
		expect(state.items).toEqual({ x: "1" });
		expect(state.calls.at(-1)).toMatchObject({ op: "write", account: "x", pid: process.pid });
	});

	it("make no effect through a view whose signal aborted, and end a hung call there", async () => {
		const memory = new MemoryKeystore();
		const cancel = new AbortController();
		const view = memory.until(cancel.signal);
		memory.state.faults.push({ point: "keychain:write", delay: 100, times: 1 });
		memory.state.faults.push({ point: "keychain:read", hang: true, times: 1 });
		const calls = Promise.allSettled([view.write("a", "1"), view.read("a")]);
		cancel.abort();
		for (const call of await calls) expect(call).toMatchObject({ status: "rejected", reason: { code: "other" } });
		await expect(view.remove("a")).rejects.toMatchObject({ code: "other" });
		expect(memory.state.items).toEqual({});
	});
});

describe("a release's keystore", () => {
	/**
	 * What `module` (a file URL) gives a test home for each test keystore, in a process of its own: `opened`, or why
	 * it refused. The home is a test one, so even a gate that failed would never reach the keychain.
	 */
	const offered = (module: string) =>
		JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`const k = await import(${JSON.stringify(module)});
					const out = [];
					for (const value of ["1", "/tmp/banda-keystore.json"]) {
						try {
							k.keystoreFor({ ...process.env, BANDA_TEST_KEYSTORE: value }, undefined, { test: true });
							out.push("opened");
						} catch (error) {
							out.push(error.message);
						}
					}
					console.log(JSON.stringify(out));`,
				],
				{ encoding: "utf8", env: { ...process.env, BANDA_TEST_KEYSTORE: "1" } },
			),
		) as string[];
	const refused = ["BANDA_TEST_KEYSTORE is for tests: a build never offers a test keystore"];

	it("is no test keystore, built as `npm run build` builds it or run from its sources, whatever the environment (H-030)", async () => {
		const root = await mkdtemp(join(tmpdir(), "banda-release-"));
		dirs.push(root);
		const app = join(root, "app");
		await mkdir(app);
		// the module's closure, compiled by the build's own tsconfig into the app's dist/, beside the dependencies
		await writeFile(
			join(root, "tsconfig.json"),
			JSON.stringify({
				extends: resolve("tsconfig.json"),
				compilerOptions: {
					outDir: join(app, "dist"),
					rootDir: resolve("src"),
					sourceMap: false,
					typeRoots: [resolve("node_modules/@types")],
				},
				files: [resolve("src/wallet/keystore.ts")],
				include: [],
			}),
		);
		execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], {
			stdio: "pipe",
		});
		await symlink(resolve("node_modules"), join(app, "node_modules"), "dir");
		const built = pathToFileURL(join(app, "dist", "wallet", "keystore.js")).href;
		// a checkout's build is refused it, and so is a release's
		expect(offered(built)).toEqual([...refused, ...refused]);
		await writeFile(join(app, RELEASE_MARKER), JSON.stringify({ release: "9.9.9-test" }));
		expect(offered(built)).toEqual([...refused, ...refused]);
		// a release that ran its TypeScript as shipped: its marker refuses it the test keystore all the same
		await cp(resolve("src"), join(app, "src"), { recursive: true });
		expect(offered(pathToFileURL(join(app, "src", "wallet", "keystore.ts")).href)).toEqual([...refused, ...refused]);
		// and the same sources in a checkout, with no marker, are a test's
		await rm(join(app, RELEASE_MARKER));
		expect(offered(pathToFileURL(join(app, "src", "wallet", "keystore.ts")).href)).toEqual(["opened", "opened"]);
	}, 60_000);
});
