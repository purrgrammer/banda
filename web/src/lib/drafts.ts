/**
 * The composer's draft, per chat and local to this device (DESIGN.md "The composer": its draft survives navigation):
 * what the owner typed or attached and did not send waits in the browser's storage, by the chat's key, until it is sent
 * or emptied. The words in localStorage, read as the composer opens; the files in IndexedDB, where their bytes fit,
 * put back as soon as they are read. Storage that is unavailable (a private window) or full keeps nothing, quietly.
 */

const PREFIX = "banda.draft.";

/** The draft kept for a chat, or undefined. */
export function readDraft(chat: string): string | undefined {
	try {
		return localStorage.getItem(PREFIX + chat) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Keep a chat's draft; an empty one is forgotten. */
export function saveDraft(chat: string, text: string): void {
	try {
		if (text.trim() === "") localStorage.removeItem(PREFIX + chat);
		else localStorage.setItem(PREFIX + chat, text);
	} catch {
		// storage unavailable or full: the draft lives as long as the page
	}
}

const DATABASE = "banda-drafts";
const FILES = "files";

type Kept = { readonly name: string; readonly type: string; readonly bytes: Blob };

let opened: Promise<IDBDatabase | undefined> | undefined;
function database(): Promise<IDBDatabase | undefined> {
	opened ??= new Promise((resolve) => {
		try {
			const request = indexedDB.open(DATABASE, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(FILES);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(undefined);
			request.onblocked = () => resolve(undefined);
		} catch {
			resolve(undefined);
		}
	});
	return opened;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** The files kept for a chat's draft, in the order attached; none when nothing is kept or storage is unavailable. */
export async function readDraftFiles(chat: string): Promise<File[]> {
	try {
		const db = await database();
		if (db === undefined) return [];
		const kept = (await settled(db.transaction(FILES).objectStore(FILES).get(chat))) as Kept[] | undefined;
		return (kept ?? []).map(({ name, type, bytes }) => new File([bytes], name, { type }));
	} catch {
		return [];
	}
}

/** Saves for a chat run one after another, so an earlier, slower one never lands over a later one. */
const queued = new Map<string, Promise<void>>();

/**
 * Keep the files of a chat's draft, as they stand now; none forgets them. `files` is read when this save's turn
 * comes, so a save queued behind another keeps what is attached then; a file that cannot be read (removed meanwhile)
 * leaves what was kept as it was, for the save that follows the removal.
 */
export function saveDraftFiles(chat: string, files: () => Promise<readonly File[]>): Promise<void> {
	const next = (queued.get(chat) ?? Promise.resolve()).then(async () => {
		try {
			const now = await files();
			const db = await database();
			if (db === undefined) return;
			const store = db.transaction(FILES, "readwrite").objectStore(FILES);
			const kept: Kept[] = now.map((file) => ({ name: file.name, type: file.type, bytes: file }));
			if (kept.length === 0) await settled(store.delete(chat));
			else await settled(store.put(kept, chat));
		} catch {
			// storage unavailable or full, or a file gone: what was kept stays until the next save
		}
	});
	queued.set(chat, next);
	void next.then(() => {
		if (queued.get(chat) === next) queued.delete(chat);
	});
	return next;
}
