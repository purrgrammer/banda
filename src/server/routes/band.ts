/**
 * The band's own file (`../../core/band.ts`): `GET /api/band` reads the pins from `band.json` at the workspace root,
 * checked against its schema, and `POST /api/band/pin` pins or unpins one, writing the file in effect at once. The shell stream carries the pins on
 * every push, so a change to the file by hand or by an agent shows with the next one. The file is read without
 * following a link, and one the daemon does not read is never written over.
 */
import type { Context } from "@earendil-works/chord";
import { BAND_FILE, bandFile, DEFAULT_PINS, isPin, MAX_BAND_BYTES, pinned, readBandFile } from "../../core/band.ts";
import { context } from "../../core/store.ts";
import { readBytes, textOf, type Workspace, write } from "../agents.ts";
import type { BandView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

/** `band.json` as the daemon reads it: its pins (Sancho with no file), or why it is not one it reads. */
async function readBand(
	workspace: Workspace,
	ctx: Context,
): Promise<{ readonly pinned: readonly string[] } | { readonly unreadable: string }> {
	const env = workspace.env();
	const path = `${workspace.root}/${BAND_FILE}`;
	// opened without following a link: none there is no file, a link (even one to nothing) is not one it reads
	const opened = await env.openBinaryReader(path, { noFollow: true }, ctx);
	if (!opened.ok) {
		if (opened.error.code === "not_found") return readBandFile(undefined);
		if (opened.error.code === "invalid") return { unreadable: "it is a link, not a file" };
		throw opened.error;
	}
	await opened.value.close(ctx);
	const read = await readBytes(env, path, MAX_BAND_BYTES, ctx);
	if (!("bytes" in read)) return read;
	const text = textOf(read.bytes);
	return "text" in text ? readBandFile(text.text) : text;
}

/** The band as the app shows it: the file's pins, or Sancho's when the file is one the daemon does not read. */
export async function bandView(workspace: Workspace, ctx: Context = context): Promise<BandView> {
	try {
		const read = await readBand(workspace, ctx);
		return "unreadable" in read ? { pinned: [...DEFAULT_PINS], unavailable: true } : { pinned: read.pinned };
	} catch {
		return { pinned: [...DEFAULT_PINS], unavailable: true };
	}
}

/** Pin `pin` (to the end of the row) or unpin it, and write `band.json`; the band as it is after. */
export async function pin(workspace: Workspace, pin: string, on: boolean, ctx: Context = context): Promise<BandView> {
	const read = await readBand(workspace, ctx);
	if ("unreadable" in read) throw new BadRequest(`band.json can't be changed here: ${read.unreadable}`, 409);
	const next = pinned(read.pinned, pin, on);
	await write(workspace.env(), workspace, `${workspace.root}/${BAND_FILE}`, bandFile(next), ctx);
	return { pinned: next };
}

export const band: AreaModule = {
	start: (deps) => {
		// one change to the file at a time: two quick pins never write over each other
		let last: Promise<unknown> = Promise.resolve();
		const serial = <T>(run: () => Promise<T>): Promise<T> => {
			const next = last.then(run, run);
			last = next.catch(() => {});
			return next;
		};
		return {
			shell: async () => [{ type: "band", band: await bandView(deps.workspace) }],
			route: async (request) => {
				if (request.path === "/band") {
					if (request.method !== "GET") return { status: 405, body: { error: "method not allowed" } };
					return { body: await bandView(deps.workspace) };
				}
				if (request.path !== "/band/pin") return undefined;
				if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
				const body = await request.json();
				const { pin: which, on } = body;
				if (typeof which !== "string" || !isPin(which)) throw new BadRequest("pin is an agent's id or group:<room>");
				if (typeof on !== "boolean") throw new BadRequest("on says whether to pin or unpin");
				const view = await serial(() => pin(deps.workspace, which, on));
				deps.changed();
				return { body: view };
			},
		};
	},
};
