import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backgroundOf, Lifecycle } from "../src/core/harness-lifecycle.ts";
import { pbtRuns } from "./pbt.ts";

const ROOT = "root";
const term = (id: string) => ({ type: "terminal", terminalId: id });
const call = (id: string) => ({ type: "tool_call", toolCallId: id });

/**
 * Orders as the installed adapters send them (read in their source: claude-agent-acp 0.100.0 `dist/v2/prompt.js`,
 * `background.js`, `background-work.js`; codex-acp 2.5.0 `promptV2`, `AcpV2ForegroundState`): a prompt is answered
 * once taken in, before the `running` of the turn it starts; a list is a full snapshot on every state; a list change
 * repeats the current state without a stop reason; an item's final status comes before the list that drops it.
 */
describe("a v2 session's lifecycle", () => {
	it("stays open past end_turn while a background command runs, and ends quiet once the list drops it", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1); // answered on insertion, before `running`
		expect(life.verdict(0)).toEqual({ kind: "open", why: "turn" });
		life.state(ROOT, "running", undefined, []);
		life.state(ROOT, "running", undefined, [term("bash-1")]);
		life.state(ROOT, "idle", "end_turn", [term("bash-1")]);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "background" });
		life.final(ROOT, "terminal", "bash-1", "exited");
		life.state(ROOT, "idle", undefined, []);
		expect(life.verdict(0)).toEqual({ kind: "quiet", stopReason: "end_turn" });
		expect(life.ended).toEqual([{ type: "terminal", id: "bash-1", session: ROOT, status: "exited" }]);
	});

	it("never ends between a prompt's answer and the run it starts", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.state(ROOT, "running", undefined, []);
		life.accepted(1);
		life.state(ROOT, "idle", "end_turn", []);
		expect(life.verdict(0).kind).toBe("quiet");
		// a note, taken in while idle: answered before its `running`, and a repeated idle snapshot between
		life.sent(2);
		life.accepted(2);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "turn" });
		life.state(ROOT, "idle", undefined, []);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "turn" });
		life.state(ROOT, "running", undefined, []);
		life.state(ROOT, "idle", "end_turn", []);
		expect(life.verdict(0).kind).toBe("quiet");
	});

	it("a note queued behind the turn: the turn's own idle ends nothing it owes", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, []);
		life.sent(2); // mid-turn: queued until the turn ends
		life.state(ROOT, "idle", "end_turn", []);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "prompt" });
		life.accepted(2);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "turn" });
		life.state(ROOT, "running", undefined, []);
		life.state(ROOT, "idle", "end_turn", []);
		expect(life.verdict(0).kind).toBe("quiet");
	});

	it("a note taken into the running turn ends with it", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, []);
		life.sent(2);
		life.accepted(2); // steered in: no new `running`
		life.state(ROOT, "idle", "end_turn", []);
		expect(life.verdict(0).kind).toBe("quiet");
	});

	it("a permission from background work holds an idle session open", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, [{ type: "subagent", sessionId: "child" }]);
		life.state(ROOT, "idle", "end_turn", [{ type: "subagent", sessionId: "child" }]);
		life.state("child", "requires_action", undefined, [term("child-bash")]);
		expect(life.verdict(1)).toEqual({ kind: "open", why: "ask" });
		expect(life.background.map((item) => `${item.session}:${item.type}:${item.id}`)).toEqual([
			"child:terminal:child-bash",
			"root:subagent:child",
		]);
		life.state("child", "idle", "end_turn", []);
		life.state(ROOT, "idle", undefined, []);
		expect(life.verdict(0).kind).toBe("quiet");
	});

	it("an agent that never reports the list ends unreported, never quiet (codex-acp 2.5.0)", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, undefined);
		life.state(ROOT, "idle", "end_turn", null);
		expect(life.verdict(0)).toEqual({ kind: "unreported", stopReason: "end_turn" });
		expect(life.reported).toBe(false);
	});

	it("a list left out or malformed after one that named work: that list stands, so the work is not killed", () => {
		for (const missing of [undefined, null, [{ type: "terminal" }], [42], "[]"]) {
			const life = new Lifecycle(2, ROOT);
			life.sent(1);
			life.accepted(1);
			life.state(ROOT, "running", undefined, [term("t")]);
			life.state(ROOT, "idle", "end_turn", missing);
			expect(life.verdict(0)).toEqual({ kind: "open", why: "background" });
			expect(life.reported).toBe(false);
			// what it named is not taken for ended
			expect(life.ended).toEqual([]);
			life.state(ROOT, "idle", undefined, []);
			expect(life.verdict(0).kind).toBe("quiet");
		}
	});

	it("a list left out after an empty one is unknown again: unreported, never quiet", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, []);
		life.state(ROOT, "idle", "end_turn", undefined);
		expect(life.verdict(0).kind).toBe("unreported");
	});

	it("a prompt taken in with no run of its own is over at the next idle that ends work, not at a repeated one", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "idle", undefined, []);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "turn" });
		life.state(ROOT, "idle", "end_turn", []);
		expect(life.verdict(0).kind).toBe("quiet");
	});

	it("counts a subagent once, and forgets a subagent's own list once the root no longer lists it", () => {
		const life = new Lifecycle(2, ROOT);
		life.state(ROOT, "idle", undefined, [{ type: "subagent", sessionId: "child" }]);
		life.state("child", "running", undefined, [term("c1")]);
		expect(life.running).toBe(1);
		expect(life.background.map((item) => item.id)).toEqual(["c1", "child"]);
		life.state(ROOT, "idle", undefined, []);
		expect(life.background).toEqual([]);
		expect(life.running).toBe(0);
	});

	it("an item dropped without a final status ended unsaid; a late final fills it in", () => {
		const life = new Lifecycle(2, ROOT);
		life.state(ROOT, "running", undefined, [call("monitor"), term("t")]);
		life.state(ROOT, "running", undefined, []);
		expect(life.ended).toEqual([
			{ type: "tool_call", id: "monitor", session: ROOT },
			{ type: "terminal", id: "t", session: ROOT },
		]);
		life.final(ROOT, "tool_call", "monitor", "cancelled");
		expect(life.ended[0]).toEqual({ type: "tool_call", id: "monitor", session: ROOT, status: "cancelled" });
		// a non-final status is no end
		life.final(ROOT, "tool_call", "x", "in_progress");
	});

	it("an unknown or future kind of work holds it open, and the state it names unknown is not idle", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, [{ type: "_claude/task", taskId: "t1", description: "watch" }]);
		life.state(ROOT, "idle", "end_turn", [{ type: "_claude/task", taskId: "t1" }]);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "background" });
		life.state(ROOT, "_future", undefined, []);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "foreground" });
	});

	it("a prompt Stop withdrew before it was taken in owes nothing", () => {
		const life = new Lifecycle(2, ROOT);
		life.sent(1);
		life.accepted(1);
		life.state(ROOT, "running", undefined, []);
		life.sent(2);
		life.state(ROOT, "idle", "cancelled", []);
		life.refused(2);
		expect(life.verdict(0)).toEqual({ kind: "quiet", stopReason: "cancelled" });
	});

	it("nothing is decided before the first prompt", () => {
		const life = new Lifecycle(2, ROOT);
		life.state(ROOT, "idle", undefined, []);
		expect(life.verdict(0)).toEqual({ kind: "open", why: "prompt" });
	});
});

describe("a v1 session's lifecycle", () => {
	it("ends unreported once every prompt's turn ended: v1 says nothing of what runs on, and holds no ask past it", () => {
		const life = new Lifecycle(1, ROOT);
		life.sent(1);
		life.sent(2);
		life.answered(1, "end_turn");
		expect(life.verdict(0)).toEqual({ kind: "open", why: "turn" });
		life.answered(2, "max_tokens");
		expect(life.verdict(0)).toEqual({ kind: "unreported", stopReason: "max_tokens" });
		expect(life.verdict(1).kind).toBe("unreported");
		// a v2 state on a v1 connection is not trusted for a list
		expect(life.reported).toBe(false);
	});
});

describe("a background list", () => {
	it("reads each known kind by its id, and a well-formed empty list as nothing running", () => {
		expect(backgroundOf("s", [])).toEqual([]);
		expect(backgroundOf("s", [term("a"), call("b"), { type: "subagent", sessionId: "c" }])).toEqual([
			{ type: "terminal", id: "a", session: "s" },
			{ type: "tool_call", id: "b", session: "s" },
			{ type: "subagent", id: "c", session: "s" },
		]);
		expect(backgroundOf("s", undefined)).toBeUndefined();
		expect(backgroundOf("s", null)).toBeUndefined();
		expect(backgroundOf("s", [{ type: "tool_call" }])).toBeUndefined();
	});
});

/**
 * A spec-conforming v2 agent with its truth hidden: prompts it holds, whether its foreground runs, the background work
 * it runs, the asks it waits on. It answers a prompt taken in while idle before reporting the run (as both adapters
 * do), may take a note into a running turn or queue it, repeats states on list changes, sends a final status before a
 * list drops an item, and may start a run of its own once idle. Whenever the client says quiet, the truth must be
 * quiet; and once the agent has nothing left, the client must not still be waiting.
 */
describe("the lifecycle against a simulated v2 agent", () => {
	type Truth = {
		queued: number[];
		/** taken in, not yet run to the end of a turn */
		held: number[];
		/** answered while idle: its `running` still to come */
		starting: boolean;
		running: boolean;
		background: string[];
		asks: number;
		next: number;
		sent: number;
	};

	it("says quiet only when nothing runs, and never waits once nothing does", () => {
		fc.assert(
			fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 120 }), fc.boolean(), (choices, steers) => {
				const life = new Lifecycle(2, ROOT);
				const truth: Truth = {
					queued: [],
					held: [],
					starting: false,
					running: false,
					background: [],
					asks: 0,
					next: 0,
					sent: 0,
				};
				const list = () => truth.background.map(term);
				const state = (s: string, stopReason?: string) => life.state(ROOT, s, stopReason, list());
				const quietTruth = () =>
					truth.queued.length === 0 &&
					truth.held.length === 0 &&
					!truth.starting &&
					!truth.running &&
					truth.background.length === 0 &&
					truth.asks === 0;
				const send = () => {
					const id = ++truth.sent;
					truth.queued.push(id);
					life.sent(id);
				};
				send();
				const actions: (() => boolean)[] = [
					// the client sends a note
					() => {
						if (truth.sent >= 4) return false;
						send();
						return true;
					},
					// the agent takes the next prompt in
					() => {
						const id = truth.queued[0];
						if (id === undefined || truth.starting) return false;
						if (truth.running && !steers) return false;
						truth.queued.shift();
						truth.held.push(id);
						if (!truth.running) truth.starting = true;
						life.accepted(id);
						return true;
					},
					// the run it owes starts
					() => {
						if (!truth.starting) return false;
						truth.starting = false;
						truth.running = true;
						state("running");
						return true;
					},
					// it starts a background command
					() => {
						if (!truth.running || truth.background.length > 2) return false;
						truth.background.push(`t${++truth.next}`);
						state("running");
						return true;
					},
					// a background command ends: its final status, then the list without it
					() => {
						const id = truth.background[0];
						if (id === undefined) return false;
						life.final(ROOT, "terminal", id, "exited");
						truth.background.shift();
						state(truth.running ? "running" : "idle");
						return true;
					},
					// background work asks, and is answered
					() => {
						if (truth.background.length === 0 || truth.asks > 0) return false;
						truth.asks = 1;
						return true;
					},
					() => {
						if (truth.asks === 0) return false;
						truth.asks = 0;
						return true;
					},
					// the turn ends: everything it held is done
					() => {
						if (!truth.running || truth.asks > 0) return false;
						truth.running = false;
						truth.held = [];
						state("idle", "end_turn");
						return true;
					},
					// a repeated snapshot
					() => {
						state(truth.running ? "running" : "idle");
						return true;
					},
					// a run of its own, once idle with nothing owed (a follow-up on a finished task)
					() => {
						if (truth.running || truth.starting || truth.held.length > 0) return false;
						truth.running = true;
						state("running");
						return true;
					},
				];
				const check = () => {
					const verdict = life.verdict(truth.asks);
					if (verdict.kind === "quiet") expect(quietTruth()).toBe(true);
					expect(verdict.kind).not.toBe("unreported");
				};
				for (const choice of choices) {
					// the chosen action, else the next one that can happen now
					for (let offset = 0; offset < actions.length; offset++)
						if (actions[(choice + offset) % actions.length]?.()) break;
					check();
				}
				// drain: the agent finishes all it has, as it must
				for (let guard = 0; guard < 50 && !quietTruth(); guard++) {
					if (truth.asks > 0) truth.asks = 0;
					else if (truth.queued.length > 0 && !truth.starting && !truth.running) actions[1]?.();
					else if (truth.starting) actions[2]?.();
					else if (truth.queued.length > 0 && truth.running && steers) actions[1]?.();
					else if (truth.running) actions[7]?.();
					else if (truth.background.length > 0) actions[4]?.();
					check();
				}
				expect(quietTruth()).toBe(true);
				expect(life.verdict(0).kind).toBe("quiet");
			}),
			{ numRuns: pbtRuns(300) },
		);
	});
});
