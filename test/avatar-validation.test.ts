import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExample } from "open-bot-avatar";
import { describe, expect, it, vi } from "vitest";
import {
	AVATAR_VALIDATION_QUEUE,
	AVATAR_VALIDATORS,
	validateAvatarCandidate,
} from "../src/server/avatar-validation.ts";

describe("untrusted avatar validation", () => {
	it("validates a built-in face without running geometry on the caller", async () => {
		const result = await validateAvatarCandidate(JSON.stringify(getExample("chat")));
		expect(result.ok).toBe(true);
	});
	it("validates when the process runs from a directory outside the app", () => {
		const validator = new URL("../src/server/avatar-validation.ts", import.meta.url).href;
		const output = execFileSync(
			process.execPath,
			[
				"-e",
				`import(${JSON.stringify(validator)})
					.then(({ validateAvatarCandidate }) => validateAvatarCandidate(process.argv[1], 20_000))
					.then((result) => console.log(JSON.stringify(result)));`,
				JSON.stringify(getExample("chat")),
			],
			{ cwd: mkdtempSync(join(tmpdir(), "banda-outside-")), encoding: "utf8" },
		);
		expect(JSON.parse(output)).toEqual({ ok: true, definition: expect.anything() });
	});
	it("reports a validator that cannot load as banda's fault, and logs why", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await validateAvatarCandidate(
			JSON.stringify(getExample("chat")),
			20_000,
			"file:///nowhere/open-bot-avatar.js",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join(" ")).toMatch(/do not change the face/i);
		expect(String(logged.mock.calls[0]?.[0])).toContain("ERR_MODULE_NOT_FOUND");
		logged.mockRestore();
	});
	it("rejects malformed and oversized data", async () => {
		expect((await validateAvatarCandidate("not json")).ok).toBe(false);
		expect((await validateAvatarCandidate("é".repeat(9_000))).ok).toBe(false);
	});
	it("keeps the event loop available while checking complex bounded geometry", async () => {
		const path = Array.from({ length: 16 }, () => `M10 10${"C10 90 90 10 90 90C90 10 10 90 10 10".repeat(10)}Z`).join(
			"",
		);
		const candidate = {
			version: 1,
			id: "complex",
			name: "Complex",
			body: { path },
			eyes: { x: 50, y: 50, spacing: 14, scale: 1 },
		};
		let ticked = false;
		const pending = validateAvatarCandidate(JSON.stringify(candidate));
		await new Promise<void>((resolve) =>
			setImmediate(() => {
				ticked = true;
				resolve();
			}),
		);
		expect(ticked).toBe(true);
		await pending;
	});
	it("bounds concurrent work and rejects an overflowing queue", async () => {
		const input = JSON.stringify(getExample("chat"));
		const pending = Array.from({ length: AVATAR_VALIDATORS + AVATAR_VALIDATION_QUEUE }, () =>
			validateAvatarCandidate(input, 150),
		);
		const overflow = await validateAvatarCandidate(input, 150);
		expect(overflow).toEqual({ ok: false, errors: ["Face validation is busy. Try again."] });
		await Promise.all(pending);
	});
	it("rejects the corrected-arc exploit in a killable worker and releases its slot", async () => {
		const candidate = {
			...getExample("chat"),
			body: { path: "M10 10A.01 120 45 0 1 90 90Z" },
		};
		const result = await validateAvatarCandidate(JSON.stringify(candidate), 100);
		expect(result.ok).toBe(false);
		expect((await validateAvatarCandidate(JSON.stringify(getExample("chat")))).ok).toBe(true);
	});
	it("rejects empty paths even though upstream validation accepts them", async () => {
		const candidate = { ...getExample("chat"), body: { path: "" } };
		expect(await validateAvatarCandidate(JSON.stringify(candidate))).toEqual({
			ok: false,
			errors: ["body.path must be a non-empty SVG path."],
		});
	});
	it("ends work when its deadline expires", async () => {
		const result = await validateAvatarCandidate(JSON.stringify(getExample("chat")), 0);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toContain("Face validation took too long.");
	});
});
