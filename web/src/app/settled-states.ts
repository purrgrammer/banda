/** How a settled ask's card reads, from how its wait ended as the store recorded it. Pure. */
import type { ApprovalState } from "../chat/Approval.tsx";
import type { QuestionState } from "../chat/Cards.tsx";
import type { Ended } from "../lib/chat.ts";

/**
 * A settled question's card, by how its wait ended as the store recorded it: answered on the card or in the chat,
 * dismissed, or never answered (no answer in time, or its run stopped first).
 */
export function questionState(ended: Ended | undefined): QuestionState {
	if (ended?.outcome === "answered")
		return ended.inChat === true ? { kind: "answered", inChat: true } : { kind: "answered", answer: ended.said };
	if (ended?.outcome === "expired" || ended?.outcome === "cancelled") return { kind: ended.outcome, words: ended.said };
	return { kind: "dismissed" };
}

/**
 * A settled approval's card: done, declined, or neither (no answer in time; stopped before it ran, even after a yes),
 * which never reads as the owner saying no.
 */
export function approvalState(ended: Ended | undefined): ApprovalState {
	if (ended?.outcome === "expired" || ended?.outcome === "cancelled") return { kind: ended.outcome, words: ended.said };
	if (ended?.outcome === "answered" && ended.answer === "approve") return { kind: "done", words: ended.said };
	return { kind: "declined" };
}
