import { expect, it } from "vitest";
import type { HarnessSessionView } from "../../../src/server/api.ts";
import { askNotice, askSummary, askWords, chatActivity, harnessActivity, shownAsks } from "./harness-activity.ts";

const one: HarnessSessionView = {
	task: 1,
	chat: 3,
	agent: "sancho",
	harness: "claude-code",
	service: "Claude Code",
	folder: "~/code/app",
	state: "working",
	at: 1,
	steps: [],
	dropped: 0,
};
it("tracks recorded working, permission, completed and interrupted states in the relevant chat only", () => {
	expect(harnessActivity([one], [3]).label).toBe("Claude Code is working…");
	const asking = { ...one, state: "waiting" as const, asks: [{ id: "ask", kind: "execute", command: "npm test" }] };
	expect(harnessActivity([asking], [3])).toMatchObject({ waiting: true, label: "Waiting on you · Claude Code" });
	expect(harnessActivity([{ ...one, steps: [{ kind: "run", command: "npm test" }] }], [3]).label).toBe(
		"Claude Code is running a command…",
	);
	for (const state of ["done", "stopped", "interrupted", "failed"] as const)
		expect(harnessActivity([{ ...one, state, ended: 2 }], [3]).label).toBeUndefined();
	expect(harnessActivity([one], [4]).sessions).toEqual([]);
});
it("counts simultaneous sessions and keeps an approval first in the picker", () => {
	const asking = { ...one, task: 2, asks: [{ id: "ask", kind: "execute", command: "npm test" }] };
	expect(harnessActivity([one, { ...one, task: 3 }], [3]).label).toBe("2 coding sessions running");
	const active = harnessActivity([one, asking], [3]);
	expect(active.waiting).toBe(true);
	expect(active.sessions.map((session) => session.task)).toEqual([2, 1]);
});
it("labels an ask's buttons by its kind, never by the harness's own option names", () => {
	expect(askWords("execute")).toEqual({ what: "Run a command", verb: "Run", no: "Don't run" });
	expect(askWords("edit")).toEqual({ what: "Change a file", verb: "Allow", no: "Don't change" });
	expect(askWords("delete").no).toBe("Don't change");
	expect(askWords("fetch")).toEqual({ what: "Open a web page", verb: "Allow", no: "Don't open" });
	expect(askWords("other")).toEqual({ what: "Do something", verb: "Allow", no: "Don't allow" });
});
it("reads an ask's kind case-blind: a harness that shouts gets the same words, not the vaguest", () => {
	expect(askWords("EXECUTE")).toEqual(askWords("execute"));
	expect(askWords("Edit")).toEqual(askWords("edit"));
	expect(askSummary("EXECUTE")).toBe("run a command");
});
it("shows the asks the owner opened, by id, and always the oldest: a resolved ask moves no button", () => {
	const a = { id: "a" };
	const b = { id: "b" };
	const c = { id: "c" };
	expect(shownAsks([a, b, c], new Set())).toEqual({ visible: [a], folded: [b, c] });
	expect(shownAsks([a, b, c], new Set(["b"]))).toEqual({ visible: [a, b], folded: [c] });
	// the first ask resolves while the owner opens the next: what they opened stays open, nothing else unfolds
	expect(shownAsks([b, c], new Set(["b"]))).toEqual({ visible: [b], folded: [c] });
	expect(shownAsks([b, c], new Set())).toEqual({ visible: [b], folded: [c] });
	// an opened ask that resolved leaves a stale id behind, harmlessly
	expect(shownAsks([c], new Set(["b"]))).toEqual({ visible: [c], folded: [] });
	expect(shownAsks([], new Set(["b"]))).toEqual({ visible: [], folded: [] });
});
it("notifies with the harness and the kind, never the command, the path or the project's name", () => {
	expect(askNotice([one])).toBeUndefined();
	const asking = {
		...one,
		service: "pi",
		folder: "~/code/banda",
		asks: [{ id: "ask", kind: "execute", command: "rm -rf node_modules" }],
	};
	expect(askNotice([asking])).toBe("pi asks to run a command");
	expect(askNotice([{ ...asking, asks: [{ id: "a", kind: "edit", command: "src/x.ts" }] }])).toBe(
		"pi asks to change a file",
	);
	expect(askNotice([asking, { ...asking, task: 2 }])).toBe("pi and 1 more are waiting on you");
	expect(askNotice([asking])).not.toContain("rm -rf");
	expect(askNotice([asking])).not.toContain("~/code");
	// the project's name can itself be a secret on a lock screen
	expect(askNotice([asking])).not.toContain("banda");
});
it("preserves the agent's own activity while retaining delegated attention and clears on completion", () => {
	const active = harnessActivity([one], [3]);
	expect(chatActivity("idle", undefined, active)).toMatchObject({ state: "working", delegatedPrimary: true });
	expect(chatActivity("working", "Thinking…", active)).toMatchObject({
		state: "working",
		doing: "Thinking…",
		secondary: true,
	});
	const waiting = harnessActivity([{ ...one, asks: [{ id: "ask", kind: "execute", command: "npm test" }] }], [3]);
	expect(chatActivity("working", "Thinking…", waiting)).toMatchObject({
		state: "working",
		doing: "Thinking…",
		attention: true,
		secondary: true,
	});
	expect(chatActivity("waiting", undefined, active)).toMatchObject({
		state: "waiting",
		doing: undefined,
		delegatedPrimary: false,
	});
	expect(chatActivity("idle", undefined, harnessActivity([{ ...one, state: "done", ended: 2 }], [3]))).toMatchObject({
		state: "idle",
		doing: undefined,
		secondary: false,
	});
});
