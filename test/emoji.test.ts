import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getExample } from "open-bot-avatar";
import { describe, expect, it } from "vitest";
import { readAvatarFace, writeAvatarFace } from "../src/core/avatar-face.ts";
import { validateBoundedAvatar } from "../src/core/avatar-geometry.ts";
import { DEFAULT_FACE, DEFAULT_NAME } from "../src/core/choices.ts";
import { handler, type Routes } from "../src/server/http.ts";
import { EMOJIBASE_FILES, emojibase, vendorEmojibase } from "../web/vite.config.ts";
import { tempHome } from "./helpers.ts";

type Hook = (...args: unknown[]) => unknown;
const hook = (plugin: ReturnType<typeof vendorEmojibase>, name: string) =>
	(plugin as unknown as Record<string, Hook>)[name]!;

/** The plugin's build output in a temp web root, as `npm run build:web` writes it into web/dist. */
async function built(): Promise<{ web: string; base: string }> {
	const root = await tempHome();
	const plugin = vendorEmojibase();
	hook(plugin, "configResolved")({ root, command: "build", build: { outDir: "dist" } });
	await hook(plugin, "closeBundle")();
	const web = join(root, "dist");
	await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
	return { web, base: `/emojibase/${emojibase().version}` };
}

describe("the emoji picker's data", () => {
	it("is fetched from the daemon's own origin, under the pinned version, never a CDN", async () => {
		const plugin = vendorEmojibase();
		const { define } = hook(plugin, "config")() as { define: Record<string, string> };
		const url = JSON.parse(define.__EMOJIBASE__!) as string;
		expect(url).toBe(`/emojibase/${emojibase().version}`);
		expect(emojibase().version).toBe("18.0.0");
		// the picker's root always sets that URL, and its props cannot replace it (frimousse falls back to a CDN)
		const picker = await readFile(new URL("../web/src/components/ui/emoji-picker.tsx", import.meta.url), "utf8");
		expect(picker).toMatch(/export const EMOJIBASE_URL: string = __EMOJIBASE__;/);
		expect(picker).toMatch(/\{\.\.\.props\}\s*locale="en"\s*emojibaseUrl=\{EMOJIBASE_URL\}/);
		expect(picker).toMatch(/"emojibaseUrl" \| "resolveEmojiData"/);
		expect(picker).not.toMatch(/https?:\/\//);
	});

	it("is vendored into the build with the shape frimousse 0.4.0 reads", async () => {
		const { web, base } = await built();
		const read = async (name: (typeof EMOJIBASE_FILES)[number]) =>
			JSON.parse(await readFile(join(web, base, "en", name), "utf8")) as unknown;
		const data = (await read("data.json")) as Record<string, unknown>[];
		expect(data.length).toBeGreaterThan(1000);
		const grouped = data.filter((entry) => "group" in entry);
		expect(grouped.length).toBeGreaterThan(1000);
		for (const entry of grouped) {
			expect(typeof entry.emoji).toBe("string");
			expect(typeof entry.label).toBe("string");
			expect(typeof entry.group).toBe("number");
			expect(typeof entry.version).toBe("number");
			for (const skin of (entry.skins ?? []) as Record<string, unknown>[]) {
				expect(typeof skin.emoji).toBe("string");
				expect(skin.tone === undefined || typeof skin.tone === "number" || Array.isArray(skin.tone)).toBe(true);
			}
		}
		expect(grouped.some((entry) => Array.isArray(entry.skins) && entry.skins.length > 0)).toBe(true);
		expect(grouped.find((entry) => entry.emoji === "🫏")).toBeDefined();
		const messages = (await read("messages.json")) as Record<string, { key: string; message: string }[]>;
		for (const list of ["groups", "subgroups", "skinTones"]) {
			expect(messages[list]!.length).toBeGreaterThan(0);
			for (const item of messages[list]!) expect(typeof item.key).toBe("string");
		}
		expect(messages.skinTones!.map((tone) => tone.key).sort()).toEqual(
			["dark", "light", "medium", "medium-dark", "medium-light"].sort(),
		);
	});

	it("is served by the daemon with no token, for GET and HEAD, as JSON", async () => {
		const { web, base } = await built();
		let port = 0;
		const server = createServer(handler({} as Routes, () => port, "secret", web));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
		try {
			for (const name of EMOJIBASE_FILES) {
				const url = `http://127.0.0.1:${port}${base}/en/${name}`;
				const got = await fetch(url);
				expect(got.status).toBe(200);
				expect(got.headers.get("content-type")).toBe("application/json");
				expect(await got.json()).toEqual(JSON.parse(await readFile(join(web, base, "en", name), "utf8")));
				const head = await fetch(url, { method: "HEAD" });
				expect(head.status).toBe(200);
				expect(head.headers.get("content-type")).toBe("application/json");
			}
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("the first chat", () => {
	it("starts as Sancho with a chat-bubble avatar", () => {
		expect(DEFAULT_NAME).toBe("Sancho");
		expect(Object.keys(DEFAULT_FACE).sort()).toEqual(["color", "definition"]);
		expect(validateBoundedAvatar(getExample("chat"))).toMatchObject({ ok: true, value: DEFAULT_FACE.definition });
		expect(readAvatarFace(writeAvatarFace(DEFAULT_FACE))).toEqual({ ok: true, face: DEFAULT_FACE });
	});
});
