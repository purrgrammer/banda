/**
 * The CLI gateway: `banda say` talks to the daemon over loopback HTTP with the daemon's token (`bearer`), so every
 * message is the owner's. The messages and asks sent to its thread go to each `say` waiting there, until its Turn
 * ends; when no `say` waits (it was interrupted), they are still in the chat and the web.
 */
import { randomUUID } from "node:crypto";
import { type Gateway, type Origin, type Outbound, OWNER, type Receive, routeKey } from "../core/gateway.ts";
import type { Ask } from "../core/wait.ts";

export type CliGatewayOptions = {
	/** Resolves once the Turn has ended, with what to print about how it ended, if anything. */
	readonly ended: (turn: number) => Promise<string>;
};

/** An ask, as `say` prints it while it waits. */
export type SaidAsk = { readonly key: string; readonly ask: Ask };

/** What `say` hears while it waits: a message's text and the names of its files, or an ask. */
export type Heard = { readonly message: string; readonly files?: readonly string[] } | { readonly ask: SaidAsk };

type Waiter = {
	readonly route: string;
	readonly reject: (error: Error) => void;
	readonly heard: (heard: Heard) => void;
};

export class CliGateway implements Gateway {
	readonly name = "cli";
	readonly strength = "bearer";
	readonly can = { buttons: false, files: false, threads: true };
	readonly #options: CliGatewayOptions;
	#receive: Receive | undefined;
	readonly #waiting = new Map<string, Waiter>();

	constructor(options: CliGatewayOptions) {
		this.#options = options;
	}

	start(receive: Receive): void {
		this.#receive = receive;
	}

	stop(): void {
		for (const waiter of this.#waiting.values()) waiter.reject(new Error("the daemon is stopping"));
		this.#waiting.clear();
	}

	/**
	 * Deliver `text` as a new owner message, telling `heard` of each message and ask sent to the thread until its Turn
	 * ends, and resolve with how it ended. Text that answers an open question resolves at once.
	 */
	async say(
		text: string,
		thread: string | undefined,
		signal: AbortSignal,
		heard: (heard: Heard) => void = () => undefined,
	): Promise<string> {
		if (this.#receive === undefined) throw new Error("the CLI gateway is not started");
		const id = randomUUID();
		const origin: Origin = { gateway: this.name, peer: OWNER, ...(thread === undefined ? {} : { thread }) };
		const gone = new Promise<never>((_resolve, reject) => {
			this.#waiting.set(id, { route: routeKey(origin), reject, heard });
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		try {
			const received = await this.#receive({ id, origin, text });
			if ("refused" in received) throw new Error(received.refused);
			if ("answered" in received) return "(answered the open question)";
			return await Promise.race([gone, this.#options.ended(received.turn)]);
		} finally {
			this.#waiting.delete(id);
		}
	}

	async send(to: Origin, out: Outbound): Promise<string> {
		const files = (out.files ?? []).map((file) => file.name);
		const heard: Heard =
			out.ask !== undefined ? { ask: out.ask } : { message: out.text, ...(files.length === 0 ? {} : { files }) };
		for (const waiter of this.#waiting.values()) if (waiter.route === routeKey(to)) waiter.heard(heard);
		return randomUUID();
	}
}
