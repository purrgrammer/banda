/**
 * Foreign content (DESIGN.md "Trust" law 4): whether a chat's task has read what someone other than the owner and banda
 * could have written, which narrows what its approvals offer (`permissions.ts`). A tool whose result brings it in marks
 * the chat in a commit before that result is recorded: every read from outside the activity log records (a
 * connection's, a page's, a command's through the proxy), the browser's pages, another agent's chat. An input that
 * carries it (another agent's message, a harness's work, a group's messages another member wrote) marks the task it
 * lands in by being there. The mark is for the task: the owner's next message (in a group, one that asks the member),
 * or a routine's wake, starts one with none.
 */
import { type ConversationId, defineDoc, type EntryId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";

/** A message one agent sent to another agent's direct chat. */
export const AGENT_MESSAGE = "banda.agent-message";
/** The entry a session's end leaves in its agent's chat. */
export const HARNESS_ENDED = "banda.harness-ended";

/** A member's turn's input in a group's execution chat: the room's messages since it last worked there. */
export const GROUP_INPUT = "banda.group-input";
export type GroupInput = {
	readonly room: number;
	/** The room's entry it reads through. */
	readonly through: number;
	/** A message of the owner's in it asks this member: it starts the member's task. */
	readonly asked?: true;
	/** Another member wrote a message in it. */
	readonly foreign?: true;
};

/** The inputs whose content is foreign: wherever one lands, its task read foreign content. */
const FOREIGN_INPUTS: ReadonlySet<string> = new Set([AGENT_MESSAGE, HARNESS_ENDED]);

/** Whether `entry` is an input whose content is foreign. */
const carriesForeign = (entry: EntryRecord) =>
	FOREIGN_INPUTS.has(entry.kind) ||
	(entry.kind === GROUP_INPUT && (entry.data as GroupInput | undefined)?.foreign === true);

/** A chat's newest entry when it last read foreign content: the task whose input is at or before it read it. */
export const Foreign = defineDoc<{ read?: number }>({
	kind: "banda.foreign",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** Mark `chat`'s task as having read foreign content. It reads a table, so it comes before the commit's first table write. */
export async function markForeign(tx: Tx, chat: number): Promise<void> {
	const newest = (await tx.scanEntries({ conversationId: chat as ConversationId }, 1)).items[0];
	(await tx.doc(Foreign, chat as ConversationId)).read = newest === undefined ? 0 : Number(newest.id);
}

/** Whether `chat`'s task, the one its input `input` began, read foreign content. Reads only. */
export async function readForeign(tx: Tx, chat: number, input: number): Promise<boolean> {
	const read = (await tx.doc(Foreign, chat as ConversationId)).read;
	if (read !== undefined && read >= input) return true;
	let cursor: Parameters<Tx["scanEntries"]>[2];
	do {
		const page = await tx.scanEntries(
			{ conversationId: chat as ConversationId, ...(input === 0 ? {} : { minEntryId: input as EntryId }) },
			50,
			cursor,
		);
		if (page.items.some(carriesForeign)) return true;
		cursor = page.next;
	} while (cursor !== undefined);
	return false;
}
