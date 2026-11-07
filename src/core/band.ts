/**
 * The band's own file, `band.json` at the workspace root: which agents and groups are pinned to the top of the band, in
 * the owner's order, and whether their tiles sit in the middle of the row (Settings, Appearance). Data, not prose, so
 * it is typed: `BandFile` is its schema, checked on every read. A file like memory, not a definition: it takes effect
 * at once, whoever wrote it, and only changes what the app shows. A pin names an agent by its id (`sancho`) or a group
 * by its room (`group:3`). With no file, Sancho is pinned; an empty list pins nothing.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export const BAND_FILE = "band.json";
export const MAX_BAND_BYTES = 16 * 1024;
/** The most pins kept: more than anyone scrolls through in one row. */
export const MAX_PINS = 50;
/** What a band with no file pins. */
export const DEFAULT_PINS: readonly string[] = ["sancho"];

/** An agent's id (as `AGENT_NAME` says) or `group:<room>`. */
export const Pin = Type.String({
	pattern: "^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|group:[1-9][0-9]{0,9})$",
	description: "An agent's id, or group:<room> for a group",
});

/** `band.json`'s schema. */
export const BandFile = Type.Object(
	{
		pinned: Type.Array(Pin, {
			maxItems: MAX_PINS,
			uniqueItems: true,
			description: "Pinned to the top of the band, in this order",
		}),
		centred: Type.Optional(
			Type.Boolean({ description: "Centre the pinned tiles while they fit in one row; left-aligned when absent" }),
		),
	},
	{ additionalProperties: false, title: "band.json", description: "The band's own file, at the workspace root" },
);
export type BandFile = Static<typeof BandFile>;

/** Whether `pin` names an agent (its id) or a group (`group:<room>`). */
export const isPin = (pin: unknown): pin is string => Value.Check(Pin, pin);

/**
 * The band a `band.json` holds, or why it is not one the daemon reads (not JSON, or not of its schema: such a file is
 * shown as no file and never written over). No file: Sancho alone.
 */
export function readBandFile(text: string | undefined): BandFile | { readonly unreadable: string } {
	if (text === undefined) return { pinned: [...DEFAULT_PINS] };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { unreadable: "it is not JSON" };
	}
	if (Value.Check(BandFile, value)) return value;
	const [first] = Value.Errors(BandFile, value);
	return { unreadable: `it does not fit its schema${first === undefined ? "" : `: ${first.message}`}` };
}

/** `band.json` holding `band`: its pins in order, and `centred` only when on. */
export function bandFile(band: BandFile): string {
	const written: BandFile = { pinned: [...band.pinned], ...(band.centred === true ? { centred: true } : {}) };
	return `${JSON.stringify(written, null, "\t")}\n`;
}

/** `pins` with `pin` pinned (last, so it lands at the end of the row) or unpinned. */
export function pinned(pins: readonly string[], pin: string, on: boolean): string[] {
	const rest = pins.filter((each) => each !== pin);
	return on ? [...rest, pin].slice(-MAX_PINS) : rest;
}
