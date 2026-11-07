/**
 * Objects an agent shows (DESIGN.md "Connections", objects): a pull request, an issue, an email, an event, a person, a
 * file, named by its link or id. The app draws each as the daemon's card beneath the message, read as the account the
 * agent uses; one named in the text stays in the text, as its name, and opens its card there. The agent names the thing
 * alone: what the card says is the daemon's reading, never the model's words.
 */
import { Type } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { MessagePart } from "./part.ts";

/** How many objects one message shows. */
export const MAX_OBJECTS = 3;

const named = (args: JsonObject) =>
	Array.isArray(args.objects) ? args.objects.filter((each): each is string => typeof each === "string") : [];

export const objects: MessagePart = {
	parameters: {
		objects: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
				maxItems: MAX_OBJECTS,
				description:
					"Things in a connection to show as cards beneath the message, each by its link or id (a pull request's " +
					"or an issue's https://github.com/… address, owner/repo#34, notification/<id>, gmail/<id>, calendar/<id>, " +
					"contacts/<id>, drive/<id>). Only what the owner should see whole; name the rest in the text.",
			}),
		),
	},
	describe:
		"In `text`, write every email, event, person, file, pull request or issue you mention from a connection as a " +
		"link, [its name](its address or id, such as calendar/<id>), never as a bare id: the owner sees its name and " +
		"opens its card from there. Give `objects` (links or ids) to show one as its card beneath the message; the " +
		"owner sees what the service says of it now.",
	present: (args) => named(args).length > 0,
	refuse: (args) => {
		if (args.objects === undefined) return undefined;
		if (!Array.isArray(args.objects) || named(args).length !== args.objects.length)
			return "objects is a list of links or ids";
		if (args.objects.length > MAX_OBJECTS) return `show at most ${MAX_OBJECTS} objects in one message`;
		return named(args).some((each) => /[\s<>]/.test(each.trim()) || each.trim() === "")
			? "each object is one link or id, without spaces"
			: undefined;
	},
	said: (args) => {
		const list = named(args);
		return list.length === 0 ? undefined : list.join("\n");
	},
};
