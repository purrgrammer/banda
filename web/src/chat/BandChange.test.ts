import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { BandChangeCard, BandChangeRow, changedWords } from "./BandChange.tsx";

const face = defaultAvatarFace();

describe("what an agent made or changed in the band", () => {
	it("draws a new agent as a row linking its chat, and a card that says what is the owner's to give", () => {
		const receipt = {
			kind: "agent" as const,
			change: "created" as const,
			id: "writer",
			agent: {
				name: "Writer",
				face,
				description: "Writes drafts",
				instructions: "Write clearly.",
				tier: "deep" as const,
			},
		};
		const row = renderToStaticMarkup(createElement(BandChangeRow, { receipt }));
		expect(row).toContain('href="#/a/writer"');
		expect(row).toContain("Created");
		expect(row).toContain("Writer");
		expect(row).not.toContain("Accept");
		const card = renderToStaticMarkup(createElement(BandChangeCard, { receipt }));
		expect(card).toContain("New agent: Writer");
		expect(card).toContain("Write clearly.");
		expect(card).toContain("yours to give");
		expect(card).toContain("Default model · Deep");
		expect(card).toContain("Open Writer");
		expect(card).not.toContain("<button");
	});

	it("draws an update with each changed field as it was, and a group with its members", () => {
		const receipt = {
			kind: "agent" as const,
			change: "updated" as const,
			id: "atlas",
			agent: { name: "Atlas", face, description: "Checks fares.", instructions: "Compare and report." },
			before: {
				description: "Tracks dates.",
				instructions: "Compare.",
				model: { provider: "openai", modelId: "gpt-6.1-sol" },
			},
		};
		expect(changedWords(receipt)).toBe("description, instructions and model");
		const card = renderToStaticMarkup(createElement(BandChangeCard, { receipt }));
		expect(card).toContain("Updated Atlas");
		expect(card).toContain("Tracks dates.");
		expect(card).toContain("Checks fares.");
		expect(card).toContain("Compare.");
		expect(card).toContain("Compare and report.");
		expect(card).toContain("didn’t change");
		expect(card).toContain("openai/gpt-6.1-sol");
		expect(card).toContain("Default model");
		const group = renderToStaticMarkup(
			createElement(BandChangeRow, {
				receipt: {
					kind: "group",
					room: 12,
					name: "Research",
					members: [
						{ id: "a", name: "Mara" },
						{ id: "b", name: "Atlas" },
					],
				},
			}),
		);
		expect(group).toContain('href="#/g/12"');
		expect(group).toContain("Research");
		expect(group).toContain("Mara, Atlas");
	});
});
