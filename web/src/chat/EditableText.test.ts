import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the approval card's module reads the page's address for its token as it loads: a page with none, on the server
vi.hoisted(() => {
	Object.assign(globalThis, { location: { hash: "", pathname: "/", search: "" } });
});

import type { Item } from "../../../src/server/api.ts";
import { DraftApproval } from "../app/DraftApproval.tsx";
import type { Ask } from "../lib/api.ts";
import { view } from "../lib/chat.ts";
import { EditableText } from "./EditableText.tsx";
import { RoutineProposal } from "./Routine.tsx";

describe("text the owner may edit before accepting it", () => {
	it("reads as the agent's words with a quiet Edit, and says when it is the owner's", () => {
		const fresh = renderToStaticMarkup(
			createElement(EditableText, { label: "Title", value: "Drafted", original: "Drafted", onChange: () => {} }),
		);
		expect(fresh).toContain("Drafted");
		expect(fresh).toContain('aria-label="Edit title"');
		expect(fresh).not.toContain("<textarea");
		expect(fresh).not.toContain("Edited by you");
		const edited = renderToStaticMarkup(
			createElement(EditableText, { label: "Title", value: "Owner's", original: "Drafted", onChange: () => {} }),
		);
		expect(edited).toContain("Owner&#x27;s");
		expect(edited).toContain("Edited by you");
		expect(edited).toContain(">Undo<");
		// read only: no Edit, no Undo, still says whose the words are
		const answered = renderToStaticMarkup(
			createElement(EditableText, { label: "Title", value: "Owner's", original: "Drafted" }),
		);
		expect(answered).toContain("Edited by you");
		expect(answered).not.toContain(">Edit<");
		expect(answered).not.toContain(">Undo<");
	});

	it("an answered approval reads what ran: the owner's text, said to be theirs", () => {
		const ask: Extract<Ask, { type: "approval" }> = {
			type: "approval",
			tool: "github__update_pull_request",
			args: { owner: "acme", repo: "banda", pullNumber: 34, title: "Drafted title", body: "Drafted description" },
			label: "Change acme/banda #34",
			editable: ["title", "body"],
		};
		// as the feed draws it: the daemon's answered Wait, with the draft that ran, through the chat's segments
		const answered: Item = {
			id: 1,
			role: "wait",
			ask,
			outcome: "answered",
			answer: "approve",
			at: 1,
			edited: { ...ask.args, title: "Owner's title" },
		};
		const segment = view([answered], [], { busy: false, running: [], thinking: false }).find(
			(each) => each.kind === "approval",
		);
		if (segment?.kind !== "approval") throw new Error("no approval segment");
		const html = renderToStaticMarkup(
			createElement(DraftApproval, {
				chat: 1,
				agent: { name: "Octo" },
				ask: segment.ask,
				label: segment.label,
				drafted: segment.drafted,
				state: { kind: "done", words: segment.ended?.said ?? "" },
			}),
		);
		expect(html).toContain("Approved as you edited it");
		expect(html).toContain("Owner&#x27;s title");
		expect(html).not.toContain("Drafted title");
		expect(html).toContain("Drafted description");
		expect(html.match(/Edited by you/g)).toHaveLength(1);
		expect(html).not.toContain(">Edit<");
		// open, the same text is the agent's, each with its own quiet Edit
		const open = renderToStaticMarkup(
			createElement(DraftApproval, { chat: 1, agent: { name: "Octo" }, ask, label: "x", wait: "k" }),
		);
		expect(open).toContain('aria-label="Edit title"');
		expect(open).toContain('aria-label="Edit description"');
		expect(open).not.toContain("Edited by you");
	});

	it("a proposed routine offers its when and what it asks to edit; a settled or removal card does not", () => {
		const routine = {
			agent: "Atlas",
			title: "Morning brief",
			kind: "new" as const,
			when: "Weekdays at 08:00",
			next: ["Thu 08:00"],
			ask: "Tell me what is on my plate today.",
			schedule: "cron 0 8 * * 1-5",
		};
		const open = renderToStaticMarkup(createElement(RoutineProposal, { routine, onAllow: () => {} }));
		expect(open).toContain('aria-label="Edit when"');
		expect(open).toContain('aria-label="Edit each run"');
		expect(open).toContain("Weekdays at 08:00");
		expect(open).not.toContain("cron 0 8");
		const settled = renderToStaticMarkup(
			createElement(RoutineProposal, { routine, settled: "Set up · Edited by you" }),
		);
		expect(settled).not.toContain(">Edit<");
		expect(settled).toContain("Edited by you");
		const removal = renderToStaticMarkup(
			createElement(RoutineProposal, { routine: { ...routine, kind: "removed" as const }, onAllow: () => {} }),
		);
		expect(removal).not.toContain(">Edit<");
	});
});
