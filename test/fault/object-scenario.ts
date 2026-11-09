import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { Accepted, AgentChats, shaOf } from "../../src/core/agents.ts";
import { Connected } from "../../src/core/connections.ts";
import { MAX_READINGS, type Reading, Readings } from "../../src/core/objects.ts";
import { context, openStore } from "../../src/core/store.ts";
import { openObjects } from "../../src/server/objects.ts";
import type { Faults } from "./faults.ts";

export type ObjectScenario = { count: number; failed: boolean; revoke: boolean };
export type ObjectSummary = {
	readings: Record<string, Reading>;
	calls: { tool: string; account: string; number: number }[];
	commits: number;
	points: Record<string, number>;
	denied: boolean;
};
/** Same scenario/invariants for thrown faults and subprocess kills; only the remote read is a deterministic double. */
export async function objectScenario(home: string, scenario: ObjectScenario, faults: Faults): Promise<ObjectSummary> {
	const harness = await openStore(home, {
		models: createModels(),
		registry: createRegistry(),
		wrapStorage: (s) => faults.storage(s),
	});
	try {
		const kind = {
			card: "issue",
			name: "{owner}/{repo} #{number}",
			urls: [],
			ids: ["{owner}/{repo}#{number}"],
			reads: { issue: { tool: "get", args: { number: "{number}" } } },
			fields: { title: "issue.title", state: "issue.state" },
		};
		const text = `---\nservice: Example\nurl: https://example.com/mcp\nauth: key\nreads: [get]\n---\n\`\`\`json\n${JSON.stringify({ objects: { issue: kind } })}\n\`\`\`\n`;
		await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			if (accepted.files["connections/example.md"] !== undefined) return;
			accepted.files["connections/example.md"] = { sha: shaOf(text), text, at: 1 };
			const agent = "---\nname: Reader\ndescription: Reads objects\nconnections: [example]\n---\nRead.";
			accepted.files["agents/reader.md"] = { sha: shaOf(agent), text: agent, at: 1 };
			(await tx.doc(AgentChats)).chats[1] = "reader";
			const connected = await tx.doc(Connected);
			connected.connections.example = {
				version: shaOf(text),
				at: 1,
				tools: {
					get: { description: "read", schema: { type: "object", properties: { number: { type: "integer" } } } },
				},
			};
			connected.accounts.example = { alice: { id: "alice", at: 1 }, bob: { id: "bob", at: 2 } };
			connected.on.reader = { example: ["alice", "bob"] };
		}, context);
		const revokeAlice = () =>
			harness.commit(async (tx) => {
				const c = await tx.doc(Connected);
				c.on.reader = { example: ["bob"] };
				delete c.accounts.example?.alice;
				const r = await tx.doc(Readings);
				for (const [key, value] of Object.entries(r.readings)) if (value.account === "alice") delete r.readings[key];
			}, context);
		let revokedDuringRead = false;
		const service = openObjects({
			harness,
			now: () => 100,
			fault: (p) => faults.hit(p as "object:answered" | "object:kept"),
			capabilities: {
				shipped: async () => [],
				listedSchema: async () => ({ type: "object", properties: { number: { type: "integer" } } }),
				readFor: async (_connection, account, tool, args) => {
					faults.hit("object:read");
					appendFileSync(
						join(home, "object-calls.jsonl"),
						`${JSON.stringify({ tool, account, number: args.number })}\n`,
					);
					if (scenario.revoke && account === "alice" && args.number === scenario.count) {
						await revokeAlice();
						revokedDuringRead = true;
					}
					return scenario.failed && args.number === 2
						? { failed: "unavailable" }
						: { text: JSON.stringify({ title: `${account} ${args.number}`, state: "open" }) };
				},
			},
		});
		let denied = true;
		for (const account of ["alice", "bob"]) {
			for (let n = 1; n <= scenario.count; n += 3) {
				const asks = Array.from({ length: Math.min(3, scenario.count - n + 1) }, (_, i) => ({
					refs: [`a/b#${n + i}`],
					account,
				}));
				const shown = await service.show(1, asks);
				if (account === "alice" && revokedDuringRead && shown.some((one) => one.shown === "card")) denied = false;
			}
		}
		if (scenario.revoke) {
			await revokeAlice();
			denied &&= (await service.show(1, [{ refs: ["a/b#1"], account: "alice" }]))[0]?.shown !== "card";
		}
		const readings = (await harness.snapshot(Readings, context))?.readings ?? {};
		const calls = readFileSync(join(home, "object-calls.jsonl"), { encoding: "utf8", flag: "a+" })
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ObjectSummary["calls"][number]);
		return {
			readings,
			calls,
			denied,
			commits: faults.hits("commit:after"),
			points: Object.fromEntries(
				["object:read", "object:answered", "object:kept"].map((p) => [p, faults.hits(p as "object:read")]),
			),
		};
	} finally {
		await harness.close(context).catch(() => {});
	}
}
/** Shared invariants deliberately independent of process count or duplicate reads after a crash. */
export function objectProblems(summary: ObjectSummary, scenario: ObjectScenario): string[] {
	const errors: string[] = [];
	const readings = Object.entries(summary.readings);
	if (!summary.denied) errors.push("revoked account was shown");
	if (readings.length > MAX_READINGS) errors.push("unbounded readings");
	if (readings.length !== (scenario.revoke ? 1 : 2) * scenario.count) errors.push("lost final reading");
	for (const [key, r] of readings) {
		if (!key.startsWith(`example/${r.account}/`)) errors.push("account cross-talk");
		if (scenario.revoke && r.account === "alice") errors.push("signed-out reading resurrected");
		if (r.card !== undefined && (r.card.card !== "issue" || !r.card.title.startsWith(r.account)))
			errors.push("wrong account bytes");
		if (r.failed !== undefined && r.card !== undefined) errors.push("fabricated card on failure");
	}
	if (
		summary.calls.some(
			(c) => c.tool !== "get" || !["alice", "bob"].includes(c.account) || c.number < 1 || c.number > scenario.count,
		)
	)
		errors.push("unadmitted effect");
	return errors;
}
