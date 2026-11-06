import { expect, it } from "vitest";
import type { HarnessSessionView } from "../../../src/server/api.ts";
import { askedAt, harnessActivity, runningSessions } from "./harness-activity.ts";

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
const ask = (at: number) => ({ id: `ask${at}`, kind: "execute", command: "npm test", at });

it("counts a chat's running sessions only, and whether one waits on the owner", () => {
	expect(harnessActivity([one], [3])).toMatchObject({ waiting: false });
	expect(harnessActivity([one], [3]).sessions).toHaveLength(1);
	expect(harnessActivity([{ ...one, state: "waiting", asks: [ask(5)] }], [3]).waiting).toBe(true);
	for (const state of ["done", "stopped", "interrupted", "failed"] as const)
		expect(harnessActivity([{ ...one, state, ended: 2 }], [3]).sessions).toEqual([]);
	expect(harnessActivity([one], [4]).sessions).toEqual([]);
});

it("lists every running session: waiting on the owner first, then this chat's, then the newest", () => {
	const elsewhere = { ...one, task: 2, chat: 9, at: 10 };
	const here = { ...one, task: 3, chat: 3, at: 5 };
	const asking = { ...one, task: 4, chat: 8, at: 1, asks: [ask(2)] };
	const ended = { ...one, task: 5, state: "done" as const, ended: 20 };
	const running = runningSessions([elsewhere, here, asking, ended], [3]);
	expect(running.sessions.map((session) => session.task)).toEqual([4, 3, 2]);
	expect(running.waiting).toBe(true);
	expect(runningSessions([elsewhere], [3]).waiting).toBe(false);
});

it("dates a chat by its newest open ask, and not by a session's steps", () => {
	expect(askedAt([one])).toBeUndefined();
	expect(
		askedAt([
			{ ...one, asks: [ask(7), ask(9)] },
			{ ...one, asks: [ask(8)] },
		]),
	).toBe(9);
});
