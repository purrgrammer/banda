import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { Accepted, AgentChats, shaOf } from "../../src/core/agents.ts";
import { defaultAvatarFace } from "../../src/core/avatar-face.ts";
import { BlobStore, Blobs } from "../../src/core/blobs.ts";
import { Connected, parseConnection } from "../../src/core/connections.ts";
import { Readings } from "../../src/core/objects.ts";
import { context, openStore } from "../../src/core/store.ts";
import { openObjects } from "../../src/server/objects.ts";
import { type Fault, Faults } from "./faults.ts";

const [home, schedule] = process.argv.slice(2) as [string, string];
const faults = new Faults(JSON.parse(schedule) as Fault[]);
const definition = await readFile(new URL("../../shipped/connections/gmail.md", import.meta.url), "utf8");
const parsed = parseConnection("gmail", definition);
if (!("connection" in parsed)) throw new Error(JSON.stringify(parsed));
const message = {
	from: "Ana <ana@example.test>",
	to: "alice@example.test",
	subject: "Notes",
	date: "today",
	snippet: "Attached",
	body: "See notes",
	unread: true,
	url: "https://mail.google.com/mail/u/0/#all/msg_1",
	attachments: [{ id: "att_1", name: "notes.txt", mimeType: "text/plain", size: 5 }],
};
let summary: unknown;
for (let attempt = 0; attempt < 4; attempt++) {
	const harness = await openStore(home, {
		models: createModels(),
		registry: createRegistry(),
		wrapStorage: (storage) => faults.storage(storage),
	});
	try {
		const chat = await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			const connected = await tx.doc(Connected);
			const agent = `---\nname: Reader\ndescription: Reads Gmail\nface: ${JSON.stringify(defaultAvatarFace())}\nstate: active\nconnections: [gmail]\n---\nReader`;
			let found = Number(
				Object.entries((await tx.doc(AgentChats)).chats).find(([, name]) => name === "reader")?.[0] ?? 0,
			);
			if (found === 0) {
				found = Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
				(await tx.doc(AgentChats)).chats[found] = "reader";
			}
			accepted.files["connections/gmail.md"] ??= { text: definition, sha: shaOf(definition), at: 1 };
			accepted.files["agents/reader.md"] ??= { text: agent, sha: shaOf(agent), at: 1 };
			connected.connections.gmail ??= {
				sha: shaOf(definition),
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
			connected.accounts.gmail ??= { alice: { id: "alice@example.test", at: 1 } };
			connected.on.reader ??= { gmail: ["alice"] };
			return found;
		}, context);
		const blobs = new BlobStore(join(home, "blobs"));
		const service = openObjects({
			harness,
			blobs,
			fault: (point) => faults.hit(point as never),
			capabilities: {
				shipped: async () => [parsed.connection],
				listedSchema: async () => ({ type: "object", properties: { message_id: { type: "string" } } }),
				readFor: async () => ({ text: JSON.stringify(message) }),
				readAttachment: async () => ({ bytes: Buffer.from("notes") }),
			},
		});
		const url = message.url;
		const shown = (await service.show(chat, [{ ref: url, agent: "reader" }]))[0];
		const file = await service.attachment(chat, url, "att_1", "reader", "alice");
		const reading = Object.values((await harness.snapshot(Readings, context))?.readings ?? {}).find(
			(each) => each.account === "alice",
		);
		const blob = file === undefined ? undefined : (await harness.snapshot(Blobs, context))?.blobs[file.sha];
		summary = {
			shown: shown?.shown,
			file,
			bytes: file === undefined ? undefined : (await blobs.read(file.sha).catch(() => undefined))?.toString("utf8"),
			hold: file === undefined ? undefined : blob?.holders[String(chat)],
			manifest: reading?.card?.card === "email" ? reading.card.attachmentManifest : undefined,
			commits: faults.hits("commit:after"),
			points: Object.fromEntries(
				[
					"object:attachment:read",
					"object:attachment:received",
					"object:attachment:stored",
					"object:attachment:kept",
				].map((point) => [point, faults.hits(point as never)]),
			),
		};
		break;
	} catch (error) {
		if (attempt === 3) throw error;
	} finally {
		await harness.close(context).catch(() => {});
	}
}
console.log(JSON.stringify(summary));
