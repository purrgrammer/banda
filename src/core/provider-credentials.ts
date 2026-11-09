/**
 * Owner-only provider credentials: one atomic file beside the daemon token, never in the durable store or box. It also
 * holds the label the owner gave each provider account (`./provider-accounts.ts`), keyed like its credential.
 */
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type Static,
	Type,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { MAX_LABEL } from "./provider-accounts.ts";

const pathOf = (home: string) => join(home, "auth", "providers.json");

/** `auth/providers.json`'s schema: credentials by provider id (an account's included), and accounts' labels. */
export const ProvidersFile = Type.Object(
	{
		credentials: Type.Record(
			Type.String({ minLength: 1 }),
			Type.Object(
				{ type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]) },
				{ additionalProperties: true },
			),
		),
		accounts: Type.Optional(
			Type.Record(
				Type.String({ minLength: 1 }),
				Type.Object({ label: Type.String({ minLength: 1, maxLength: MAX_LABEL }) }, { additionalProperties: false }),
			),
		),
	},
	{ additionalProperties: false, title: "auth/providers.json" },
);
type Saved = { credentials: Record<string, Credential>; accounts?: Record<string, { label: string }> };
export type ProvidersFile = Static<typeof ProvidersFile>;

/**
 * Writes to one file, in turn: a write of one provider's must not lose another's. Keyed by the file, so every store
 * on one home shares it. The daemon owns the home lock, so this also serializes OAuth refreshes.
 */
const chains = new Map<string, Promise<void>>();

export class FileCredentialStore implements CredentialStore {
	readonly home: string;

	constructor(home: string) {
		this.home = home;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await this.load()).credentials[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries((await this.load()).credentials).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.serial(async () => {
			const saved = await this.load();
			const next = await fn(saved.credentials[providerId]);
			if (next === undefined) return saved.credentials[providerId];
			await this.save({ ...saved, credentials: { ...saved.credentials, [providerId]: next } });
			return next;
		});
	}

	/** Forget `providerId`'s credential, and its label with it. */
	delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		return this.serial(async () => {
			const saved = await this.load();
			if (saved.credentials[providerId] === undefined && saved.accounts?.[providerId] === undefined) return;
			const { [providerId]: _, ...credentials } = saved.credentials;
			const { [providerId]: __, ...accounts } = saved.accounts ?? {};
			if (Object.keys(credentials).length === 0 && Object.keys(accounts).length === 0)
				await rm(pathOf(this.home), { force: true });
			else await this.save({ credentials, ...(Object.keys(accounts).length === 0 ? {} : { accounts }) });
		});
	}

	/** The labels the owner gave accounts, by provider id. */
	async labels(): Promise<Readonly<Record<string, string>>> {
		return Object.fromEntries(Object.entries((await this.load()).accounts ?? {}).map(([id, { label }]) => [id, label]));
	}

	/** Name the account `providerId` `label`. */
	label(providerId: string, label: string): Promise<void> {
		return this.serial(async () => {
			const saved = await this.load();
			await this.save({ ...saved, accounts: { ...saved.accounts, [providerId]: { label } } });
		});
	}

	private async serial<T>(run: () => Promise<T>): Promise<T> {
		const key = pathOf(this.home);
		const before = chains.get(key) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => (release = resolve));
		const chain = before.then(() => mine);
		chains.set(key, chain);
		await before;
		try {
			return await run();
		} finally {
			release();
			if (chains.get(key) === chain) chains.delete(key);
		}
	}

	private async load(): Promise<Saved> {
		let text: string;
		try {
			text = await readFile(pathOf(this.home), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { credentials: {} };
			throw error;
		}
		const value: unknown = JSON.parse(text);
		if (!Value.Check(ProvidersFile, value)) {
			const [first] = Value.Errors(ProvidersFile, value);
			throw new Error(
				`auth/providers.json does not fit its schema${first === undefined ? "" : `: ${first.instancePath} ${first.message}`}`,
			);
		}
		return value as Saved;
	}

	private async save(saved: Saved): Promise<void> {
		// a forked home links its file to the home it was forked from: a refresh is written there, so neither holds a
		// refresh token the provider already rotated
		const path = await realpath(pathOf(this.home)).catch(() => pathOf(this.home));
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(saved, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporary, path);
	}
}
