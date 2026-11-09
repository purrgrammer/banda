/**
 * The sweep of what boxes left behind: a container labelled with a home that is gone is removed with its networks
 * and volumes; one whose home still exists stays, unless the owner's own sweep finds it an idle throwaway.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerAvailable, sweepBoxes } from "../src/box/container.ts";

const IMAGE = "mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const exists = (name: string) => docker("ps", "--all", "--quiet", "--filter", `name=^${name}$`) !== "";

describe.skipIf(!(await dockerAvailable()))("sweeping boxes", () => {
	it("removes what a gone home left, keeps a home that exists, and an idle throwaway only when asked", async () => {
		const tag = Math.random().toString(36).slice(2, 8);
		const gone = mkdtempSync(join(tmpdir(), "banda-sweep-gone-"));
		const kept = mkdtempSync(join(tmpdir(), "banda-sweep-kept-"));
		const names = { gone: `banda-box-sweep${tag}g`, kept: `banda-box-sweep${tag}k` };
		try {
			docker("network", "create", `${names.gone}-in`);
			docker("volume", "create", `${names.gone}-workspace`);
			docker("create", "--name", names.gone, "--label", `banda.home=${gone}`, IMAGE);
			docker("create", "--name", `${names.gone}-proxy`, "--label", `banda.home=${gone}`, IMAGE);
			docker("create", "--name", names.kept, "--label", `banda.home=${kept}`, IMAGE);
			rmSync(gone, { recursive: true, force: true });

			expect(await sweepBoxes()).toContain(gone);
			expect([exists(names.gone), exists(`${names.gone}-proxy`)]).toEqual([false, false]);
			expect(docker("network", "ls", "--quiet", "--filter", `name=^${names.gone}-in$`)).toBe("");
			expect(docker("volume", "ls", "--quiet", "--filter", `name=^${names.gone}-workspace$`)).toBe("");
			// its home exists: only the owner's own sweep takes an idle throwaway
			expect(exists(names.kept)).toBe(true);
			expect(await sweepBoxes({ idle: true })).toContain(kept);
			expect(exists(names.kept)).toBe(false);
		} finally {
			for (const name of [names.gone, `${names.gone}-proxy`, names.kept]) {
				try {
					execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
				} catch {}
			}
			rmSync(kept, { recursive: true, force: true });
		}
	}, 120_000);
});
