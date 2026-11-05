import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, createRegistry, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Accepted, shaOf } from "../src/core/agents.ts";
import { type Inbound, OWNER } from "../src/core/gateway.ts";
import {
	acceptedSkills,
	ownerSkillEntry,
	parseSkill,
	skillsExtension,
	visibleSkillMessages,
} from "../src/core/skills.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { itemOf } from "../src/server/transcript.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

const text = "---\nname: research\ndescription: Gather sources and cite them\n---\n\n# Research\nCite your sources.";
const origin = { gateway: "fake", peer: OWNER };
// as pstack writes one: only the owner's /bro loads it
const bro =
	'---\nname: bro\ndescription: "Restate the last message in plain words."\ndisable-model-invocation: true\n---\n\nSay it plainly.';

async function fixture(
	responses: (request: {
		messages: { role: string; content?: unknown }[];
	}) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
	afterWrite?: () => Promise<void>,
) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const seen: { role: string; content?: unknown }[][] = [];
	faux.setResponses(
		Array.from(
			{ length: 16 },
			() =>
				((request: { messages: { role: string; content?: unknown }[] }) => {
					seen.push(request.messages);
					return responses(request);
				}) as never,
		),
	);
	const gateway = new FakeGateway();
	let harness: Harness;
	const registry = createRegistry();
	const core = defineCore({
		blobs: blobStore(),
		gateway: (name) => (name === gateway.name ? gateway : undefined),
		model: () => FAUX_MODEL,
		tools: () =>
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name),
		writeSkill: async (chat, requestId, entry, ctx) => {
			await (await harness.conversation(chat as ConversationId, ctx))!.submit({ type: "write", requestId, entry }, ctx);
			await afterWrite?.();
		},
	});
	registry.install(core.extension);
	registry.install(skillsExtension);
	harness = await openStore(await tempHome(), { models, registry });
	await harness.commit(async (tx) => {
		const files = (await tx.doc(Accepted)).files;
		files["skills/research/SKILL.md"] = { text, sha: shaOf(text), at: 1 };
		files["skills/bro/SKILL.md"] = { text: bro, sha: shaOf(bro), at: 1 };
	}, context);
	harness.resume();
	async function send(id: string, words: string) {
		const inbound: Inbound = { id, text: words, origin };
		const received = await core.receive(harness, inbound);
		if (!("turn" in received)) throw new Error("message not admitted");
		await harness.waitForTask(received.turn as TaskId, context);
		return received.chat;
	}
	async function entries(chat: number) {
		return (await (await harness.conversation(chat as ConversationId, context))!.entries({}, 100, undefined, context))
			.items;
	}
	return { harness, core, seen, send, entries, gateway };
}

describe("accepted skill loads", () => {
	it("a busy run cannot see an early write; the next request with the owner's input sees the complete load", async () => {
		let written!: () => void;
		const wrote = new Promise<void>((resolve) => {
			written = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let secondSeen!: () => void;
		const nextRequest = new Promise<void>((resolve) => {
			secondSeen = resolve;
		});
		const run = await fixture(
			async () => {
				if (run.seen.length === 1) {
					await wrote;
					return fauxAssistantMessage([fauxToolCall("message_user", { text: "First answered" })], {
						stopReason: "toolUse",
					});
				}
				if (run.seen.length === 2) secondSeen();
				return fauxAssistantMessage("finished");
			},
			async () => {
				written();
				await held;
			},
		);
		try {
			const first = await run.core.receive(run.harness, { id: "busy", text: "First task", origin });
			const second = await run.core.receive(run.harness, { id: "steered", text: "Use /research", origin });
			if (!("turn" in first) || !("turn" in second)) throw new Error("not admitted");
			await nextRequest;
			expect(run.seen[1]?.some((item) => JSON.stringify(item).includes("Cite your sources."))).toBe(false);
			release();
			await run.harness.waitForTask(first.turn as TaskId, context);
			await run.harness.waitForTask(second.turn as TaskId, context);
			const next = run.seen.at(-1)!;
			const loaded = next.findIndex(
				(item) => item.role === "toolResult" && JSON.stringify(item).includes("Cite your sources."),
			);
			expect(loaded).toBeGreaterThan(0);
			expect(next[loaded - 1]?.role).toBe("assistant");
			expect(next.at(-1)?.role).toBe("user");
		} finally {
			release();
			await run.harness.close(context);
		}
	});
	it("hides an already-written round from an earlier model request until its owner input is present", () => {
		const skill = acceptedSkills({ "skills/research/SKILL.md": { text, sha: shaOf(text), at: 1 } })[0]!;
		const loaded = ownerSkillEntry(skill, "skill:fake:first:research", 1, "Use /research");
		const pair = loaded.model;
		const before = [{ role: "user" as const, content: "First task", timestamp: 0 }, ...pair];
		expect(visibleSkillMessages(before).map(({ role }) => role)).toEqual(["user"]);
		const after = [...before, { role: "user" as const, content: "Use /research", timestamp: 2 }];
		expect(visibleSkillMessages(after)).toBe(after);
		expect(
			visibleSkillMessages([...before, { role: "user" as const, content: "Unrelated", timestamp: 2 }]).map(
				({ role }) => role,
			),
		).toEqual(["user", "user"]);
	});
	it("an explicit owner invocation is a complete tool round before its first model request and survives redelivery", async () => {
		const run = await fixture(() =>
			fauxAssistantMessage([fauxToolCall("message_user", { text: "Done" })], { stopReason: "toolUse" }),
		);
		try {
			const chat = await run.send("first", "Please /research today");
			const first = run.seen[0]!;
			expect(first.map(({ role }) => role)).toEqual(["system", "assistant", "toolResult", "user"]);
			expect(JSON.stringify(first[2])).toContain("Cite your sources.");
			const loads = (await run.entries(chat)).filter((entry) => entry.kind === "banda.skill-load");
			expect(loads).toHaveLength(1);
			const loaded = itemOf(loads[0]!);
			expect(loaded?.role).toBe("tool");
			if (loaded?.role !== "tool") throw new Error("not a tool result");
			expect(loaded.receipt).toMatchObject({ kind: "skill", name: "research", by: "owner" });
			await run.send("first", "Please /research today");
			expect((await run.entries(chat)).filter((entry) => entry.kind === "banda.skill-load")).toHaveLength(1);
		} finally {
			await run.harness.close(context);
		}
	});

	it("unknown, quoted and escaped slashes stay text; an agent may load the accepted tool on demand", async () => {
		let n = 0;
		const run = await fixture(() =>
			++n === 1
				? fauxAssistantMessage([fauxToolCall("skill", { name: "research" })], { stopReason: "toolUse" })
				: fauxAssistantMessage([fauxToolCall("message_user", { text: "Done" })], { stopReason: "toolUse" }),
		);
		try {
			const chat = await run.send("second", 'What is `/research`, "/research", \\/research, and /unknown?');
			expect(run.seen[0]!.map(({ role }) => role)).toEqual(["system", "user"]);
			const entries = await run.entries(chat);
			expect(entries.filter((entry) => entry.kind === "banda.skill-load")).toHaveLength(0);
			expect(
				entries.some(
					(entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.model).includes("Cite your sources."),
				),
			).toBe(true);
		} finally {
			await run.harness.close(context);
		}
	});

	it("an owner-only skill is never offered to an agent nor loaded by it, and loads when the owner invokes it", async () => {
		let n = 0;
		const run = await fixture(() =>
			++n === 1
				? fauxAssistantMessage([fauxToolCall("skill", { name: "bro" })], { stopReason: "toolUse" })
				: fauxAssistantMessage([fauxToolCall("message_user", { text: "Done" })], { stopReason: "toolUse" }),
		);
		try {
			const chat = await run.send("agent", "Explain that again");
			const system = JSON.stringify(run.seen[0]![0]);
			expect(system).toContain("research: Gather sources");
			expect(system).not.toContain("bro:");
			const results = (await run.entries(chat)).filter((entry) => entry.kind === "pi.tool-result");
			expect(JSON.stringify(results)).toContain("loaded only when the owner invokes /bro");
			expect(JSON.stringify(results)).not.toContain("Say it plainly.");
			const owned = await run.send("owner", "/bro please");
			const loads = (await run.entries(owned)).filter((entry) => entry.kind === "banda.skill-load");
			expect(JSON.stringify(loads)).toContain("Say it plainly.");
		} finally {
			await run.harness.close(context);
		}
	});
});

describe("the Agent Skills format", () => {
	it("reads quoted, folded and nested frontmatter, keeps other harnesses' fields as data, and knows owner-only", () => {
		const file = [
			"---",
			"name: diagram-design",
			"description: >-",
			"  Create diagrams",
			"  as standalone HTML.",
			"license: MIT",
			'compatibility: "Routes by harness"',
			"metadata:",
			"  author: someone",
			'  version: "2.6"',
			"paths: [docs/**]",
			"disable-model-invocation: false",
			"---",
			"",
			"Body.",
		].join("\n");
		expect(parseSkill("diagram-design", file)).toEqual({
			name: "diagram-design",
			description: "Create diagrams as standalone HTML.",
			path: "skills/diagram-design/SKILL.md",
			body: "\nBody.",
		});
		expect(parseSkill("bro", bro)).toMatchObject({
			description: "Restate the last message in plain words.",
			ownerOnly: true,
		});
		expect(() => parseSkill("bro", bro.replace("true", "yes"))).toThrow("true or false");
		expect(() => parseSkill("bro", bro.replace("name: bro", "name: brother"))).toThrow("must be bro");
		expect(() => parseSkill("bro", bro.replace("description: ", "description: x\ndescription: "))).toThrow("twice");
	});
});
