/**
 * A part of a message (DESIGN.md "Messages"): what a speaking tool's call carries besides its text and files, each in
 * its own file so the parts grow side by side. A part may refuse a call or prepare what it needs before the message is
 * sent. One that `message_user` and `message_group` carry adds optional parameters to them and says what the model is
 * told of them; the other speaking tools (`react`, `publish`, …) give their own. `index.ts` lists them all.
 */
import type { Context } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { BlobStore } from "../blobs.ts";

/**
 * What a part may use as it prepares: the blobs (their lock already held), how much one file may weigh, and whom the
 * message goes `to`: the owner in the agent's own chat, or the group's room.
 */
export type PartStore = { readonly blobs: BlobStore; readonly limit: number; readonly to: "owner" | "group" };

export type MessagePart = {
	/** The parameters it adds to `message_user` and `message_group`, each optional. */
	readonly parameters?: { readonly [name: string]: TSchema };
	/** What the model is told of them: a sentence added to the tool's description. */
	readonly describe?: string;
	/** Whether the call carries this part, so a message of only it is still a message. */
	readonly present?: (args: JsonObject) => boolean;
	/** Why the call cannot be sent as given, checked before anything is; undefined when it can. */
	readonly refuse?: (args: JsonObject) => string | undefined;
	/** What the message says in words when it has no text of its own, for a gateway that shows only words. */
	readonly said?: (args: JsonObject) => string | undefined;
	/**
	 * Run before the message is queued, under the same lock as its files (`BlobStore.exclusive`), so no sweep comes
	 * between: why it cannot be sent, an optional UI receipt published only on successful delivery, or undefined.
	 * A rerun after a crash runs it again: it must find what it did.
	 */
	readonly prepare?: (
		args: JsonObject,
		api: ToolExecutionApi,
		ctx: Context,
		store: PartStore,
	) => Promise<string | undefined | { readonly receipt: JsonObject }>;
};
