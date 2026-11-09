/**
 * The Chrome DevTools Protocol over a pipe (`--remote-debugging-pipe`): JSON messages, each ended by a NUL byte, on
 * the process's own stdin and stdout. The daemon starts Chromium in the box with `docker exec`, so DevTools is reached
 * over that one process and never over a port: nothing in the box, or on the host's network, can connect to it.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type CdpEvent = {
	readonly method: string;
	readonly params: Record<string, unknown>;
	readonly sessionId?: string;
};

export class CdpError extends Error {}

/** A CDP connection: commands answered by id, events to every listener; closed when the process ends. */
export class Cdp {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #listeners = new Set<(event: CdpEvent) => void>();
	#buffer: Buffer = Buffer.alloc(0);
	#next = 0;
	#closed: string | undefined;
	/** Settles when the process ended, with why. */
	readonly ended: Promise<string>;

	constructor(command: readonly string[], log: (line: string) => void) {
		const [program, ...args] = command;
		if (program === undefined) throw new CdpError("no command starts the browser");
		this.#child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
		// Chromium's own log is about Chromium, never the pages: only its last lines are kept, for when it fails to start
		let tail = "";
		this.#child.stderr.on("data", (chunk: Buffer) => {
			tail = (tail + chunk.toString("utf8")).slice(-2000);
		});
		this.#child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
		this.#child.stdin.on("error", () => undefined);
		this.ended = new Promise((resolve) => {
			this.#child.on("error", (error) => this.#close(`it did not start: ${error.message}`, resolve));
			// A descendant may keep stderr open after the browser exits; diagnostics do not confer liveness.
			this.#child.on("exit", (code, signal) => {
				const last = tail
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "" && !/dbus|Fontconfig|crashpad/i.test(line))
					.at(-1);
				this.#close(
					`it ended (${signal ?? `code ${code}`})${code !== 0 && last !== undefined ? `: ${last.slice(0, 300)}` : ""}`,
					resolve,
				);
			});
		});
		void this.ended.then((why) => log(`browser: ${why}`));
	}

	#close(why: string, resolve: (why: string) => void) {
		if (this.#closed !== undefined) return;
		this.#closed = why;
		this.#child.stdin.destroy();
		this.#child.stdout.destroy();
		this.#child.stderr.destroy();
		this.#listeners.clear();
		this.#buffer = Buffer.alloc(0);
		for (const { reject } of this.#pending.values()) reject(new CdpError(`the browser closed: ${why}`));
		this.#pending.clear();
		resolve(why);
	}

	#read(chunk: Buffer) {
		if (this.#closed !== undefined) return;
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		for (let end = this.#buffer.indexOf(0); end >= 0; end = this.#buffer.indexOf(0)) {
			const text = this.#buffer.subarray(0, end).toString("utf8");
			this.#buffer = this.#buffer.subarray(end + 1);
			let message: {
				id?: number;
				result?: unknown;
				error?: { message: string };
				method?: string;
				params?: Record<string, unknown>;
				sessionId?: string;
			};
			try {
				message = JSON.parse(text);
			} catch {
				continue;
			}
			if (message.id !== undefined) {
				const waiting = this.#pending.get(message.id);
				this.#pending.delete(message.id);
				if (message.error !== undefined) waiting?.reject(new CdpError(message.error.message));
				else waiting?.resolve(message.result ?? {});
			} else if (message.method !== undefined) {
				const event: CdpEvent = {
					method: message.method,
					params: message.params ?? {},
					...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
				};
				for (const listener of this.#listeners) {
					try {
						listener(event);
					} catch {
						// a listener's failure is its own
					}
				}
			}
		}
	}

	get closed(): string | undefined {
		return this.#closed;
	}

	/**
	 * Send `method`; its result, or a `CdpError`, also when it is not answered within `timeoutMs`: a page busy or stuck
	 * (a navigation waiting on a paused request) never holds a tool call forever. Once `signal` aborts, the command is
	 * abandoned with its reason: never sent if it had not been, its answer ignored if it comes.
	 */
	send<T = Record<string, unknown>>(
		method: string,
		params: object = {},
		sessionId?: string,
		timeoutMs = 30_000,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.#closed !== undefined) return Promise.reject(new CdpError(`the browser closed: ${this.#closed}`));
		if (signal?.aborted === true) return Promise.reject(signal.reason);
		const id = ++this.#next;
		return new Promise<T>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abandon);
			};
			const abandon = () => {
				this.#pending.delete(id);
				done();
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				done();
				reject(new CdpError(`the browser did not answer ${method} in time`));
			}, timeoutMs);
			timer.unref();
			signal?.addEventListener("abort", abandon, { once: true });
			this.#pending.set(id, {
				resolve: (value) => {
					done();
					resolve(value as T);
				},
				reject: (error) => {
					done();
					reject(error);
				},
			});
			this.#child.stdin.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		});
	}

	/** Hear every event; the stop. */
	on(listener: (event: CdpEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** End the process: its stdin closed (Chromium closes when its pipe does), then killed. */
	close(): void {
		this.#child.stdin.end();
		const kill = setTimeout(() => this.#child.kill("SIGKILL"), 3_000);
		kill.unref();
		void this.ended.then(() => clearTimeout(kill));
	}
}
