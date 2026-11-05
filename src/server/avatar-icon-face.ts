import type { Harness } from "@earendil-works/pi-durable";
import { Accepted, LEAD, parseAgent } from "../core/agents.ts";
import type { AvatarFace } from "../core/avatar-face.ts";
import { context } from "../core/store.ts";

/** Read only accepted store data: public icons must never enumerate or parse the box's pending files. */
export async function acceptedIconFace(harness: Harness): Promise<AvatarFace | undefined> {
	const files = (await harness.snapshot(Accepted, context))?.files ?? {};
	const entries = Object.entries(files).flatMap(([path, file]) => {
		const id = /^agents\/(.+)\.md$/.exec(path)?.[1];
		return id === undefined ? [] : [{ id, file }];
	});
	entries.sort((a, b) => (a.id === LEAD ? -1 : b.id === LEAD ? 1 : a.id.localeCompare(b.id)));
	for (const { id, file } of entries) {
		const parsed = parseAgent(id, file.text);
		if ("agent" in parsed && parsed.agent.state === "active") return parsed.agent.face;
	}
	return undefined;
}
