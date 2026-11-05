/**
 * A home made by an earlier build opens in this one: a stored doc whose shape a rename changed is migrated by its
 * definition's version, never read as missing. Each case writes the earlier shape with that version's definition,
 * closes the store, and reads it back through today's.
 */
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { LEAD } from "../src/core/agents.ts";
import { Connected } from "../src/core/connections.ts";
import { keepReading, Readings } from "../src/core/objects.ts";
import { Permissions } from "../src/core/permissions.ts";
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
