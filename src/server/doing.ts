/**
 * Work in progress as one plain line (DESIGN.md "The app"): what a tool call is doing, in the present tense, with no
 * tool names, paths or ids. The daemon labels its own tools, so the app never maps a tool name to words.
 */
import { toolWords } from "../core/ask.ts";
import type { OpenWait } from "../core/status.ts";
import type { ShownWait } from "./api.ts";

/** The tools whose names a label must never say: every tool the daemon has, and the words they are known by. */
export const TOOL_NAMES = ["bash", "read", "write", "edit", "message_user", "message_group", "schedule"] as const;

/** Whether `text` holds a tool's name as a word of its own (so `readme.md` is fine, `notes.read` is not). */
export function namesTool(text: string): boolean {
	return TOOL_NAMES.some((name) => new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`).test(text));
}

/** A path's last part, fit to show: control characters gone, at most 60 characters; undefined when nothing is left. */
function basename(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
	const base = (path.split(/[/\\]/).at(-1) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (base === "" || base === "." || base === "..") return undefined;
	const short = base.length > 60 ? `${base.slice(0, 59)}…` : base;
	return namesTool(short) ? undefined : short;
}

/** An address's host, fit to show: a plain host name of at most 60 characters; undefined for anything else. */
function hostOf(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	try {
		const host = new URL(url.trim()).hostname;
		return /^[a-z0-9.-]{1,60}$/.test(host) ? host : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The line for a call of `tool` with `args`; undefined for `message_user` and `message_group`, whose message shows itself. Anything
 * unknown is `working`.
 */
export function doing(tool: string, args: unknown): string | undefined {
	const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	switch (tool) {
		case "message_user":
		case "message_group":
			return undefined;
		case "tool_search":
			return "finding a tool";
		case "bash":
			return "running a command";
		case "read": {
			const name = basename(given.path);
			return name === undefined ? "reading a file" : `reading ${name}`;
		}
		case "write":
		case "edit": {
			const name = basename(given.path);
			return name === undefined ? "writing a file" : `writing ${name}`;
		}

		case "search":
			return "searching conversations and artifacts";
		case "read_search_result":
			return "reading a source";
		case "schedule":
			return "setting up a routine";
		case "web_fetch": {
			const host = hostOf(given.url);
			return host === undefined ? "reading a page" : `reading ${host}`;
		}
		case "browser_navigate":
		case "browser_snapshot":
		case "browser_click":
		case "browser_select":
		case "browser_scroll":
		case "browser_wait":
		case "browser_screenshot":
			return "using its browser";
		case "browser_type":
			return "typing in its browser";
		case "browser_send":
			return "sending a form from its browser";
		case "browser_hand_over":
			return "waiting for you in its browser";
		case "propose_key":
			return "keeping a key";
		default:
			return "working";
	}
}

/**
 * What an approval asks to let run, in words: the line for its call where the table has a specific one, else the tool's
 * name in words (`send_email`: "send email").
 */
export function approvalLabel(tool: string, args: unknown): string {
	const line = doing(tool, args);
	if (line !== undefined && line !== "working") return line;
	return toolWords(tool);
}

/** An open ask as the app shows it: an approval says what it would run, in words. */
export const shownWait = (wait: OpenWait): ShownWait =>
	wait.ask.type === "approval"
		? { ...wait, label: wait.ask.label ?? approvalLabel(wait.ask.tool, wait.ask.args) }
		: wait;
