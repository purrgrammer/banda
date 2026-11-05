import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openBrowser, type ViewEvent } from "../src/box/browser.ts";
import { tempHome, until } from "./helpers.ts";
import { CHROME, hasChrome } from "./smoke/chrome.ts";

it.skipIf(!hasChrome())(
	"a second viewer gets the current frame of a static page without waiting for another paint",
	async () => {
		const home = await tempHome();
		const server = createServer((_request, response) =>
			response.end("<title>Static page</title><h1>A quiet page</h1>"),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("fixture did not listen");
		let ended = false;
		let onSwitch: ViewEvent[] = [];
		const browser = openBrowser({
			setup: {
				command: [
					"/bin/sh",
					"-c",
					'exec 3<&0 4>&1 1>&2; exec "$1" --headless=new --remote-debugging-pipe --no-first-run --disable-background-networking --user-data-dir="$2" about:blank',
					"banda-stream-test",
					CHROME,
					join(home, "chrome"),
				],
				login: { username: "test", password: "test" },
			},
			ensure: async () => {},
			tell: async (holder) => {
				if (holder?.chat !== 2) return;
				const events: ViewEvent[] = [];
				const stop = browser.watch((event) => events.push(event));
				onSwitch = [...events];
				stop();
			},
			log: (line) => {
				if (line.startsWith("browser: it ended")) ended = true;
			},
		});
		const first: ViewEvent[] = [];
		const stop = browser.watch((event) => first.push(event));
		let stopSecond: (() => void) | undefined;
		try {
			await browser.act(1, { type: "navigate", url: `http://127.0.0.1:${address.port}/` });
			await until(async () => {
				const navigation = first.findIndex(
					(event) => event.type === "state" && event.view.url === `http://127.0.0.1:${address.port}/`,
				);
				return navigation >= 0 && first.slice(navigation + 1).some((event) => event.type === "frame");
			});
			const second: ViewEvent[] = [];
			stopSecond = browser.watch((event) => second.push(event));
			// No paint or clock: a subscriber to an already-running cast must get its current image immediately.
			expect(second.map((event) => event.type)).toEqual(["state", "frame"]);
			expect(second[1]).toEqual(first.filter((event) => event.type === "frame").at(-1));
			await browser.act(2, { type: "navigate", url: `http://127.0.0.1:${address.port}/other` });
			expect(onSwitch.map((event) => event.type)).toEqual(["state"]);
			stopSecond();
			stop();
			const restarted: ViewEvent[] = [];
			stopSecond = browser.watch((event) => restarted.push(event));
			expect(restarted.map((event) => event.type)).toEqual(["state"]);
			await until(async () => restarted.some((event) => event.type === "frame"));
		} finally {
			stopSecond?.();
			stop();
			browser.close();
			await until(async () => ended);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);
