/**
 * Search (DESIGN.md "State"): the one derived store, `<home>/search.db`, SQLite FTS over memory and what was said in
 * the owner's chats. Nothing in it is truth: it is caught up from cursors stored with its rows, in the same
 * transaction, so a crash leaves it either before or after a catch-up, and it can be deleted and rebuilt from scratch.
 * Memory's cursor is each file's hash; the chats' is the newest entry indexed (entry ids grow with the commits
 * that make them). A deletion is real: rows go with their file's next catch-up, and the index is merged and the file
 * vacuumed with secure delete on, so no page keeps the words.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import { allFactsByFile, type Fact, type MemoryFiles, parseFacts } from "./memory.ts";
import { Routes } from "./turn.ts";

/** The schema's version: a database of another is rebuilt. */
const VERSION = 2;

export type Hit =
	| { readonly kind: "fact"; readonly fact: Fact }
	| {
			readonly kind: "message";
			readonly chat: number;
			readonly entry: number;
			readonly who: "owner" | "companion";
			readonly text: string;
			readonly at: number;
	  }
	| {
			readonly kind: "group";
			readonly room: number;
			readonly entry: number;
			/** The owner, or the member who said it. */
			readonly who: string;
			readonly text: string;
			readonly at: number;
	  }
	| { readonly kind: "artifact"; readonly id: string; readonly title: string; readonly text: string };

/** A line of a group's log, as search indexes it. */
export type GroupLine = { readonly entry: number; readonly who: string; readonly text: string; readonly at: number };

/** An artifact as search indexes it: its title and, for text, its newest version's words; `sha` names that version. */
export type ArtifactText = { readonly id: string; readonly title: string; readonly sha: string; readonly text: string };

/** A row as stored: what a test compares between an index caught up bit by bit and one rebuilt. */
export type Row = {
	readonly kind: string;
	readonly key: string;
	readonly path: string;
	readonly text: string;
	readonly meta: string;
};

/** Something that commits, from which chats are read: the Harness, or a tool's api. */
type Committer = { commit<T>(change: (tx: Tx) => T | Promise<T>, ctx: Context): Promise<T> };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A query as FTS5 terms: each word quoted, any of them matching, the last also as a prefix, so a word being typed
 * already finds ("lisb" finds Lisbon); none when it has no words.
 */
export function terms(query: string): string | undefined {
	const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
	if (words.length === 0) return undefined;
	return words.map((word, index) => (index === words.length - 1 ? `"${word}"*` : `"${word}"`)).join(" OR ");
}

export class Search {
	readonly #db: DatabaseSync;
	/** Called inside each catch-up's transaction, before it commits: fault injection crashes there. */
	readonly #hit: (() => void) | undefined;

	constructor(path: string, { hit }: { hit?: () => void } = {}) {
		this.#db = new DatabaseSync(path);
		this.#hit = hit;
		// freed pages are zeroed, and no write-ahead log keeps old pages beside the file
		this.#db.exec("PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;");
		const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version !== VERSION) this.#drop();
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS cursor (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, sha TEXT NOT NULL);
			CREATE VIRTUAL TABLE IF NOT EXISTS rows USING fts5(
				text, kind UNINDEXED, key UNINDEXED, path UNINDEXED, meta UNINDEXED, tokenize = 'porter unicode61'
			);
			PRAGMA user_version = ${VERSION};
		`);
	}

	#drop() {
		this.#db.exec("DROP TABLE IF EXISTS rows; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS cursor;");
	}

	/** Forget everything, as a database made from scratch: the next catch-ups index it all again. */
	rebuild(): void {
		this.#db.exec("BEGIN");
		try {
			this.#db.exec("DELETE FROM rows; DELETE FROM files; DELETE FROM cursor;");
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
		this.#scrub();
	}

	/** Run `write` in one transaction, which passes the fault point before it commits. */
	#transaction(write: () => void) {
		this.#db.exec("BEGIN");
		try {
			write();
			this.#hit?.();
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Merge the index and rewrite the file, so the words of deleted rows are on no page. */
	#scrub() {
		this.#db.exec("INSERT INTO rows(rows) VALUES('optimize'); VACUUM;");
	}

	/**
	 * Catch up with the memory files: each file whose hash differs from the one stored is indexed again, a file gone
	 * takes its rows with it, each in the transaction that stores its hash. Rows that went are scrubbed.
	 */
	async memory(files: MemoryFiles, ctx: Context): Promise<void> {
		const known = new Map(
			(
				this.#db.prepare("SELECT path, sha FROM files WHERE path NOT LIKE 'artifact:%'").all() as {
					path: string;
					sha: string;
				}[]
			).map((row) => [row.path, row.sha]),
		);
		const now = await allFactsByFile(files, ctx);
		let removed = false;
		for (const [path, text] of now) {
			const hash = sha(text);
			if (known.get(path) === hash) continue;
			const facts = parseFacts(path, text);
			const before = (
				this.#db.prepare("SELECT key FROM rows WHERE kind = 'fact' AND path = ?").all(path) as { key: string }[]
			).map((row) => row.key);
			if (before.some((key) => !facts.some((fact) => fact.id === key))) removed = true;
			this.#transaction(() => {
				this.#db.prepare("DELETE FROM rows WHERE kind = 'fact' AND path = ?").run(path);
				const insert = this.#db.prepare("INSERT INTO rows (text, kind, key, path, meta) VALUES (?, 'fact', ?, ?, ?)");
				for (const fact of facts) insert.run(fact.text, fact.id, path, JSON.stringify(fact));
				this.#db.prepare("INSERT OR REPLACE INTO files (path, sha) VALUES (?, ?)").run(path, hash);
			});
		}
		for (const path of known.keys()) {
			if (now.has(path)) continue;
			removed = true;
			this.#transaction(() => {
				this.#db.prepare("DELETE FROM rows WHERE kind = 'fact' AND path = ?").run(path);
				this.#db.prepare("DELETE FROM files WHERE path = ?").run(path);
			});
		}
		if (removed) this.#scrub();
	}

	/**
	 * Catch up with what was said in the owner's chats since the newest entry indexed: the owner's messages and
	 * the companion's (`message_user`), read in one transaction of the store's, so no entry slips between two reads.
	 */
	async messages(store: Committer, ctx: Context): Promise<void> {
		const cursor =
			(this.#db.prepare("SELECT value FROM cursor WHERE name = 'entry'").get() as { value: number } | undefined)
				?.value ?? 0;
		const { rows, newest } = await store.commit(async (tx) => {
			const found: { chat: number; entry: number; key: string; who: string; text: string; at: number }[] = [];
			let newest = cursor;
			for (const id of Object.keys((await tx.doc(Routes)).chats)) {
				const chat = Number(id);
				let page: Awaited<ReturnType<Tx["scanEntries"]>> | undefined;
				do {
					page = await tx.scanEntries(
						{ conversationId: chat as ConversationId, minEntryId: (cursor + 1) as EntryId, order: "ascending" },
						200,
						page?.next,
					);
					for (const entry of page.items) {
						const entryId = Number(entry.id);
						newest = Math.max(newest, entryId);
						const message = entry.model?.[0];
						if (message === undefined) continue;
						const data = entry.data as { origin?: unknown; message?: unknown; said?: unknown } | undefined;
						if (message.role === "user" && data?.origin !== undefined && data.message !== undefined) {
							const text =
								typeof data.said === "string"
									? data.said
									: typeof message.content === "string"
										? message.content
										: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
							if (text.trim() !== "")
								found.push({
									chat,
									entry: entryId,
									key: `c${chat}/e${entryId}`,
									who: "owner",
									text,
									at: message.timestamp,
								});
						} else if (message.role === "assistant")
							for (const block of message.content) {
								if (block.type !== "toolCall" || block.name !== "message_user") continue;
								const text = (block.arguments as { text?: unknown }).text;
								if (typeof text === "string" && text.trim() !== "")
									found.push({
										chat,
										entry: entryId,
										key: `c${chat}/e${entryId}/${block.id}`,
										who: "companion",
										text,
										at: message.timestamp,
									});
							}
					}
				} while (page.next !== undefined);
			}
			return { rows: found, newest };
		}, ctx);
		if (newest === cursor) return;
		this.#transaction(() => {
			const insert = this.#db.prepare("INSERT INTO rows (text, kind, key, path, meta) VALUES (?, 'message', ?, '', ?)");
			for (const row of rows)
				insert.run(row.text, row.key, JSON.stringify({ chat: row.chat, entry: row.entry, who: row.who, at: row.at }));
			this.#db.prepare("INSERT OR REPLACE INTO cursor (name, value) VALUES ('entry', ?)").run(newest);
		});
	}

	/** Catch up with group `room`'s log: the lines after the newest entry indexed, in one transaction with its cursor. */
	groupLines(room: number, lines: readonly GroupLine[]): void {
		const name = `g${room}`;
		const cursor =
			(this.#db.prepare("SELECT value FROM cursor WHERE name = ?").get(name) as { value: number } | undefined)?.value ??
			0;
		const fresh = lines.filter((line) => line.entry > cursor && line.text.trim() !== "");
		const newest = Math.max(cursor, ...lines.map((line) => line.entry));
		if (newest === cursor) return;
		this.#transaction(() => {
			const insert = this.#db.prepare("INSERT INTO rows (text, kind, key, path, meta) VALUES (?, 'group', ?, '', ?)");
			for (const line of fresh)
				insert.run(
					line.text,
					`g${room}/e${line.entry}`,
					JSON.stringify({ room, entry: line.entry, who: line.who, at: line.at }),
				);
			this.#db.prepare("INSERT OR REPLACE INTO cursor (name, value) VALUES (?, ?)").run(name, newest);
		});
	}

	/**
	 * Catch up with the artifacts: one whose newest version changed is indexed again (its title and words), one gone
	 * takes its row with it; rows that went are scrubbed.
	 */
	artifacts(now: readonly ArtifactText[]): void {
		const known = new Map(
			(
				this.#db.prepare("SELECT path, sha FROM files WHERE path LIKE 'artifact:%'").all() as {
					path: string;
					sha: string;
				}[]
			).map((row) => [row.path, row.sha]),
		);
		let removed = false;
		for (const artifact of now) {
			const path = `artifact:${artifact.id}`;
			const hash = sha(`${artifact.sha}\n${artifact.title}`);
			if (known.get(path) === hash) continue;
			if (known.has(path)) removed = true;
			this.#transaction(() => {
				this.#db.prepare("DELETE FROM rows WHERE kind = 'artifact' AND path = ?").run(path);
				this.#db
					.prepare("INSERT INTO rows (text, kind, key, path, meta) VALUES (?, 'artifact', ?, ?, ?)")
					.run(
						`${artifact.title}\n${artifact.text}`,
						artifact.id,
						path,
						JSON.stringify({ id: artifact.id, title: artifact.title }),
					);
				this.#db.prepare("INSERT OR REPLACE INTO files (path, sha) VALUES (?, ?)").run(path, hash);
			});
		}
		const ids = new Set(now.map((artifact) => `artifact:${artifact.id}`));
		for (const path of known.keys()) {
			if (ids.has(path)) continue;
			removed = true;
			this.#transaction(() => {
				this.#db.prepare("DELETE FROM rows WHERE kind = 'artifact' AND path = ?").run(path);
				this.#db.prepare("DELETE FROM files WHERE path = ?").run(path);
			});
		}
		if (removed) this.#scrub();
	}

	/** The best matches for `query` among rows of `kinds`, best first. */
	find(
		query: string,
		limit: number,
		kinds: readonly Hit["kind"][] = ["fact", "message"],
		audience?: { readonly paths: readonly string[]; readonly chats: readonly number[] },
	): Hit[] {
		const match = terms(query);
		if (match === undefined || kinds.length === 0) return [];
		// Restrict before ranking/limiting: another agent's matches must not crowd out the caller's facts.
		const scoped =
			audience === undefined
				? ""
				: ` AND (
			(kind = 'fact' AND path IN (${audience.paths.map(() => "?").join(",")})) OR
			(kind = 'message' AND json_extract(meta, '$.chat') IN (${audience.chats.map(() => "?").join(",")}))
		)`;
		const rows = this.#db
			.prepare(
				`SELECT kind, text, meta FROM rows WHERE rows MATCH ? AND kind IN (${kinds.map(() => "?").join(", ")})${scoped} ORDER BY bm25(rows) LIMIT ?`,
			)
			.all(match, ...kinds, ...(audience === undefined ? [] : [...audience.paths, ...audience.chats]), limit) as {
			kind: string;
			text: string;
			meta: string;
		}[];
		return rows.flatMap((row): Hit[] => {
			const meta = JSON.parse(row.meta) as Record<string, unknown>;
			if (row.kind === "fact") return [{ kind: "fact", fact: meta as unknown as Fact }];
			if (row.kind === "group")
				return [
					{
						kind: "group",
						room: meta.room as number,
						entry: meta.entry as number,
						who: meta.who as string,
						text: row.text,
						at: meta.at as number,
					},
				];
			if (row.kind === "artifact")
				return [{ kind: "artifact", id: meta.id as string, title: meta.title as string, text: row.text }];
			return [
				{
					kind: "message",
					chat: meta.chat as number,
					entry: meta.entry as number,
					who: meta.who as "owner" | "companion",
					text: row.text,
					at: meta.at as number,
				},
			];
		});
	}

	/** Every row, in a fixed order. */
	rows(): Row[] {
		return this.#db.prepare("SELECT kind, key, path, text, meta FROM rows ORDER BY kind, key").all() as Row[];
	}

	close(): void {
		this.#db.close();
	}
}
