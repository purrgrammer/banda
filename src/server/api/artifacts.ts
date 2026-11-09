/**
 * The API's shapes for artifacts and the Library (DESIGN.md "The app"): what the companion made, each with every
 * version it had, oldest first. Re-exported by `../api.ts`.
 */
import type { ArtifactKind, WriteBack } from "../../core/artifacts.ts";

export type { ArtifactKind, WriteBack } from "../../core/artifacts.ts";

export type ArtifactVersionView = {
	readonly n: number;
	/** Its blob: its bytes, by `/api/blobs/<sha>` or `/api/artifacts/<id>/versions/<n>`. */
	readonly sha: string;
	readonly size: number;
	readonly at: number;
	readonly by: "companion" | "owner";
	/** What changed since the version before, in the companion's words. */
	readonly change?: string;
	/** The chat and the call that published it (the companion's). */
	readonly chat?: number;
	readonly call?: string;
	/** An owner's restore: the version whose bytes it holds again. */
	readonly restored?: number;
	/** An owner's version: how the chat it is told in shows it. */
	readonly said?: string;
	/** An owner's version: written into the box, on its way, left out because the box changed the file, or failed. */
	readonly box?: WriteBack;
};

export type ArtifactView = {
	/** Stable for the path it was first published from. */
	readonly id: string;
	readonly title: string;
	/** Where it lives in the box: never shown on a consumer screen. */
	readonly path: string;
	readonly mimeType: string;
	readonly kind: ArtifactKind;
	/** Oldest first, numbered 1..n; the last is the current one. */
	readonly versions: readonly ArtifactVersionView[];
	/** `<chat>:<call>` -> the version that call published: how a chat finds the card of each message that published. */
	readonly published: { readonly [call: string]: number };
	/** The chat that first published it. */
	readonly chat: number;
	/** When it last changed. */
	readonly at: number;
};

/** The Library, pushed on the shell stream whenever it changes: every artifact, newest first. */
export type ArtifactsShellEvent = { readonly type: "artifacts"; readonly artifacts: readonly ArtifactView[] };
