import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { downloadFiles, type Release, updateDownloads } from "../scripts/site-downloads.ts";

const release = (tag: string, date: string, names: string[], draft = false): Release => ({
	tag_name: tag,
	published_at: date,
	draft,
	assets: [...names, "SHA256SUMS"].map((name) => ({
		name,
		browser_download_url: `https://github.com/purrgrammer/banda/releases/download/${tag}/${name}`,
	})),
});

describe("landing downloads", () => {
	it("keeps desktop downloads when the newest release updates only Android, sorted by publication", () => {
		const files = downloadFiles([
			release("old-android", "2026-11-01", ["banda-1-android-arm64.apk"]),
			release("desktop", "2026-11-02", ["banda-1-mac-arm64.dmg", "banda-cli-1-linux-x64.tar.gz"]),
			release("new-android", "2026-11-03", ["banda-2-android-arm64.apk"]),
			release("draft", "2026-11-04", ["banda-3-mac-arm64.dmg"], true),
		]);
		expect(files.get("desktop/mac/arm64/dmg")?.release.tag_name).toBe("desktop");
		expect(files.get("cli/linux/x64/tar.gz")?.release.tag_name).toBe("desktop");
		expect(files.get("phone/android/arm64/apk")?.release.tag_name).toBe("new-android");
	});

	it("recognises the packagers' architecture aliases and excludes unsigned APKs", () => {
		const files = downloadFiles([
			release("v1", "2026-11-01", [
				"banda-1-linux-x86_64.AppImage",
				"banda-1-linux-amd64.deb",
				"banda-1-linux-aarch64.AppImage",
				"banda-1-android-arm64-unsigned.apk",
			]),
		]);
		expect([...files.keys()]).toEqual([
			"desktop/linux/x64/AppImage",
			"desktop/linux/x64/deb",
			"desktop/linux/arm64/AppImage",
		]);
	});

	it("bakes direct links and the matching checksums into HTML, without browser API access", async () => {
		const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
		const names = [...html.matchAll(/data-file="([^"]+)"/g)].map(([, key]) => {
			const [kind, os, arch, ext] = key.split("/");
			return `banda-${kind === "cli" ? "cli-" : ""}2-${os}-${arch}.${ext}`;
		});
		const releases = [
			release(
				"v2",
				"2026-11-02",
				names.filter((name) => !name.includes("android")),
			),
			release("phone2", "2026-11-03", ["banda-2-android-arm64.apk"]),
		];
		const result = updateDownloads(html, releases);
		const links = [...result.matchAll(/data-file="([^"]+)" href="([^"]+)"/g)];
		expect(links).toHaveLength(13);
		for (const [, key, url] of links)
			expect(url).toContain(`/releases/download/${key.startsWith("phone") ? "phone2" : "v2"}/`);
		expect(result).toContain("/v2/SHA256SUMS");
		expect(result).toContain("/phone2/SHA256SUMS");
		expect(result).not.toContain("api.github.com");
		expect(updateDownloads(result, releases)).toBe(result);
		expect(() => updateDownloads(html, [])).toThrow("No published download");
	});
});
