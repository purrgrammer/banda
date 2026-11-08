/**
 * An agent's Contacts change through the capabilities, against a fake Google: it becomes a draft in the owner's words
 * with nothing to edit; approving runs it once, as drafted, as the account the draft names; denying runs nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { openConnected } from "./fixtures/connected.ts";
import { fakeContacts } from "./fixtures/google-contacts.ts";
import { answerNudge } from "./fixtures/models.ts";
import { tempHome } from "./helpers.ts";

const GOOGLE = "https://www.googleapis.com/auth/";
const SCOPES = [`${GOOGLE}contacts.readonly`, `${GOOGLE}userinfo.email`, `${GOOGLE}contacts`];
const web = { gateway: "web", peer: OWNER };
const ANA = {
	resourceName: "people/c111",
	etag: "e0",
	names: [{ givenName: "Ana", familyName: "García" }],
	emailAddresses: [{ value: "ana@work.example" }],
};

const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
afterEach(async () => {
	for (const connected of opened.splice(0)) await connected.close();
});

/** A daemon whose lead may change Alice's contacts, and whose model makes `call` once, then says it is done. */
async function connectedWith(call: { tool: string; args: JsonObject }) {
	const home = await tempHome();
	const shipped = join(home, "shipped");
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "contacts.md"),
		readFileSync(new URL("../shipped/connections/contacts.md", import.meta.url), "utf8"),
	);
	const google = fakeContacts({ seed: { "people/c111": structuredClone(ANA) } });
	const s = await openConnected({
		home,
		shipped,
		fetch: google.fetch,
		respond: ((ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const heed = answerNudge(ctx.messages);
			if (heed !== undefined) return heed;
			const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
			if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
			return fauxAssistantMessage([fauxToolCall(`contacts__${call.tool}`, call.args, { id: "c1" })], {
				stopReason: "toolUse",
			});
		}) as never,
	});
	opened.push(s);
	await s.capabilities.addShipped("contacts");
	const started = await s.capabilities.signIn("contacts", context, LEAD, { scopes: SCOPES });
	if (!("url" in started)) throw new Error("a Google sign-in opens a page");
	const state = new URL(started.url).searchParams.get("state") ?? "";
	expect(await s.capabilities.callback({ state, code: "fake-code" })).toMatchObject({ ok: true });
	expect(s.offered()).toContain(`contacts__${call.tool}`);
	const received = await s.core.receive(s.harness, {
		id: "m1",
		origin: { gateway: "fake", peer: OWNER },
		text: "please",
	});
	if (!("turn" in received)) throw new Error(JSON.stringify(received));
	const turn = received.turn as TaskId<TurnResult>;
	const ask = async () => {
		while (true) {
			const open = (await openWaits(s.harness)).find((wait) => wait.ask.type === "approval");
			if (open !== undefined) return open;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	return { s, google, turn, ask };
}

describe("Contacts changes as drafts", () => {
	it("an added contact is a draft with nothing to edit; approved, it runs once, as drafted", async () => {
		const { s, google, turn, ask } = await connectedWith({
			tool: "create_contact",
			args: { name: "Bo Díaz", emails: ["bo@example.test"] },
		});
		const wait = await ask();
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			tool: "contacts__create_contact",
			label: "Add “Bo Díaz” to your contacts",
			verb: "Add",
			args: { name: "Bo Díaz", emails: ["bo@example.test"] },
		});
		// the owner approves what was drafted: nothing to edit, so a permission would bind every argument
		expect(wait.ask.editable ?? []).toEqual([]);
		expect(wait.ask.floor).toBeUndefined();
		expect(wait.ask.permission?.match).toMatchObject({ name: "Bo Díaz", emails: ["bo@example.test"] });
		expect(google.writes).toEqual([]);
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toHaveLength(1);
		const made = Object.values(google.people()).find((person) => person.resourceName !== "people/c111");
		expect(made).toMatchObject({
			names: [{ unstructuredName: "Bo Díaz" }],
			emailAddresses: [{ value: "bo@example.test" }],
		});
		expect(JSON.stringify(await s.harness.getTask(turn, context))).not.toContain("fake-contacts-access-token");
	});

	it("a changed contact draws the contact's card and says Change; approved, it patches once", async () => {
		const { s, google, turn, ask } = await connectedWith({
			tool: "update_contact",
			args: { contact_id: "contacts/pc111", name: "Ana García", title: "Head of Design" },
		});
		const wait = await ask();
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			label: "Change “Ana García”",
			verb: "Change",
			on: { refs: [expect.stringContaining("contacts")] },
			args: { contact_id: "pc111" },
		});
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes.map((write) => write.method)).toEqual(["PATCH"]);
		expect(google.people()["people/c111"]).toMatchObject({ organizations: [{ title: "Head of Design" }] });
	});

	it("a denied deletion runs nothing", async () => {
		const { s, google, turn, ask } = await connectedWith({ tool: "delete_contact", args: { contact_id: "pc111" } });
		const wait = await ask();
		expect(wait.ask).toMatchObject({ label: "Delete this contact from your contacts", verb: "Delete" });
		await answer(s.harness, wait.key, "deny", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toEqual([]);
		expect(Object.keys(google.people())).toEqual(["people/c111"]);
	});

	it("an approved deletion removes the contact once", async () => {
		const { s, google, turn, ask } = await connectedWith({ tool: "delete_contact", args: { contact_id: "pc111" } });
		const wait = await ask();
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes.map((write) => write.method)).toEqual(["DELETE"]);
		expect(google.people()).toEqual({});
	});
});
