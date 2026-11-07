/**
 * The words and refs a settled dialog folds into (chat/Done.tsx): an approval's verb in the past, what kind of row it
 * is, and the object it acted on read as a rich ref. And which cards were seen open on this page, so one answered
 * here folds as the owner watches while one already answered when the chat opened is a row from the start.
 */
import { useEffect, useState } from "react";
import type { ObjectShown } from "../../../src/server/objects.ts";
import type { DoneKind } from "../chat/Done.tsx";
import { ObjectLink } from "../chat/Object.tsx";
import { api } from "../lib/api.ts";

const seenOpen = new Set<string>();

/** A card drawn open: it may settle here. */
export function sawOpen(key: string): void {
	seenOpen.add(key);
}

/** It was open on this page: its settling is seen, so it folds rather than appearing folded. */
export function wasOpen(key: string): boolean {
	return seenOpen.has(key);
}

const IRREGULAR: Record<string, string> = {
	buy: "bought",
	do: "did",
	make: "made",
	pay: "paid",
	put: "put",
	run: "ran",
	send: "sent",
	set: "set",
	write: "wrote",
	label: "labelled",
};

/** An effect's verb, done: Comment → commented, Merge → merged, Send → sent, Stop → stopped. */
export function past(verb: string): string {
	const word = verb.toLowerCase();
	const irregular = IRREGULAR[word];
	if (irregular !== undefined) return irregular;
	if (word.endsWith("e")) return `${word}d`;
	if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ied`;
	// one short syllable ending consonant-vowel-consonant doubles: stop, ship, tag, plan, submit
	if (/^(?:[^aeiou]*[aeiou][^aeiouwxy]|submit|commit|omit)$/.test(word)) return `${word}${word.at(-1)}ed`;
	return `${word}ed`;
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** What an approved effect did, from its card's words: "Comment on banda #34" → "commented on banda #34". */
export function didWords(label: string, verb: string): string {
	const [first = "", ...rest] = label.split(" ");
	if (first.toLowerCase() === verb.toLowerCase()) return [past(verb), ...rest].join(" ");
	return `${past(verb)}: ${lower(label)}`;
}

/** What a declined or unanswered effect did not do: "Comment on banda #34" → "didn't comment on banda #34". */
export function didNotWords(label: string, outcome: "declined" | "expired" | "cancelled"): string {
	if (outcome === "expired") return `not done, no answer in time: ${lower(label)}`;
	if (outcome === "cancelled") return `stopped before it ran: ${lower(label)}`;
	return `didn't ${lower(label)}`;
}

/** The row's kind, by the effect's verb and words: its icon. Anything else is a permission used. */
export function approvalKind(verb: string, label: string): DoneKind {
	const word = verb.toLowerCase();
	const words = label.toLowerCase();
	if (word === "comment" || word === "reply") return "comment";
	if (word === "merge") return "merge";
	if (word === "push" || word === "commit") return "push";
	if (word === "label") return "label";
	if (word === "close") return "close";
	if (word === "review" || word === "approve") return "review";
	if (word === "send" || word === "email" || word === "post") return "send";
	if (word === "book" || word === "buy" || word === "pay" || word === "order") return "book";
	if (word === "create" || word === "open")
		return words.includes("pull request") ? "pull-request" : words.includes("issue") ? "issue" : "permission";
	return "permission";
}

type Readable = Extract<ObjectShown, { shown: "card" }>["card"];

/**
 * The object an effect acted on, as a message draws it: the service's mark, its state, its title, linked. Read once;
 * until it reads, or when it cannot, nothing (the row's words already name it).
 */
export function AskRef({
	chat,
	on,
	agent,
}: {
	chat: number;
	on: { readonly refs: readonly string[]; readonly account?: string };
	agent?: string | undefined;
}) {
	const [card, setCard] = useState<Readable | undefined>();
	const request = JSON.stringify({ ...on, ...(agent === undefined ? {} : { agent }) });
	useEffect(() => {
		let gone = false;
		api<ObjectShown[]>("/objects", {
			method: "POST",
			body: JSON.stringify({ chat, asks: [JSON.parse(request)] }),
		}).then(
			(shown) => {
				const first = shown[0];
				if (!gone && first?.shown === "card") setCard(first.card);
			},
			() => {
				// no preview: the words stand alone
			},
		);
		return () => {
			gone = true;
		};
	}, [chat, request]);
	if (card === undefined || card.card === "notification") return null;
	return <ObjectLink object={card} href={card.url ?? ""} />;
}
