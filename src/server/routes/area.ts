/**
 * An area of the daemon (DESIGN.md "The app"): what one part of the app adds to the daemon in its own file, so the
 * parts grow side by side without editing a shared list. An area may install extensions before the store opens (tools
 * the agents get), answer requests under `/api`, and push events on the shell stream. `routes/index.ts` lists them all.
 */
import type { MutableModels } from "@earendil-works/pi-ai";
import type { Extension, Harness, ModelRef, Registry, SessionDocToken } from "@earendil-works/pi-durable";
import type { BlobStore } from "../../core/blobs.ts";
import type { defineCore } from "../../core/turn.ts";
import type { Config } from "../../home.ts";
import type { Workspace } from "../agents.ts";
import type {
	AgentView,
	CapabilitiesView,
	ChatRow,
	CompanionView,
	ControlView,
	MemoryView,
	Posted,
	PostMessage,
	SeenBy,
	ShellEvent,
} from "../api.ts";
import type { MemoryDesk } from "../memory.ts";

/** What an area may use before the store opens. */
export type Boot = {
	readonly core: ReturnType<typeof defineCore>;
	readonly blobs: BlobStore;
	readonly config: Config;
	readonly home: string;
	/** The workspace's root in the box. */
	readonly root: string;
	readonly log: (line: string) => void;
};

/** What an area may use once the daemon is up. */
export type Deps = Boot & {
	readonly harness: Harness;
	/** The tools the model is offered: an area re-installs its own extension (by its name) when they change. */
	readonly registry: Registry;
	readonly workspace: Workspace;
	readonly desk: MemoryDesk;
	readonly models: MutableModels;
	readonly seen: (model: ModelRef) => SeenBy | undefined;
	/** Tell every shell stream something changed: it reads the shell again. */
	readonly changed: () => void;
	readonly chats: () => Promise<ChatRow[]>;
	readonly companion: () => Promise<CompanionView>;
	readonly control: () => Promise<ControlView>;
	readonly agents: () => Promise<AgentView[]>;
	readonly memory: () => Promise<MemoryView>;
	readonly capabilities: () => Promise<CapabilitiesView>;
	/** A message as the owner, as `POST /api/messages` takes it; throws `BadRequest` with why it was refused. */
	readonly post: (message: PostMessage) => Promise<Posted>;
};

/** A request under `/api`, authorized: the owner's. */
export type AreaRequest = {
	readonly method: string;
	/** The path under `/api`, as `/groups/3/read`. */
	readonly path: string;
	readonly url: URL;
	/** The body as a JSON object; throws `BadRequest` when it is not one. */
	readonly json: () => Promise<Record<string, unknown>>;
	/** The paired device that asked, over Iroh, by its endpoint id; absent on the computer banda runs on. */
	readonly device?: string;
	/** Aborts when the client goes away. */
	readonly signal: AbortSignal;
};

/**
 * An area's answer: JSON (`status` 200 unless given), or a file's bytes, served as `/api/blobs` serves them (an image
 * shown, anything else downloaded, never rendered on the daemon's origin). A refusal throws `BadRequest`.
 */
export type AreaReply =
	| { readonly status?: number; readonly body: unknown }
	| { readonly file: { readonly name: string; readonly mimeType: string; readonly bytes: Buffer } };

/** A doc the shell stream watches for an area: a change pushes the shell again. */
// biome-ignore lint/suspicious/noExplicitAny: a doc of any shape
export type Watched = SessionDocToken<any>;

export type Area = {
	/** Answer a request, or undefined when it is not this area's. */
	readonly route?: (request: AreaRequest) => Promise<AreaReply | undefined>;
	/** Events for the shell stream, read on every change; each is written when it changed since the last. */
	readonly shell?: () => Promise<readonly ShellEvent[]>;
	/** Docs whose changes push the shell. */
	readonly watch?: readonly Watched[];
	/** End the area's work in flight as the daemon stops, so nothing it opened keeps the process alive. */
	readonly stop?: () => Promise<void>;
};

export type AreaModule = {
	/** Before the store opens: the extensions it installs, tools the agents get among them. */
	readonly install?: (boot: Boot) => readonly Extension[];
	/** Once the daemon is up. */
	readonly start?: (deps: Deps) => Area;
};
