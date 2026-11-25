/**
 * A home made by an earlier build opens in this one: a stored doc whose shape a rename changed is migrated by its
 * definition's version, never read as missing. Each case writes the earlier shape with that version's definition,
 * closes the store, and reads it back through today's.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { Accepted, agentPath, LEAD, LEAD_TEXT, shaOf } from "../src/core/agents.ts";
import { EffectRun } from "../src/core/ask.ts";
import { Connected, credentialsOf, ToolSettings, WALLET, walletOf } from "../src/core/connections.ts";
import { Devices, INVITE_MS, pairingState } from "../src/core/devices.ts";
import { Harnesses } from "../src/core/harness.ts";
import { keepReading, Readings } from "../src/core/objects.ts";
import { Permissions } from "../src/core/permissions.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineWait } from "../src/core/wait.ts";
import { Followed } from "../src/core/watches.ts";
import { AgentPublications, queueAgentPublication } from "../src/server/agent-publication.ts";
import { checksummed } from "../src/wallet/address.ts";
import {
	Incoming,
	incomingKey,
	nativeKey,
	type PaymentState,
	Payments,
	type PaymentValue,
	track,
	Wallets,
	type WalletsValue,
} from "../src/wallet/docs.ts";
import { tempHome } from "./helpers.ts";

const open = (home: string) => openStore(home, { models: createModels(), registry: createRegistry() });

it("reopens one captured connection authority on its task, approval and permission without a migration", async () => {
	const home = await tempHome();
	const wait = defineWait(async () => {});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.authority", tasks: [wait] }));
	const before = await openStore(home, { models: createModels(), registry });
	const authority = { connection: "cal", tool: "create", version: "s1", listing: 2, accountArg: "as_account" as const };
	const args = { account: { key: "provider", generation: "provider" }, as_account: { key: "ana", generation: "G1" } };
	const id = await before.commit(async (tx) => {
		const connected = await tx.doc(Connected);
		connected.versions = 2;
		connected.servers.cal = { service: "Calendar", url: "https://cal.example/mcp", auth: "oauth", version: 1, at: 0 };
		connected.connections.cal = {
			version: "s1",
			tools: {
				create: {
					generation: 2,
					description: "create",
					schema: { type: "object", properties: { account: { type: "object" } } },
				},
			},
			at: 0,
		};
		const permissions = await tx.doc(Permissions);
		permissions.permissions["1"] = {
			tool: "cal__create",
			authority,
			match: args,
			what: "create",
			scope: "always",
			agent: LEAD,
			at: 0,
			wait: 0,
		};
		permissions.next = 2;
		const chat = await tx.createConversation({ ownership: { kind: "ownerless" } });
		return tx.createTask(
			wait,
			{
				key: "approval",
				ask: { type: "approval", tool: "cal__create", authority, args, floor: "money" },
				deadline: Date.now() + 60_000,
			},
			{ conversationId: chat.id, ownership: { kind: "conversation" } },
		);
	}, context);
	await before.commit(async (tx) => {
		const run = await tx.doc(EffectRun, id);
		run.authority = authority;
		run.draft = args;
	}, context);
	const expected = {
		connected: await before.snapshot(Connected, context),
		permissions: await before.snapshot(Permissions, context),
		run: await before.snapshot(EffectRun, id, context),
		ask: (await before.getTask(id, context))?.input,
	};
	await before.close(context);
	const after = await openStore(home, { models: createModels(), registry });
	try {
		expect(await after.snapshot(Connected, context)).toEqual(expected.connected);
		expect(await after.snapshot(Permissions, context)).toEqual(expected.permissions);
		expect(await after.snapshot(EffectRun, id, context)).toEqual(expected.run);
		expect((await after.getTask(id, context))?.input).toEqual(expected.ask);
	} finally {
		await after.close(context);
	}
});

it("reopens the exact pending owner publication and accepted bytes without a migration", async () => {
	const home = await tempHome();
	const before = await open(home);
	const text = `${LEAD_TEXT}\nA saved owner revision.\n`;
	const file = { text, sha: shaOf(text), at: 123 };
	await before.commit(async (tx) => {
		await queueAgentPublication(tx, { name: LEAD, file, base: shaOf(LEAD_TEXT), workingBase: shaOf(LEAD_TEXT) });
		(await tx.doc(Accepted)).files[agentPath(LEAD)] = file;
	}, context);
	const expected = await before.snapshot(AgentPublications, context);
	await before.close(context);
	const after = await open(home);
	try {
		expect(await after.snapshot(AgentPublications, context)).toEqual(expected);
		expect((await after.snapshot(AgentPublications, context))?.operations["1"]).toMatchObject({
			id: 1,
			name: LEAD,
			file,
			state: { kind: "pending" },
		});
		expect((await after.snapshot(Accepted, context))?.files[agentPath(LEAD)]).toEqual(file);
	} finally {
		await after.close(context);
	}
});

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
		connected.accounts.notes = { "account-1": { id: "account 1", label: "Work", at: 124 } };
		connected.on.reader = { github: ["alice"] };
		connected.off.github__issue_read = "owner";
		connected.off.github__add_comment = "waiting";
		connected.added.github = { at: 99 };
		connected.versions = 5;
		connected.servers.ernesto = {
			service: "Ernesto",
			url: "https://ernesto.example/mcp",
			auth: "oauth",
			scopes: ["mcp"],
			version: 3,
			at: 1,
		};
		connected.reads.github = { tools: ["list_notifications"], version: 5 };
		(await tx.doc(ToolSettings)).set.github__issue_write = "always";
		(await tx.doc(Followed)).objects["github/alice/pull_request:org/repo#7"] = {
			answers: { pr: { head: { sha: "b2" } }, derived: { checks_green: false } },
			at: 455,
			source: "accepted-definition-and-account-generation",
			version: 2,
			earlier: [{ version: 1, answers: { pr: { head: { sha: "a1" } }, derived: { checks_green: true } } }],
			through: 455,
			heldBack: ["checks_green"],
		};
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
		await keepReading(tx, "gmail/me@example.test/search:gmail/search/from%3Aboss", {
			connection: "gmail",
			account: "me@example.test",
			kind: "search",
			source: "accepted-definition-and-account-generation",
			at: 791,
			card: {
				card: "messages",
				title: "mail matching from:boss",
				search: true,
				messages: [{ id: "m1", from: "Boss <boss@example.test>", subject: "Numbers", date: "Mon, 2 Nov 2026" }],
				total: 1,
			},
		});
		await keepReading(tx, "slack/@ana at Acme/thread:slack/C0GENERAL/p1700000000.000100", {
			connection: "slack",
			account: "@ana at Acme",
			kind: "thread",
			source: "accepted-definition-and-account-generation",
			at: 792,
			card: {
				card: "messages",
				title: "#general",
				search: false,
				messages: [
					{
						id: "1700000150.000150",
						from: "@deploybot [bot]",
						subject: "",
						date: "2023-11-14T22:15:50.000Z",
						text: "Done",
					},
				],
				total: 3,
				url: "https://acme.slack.com/archives/C0GENERAL/p1700000000000100",
				service: "slack",
				place: "thread",
			},
		});
		await keepReading(tx, "slack/@ana at Acme/person:slack/user/U0OLGA", {
			connection: "slack",
			account: "@ana at Acme",
			kind: "person",
			source: "accepted-definition-and-account-generation",
			at: 792,
			card: {
				card: "contact",
				name: "Olga Ivanova",
				emails: "",
				phones: "",
				organization: "",
				title: "Partner",
				other: false,
				service: "slack",
				handle: "@olga",
				status: "",
				timezone: "Europe/Berlin",
				outside: true,
			},
		});
	}, context);
	await before.close(context);
	const after = await open(home);
	try {
		expect(await after.snapshot(Connected, context)).toMatchObject({
			epoch: 7,
			accounts: {
				github: { alice: { id: "alice", at: 123 } },
				notes: { "account-1": { id: "account 1", label: "Work", at: 124 } },
			},
			on: { reader: { github: ["alice"] } },
			off: { github__issue_read: "owner", github__add_comment: "waiting" },
			added: { github: { at: 99 } },
			versions: 5,
			servers: {
				ernesto: {
					service: "Ernesto",
					url: "https://ernesto.example/mcp",
					auth: "oauth",
					scopes: ["mcp"],
					version: 3,
					at: 1,
				},
			},
			reads: { github: { tools: ["list_notifications"], version: 5 } },
		});
		expect(await after.snapshot(ToolSettings, context)).toEqual({ set: { github__issue_write: "always" } });
		expect((await after.snapshot(Followed, context))?.objects["github/alice/pull_request:org/repo#7"]).toMatchObject({
			version: 2,
			earlier: [{ version: 1 }],
			heldBack: ["checks_green"],
		});
		expect(await after.snapshot(Connected, context)).toMatchObject({});
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
		expect(
			(await after.snapshot(Readings, context))?.readings["gmail/me@example.test/search:gmail/search/from%3Aboss"],
		).toMatchObject({ card: { card: "messages", search: true, messages: [{ id: "m1", subject: "Numbers" }] } });
		const readings = (await after.snapshot(Readings, context))?.readings ?? {};
		expect(readings["slack/@ana at Acme/thread:slack/C0GENERAL/p1700000000.000100"]).toMatchObject({
			card: { service: "slack", place: "thread", messages: [{ id: "1700000150.000150", text: "Done" }] },
		});
		expect(readings["slack/@ana at Acme/person:slack/user/U0OLGA"]).toMatchObject({
			card: { card: "contact", service: "slack", handle: "@olga", outside: true },
		});
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
		home: "/home/owner/.banda",
		marker: "10-1-uuid",
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

it("reads a wallet's auth/connections credentials as stored: where its key is, never the key, and nothing else", async () => {
	const home = await tempHome();
	const address = checksummed(`0x${"c".repeat(40)}`);
	const shape = {
		wallet: { account: `home-1/wallet/${address}`, address, network: "base-sepolia" },
		revision: "r-1",
		generation: "g-1",
	};
	const dir = join(home, "auth", "connections", WALLET, address.toLowerCase());
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "credentials.json"), JSON.stringify(shape));
	const read = await credentialsOf(home, WALLET, address.toLowerCase());
	expect(read).toEqual(shape);
	expect(walletOf(read)).toEqual(shape.wallet);
	// a file that holds more than a wallet is none, never read as one
	await writeFile(join(dir, "credentials.json"), JSON.stringify({ ...shape, key: "0x01" }));
	expect(walletOf(await credentialsOf(home, WALLET, address.toLowerCase()))).toBeUndefined();
});

it("reopens wallets, their recipients, ledgers, open payments and every signed version as they were stored", async () => {
	const home = await tempHome();
	const wallet = checksummed(`0x${"a".repeat(40)}`);
	const ana = `address:base-sepolia:${checksummed(`0x${"b".repeat(40)}`)}`;
	const weather = `x402:base-sepolia:${checksummed("0x036cbd53842c5426634e7929541ec2318f3dcf7e")}:${checksummed(`0x${"c".repeat(40)}`)}:https://api.weather.example/v1/forecast`;
	const payment: PaymentValue = {
		by: "agent",
		agent: "sancho",
		wallet,
		to: ana,
		amount: "1500000",
		asset: "usdc",
		reserve: "162500000000",
		state: "Sent",
		versions: [
			{
				kind: "pay",
				raw: "0x02f8aa",
				hash: `0x${"1".repeat(64)}`,
				nonce: 6,
				gas: "65000",
				maxFee: "2000000",
				tip: "1000000",
				at: 5,
			},
			{
				kind: "bump",
				raw: "0x02f8ab",
				hash: `0x${"2".repeat(64)}`,
				nonce: 6,
				gas: "65000",
				maxFee: "2250000",
				tip: "1125000",
				at: 6,
			},
			{
				kind: "cancel",
				raw: "0x02f8ad",
				hash: `0x${"5".repeat(64)}`,
				nonce: 6,
				gas: "65000",
				maxFee: "2500000",
				tip: "1250000",
				at: 7,
			},
		],
		nonce: 6,
		foreign: { hash: `0x${"6".repeat(64)}`, at: 3 },
		approvedAt: 4,
		version: 3,
		at: 4,
	};
	const send: PaymentValue = {
		by: "owner",
		wallet,
		to: ana,
		amount: "1",
		asset: "native",
		reserve: "21000",
		state: "Confirmed",
		versions: [
			{
				kind: "pay",
				raw: "0x02f8ac",
				hash: `0x${"4".repeat(64)}`,
				nonce: 5,
				gas: "21000",
				maxFee: "1",
				tip: "1",
				at: 2,
			},
		],
		nonce: 5,
		included: { hash: `0x${"4".repeat(64)}`, block: 8 },
		version: 5,
		at: 2,
	};
	const wallets: WalletsValue = {
		wallets: {
			[wallet]: {
				name: "Groceries",
				network: "base-sepolia",
				state: "ready",
				backup: "unsaved",
				default: "deny",
				disclosed: true,
				request: "create-1",
				reveal: { expires: 600_001, digest: "7".repeat(64) },
				device: true,
				reveals: [
					{ at: 2, kind: "creation" },
					{ at: 3, kind: "later" },
					// a later reveal as the desktop app tells it, by the id its take-back is keyed on
					{ at: 4, kind: "later", id: "5a1b2c3d-0000-4000-8000-000000000004" },
				],
				code: { hash: "6".repeat(64), block: 3, acknowledged: 3 },
				// the owner's act that last moved its state, at the version its commit gave: a retry's test (C21)
				moved: { act: "skip_save", version: 3 },
				version: 4,
				at: 1,
			},
			// an archived wallet, as the owner's archive leaves it: no reveal, the act named
			"0x0000000000000000000000000000000000000002": {
				name: "Holiday",
				network: "base-sepolia",
				state: "archived",
				backup: "saved",
				default: "ask",
				disclosed: false,
				request: "create-2",
				moved: { act: "archive", version: 2 },
				version: 2,
				at: 1,
			},
		},
		recipients: {
			[wallet]: {
				[ana]: { name: "Ana", kind: "address", version: 2, at: 2 },
				[weather]: { kind: "x402", deny: true, version: 3, at: 3 },
			},
		},
		ledger: { [wallet]: { next: 7, frozen: { count: 8, at: 7 }, paused: { at: 7 }, foreign: [6, 7] } },
		open: {},
		recipientVersion: { [wallet]: 3 },
		lease: 2,
		removed: { "0x0000000000000000000000000000000000000001": 1 },
	};
	const refused: PaymentValue = {
		by: "agent",
		agent: "sancho",
		wallet,
		to: weather,
		amount: "10000",
		asset: "usdc",
		reserve: "0",
		state: "Refused",
		reason: "denied",
		versions: [],
		version: 2,
		at: 3,
	};
	track(wallets, "p1", payment, "new");
	track(wallets, "p0", send, "new");
	track(wallets, "p2", refused, "new");
	expect(wallets.open).toEqual({ [wallet]: ["p1"] });
	const incoming = {
		rows: {
			[incomingKey(`0x${"3".repeat(64)}`, 2)]: {
				wallet,
				asset: "usdc" as const,
				amount: "5000000",
				from: `0x${"f".repeat(40)}`,
				block: 9,
			},
			[nativeKey(wallet, 9)]: { wallet, asset: "native" as const, amount: "100", block: 9 },
		},
		cursors: { "base-sepolia": 10 },
		read: { [wallet]: 10 },
		gaps: {
			[wallet]: [
				{ from: 1, to: 4, why: "state" as const },
				{ from: 6, to: 6, why: "unexplained" as const },
				{ from: 7, to: 8, why: "code" as const },
			],
		},
		dropped: { [wallet]: 5 },
	};
	const before = await open(home);
	await before.commit(async (tx) => {
		Object.assign(await tx.doc(Wallets), structuredClone(wallets));
		await tx.doc(Payments, "p1", structuredClone(payment));
		await tx.doc(Payments, "p0", structuredClone(send));
		await tx.doc(Payments, "p2", structuredClone(refused));
		Object.assign(await tx.doc(Incoming), structuredClone(incoming));
	}, context);
	// an open that is not the creating one passes no seed: an existing member opens as it is
	await before.commit(async (tx) => {
		expect((await tx.doc(Payments, "p1", null)).version).toBe(3);
	}, context);
	await before.close(context);
	const after = await open(home);
	try {
		expect(await after.snapshot(Wallets, context)).toEqual(wallets);
		expect(await after.snapshot(Payments, "p1", context)).toEqual(payment);
		expect(await after.snapshot(Payments, "p0", context)).toEqual(send);
		expect(await after.snapshot(Payments, "p2", context)).toEqual(refused);
		expect(await after.snapshot(Incoming, context)).toEqual(incoming);
	} finally {
		await after.close(context);
	}
});

it("keeps a wallet's open payments until they end, the queued ones in queue-commit order (C2)", () => {
	const wallet = checksummed(`0x${"a".repeat(40)}`);
	const other = checksummed(`0x${"b".repeat(40)}`);
	const wallets: WalletsValue = { wallets: {}, recipients: {}, ledger: {}, open: {}, recipientVersion: {} };
	const states = new Map<string, PaymentState>();
	const move = (id: string, state: PaymentState, at = wallet) => {
		track(wallets, id, { wallet: at, state }, states.get(id) ?? "new");
		states.set(id, state);
	};
	// the lane as PaymentLane.tla stores it: its queue, read from `open`
	const lane = (at = wallet) => (wallets.open[at] ?? []).filter((id) => states.get(id) === "Queued");
	move("p1", "Waiting");
	move("p3", "Waiting");
	// Pay appends in the commit that queues: p3 approved before p1 goes first
	move("p3", "Queued");
	move("p1", "Queued");
	expect(lane()).toEqual(["p3", "p1"]);
	// a payment created Queued (an Always covered the call) appends too
	move("p4", "Queued");
	expect(lane()).toEqual(["p3", "p1", "p4"]);
	// a change that keeps it Queued keeps its place
	move("p3", "Queued");
	expect(lane()).toEqual(["p3", "p1", "p4"]);
	// the start commit removes the head; it stays open
	move("p3", "Signed");
	expect(lane()).toEqual(["p1", "p4"]);
	expect(wallets.open[wallet]).toContain("p3");
	// sent back to Waiting and approved again, it appends behind those queued since
	move("p1", "Waiting");
	expect(lane()).toEqual(["p4"]);
	move("p1", "Queued");
	expect(lane()).toEqual(["p4", "p1"]);
	move("p3", "Sent");
	move("p3", "Waiting");
	move("p3", "Queued");
	expect(lane()).toEqual(["p4", "p1", "p3"]);
	move("p5", "Signed", other);
	expect(lane(other)).toEqual([]);
	expect(wallets.open[other]).toEqual(["p5"]);
	move("p4", "Refused");
	move("p1", "Cancelled");
	expect(wallets.open).toEqual({ [wallet]: ["p3"], [other]: ["p5"] });
	move("p3", "Confirmed");
	move("p5", "Failed", other);
	expect(wallets.open).toEqual({});
});

it("opens no payment that was never created: an absent id with no seed throws and stores nothing", async () => {
	const home = await tempHome();
	const store = await open(home);
	try {
		await expect(
			store.commit(async (tx) => {
				await tx.doc(Payments, "stale", null);
			}, context),
		).rejects.toThrow(/^no such payment$/);
		expect(await store.snapshot(Payments, "stale", context)).toBeUndefined();
	} finally {
		await store.close(context);
	}
});

it("names an address in every key by its EIP-55 form", () => {
	const lower = `0x${"ab".repeat(20)}`;
	const wallet = checksummed(lower);
	expect(wallet).not.toBe(lower);
	expect(checksummed(wallet)).toBe(wallet);
	expect(() => checksummed(wallet.replace(/[A-F]/, (c) => c.toLowerCase()))).toThrow(/not an address/);
	expect(nativeKey(lower, 9)).toBe(`native:9:${wallet}`);
});
