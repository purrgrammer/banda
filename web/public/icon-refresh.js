// Identity is public only as pixels. Revalidate the current still without a token or any identity API.
// Browsers do not automatically reload a favicon after an in-app edit, so change the link URL as well.
let etag;
let checking = false;
async function refreshIcons() {
	if (checking || document.visibilityState === "hidden") return;
	checking = true;
	try {
		const response = await fetch("/icon.svg", {
			method: "HEAD",
			cache: "no-store",
			credentials: "omit",
			headers: etag ? { "if-none-match": etag } : {},
		});
		if (!response.ok || response.status === 304) return;
		const next = response.headers.get("etag");
		if (!next || next === etag) return;
		etag = next;
		const version = encodeURIComponent(next.replaceAll('"', ""));
		for (const [rel, path] of [
			["icon", "/icon.svg"],
			["apple-touch-icon", "/apple-touch-icon.png"],
			["manifest", "/manifest.webmanifest"],
		]) {
			const link = document.querySelector(`link[rel="${rel}"]`);
			if (link) link.href = `${path}?v=${version}`;
		}
	} catch {
		// Offline: leave the already displayed icon alone. Never cache a failed identity reading.
	} finally {
		checking = false;
	}
}
window.addEventListener("focus", refreshIcons);
window.addEventListener("pageshow", refreshIcons);
document.addEventListener("visibilitychange", refreshIcons);
setInterval(refreshIcons, 5000);
void refreshIcons();
