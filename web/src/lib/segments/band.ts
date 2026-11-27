/**
 * What an agent made or changed in the band, in the chat's feed: a `create_agent`, `update_agent` or `create_group`
 * call is one row where it happened. The daemon applies these in the call itself, so the row has nothing to answer: it
 * says what was done and links to it. Its subject is the receipt the daemon put in the call's result (`BandReceipt`),
 * never the call's arguments; a call the daemon refused says why, and one that never answered claims nothing.
 */
import type { BandReceipt } from "../../../../src/core/band-tools.ts";
import { callState, type FeedState, refusalWhy, settled } from "../feed.ts";
import type { Segmenter } from "./types.ts";

export type BandTool = "create_agent" | "update_agent" | "create_group";

export type BandSegment = {
	readonly kind: "band";
	readonly key: string;
	readonly tool: BandTool;
	/** Working until the call answers; done with a receipt, refused with why, stopped when it never answered. */
	readonly state: FeedState;
	readonly receipt?: BandReceipt;
	/** Why the daemon refused, in its words. */
	readonly why?: string;
	readonly at?: number;
};

declare module "./types.ts" {
	interface AreaSegments {
		band: BandSegment;
	}
}

const TOOLS: ReadonlySet<string> = new Set<BandTool>(["create_agent", "update_agent", "create_group"]);

const NOUN: { readonly [tool in BandTool]: string } = {
	create_agent: "an agent",
	update_agent: "an agent",
	create_group: "a group",
};

/** The row's words, by state: never "created" for what the daemon did not say it made. */
export function bandWords(segment: Pick<BandSegment, "tool" | "state" | "receipt" | "why">): string {
	const { tool, receipt } = segment;
	const update = tool === "update_agent";
	switch (segment.state) {
		case "working":
			return update ? "Updating an agent…" : `Creating ${NOUN[tool]}…`;
		case "stopped":
			return update ? "Didn't finish updating an agent" : `Didn't finish creating ${NOUN[tool]}`;
		case "done":
			if (receipt?.kind === "group")
				return `Created the group ${receipt.name}: ${receipt.members.map(({ name }) => name).join(", ")}`;
			if (receipt?.kind === "agent" && receipt.change === "created")
				return `Created ${receipt.agent.name}: ${receipt.agent.description}`;
			if (receipt?.kind === "agent") return `Updated ${receipt.agent.name}: ${Object.keys(receipt.before).join(", ")}`;
			return update ? "Updated an agent" : `Created ${NOUN[tool]}`;
		default: {
			const not = update ? "Agent not updated" : tool === "create_group" ? "Group not created" : "Agent not created";
			return segment.why === undefined ? not : `${not}: ${segment.why}`;
		}
	}
}

export const band: Segmenter = {
	call: (call, key, at) => {
		if (!TOOLS.has(call.name)) return undefined;
		const tool = call.name as BandTool;
		const early = callState(at.result);
		const named = early === undefined ? at.result?.receipt : undefined;
		const receipt = named?.kind === "agent" || named?.kind === "group" ? named : undefined;
		const segment: BandSegment = {
			kind: "band",
			key,
			tool,
			// answered without a receipt the daemon would write: nothing the row could claim
			state: early ?? (receipt === undefined ? "refused" : "done"),
			...(receipt === undefined ? {} : { receipt }),
			...(early === "refused" ? { why: refusalWhy(at.result) } : {}),
			...(at.result?.at === undefined ? {} : { at: at.result.at }),
		};
		return [segment, ...at.asks()];
	},
	after: (segments, input) =>
		segments.map((segment) =>
			segment.kind === "band" ? { ...segment, state: settled(segment.key, segment.state, input) } : segment,
		),
	shown: (segment) => (segment.kind === "band" ? [bandWords(segment)] : undefined),
};
