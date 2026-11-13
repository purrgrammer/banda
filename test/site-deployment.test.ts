import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("deploys all landing changes since the last deployment, even beneath an unrelated tip commit", async () => {
	const { ignoreCommand } = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
	const cwd = await mkdtemp(join(tmpdir(), "banda-site-deploy-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const decision = (previous: string) =>
		spawnSync("sh", ["-c", ignoreCommand], { cwd, env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: previous } }).status;
	try {
		git("init", "--quiet");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.test");
		await mkdir(join(cwd, "site"));
		await mkdir(join(cwd, "scripts"));
		await mkdir(join(cwd, "web/src/chat"), { recursive: true });
		await copyFile(new URL("../scripts/vercel-ignore.sh", import.meta.url), join(cwd, "scripts/vercel-ignore.sh"));
		await writeFile(join(cwd, "site/index.html"), "old downloads");
		await writeFile(join(cwd, "web/src/chat/Object.tsx"), "a card");
		git("add", ".");
		git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "deployed");
		const deployed = git("rev-parse", "HEAD");
		expect(decision(deployed)).toBe(0);
		await writeFile(join(cwd, "site/index.html"), "direct downloads");
		git("commit", "-am", "landing", "--no-gpg-sign", "--quiet");
		await writeFile(join(cwd, "unrelated.txt"), "other change");
		git("add", ".");
		git("commit", "-m", "unrelated tip", "--no-gpg-sign", "--quiet");
		expect(decision(deployed)).toBe(1);
		// Vercel fails a deployment on any answer but 0 or 1: a commit it cannot diff against builds, with exactly 1
		expect(decision("")).toBe(1);
		expect(decision("missing-commit")).toBe(1);
		expect(decision(git("rev-parse", "HEAD"))).toBe(0);
		// the showcase draws the app's components: a change to one is a change to the landing
		const before = git("rev-parse", "HEAD");
		await writeFile(join(cwd, "web/src/chat/Object.tsx"), "a card, redrawn");
		git("commit", "-am", "card", "--no-gpg-sign", "--quiet");
		expect(decision(before)).toBe(1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
