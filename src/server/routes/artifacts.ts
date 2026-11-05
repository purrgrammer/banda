/**
 * Artifacts (DESIGN.md "The app"): what the companion made, with every version, the owner's edits and restores, and the
 * Library. Pushed whole on the shell stream whenever it changes. A version's bytes are served as `/api/blobs` serves
 * them: an image shown, anything else downloaded, never rendered on the daemon's origin.
 */
import { posix } from "node:path";
import type { Harness } from "@earendil-works/pi-durable";
import {
	ARTIFACT_ID,
	type Artifact,
	Artifacts,
	defineArtifacts,
	Refused,
	removeArtifact,
} from "../../core/artifacts.ts";
import type { BlobStore } from "../../core/blobs.ts";
import { context } from "../../core/store.ts";
import { maxFileBytes } from "../../home.ts";
import type { ArtifactView } from "../api.ts";
import { BadRequest } from "../http.ts";
import type { AreaModule } from "./area.ts";

/** The Library: every artifact, newest first. */
export async function artifactViews(harness: Harness): Promise<ArtifactView[]> {
	const artifacts = (await harness.snapshot(Artifacts, context))?.artifacts ?? {};
	return Object.entries(artifacts)
		.map(([id, artifact]) => viewOf(id, artifact))
		.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

const viewOf = (id: string, artifact: Artifact): ArtifactView => ({
	id,
	title: artifact.title,
	path: artifact.path,
	mimeType: artifact.mimeType,
	kind: artifact.kind,
	versions: artifact.versions,
	published: artifact.published,
	chat: artifact.chat,
	at: artifact.at,
});

/** The kinds the app shows from their text. */
const TEXT_KINDS = new Set(["markdown", "text", "table", "page"]);

const whole = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A refusal from the core as the API answers it. */
async function refusing<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof Refused) throw new BadRequest(error.message, error.status);
		throw error;
	}
}

/** Each daemon's artifacts, by its blobs (the one thing its boot and its start share): the store reaches them at start. */
const daemons = new WeakMap<
	BlobStore,
	{ readonly library: ReturnType<typeof defineArtifacts>; harness: Harness | undefined }
>();

export const artifacts: AreaModule = {
	install: (boot) => {
		const daemon: { library: ReturnType<typeof defineArtifacts>; harness: Harness | undefined } = {
			library: defineArtifacts({ blobs: boot.blobs, harness: () => daemon.harness }),
			harness: undefined,
		};
		daemons.set(boot.blobs, daemon);
		return [daemon.library.extension];
	},
	start: (deps) => {
		const { harness, blobs } = deps;
		const daemon = daemons.get(blobs) ?? {
			library: defineArtifacts({ blobs, harness: () => harness }),
			harness,
		};
		daemon.harness = harness;
		const { library } = daemon;
		const limit = maxFileBytes(deps.config);
		const one = async (id: string) => {
			const view = (await artifactViews(harness)).find((artifact) => artifact.id === id);
			if (view === undefined) throw new BadRequest("no such artifact", 404);
			return view;
		};
		return {
			watch: [Artifacts],
			shell: async () => [{ type: "artifacts", artifacts: await artifactViews(harness) }],
			route: async ({ method, path, json }) => {
				if (path === "/artifacts" && method === "GET") return { body: await artifactViews(harness) };
				const match = /^\/artifacts\/([^/]+)(\/.*)?$/.exec(path);
				if (match === null) return undefined;
				const id = match[1] ?? "";
				const rest = match[2] ?? "";
				if (!ARTIFACT_ID.test(id)) throw new BadRequest("no such artifact", 404);
				if (rest === "" && method === "GET") return { body: await one(id) };
				if (rest === "" && method === "DELETE") {
					if (!(await removeArtifact(harness, id))) throw new BadRequest("no such artifact", 404);
					deps.changed();
					return { body: await artifactViews(harness) };
				}
				const version = /^\/versions\/(\d{1,6})$/.exec(rest);
				if (version !== null && method === "GET") {
					const artifact = await one(id);
					const found = artifact.versions[Number(version[1]) - 1];
					if (found === undefined) throw new BadRequest(`there is no v${version[1]}`, 404);
					return {
						file: {
							name: posix.basename(artifact.path),
							mimeType: artifact.mimeType,
							bytes: await blobs.read(found.sha),
						},
					};
				}
				const words = /^\/versions\/(\d{1,6})\/text$/.exec(rest);
				if (words !== null && method === "GET") {
					const artifact = await one(id);
					const found = artifact.versions[Number(words[1]) - 1];
					if (found === undefined) throw new BadRequest(`there is no v${words[1]}`, 404);
					if (!TEXT_KINDS.has(artifact.kind)) throw new BadRequest("it is not text");
					// as JSON, so the bytes are words for the app to show, never a document of their own
					return { body: { text: (await blobs.read(found.sha)).toString("utf8") } };
				}
				if (rest === "/versions" && method === "POST") {
					const { text, base } = await json();
					if (typeof text !== "string") throw new BadRequest("text is the owner's version, whole");
					if (Buffer.byteLength(text) > limit) throw new BadRequest("the text is larger than a file may be", 413);
					if (!whole(base)) throw new BadRequest("base is the version the edit was made on");
					await refusing(() => library.edit(harness, id, text, base));
					return { body: await one(id) };
				}
				if (rest === "/restore" && method === "POST") {
					const { n, base } = await json();
					if (!whole(n)) throw new BadRequest("n is the version to restore");
					if (base !== undefined && !whole(base)) throw new BadRequest("base is the newest version on screen");
					await refusing(() => library.restore(harness, id, n, base));
					return { body: await one(id) };
				}
				return undefined;
			},
		};
	},
};
