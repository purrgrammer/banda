import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/follow.ts";
import { REST_APIS } from "../src/core/rest.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

/** Google Contacts as banda ships it, signed in as me@example.com. */
const CONTACTS = {
	name: "contacts",
	file: readFileSync(new URL("../shipped/connections/contacts.md", import.meta.url), "utf8"),
	tools: REST_APIS.contacts.tools,
	account: "me@example.com",
};

type Person = { [key: string]: Json };

/** Ana as `get_contact` answers her. */
const ana = (): Person => ({
	name: "Ana García",
	emails: ["ana@home.example"],
	phones: ["+34 600 000 000"],
	addresses: [],
	organization: "Northstar",
	title: "Designer",
	other: false,
	photo: "https://lh3.googleusercontent.com/a",
	url: "https://contacts.google.com/person/c111",
});

/** Ana's life: each step's answer is the one before, changed by that step's change. */
const life =
	(...steps: ((person: Person) => void)[]): Answer =>
	(tool, args, step) => {
		if (tool !== "get_contact" || args.contact_id !== "pc111") return failure(`no ${tool}`);
		const person = ana();
		for (const change of steps.slice(0, step)) change(person);
		return person;
	};

describe("a watch on a contact", () => {
	it("a phone, email or address added or removed, a new organization, title or name only tell; a new photo is nothing; it never ends", async () => {
		const summary = await watchScenario(await tempHome(), new Faults(), {
			connection: CONTACTS,
			object: "contacts/pc111",
			answer: life(
				(person) =>
					Object.assign(person, { phones: ["+34 600 000 000", "+34 611 111 111"], emails: ["ana@new.example"] }),
				(person) =>
					Object.assign(person, { addresses: ["Calle Mayor 1, 28013 Madrid"], organization: "Aurora", title: "Lead" }),
				(person) => Object.assign(person, { photo: "https://lh3.googleusercontent.com/b" }),
				(person) => Object.assign(person, { organization: "", title: "" }),
				(person) => Object.assign(person, { name: "Ana García López", phones: ["+34 611 111 111"], addresses: [] }),
			),
			clicks: ["k1", "k2", "k3", "k4", "k5"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.record.failed).toBeUndefined();
		expect(summary.wakes).toEqual([]);
		expect(summary.tells.map((tell) => [...tell.changes].sort())).toEqual([
			["email ana@home.example removed", "new email ana@new.example", "new phone +34 611 111 111"],
			["new address: Calle Mayor 1, 28013 Madrid", "now at Aurora", "title: Lead"],
			["no longer at Aurora"],
			["address removed: Calle Mayor 1, 28013 Madrid", "phone +34 600 000 000 removed", "renamed: Ana García López"],
		]);
		expect(summary.tells[0]?.object).toMatchObject({ name: "pc111", service: "Google Contacts" });
		expect(summary.turns).toEqual([]);
		expect(summary.unread).toBe(0);
		expect(summary.record.done).toBeUndefined();
		expect(summary.task?.status).not.toBe("terminal");
	}, 60_000);
});
