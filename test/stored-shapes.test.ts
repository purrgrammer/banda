/**
 * A home made by an earlier build opens in this one: a stored doc whose shape a rename changed is migrated by its
 * definition's version, never read as missing. Each case writes the earlier shape with that version's definition,
 * closes the store, and reads it back through today's.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { Connected } from "../src/core/connections.ts";
import { Devices, INVITE_MS, pairingState } from "../src/core/devices.ts";
import { Harnesses } from "../src/core/harness.ts";
import { keepReading, Readings } from "../src/core/objects.ts";
import { Permissions } from "../src/core/permissions.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { context, openStore } from "../src/core/store.ts";
import { tempHome } from "./helpers.ts";

const open = (home: string) => openStore(home, { models: createModels(), registry: createRegistry() });

it("reads a host permission given before permissions named their agent (Permissions version 1) as the lead's", async () => {
	const home = await tempHome();
	type V1 = { tool: string; match: { [key: string]: string }; what: string; scope: string; at: number; wait: number };
	const v1 = defineDoc<{ permissions: { [id: string]: V1 }; next: number }>({
		kind: "banda.permissions",
		version: 1,
		scope: "session",
		initial: () => ({ permissions: {}, next: 1 }),
		checkpointWhen: () => true,
	});
	const before = await open(home);
	await before.commit(async (tx) => {
		const doc = await tx.doc(v1);
		const base = { tool: "propose_send", at: 1, wait: 1 };
		doc.permissions["1"] = {
			...base,
			match: { _host: "github.com" },
			what: "send anything to github.com",
			scope: "host",
		};
		doc.permissions["2"] = {
			...base,
			match: { _route: "POST a.example/x" },
			what: "send POST requests",
			scope: "always",
		};
		doc.next = 3;
	}, context);
	await before.close(context);

	const after = await open(home);
	try {
		const doc = await after.snapshot(Permissions, context);
		expect(doc?.permissions["1"]).toMatchObject({ agent: LEAD, what: "your lead may send anything to github.com" });
		expect(doc?.permissions["2"]).not.toHaveProperty("agent");
		expect(doc?.next).toBe(3);
	} finally {
		await after.close(context);
	}
});

it("reopens current account authority and object readings without a migration", async () => {
	const home = await tempHome();
	const before = await open(home);
	await before.commit(async (tx) => {
		const connected = await tx.doc(Connected);
		connected.epoch = 7;
		connected.accounts.github = { alice: { id: "alice", at: 123 } };
		connected.on.reader = { github: ["alice"] };
		connected.off.github__issue_read = true;
		await keepReading(tx, "github/alice/issue:org/repo#12", {
			connection: "github",
			account: "alice",
			kind: "issue",
			source: "accepted-definition-and-account-generation",
			at: 456,
			card: {
				card: "issue",
				repo: "org/repo",
				number: 12,
				title: "Readings survive a restart",
				state: "unknown",
				author: "alice",
				labels: [],
				comments: null,
			},
		});
		await keepReading(tx, "calendar/me@example.test/event:calendar/cHJpbWFyeSBlMQ", {
			connection: "calendar",
			account: "me@example.test",
			kind: "event",
			source: "accepted-definition-and-account-generation",
			at: 789,
			card: {
				card: "event",
				title: "Planning",
				start: "2026-11-09T10:00:00+01:00",
				end: "2026-11-09T11:00:00+01:00",
				allDay: false,
				timeZone: "Europe/Madrid",
				location: "",
				organizer: "me@example.test",
				who: "Ana +2",
				attendees: null,
				response: "accepted",
				status: "confirmed",
				description: "",
				url: "https://www.google.com/calendar/event?eid=x",
			},
		});
		await keepReading(tx, "contacts/me@example.test/contact:contacts/oc1", {
			connection: "contacts",
			account: "me@example.test",
			kind: "contact",
			source: "accepted-definition-and-account-generation",
			at: 790,
			card: {
				card: "contact",
				name: "Bo",
				emails: "bo@example.test",
				phones: "",
				organization: "",
				title: "",
				other: true,
			},
		});
		await keepReading(tx, "drive/me@example.test/file:drive/1aBcD", {
			connection: "drive",
			account: "me@example.test",
			kind: "file",
			source: "accepted-definition-and-account-generation",
			at: 790,
			card: {
				card: "file",
				name: "Q1 rollout plan",
				kind: "doc",
				mimeType: "application/vnd.google-apps.document",
				owner: "Ana",
				modified: "2026-11-05T16:42:10.000Z",
				size: null,
				description: "",
				url: "https://docs.google.com/document/d/1aBcD/edit",
			},
		});
	}, context);
	await before.close(context);
	const after = await open(home);
	try {
		expect(await after.snapshot(Connected, context)).toMatchObject({
			epoch: 7,
			accounts: { github: { alice: { id: "alice", at: 123 } } },
			on: { reader: { github: ["alice"] } },
			off: { github__issue_read: true },
		});
		expect((await after.snapshot(Readings, context))?.readings["github/alice/issue:org/repo#12"]).toMatchObject({
			account: "alice",
			source: "accepted-definition-and-account-generation",
			at: 456,
			card: { title: "Readings survive a restart", state: "unknown", comments: null },
		});
		expect(
			(await after.snapshot(Readings, context))?.readings["calendar/me@example.test/event:calendar/cHJpbWFyeSBlMQ"],
		).toMatchObject({ card: { card: "event", attendees: null, allDay: false, who: "Ana +2" } });
		expect(
			(await after.snapshot(Readings, context))?.readings["contacts/me@example.test/contact:contacts/oc1"],
		).toMatchObject({ card: { card: "contact", other: true, emails: "bo@example.test" } });
		expect((await after.snapshot(Readings, context))?.readings["drive/me@example.test/file:drive/1aBcD"]).toMatchObject(
			{
				card: { card: "file", kind: "doc", size: null, name: "Q1 rollout plan" },
			},
		);
	} finally {
		await after.close(context);
	}
});

it("reads connections stored before anonymous MCP access (Connected version 1) with no agent switches", async () => {
	const home = await tempHome();
	const v1 = defineDoc<{
		epoch: number;
		connections: { [name: string]: never };
		off: { [tool: string]: true };
		accounts: { [connection: string]: never };
		on: { [agent: string]: never };
	}>({
		kind: "banda.connections",
		version: 1,
		scope: "session",
		initial: () => ({ epoch: 0, connections: {}, off: {}, accounts: {}, on: {} }),
		checkpointWhen: () => true,
	});
	const before = await open(home);
	await before.commit(async (tx) => {
		const doc = await tx.doc(v1);
		doc.epoch = 4;
		doc.off = { github__merge: true };
	}, context);
	await before.close(context);

	const after = await open(home);
	try {
		await after.commit(async (tx) => {
			const doc = await tx.doc(Connected);
			expect(doc.public).toEqual({});
			doc.public["mcp-new"] = [LEAD];
		}, context);
		const doc = await after.snapshot(Connected, context);
		expect(doc).toMatchObject({ epoch: 4, off: { github__merge: true }, public: { "mcp-new": [LEAD] } });
	} finally {
		await after.close(context);
	}
});

it("reopens devices, an invite claimed and a request waiting as they were stored", async () => {
	const home = await tempHome();
	const phone = "a".repeat(64);
	const tablet = "b".repeat(64);
	const before = await open(home);
	await before.commit(async (tx) => {
		const doc = await tx.doc(Devices);
		doc.devices[phone] = { name: "Pixel", paired: 10, revoked: 20 };
		doc.invites.h1 = { made: 30, expires: 30 + INVITE_MS, claimed: { by: tablet, at: 31 } };
		doc.invites.h0 = {
			made: 1,
			expires: 1 + INVITE_MS,
			claimed: { by: phone, at: 2 },
			spent: { at: 10, approved: true },
		};
		doc.requests[tablet] = { name: "Tablet", at: 31, invite: "h1" };
	}, context);
	await before.close(context);
	const after = await open(home);
	try {
		const doc = await after.snapshot(Devices, context);
		expect(doc).toEqual({
			devices: { [phone]: { name: "Pixel", paired: 10, revoked: 20 } },
			invites: {
				h1: { made: 30, expires: 30 + INVITE_MS, claimed: { by: tablet, at: 31 } },
				h0: { made: 1, expires: 1 + INVITE_MS, claimed: { by: phone, at: 2 }, spent: { at: 10, approved: true } },
			},
			requests: { [tablet]: { name: "Tablet", at: 31, invite: "h1" } },
		});
		expect(pairingState(doc, tablet, 32)).toBe("pending");
		expect(pairingState(doc, phone, 32)).toBe("revoked");
	} finally {
		await after.close(context);
	}
});

it("reopens current harness authority, continuation and process identities unchanged", async () => {
	const home = await tempHome();
	const before = await open(home);
	const session = {
		chat: 1,
		agent: "sancho",
		harness: "fake",
		folder: "~/code/app",
		prompt: "fix",
		state: "working" as const,
		at: 1,
		// a decided step keeps the ask's kind, so a folded row can say it in words after a reopen
		steps: [{ kind: "decided" as const, command: "make deploy", ask: "execute", allowed: true }],
		dropped: 0,
		// the latest useful session/update of each kind, one each
		updates: { usage: { used: 20, size: 100 }, info: { title: "Fixing" } },
		notes: [{ text: "check", at: 2, from: "agent" as const, call: "n1", sent: true as const }],
		continues: 9,
		continuation: "native" as const,
		groups: [{ id: 42, members: [{ pid: 42, started: 1234 }] }],
	};
	await before.commit(async (tx) => {
		const doc = await tx.doc(Harnesses);
		doc.accounts.fake = { folder: "~/code", agents: ["sancho"] };
		doc.sessions[10] = session;
	}, context);
	await before.close(context);
	const after = await open(home);
	try {
		expect((await after.snapshot(Harnesses, context))?.sessions[10]).toEqual(session);
	} finally {
		await after.close(context);
	}
});

it("reads auth/providers.json as stored: credentials by account, and the labels the owner gave accounts", async () => {
	const home = await tempHome();
	const shape = {
		credentials: {
			anthropic: { type: "api_key", key: "sk-personal" },
			"anthropic@work": { type: "oauth", access: "a", refresh: "r", expires: 1 },
		},
		accounts: { anthropic: { label: "Personal" }, "anthropic@work": { label: "Work" } },
	};
	await mkdir(join(home, "auth"), { recursive: true });
	await writeFile(join(home, "auth", "providers.json"), JSON.stringify(shape));
	const credentials = new FileCredentialStore(home);
	expect(await credentials.read("anthropic@work")).toEqual(shape.credentials["anthropic@work"]);
	expect(await credentials.labels()).toEqual({ anthropic: "Personal", "anthropic@work": "Work" });
	// a file that does not fit its schema is refused, never read as no credentials
	await writeFile(join(home, "auth", "providers.json"), JSON.stringify({ credentials: { anthropic: { key: "x" } } }));
	await expect(credentials.read("anthropic")).rejects.toThrow(/schema/);
});
