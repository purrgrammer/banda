import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, createRegistry, type Harness } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LEAD_TEXT, parseAgent } from "../src/core/agents.ts";
import {
	DEFAULT_FACE,
	DEFAULT_PERSONALITY,
	firstEmoji,
	oneEmoji,
	personalityOf,
	personalityWords,
	withPersonality,
} from "../src/core/choices.ts";
import { Companion, nameLine, setCompanion } from "../src/core/companion.ts";

import { type Origin, OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { companion, validPicks } from "../src/server/companion.ts";
import { allowTools, blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";
import { pbtRuns } from "./pbt.ts";

const owner = (thread: string): Origin => ({ gateway: "fake", peer: OWNER, thread });

/** A lead that writes notes for anything. */
function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const respond = (ctx: { messages: readonly { role: string; content: unknown }[] }) => {
		const last = ctx.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
		if (last?.role === "toolResult" || text === undefined) return fauxAssistantMessage("done");
		return fauxAssistantMessage("noted");
	};
	faux.setResponses(Array.from({ length: 50 }, () => respond as never));
	const gateway = new FakeGateway();
	const core = defineCore({ blobs: blobStore(), gateway: () => gateway, model: () => FAUX_MODEL, retryDelay: () => 5 });
	const open = async () => {
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(await tempHome(), { models, registry });
		await allowTools(harness, "reader", ["read"]);
		harness.resume();
		return harness;
	};
	return { core, open };
}

const instructions = (harness: Harness, chat: number) =>
	harness.commit(
		async (tx) => (await tx.doc(AgentDoc, chat as ConversationId)).instructions as string | undefined,
		context,
	);

const lead = (parseAgent("sancho", LEAD_TEXT) as { agent: { instructions: string } }).agent.instructions;

describe("the companion's name", () => {
	it("starts as Sancho without a setup step; renames leave existing prompts intact", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			expect(lead).not.toContain("sancho");
			const before = await s.core.receive(harness, { id: "m1", origin: owner("a"), text: "hi" });
			if (!("turn" in before)) throw new Error(JSON.stringify(before));
			const initial = await instructions(harness, before.chat);
			expect(initial).toBe(`${nameLine("Sancho")}\n\n${lead}`);
			await setCompanion(harness, { name: "Rocinante" });
			expect((await harness.snapshot(Companion, context))?.name).toBe("Rocinante");
			const after = await s.core.receive(harness, { id: "m2", origin: owner("b"), text: "hi" });
			if (!("turn" in after)) throw new Error(JSON.stringify(after));
			expect(await instructions(harness, after.chat)).toBe(`${nameLine("Rocinante")}\n\n${lead}`);
			expect(nameLine("Rocinante")).toBe("Your name is Rocinante. The owner calls you that.");
			expect(initial).not.toMatch(/Your face|react with|body.path/);
			// a rename leaves both prompts byte for byte as they started, so their cached prefixes hold
			await setCompanion(harness, { name: "Dapple" });
			expect(await instructions(harness, before.chat)).toBe(initial);
			expect(await instructions(harness, after.chat)).toBe(`${nameLine("Rocinante")}\n\n${lead}`);
		} finally {
			await harness.close(context);
		}
	});
});

describe("the companion's picks", () => {
	it("defaults to the chat bubble and validates the owner's face pick", async () => {
		const s = setup();
		const harness = await s.open();
		try {
			expect((await companion(harness)).face).toEqual(DEFAULT_FACE);
			expect(DEFAULT_FACE.definition.id).toBe("chat");
			expect(validPicks({ face: { ...DEFAULT_FACE, color: "#ABCDEF" } }).face).toEqual({
				...DEFAULT_FACE,
				color: "#abcdef",
			});
		} finally {
			await harness.close(context);
		}
	});

	it("refuses the old face shape, markup, unknown keys and oversized definitions", () => {
		for (const face of [
			{ emoji: "🦉" },
			"<svg/>",
			{ ...DEFAULT_FACE, svg: "<svg/>" },
			{ ...DEFAULT_FACE, color: "red" },
			{ ...DEFAULT_FACE, definition: { ...DEFAULT_FACE.definition, body: { path: "M".repeat(16_385) } } },
		])
			expect(() => validPicks({ face })).toThrow();
	});

	it("a personality is the lead file's whole body, as any agent's: written, read back, replaced, the frontmatter kept", () => {
		const words = fc
			.string({ minLength: 1, maxLength: 200, unit: "grapheme" })
			.map(personalityWords)
			.filter((each): each is string => typeof each === "string");
		fc.assert(
			fc.property(fc.string(), words, words, (body, first, second) => {
				const text = `---\ndescription: d\n---\n${body}`;
				const once = withPersonality(text, first);
				// a body that is the words already stays byte for byte, as the next test says
				expect(once).toBe(body.trim() === first ? text : `---\ndescription: d\n---\n${first}\n`);
				expect(personalityOf(once)).toBe(first);
				const twice = withPersonality(once, second);
				expect(personalityOf(twice)).toBe(second);
				// writing the same one again changes nothing
				expect(withPersonality(twice, second)).toBe(twice);
			}),
			{ numRuns: pbtRuns(100), examples: [["ref", "ref", "!"]] },
		);
		// the lead starts with its role and the default words, one body with no section of its own
		expect(personalityOf(LEAD_TEXT)).toBe(lead.trim());
		expect(LEAD_TEXT).not.toMatch(/^#/m);
		expect(lead).toMatch(/^You are the owner's lead agent\./);
		expect(lead.trim().endsWith(DEFAULT_PERSONALITY)).toBe(true);
		expect(personalityOf("---\ndescription: d\n---\n")).toBeUndefined();
		expect(personalityOf("---\ndescription: d\n---")).toBeUndefined();
		// a body a home wrote before, its role and a "## Personality" section, is read whole and kept as it is
		const older = `---\ndescription: d\n---\nYou are the lead.\n\n## Personality\nBe dry.\n`;
		expect(personalityOf(older)).toBe("You are the lead.\n\n## Personality\nBe dry.");
		expect(withPersonality(older, personalityOf(older) ?? "")).toBe(older);
		// headings and long bodies are the owner's to write: no section to end, no limit but the file's
		expect(personalityWords("Be brief.\n## Tools\nall")).toBe("Be brief.\n## Tools\nall");
		const long = "Keep this in mind. ".repeat(200).trim();
		expect(long.length).toBeGreaterThan(2000);
		expect(personalityWords(long)).toBe(long);
		expect(personalityOf(withPersonality(LEAD_TEXT, long))).toBe(long);
		// nothing at all is refused
		expect(personalityWords("  \n ")).toEqual({ refused: expect.stringMatching(/few words/) });
		expect(personalityWords("  Warm,\r\nand brief.  ")).toBe("Warm,\nand brief.");
	});

	it("a file whose body already holds the words is left byte for byte, however its spacing falls", () => {
		// the daemon skips a save whose words are the body's already, and the app checks the saved file against its own
		// withPersonality: both must agree it is the file as it was, or the owner sees a conflict nobody made
		const spacing = fc.constantFrom("", "\n", "\n\n", " \n", "\n\n\n");
		fc.assert(
			fc.property(spacing, spacing, spacing, (afterClose, beforeBody, end) => {
				const file = `---\ndescription: d\n---${afterClose === "" ? "\n" : ` ${afterClose}`}${beforeBody}You are the lead.\n\nBe dry.${end}`;
				const words = personalityWords(`${personalityOf(file)} `);
				expect(words).toBe(personalityOf(file));
				expect(withPersonality(file, typeof words === "string" ? words : "")).toBe(file);
			}),
			{ numRuns: pbtRuns(50) },
		);
	});

	it("a reaction is exactly one emoji", () => {
		for (const emoji of ["🫏", "🛡️", "🌾", "👩🏽‍🚀", "🇵🇹", "1️⃣", " 🦉 "]) expect(oneEmoji(emoji)).toBe(emoji.trim());
		for (const text of ["", "a", "🌾🌾", "🌾a", "ab", "1"]) expect(oneEmoji(text)).toBeUndefined();
		expect(firstEmoji("call me 🦉 or 🐢")).toBe("🦉");
		expect(firstEmoji("none")).toBeUndefined();
	});
});
