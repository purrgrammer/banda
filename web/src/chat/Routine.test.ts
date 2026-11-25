/**
 * A routine's card says who asks and whom it runs as, each, and whether it is the agent's own or shared: what the owner
 * allows is what runs, so the card never names the asking agent as the one it wakes when another's folder holds it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the card's words for a refusal come from the app's request module, which reads the page's address as it loads
vi.hoisted(() => {
	Object.assign(globalThis, { location: { hash: "", pathname: "/", search: "" } });
});

import { problemWords, RoutineProposal } from "./Routine.tsx";

const routine = {
	agent: "Curro",
	title: "Probe",
	kind: "new" as const,
	when: "Mondays at 06:00",
	next: ["Mon 06:00"],
	ask: "Check the inbox.",
};
const text = (props: Parameters<typeof RoutineProposal>[0]) =>
	renderToStaticMarkup(createElement(RoutineProposal, props))
		.replace(/<[^>]+>/g, " ")
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, " ");

describe("a routine's card", () => {
	it("asked for in one agent's chat for another: says both, and wakes the one it runs as", () => {
		const card = text({ routine: { ...routine, runsAs: "Sancho" }, onAllow: () => {} });
		expect(card).toContain("Curro asks to set up a routine for Sancho");
		expect(card).toContain("Sancho's own routine");
		expect(card).toContain("It wakes Sancho on its own, with Sancho's instructions and access");
		expect(card).toContain("lands in Sancho's chat, not here");
		expect(card).not.toContain("It wakes Curro");
	});

	it("its own: names one agent, and says it is its own", () => {
		const card = text({ routine: { ...routine, runsAs: "Curro" }, onAllow: () => {} });
		expect(card).toContain("Curro asks to set up a routine Probe");
		expect(card).toContain("Curro's own routine");
		expect(card).toContain("It wakes Curro on its own; what it finds lands here");
	});

	it("shared: says so, and whom it runs as", () => {
		expect(text({ routine: { ...routine, runsAs: "Sancho", shared: true } })).toContain(
			"Shared routine · runs as Sancho",
		);
	});

	it("beside another routine of its name that wakes the same agent: says both will run", () => {
		expect(text({ routine: { ...routine, twin: "shared" }, onAllow: () => {} })).toContain(
			"A shared routine of this name also runs as Curro: both will run.",
		);
		expect(text({ routine: { ...routine, shared: true, twin: "own" }, onAllow: () => {} })).toContain(
			"Curro's own routine of this name also runs: both will run.",
		);
		// a removal stops one: nothing to warn of
		expect(text({ routine: { ...routine, kind: "removed", twin: "shared" } })).not.toContain("both will run");
	});
});

describe("an answer the daemon refused", () => {
	it("is said on the card, in the daemon's words, and the buttons stay: the owner answers again or looks again", () => {
		const problem = "Couldn't set it up. There is no routine curro/probe: it is gone from the box and the store";
		const card = text({ routine, problem, onAllow: () => {}, onDecline: () => {} });
		expect(card).toContain(problem);
		expect(card).toContain("Set it up");
		expect(card).toContain("Don't");
		// settled, nothing is left to refuse
		expect(text({ routine, problem, settled: "Set up · 9:12" })).not.toContain("Couldn't");
	});

	it("names what did not happen, then why: a routine gone reads apart from one changed since", async () => {
		const { Refused } = await import("../lib/api.ts");
		expect(problemWords("set it up", new Refused("there is no routine curro/probe: it is gone", 404))).toBe(
			"Couldn't set it up. There is no routine curro/probe: it is gone",
		);
		expect(
			problemWords("decline it", new Refused("agents/curro/routines/probe.md changed since you saw it", 409)),
		).toBe("Couldn't decline it. Agents/curro/routines/probe.md changed since you saw it");
		expect(problemWords("stop it", new TypeError("Failed to fetch"))).toBe(
			"Couldn't stop it. banda on this computer didn't answer. Check it's still running.",
		);
	});
});
