/**
 * The band's own file (`../../core/band.ts`): `GET /api/band` reads the pins from `band.json` at the workspace root,
 * checked against its schema; `POST /api/band/pin` pins or unpins one, and `POST /api/band` centres the tiles or not,
 * each writing the file in effect at once. The shell stream carries the pins on
 * every push, so a change to the file by hand or by an agent shows with the next one. The file is read without
 * following a link, and one the daemon does not read is never written over.
 */
import type { Context } from "@earendil-works/chord";
import {
	BAND_FILE,
	type BandFile,
	bandFile,
	DEFAULT_PINS,
	isPin,
	MAX_BAND_BYTES,
	pinned,
	readBandFile,
} from "../../core/band.ts";
import { context } from "../../core/store.ts";
import { readBytes, textOf, type Workspace, write } from "../agents.ts";
import type { BandView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

/** `band.json` as the daemon reads it (Sancho pinned with no file), or why it is not one it reads. */
async function readBand(workspace: Workspace, ctx: Context): Promise<BandFile | { readonly unreadable: string }> {
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

const unavailable: BandView = { pinned: [...DEFAULT_PINS], centred: false, unavailable: true };
const viewOf = (band: BandFile): BandView => ({ pinned: band.pinned, centred: band.centred === true });

/** The band as the app shows it: the file's pins, or Sancho's when the file is one the daemon does not read. */
export async function bandView(workspace: Workspace, ctx: Context = context): Promise<BandView> {
	try {
		const read = await readBand(workspace, ctx);
		return "unreadable" in read ? unavailable : viewOf(read);
	} catch {
		return unavailable;
	}
}

/** Change `band.json` as `change` says, and write it; the band as it is after. */
async function change(
	workspace: Workspace,
	change: (band: BandFile) => BandFile,
	ctx: Context = context,
): Promise<BandView> {
	const read = await readBand(workspace, ctx);
	if ("unreadable" in read) throw new BadRequest(`band.json can't be changed here: ${read.unreadable}`, 409);
	const next = change(read);
	await write(workspace.env(), workspace, `${workspace.root}/${BAND_FILE}`, bandFile(next), ctx);
	return viewOf(next);
}

/** Pin `pin` (to the end of the row) or unpin it; the band as it is after. */
export const pin = (workspace: Workspace, pin: string, on: boolean, ctx: Context = context): Promise<BandView> =>
	change(workspace, (band) => ({ ...band, pinned: pinned(band.pinned, pin, on) }), ctx);

/** Centre the pinned tiles or not; the band as it is after. */
export const centre = (workspace: Workspace, centred: boolean, ctx: Context = context): Promise<BandView> =>
	change(workspace, ({ centred: _was, ...band }) => (centred ? { ...band, centred } : band), ctx);

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
					if (request.method === "GET") return { body: await bandView(deps.workspace) };
					if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
					const { centred } = await request.json();
					if (typeof centred !== "boolean")
						throw new BadRequest("centred says whether the pinned tiles sit in the middle");
					const view = await serial(() => centre(deps.workspace, centred));
					deps.changed();
					return { body: view };
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
