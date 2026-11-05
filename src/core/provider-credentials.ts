/** Owner-only provider credentials: one atomic file beside the daemon token, never in the durable store or box. */
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const pathOf = (home: string) => join(home, "auth", "providers.json");
type Saved = { readonly credentials?: Record<string, Credential> };

/** A small file-backed store. The daemon owns the home lock, so its per-provider queue also serializes OAuth refreshes. */
export class FileCredentialStore implements CredentialStore {
	readonly #chains = new Map<string, Promise<void>>();
	readonly home: string;

	constructor(home: string) {
		this.home = home;
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await this.load())[providerId];
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.serial(providerId, async () => {
			const credentials = await this.load();
			const next = await fn(credentials[providerId]);
			if (next === undefined) return credentials[providerId];
			await this.save({ ...credentials, [providerId]: next });
			return next;
		});
	}

	delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		return this.serial(providerId, async () => {
			const credentials = await this.load();
			if (credentials[providerId] === undefined) return;
			const { [providerId]: _, ...rest } = credentials;
			if (Object.keys(rest).length === 0) await rm(pathOf(this.home), { force: true });
			else await this.save(rest);
		});
	}

	private async serial<T>(providerId: string, run: () => Promise<T>): Promise<T> {
		const before = this.#chains.get(providerId) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => (release = resolve));
		const chain = before.then(() => mine);
		this.#chains.set(providerId, chain);
		await before;
		try {
			return await run();
		} finally {
			release();
			if (this.#chains.get(providerId) === chain) this.#chains.delete(providerId);
		}
	}

	private async load(): Promise<Record<string, Credential>> {
		try {
			const saved = JSON.parse(await readFile(pathOf(this.home), "utf8")) as Saved;
			return saved.credentials ?? {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async save(credentials: Record<string, Credential>): Promise<void> {
		// a forked home links its file to the home it was forked from: a refresh is written there, so neither holds a
		// refresh token the provider already rotated
		const path = await realpath(pathOf(this.home)).catch(() => pathOf(this.home));
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ credentials }, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporary, path);
	}
}
