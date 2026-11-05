/** An agent file as the owner edits it from its panel: pure, for the tests. */

import { type AvatarFace, writeAvatarFace } from "../../../src/core/avatar-face.ts";

export type Edit = { readonly face?: AvatarFace; readonly name?: string; readonly personality?: string };

const scalar = (value: string) => `"${value.replace(/[\r\n"]+/g, " ").trim()}"`;

/** An agent file with its name, face or body changed, everything else as it was. */
export function edited(text: string, edit: Edit): string {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (match === null) return text;
	let head = match[1] ?? "";
	const set = (key: string, value: string) => {
		const line = new RegExp(`^${key}:.*$`, "m");
		head = line.test(head) ? head.replace(line, () => `${key}: ${value}`) : `${head}\n${key}: ${value}`;
	};
	if (edit.name !== undefined) set("name", scalar(edit.name));
	if (edit.face !== undefined) set("face", writeAvatarFace(edit.face));
	const body = edit.personality === undefined ? (match[2] ?? "") : `${edit.personality.trim()}\n`;
	return `---\n${head}\n---\n${body}`;
}

const TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"web_fetch",
	"browser_snapshot",
	"browser_navigate",
	"browser_click",
	"browser_type",
	"browser_select",
	"browser_scroll",
	"browser_wait",
	"browser_screenshot",
	"browser_send",
	"browser_hand_over",
	"propose_key",
	"remember",
	"recall",
	"forget",
];

/** The agent's file, as the owner's own. */
export function agentFile(who: { readonly face: AvatarFace; readonly name: string }, personality: string): string {
	return `---\nname: ${scalar(who.name)}\nface: ${writeAvatarFace(who.face)}\ndescription: ${scalar(
		// its personality's first sentence, or its name while it has none: the owner never writes a description
		personality.split(/[.\n]/)[0]?.trim() || who.name,
	)}\ntier: balanced\ntools: [${TOOLS.join(", ")}]\n---\n${personality.trim()}\n`;
}

/** An agent file archived or restored, everything else as it was. */
export function withState(text: string, state: "active" | "archived"): string {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (match === null) return text;
	const head = match[1] ?? "";
	const line = /^state:.*$/m;
	return `---\n${line.test(head) ? head.replace(line, `state: ${state}`) : `${head}\nstate: ${state}`}\n---\n${match[2] ?? ""}`;
}
