/** An agent file as the owner edits it from its panel: pure, for the tests. */

import { type AvatarFace, writeAvatarFace } from "../../../src/core/avatar-face.ts";

export type Edit = { readonly face?: AvatarFace; readonly name?: string; readonly personality?: string };

/** A one-line value as the file holds it: no line breaks or quotes inside, and quoted. */
const plain = (value: string) => value.replace(/[\r\n"]+/g, " ").trim();
const scalar = (value: string) => `"${plain(value)}"`;
const unquote = (value: string) => /^"(.*)"$/.exec(value)?.[1] ?? value;
/**
 * What the owner's words say the agent is for: its personality's first sentence, or its name while it has none. The
 * owner never writes a description; other agents choose whom to ask by it (the roster).
 */
const describedBy = (personality: string, name: string) => personality.split(/[.\n]/)[0]?.trim() || name;

/**
 * An agent file with its name, face or body changed, everything else as it was. A description derived from the owner's
 * words follows them; one written otherwise (an accepted proposal's, the lead's) is kept.
 */
export function edited(text: string, edit: Edit): string {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (match === null) return text;
	let head = match[1] ?? "";
	const field = (key: string) => new RegExp(`^${key}:(.*)$`, "m").exec(head)?.[1]?.trim();
	const set = (key: string, value: string) => {
		const line = new RegExp(`^${key}:.*$`, "m");
		head = line.test(head) ? head.replace(line, () => `${key}: ${value}`) : `${head}\n${key}: ${value}`;
	};
	const name = unquote(field("name") ?? "");
	const description = unquote(field("description") ?? "");
	const derived = description !== "" && description === plain(describedBy(match[2] ?? "", name));
	if (edit.name !== undefined) set("name", scalar(edit.name));
	if (edit.face !== undefined) set("face", writeAvatarFace(edit.face));
	const body = edit.personality === undefined ? (match[2] ?? "") : `${edit.personality.trim()}\n`;
	const next = plain(describedBy(body, edit.name ?? name));
	if (derived && next !== description) set("description", scalar(next));
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
		describedBy(personality, who.name),
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
