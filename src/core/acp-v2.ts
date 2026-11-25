/**
 * ACP v2's session updates, read into the updates the steps are made of (`applyUpdate` in harness.ts), which speak
 * v1's shapes. What differs:
 * - a tool call is one `tool_call_update` that upserts by id (v1 had `tool_call` first): the steps upsert already;
 * - a command's output is on a display terminal (`terminal_update`, `terminal_output_chunk`, base64), which the tool
 *   call names in its content; it becomes the call's output;
 * - a diff names its files (`changes`) and may carry a patch, never the old and new texts;
 * - a plan is `plan_update`, by id;
 * - `state_update` is the session's foreground and background, which is the lifecycle's (harness-lifecycle.ts), not a
 *   step; `user_message` and whole-message updates are what was sent, or a replay's clearing, never steps.
 */
import type { AcpPermissionRequest, AcpUpdate } from "./acp.ts";

/** How much of a terminal's output is kept, its end. */
const OUTPUT_MAX = 8_000;
/** Terminals remembered at once, the newest kept: one exits, and goes, once its call has its output. */
const TERMINALS_KEPT = 64;

type Terminal = { output: string; command?: string; exit?: string; call?: string };

/** A diff part of either version: v1's texts, or v2's changes and patch. */
export type DiffPart = {
	readonly type?: string;
	readonly path?: string;
	readonly oldText?: string | null;
	readonly newText?: string;
	readonly changes?: readonly { readonly path?: string; readonly oldPath?: string; readonly operation?: string }[];
	readonly patch?: { readonly text?: string } | null;
	/** A v2 patch's lines, counted (patchLines): what the steps show for a diff that has no texts. */
	readonly lines?: { readonly added: number; readonly removed: number; readonly diff: string };
};

/** A v2 patch's own lines: each added and removed line, the file headers left out. */
export function patchLines(text: string): { added: number; removed: number; diff: string } {
	const kept: string[] = [];
	let added = 0;
	let removed = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) {
			added++;
			kept.push(line);
		} else if (line.startsWith("-")) {
			removed++;
			kept.push(line);
		}
	}
	return { added, removed, diff: kept.join("\n") };
}

const decode = (data: unknown): string => {
	if (typeof data !== "string") return "";
	try {
		return Buffer.from(data, "base64").toString("utf8");
	} catch {
		return "";
	}
};
const tailOf = (text: string) => (text.length > OUTPUT_MAX ? text.slice(-OUTPUT_MAX) : text);

/** The steps' updates of one v2 connection: it remembers each terminal, so its output reaches the call that owns it. */
export class V2Updates {
	#terminals = new Map<string, Terminal>();

	/** What `update` is as v1 step updates: none for one that is no step. */
	take(update: AcpUpdate): AcpUpdate[] {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk":
			case "usage_update":
			case "session_info_update":
			case "available_commands_update":
				return [update];
			case "plan_update": {
				const plan = update.plan as { type?: unknown; entries?: unknown } | undefined;
				return plan?.type === "items" && Array.isArray(plan.entries)
					? [{ sessionUpdate: "plan", entries: plan.entries }]
					: [];
			}
			case "tool_call_update":
				return [this.#call(update)];
			case "terminal_update":
			case "terminal_output_chunk":
				return this.#terminal(update);
			default:
				return [];
		}
	}

	#call(update: AcpUpdate): AcpUpdate {
		const content = Array.isArray(update.content) ? (update.content as { type?: string; terminalId?: unknown }[]) : [];
		let output: string | undefined;
		for (const part of content)
			if (part.type === "terminal" && typeof part.terminalId === "string") {
				const terminal = this.#terminals.get(part.terminalId) ?? { output: "" };
				terminal.call = String(update.toolCallId);
				this.#terminals.set(part.terminalId, terminal);
				if (terminal.output !== "") output = terminal.output;
			}
		const diffs = content.filter((part) => part.type === "diff") as DiffPart[];
		const kept = content.filter((part) => part.type !== "terminal" && part.type !== "diff");
		return {
			...update,
			...(update.content === undefined ? {} : { content: [...kept, ...diffs.map(v1Diff)] }),
			...(output === undefined ? {} : { rawOutput: output }),
		};
	}

	#terminal(update: AcpUpdate): AcpUpdate[] {
		const id = update.terminalId;
		if (typeof id !== "string") return [];
		const terminal = this.#terminals.get(id) ?? { output: "" };
		this.#terminals.set(id, terminal);
		if (update.sessionUpdate === "terminal_output_chunk")
			terminal.output = tailOf(terminal.output + decode(update.data));
		else {
			const output = (update.output as { data?: unknown } | null | undefined)?.data;
			if (output !== undefined) terminal.output = tailOf(decode(output));
			if (typeof update.command === "string") terminal.command = update.command;
		}
		const exited = typeof update.exitStatus === "object" && update.exitStatus !== null;
		if (this.#terminals.size > TERMINALS_KEPT) {
			const oldest = this.#terminals.keys().next().value;
			if (oldest !== undefined && oldest !== id) this.#terminals.delete(oldest);
		}
		// the claude adapter names a command's terminal after its call; any other names it in the call's content
		const call = terminal.call;
		if (call === undefined) return [];
		if (exited) this.#terminals.delete(id);
		return [{ sessionUpdate: "tool_call_update", toolCallId: call, rawOutput: terminal.output }];
	}
}

/** A v2 diff as the steps read one: its first file, and its patch's lines when it carries one. */
function v1Diff(part: DiffPart): DiffPart {
	if (part.changes === undefined) return part;
	const path = part.changes[0]?.path;
	const text = part.patch?.text;
	return {
		type: "diff",
		...(path === undefined ? {} : { path }),
		// its changes stay: a v2 diff with no patch says no lines, never v1's empty texts
		changes: part.changes,
		...(typeof text === "string" ? { lines: patchLines(text) } : {}),
	};
}

/**
 * A v2 permission request (`title`, `subject.toolCall`) as the v1 shape the asks are made of (`toolCall` with its
 * title). A `command` subject is the command it would run, in its folder; one with no subject is its title and
 * description, both shown. A subject of another kind cannot be shown whole, so it is marked unreviewable: refused,
 * never approved from its title alone. Either way it is named by `fallback` when it names no tool call.
 */
export function permissionOf(params: unknown, fallback: string): AcpPermissionRequest {
	const request = (params ?? {}) as {
		sessionId?: unknown;
		title?: unknown;
		subject?: { type?: unknown; toolCall?: { [field: string]: unknown } } | null;
		toolCall?: unknown;
		options?: unknown;
	};
	if (request.toolCall !== undefined) return request as unknown as AcpPermissionRequest;
	const subject = request.subject as
		| { type?: unknown; toolCall?: unknown; command?: unknown; cwd?: unknown }
		| null
		| undefined;
	const description =
		typeof (request as { description?: unknown }).description === "string"
			? (request as { description: string }).description
			: undefined;
	const call: { [field: string]: unknown } =
		subject?.type === "tool_call"
			? ((subject.toolCall ?? {}) as { [field: string]: unknown })
			: subject?.type === "command" && typeof subject.command === "string"
				? {
						...(typeof (subject as { toolCallId?: unknown }).toolCallId === "string"
							? { toolCallId: (subject as { toolCallId: string }).toolCallId }
							: {}),
						kind: "execute",
						rawInput: { command: subject.command, ...(typeof subject.cwd === "string" ? { cwd: subject.cwd } : {}) },
					}
				: subject === undefined || subject === null
					? description === undefined
						? {}
						: { content: [{ type: "content", content: { type: "text", text: description } }] }
					: { unreviewable: true };
	const content = Array.isArray(call.content) ? (call.content as { type?: string }[]) : undefined;
	return {
		sessionId: String(request.sessionId ?? ""),
		toolCall: {
			...call,
			toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : fallback,
			...(typeof call.title === "string" ? {} : typeof request.title === "string" ? { title: request.title } : {}),
			...(content === undefined
				? {}
				: { content: content.map((part) => (part.type === "diff" ? v1Diff(part) : part)) }),
		} as AcpPermissionRequest["toolCall"],
		options: (Array.isArray(request.options) ? request.options : []) as AcpPermissionRequest["options"],
	};
}
