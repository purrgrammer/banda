/**
 * The connect card an agent sent: a `connect` call naming a connection it needs, drawn after its message as the
 * app's own card for that connection and this agent. Only a call that was sent draws one.
 */
import type { Segmenter } from "./types.ts";

declare module "./types.ts" {
	interface AreaSegments {
		connect: {
			readonly kind: "connect";
			readonly key: string;
			/** The connection, by its name, as the call gave it. */
			readonly connection: string;
			readonly at?: number;
		};
	}
}

export const connect: Segmenter = {
	message: (call, key, { result }) => {
		const name = call.args.connect;
		if (typeof name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) return [];
		// a call refused, or not yet answered, shows no card
		if (result === undefined || result.error === true) return [];
		return [
			{
				kind: "connect",
				key: `${key}:connect`,
				connection: name,
				...(result.at === undefined ? {} : { at: result.at }),
			},
		];
	},
	shown: (segment) => (segment.kind === "connect" ? [`Connect ${segment.connection}`] : undefined),
};
