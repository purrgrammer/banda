/**
 * The hero's download choice (site/download-choice.ts) over the page's published links, as scripts/site-downloads.ts
 * bakes them: each device a user agent names, against the releases test/site-downloads.browser.test.ts serves. That file
 * keeps what needs a page: the button's script runs, its links are drawn and fit, a click reaches the downloads.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type Release, updateDownloads } from "../scripts/site-downloads.ts";
import { type Device, detectDevice, pickDownload, withArchitecture } from "../site/download-choice.ts";

const release = (tag: string, date: string, names: string[]): Release => ({
	tag_name: tag,
	published_at: date,
	assets: [...names, "SHA256SUMS"].map((name) => ({
		name,
		browser_download_url: `https://github.com/purrgrammer/banda/releases/download/${tag}/${name}`,
	})),
});
const older = release("old", "2026-11-01", [
	"banda-1-mac-arm64.dmg",
	"banda-1-win-x64.exe",
	"banda-cli-1-mac-arm64.tar.gz",
	"banda-cli-1-win-x64.zip",
	"banda-cli-1-linux-x64.tar.gz",
	"banda-cli-1-linux-arm64.tar.gz",
	"banda-1-android-arm64.apk",
	"banda-1-linux-x86_64.AppImage",
	"banda-1-linux-arm64.AppImage",
	"banda-1-linux-amd64.deb",
	"banda-1-linux-arm64.deb",
]);
const page = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
/** The page as served with these releases published after the older one; as committed when the API is unreachable. */
const baked = (releases?: Release[]) => (releases ? updateDownloads(updateDownloads(page, [older]), releases) : page);

/** What `a[data-file="…"][href]` finds first in the page, as the button's script asks it. */
function linksOf(html: string): (file: string) => string | undefined {
	return (file) => {
		for (const [tag] of html.matchAll(/<a\b[^>]*>/g)) {
			const href = /\shref="([^"]*)"/.exec(tag)?.[1];
			if (href !== undefined && /\sdata-file="([^"]*)"/.exec(tag)?.[1] === file) return href;
		}
		return undefined;
	};
}
const agent = (system: string) => `Mozilla/5.0 (${system}) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36`;
const device = (platform: string, system: string, extra: { maxTouchPoints?: number; architecture?: string } = {}) =>
	withArchitecture(
		detectDevice({ userAgent: agent(system), platform, maxTouchPoints: extra.maxTouchPoints }),
		extra.architecture,
	);
const choose = (on: Device, releases?: Release[]) => pickDownload(on, linksOf(baked(releases)));
const CHOOSER = { href: "#downloads", label: "Choose your platform" };

describe("the hero's download choice", () => {
	for (const [platform, system, extension] of [
		["MacIntel", "Macintosh; Intel Mac OS X 14_0", ".dmg"],
		["Linux armv8l", "Linux; Android 14; Pixel 8", ".apk"],
	] as const)
		it(`offers ${extension} from the published page when GitHub's API is unreachable`, () => {
			expect(choose(device(platform, system)).href.endsWith(extension)).toBe(true);
		});

	for (const [platform, system] of [
		["Win32", "Windows NT 10.0; Win64; x64"],
		["MacIntel", "Macintosh; Intel Mac OS X 14_0"],
	] as const)
		it(`offers the platform chooser on ${platform} x86`, () => {
			const releases = [older, release("new", "2026-11-02", ["banda-2-linux-amd64.deb"])];
			expect(choose(device(platform, system, { architecture: "x86" }), releases)).toEqual(CHOOSER);
		});

	for (const arch of ["amd64", "x64"])
		it(`selects the published ${arch} Debian desktop instead of an older AppImage`, () => {
			const releases = [older, release("new", "2026-11-02", [`banda-2-linux-${arch}.deb`])];
			expect(choose(device("Linux x86_64", "X11; Linux x86_64"), releases)).toEqual({
				href: `https://github.com/purrgrammer/banda/releases/download/new/banda-2-linux-${arch}.deb`,
				label: "Download for Linux (Debian, Ubuntu, x64)",
			});
		});

	for (const [name, files] of [
		["AppImage only", ["banda-2-linux-x86_64.AppImage"]],
		["ARM Debian only", ["banda-2-linux-arm64.deb"]],
		["no Linux desktop", ["banda-2-mac-arm64.dmg", "banda-2-win-x64.exe"]],
	] as const)
		it(`does not offer a stale Linux desktop with ${name}`, () => {
			expect(
				choose(device("Linux x86_64", "X11; Linux x86_64"), [older, release("new", "2026-11-02", [...files])]),
			).toEqual({
				href: "https://github.com/purrgrammer/banda/releases",
				label: "View releases",
			});
		});

	it("does not select the x64 Debian desktop on Linux ARM", () => {
		const releases = [older, release("new", "2026-11-02", ["banda-2-linux-amd64.deb", "banda-2-linux-arm64.deb"])];
		expect(choose(device("Linux aarch64", "X11; Linux"), releases)).toEqual(CHOOSER);
	});

	// beyond the page's matrix: devices the choice tells apart by what the browser says alone
	it("offers the chooser on an iPhone and on an iPad that reports a desktop Mac", () => {
		expect(device("iPhone", "iPhone; CPU iPhone OS 18_0 like Mac OS X").os).toBeNull();
		expect(device("MacIntel", "Macintosh; Intel Mac OS X 14_0", { maxTouchPoints: 5 }).os).toBeNull();
		expect(choose(device("MacIntel", "Macintosh; Intel Mac OS X 14_0", { maxTouchPoints: 5 }))).toEqual(CHOOSER);
	});

	it("takes the high-entropy architecture on a desktop, never on a phone", () => {
		expect(device("MacIntel", "Macintosh; Intel Mac OS X 14_0", { architecture: "arm" }).arch).toBe("arm64");
		expect(device("Linux x86_64", "X11; Linux x86_64", { architecture: "arm" }).arch).toBe("arm64");
		expect(device("Linux armv8l", "Linux; Android 14; Pixel 8", { architecture: "x86" })).toEqual({
			os: "android",
			arch: "arm64",
		});
		expect(device("Win32", "Windows NT 10.0; Win64; x64", { architecture: "arm" })).toEqual({ os: null, arch: "x64" });
	});

	it("reads the platform from userAgentData before navigator.platform", () => {
		expect(
			detectDevice({ userAgent: agent("X11; CrOS x86_64"), platform: "", userAgentData: { platform: "Linux" } }).os,
		).toBe("linux");
	});
});
