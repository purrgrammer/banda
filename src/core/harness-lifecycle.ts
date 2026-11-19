/**
 * When a harness session may end, from what the agent said and nothing else: no clock, no guess. Pure, so every order
 * the wire may deliver can be tried (test/harness-lifecycle.test.ts).
 *
 * ACP v1 answers a prompt when its turn ends, and says nothing of work left running past it. ACP v2 answers a prompt
 * once the agent took it in (`{ messageId }`), reports the session's foreground as `state_update`s (`running`,
 * `requires_action`, `idle`) and, when it reports background work, a complete list of it on every one of them:
 * omitted or `null` is "not reported", never "nothing runs"; `[]` is nothing runs; a malformed list is not reported.
 *
 * A session is quiet, and may end as done, only on evidence: every prompt taken in and its turn over, no ask open, the
 * root's foreground idle, and its latest list reported and empty. One whose agent does not report the list is
 * `unreported` once the rest holds: what it may have left running is unknown, never taken for finished.
 */

export type Foreground = "idle" | "running" | "requires_action" | "unknown";

/** A piece of background work as a list names it: a terminal, a tool call, a subagent's session, or another kind. */
export type BackgroundItem = {
	/** As the list says it: `terminal`, `tool_call`, `subagent`, `_claude/task`, or another. */
	readonly type: string;
	/** Its terminal, tool call, session or task id. */
	readonly id: string;
	/** The session whose list names it. */
	readonly session: string;
};

/** An item a list dropped, with the final status the agent sent before it, if any: none is "not said", never done. */
export type EndedItem = BackgroundItem & { readonly status?: string };

export type Verdict =
	| { readonly kind: "open"; readonly why: "prompt" | "turn" | "ask" | "foreground" | "background" }
	/** Evidence that nothing runs: the session may end as done (or stopped, when Stop was asked for). */
	| { readonly kind: "quiet"; readonly stopReason?: string }
	/** Its turns are over and no ask is open, but the agent does not say whether work runs on. */
	| { readonly kind: "unreported"; readonly stopReason?: string };

type Prompt = {
	/** v2: the agent took it in. v1: never (its answer is the end of its turn). */
	accepted: boolean;
	/** v2: a foreground run that holds it: the one it was taken into, or one reported after. */
	held: boolean;
	done: boolean;
};

/** What a list holds, or undefined when it is not a well-formed list (omitted, `null`, or malformed). */
export function backgroundOf(session: string, background: unknown): BackgroundItem[] | undefined {
	if (!Array.isArray(background)) return undefined;
	const items: BackgroundItem[] = [];
	for (const entry of background as unknown[]) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const item = entry as {
			type?: unknown;
			terminalId?: unknown;
			toolCallId?: unknown;
			sessionId?: unknown;
			taskId?: unknown;
		};
		if (typeof item.type !== "string") return undefined;
		const id =
			item.type === "terminal"
				? item.terminalId
				: item.type === "tool_call"
					? item.toolCallId
					: (item.sessionId ?? item.taskId ?? item.terminalId ?? item.toolCallId);
		// a known kind without its id is malformed, and so is the list; an unknown one without an id is still work
		if (typeof id !== "string" || id === "") {
			if (item.type === "terminal" || item.type === "tool_call") return undefined;
			items.push({ type: item.type, id: JSON.stringify(entry).slice(0, 200), session });
			continue;
		}
		items.push({ type: item.type, id, session });
	}
	return items;
}

const key = (item: BackgroundItem) => `${item.session}\u0000${item.type}\u0000${item.id}`;
const FINAL = new Set(["completed", "failed", "cancelled"]);
/** How many dropped items are remembered, newest kept. */
const ENDED_KEPT = 32;

export class Lifecycle {
	readonly protocol: 1 | 2;
	readonly root: string;
	#prompts = new Map<number, Prompt>();
	#foreground: Foreground = "idle";
	/** Each session's latest list, as last reported; a session absent here never reported one. */
	#lists = new Map<string, BackgroundItem[] | undefined>();
	#stopReason: string | undefined;
	#finals = new Map<string, string>();
	/** Sessions whose latest state left the list out, after one that named work: that list stands. */
	#lost = new Set<string>();
	#ended: EndedItem[] = [];

	constructor(protocol: 1 | 2, root: string) {
		this.protocol = protocol;
		this.root = root;
	}

	/** A `session/prompt` went to the agent. */
	sent(id: number): void {
		this.#prompts.set(id, { accepted: false, held: false, done: false });
	}

	/**
	 * v2: the agent answered a prompt, so it took it in. Taken into running foreground work, that run holds it; taken in
	 * while idle (the agent answers before it reports the run it starts), it waits for the next run.
	 */
	accepted(id: number): void {
		const prompt = this.#prompts.get(id);
		if (prompt === undefined || prompt.accepted) return;
		prompt.accepted = true;
		prompt.held = this.#foreground === "running" || this.#foreground === "requires_action";
	}

	/** v1: the agent answered a prompt, so its turn ended. */
	answered(id: number, stopReason: string | undefined): void {
		const prompt = this.#prompts.get(id);
		if (prompt === undefined) return;
		prompt.done = true;
		this.#stopReason = stopReason;
	}

	/** The agent refused a prompt (a cancel withdrew it before it was taken in): it owes nothing. */
	refused(id: number): void {
		const prompt = this.#prompts.get(id);
		if (prompt !== undefined) prompt.done = true;
	}

	/**
	 * A v2 `state_update` of `session`. The root's foreground decides its prompts; every session's list is kept, so Stop
	 * reaches what each names. Whether any list changed.
	 */
	state(session: string, state: string, stopReason: unknown, background: unknown): boolean {
		const items = backgroundOf(session, background);
		const changed = this.#list(session, items);
		if (session !== this.root) return changed;
		const foreground: Foreground =
			state === "idle" || state === "running" || state === "requires_action" ? state : "unknown";
		this.#foreground = foreground;
		if (foreground === "running" || foreground === "requires_action")
			for (const prompt of this.#prompts.values()) if (prompt.accepted) prompt.held = true;
		if (foreground === "idle") {
			// an idle ends the foreground work that held a prompt; one taken in but not yet run waits for its run, or for
			// an idle that ends work (it carries a stop reason: a repeated snapshot carries none) after it was taken in
			const ends = typeof stopReason === "string" && stopReason !== "";
			for (const prompt of this.#prompts.values()) if (prompt.accepted && (prompt.held || ends)) prompt.done = true;
			if (ends) this.#stopReason = stopReason;
		}
		return changed;
	}

	/**
	 * A tool call or terminal's final status, kept for when a list drops it (a list may drop it only after): only for an
	 * item a list names now, or one it dropped with no status said (a late final), so a long session keeps no more.
	 */
	final(session: string, type: "tool_call" | "terminal", id: string, status: string): void {
		if (type === "tool_call" && !FINAL.has(status)) return;
		const one = key({ type, id, session });
		const ended = this.#ended.findIndex((item) => key(item) === one);
		const known = this.#ended[ended];
		// a final that comes after the drop replaces "not said"
		if (known !== undefined && known.status === undefined) this.#ended[ended] = { ...known, status };
		else if ((this.#lists.get(session) ?? []).some((item) => key(item) === one)) this.#finals.set(one, status);
	}

	#list(session: string, items: BackgroundItem[] | undefined): boolean {
		const before = this.#lists.get(session);
		const had = this.#lists.has(session);
		// a list left out (or malformed) after one that named work says nothing of that work: it may still run, so the
		// last list stands (the agent MUST send it on every state). After an empty one, it is unknown again
		if (items === undefined && before !== undefined && before.length > 0) {
			this.#lost.add(session);
			return false;
		}
		this.#lost.delete(session);
		this.#lists.set(session, items);
		if (before !== undefined) {
			const now = new Set((items ?? []).map(key));
			// an unreported list drops nothing: it says nothing, so what it named may still run
			if (items !== undefined)
				for (const item of before)
					if (!now.has(key(item))) {
						const status = this.#finals.get(key(item));
						this.#finals.delete(key(item));
						this.#ended.push(status === undefined ? item : { ...item, status });
						if (this.#ended.length > ENDED_KEPT) this.#ended.shift();
					}
		}
		if (!had) return true;
		return JSON.stringify(before ?? null) !== JSON.stringify(items ?? null);
	}

	get foreground(): Foreground {
		return this.#foreground;
	}

	/** The root's latest list was reported (and well formed). */
	get reported(): boolean {
		return this.protocol === 2 && this.#lists.get(this.root) !== undefined && !this.#lost.has(this.root);
	}

	/**
	 * Every item the lists name: the root's, and those of the subagents it lists now (one it no longer lists is over,
	 * whatever its own last list said), the root's last.
	 */
	get background(): BackgroundItem[] {
		const root = this.#lists.get(this.root) ?? [];
		const all: BackgroundItem[] = [];
		const seen = new Set<string>();
		const walk = (items: readonly BackgroundItem[]) => {
			for (const item of items)
				if (item.type === "subagent" && !seen.has(item.id)) {
					seen.add(item.id);
					const own = this.#lists.get(item.id) ?? [];
					walk(own);
					all.push(...own);
				}
		};
		walk(root);
		all.push(...root);
		return all;
	}

	/** The pieces of work it reports running on: the root's list, each subagent counted once with its own work. */
	get running(): number {
		return (this.#lists.get(this.root) ?? []).length;
	}

	/** Items lists dropped, with the final status sent for each, when one was. */
	get ended(): readonly EndedItem[] {
		return this.#ended;
	}

	/**
	 * Whether it may end now, and on what: `asks` is how many of its asks wait on the owner. A v1 turn that ended has
	 * no ask left to answer (its harness answered them, or withdrew them, before it ended the turn): asks hold only v2.
	 */
	verdict(asks: number): Verdict {
		if (this.#prompts.size === 0) return { kind: "open", why: "prompt" };
		for (const prompt of this.#prompts.values())
			if (!prompt.done) return { kind: "open", why: prompt.accepted || this.protocol === 1 ? "turn" : "prompt" };
		const stopReason = this.#stopReason === undefined ? {} : { stopReason: this.#stopReason };
		if (this.protocol === 1) return { kind: "unreported", ...stopReason };
		if (asks > 0) return { kind: "open", why: "ask" };
		if (this.#foreground !== "idle") return { kind: "open", why: "foreground" };
		const root = this.#lists.get(this.root);
		if (root === undefined) return { kind: "unreported", ...stopReason };
		if (root.length > 0) return { kind: "open", why: "background" };
		return { kind: "quiet", ...stopReason };
	}
}
