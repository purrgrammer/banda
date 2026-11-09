/**
 * The connect card (DESIGN.md "Connections"): when the agent needs a service it has no account of, it sends the card
 * instead of pointing the owner elsewhere. The card is the daemon's, the same as in its panel and Settings: Connect,
 * the code while the site opens, done once the daemon sees the grant, the account on for this agent. The agent names
 * the connection alone; what the card says and does is the app's, so nothing the model writes reaches the owner as a
 * control.
 */
import type { JsonObject } from "@earendil-works/pi-durable";
import { AGENT_NAME } from "../agents.ts";
import type { MessagePart } from "./part.ts";

const named = (args: JsonObject) => (typeof args.connect === "string" ? args.connect : undefined);

export const connect: MessagePart = {
	present: (args) => named(args) !== undefined,
	refuse: (args) => {
		const name = named(args);
		if (args.connect !== undefined && name === undefined) return "connect is a connection's name";
		return name === undefined || AGENT_NAME.test(name) ? undefined : `"${name}" is not a connection's name`;
	},
	// a gateway that shows only words hears where to connect it
	said: (args) => {
		const name = named(args);
		return name === undefined ? undefined : `Connect ${name} for me in the app, and I can use it.`;
	},
};
