import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { linkMentions, mentionQuery, mentionsIn } from "../web/src/lib/mentions.ts";
import type { ChatAgent } from "../web/src/lib/navigation.ts";
import { pbtRuns } from "./pbt.ts";

const face = defaultAvatarFace();
const writer: ChatAgent = { id: "writer", name: "Writer", face };
const researcher: ChatAgent = { id: "researcher", name: "Researcher", face };

describe("mentions in the composer", () => {
	it("offers agents only for an @ word just before the caret", () => {
		expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
		expect(mentionQuery("hi @Wr", 6)).toEqual({ start: 3, query: "Wr" });
		expect(mentionQuery("hi @Wr there", 12)).toBeUndefined();
		expect(mentionQuery("mail@example", 12)).toBeUndefined();
	});

	it("asks only agents picked whose mention is still in the text, each once", () => {
		expect(mentionsIn("@Writer and @Researcher", [writer, researcher])).toEqual(["writer", "researcher"]);
		expect(mentionsIn("@Writer then @Writer", [writer, writer])).toEqual(["writer"]);
		// typed by hand, never picked: not a mention
		expect(mentionsIn("@Researcher", [writer])).toEqual([]);
		// picked, then deleted from the text
		expect(mentionsIn("never mind", [writer])).toEqual([]);
	});

	it("never asks an agent that was not picked, whatever the text", () => {
		fc.assert(
			fc.property(fc.string(), fc.subarray([writer, researcher]), (text, picked) => {
				const asked = mentionsIn(text, picked);
				expect(asked.every((id) => picked.some((agent) => agent.id === id))).toBe(true);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});

	it("draws as chips only the agents a message asked, longest name first; other @s stay words", () => {
		const ana: ChatAgent = { id: "ana", name: "Ana", face };
		const analu: ChatAgent = { id: "analu", name: "Ana Lu", face };
		const agents = [writer, researcher, ana, analu];
		expect(linkMentions("@Writer go", ["writer"], agents)).toBe("[@Writer](#/a/writer) go");
		// named, but not asked: words
		expect(linkMentions("@Researcher no", ["writer"], agents)).toBe("@Researcher no");
		expect(linkMentions("hi @Ana Lu!", ["ana", "analu"], agents)).toBe("hi [@Ana Lu](#/a/analu)!");
		expect(linkMentions("mail@Writer", ["writer"], agents)).toBe("mail@Writer");
		expect(linkMentions("@Writers", ["writer"], agents)).toBe("@Writers");
		// whatever the case it was typed in, under the agent's own name
		expect(linkMentions("@writer go", ["writer"], agents)).toBe("[@Writer](#/a/writer) go");
	});
});

describe("mentions whatever the case", () => {
	it("asks the agent named in any case, as a whole name only", () => {
		const mara = { id: "mara", name: "Mara", face: { ...face, color: "#c79267" } };
		expect(mentionsIn("@mara how unoriginal", [mara])).toEqual(["mara"]);
		expect(mentionsIn("@MARA go", [mara])).toEqual(["mara"]);
		expect(mentionsIn("@marathon", [mara])).toEqual([]);
	});
});

describe("a group message's mentions, shown", () => {
	const agents = [
		{ id: "sancho", name: "Sancho" },
		{ id: "rosa", name: "Rosa" },
	];
	it("stand at the @Name, else at the name as a word, else before the words; once, whatever the case", async () => {
		const { mentionParts } = await import("../web/src/lib/mentions.ts");
		expect(mentionParts("@rosa I checked it", ["rosa"], agents)).toEqual([
			{ mention: "rosa" },
			{ text: " I checked it" },
		]);
		expect(mentionParts("Sancho, send me the forecast", ["sancho"], agents)).toEqual([
			{ mention: "sancho" },
			{ text: ", send me the forecast" },
		]);
		expect(mentionParts("Can you do it?", ["rosa"], agents)).toEqual([
			{ mention: "rosa" },
			{ text: " " },
			{ text: "Can you do it?" },
		]);
		// a name inside another word is no mention, and one not asked is left as words
		expect(mentionParts("Rosalind and Sancho", ["rosa"], agents)).toEqual([
			{ mention: "rosa" },
			{ text: " " },
			{ text: "Rosalind and Sancho" },
		]);
	});
});
