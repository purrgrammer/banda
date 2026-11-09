/**
 * The web gateway: the browser posts with the daemon's token (`bearer`), so every message is the owner's. A new thread
 * (the browser's name for it) starts a chat; a message to an existing one names it, wherever it started, and
 * is answered where it started. The browser reads replies from the transcript itself, so sending one only names it.
 */
import { randomUUID } from "node:crypto";
import type { Attachment } from "../core/blobs.ts";
import {
	type Gateway,
	type Image,
	type Origin,
	type Outbound,
	OWNER,
	type Receive,
	type Received,
} from "../core/gateway.ts";

/**
 * Where a web message goes: a new thread (running `agent`, else the lead), or
 * a chat by its id.
 */
export type WebTarget = { readonly thread: string; readonly agent?: string } | { readonly chat: number };

/** What came with a web message: its attachments, and the images among them as the model takes them. */
export type WebFiles = { readonly files?: readonly Attachment[]; readonly images?: readonly Image[] };

export class WebGateway implements Gateway {
	readonly name = "web";
	readonly strength = "bearer";
	readonly can = { buttons: false, files: false, threads: true };
	#receive: Receive | undefined;

	start(receive: Receive): void {
		this.#receive = receive;
	}

	/**
	 * `id` is the browser's for the message, so a retried post is a redelivery. Attachments are blobs already: post
	 * inside `BlobStore.exclusive`, with the check that they are there.
	 */
	post(id: string, to: WebTarget, text: string, { files = [], images = [] }: WebFiles = {}): Promise<Received> {
		if (this.#receive === undefined) throw new Error("the web gateway is not started");
		const came = { ...(files.length === 0 ? {} : { files }), ...(images.length === 0 ? {} : { images }) };
		return "thread" in to
			? this.#receive({
					id,
					origin: { gateway: this.name, peer: OWNER, thread: to.thread },
					text,
					...came,
					...(to.agent === undefined ? {} : { agent: to.agent }),
				})
			: this.#receive({
					id,
					origin: { gateway: this.name, peer: OWNER },
					chat: to.chat,
					text,
					...came,
				});
	}

	async send(_to: Origin, out: Outbound): Promise<string> {
		// unique within the gateway: one message per ask, and any number of others
		return out.ask === undefined ? `message:${randomUUID()}` : `ask:${out.ask.key}`;
	}
}
