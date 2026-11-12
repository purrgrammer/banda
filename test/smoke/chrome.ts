/**
 * Headless Google Chrome over the DevTools pipe, with the client the box's browser uses. It opens a page at a given
 * size (a phone's is emulated as one: touch, mobile viewport), runs steps in it, and takes screenshots. For browser
 * tests and the manual smoke run; nothing in the product uses it.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "../../src/box/cdp.ts";

export const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const hasChrome = () => existsSync(CHROME);

export type Page = {
	/** Evaluate `expression` in the page; resolves with its value (awaited when it is a promise). */
	readonly run: <T = unknown>(expression: string) => Promise<T>;
	/** Resolve once `expression` is truthy in the page, or reject after `ms`. */
	readonly until: (expression: string, ms?: number) => Promise<void>;
	readonly shoot: (file: string) => Promise<void>;
	readonly goto: (url: string) => Promise<void>;
	/** Native CDP input, for pointer, keyboard and touch acceptance checks. */
	readonly input: (method: string, params: object) => Promise<unknown>;
	/** The page's uncaught exceptions and console errors so far. */
	readonly errors: () => readonly string[];
};

/**
 * How long one DevTools command may take: under a test's own timeout (vitest.config.ts), so a page that stops answering
 * fails naming the command, not as a test that timed out with no word on why.
 */
export const COMMAND_MS = 20_000;

export type Chrome = { readonly cdp: Cdp; readonly stop: () => Promise<void> };

/** A Chrome of its own. It exits when its pipe closes, so a test process that dies, however it dies, takes Chrome along. */
export async function openChrome(): Promise<Chrome> {
	const profile = await mkdtemp(join(tmpdir(), "banda-chrome-"));
	const cdp = new Cdp(
		[
			"/bin/sh",
			"-c",
			'exec 3<&0 4>&1 1>&2; exec "$1" --headless=new --remote-debugging-pipe --no-first-run --user-data-dir="$2" about:blank',
			"banda-chrome",
			CHROME,
			profile,
		],
		() => undefined,
	);
	return {
		cdp,
		stop: async () => {
			cdp.close();
			// Chrome keeps writing its profile until it exits
			await cdp.ended;
			await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
		},
	};
}

export async function withPage<T>(
	url: string,
	{ width, height }: { width: number; height: number },
	use: (page: Page) => Promise<T>,
): Promise<T> {
	const chrome = await openChrome();
	try {
		const errors: string[] = [];
		chrome.cdp.on(({ method, params }) => {
			const event = params as {
				exceptionDetails?: { text: string; exception?: { description?: string } };
				type?: string;
				args?: { value?: unknown; description?: string }[];
			};
			if (method === "Runtime.exceptionThrown")
				errors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "");
			if (method === "Runtime.consoleAPICalled" && event.type === "error")
				errors.push((event.args ?? []).map((a) => String(a.value ?? a.description)).join(" "));
		});
		const send = <R>(method: string, params: object = {}, sessionId?: string) =>
			chrome.cdp.send<R>(method, params, sessionId, COMMAND_MS);
		const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		await send("Runtime.enable", {}, sessionId);
		const mobile = width < 768;
		await send(
			"Emulation.setDeviceMetricsOverride",
			{ width, height, deviceScaleFactor: mobile ? 3 : 1, mobile },
			sessionId,
		);
		if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true }, sessionId);
		const run = async <R>(expression: string): Promise<R> => {
			const { result, exceptionDetails } = await send<{
				result: { value?: R };
				exceptionDetails?: { text: string; exception?: { description?: string } };
			}>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
			if (exceptionDetails !== undefined)
				throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value as R;
		};
		const page: Page = {
			errors: () => errors,
			run,
			// waits on state, not on a clock of its own: the test's timeout is the bound (vitest.config.ts); this one only
			// names what never came, before that timeout ends the test with no word on why
			until: async (expression, ms = 20_000) => {
				const end = Date.now() + ms;
				// awaited, so a promise is waited on for its value rather than taken as truthy
				while (!(await run<boolean>(`(async () => Boolean(await (${expression})))()`))) {
					if (Date.now() > end) {
						// what the page was showing, and what went wrong in it, say why the state never came
						const shown = await run<string>("document.body?.innerText.slice(0, 300) ?? ''").catch(() => "?");
						const at = await run<string>("location.href").catch(() => "?");
						throw new Error(
							`timed out waiting for ${expression}\nat ${at}\nshowing: ${JSON.stringify(shown)}\nerrors: ${JSON.stringify(errors.slice(-5))}`,
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			},
			input: (method, params) => send(method, params, sessionId),
			shoot: async (file) => {
				const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
				await writeFile(file, Buffer.from(data, "base64"));
			},
			goto: async (to) => {
				await send("Page.navigate", { url: to }, sessionId);
				const end = Date.now() + 20_000;
				while ((await run<string>("document.readyState")) !== "complete") {
					if (Date.now() > end) throw new Error(`${to} did not finish loading`);
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			},
		};
		await page.goto(url);
		return await use(page);
	} finally {
		await chrome.stop();
	}
}
