/**
 * Artifacts as the app shows them (DESIGN.md "The app"): a table's rows from its CSV, a page as the document its
 * sandboxed frame shows, a version in words. Pure, so it is unit-tested beside the server's tests; it imports types
 * alone.
 */
import type { ArtifactVersionView, ArtifactView } from "../../../src/server/api.ts";

/** A CSV's rows (RFC 4180: quoted fields, doubled quotes, CRLF or LF), each a list of cells. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === ",") {
			row.push(cell);
			cell = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

/**
 * A page may run its own inline interactions (buttons, charts and hash routes), but cannot fetch code or data,
 * submit forms, or load any resource beyond embedded fonts and images, and images from an https address. The frame
 * has an opaque origin and cannot navigate the app; its CSP is first so the page cannot relax it.
 */
export const PAGE_POLICY =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

/**
 * The document a page's sandboxed frame shows: its policy first, so it holds before anything of the page's is read,
 * then the page as the box wrote it (its own doctype dropped: one comes first already).
 */
export function pageDocument(html: string): string {
	const page = html.replace(/^﻿?\s*<!doctype[^>]*>/i, "");
	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">${page}`;
}

/** Who made a version, in the app's words: the companion by its name, or "you". */
export const byWords = (version: Pick<ArtifactVersionView, "by">, name: string) =>
	version.by === "owner" ? "you" : name;

/** A version's line under its title: what it did, and when it is not a plain one. */
export function versionNote(version: ArtifactVersionView): string | undefined {
	if (version.restored !== undefined) return `restored v${version.restored}`;
	return version.change;
}

/** What became of the owner's version in the box, when the owner should know; undefined when all is well. */
export function boxNote(version: ArtifactVersionView, name: string): string | undefined {
	if (version.box === "kept") return `${name} had changed its copy since, so it kept that one and read yours.`;
	if (version.box === "failed") return `${name}'s computer could not take it; it read your version.`;
	return undefined;
}

/** The version `n` of `artifact`, or its newest when `n` names none. */
export const versionOf = (artifact: ArtifactView, n?: number) =>
	(n === undefined ? undefined : artifact.versions[n - 1]) ?? artifact.versions.at(-1);
