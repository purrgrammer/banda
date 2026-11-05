/** The Gateway slot (DESIGN.md "Slots"): where people reach the agent. */
import type { Ask } from "./wait.ts";

/** Where a message came from, and so where its reply goes. The gateway, peer and thread name a chat. */
export type Origin = {
	readonly gateway: string;
	readonly peer: string;
	readonly thread?: string;
};

/** The peer a gateway gives the owner, once it knows them: the owner is one person on every gateway. */
export const OWNER = "owner";

/**
 * The main chat (DESIGN.md "The app"): the one chat with the companion that is always the same, pinned first, where the
 * app opens. It is the web's owner thread of this name, so its route names it in the store and it stays the same
 * across restarts; every other chat is a side chat.
 */
export const MAIN_THREAD = "main";

/** The stable web thread of an agent's main chat. The fixed default keeps the short historic route. */
export const agentMainThread = (agent: string) => (agent === "sancho" ? MAIN_THREAD : `agent:${agent}`);

/** The agent whose main chat `origin` names, or undefined when it names a side chat. */
export const mainAgentOf = (origin: Origin): string | undefined => {
	if (origin.gateway !== "web" || origin.peer !== OWNER) return undefined;
	if (origin.thread === MAIN_THREAD) return "sancho";
	return /^agent:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(origin.thread ?? "")?.[1];
};

/** Whether `origin` is the main chat's home. */
export const isMain = (origin: Origin) =>
	origin.gateway === "web" && origin.peer === OWNER && origin.thread === MAIN_THREAD;

/** Whether `origin` is any permanent agent's main chat. */
export const isAgentMain = (origin: Origin) => mainAgentOf(origin) !== undefined;

/** An image as the model takes it. */
export type Image = { readonly data: string; readonly mimeType: string };

export type Inbound = {
	/** The gateway's id for the message, unique within the gateway; a redelivery carries the same id. */
	readonly id: string;
	readonly origin: Origin;
	readonly text: string;
	readonly images?: readonly Image[];
	/** Files that came with it, stored as blobs (inside `BlobStore.exclusive`, with this receive). */
	readonly files?: readonly Attachment[];
	/** The gateway id of the message this one replies to, when it is a reply. */
	readonly replyTo?: string;
	/** Forwarded or quoted: someone else's words, never an answer. */
	readonly forwarded?: boolean;
	/** A button pressed on an ask: the ask's id and the value the button carries. */
	readonly press?: { readonly key: string; readonly value: string };
	/**
	 * The chat it is written to, when the gateway names one rather than its origin's (the web, writing to a
	 * chat that started elsewhere). Only the owner's, to the owner's chats.
	 */
	readonly chat?: number;
	/** The agent a chat it starts runs, when not the lead: the owner's pick on the web. */
	readonly agent?: string;
};

import type { Attachment } from "./blobs.ts";

const TYPES: { readonly [extension: string]: string } = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	json: "application/json",
	html: "text/html",
	zip: "application/zip",
};

/** A file's media type by its name's extension; anything else is bytes. */
export const mimeOf = (name: string) =>
	TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Images a gateway may show inline. */
export const INLINE_IMAGES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type Outbound = {
	readonly text: string;
	/** Attachments sent with the text, after it; their bytes are blobs, the same on every resend. */
	readonly files?: readonly Attachment[];
	/** The gateway id of the message this answers. */
	readonly replyTo?: string;
	/** An ask to show with its own controls, when the gateway has them; `text` says it in words. */
	readonly ask?: { readonly key: string; readonly ask: Ask };
};

/** How well a gateway knows who is talking: all but `weak` can carry the owner. */
export type Strength = "platform" | "bearer" | "weak";

/** Resolves with what the inbound became, the same for a redelivery. */
export type Receive = (inbound: Inbound) => Promise<Received>;

/**
 * A message starts a Turn; an answer fills a Wait (`answered`, its id) and starts nothing; an answer that cannot fill
 * the Wait it names is `refused`, with why, for the gateway to tell the sender.
 */
export type Received =
	| { readonly turn: number; readonly chat: number }
	| { readonly answered: number; readonly chat: number }
	| { readonly refused: string };

export interface Gateway {
	readonly name: string;
	readonly strength: Strength;
	readonly can: { readonly buttons: boolean; readonly files: boolean; readonly threads: boolean };
	/** Start delivering inbound messages. A message counts as received once `receive` resolves. */
	start(receive: Receive): void | Promise<void>;
	stop?(): void | Promise<void>;
	/**
	 * Send `out` to `to` and resolve with the sent message's id, unique within the gateway. Throws `PermanentSendError`
	 * when the gateway rejects the message; any other throw is transient, and the same bytes are sent again later, no
	 * sooner than its `retryAfterMs` when it carries one (a rate limit).
	 */
	send(to: Origin, out: Outbound, signal: AbortSignal): Promise<string>;
	/**
	 * Show, on the gateway's message `message` that carried an ask, that the ask ended (`outcome`: a few words), such as
	 * buttons giving way to it. Throws `PermanentSendError` when the message cannot show it; other throws are retried.
	 */
	settleAsk?(to: Origin, message: string, outcome: string, signal: AbortSignal): Promise<void>;
	/** Where this gateway reaches the owner unprompted, when it can: where a notice about another origin goes. */
	ownerOrigin?(): Origin | undefined;
}

export class PermanentSendError extends Error {
	override name = "PermanentSendError";
}

/** The key naming an origin's chat; structural, so no peer or thread can spell another's. */
export function routeKey(origin: Origin): string {
	return JSON.stringify([origin.gateway, origin.peer, origin.thread ?? null]);
}

/** The key of a gateway's message in the message refs. */
export function messageKey(gateway: string, id: string): string {
	return JSON.stringify([gateway, id]);
}
