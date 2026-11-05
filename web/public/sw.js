/*
 * The app's service worker: it keeps the shell, so the installed app opens without the daemon and says it cannot
 * reach it. Navigations go to the network first, the cached shell when that fails; built assets (their names carry
 * their hash, so they never change) come from the cache first, and so does the emoji picker's data under /emojibase/
 * (its version is in its path), so the picker works offline once opened. Provider marks use the network first so
 * a changed local SVG is not held stale; the last viewed copy stays available offline. Nothing under /api, and no request carrying a token,
 * is ever touched. The build stamps the cache's name, so a new build starts a new cache and the old one goes.
 */
const CACHE = "banda-__BUILD__";

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.add("/"))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET" || request.headers.has("authorization")) return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
	// Accepted identity is mutable, not a build asset. Always let HTTP revalidate it; never freeze it in CacheStorage.
	if (
		url.pathname === "/manifest.webmanifest" ||
		url.pathname === "/apple-touch-icon.png" ||
		/^\/icon(?:-maskable)?(?:-\d+)?\.(?:svg|png)$/.test(url.pathname)
	)
		return;
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then(async (response) => {
					if (response.ok) await (await caches.open(CACHE)).put("/", response.clone());
					return response;
				})
				.catch(async () => (await caches.match("/")) ?? Response.error()),
		);
		return;
	}
	if (url.pathname.startsWith("/providers/")) {
		event.respondWith(
			fetch(request)
				.then(async (response) => {
					if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
					return response;
				})
				.catch(async () => (await caches.match(request)) ?? Response.error()),
		);
		return;
	}
	if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/emojibase/")) {
		event.respondWith(
			caches.match(request).then(
				(cached) =>
					cached ??
					fetch(request).then(async (response) => {
						if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
						return response;
					}),
			),
		);
	}
});
