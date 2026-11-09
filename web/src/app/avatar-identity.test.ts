import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAgent } from "../../../src/core/agents.ts";
import { defaultAvatarFace, readAvatarFace, writeAvatarFace } from "../../../src/core/avatar-face.ts";
import { SHAPES } from "../avatar/choices.ts";
import { changeCompanion, saveAgent } from "../lib/api.ts";
import { withoutFace } from "./agent-preview.ts";
import { whoOf } from "./band.ts";
import { agentFile, edited } from "./edit-file.ts";
import { saveEdit } from "./edits.ts";

vi.mock("../lib/api.ts", () => ({ changeCompanion: vi.fn(), saveAgent: vi.fn() }));

const face = {
	definition: SHAPES.find((shape) => shape.id === "sprout")?.definition ?? defaultAvatarFace().definition,
	color: "#123456",
};
const original = agentFile({ name: "Otto", face: defaultAvatarFace() }, "Keep things clear.");

describe("avatar identity through the owner's APIs", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps gallery definitions canonical so a saved selection is still selected on reopening", () => {
		for (const shape of SHAPES) {
			const picked = { definition: shape.definition, color: face.color };
			expect(readAvatarFace(writeAvatarFace(picked))).toEqual({ ok: true, face: picked });
		}
	});

	it("creates an agent with the selected shape and custom colour, not a gallery reference", () => {
		const file = agentFile({ name: "Otto", face }, "Keep things clear.");
		const parsed = parseAgent("otto", file);
		if ("errors" in parsed) throw new Error(parsed.errors.join(", "));
		expect(parsed.agent.face).toEqual(face);
		expect(file).toContain(`face: ${writeAvatarFace(face)}\n`);
	});

	it("edits shape and colour together while keeping unrelated fields and personality", () => {
		const next = edited(original, { face });
		const parsed = parseAgent("otto", next);
		if ("errors" in parsed) throw new Error(parsed.errors.join(", "));
		expect(parsed.agent.face).toEqual(face);
		expect(withoutFace(next)).toBe(withoutFace(original));
		expect(edited(next, { name: "Otto renamed" })).toContain(`face: ${writeAvatarFace(face)}`);
	});

	it("binds the first agent's face to the accepted revision the owner observed", async () => {
		await saveEdit(
			"sancho",
			{ face },
			[{ name: "sancho", accepted: { text: original, sha: "observed-sha" } }],
			undefined,
		);
		expect(changeCompanion).toHaveBeenCalledExactlyOnceWith({ face, base: "observed-sha" });
		expect(saveAgent).not.toHaveBeenCalled();
	});

	it("does not submit a face without an observed accepted revision", async () => {
		await expect(saveEdit("sancho", { face }, [], undefined)).rejects.toThrow("not in effect yet");
		expect(changeCompanion).not.toHaveBeenCalled();
	});

	it("writes another agent's selected face bound to its accepted file version", async () => {
		await saveEdit("otto", { face }, [{ name: "otto", accepted: { text: original, sha: "accepted-sha" } }], undefined);
		expect(saveAgent).toHaveBeenCalledExactlyOnceWith("otto", edited(original, { face }), "accepted-sha");
		expect(changeCompanion).not.toHaveBeenCalled();
	});

	it("publishes the accepted file returned by a save before the next queued edit", async () => {
		const updated = [{ name: "otto", accepted: { text: edited(original, { face }), sha: "new-sha" } }];
		vi.mocked(saveAgent).mockResolvedValueOnce(updated);
		const onSaved = vi.fn();
		await saveEdit(
			"otto",
			{ face },
			[{ name: "otto", accepted: { text: original, sha: "old-sha" } }],
			undefined,
			onSaved,
		);
		expect(onSaved).toHaveBeenCalledExactlyOnceWith(updated);
	});

	it("propagates save failures so the caller can report them, rather than pretending the face persisted", async () => {
		vi.mocked(changeCompanion).mockRejectedValueOnce(new Error("Could not save"));
		await expect(
			saveEdit("sancho", { face }, [{ name: "sancho", accepted: { text: original, sha: "observed-sha" } }], undefined),
		).rejects.toThrow("Could not save");
	});

	it("carries arbitrary accepted definitions through the band and uses the bubble for unknown members", () => {
		expect(whoOf([{ id: "otto", name: "Otto", face }], "otto").face).toBe(face);
		expect(whoOf([], "missing").face).toEqual(defaultAvatarFace());
	});

	it("keeps geometry JSON out of both sides of a change approval without hiding the personality", () => {
		const text = agentFile({ name: "Otto", face }, "My personality.\nface: this is prose, not identity.");
		const preview = withoutFace(text);
		expect(preview).not.toContain(writeAvatarFace(face));
		expect(preview).not.toContain('"definition"');
		expect(preview).toContain("face: this is prose, not identity.");
		expect(withoutFace(text.replaceAll("\n", "\r\n"))).not.toContain('"definition"');
		expect(withoutFace(text.replace("\n---\n", "\n--- \t\n"))).not.toContain('"definition"');
	});
});
