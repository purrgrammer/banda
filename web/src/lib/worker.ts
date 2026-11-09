/**
 * The app's service worker (`/sw.js`), and keeping the page on the build the daemon serves. The worker keeps the shell
 * for when the daemon cannot be reached; a new build is a new worker (its cache's name is stamped with the build), which
 * takes over at once (`skipWaiting`, `clients.claim`). The page asks for it whenever the daemon may have changed (it
 * came back, the page came back into view) and reloads once a new worker took over, so it never runs on a stale shell.
 * A lazy chunk of an older build that is gone (`vite:preloadError`) reloads it too, once.
 */

import { nativeShell } from "./transport.ts";

const RELOADED = "banda.reloaded";

/** Register the worker, in a built app only: a dev server serves no worker, and the phone's shell carries its files. */
export function registerWorker(): void {
	if (!import.meta.env.PROD || !("serviceWorker" in navigator) || nativeShell() !== undefined) return;
	// a page the worker already controlled reloads when a new one takes over; the first install changes nothing
	const controlled = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (controlled) location.reload();
	});
	addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
	addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") checkForUpdate();
	});
	addEventListener("vite:preloadError", (event) => {
		try {
			if (sessionStorage.getItem(RELOADED) === location.href) return;
			sessionStorage.setItem(RELOADED, location.href);
		} catch {
			// no storage: reload anyway; a second failure shows as the chunk's error
		}
		event.preventDefault();
		location.reload();
	});
}

/** Ask whether the daemon serves a new build: if it does, its worker installs, takes over, and the page reloads. */
export function checkForUpdate(): void {
	if (!import.meta.env.PROD || !("serviceWorker" in navigator) || nativeShell() !== undefined) return;
	void navigator.serviceWorker
		.getRegistration()
		.then((registration) => registration?.update())
		.catch(() => undefined);
}
