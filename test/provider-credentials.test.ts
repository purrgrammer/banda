import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "../src/core/provider-credentials.ts";

const homes: string[] = [];
const home = () => {
	const next = mkdtempSync(join(tmpdir(), "banda-providers-"));
	homes.push(next);
	return next;
};
afterEach(() => {
	for (const next of homes.splice(0)) rmSync(next, { recursive: true, force: true });
});

it("keeps provider credentials atomically while listing only their non-secret status", async () => {
	const root = home();
	const credentials = new FileCredentialStore(root);
	await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-not-in-status" }));
	expect(await credentials.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
	expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "sk-not-in-status" });
	expect(readFileSync(join(root, "auth", "providers.json"), "utf8")).toContain("sk-not-in-status");
	await credentials.delete("openai");
	expect(await credentials.list()).toEqual([]);
});

it("serializes provider refreshes", async () => {
	const credentials = new FileCredentialStore(home());
	await credentials.modify("openai", async () => ({ type: "api_key", key: "first" }));
	const suffix = (current: Awaited<ReturnType<typeof credentials.read>>) =>
		current?.type === "api_key" ? current.key : undefined;
	const one = credentials.modify("openai", async (current) => ({ type: "api_key", key: `${suffix(current)}-one` }));
	const two = credentials.modify("openai", async (current) => ({ type: "api_key", key: `${suffix(current)}-two` }));
	await Promise.all([one, two]);
	expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "first-one-two" });
});
