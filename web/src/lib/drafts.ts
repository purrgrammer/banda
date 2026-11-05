/**
 * The composer's draft, per chat and local to this device (DESIGN.md "The composer": its draft survives navigation):
 * what the owner typed and did not send waits in the browser's storage, by the chat's key, until it is sent or emptied.
 * Words only: files attached are not kept. Storage that is unavailable (a private window) keeps nothing, quietly.
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
