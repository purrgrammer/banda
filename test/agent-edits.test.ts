/** An agent's file as the owner edits it from its panel: the name, the face or the body, nothing else. */
import { describe, expect, it } from "vitest";
import { defaultAvatarFace, writeAvatarFace } from "../src/core/avatar-face.ts";
import { edited, withState } from "../web/src/app/edit-file.ts";

const face = defaultAvatarFace();
const changedFace = { ...face, color: "#c79267" };
const FILE = `---\nname: "Mara"\nface: ${writeAvatarFace(face)}\ntools: [read]\n---\nWarm and brief.\n`;

describe("agent edits", () => {
	it("changes the name, the face or the personality, keeping the rest", () => {
		expect(edited(FILE, { name: "Mara Lu" })).toBe(FILE.replace('"Mara"', '"Mara Lu"'));
		expect(edited(FILE, { face: changedFace })).toBe(FILE.replace(writeAvatarFace(face), writeAvatarFace(changedFace)));
		expect(edited(FILE, { personality: "Plans trips.\n\n" })).toBe(FILE.replace("Warm and brief.\n", "Plans trips.\n"));
	});
	it("adds a field the file did not have", () => {
		expect(edited("---\nname: x\n---\nbody\n", { face })).toBe(
			`---\nname: x\nface: ${writeAvatarFace(face)}\n---\nbody\n`,
		);
	});
	it("archives and restores, keeping everything else", () => {
		const archived = withState(FILE, "archived");
		expect(archived).toBe(FILE.replace("---\nWarm", "state: archived\n---\nWarm"));
		expect(withState(archived, "active")).toBe(FILE.replace("---\nWarm", "state: active\n---\nWarm"));
	});
});

describe("an agent's description, which other agents choose it by", () => {
	const description = (text: string) => /^description: (.*)$/m.exec(text)?.[1];

	it("follows the personality the owner rewrites, as the app derived it from the first", async () => {
		const { agentFile } = await import("../web/src/app/edit-file.ts");
		const made = agentFile({ face, name: "Mara" }, "Plans trips: trains and flights. Keeps receipts.");
		expect(description(made)).toBe('"Plans trips: trains and flights"');
		const rewritten = edited(made, { personality: "Keeps the owner's taxes in order. Never late." });
		expect(description(rewritten)).toBe(`"Keeps the owner's taxes in order"`);
		// only the description and the body changed
		expect(rewritten).toBe(
			made
				.replace('"Plans trips: trains and flights"', `"Keeps the owner's taxes in order"`)
				.replace(
					"Plans trips: trains and flights. Keeps receipts.\n",
					"Keeps the owner's taxes in order. Never late.\n",
				),
		);
	});

	it("follows the name while there is no personality, and not once there is one", async () => {
		const { agentFile } = await import("../web/src/app/edit-file.ts");
		const unnamed = agentFile({ face, name: "Otto" }, "");
		expect(description(edited(unnamed, { name: "Otto Lu" }))).toBe('"Otto Lu"');
		const described = agentFile({ face, name: "Otto" }, "Digs in.");
		expect(description(edited(described, { name: "Otto Lu" }))).toBe('"Digs in"');
	});

	it("keeps one written otherwise: an accepted proposal's, or the lead's", async () => {
		const { LEAD_TEXT } = await import("../src/core/agents.ts");
		const proposed = FILE.replace("tools:", "description: Books every trip, end to end\ntools:");
		expect(edited(proposed, { personality: "Short and dry." })).toBe(
			proposed.replace("Warm and brief.\n", "Short and dry.\n"),
		);
		expect(description(edited(LEAD_TEXT, { personality: "Terse." }))).toBe(description(LEAD_TEXT));
	});

	it("leaves the file's bytes alone when only the face changes", async () => {
		const { agentFile } = await import("../web/src/app/edit-file.ts");
		const made = agentFile({ face, name: "Mara" }, "Plans trips.");
		expect(edited(made, { face: changedFace })).toBe(made.replace(writeAvatarFace(face), writeAvatarFace(changedFace)));
	});
});

describe("a new agent's file", () => {
	it("is a valid agent with or without a personality: the owner never writes a description", async () => {
		const { agentFile } = await import("../web/src/app/edit-file.ts");
		const { parseAgent } = await import("../src/core/agents.ts");
		for (const personality of ["", "Curious and careful. Digs in.", "\n\n"]) {
			const parsed = parseAgent("otto", agentFile({ face: changedFace, name: "Otto" }, personality));
			expect(parsed, personality).toHaveProperty("agent.face", changedFace);
		}
	});
});
