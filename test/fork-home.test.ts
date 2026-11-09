/**
 * A fork of a home (scripts/fork-home.ts): the store and the owner's setup copied, the source only read, routines
 * paused in the fork, and the providers' sign-in shared, so a refresh in either home is the other's too. The box's
 * volumes need Docker and are left out here.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { forkHome } from "../scripts/fork-home.ts";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";
import { Control } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";

const dirs: string[] = [];
const dir = (prefix: string) => {
	const next = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(next);
	return next;
};
afterEach(() => {
	for (const next of dirs.splice(0)) rmSync(next, { recursive: true, force: true });
});

const control = async (home: string) => {
	const harness = await openStore(home, { models: createModels(), registry: createRegistry() });
	try {
		return await harness.snapshot(Control, context);
	} finally {
		await harness.close(context);
	}
};

it("forks a home's store and setup, pauses its routines, and leaves the source as it was", async () => {
	const from = dir("banda-main-");
	const harness = await openStore(from, { models: createModels(), registry: createRegistry() });
	try {
		// the source's daemon keeps the store open, as a live home's does
		await harness.commit(async (tx) => {
			(await tx.doc(Control)).chat = 7;
		}, context);
		mkdirSync(join(from, "auth"), { recursive: true });
		mkdirSync(join(from, "blobs", "ab"), { recursive: true });
		writeFileSync(join(from, "blobs", "ab", "abcd"), "bytes");
		writeFileSync(join(from, "config.json"), '{"model":{"provider":"openai","id":"x"}}');
		writeFileSync(join(from, "auth", "token"), "owner-token");
		writeFileSync(join(from, "auth", "egress.json"), '{"credentials":[]}');
		writeFileSync(join(from, "auth", "egress.key"), "f".repeat(64));
		await new FileCredentialStore(from).modify("openai", async () => ({ type: "api_key", key: "first" }));

		const to = join(dir("banda-fork-"), "home");
		const done = await forkHome(from, to, { volumes: false });
		expect(done).toEqual([
			"store",
			"blobs",
			"config",
			"auth/token",
			"auth/egress.json",
			"auth/providers.json (linked)",
			"routines paused",
		]);
		expect(await control(to)).toMatchObject({ chat: 7, paused: expect.any(Number) });
		expect(readFileSync(join(to, "blobs", "ab", "abcd"), "utf8")).toBe("bytes");
		expect(readFileSync(join(to, "auth", "token"), "utf8")).toBe("owner-token");
		// the proxy's key is the fork's own, made by its daemon
		expect(() => lstatSync(join(to, "auth", "egress.key"))).toThrow();
		// the source: still running, not paused
		expect((await harness.snapshot(Control, context))?.paused).toBeUndefined();
		await expect(forkHome(from, to, { volumes: false })).rejects.toThrow("is not empty");
		await expect(forkHome(from, from, { volumes: false })).rejects.toThrow("onto itself");

		// a refresh in the fork is written to the source's file, and the fork keeps its link
		await new FileCredentialStore(to).modify("openai", async () => ({ type: "api_key", key: "refreshed" }));
		expect(lstatSync(join(to, "auth", "providers.json")).isSymbolicLink()).toBe(true);
		expect(await new FileCredentialStore(from).read("openai")).toEqual({ type: "api_key", key: "refreshed" });
	} finally {
		await harness.close(context);
	}
});
