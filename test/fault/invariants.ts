/**
 * The Turn invariants (DESIGN.md "Flows", "Messages"), checked after every faulted run, whatever the faults were: each
 * input reaches its origin's chat exactly once, in order; every Turn ends; the agent's messages to an origin
 * arrive in the order of the inputs they answer (at least once, so a repeat is allowed, a reorder or a loss is not), and
 * every input whose run answered was answered (the owner's, answered in notes alone, once nudged; nobody else's notes
 * are answered, and no notes are ever sent); a run is nudged at most once, and only the owner's; a run that failed told its sender; a message is given up only for a
 * reason `undeliverable` admits, or because the gateway refused it; and a message given up is told to the owner on
 * their own origin, unless that notice was given up too, for a reason `undeliverable` admits.
 */
import { expect } from "vitest";
import { type Inbound, OWNER, routeKey } from "../../src/core/gateway.ts";
import { REACT, REACTION, SAY } from "../fixtures/models.ts";
import { OWNER_ORIGIN, REFUSING, type Sent, type Summary } from "./sut.ts";

export function checkTurnInvariants(
	inputs: readonly Inbound[],
	sent: readonly Sent[],
	summary: Summary,
	undeliverable: (reason: string) => boolean = () => false,
): void {
	for (const m of inputs) expect(summary.outcomes[m.id]?.status, `the Turn of ${m.id}`).toBe("completed");
	for (const message of summary.messages) {
		const label = `the message ${JSON.stringify(message.text)} to ${routeKey(message.origin)}`;
		expect(message.outcome?.status, label).toBe("completed");
		if (message.outcome?.status !== "completed" || !("undelivered" in message.outcome.result)) {
			expect(message.origin.peer, `${label} went through`).not.toBe(REFUSING);
			continue;
		}
		const { undelivered: why } = message.outcome.result;
		const refused = message.origin.peer === REFUSING && why === "refused";
		expect(refused || undeliverable(why), `why ${label} was given up: ${why}`).toBe(true);
		// a notice about a notice is never sent: the owner's own origin has nowhere else to be told
		if (routeKey(message.origin) === routeKey(OWNER_ORIGIN)) continue;
		const notice = message.notice;
		expect(notice?.status, `the notice about ${label}`).toBe("completed");
		if (notice?.status !== "completed") continue;
		if ("undelivered" in notice.result) {
			expect(undeliverable(notice.result.undelivered), `why the notice about ${label} was given up`).toBe(true);
			continue;
		}
		const told = sent.filter((s) => routeKey(s.to) === routeKey(OWNER_ORIGIN)).map((s) => s.out.text);
		expect(told, `the owner told about ${label}`).toContainEqual(
			expect.stringMatching(
				new RegExp(`^Message not delivered to fake/${message.origin.peer}: ${why} \\(\\d+ attempts?\\)\\.$`),
			),
		);
	}
	const origins = new Map(inputs.map((m) => [routeKey(m.origin), m.origin]));
	for (const [key, origin] of origins) {
		const mine = inputs.filter((m) => routeKey(m.origin) === key);
		expect(summary.inbound[key], `inbound entries of ${key}`).toEqual(mine.map((m) => m.id));
		if (origin.peer === REFUSING) continue;
		const texts = sent.filter((s) => routeKey(s.to) === key).map((s) => s.out.text);
		const answers = texts.filter((text) => text.startsWith("re: ")).filter((text, i, all) => all.indexOf(text) === i);
		// a run's notes are never sent, whoever it answered
		expect(
			texts.filter((text) => text.includes("said: ")),
			`notes sent to ${key}`,
		).toEqual([]);
		// a run answering the owner that left them unanswered is nudged, once: never anyone else's, never twice
		const owners = origin.peer === OWNER;
		const steps = summary.inputs[key] ?? [];
		if (!owners) expect(steps, `nudges in ${key}`).not.toContain("nudge");
		expect(
			steps.some((step, i) => step === "nudge" && steps[i - 1] === "nudge"),
			`two nudges in a row in ${key}: ${steps.join(" ")}`,
		).toBe(false);
		// a reaction alone answers in its emoji, which says nothing of the order; a final text alone answers no one but
		// the owner, nudged
		const worded = mine.filter((m) => !m.text.startsWith(REACT));
		const expected = worded.map((m) => `re: ${m.text}`);
		// in input order: each answer is to an input of this origin, after the answers to earlier ones
		expect(
			answers.map((text) => expected.indexOf(text)),
			`answers to ${key}: ${JSON.stringify(answers)}`,
		).toEqual([...answers.map((text) => expected.indexOf(text))].sort((a, b) => a - b));
		expect(
			answers.every((text) => expected.includes(text)),
			`answers to ${key} answer its inputs`,
		).toBe(true);
		for (const m of mine) {
			const outcome = summary.outcomes[m.id];
			if (outcome?.status !== "completed") continue;
			if ("failed" in outcome.result)
				expect(texts, `the failure of ${m.id} told`).toContainEqual(expect.stringMatching(/^The run failed: /));
			else if (outcome.result.ended === "answered" && m.text.startsWith(REACT))
				expect(texts, `the reaction to ${m.id}`).toContain(REACTION);
			// answered in notes alone: nobody else's is answered; the owner's is nudged, unless they wrote again first,
			// which the next run answers
			else if (
				outcome.result.ended === "answered" &&
				m.text.startsWith(SAY) &&
				(!owners || mine.indexOf(m) < mine.length - 1)
			)
				continue;
			else if (outcome.result.ended === "answered") expect(answers, `the answer to ${m.id}`).toContain(`re: ${m.text}`);
		}
	}
}
