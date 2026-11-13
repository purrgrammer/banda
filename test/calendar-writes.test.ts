/**
 * An agent's Calendar change through the capabilities, against a fake Google: it becomes a draft in the owner's
 * words; approving runs it once, as approved and edited, as the account the draft names; denying runs nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { createdEventId, eventRef } from "../src/core/calendar-rest.ts";
import { readDefinition } from "../src/core/definitions.ts";
import { OWNER } from "../src/core/gateway.ts";
import { REST_APIS, type RestApi } from "../src/core/rest.ts";
import { openWaits } from "../src/core/status.ts";
import { context } from "../src/core/store.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { answer } from "../src/core/wait.ts";
import { openConnected } from "./fixtures/connected.ts";
import { fakeCalendar } from "./fixtures/google-calendar.ts";
import { answerNudge } from "./fixtures/models.ts";
import { shippedText } from "./fixtures/shipped.ts";
import { tempHome } from "./helpers.ts";

const READ = "https://www.googleapis.com/auth/calendar.readonly";
const EVENTS = "https://www.googleapis.com/auth/calendar.events";
const web = { gateway: "web", peer: OWNER };

const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
afterEach(async () => {
	for (const connected of opened.splice(0)) await connected.close();
});

/** A daemon whose lead may change Alice's calendar, and whose model makes `call` once, then says it is done. */
async function connectedWith(
	call: { tool: string; args: JsonObject },
	wrapFetch: (fetcher: typeof fetch) => typeof fetch = (fetcher) => fetcher,
) {
	const home = await tempHome();
	const shipped = join(home, "shipped");
	mkdirSync(shipped, { recursive: true });
	writeFileSync(
		join(shipped, "calendar.json"),
		readFileSync(new URL("../shipped/connections/calendar.json", import.meta.url), "utf8"),
	);
	const google = fakeCalendar();
	const s = await openConnected({
		home,
		shipped,
		fetch: wrapFetch(google.fetch),
		respond: ((ctx: { messages: readonly { role: string; content: unknown }[] }) => {
			const heed = answerNudge(ctx.messages);
			if (heed !== undefined) return heed;
			const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((m) => m.role === "user");
			if (ctx.messages.slice(after).some((m) => m.role === "toolResult")) return fauxAssistantMessage("Done.");
			return fauxAssistantMessage([fauxToolCall(`calendar__${call.tool}`, call.args, { id: "c1" })], {
				stopReason: "toolUse",
			});
		}) as never,
	});
	opened.push(s);
	await s.capabilities.addShipped("calendar");
	const started = await s.capabilities.signIn("calendar", context, LEAD, { scopes: [READ, EVENTS] });
	if (!("url" in started)) throw new Error("a Google sign-in opens a page");
	const state = new URL(started.url).searchParams.get("state") ?? "";
	const signed = await s.capabilities.callback({ state, code: "fake-code" });
	expect(signed).toMatchObject({ ok: true });
	expect(s.offered()).toContain(`calendar__${call.tool}`);
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
	return { s, google, turn, ask, shipped };
}

describe("Calendar changes as drafts", () => {
	it("an idempotent once-approved replay cannot switch to a replacement sign-in", async () => {
		let writing!: () => void;
		const reached = new Promise<void>((resolve) => {
			writing = resolve;
		});
		const { s, google, turn, ask, shipped } = await connectedWith(
			{
				tool: "create_event",
				args: { title: "Tea", start: "2026-11-09T09:00:00+01:00", end: "2026-11-09T10:00:00+01:00" },
			},
			(fetcher) => async (input, init) => {
				if (init?.method === "POST" && String(input).includes("/calendar/v3/calendars/primary/events")) {
					const signal = init.signal;
					if (signal === undefined || signal === null) throw new Error("the write must be cancellable");
					writing();
					await new Promise<never>((_resolve, reject) => {
						if (signal.aborted) reject(signal.reason);
						else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}
				return fetcher(input, init);
			},
		);
		const waiting = await ask();
		await answer(s.harness, waiting.key, "approve", web, "bearer");
		await reached;
		const started = await s.capabilities.signIn("calendar", context, LEAD, { scopes: [READ, EVENTS] });
		if (!("url" in started)) throw new Error("a sign-in opens a page");
		expect(
			await s.capabilities.callback({ state: new URL(started.url).searchParams.get("state") ?? "", code: "fake-code" }),
		).toMatchObject({ ok: true });
		await s.close();
		opened.splice(opened.indexOf(s), 1);
		const recovered = await openConnected({
			home: s.home,
			shipped,
			fetch: google.fetch,
			respond: () => fauxAssistantMessage("Done."),
		});
		opened.push(recovered);
		await recovered.harness.waitForTask(turn, context);
		expect(await openWaits(recovered.harness)).toEqual([]);
		expect(google.writes).toEqual([]);
	});

	it("a created event is a draft in the owner's words; approved with edits, it runs once, as approved", async () => {
		const { s, google, turn, ask } = await connectedWith({
			tool: "create_event",
			args: {
				title: "Tea",
				start: "2026-11-09T09:00:00+01:00",
				end: "2026-11-09T10:00:00+01:00",
				attendees: ["ana@example.test"],
				add_meet: true,
			},
		});
		const wait = await ask();
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			tool: "calendar__create_event",
			label: "Create “Tea”",
			verb: "Create",
			args: {
				title: "Tea",
				attendees: "ana@example.test",
				location: "",
				description: "",
				account: { key: expect.any(String), generation: expect.any(String) },
			},
		});
		expect([...(wait.ask.editable ?? [])].sort()).toEqual(
			["attendees", "description", "end", "location", "start", "title"].sort(),
		);
		// it invites people: on the private floor, so no permission is offered and it asks every time
		expect(wait.ask.floor).toBe("private");
		expect(wait.ask).not.toHaveProperty("permission");
		expect(google.writes).toEqual([]);
		const filled = await answer(s.harness, wait.key, "approve", web, "bearer", {
			type: "approval",
			approving: { edits: { title: "Tea and cake", attendees: "ana@example.test, bo@example.test", location: "Café" } },
		});
		expect(filled).not.toHaveProperty("refused");
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toHaveLength(1);
		const events = Object.values(google.events());
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			summary: "Tea and cake",
			location: "Café",
			attendees: [{ email: "ana@example.test" }, { email: "bo@example.test" }],
			conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
		});
		const id = events[0]?.id as string;
		expect(id).toMatch(/^banda[a-v0-9]+$/);
		// the id is the approved effect's key's: the same key, the same event
		expect(events[0]?.conferenceData).toMatchObject({ createRequest: { requestId: id } });
		expect(createdEventId("another run")).not.toBe(id);
		const said = JSON.stringify(await s.harness.getTask(turn, context));
		expect(said).not.toContain("fake-calendar-access-token");
	});

	it("answering an invitation draws the event and says Accept; approved, it answers once as the owner", async () => {
		const { s, google, turn, ask } = await (async () => {
			const ref = eventRef("primary", "evt1") as string;
			return connectedWith({ tool: "respond_to_event", args: { event_id: `calendar/${ref}`, response: "accepted" } });
		})();
		// the invitation is there before the owner answers
		const events = google.events();
		events.evt1 = {
			id: "evt1",
			summary: "Planning",
			attendees: [
				{ email: "boss@example.test", organizer: true, responseStatus: "accepted" },
				{ email: "alice@example.test", self: true, responseStatus: "needsAction" },
			],
		};
		const wait = await ask();
		if (wait.ask.type !== "approval") throw new Error("not an approval");
		expect(wait.ask).toMatchObject({
			label: "Accept this invitation",
			verb: "Accept",
			on: { refs: [expect.stringContaining("calendar")] },
			args: { event_id: eventRef("primary", "evt1") },
		});
		await answer(s.harness, wait.key, "approve", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes.map((write) => write.method)).toEqual(["PATCH"]);
		expect(google.events().evt1?.attendees).toContainEqual(
			expect.objectContaining({ self: true, responseStatus: "accepted" }),
		);
	});

	it("a denied deletion runs nothing", async () => {
		const ref = eventRef("primary", "evt1") as string;
		const { s, google, turn, ask } = await connectedWith({ tool: "delete_event", args: { event_id: ref } });
		const wait = await ask();
		expect(wait.ask).toMatchObject({ label: "Delete this event and tell its guests", verb: "Delete" });
		await answer(s.harness, wait.key, "deny", web, "bearer", { type: "approval" });
		await s.harness.waitForTask(turn, context);
		expect(google.writes).toEqual([]);
	});
});

describe("what a built-in change never gets ahead", () => {
	it("a change whose content the owner edits, so no permission can bind it, is on a floor in its shipped file", () => {
		const shippedFile = (name: string) => {
			const parsed = readDefinition(name, shippedText(name));
			if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
			return parsed.connection;
		};
		const edited = Object.entries(REST_APIS as Record<string, RestApi>).flatMap(([name, api]) =>
			api.tools.flatMap((tool) =>
				(api.drafts?.editable(tool.name).length ?? 0) > 0 ? [[name, tool.name] as const] : [],
			),
		);
		expect(edited.length).toBeGreaterThan(0);
		for (const [name, tool] of [...edited, ["gmail", "send_message"] as const])
			expect([name, tool, shippedFile(name).floors[tool]]).toEqual([name, tool, "private"]);
	});
});
