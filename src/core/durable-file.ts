/**
 * A file written whole and on disk before it is answered: written to a temporary name beside it and flushed, renamed
 * over the file, and its folder flushed, so a power cut leaves either the file before or the file after, never an
 * empty or torn one.
 */
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeDurably(
	path: string,
	data: string | Uint8Array,
	options: {
		/** The file's permissions when it is made. */
		readonly mode?: number;
		/** The temporary name, for a sole writer that writes over one name so a killed one leaves no litter. */
		readonly temporary?: string;
		/** Told once the temporary file is written and flushed, before the rename: an effect boundary, for faults. */
		readonly written?: () => void;
	} = {},
): Promise<void> {
	const temporary = options.temporary ?? `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "w", options.mode ?? 0o666);
		try {
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		options.written?.();
		await rename(temporary, path);
	} finally {
		if (options.temporary === undefined) await rm(temporary, { force: true });
	}
	// Windows does not expose directory fsync through Node; the file itself is flushed before the rename.
	if (process.platform === "win32") return;
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
