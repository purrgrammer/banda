/**
 * The band's own file, `band.md` at the workspace root: which agents and groups are pinned to the top of the band, in
 * the owner's order. A file like memory, not a definition: it takes effect at once, whoever wrote it, and it only
 * orders what the app shows. A pin names an agent by its id (`sancho`) or a group by its room (`group:3`). With no
 * file, Sancho is pinned; a file with an empty list pins nothing.
 */
import { AGENT_NAME } from "./agents.ts";

export const BAND_FILE = "band.md";
export const MAX_BAND_BYTES = 16 * 1024;
/** The most pins kept: more than anyone scrolls through in one row. */
export const MAX_PINS = 50;
/** What a band with no file pins. */
export const DEFAULT_PINS: readonly string[] = ["sancho"];

const GROUP_PIN = /^group:([1-9][0-9]{0,9})$/;

/** Whether `pin` names an agent (its id) or a group (`group:<room>`). */
export const isPin = (pin: string): boolean => AGENT_NAME.test(pin) || GROUP_PIN.test(pin);

/**
 * The pins a `band.md` holds, in its order: the `pinned:` list of its front matter, each `- <pin>` on its own line
 * (or `pinned: []`). What is not a pin is skipped, a repeat kept once. No file: Sancho alone.
 */
export function pinsOf(text: string | undefined): string[] {
	if (text === undefined) return [...DEFAULT_PINS];
	const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
	if (front === undefined) return [];
	const pins: string[] = [];
	let listing = false;
	for (const line of front.split(/\r?\n/)) {
		const key = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (key !== null) {
			listing = key[1] === "pinned" && key[2]?.trim() === "";
			continue;
		}
		const item = /^\s+-\s+(.+?)\s*$/.exec(line);
		if (!listing || item === null) continue;
		const pin = item[1]?.replace(/^["']|["']$/g, "") ?? "";
		if (isPin(pin) && !pins.includes(pin) && pins.length < MAX_PINS) pins.push(pin);
	}
	return pins;
}

/** `band.md` holding `pins`, in that order, with a line saying what the file is for. */
export function bandFile(pins: readonly string[]): string {
	const list = pins.length === 0 ? "pinned: []" : `pinned:\n${pins.map((pin) => `  - ${pin}`).join("\n")}`;
	return `---\n${list}\n---\n\nThe band's own file. Pinned agents (by id) and groups (group:<room>) sit at the top of the band, in this order.\n`;
}

/** `pins` with `pin` pinned (last, so it lands at the end of the row) or unpinned. */
export function pinned(pins: readonly string[], pin: string, on: boolean): string[] {
	const rest = pins.filter((each) => each !== pin);
	return on ? [...rest, pin].slice(-MAX_PINS) : rest;
}
