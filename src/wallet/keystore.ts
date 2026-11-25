/**
 * Where a wallet's key is kept: the OS keychain (macOS Keychain, Linux Secret Service), through `@napi-rs/keyring`, the
 * one module that imports it. Only the signer child calls it (C20): a keychain call can block for as long as a person
 * takes to answer a prompt, or forever, ignoring its AbortSignal, and four such calls starve the process's thread pool
 * (docs/wallets/spikes/keychain). Every entry pins Linux to the Secret Service, so a missing one throws instead of the
 * key landing in the kernel keyring, which a reboot empties (H-029). A failure is rethrown as a fixed code, never the
 * native message (H-010).
 *
 * `write` is a plain set and replaces what is there, as the keychain itself does; never overwriting a wallet's item is
 * the signer's rule (it reads first), not this interface's (H-024).
 *
 * Tests never reach the keychain (H-031): `BANDA_TEST_KEYSTORE` gives the signer a fake one, from the sources only; a
 * build that is asked for it throws (H-030). A test home is marked (src/wallet/home-id.ts `TEST_HOME_MARKER`), and its
 * signer gets a test keystore or none, whatever environment the process that started it passed on. Under vitest a
 * `KeychainStore` is made only for a `banda-test-` service, so a test that forgets the fake fails instead of opening
 * the owner's keychain.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { readMarkerSync } from "../core/marker.ts";
import type { WalletPoint } from "./docs.ts";
import { tempSuffix } from "./draws.ts";

export interface Keystore {
	/** The secret under `account`, or null when there is none (or, on Linux with no default collection, no keychain). */
	read(account: string): Promise<string | null>;
	write(account: string, secret: string): Promise<void>;
	/** Whether there was an item to remove. */
	remove(account: string): Promise<boolean>;
	/** The accounts whose name starts with `prefix`. */
	find(prefix: string): Promise<string[]>;
}

/**
 * What a keychain failure means, from its message (every error is `GenericFailure`; only the text tells them apart).
 */
type KeychainCode = "locked" | "no_keychain" | "denied" | "exists" | "ambiguous" | "other";

export class KeystoreError extends Error {
	readonly code: KeychainCode;
	constructor(code: KeychainCode) {
		super(`the keychain refused: ${code}`);
		this.name = "KeystoreError";
		this.code = code;
	}
}

/**
 * Message prefixes of `@napi-rs/keyring` 2.1.2 (keyring-core 1.0.1), each seen in the keychain spike or named by the
 * platform's error table; the version is pinned so these hold, and each has a test.
 */
const PATTERNS: readonly [RegExp, KeychainCode][] = [
	[/unlock prompt was dismissed|IsLocked|interaction is not allowed|keychain is locked/i, "locked"],
	[
		new RegExp(
			[
				"Secret Service: no result found",
				"org\\.freedesktop\\.secrets was not provided",
				"DBUS_SESSION_BUS_ADDRESS",
				"default keychain could not be found",
				"No keychain is available",
				"PermissionDenied",
			].join("|"),
			"i",
		),
		"no_keychain",
	],
	[/User canceled|user name or passphrase you entered is not correct|access denied/i, "denied"],
	[/already exists/i, "exists"],
	[/ambiguous|matched by more than one|is matched by \d+/i, "ambiguous"],
];

export function classify(message: string): KeychainCode {
	for (const [pattern, code] of PATTERNS) if (pattern.test(message)) return code;
	return "other";
}

const fixed = (error: unknown): KeystoreError =>
	error instanceof KeystoreError ? error : new KeystoreError(classify(error instanceof Error ? error.message : ""));

/** The options every entry is built with: Linux's Secret Service or nothing, never the kernel keyring (H-029). */
export const ENTRY_OPTIONS = { linux: { store: "secret-service" } } as const;

type Keyring = Pick<typeof import("@napi-rs/keyring"), "AsyncEntry" | "findCredentialsAsync">;

/**
 * How long one keychain call may wait before its AbortSignal fires. The signer child's SIGKILL is the bound that
 * holds (a call behind a prompt ignores its signal); this only ends a call the library can still abort.
 */
const KEYCHAIN_WAIT = 15_000;

type KeychainOptions = {
	/** The native module, imported on first use so nothing that only names this class loads it. */
	readonly load?: () => Promise<Keyring>;
	/** The platform the listing runs on; this process's by default. */
	readonly platform?: NodeJS.Platform;
};

export class KeychainStore implements Keystore {
	readonly #service: string;
	readonly #load: () => Promise<Keyring>;
	readonly #platform: NodeJS.Platform;
	#keyring: Promise<Keyring> | undefined;

	constructor(service: string, options: KeychainOptions = {}) {
		if (process.env.VITEST !== undefined && !service.startsWith("banda-test-"))
			throw new Error("a test reaches the keychain only under a banda-test- service");
		this.#service = service;
		// biome-ignore lint/style/noRestrictedImports: this module is the one that reaches the keychain
		this.#load = options.load ?? (() => import("@napi-rs/keyring"));
		this.#platform = options.platform ?? process.platform;
	}

	async #entry(account: string) {
		this.#keyring ??= this.#load();
		const { AsyncEntry } = await this.#keyring;
		return new AsyncEntry(this.#service, account, ENTRY_OPTIONS);
	}

	async read(account: string): Promise<string | null> {
		try {
			return await (await this.#entry(account)).getPassword(AbortSignal.timeout(KEYCHAIN_WAIT));
		} catch (error) {
			throw fixed(error);
		}
	}

	async write(account: string, secret: string): Promise<void> {
		try {
			await (await this.#entry(account)).setPassword(secret, AbortSignal.timeout(KEYCHAIN_WAIT));
		} catch (error) {
			throw fixed(error);
		}
	}

	async remove(account: string): Promise<boolean> {
		try {
			return await (await this.#entry(account)).deletePassword(AbortSignal.timeout(KEYCHAIN_WAIT));
		} catch (error) {
			throw fixed(error);
		}
	}

	/**
	 * Refused on Linux: the listing takes no store, so it may come from the kernel keyring and miss the Secret Service's
	 * items, and an orphan sweep must never read "none" from the wrong store.
	 */
	async find(prefix: string): Promise<string[]> {
		if (this.#platform === "linux") throw new KeystoreError("no_keychain");
		try {
			this.#keyring ??= this.#load();
			const { findCredentialsAsync } = await this.#keyring;
			const found = await findCredentialsAsync(this.#service, null, AbortSignal.timeout(KEYCHAIN_WAIT));
			return found.map((credential) => credential.account).filter((account) => account.startsWith(prefix));
		} catch (error) {
			throw fixed(error);
		}
	}
}

/**
 * The file staging a release (scripts/stage.ts, for `npm run cli:pack` and `npm run desktop:pack`) writes at its app
 * root, beside `dist/` and `package.json`: what makes a run the released app's. A checkout's `dist/` has none, so
 * `node dist/cli/index.js serve` is a development run.
 */
export const RELEASE_MARKER = "release.json";
export const ReleaseMarker = Type.Object({ release: Type.String({ minLength: 1 }) }, { additionalProperties: false });

/** Whether the module at `from` is part of a release, as its app root's marker says. */
function isRelease(from: string = import.meta.url): boolean {
	const path = fileURLToPath(new URL(`../../${RELEASE_MARKER}`, from));
	return readMarkerSync(path, ReleaseMarker, "a release's marker") !== undefined;
}

/**
 * Whether the module at `from` runs from a checkout's sources: TypeScript, and no release around it. Both, so neither a
 * build (JavaScript, whatever its URL) nor a release that runs its sources as shipped is ever taken for a test (H-030).
 */
const fromSources = (from: string): boolean => from.endsWith(".ts") && !isRelease(from);

/** Names a keychain test's own `banda-test-` service. */
const TEST_SERVICE_ENV = "BANDA_TEST_KEYCHAIN_SERVICE";

/**
 * The keychain service banda's items live under: the release's, every other run's of its own (`banda-dev`), so a
 * checkout, built or not, never reads the released app's keys (docs/wallets.md "Homes, forks and backups"), or a
 * `banda-test-` service a keychain test names, from the sources only.
 */
export function keychainService(env: NodeJS.ProcessEnv = process.env, from: string = import.meta.url): string {
	const test = env[TEST_SERVICE_ENV];
	if (test !== undefined) {
		if (!fromSources(from)) throw new Error(`${TEST_SERVICE_ENV} is for tests: a build never takes it`);
		if (!/^banda-test-[\w-]+$/.test(test)) throw new Error(`${TEST_SERVICE_ENV} names a banda-test- service only`);
		return test;
	}
	return isRelease(from) ? "banda" : "banda-dev";
}

/** The keychain's effect boundaries, as fault schedules and a fake keystore's faults both name them. */
type KeychainPoint = Extract<WalletPoint, `keychain:${string}`>;

/** The point each keystore call reaches: a listing is a read. */
export const POINTS: Record<keyof Keystore, KeychainPoint> = {
	read: "keychain:read",
	find: "keychain:read",
	write: "keychain:write",
	remove: "keychain:delete",
};

/** A fault a fake keystore injects at a point, for the first calls that match it. */
const Fault = Type.Object(
	{
		point: Type.Union([Type.Literal("keychain:read"), Type.Literal("keychain:write"), Type.Literal("keychain:delete")]),
		/** Applies only to accounts (a listing's prefix) containing this. */
		account: Type.Optional(Type.String()),
		/** Throw an error with this native message, classified as the keychain's would be, before the effect. */
		throw: Type.Optional(Type.String()),
		/** Never answer, as a call behind an unanswered prompt. */
		hang: Type.Optional(Type.Literal(true)),
		/** Answer after this many milliseconds. */
		delay: Type.Optional(Type.Number({ minimum: 0 })),
		/** For a read: answer this instead of what is stored. */
		answer: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		/** SIGKILL this process once the effect is stored, before anyone hears of it: a signer child's alone. */
		kill: Type.Optional(Type.Literal(true)),
		/** How many matching calls it applies to; every one when absent. */
		times: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);
export type KeystoreFault = Static<typeof Fault>;

/** A fake keystore's whole state: its items, its faults, and each call made, in order. */
export const FakeState = Type.Object(
	{
		items: Type.Record(Type.String(), Type.String()),
		faults: Type.Array(Fault),
		calls: Type.Array(
			Type.Object(
				{
					op: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("remove"), Type.Literal("find")]),
					account: Type.String(),
					pid: Type.Integer(),
					start: Type.Number(),
					end: Type.Optional(Type.Number()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type FakeState = Static<typeof FakeState>;

export const emptyState = (): FakeState => ({ items: {}, faults: [], calls: [] });

type FakeOptions = {
	/**
	 * Called at each call's point once its effect is stored, before it answers: a fault worker's schedule kills or
	 * throws there (test/fault/faults.ts).
	 */
	readonly hit?: (point: KeychainPoint) => void;
};

/** Thrown by a call made through a cancelled view: it made no effect. */
const cancelled = () => new KeystoreError("other");

/** A keystore for tests, whose state lives where a subclass keeps it. */
abstract class FakeKeystore implements Keystore {
	/** As `FakeOptions.hit`; a test sets it on the one memory keystore of its process. */
	hit: ((point: KeychainPoint) => void) | undefined;

	constructor(options: FakeOptions = {}) {
		this.hit = options.hit;
	}

	/** Whether a `kill` fault may end this process: never the test runner's own. */
	protected abstract readonly killable: boolean;
	protected abstract load(): Promise<FakeState>;
	protected abstract save(state: FakeState): Promise<void>;

	async #call<T>(
		op: keyof Keystore,
		account: string,
		act: (state: FakeState) => T,
		signal: AbortSignal | undefined,
	): Promise<T> {
		if (signal?.aborted) throw cancelled();
		const point = POINTS[op];
		const state = await this.load();
		const index = state.calls.push({ op, account, pid: process.pid, start: Date.now() }) - 1;
		const fault = state.faults.find(
			(f) => f.point === point && (f.account === undefined || account.includes(f.account)) && f.times !== 0,
		);
		if (fault?.kill && !this.killable) throw new Error("a kill fault is for a signer child's file keystore");
		if (fault?.times !== undefined) fault.times--;
		await this.save(state);
		if (fault?.hang) await aborted(signal);
		if (fault?.delay !== undefined) await new Promise((resolve) => setTimeout(resolve, fault.delay));
		if (signal?.aborted) {
			// it ended, with no effect: a call after it can be told to have waited for it
			const ended = await this.load();
			const call = ended.calls[index];
			if (call !== undefined) call.end = Date.now();
			await this.save(ended);
			throw cancelled();
		}
		if (fault?.throw !== undefined) throw new KeystoreError(classify(fault.throw));
		const now = await this.load();
		const result = op === "read" && fault !== undefined && "answer" in fault ? (fault.answer as T) : act(now);
		const call = now.calls[index];
		if (call !== undefined) call.end = Date.now();
		await this.save(now);
		if (fault?.kill) process.kill(process.pid, "SIGKILL");
		this.hit?.(point);
		return result;
	}

	#read(account: string, signal?: AbortSignal): Promise<string | null> {
		return this.#call("read", account, (state) => state.items[account] ?? null, signal);
	}

	#write(account: string, secret: string, signal?: AbortSignal): Promise<void> {
		return this.#call(
			"write",
			account,
			(state) => {
				state.items[account] = secret;
			},
			signal,
		);
	}

	#remove(account: string, signal?: AbortSignal): Promise<boolean> {
		return this.#call(
			"remove",
			account,
			(state) => {
				const had = account in state.items;
				delete state.items[account];
				return had;
			},
			signal,
		);
	}

	#find(prefix: string, signal?: AbortSignal): Promise<string[]> {
		return this.#call("find", prefix, (state) => Object.keys(state.items).filter((a) => a.startsWith(prefix)), signal);
	}

	read(account: string): Promise<string | null> {
		return this.#read(account);
	}

	write(account: string, secret: string): Promise<void> {
		return this.#write(account, secret);
	}

	remove(account: string): Promise<boolean> {
		return this.#remove(account);
	}

	find(prefix: string): Promise<string[]> {
		return this.#find(prefix);
	}

	/**
	 * This keystore as one call sees it: once `signal` aborts, a call not yet at its effect throws without making it,
	 * and a hung one ends, so an abandoned call makes no effect after its caller gave up.
	 */
	until(signal: AbortSignal): Keystore {
		return {
			read: (account) => this.#read(account, signal),
			write: (account, secret) => this.#write(account, secret, signal),
			remove: (account) => this.#remove(account, signal),
			find: (prefix) => this.#find(prefix, signal),
		};
	}
}

/** Resolves never, or rejects when `signal` aborts. */
function aborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise<never>((_, reject) => {
		if (signal === undefined) return;
		if (signal.aborted) return reject(cancelled());
		signal.addEventListener("abort", () => reject(cancelled()), { once: true });
	});
}

/** A keystore in this process's memory, for tests that run the signer in process. */
export class MemoryKeystore extends FakeKeystore {
	state: FakeState = emptyState();
	protected readonly killable = false;

	protected async load(): Promise<FakeState> {
		return this.state;
	}

	protected async save(state: FakeState): Promise<void> {
		this.state = state;
	}
}

/** A keystore in a JSON file, shared by every signer child a test starts and by the test, which reads and faults it. */
export class FileKeystore extends FakeKeystore {
	readonly path: string;
	protected readonly killable = true;

	constructor(path: string, options: FakeOptions = {}) {
		super(options);
		this.path = path;
	}

	protected async load(): Promise<FakeState> {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(this.path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			throw new KeystoreError("other");
		}
		if (!Value.Check(FakeState, raw)) throw new KeystoreError("other");
		return raw as FakeState;
	}

	protected async save(state: FakeState): Promise<void> {
		const temp = `${this.path}.${process.pid}.${tempSuffix()}.tmp`;
		await writeFile(temp, JSON.stringify(state));
		await rename(temp, this.path);
	}
}

/**
 * Set by tests alone: `1` is a keystore in the process's memory (the signer then runs in process, since a child's
 * memory ends with it), an absolute path a keystore in that JSON file. Read from the sources only: a build asked for it
 * throws, so no release can be pointed at a fake keystore (H-030).
 */
export const TEST_KEYSTORE_ENV = "BANDA_TEST_KEYSTORE";

let memory: MemoryKeystore | undefined;

/** The one in-memory keystore of this process, which tests fault and read. */
export function memoryKeystore(): MemoryKeystore {
	memory ??= new MemoryKeystore();
	return memory;
}

/** Which test keystore this process is given, if any. */
export function testKeystore(
	env: NodeJS.ProcessEnv = process.env,
	from: string = import.meta.url,
): { kind: "memory" } | { kind: "file"; path: string } | undefined {
	const value = env[TEST_KEYSTORE_ENV];
	if (value === undefined || value === "") return undefined;
	if (!fromSources(from)) throw new Error(`${TEST_KEYSTORE_ENV} is for tests: a build never offers a test keystore`);
	if (value === "1") return { kind: "memory" };
	if (isAbsolute(value)) return { kind: "file", path: value };
	throw new Error(`${TEST_KEYSTORE_ENV} is 1 or an absolute path`);
}

/**
 * The keystore this process signs with for `home`: a test's, or the OS keychain under banda's service. A test home is
 * refused the keychain, so a test whose child lost `BANDA_TEST_KEYSTORE` fails instead of opening it (H-031).
 */
export function keystoreFor(
	env: NodeJS.ProcessEnv = process.env,
	from: string = import.meta.url,
	home: { readonly test?: true } = {},
): Keystore {
	const test = testKeystore(env, from);
	if (test?.kind === "memory") return memoryKeystore();
	if (test?.kind === "file") return new FileKeystore(test.path);
	if (home.test) throw new Error("a test home never opens the keychain");
	return new KeychainStore(keychainService(env, from));
}
