/**
 * The installation id (src/home.ts `installationId`) on a filesystem without hard links: an exFAT or FAT drive, many
 * network shares, where `link` fails. The id is made all the same, once and whole, and kept from then on.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "./helpers.ts";

const links = vi.hoisted(() => ({ refused: undefined as string | undefined, tried: 0 }));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		link: async (from: string, to: string) => {
			links.tried++;
			if (links.refused === undefined) return actual.link(from, to);
			throw Object.assign(new Error(`${links.refused}: operation not supported, link '${from}' -> '${to}'`), {
				code: links.refused,
			});
		},
	};
});

const { installationId } = await import("../src/home.ts");

afterEach(() => {
	links.refused = undefined;
	links.tried = 0;
});

describe("the installation id without hard links", () => {
	for (const code of ["ENOTSUP", "EPERM", "EXDEV", "ENOSYS"])
		it(`is made once and whole where link fails with ${code}`, async () => {
			links.refused = code;
			const home = await tempHome();
			const ids = await Promise.all([installationId(home), installationId(home), installationId(home)]);
			expect(links.tried).toBeGreaterThan(0);
			expect(new Set(ids).size).toBe(1);
			const [id] = ids;
			expect(await readFile(join(home, "auth", "device-id"), "utf8")).toBe(`${id}\n`);
			// no temporary is left beside it, and a later call keeps it
			expect(await readdir(join(home, "auth"))).toEqual(["device-id"]);
			expect(await installationId(home)).toBe(id);
		});

	it("still refuses a link that fails for any other reason, and leaves no id behind", async () => {
		links.refused = "EIO";
		const home = await tempHome();
		await expect(installationId(home)).rejects.toThrow(/EIO/);
		expect(await readdir(join(home, "auth"))).toEqual([]);
		links.refused = undefined;
		expect(await installationId(home)).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("takes away the temporary files a process killed while making the id left, never a running one's", async () => {
		const home = await tempHome();
		await mkdir(join(home, "auth"));
		// a pid no process has: the kernel's limit is far below it
		const dead = "device-id.2147483646.0a1b.tmp";
		const live = `device-id.${process.ppid}.0a1b.tmp`;
		for (const name of [dead, live]) await writeFile(join(home, "auth", name), "half");
		await installationId(home);
		expect((await readdir(join(home, "auth"))).sort()).toEqual(["device-id", live]);
	});
});
