import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBox } from "../src/box/box.ts";
import { launchMicrovm, microvmBox } from "../src/box/microvm.ts";
import * as assets from "../src/box/microvm-assets.ts";

const homes: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home() {
	const path = await mkdtemp(join(tmpdir(), "banda-microvm-unit-"));
	homes.push(path);
	return path;
}

describe("the guarded microVM backend", () => {
	it("keeps a missing bundled runtime offline without opening host execution", async () => {
		const root = await home();
		vi.spyOn(assets, "installedMicrovmAssets").mockRejectedValue(new Error("The bundled computer is missing."));
		const setup = microvmBox(root);
		const box = openBox(setup, () => {});
		try {
			expect(setup.egress?.env(7).https_proxy).toMatch(/^http:\/\/c7:[a-f0-9]+@127\.0\.0\.1:80$/);
			await expect(box.ensure()).rejects.toThrow(/bundled computer|Apple silicon/);
			expect(box.state()).toMatchObject({ state: "offline" });
			expect(box.kind).toBe("microvm");
			await expect(access(join(root, "computer"))).rejects.toMatchObject({ code: "ENOENT" });
			expect((await readFile(join(root, "auth/egress.key"), "utf8")).trim()).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			await box.close();
		}
	});

	it("closing before first use prevents later startup and does not need a bundle", async () => {
		const root = await home();
		const setup = microvmBox(root);
		await setup.close?.();
		await setup.close?.();
		await expect(setup.ensure()).rejects.toThrow("This computer is closed");
		await expect(access(join(root, "computer"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a launch naming arbitrary runtime paths before looking for assets", async () => {
		await expect(launchMicrovm(["env", "/not-a-home", "../../another-process"])).rejects.toThrow(
			"Invalid computer command identifiers",
		);
	});
});
