/**
 * Headless Google Chrome over the DevTools protocol, with Node's own WebSocket: no dependency. It opens a page at a
 * given size (a phone's is emulated as one: touch, mobile viewport), runs steps in it, and takes screenshots. For the
 * manual smoke run only; nothing in the product uses it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

export async function withPage<T>(
	url: string,
	{ width, height }: { width: number; height: number },
	use: (page: Page) => Promise<T>,
): Promise<T> {
	const profile = await mkdtemp(join(tmpdir(), "banda-chrome-"));
	const chrome: ChildProcess = spawn(
		CHROME,
		["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	try {
		const endpoint = await new Promise<string>((resolve, reject) => {
			let seen = "";
			chrome.stderr?.on("data", (chunk: Buffer) => {
				seen += chunk.toString();
				const found = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
				if (found?.[1] !== undefined) resolve(found[1]);
			});
			chrome.once("exit", () => reject(new Error(`chrome exited: ${seen}`)));
		});
		const socket = new WebSocket(endpoint);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		let next = 0;
		const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		const errors: string[] = [];
		socket.onmessage = (message) => {
			const data = JSON.parse(String(message.data)) as {
				id?: number;
				method?: string;
				params?: {
					exceptionDetails?: { text: string; exception?: { description?: string } };
					type?: string;
					args?: { value?: unknown; description?: string }[];
				};
				result?: unknown;
				error?: { message: string };
			};
			if (data.method === "Runtime.exceptionThrown")
				errors.push(data.params?.exceptionDetails?.exception?.description ?? data.params?.exceptionDetails?.text ?? "");
			if (data.method === "Runtime.consoleAPICalled" && data.params?.type === "error")
				errors.push((data.params.args ?? []).map((a) => String(a.value ?? a.description)).join(" "));
			const waiter = data.id === undefined ? undefined : pending.get(data.id);
			if (waiter === undefined) return;
			pending.delete(data.id as number);
			if (data.error !== undefined) waiter.reject(new Error(data.error.message));
			else waiter.resolve(data.result);
		};
		const send = <R>(method: string, params: object = {}, sessionId?: string) =>
			new Promise<R>((resolve, reject) => {
				const id = ++next;
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
				socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
			});
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
			// names what never came, should the state not arrive within a minute
			until: async (expression, ms = 60_000) => {
				const end = Date.now() + ms;
				while (!(await run<boolean>(`Boolean(${expression})`))) {
					if (Date.now() > end) {
						// what the page was showing, and what went wrong in it, say why the state never came
						const shown = await run<string>("document.body?.innerText.slice(0, 300) ?? ''").catch(() => "?");
						const at = await run<string>("location.href").catch(() => "?");
						throw new Error(
							`timed out waiting for ${expression}\nat ${at}\nshowing: ${JSON.stringify(shown)}\nerrors: ${JSON.stringify(errors.slice(-5))}`,
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			},
			input: (method, params) => send(method, params, sessionId),
			shoot: async (file) => {
				const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
				await writeFile(file, Buffer.from(data, "base64"));
			},
			goto: async (to) => {
				await send("Page.navigate", { url: to }, sessionId);
				await new Promise((resolve) => setTimeout(resolve, 500));
			},
		};
		await page.goto(url);
		const result = await use(page);
		socket.close();
		return result;
	} finally {
		chrome.kill();
		await rm(profile, { recursive: true, force: true }).catch(() => undefined);
	}
}
