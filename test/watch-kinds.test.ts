import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REST_APIS } from "../src/core/rest.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

/** Gmail as banda ships it, signed in as ana@example.com: the shape each connection's watch scenario copies. */
const GMAIL = {
	name: "gmail",
	file: readFileSync(new URL("../shipped/connections/gmail.md", import.meta.url), "utf8"),
	tools: REST_APIS.gmail.tools,
	account: "ana@example.com",
};

/** An email as `get_message` answers it: unread, then read and labelled. */
const email: Answer = (tool, args, step) => {
	if (tool !== "get_message") return { failed: `no ${tool}` };
	return {
		id: String(args.message_id),
		threadId: "t1",
		from: "Bob <bob@example.com>",
		to: "ana@example.com",
		cc: "",
		subject: "Lunch?",
		date: "Mon, 2 Nov 2026 09:00:00 +0100",
		snippet: "Are you free",
		body: "Are you free on Thursday?",
		attachments: [],
		labels: step >= 1 ? ["INBOX", "IMPORTANT"] : ["INBOX", "UNREAD"],
		unread: step < 1,
	};
};

describe("a watch through any connection", () => {
	it("a Gmail email, until Gmail declares how one is followed, is refused in the kind's words", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: GMAIL,
			object: "gmail/18c2f0a1b2c3d4e5",
			answer: email,
			clicks: ["k1"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.record.failed?.why).toBe(
			"Gmail here cannot follow a email yet: update Gmail on the Connections page",
		);
		expect(summary.wakes).toEqual([]);
		expect(summary.reads).toBe(0);
	}, 60_000);
});
