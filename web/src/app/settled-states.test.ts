import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "../chat/Approval.tsx";
import { QuestionCard } from "../chat/Cards.tsx";
import { Done } from "../chat/Done.tsx";
import type { Ended } from "../lib/chat.ts";
import { approvalState, notDoneKind, questionState } from "./settled-states.ts";

/**
 * A settled ask's card says what happened, as the store recorded it: answered on the card or in the chat, dismissed,
 * no answer in time, or stopped before it ran. Only a no reads as the owner's no.
 */
const question = (ended: Ended) =>
	renderToStaticMarkup(
		createElement(QuestionCard, { question: "Which flight?", choices: ["TP 1351"], state: questionState(ended) }),
	);
const approval = (ended: Ended) =>
	renderToStaticMarkup(
		createElement(ApprovalCard, { agent: "Sancho", what: "Run npm test", verb: "Run", state: approvalState(ended) }),
	);

describe("a settled question's card", () => {
	it("says the answer picked on the card", () => {
		const html = question({ outcome: "answered", answer: "TP 1351", said: "TP 1351" });
		expect(html).toContain("You answered");
		expect(html).toContain("TP 1351");
	});

	it("says an answer typed in the chat was answered there, never 'Answered below' as the answer", () => {
		const html = question({ outcome: "answered", answer: "the later one", inChat: true, said: "Answered below" });
		expect(html).toContain("You answered in the chat");
		expect(html).not.toContain("Answered below");
	});

	it("tells dismissed, expired and stopped apart", () => {
		expect(question({ outcome: "dismissed", said: "Dismissed" })).toContain("You let this one go.");
		const expired = question({ outcome: "expired", said: "No answer in time" });
		expect(expired).toContain("No answer in time");
		expect(expired).not.toContain("let this one go");
		const stopped = question({ outcome: "cancelled", said: "Stopped before an answer" });
		expect(stopped).toContain("Stopped before an answer");
		expect(stopped).not.toContain("let this one go");
	});

	it("lets a long answer break rather than leave the card", () => {
		const html = question({ outcome: "answered", answer: "x", said: `https://example.test/${"a".repeat(200)}` });
		expect(html).toContain("[overflow-wrap:anywhere]");
		expect(html).not.toMatch(/class="flex items-center gap-1.5 text-ui text-ink-2"/);
	});
});

describe("a settled approval's card", () => {
	it("says no only when the owner said no", () => {
		expect(approval({ outcome: "answered", answer: "deny", said: "Declined" })).toContain(
			"You said no: didn&#x27;t run",
		);
		for (const ended of [
			{ outcome: "expired", said: "No answer in time; it did not run" },
			{ outcome: "cancelled", said: "Stopped before an answer" },
			// approved, then stopped before it ran: not done, and not a no
			{ outcome: "cancelled", answer: "approve", said: "Stopped before your answer was used" },
		] as const) {
			const html = approval(ended);
			expect(html).toContain(ended.said);
			expect(html).not.toContain("You said no");
		}
	});

	it("says what was done when it ran", () => {
		expect(approval({ outcome: "answered", answer: "approve", said: "Approved as you edited it" })).toContain(
			"Approved as you edited it",
		);
	});
});

describe("a settled ask folded into a row", () => {
	it("marks what did not happen as its card does: a clock for no answer in time, a stop for a stopped run", () => {
		expect(notDoneKind({ outcome: "expired", said: "No answer in time" })).toBe("expired");
		expect(notDoneKind({ outcome: "cancelled", said: "Stopped before an answer" })).toBe("stopped");
		expect(notDoneKind({ outcome: "cancelled", answer: "approve", said: "Stopped before your answer was used" })).toBe(
			"stopped",
		);
		expect(notDoneKind({ outcome: "dismissed", said: "Dismissed" })).toBe("declined");
		expect(notDoneKind({ outcome: "answered", answer: "deny", said: "Declined" })).toBe("declined");
		const row = (kind: "expired" | "stopped" | "declined") =>
			renderToStaticMarkup(
				createElement(Done, { kind, action: "no answer in time", reference: { where: "Book it?" } }),
			);
		expect(row("expired")).toContain("lucide-clock");
		expect(row("stopped")).toContain("lucide-circle-slash");
		expect(row("declined")).toContain("lucide-x");
		for (const kind of ["expired", "stopped", "declined"] as const) {
			expect(row(kind)).not.toContain(kind === "declined" ? "lucide-clock" : "lucide-x ");
			// not done: what it was about is struck through
			expect(row(kind)).toContain("line-through");
		}
	});
});

describe("an open ask with long words", () => {
	it("lets a long choice wrap inside its button, and a long scope inside the card", () => {
		const long = `https://example.test/${"segment/".repeat(20)}`;
		const open = renderToStaticMarkup(
			createElement(QuestionCard, { question: "Which?", choices: [long], state: { kind: "open" } }),
		);
		expect(open).toMatch(/<button[^>]*whitespace-normal[^>]*\[overflow-wrap:anywhere\][^>]*>https:/);
		expect(open).not.toMatch(/<button[^>]*whitespace-nowrap[^>]*>https:/);
		const approval = renderToStaticMarkup(
			createElement(ApprovalCard, {
				agent: "Sancho",
				what: "Send a message",
				verb: "Send",
				scope: `Send messages to ${"a".repeat(80)}@example.test without asking`,
				state: { kind: "open" },
			}),
		);
		expect(approval).toMatch(/<label[^>]*\[overflow-wrap:anywhere\][^>]*>Send messages to/);
	});
});
