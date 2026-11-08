import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createRegistry,
	type JsonObject,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Artifacts } from "../src/core/artifacts.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Groups } from "../src/core/groups.ts";
import { Search } from "../src/core/search.ts";
import { searchService } from "../src/core/search-service.ts";
import { searchExtension } from "../src/core/search-tools.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { allowTools, blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

async function fixture() {
	const home = await tempHome();
	const index = new Search(join(home, "search.db"));
	const blobs = blobStore();
	const core = defineCore({ blobs, gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
	const registry = createRegistry();
	registry.install(core.extension);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage("PRIVATE MODEL NOTES")));
	const harness = await openStore(home, { registry, models });
	const service = searchService({ index, blobs, groups: core.groups, harness: () => harness });
	const tools = searchExtension(service).tools! as readonly ToolRegistration[];
	await allowTools(harness, "mara", []);
	await allowTools(harness, "atlas", []);
	const got = await core.receive(harness, {
		id: "seed",
		origin: { gateway: "fake", peer: OWNER },
		text: "Lisbon train booked",
		agent: "mara",
	});
	if (!("chat" in got)) throw new Error("no chat");
	await harness.commit(
		(tx) =>
			tx.appendEntry(got.chat as never, {
				kind: "banda.inbound",
				data: { origin: {}, message: "visible" },
				model: [{ role: "user", content: "Lisbon train booked", timestamp: 1 }],
			}),
		context,
	);
	const room = await core.groups.create(harness, { members: ["mara", "atlas"] });
	const hidden = (await harness.snapshot(Groups, context))!.groups[room]!.executions.mara!.chat;
	const invoke = async (name: string, args: JsonObject, chat = got.chat) => {
		const api = { conversationId: chat, commit: harness.commit.bind(harness) } as ToolExecutionApi;
		return tools.find((tool) => tool.name === name)!.execute(args, api, context);
	};
	return {
		index,
		blobs,
		core,
		harness,
		service,
		room,
		hidden,
		chat: got.chat,
		invoke,
		close: async () => {
			await harness.close(context);
			index.close();
		},
	};
}

describe("band search", () => {
	it("finds other agents' direct chats, excludes memory and hidden chats before limiting, and reads bounded context", async () => {
		const s = await fixture();
		try {
			await s.index.memory(
				{
					list: async () => ["memory/agents/mara.md"],
					read: async () => "- Lisbon secretmemory\n",
					write: async () => {},
				},
				context,
			);
			expect(s.index.rows().filter((row) => row.kind === "fact")).toHaveLength(1);
			// Retired execution chats remain hidden even when no longer in a group's execution roster.
			await s.harness.commit(async (tx) => {
				await tx.appendEntry(s.hidden as never, {
					kind: "banda.inbound",
					data: { origin: {}, message: "hidden" },
					model: [{ role: "user", content: "hidden Lisbon", timestamp: 1 }],
				});
				delete (await tx.doc(Groups)).groups[s.room]!.executions.mara;
				await tx.appendEntry(s.chat as never, {
					kind: "private-note",
					model: [fauxAssistantMessage("PRIVATENOTES Lisbon")],
				});
			}, context);
			expect((await s.service.search({ query: "secretmemory PRIVATENOTES" }, context)).results).toEqual([]);
			const found = await s.service.search({ query: "Lisbon", limit: 1 }, context);
			expect(found.results).toHaveLength(1);
			expect(found.results[0]).toMatchObject({
				kind: "message",
				source: { chat: s.chat },
				excerpt: "Lisbon train booked",
			});
			expect(await s.service.label(found.results[0]!.href, context)).toEqual({
				kind: "message",
				label: "Lisbon train booked",
			});
			expect(await s.service.label("#/a/mara?at=999999", context)).toBeUndefined();
			expect(await s.service.label("https://example.com", context)).toBeUndefined();
			const read = await s.service.read(found.results[0]!.source, 0, context);
			expect(read.text).toContain("Lisbon train booked");
			expect(read.text).not.toContain("hidden");
			await expect(s.service.read({ kind: "message", chat: s.hidden, entry: 1 }, 0, context)).rejects.toThrow(
				"visible",
			);
			await expect(s.invoke("search", { query: "Lisbon" }, 999999)).rejects.toThrow("calling agent");
			expect(JSON.stringify(await s.invoke("search", { query: "Lisbon" }, s.hidden))).toContain("Lisbon train booked");
		} finally {
			await s.close();
		}
	});

	it("indexes shared group messages once, refreshes them without a UI request and reads their context", async () => {
		const s = await fixture();
		try {
			await s.core.groups.post(s.harness, { room: s.room, key: "train", text: "Porto train is confirmed" });
			const pages = await Promise.all(Array.from({ length: 4 }, () => s.service.search({ query: "Porto" }, context)));
			for (const page of pages) expect(page.results).toHaveLength(1);
			const source = pages[0]!.results[0]!.source;
			expect(source).toMatchObject({ kind: "group", room: s.room });
			expect((await s.service.read(source, 0, context)).text).toContain("Porto train is confirmed");
			expect(await s.service.label(pages[0]!.results[0]!.href, context)).toEqual({
				kind: "group",
				label: "Porto train is confirmed",
			});
			expect(s.index.rows().filter((row) => row.kind === "group")).toHaveLength(1);
		} finally {
			await s.close();
		}
	});

	it("paginates ties without duplicates, rejects a mismatched cursor, and filters kinds", async () => {
		const s = await fixture();
		try {
			const text = `Lisbon source ${"x".repeat(15_000)}`;
			const sha = await s.blobs.put(Buffer.from(text));
			await s.harness.commit(async (tx) => {
				const doc = await tx.doc(Artifacts);
				for (let n = 1; n <= 5; n++)
					doc.artifacts[n.toString(16).padStart(16, "0")] = {
						gen: n,
						title: `Plan ${n}`,
						path: `/workspace/${n}.md`,
						mimeType: "text/markdown",
						kind: "markdown",
						chat: s.chat,
						at: 1,
						versions: [{ n: 1, sha, size: text.length, at: 1, by: "owner" }],
						published: {},
						held: sha,
					};
			}, context);
			const stemText = `${"unrelated ".repeat(200)}train departure`;
			const stemSha = await s.blobs.put(Buffer.from(stemText));
			await s.harness.commit(async (tx) => {
				const artifact = (await tx.doc(Artifacts)).artifacts["0000000000000001"]!;
				artifact.versions.push({ n: 2, sha: stemSha, size: stemText.length, at: 2, by: "owner" });
			}, context);
			expect((await s.service.search({ query: "trains", kinds: ["artifact"] }, context)).results[0]?.excerpt).toContain(
				"train departure",
			);
			await s.harness.commit(async (tx) => {
				(await tx.doc(Artifacts)).artifacts["0000000000000001"]!.versions.pop();
			}, context);
			const seen: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await s.service.search(
					{ query: "Lisbon", kinds: ["artifact"], limit: 2, ...(cursor ? { cursor } : {}) },
					context,
				);
				seen.push(...page.results.map((result) => JSON.stringify(result.source)));
				for (const result of page.results) expect(result.excerpt.length).toBeLessThanOrEqual(802);
				cursor = page.nextCursor;
			} while (cursor);
			expect(seen).toHaveLength(5);
			expect(new Set(seen).size).toBe(5);
			const first = await s.service.search({ query: "Lisbon", limit: 1 }, context);
			await expect(s.service.search({ query: "Porto", cursor: first.nextCursor! }, context)).rejects.toThrow(
				"different search",
			);
			const source = { kind: "artifact" as const, id: "0000000000000001" };
			expect(await s.service.label("#/artifact/0000000000000001", context)).toEqual({
				kind: "artifact",
				label: "Plan 1",
			});
			const read = await s.service.read(source, 0, context);
			expect(read.text).toHaveLength(12_000);
			expect(read.nextOffset).toBe(12_000);
			expect((await s.service.read(source, read.nextOffset!, context)).text).toBe(`Plan 1\n${text}`.slice(12_000));
			await s.harness.commit(async (tx) => {
				(await tx.doc(Artifacts)).artifacts = {};
			}, context);
			expect((await s.service.search({ query: "Lisbon", kinds: ["artifact"] }, context)).results).toEqual([]);
			expect(await s.service.label("#/artifact/0000000000000001", context)).toBeUndefined();
			await expect(s.service.read(source, 0, context)).rejects.toThrow("no longer available");
		} finally {
			await s.close();
		}
	});

	it("property: only permitted sources compete for a limited page", async () => {
		const index = new Search(join(await tempHome(), "search.db"));
		try {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 30 }), (hidden, limit) => {
					index.rebuild();
					index.groupLines(
						99,
						Array.from({ length: hidden }, (_, n) => ({ entry: n + 1, who: "owner", text: "Lisbon", at: n })),
					);
					index.groupLines(1, [{ entry: 1, who: "owner", text: "Lisbon visible source", at: 1 }]);
					expect(index.find("Lisbon", limit, ["group"], { paths: [], chats: [], rooms: [1] })).toEqual([
						expect.objectContaining({ room: 1 }),
					]);
				}),
				{ numRuns: pbtRuns(30) },
			);
		} finally {
			index.close();
		}
	});
});
