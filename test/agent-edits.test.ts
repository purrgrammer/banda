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
