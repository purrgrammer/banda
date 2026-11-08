import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { Accepted, AgentChats, shaOf } from "../src/core/agents.ts";
import { BlobStore, Blobs } from "../src/core/blobs.ts";
import { Connected } from "../src/core/connections.ts";
import { cardOf, Readings } from "../src/core/objects.ts";
import { context } from "../src/core/store.ts";
import { openObjects } from "../src/server/objects.ts";
import { openConnected } from "./fixtures/connected.ts";
import { added, definition as shipped, shippedText, shipping } from "./fixtures/shipped.ts";
import { tempHome } from "./helpers.ts";

const opened: Awaited<ReturnType<typeof openConnected>>[] = [];
afterEach(async () => {
	for (const connected of opened.splice(0)) await connected.close();
});

it("fetches only an attachment named by the same authorized Gmail message and holds its blob", async () => {
	const home = await tempHome();
	const connected = await openConnected({ home, respond: () => fauxAssistantMessage("done") });
	opened.push(connected);
	const blobs = new BlobStore(join(home, "blobs"));
	const definition = shippedText("gmail");
	const parsed = { connection: shipped("gmail", definition) };
	shipping(parsed.connection);
	const emailKind = parsed.connection.objects?.email;
	if (emailKind === undefined) throw new Error("no email object");
	let chat = 0;
	expect(() =>
		cardOf(
			emailKind,
			{ connection: "gmail", kind: "email", values: { id: "msg_1" } },
			{
				message: {
					from: "Ana <ana@example.test>",
					to: "alice@example.test",
					subject: "Notes",
					date: "today",
					snippet: "Attached",
					body: "See notes",
					unread: true,
					attachments: [{ id: "att_1", name: "notes.txt", mimeType: "text/plain", size: 5 }],
				},
			},
		),
	).not.toThrow();
	const agent = "---\nname: Reader\ndescription: Reads Gmail\nstate: active\nconnections: [gmail]\n---\nReader";
	await connected.harness.commit(async (tx) => {
		await added(tx, "gmail");
		(await tx.doc(Accepted)).files["agents/reader.md"] = { text: agent, sha: shaOf(agent), at: 1 };
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		chat = Number(conversation.id);
		(await tx.doc(AgentChats)).chats[chat] = "reader";
		const store = await tx.doc(Connected);
		store.connections.gmail = {
			version: shaOf(definition),
			at: 1,
			tools: {
				get_profile: { description: "profile", schema: { type: "object" } },
				search_messages: { description: "search", schema: { type: "object" } },
				get_message: {
					description: "message",
					schema: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
				},
				get_thread: { description: "thread", schema: { type: "object" } },
			},
		};
		store.accounts.gmail = { alice: { id: "alice@example.test", at: 1 }, bob: { id: "bob@example.test", at: 1 } };
		store.on.reader = { gmail: ["alice"] };
	}, context);
	let fetched = 0;
	const service = openObjects({
		harness: connected.harness,
		blobs,
		capabilities: {
			shipped: async () => [parsed.connection],
			listedSchema: async () => ({ type: "object", properties: { message_id: { type: "string" } } }),
			readFor: async () => ({
				text: JSON.stringify({
					from: "Ana <ana@example.test>",
					to: "alice@example.test",
					subject: "Notes",
					date: "today",
					snippet: "Attached",
					body: "See notes",
					unread: true,
					attachments: [{ id: "att_1", name: "notes.txt", mimeType: "text/plain", size: 5 }],
				}),
			}),
			readAttachment: async () => {
				fetched++;
				return { bytes: Buffer.from("notes") };
			},
		},
	});
	const ref = "gmail/msg_1";
	const card = (await service.show(chat, [{ ref, agent: "reader" }]))[0];
	expect(card).toMatchObject({ shown: "card" });
	const denied = await service.attachment(chat, ref, "att_other", "reader", "alice");
	expect(denied).toBeUndefined();
	expect(fetched).toBe(0);
	const file = await service.attachment(chat, ref, "att_1", "reader", "alice");
	expect(file).toMatchObject({ name: "notes.txt", size: 5 });
	expect(file?.sha).toMatch(/^[0-9a-f]{64}$/);
	expect(await blobs.read(file!.sha)).toEqual(Buffer.from("notes"));
	expect((await connected.harness.snapshot(Blobs, context))?.blobs[file!.sha]?.holders[String(chat)]?.from).toBe(
		"connection",
	);
	const reading = Object.values((await connected.harness.snapshot(Readings, context))?.readings ?? {}).find(
		(each) => each.account === "alice",
	);
	expect(reading?.card?.card).toBe("email");
	if (reading?.card?.card === "email") expect(reading.card.attachmentManifest).toContain(file!.sha);
	expect(fetched).toBe(1);
	await connected.capabilities.signOut("gmail", "alice");
	expect((await connected.harness.snapshot(Blobs, context))?.blobs[file!.sha]?.holders["1"]).toBeUndefined();
});

it("fetches a file only when a Slack thread's card shows it, at most 10 MB, and the chat holds its blob", async () => {
	const home = await tempHome();
	const connected = await openConnected({ home, respond: () => fauxAssistantMessage("done") });
	opened.push(connected);
	const blobs = new BlobStore(join(home, "blobs"));
	const definition = await readFile(new URL("../shipped/connections/slack.md", import.meta.url), "utf8");
	const parsed = parseConnection("slack", definition);
	if (!("connection" in parsed)) throw new Error(JSON.stringify(parsed));
	let chat = 0;
	const agent = "---\nname: Reader\ndescription: Reads Slack\nstate: active\nconnections: [slack]\n---\nReader";
	const schema = (properties: string[]) => ({
		type: "object",
		properties: Object.fromEntries(properties.map((each) => [each, { type: "string" }])),
	});
	await connected.harness.commit(async (tx) => {
		(await tx.doc(Accepted)).files["connections/slack.md"] = { text: definition, sha: shaOf(definition), at: 1 };
		(await tx.doc(Accepted)).files["agents/reader.md"] = { text: agent, sha: shaOf(agent), at: 1 };
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		chat = Number(conversation.id);
		(await tx.doc(AgentChats)).chats[chat] = "reader";
		const store = await tx.doc(Connected);
		store.connections.slack = {
			sha: shaOf(definition),
			at: 1,
			tools: Object.fromEntries(
				parsed.connection.reads.map((tool) => [tool, { description: tool, schema: schema(["channel", "ts"]) }]),
			),
		};
		store.accounts.slack = { ana: { id: "@ana at Acme", at: 1 } };
		store.on.reader = { slack: ["ana"] };
	}, context);
	const fetched: string[] = [];
	const message = (ts: string, text: string, files?: unknown[]) => ({
		ts,
		from: "@bob",
		author: "@bob at Acme",
		user: "U0BOB",
		text,
		date: "2023-11-14T22:13:20.000Z",
		mentions_me: false,
		...(files === undefined ? {} : { files }),
	});
	const service = openObjects({
		harness: connected.harness,
		blobs,
		capabilities: {
			shipped: async () => [parsed.connection],
			listedSchema: async () => schema(["channel", "ts"]),
			readFor: async () => ({
				text: JSON.stringify({
					channel: "C0GENERAL",
					channel_name: "general",
					root: "1700000000.000100",
					messages: [
						message("1700000000.000100", "Release notes draft"),
						message("1700000160.000160", "the log", [
							{ id: "F0LOG", name: "deploy-41.log", size: 5, mimetype: "text/plain" },
							{ id: "F0BIG", name: "dump.bin", size: 11 * 1024 * 1024, mimetype: "application/octet-stream" },
						]),
					],
					total: 2,
				}),
			}),
			readSlackFile: async (_account, fileId) => {
				fetched.push(fileId);
				return { bytes: Buffer.from("hello"), name: "deploy-41.log" };
			},
		},
	});
	const shown = (await service.show(chat, [{ ref: "slack/C0GENERAL/p1700000000000100", agent: "reader" }]))[0];
	if (shown?.shown !== "card" || shown.card.card !== "messages") throw new Error(JSON.stringify(shown));
	expect(shown.card.messages.find((each) => each.id === "1700000160.000160")?.files).toEqual([
		{ id: "F0LOG", name: "deploy-41.log", size: 5 },
		{ id: "F0BIG", name: "dump.bin", size: 11 * 1024 * 1024 },
	]);
	// the app names the object by its card's own id
	const ref = shown.key.split(":").slice(2).join(":");
	expect(await service.attachment(chat, ref, "F0OTHER", "reader", "ana")).toBeUndefined();
	await expect(service.attachment(chat, ref, "F0BIG", "reader", "ana")).rejects.toThrow(
		"dump.bin is larger than 10 MB.",
	);
	expect(fetched).toEqual([]);
	const file = await service.attachment(chat, ref, "F0LOG", "reader", "ana");
	expect(file).toMatchObject({ name: "deploy-41.log", size: 5 });
	expect(await blobs.read(file!.sha)).toEqual(Buffer.from("hello"));
	expect((await connected.harness.snapshot(Blobs, context))?.blobs[file!.sha]?.holders[String(chat)]).toMatchObject({
		from: "connection",
		connection: "slack",
		account: "ana",
	});
	expect(fetched).toEqual(["F0LOG"]);
});
