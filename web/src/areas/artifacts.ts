/**
 * Artifacts and the Library in the app (DESIGN.md "The app"): the Library as the daemon last pushed it, and the owner's
 * calls: an edit, a restore, a removal. A version's bytes are a blob, fetched with the token, and its text as JSON:
 * never as a page.
 */
import { type ArtifactView, api } from "../lib/api.ts";
import type { ShellHandlers } from "../lib/shell.ts";

declare module "../lib/shell.ts" {
	interface Shell {
		/** The Library: every artifact, newest first; undefined until the daemon said. */
		readonly artifacts?: readonly ArtifactView[];
	}
}

export const shell: ShellHandlers = {
	artifacts: (event) => ({ artifacts: event.artifacts }),
};

/** Save the owner's text as the next version, on version `base`; the artifact as it is after. */
export const editArtifact = (id: string, text: string, base: number) =>
	api<ArtifactView>(`/artifacts/${id}/versions`, { method: "POST", body: JSON.stringify({ text, base }) });

/** Make version `n` the current one again, as a new version; the artifact as it is after. */
export const restoreArtifact = (id: string, n: number, base: number) =>
	api<ArtifactView>(`/artifacts/${id}/restore`, { method: "POST", body: JSON.stringify({ n, base }) });

/** Remove an artifact from the Library. */
export const removeArtifact = (id: string) => api<ArtifactView[]>(`/artifacts/${id}`, { method: "DELETE" });

const texts = new Map<string, Promise<string>>();

/**
 * A text version's words, as JSON (the app's own policy lets it fetch nothing else); they never change, so each is
 * fetched once a page.
 */
export function artifactText(id: string, n: number, sha: string): Promise<string> {
	let text = texts.get(sha);
	if (text === undefined) {
		text = api<{ text: string }>(`/artifacts/${id}/versions/${n}/text`).then((body) => body.text);
		text.catch(() => texts.delete(sha));
		texts.set(sha, text);
	}
	return text;
}
