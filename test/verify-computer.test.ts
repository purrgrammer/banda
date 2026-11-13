import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/verify-computer.ts", import.meta.url));

describe("native computer qualification package selection", () => {
	it("rejects a relative package before executing a staged runtime", async () => {
		await expect(
			run(process.execPath, [script], { env: { ...process.env, BANDA_RELEASE_ROOT: "relative-package" } }),
		).rejects.toThrow("BANDA_RELEASE_ROOT must be an absolute path");
	});

	it("resolves the selected package's bundled Node before using the default release", async () => {
		const root = join(await tempHome(), "not-staged");
		await expect(
			run(process.execPath, [script], { env: { ...process.env, BANDA_RELEASE_ROOT: root } }),
		).rejects.toThrow(join(root, "node/node"));
	});
});
