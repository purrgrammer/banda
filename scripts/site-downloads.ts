import { readFile, writeFile } from "node:fs/promises";

export type Release = {
	tag_name: string;
	published_at: string | null;
	draft?: boolean;
	assets: { name: string; browser_download_url: string }[];
};

/** Newest published asset per platform, including pre-releases and platform-only releases. */
export function downloadFiles(releases: Release[]) {
	const files = new Map<string, { url: string; release: Release }>();
	const aliases: Record<string, string> = { x86_64: "x64", amd64: "x64", aarch64: "arm64" };
	for (const release of releases
		.filter((release) => !release.draft && release.published_at)
		.sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""))) {
		for (const asset of release.assets) {
			const match = /^banda-(cli-)?.+-(mac|win|linux|android)-([a-z0-9_]+)\.(tar\.gz|[A-Za-z]+)$/.exec(asset.name);
			if (!match) continue;
			const [, cli, os, arch, ext] = match;
			const kind = cli ? "cli" : os === "android" ? "phone" : "desktop";
			const key = `${kind}/${os}/${aliases[arch] ?? arch}/${ext}`;
			if (!files.has(key)) files.set(key, { url: asset.browser_download_url, release });
		}
	}
	return files;
}

const escapeHtml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function updateDownloads(html: string, releases: Release[]) {
	const files = downloadFiles(releases);
	const used = new Set<Release>();
	let count = 0;
	const updated = html.replace(/(<a data-file="([^"]+)" href=")[^"]*(")/g, (_match, start, key, end) => {
		const file = files.get(key);
		if (!file) throw new Error(`No published download for ${key}`);
		const url = new URL(file.url);
		if (url.origin !== "https://github.com" || !url.pathname.startsWith("/purrgrammer/banda/releases/download/")) {
			throw new Error(`Not a banda release download: ${file.url}`);
		}
		used.add(file.release);
		count++;
		return `${start}${escapeHtml(file.url)}${end}`;
	});
	if (!count) throw new Error("No download links found in landing page");
	const checksums = [...used].map((release) => {
		const asset = release.assets.find((asset) => asset.name === "SHA256SUMS");
		if (!asset) throw new Error(`Missing checksums for ${release.tag_name}`);
		return `<a href="${escapeHtml(asset.browser_download_url)}">Checksums (${escapeHtml(release.tag_name)})</a>`;
	});
	return updated.replace(
		/<!-- checksums:start -->.*?<!-- checksums:end -->/s,
		`<!-- checksums:start -->${checksums.join(" · ")}<!-- checksums:end -->`,
	);
}

if (import.meta.main) {
	const input = process.argv[2];
	if (!input) throw new Error("Usage: node scripts/site-downloads.ts <releases.json>");
	// gh api --paginate --slurp emits an array of pages; a single page works too.
	const releases: Release[] = JSON.parse(await readFile(input, "utf8")).flat();
	const path = new URL("../site/index.html", import.meta.url);
	await writeFile(path, updateDownloads(await readFile(path, "utf8"), releases));
}
