/**
 * A marker file: a small JSON file whose being there says something about the folder it is in (a restored home, a
 * fork, a test home, a release). Absent is undefined; one that is there but not of its schema is refused, never read
 * as absent, so a damaged marker cannot pass for none.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

function parsed<S extends TSchema>(raw: string, schema: S, path: string, what: string): Static<S> {
	let marker: unknown;
	try {
		marker = JSON.parse(raw);
	} catch {
		marker = undefined;
	}
	if (!Value.Check(schema, marker)) throw new Error(`${path.split(/[\\/]/).pop()} is not ${what}`);
	return marker as Static<S>;
}

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** The marker at `path`, checked against `schema`, or undefined where there is none; `what` names it in a refusal. */
export async function readMarker<S extends TSchema>(
	path: string,
	schema: S,
	what: string,
): Promise<Static<S> | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (absent(error)) return undefined;
		throw error;
	}
	return parsed(raw, schema, path, what);
}

/** `readMarker`, for a caller that cannot wait. */
export function readMarkerSync<S extends TSchema>(path: string, schema: S, what: string): Static<S> | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (absent(error)) return undefined;
		throw error;
	}
	return parsed(raw, schema, path, what);
}
