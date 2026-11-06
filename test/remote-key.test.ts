import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as iroh from "@number0/iroh";
import { afterEach, expect, it, vi } from "vitest";
import { endpointKey } from "../src/server/remote.ts";
import { tempHome } from "./helpers.ts";

const disk = vi.hoisted(() => ({ events: [] as string[], fail: "" }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			const handle = await fs.open(...args);
			const kind = (await handle.stat()).isDirectory() ? "directory" : "file";
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				disk.events.push(kind);
				if (disk.fail === kind) throw new Error(`cannot sync ${kind}`);
				await sync();
			};
			return handle;
		},
		rename: async (...args: Parameters<typeof fs.rename>) => {
			disk.events.push("rename");
			return fs.rename(...args);
		},
	};
});
afterEach(() => {
	disk.events.length = 0;
	disk.fail = "";
});

it("flushes key bytes before publication and its directory before exposing the identity", async () => {
	const home = await tempHome();
	const key = await endpointKey(home, iroh);
	expect(disk.events).toContain("file");
	expect(disk.events.indexOf("file")).toBeLessThan(disk.events.indexOf("rename"));
	if (process.platform !== "win32") expect(disk.events.slice(disk.events.indexOf("rename") + 1)).toContain("directory");
	expect(await readFile(join(home, "auth", "iroh.key"))).toEqual(Buffer.from(key.toBytes()));
	if (process.platform !== "win32") expect((await stat(join(home, "auth", "iroh.key"))).mode & 0o777).toBe(0o600);
	expect((await endpointKey(home, iroh)).toBytes()).toEqual(key.toBytes());
});

it("does not publish an identity when the key cannot be flushed", async () => {
	const home = await tempHome();
	disk.fail = "file";
	await expect(endpointKey(home, iroh)).rejects.toThrow("cannot sync file");
	await expect(readFile(join(home, "auth", "iroh.key"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")("does not expose a key when directory durability fails", async () => {
	const home = await tempHome();
	disk.fail = "directory";
	await expect(endpointKey(home, iroh)).rejects.toThrow("cannot sync directory");
});
