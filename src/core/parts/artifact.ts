/**
 * An artifact (DESIGN.md "The app"): a file of the box the companion made for the owner (a document, a table, a plan,
 * a page), published to their Library as its next version. Read from the box (never through a link), stored as a blob
 * and committed as a version before the message is sent, under the blobs' lock; a rerun after a crash finds the version
 * its call published instead of adding one.
 */
import type { JsonObject } from "@earendil-works/pi-durable";
import { publish, publishedBy, quoted, readBoxFile, titleOf, unseen } from "../artifacts.ts";
import type { MessagePart } from "./part.ts";

type Given = { readonly path: string; readonly title?: string; readonly change?: string };

const given = (args: JsonObject): Given | undefined => {
	const value = args.artifact as Given | undefined;
	return typeof value === "object" && value !== null && typeof value.path === "string" ? value : undefined;
};

export const artifact: MessagePart = {
	present: (args) => given(args) !== undefined,
	// a gateway that shows only words hears that it is there
	said: (args) => {
		const file = given(args);
		if (file === undefined) return undefined;
		return `I put “${file.title ?? titleOf(file.path)}” in your Library${file.change === undefined ? "" : `: ${file.change}`}.`;
	},
	prepare: async (args, api, ctx, { blobs, limit }) => {
		const file = given(args);
		if (file === undefined) return undefined;
		const chat = Number(api.conversationId);
		// published by this call before a restart: the same version, never a second one
		if ((await api.commit((tx) => publishedBy(tx, chat, api.callId), ctx)) !== undefined) return undefined;
		const env = api.env;
		if (env === undefined) return "there is no box to read the artifact from";
		const absolute = await env.absolutePath(file.path, ctx);
		if (!absolute.ok) return `${file.path}: ${absolute.error.message}`;
		// its path reaches the owner and the chat as one plain line: a name that hides or steers text is refused
		if (unseen(absolute.value))
			return `${quoted(absolute.value)}: its name holds a control or invisible character; rename it`;
		const read = await readBoxFile(env, absolute.value, limit, ctx);
		if ("refused" in read) return read.refused;
		const sha = await blobs.put(read.bytes);
		await api.commit(
			(tx) =>
				publish(tx, {
					path: absolute.value,
					sha,
					size: read.bytes.byteLength,
					...(file.title === undefined ? {} : { title: file.title }),
					...(file.change === undefined ? {} : { change: file.change }),
					chat,
					call: api.callId,
					at: api.now(),
				}),
			ctx,
		);
		return undefined;
	},
};
