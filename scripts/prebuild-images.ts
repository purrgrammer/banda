/**
 * Build the box's and the proxy's images under the tags banda looks for, so a run finds them made. In CI
 * (`BANDA_IMAGE_CACHE=gha`) buildx reads and writes GitHub's layer cache, so an unchanged Dockerfile builds in seconds.
 */
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSpecs } from "../src/box/container.ts";

const cache = process.env.BANDA_IMAGE_CACHE === "gha";
for (const { tag, files } of await imageSpecs()) {
	const scope = tag.split(":")[0];
	const context = await mkdtemp(join(tmpdir(), `${scope}-`));
	try {
		for (const [name, path] of Object.entries(files)) await copyFile(path, join(context, name));
		if ("pi-env" in files) await chmod(join(context, "pi-env"), 0o755);
		const args = cache
			? [
					"buildx",
					"build",
					"--load",
					`--cache-from=type=gha,scope=${scope}`,
					`--cache-to=type=gha,mode=max,scope=${scope}`,
				]
			: ["build"];
		execFileSync("docker", [...args, "--progress", "plain", "--tag", tag, context], { stdio: "inherit" });
		console.log(`built ${tag}`);
	} finally {
		await rm(context, { recursive: true, force: true });
	}
}
