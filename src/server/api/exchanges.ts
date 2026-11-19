/**
 * What two agents said to each other (DESIGN.md "Agents and groups"): the messages `message_agent` delivered between
 * them, from both of their direct chats, and nothing else of either chat. `GET /api/exchanges/<a>/<b>`.
 */

/** One message an agent sent another, as it landed in the recipient's direct chat. */
export type ExchangeMessage = {
	/** The recipient's chat, and the entry in it. */
	readonly chat: number;
	readonly entry: number;
	readonly from: string;
	readonly to: string;
	readonly text: string;
	/** When it was sent (epoch ms). */
	readonly at: number;
	/** The sender's tool call that sent it: what the sender's own chat names it by. */
	readonly call?: string;
};

/** A page of the exchange between two agents, oldest first; `next` asks for the older page (`?before=`). */
export type ExchangeView = {
	readonly agents: readonly [string, string];
	readonly items: readonly ExchangeMessage[];
	readonly next?: string;
};
