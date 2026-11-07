/**
 * The daemon's HTTP server (DESIGN.md "Clients"), on loopback and over Iroh (`remote.ts`). Who a request is comes from
 * its transport. On loopback, Host and Origin are checked on every request, so a web page cannot reach it through DNS
 * rebinding or a cross-site request, and the API (`/api/`) needs the daemon's token on every request; the web UI's
 * files are public code and are served without it. Over Iroh the socket carries the endpoint id the handshake
 * authenticated: a paired device acts as the owner, with no token and whatever Host it names; any other endpoint
 * reaches the pairing route alone.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAvatarFace } from "../core/avatar-face.ts";
import { avatarIcons, avatarManifest, ICON_FILES, type IconPath } from "../core/avatar-icon.ts";
import { type Attachment, safeName, sizeOf, tooBig } from "../core/blobs.ts";

import { INLINE_IMAGES, mainAgentOf, mimeOf, OWNER } from "../core/gateway.ts";
import type { PermissionScope } from "../core/permissions.ts";
import { FULL, GLIMPSE, type Preview, preview } from "../core/preview.ts";
import type { Approving } from "../core/wait.ts";
import type { Heard } from "../gateways/cli.ts";
import type {
	AgentView,
	Answer,
	BrowserView,
	CapabilitiesView,
	ChatContext,
	ChatPrompt,
	ChatRow,
	CompanionView,
	ControlView,
	FilePreview,
	Item,
	ItemPage,
	LiveEvent,
	MemoryView,
	OwnerInput,
	Posted,
	PostedFile,
	PostMessage,
	ShellEvent,
	ViewEvent,
} from "./api.ts";
import type { BringPick, BringView } from "./bring.ts";
import type { ObjectAsk, ObjectShown } from "./objects.ts";
import { SERVED_POLICY } from "./policy.ts";
import { endpointOf } from "./remote.ts";
import type { Area, AreaReply, AreaRequest } from "./routes/area.ts";
import type { ShippedSkillsView, SkillView } from "./skills.ts";
import type { PageQuery } from "./transcript.ts";

export type Routes = {
	readonly status: () => Promise<unknown>;
	readonly companion: () => Promise<CompanionView>;
	/** Change the companion as the owner picked; throws `BadRequest` with why a pick is refused. */
	readonly change: (body: Record<string, unknown>) => Promise<CompanionView>;
	/** A message as the owner, and how its Turn ended; each message and ask sent to its thread meanwhile goes to `heard`. */
	readonly say: (
		body: { text: string; thread?: string },
		signal: AbortSignal,
		heard: (heard: Heard) => void,
	) => Promise<{ ended: string }>;
	/** Answer the open ask `key` as the owner, on the `via` client; throws `BadRequest` with why it was refused. */
	readonly answer: (
		key: string,
		answer: Answer,
		via: "web" | "cli",
		type?: "question" | "approval",
		approving?: Approving,
	) => Promise<{ chat: number }>;
	/** Dismiss an open question without putting a made-up answer in the model's context. */
	readonly dismissQuestion: (key: string) => Promise<{ chat: number }>;
	/** Take back permission `id`; false when there is no such permission. */
	readonly revoke: (id: string) => Promise<ControlView | undefined>;
	/** Allow agent `agent` to send anything to `host` (a host, `*.example.com` or `*`); throws `BadRequest` with why not. */
	readonly allowHost: (agent: string, host: string) => Promise<ControlView>;
	readonly chats: () => Promise<ChatRow[]>;
	/** Mark at most the displayed entry read; false when no chat has that id. */
	readonly read: (chat: number, through: number) => Promise<boolean>;
	readonly items: (chat: number, query: PageQuery) => Promise<ItemPage | undefined>;
	/** How full the chat's context is, against its budget; undefined when there is no such chat. */
	readonly context: (chat: number) => Promise<ChatContext | undefined>;
	/** The system prompt and tools the chat's model is sent; undefined when there is no such chat. */
	readonly prompt: (chat: number, at?: number) => Promise<ChatPrompt | undefined>;
	readonly live: (chat: number, write: (event: LiveEvent) => void, signal: AbortSignal) => Promise<boolean>;
	readonly post: (message: PostMessage) => Promise<Posted>;
	/** What the daemon takes: how much one file may weigh, in bytes. */
	readonly limits: () => { readonly fileBytes: number };
	/** Store an uploaded file as a blob, for a message to name; one no message names is swept within hours. */
	readonly upload: (name: string, bytes: Buffer) => Promise<Attachment>;
	/** A blob some chat holds, with its media type; undefined when none does. */
	readonly blob: (sha: string) => Promise<{ readonly mimeType: string; readonly bytes: Buffer } | undefined>;
	/** The `n`th file a `message_user` call sent, or undefined when there is none. */
	readonly file: (
		chat: number,
		call: string,
		n: number,
	) => Promise<{ readonly attachment: Attachment; readonly bytes: Buffer } | undefined>;
	/** The `n`th image of a transcript item, or undefined when there is none. */
	readonly image: (chat: number, item: number, n: number) => Promise<{ data: Buffer; mimeType: string } | undefined>;
	/** The chat list, now and whenever they change, until `signal` aborts. */
	readonly shell: (write: (event: ShellEvent) => void, signal: AbortSignal) => Promise<void>;
	/** Stop the chat's run and its queued inputs; false when there is no such chat. */
	readonly stop: (chat: number) => Promise<boolean>;
	readonly retry: (task: number) => Promise<boolean>;
	/** A public icon reads accepted store data only, never pending box files. */
	readonly iconFace?: () => Promise<import("../core/avatar-face.ts").AvatarFace | undefined>;
	/** Every agent, with the change its file in the box holds. */
	readonly agents: () => Promise<AgentView[]>;
	readonly skills: () => Promise<SkillView[]>;
	readonly acceptSkill: (name: string, sha: string) => Promise<SkillView[]>;
	/** Accept every listed proposal by the hash the owner saw, all or none. */
	readonly acceptSkills: (wanted: readonly { name: string; sha: string }[]) => Promise<SkillView[]>;
	readonly saveSkill: (name: string, text: string, base: string | null) => Promise<SkillView[]>;
	/** The skills banda ships, and whether the owner chose from them at first run. */
	readonly shippedSkills: () => Promise<ShippedSkillsView>;
	/** Add the shipped skills picked, accepted; none skips. Either way they are not offered again. */
	readonly chooseShippedSkills: (names: readonly string[]) => Promise<ShippedSkillsView>;
	/** What the other harnesses on this computer have to import, and whether the owner chose at first run. */
	readonly bringable: () => Promise<BringView>;
	/** Import the skills and agents picked; none skips. Either way the step is not offered again. */
	readonly chooseBring: (picks: {
		readonly skills: readonly BringPick[];
		readonly agents: readonly BringPick[];
	}) => Promise<BringView>;
	/** Throws `BadRequest` when the file changed since `sha` was shown, or does not parse. */
	readonly accept: (name: string, sha: string | null) => Promise<AgentView[]>;
	readonly decline: (name: string) => Promise<AgentView[]>;
	/** Save the owner's reviewed definition, accepted at once; `base` is null for a new agent. */
	readonly saveAgent: (name: string, text: string, base: string | null) => Promise<AgentView[]>;
	/** The control room, from the store. */
	readonly control: () => Promise<ControlView>;
	/** Pause everything, or resume. */
	readonly pause: (paused: boolean) => Promise<ControlView>;
	/**
	 * The owner acts on routine `name`: allows the change shown (`sha`, null for a removal), declines it, pauses or resumes
	 * it, removes it, or sets how often it speaks up (null: as the companion does). Throws `BadRequest` with why not.
	 */
	readonly routine: (name: string, action: RoutineAction) => Promise<ControlView>;
	/** What the companion knows, and the core's changes waiting for the owner. */
	readonly memory: () => Promise<MemoryView>;
	/** The owner acts on memory; each throws `BadRequest` with why not, and answers with memory as it is after. */
	readonly fact: (action: FactAction) => Promise<MemoryView>;
	/** One item of a chat's transcript (the message a fact came from), or undefined when there is none. */
	readonly item: (chat: number, item: number) => Promise<Item | undefined>;
	/** What the companion can use: its connections and the tools it made, with the changes waiting. */
	readonly capabilities: () => Promise<CapabilitiesView>;
	/** The owner acts on a connection or a tool; throws `BadRequest` with why not; the capabilities as they are after. */
	readonly capability: (action: CapabilityAction) => Promise<CapabilitiesView>;
	readonly addMcp?: (config: unknown) => Promise<{ name: string; capabilities: CapabilitiesView }>;
	/** Start signing in to a connection: the page the owner's browser opens, or the code they type on the server's page. */
	readonly signIn: (
		name: string,
		agent?: string,
	) => Promise<
		| { readonly url: string }
		| { readonly code: string; readonly page: string; readonly expires: number }
		| { readonly connected: true }
	>;
	/** The owner's browser came back from signing in (no token: the state names the sign-in, once). */
	readonly callback: (query: {
		readonly state?: string;
		readonly code?: string;
		readonly error?: string;
		readonly iss?: string;
	}) => Promise<{ readonly ok: boolean; readonly words: string }>;
	/**
	 * What to draw for the links and objects of a message in chat `chat` (DESIGN.md "Connections", objects): a card read
	 * as the account its agent uses, the connect card, or a plain link; `refresh`, the owner tapped one.
	 */
	readonly objects?: (chat: number, asks: readonly ObjectAsk[], refresh: boolean) => Promise<ObjectShown[]>;
	/** Chat `chat`'s tab as the owner sees it: its state, and its frames while they watch, until `signal` aborts. */
	readonly browser?: (chat: number, write: (event: ViewEvent) => void, signal: AbortSignal) => Promise<void>;
	/** The owner takes chat `chat`'s tab, or gives it back; throws `BadRequest` with why not. */
	readonly browserControl?: (chat: number, hold: boolean) => Promise<BrowserView>;
	/** The owner's input on chat `chat`'s tab's live view; throws `BadRequest` unless they hold it. */
	readonly browserInput?: (chat: number, input: OwnerInput) => Promise<void>;
	/** Sign `agent`'s browser out of `site`: its session forgotten. */
	readonly signOut?: (agent: string, site: string) => Promise<CapabilitiesView>;
};

/** What the owner does to a connection or a tool the companion made, from the app. */
export type CapabilityAction =
	| {
			readonly action: "accept";
			readonly folder: "connections" | "tools";
			readonly name: string;
			readonly sha: string | null;
	  }
	| { readonly action: "decline" | "remove"; readonly folder: "connections" | "tools"; readonly name: string }
	| { readonly action: "disconnect"; readonly name: string }
	| { readonly action: "key"; readonly name: string; readonly key: unknown; readonly agent?: string }
	| {
			readonly action: "account";
			readonly name: string;
			readonly account: string;
			readonly sha?: string;
			readonly agent: string;
			readonly on: boolean;
	  }
	| { readonly action: "signout"; readonly name: string; readonly account: string }
	| { readonly action: "scopes"; readonly name: string; readonly scopes: unknown }
	| { readonly action: "add"; readonly name: string }
	| { readonly action: "address"; readonly url: unknown }
	| { readonly action: "trust" | "reads"; readonly name: string; readonly tools: unknown; readonly sha?: string }
	| {
			readonly action: "public";
			readonly name: string;
			readonly agent: string;
			readonly on: boolean;
			readonly sha?: string;
	  }
	| { readonly action: "refresh"; readonly name: string }
	| { readonly action: "switch"; readonly tool: string; readonly on: boolean };

/** What the owner does to memory from the app. */
export type FactAction =
	| { readonly action: "add"; readonly body: Record<string, unknown> }
	| { readonly action: "edit"; readonly id: string; readonly text: unknown }
	| { readonly action: "delete"; readonly id: string };

/** What the owner does to a routine from the app. */
export type RoutineAction =
	| { readonly action: "accept"; readonly sha: string | null }
	| { readonly action: "decline" | "pause" | "resume" | "remove" };

/** The built web UI (`npm run build:web`); the same path from `src/server` and `dist/server`. */
export const WEB = fileURLToPath(new URL("../../web/dist/", import.meta.url));

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".json": "application/json",
};

/** Image types a transcript serves; anything else is not served as an image. */
const IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How a request that came over Iroh is let in: by the endpoint id its handshake authenticated. */
export type RemoteGate = {
	/** Whether endpoint `id` is a paired device the owner has not revoked: such a device acts as the owner. */
	readonly paired: (id: string) => Promise<boolean>;
	/** `/api/devices/pair`, the one route an endpoint that is not a paired device reaches; undefined is a 404. */
	readonly pair: (id: string, request: AreaRequest) => Promise<AreaReply | undefined>;
	/** Told of each request a paired device makes, before it is served: the daemon logs which device asked. */
	readonly heard?: (id: string, method: string, path: string) => void;
};

/** The one path any endpoint may ask for over Iroh. */
export const PAIR_PATH = "/api/devices/pair";

/** The most of a pairing request read, before the daemon knows who asks: an invite's secret and a name fit in it. */
export const PAIR_BODY = 4 * 1024;

/** The most of any JSON body read: an artifact's text is the largest; files go up as blobs. */
export const JSON_BODY = 64 * 1024 * 1024;

export function handler(
	routes: Routes,
	port: () => number,
	token: string,
	web = WEB,
	/** The areas' own routes (`routes/area.ts`), tried in order after the daemon's. */
	areas: readonly Area[] = [],
	/** Requests over Iroh; without it, every one is refused. */
	remote?: RemoteGate,
): RequestListener {
	const icons = avatarIcons();
	const defaultFace = defaultAvatarFace();
	return (req, res) => {
		void serve(req, res).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) reply(res, error instanceof BadRequest ? error.status : 500, { error: message });
			else res.destroy();
		});
	};

	async function serve(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://local");
		const device = endpointOf(req.socket);
		if (device === undefined) {
			const local = [`127.0.0.1:${port()}`, `localhost:${port()}`];
			if (!local.includes(req.headers.host ?? "")) return reply(res, 403, { error: "bad host" });
			const origin = req.headers.origin;
			if (origin !== undefined && !local.some((host) => origin === `http://${host}`))
				return reply(res, 403, { error: "bad origin" });
		} else {
			// one request a stream: its response ends the stream
			res.setHeader("connection", "close");
			if (remote === undefined) return reply(res, 403, { error: "this device is not paired" });
			if (url.pathname === PAIR_PATH) {
				const gone = new AbortController();
				res.on("close", () => gone.abort(new Error("client went away")));
				const answered = await remote.pair(device, {
					method: req.method ?? "GET",
					path: url.pathname.slice("/api".length),
					url,
					json: () => json(req, PAIR_BODY),
					device,
					signal: gone.signal,
				});
				if (answered === undefined || "file" in answered) return reply(res, 404, { error: "not found" });
				return reply(res, answered.status ?? 200, answered.body);
			}
			if (!(await remote.paired(device))) return reply(res, 403, { error: "this device is not paired" });
			remote.heard?.(device, req.method ?? "GET", url.pathname);
		}
		if (url.pathname === "/oauth/callback" && req.method === "GET") {
			// a sign-in coming back: no token (a browser redirect carries none), its state names the sign-in, once
			const param = (name: string) => url.searchParams.get(name) ?? undefined;
			const state = param("state");
			const code = param("code");
			const error = param("error");
			const iss = param("iss");
			const done = await routes.callback({
				...(state === undefined ? {} : { state }),
				...(code === undefined ? {} : { code }),
				...(error === undefined ? {} : { error }),
				...(iss === undefined ? {} : { iss }),
			});
			if (done.ok) return void res.writeHead(302, { location: "/#/connections", "cache-control": "no-store" }).end();
			return void res
				.writeHead(400, {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": "default-src 'none'",
					"referrer-policy": "no-referrer",
				})
				.end(
					`<!doctype html><meta charset="utf-8"><title>banda</title><p>${escapeHtml(done.words)}</p><p><a href="/#/connections">Back to banda</a></p>`,
				);
		}
		if (Object.hasOwn(ICON_FILES, url.pathname) || url.pathname === "/manifest.webmanifest") {
			if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed" });
			// Install clients carry no token. Expose only the first accepted face, never a pending candidate,
			// name or personality. Host/Origin above and CORP below retain the public icon's same-origin policy.
			if (req.headers["sec-fetch-site"] === "cross-site") return reply(res, 403, { error: "bad origin" });
			const face = await routes.iconFace?.().catch(() => undefined);
			let drawing: ReturnType<typeof icons>;
			try {
				drawing = icons(face ?? defaultFace);
			} catch {
				// Malformed stored candidates are never rendered or echoed in an unauthenticated error.
				drawing = icons(defaultFace);
			}
			const manifest = url.pathname === "/manifest.webmanifest";
			const image = manifest ? undefined : drawing.image(url.pathname as IconPath);
			const bytes = image?.bytes ?? Buffer.from(avatarManifest(drawing.revision));
			const etag = image?.etag ?? `"${createHash("sha256").update(bytes).digest("hex")}"`;
			const matches = req.headers["if-none-match"]?.split(",").some((tag) => {
				const value = tag.trim().replace(/^W\//, "");
				return value === etag || value === "*";
			});
			res.writeHead(matches ? 304 : 200, {
				"content-type": image?.type ?? "application/manifest+json",
				"content-security-policy": "default-src 'none'",
				"cross-origin-resource-policy": "same-origin",
				"x-content-type-options": "nosniff",
				// Version hints do not select historical identities: even an old URL always revalidates the current one.
				"cache-control": "private, no-cache",
				etag,
				...(matches ? {} : { "content-length": bytes.length }),
			});
			return void res.end(matches || req.method === "HEAD" ? undefined : bytes);
		}
		if (!url.pathname.startsWith("/api/")) {
			if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed" });
			return file(res, web, url.pathname);
		}
		// a paired device is the owner by its endpoint id, and never needs the token
		if (device === undefined && !authorized(req.headers.authorization))
			return reply(res, 401, { error: "missing or wrong token" });
		const path = url.pathname.slice("/api".length);
		const route = `${req.method} ${path}`;
		const gone = new AbortController();
		res.on("close", () => gone.abort(new Error("client went away")));
		if (route === "GET /status") return reply(res, 200, await routes.status());
		if (route === "GET /companion") return reply(res, 200, await routes.companion());
		if (route === "PUT /companion") return reply(res, 200, await routes.change(await json(req)));
		if (route === "POST /say") {
			const body = await json(req);
			if (typeof body.text !== "string" || body.text === "") return reply(res, 400, { error: "text is required" });
			if (body.thread !== undefined && typeof body.thread !== "string")
				return reply(res, 400, { error: "thread must be a string" });
			const said = { text: body.text, ...(body.thread === undefined ? {} : { thread: body.thread }) };
			// newline-delimited JSON: a `message` or `ask` line for each sent meanwhile, then how it `ended`, or an `error`
			const line = (value: unknown) => {
				if (!res.headersSent)
					res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
				res.write(`${JSON.stringify(value)}\n`);
			};
			try {
				line(await routes.say(said, gone.signal, line));
			} catch (error) {
				if (!res.headersSent) throw error;
				line({ error: error instanceof Error ? error.message : String(error) });
			}
			return void res.end();
		}
		const waited = /^\/waits\/([2-9a-hjkmnp-z]{10})(?:\/(dismiss))?$/.exec(path);
		if (waited !== null && req.method === "POST") {
			if (waited[2] === "dismiss") return reply(res, 200, await routes.dismissQuestion(waited[1] ?? ""));
			const { answer, via, type, edits, permission } = await json(req);
			if (via !== undefined && via !== "web" && via !== "cli") return reply(res, 400, { error: "via is web or cli" });
			if (type !== undefined && type !== "question" && type !== "approval")
				return reply(res, 400, { error: "type is question or approval" });
			// the shape only: whether it fits the ask is the Wait's to say
			const valid =
				typeof answer === "string" ||
				(Array.isArray(answer) && answer.every((value) => typeof value === "string")) ||
				(typeof answer === "object" &&
					answer !== null &&
					!Array.isArray(answer) &&
					Object.values(answer).every((value) => ["string", "number", "boolean"].includes(typeof value)));
			if (!valid)
				return reply(res, 400, {
					error: "answer is text, a list of picks, or an object of text, number and yes/no values",
				});
			if (
				edits !== undefined &&
				(typeof edits !== "object" ||
					edits === null ||
					Array.isArray(edits) ||
					!Object.values(edits).every((value) => typeof value === "string"))
			)
				return reply(res, 400, { error: "edits are the draft's text, by argument" });
			const scope = permissionOf(permission);
			if (scope === null)
				return reply(res, 400, {
					error: 'permission is {scope: "task"}, {scope: "until", until: <ms>}, {scope: "always"} or {scope: "host"}',
				});
			const approving: Approving = {
				...(edits === undefined ? {} : { edits: edits as { [arg: string]: string } }),
				...(scope === undefined ? {} : { permission: scope }),
			};
			return reply(res, 200, await routes.answer(waited[1] ?? "", answer as Answer, via ?? "web", type, approving));
		}
		if (route === "GET /chats") return reply(res, 200, await routes.chats());
		const reading = /^\/chats\/(\d+)\/read$/.exec(path);
		if (reading !== null && req.method === "POST") {
			const { through } = await json(req);
			if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0)
				return reply(res, 400, { error: "through must be a transcript entry id already shown" });
			return (await routes.read(Number(reading[1]), through))
				? reply(res, 200, { read: true })
				: reply(res, 404, { error: "no such chat" });
		}
		const retrying = /^\/tasks\/(\d+)\/retry$/.exec(path);
		if (retrying !== null && req.method === "POST")
			return (await routes.retry(Number(retrying[1])))
				? reply(res, 200, { retried: true })
				: reply(res, 404, { error: "no parked task has that id" });
		if (route === "GET /limits") return reply(res, 200, routes.limits());
		if (route === "POST /blobs") {
			const name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
			if (name === "") return reply(res, 400, { error: "the x-file-name header names the file" });
			return reply(res, 200, await routes.upload(name, await uploaded(req, name, routes.limits().fileBytes)));
		}
		// what the daemon draws of a file attached in the composer, before it is sent: nothing is kept
		if (route === "POST /previews") {
			const name = safeName(decodeURIComponent(String(req.headers["x-file-name"] ?? "")));
			const bytes = await uploaded(req, name, routes.limits().fileBytes);
			return reply(res, 200, { preview: preview(name, mimeOf(name), bytes) });
		}
		const drawn = /^\/blobs\/([0-9a-f]{64})\/preview$/.exec(path);
		if (req.method === "GET" && drawn !== null) {
			const sha = drawn[1] ?? "";
			const found = await routes.blob(sha);
			if (found === undefined) return reply(res, 404, { error: "no such blob" });
			const name = safeName(url.searchParams.get("name") ?? "file");
			return reply(
				res,
				200,
				filePreview({ sha, name, mimeType: found.mimeType, size: found.bytes.length }, found.bytes, full(url)),
			);
		}
		const sentDrawn = /^\/chats\/(\d+)\/messages\/([^/]+)\/files\/(\d+)\/preview$/.exec(path);
		if (req.method === "GET" && sentDrawn !== null) {
			const [, chat, call, n] = sentDrawn;
			const found = await routes.file(Number(chat), decodeURIComponent(call ?? ""), Number(n));
			if (found === undefined) return reply(res, 404, { error: "no such file" });
			return reply(res, 200, filePreview(found.attachment, found.bytes, full(url)));
		}
		const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(path);
		if (req.method === "GET" && blob !== null) {
			const found = await routes.blob(blob[1] ?? "");
			if (found === undefined) return reply(res, 404, { error: "no such blob" });
			return download(res, { name: url.searchParams.get("name") ?? "file", mimeType: found.mimeType }, found.bytes);
		}
		if (route === "POST /messages") {
			const { id, thread, chat, text, files: posted, agent } = await json(req);
			if (typeof id !== "string" || !UUID.test(id)) return reply(res, 400, { error: "id must be a UUID" });
			const files = postedFiles(posted);
			if (files === undefined) return reply(res, 400, { error: "files are up to ten {sha, name} of uploaded blobs" });
			if (typeof text !== "string" || (text.trim() === "" && files.length === 0))
				return reply(res, 400, { error: "text or files are required" });
			const attached = files.length === 0 ? {} : { files };
			if (chat !== undefined) {
				if (thread !== undefined || typeof chat !== "number" || !Number.isSafeInteger(chat) || chat < 1)
					return reply(res, 400, { error: "chat is a chat's id, without a thread" });
				return reply(res, 200, await routes.post({ id, chat, text, ...attached }));
			}
			// a new thread is the browser's UUID or a permanent agent's stable main thread
			if (typeof thread !== "string")
				return reply(res, 400, { error: "thread must be a UUID, or an agent's main one" });
			const mainAgent = mainAgentOf({ gateway: "web", peer: OWNER, thread });
			if (!UUID.test(thread) && mainAgent === undefined)
				return reply(res, 400, { error: "thread must be a UUID, or an agent's main one" });
			if (agent !== undefined && typeof agent !== "string")
				return reply(res, 400, { error: "agent is an agent's name" });
			if (mainAgent !== undefined && agent !== undefined && agent !== mainAgent)
				return reply(res, 400, { error: `this is ${mainAgent}'s main chat, not ${agent}'s` });
			const selectedAgent = mainAgent ?? agent;
			return reply(
				res,
				200,
				await routes.post({
					id,
					thread,
					text,
					...attached,
					...(selectedAgent === undefined ? {} : { agent: selectedAgent }),
				}),
			);
		}
		if (route === "GET /skills") return reply(res, 200, await routes.skills());
		if (route === "POST /skills") {
			const { accept } = await json(req);
			if (
				!Array.isArray(accept) ||
				!accept.every(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						typeof item.name === "string" &&
						typeof item.sha === "string" &&
						/^[0-9a-f]{64}$/.test(item.sha),
				)
			)
				return reply(res, 400, { error: "accept is a list of { name, sha } you saw" });
			return reply(
				res,
				200,
				await routes.acceptSkills(accept.map(({ name, sha }: { name: string; sha: string }) => ({ name, sha }))),
			);
		}
		if (route === "GET /skills/shipped") return reply(res, 200, await routes.shippedSkills());
		if (route === "POST /skills/shipped") {
			const { add } = await json(req);
			if (!Array.isArray(add) || !add.every((name) => typeof name === "string"))
				return reply(res, 400, { error: "add is the names of the shipped skills picked; none skips" });
			return reply(res, 200, await routes.chooseShippedSkills(add));
		}
		if (route === "GET /bring") return reply(res, 200, await routes.bringable());
		if (route === "POST /bring") {
			const { skills, agents } = await json(req);
			const picks = (list: unknown): BringPick[] | undefined =>
				Array.isArray(list) &&
				list.every(
					(pick) =>
						typeof pick === "object" &&
						pick !== null &&
						typeof pick.harness === "string" &&
						typeof pick.name === "string",
				)
					? list.map(({ harness, name }: BringPick) => ({ harness, name }))
					: undefined;
			const wanted = { skills: picks(skills), agents: picks(agents) };
			if (wanted.skills === undefined || wanted.agents === undefined)
				return reply(res, 400, { error: "skills and agents are lists of { harness, name } picked; none skips" });
			return reply(res, 200, await routes.chooseBring({ skills: wanted.skills, agents: wanted.agents }));
		}
		const skill = /^\/skills\/([a-z0-9-]+)(?:\/(accept))?$/.exec(path);
		if (skill !== null) {
			const [, name = "", action] = skill;
			if (action === undefined && req.method === "PUT") {
				const { text, base } = await json(req);
				if (typeof text !== "string" || (base !== null && (typeof base !== "string" || !/^[0-9a-f]{64}$/.test(base))))
					return reply(res, 400, { error: "text is SKILL.md and base is its accepted hash, or null" });
				return reply(res, 200, await routes.saveSkill(name, text, base));
			}
			if (action === "accept" && req.method === "POST") {
				const { sha } = await json(req);
				if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha))
					return reply(res, 400, { error: "sha is the hash of the proposed file you saw" });
				return reply(res, 200, await routes.acceptSkill(name, sha));
			}
			return reply(res, 405, { error: "method not allowed" });
		}
		if (route === "GET /agents") return reply(res, 200, await routes.agents());
		const agent = /^\/agents\/([a-z0-9-]+)(?:\/(accept|decline))?$/.exec(path);
		if (agent !== null) {
			const [, name = "", action] = agent;
			if (action === undefined && req.method === "PUT") {
				const { text, base } = await json(req);
				if (typeof text !== "string") return reply(res, 400, { error: "text is the reviewed agent definition" });
				if (base !== null && (typeof base !== "string" || !/^[0-9a-f]{64}$/.test(base)))
					return reply(res, 400, { error: "base is the accepted hash, or null for a new agent" });
				return reply(res, 200, await routes.saveAgent(name, text, base));
			}
			if (action === "accept" && req.method === "POST") {
				const { sha } = await json(req);
				if (sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)))
					return reply(res, 400, { error: "sha is the hash of the text shown, or null for a removal" });
				return reply(res, 200, await routes.accept(name, sha));
			}
			if (action === "decline" && req.method === "POST") return reply(res, 200, await routes.decline(name));
			return reply(res, 405, { error: "method not allowed" });
		}
		if (route === "GET /control") return reply(res, 200, await routes.control());
		const revoking = /^\/permissions\/(\d+)\/revoke$/.exec(path);
		if (revoking !== null && req.method === "POST") {
			const after = await routes.revoke(revoking[1] ?? "");
			return after === undefined ? reply(res, 404, { error: "no such permission" }) : reply(res, 200, after);
		}
		const hosting = /^\/agents\/([a-z0-9-]+)\/hosts$/.exec(path);
		if (hosting !== null && req.method === "POST") {
			const { host } = await json(req);
			if (typeof host !== "string") return reply(res, 400, { error: "host is the host to allow" });
			return reply(res, 200, await routes.allowHost(hosting[1] ?? "", host));
		}
		if (route === "POST /control/pause") return reply(res, 200, await routes.pause(true));
		if (route === "POST /control/resume") return reply(res, 200, await routes.pause(false));
		const routine = /^\/routines\/([a-z0-9-]+)\/(accept|decline|pause|resume|remove)$/.exec(path);
		if (routine !== null && req.method === "POST") {
			const [, name = "", action] = routine;
			if (action === "accept") {
				const { sha } = await json(req);
				if (sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)))
					return reply(res, 400, { error: "sha is the hash of the text shown, or null for a removal" });
				return reply(res, 200, await routes.routine(name, { action, sha }));
			}

			return reply(
				res,
				200,
				await routes.routine(name, { action: action as "decline" | "pause" | "resume" | "remove" }),
			);
		}
		if (route === "GET /memory") return reply(res, 200, await routes.memory());
		if (route === "POST /memory") return reply(res, 200, await routes.fact({ action: "add", body: await json(req) }));
		const fact = /^\/memory\/(m[0-9a-f]{10})$/.exec(path);
		if (fact !== null) {
			const [, id = ""] = fact;
			if (req.method === "PUT")
				return reply(res, 200, await routes.fact({ action: "edit", id, text: (await json(req)).text }));
			if (req.method === "DELETE") return reply(res, 200, await routes.fact({ action: "delete", id }));
			return reply(res, 405, { error: "method not allowed" });
		}
		const oneItem = /^\/chats\/(\d+)\/items\/(\d+)$/.exec(path);
		if (oneItem !== null && req.method === "GET") {
			const found = await routes.item(Number(oneItem[1]), Number(oneItem[2]));
			return found === undefined ? reply(res, 404, { error: "no such item" }) : reply(res, 200, found);
		}
		if (route === "POST /objects" && routes.objects !== undefined) {
			const { chat, asks, refresh } = await json(req);
			if (typeof chat !== "number" || !Number.isSafeInteger(chat) || chat <= 0)
				throw new BadRequest("chat is a chat's number");
			if (!Array.isArray(asks) || asks.length > 8) throw new BadRequest("asks is a list of at most 8");
			const text = (value: unknown, max: number) =>
				typeof value === "string" && value.length > 0 && value.length <= max;
			const checked = asks.map((ask: unknown): ObjectAsk => {
				const given = (ask ?? {}) as { ref?: unknown; refs?: unknown; account?: unknown; agent?: unknown };
				if (given.agent !== undefined && !text(given.agent, 100)) throw new BadRequest("agent is a member's name");
				const attribution = given.agent === undefined ? {} : { agent: given.agent as string };
				if (text(given.ref, 500)) return { ref: given.ref as string, ...attribution };
				if (
					Array.isArray(given.refs) &&
					given.refs.length > 0 &&
					given.refs.length <= 4 &&
					given.refs.every((each) => text(each, 500)) &&
					(given.account === undefined || text(given.account, 100))
				)
					return {
						refs: given.refs as string[],
						...attribution,
						...(given.account === undefined ? {} : { account: given.account as string }),
					};
				throw new BadRequest("each ask is {ref} or {refs, account}");
			});
			return reply(res, 200, await routes.objects(chat, checked, refresh === true));
		}
		if (route === "GET /capabilities") return reply(res, 200, await routes.capabilities());
		if (route === "POST /capabilities/mcp" && routes.addMcp !== undefined)
			return reply(res, 200, await routes.addMcp(await json(req)));
		// the owner adds a server by its address: the daemon finds how it signs in, writes its file and allows it
		if (route === "POST /capabilities/connections")
			return reply(res, 200, await routes.capability({ action: "address", url: (await json(req)).url }));
		const capability =
			/^\/capabilities\/(connections|tools)\/([a-z0-9-]{1,64})\/(accept|decline|remove|signin|key|scopes|add|trust|disconnect|public|refresh|reads)$/.exec(
				path,
			);
		if (capability !== null && req.method === "POST") {
			const [, folder = "", name = "", action = ""] = capability;
			const kind = folder as "connections" | "tools";
			if (action === "signin" && kind === "connections") {
				const { agent } = await json(req);
				if (agent !== undefined && (typeof agent !== "string" || !/^[a-z0-9-]{1,64}$/.test(agent)))
					throw new BadRequest("agent names an agent");
				return reply(res, 200, await routes.signIn(name, agent as string | undefined));
			}
			if (action === "accept") {
				const { sha } = await json(req);
				if (sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)))
					throw new BadRequest("sha must be the hash shown, or null for a removal");
				return reply(res, 200, await routes.capability({ action, folder: kind, name, sha }));
			}
			if (action === "decline" || action === "remove")
				return reply(res, 200, await routes.capability({ action, folder: kind, name }));
			if (action === "key" && kind === "connections") {
				const { key, agent } = await json(req);
				if (agent !== undefined && (typeof agent !== "string" || !/^[a-z0-9-]{1,64}$/.test(agent)))
					throw new BadRequest("agent names an agent");
				return reply(
					res,
					200,
					await routes.capability({ action, name, key, ...(agent === undefined ? {} : { agent: agent as string }) }),
				);
			}
			if (action === "add" && kind === "connections") return reply(res, 200, await routes.capability({ action, name }));
			if ((action === "trust" || action === "reads") && kind === "connections") {
				const { tools, sha } = await json(req);
				if ((action === "reads" || sha !== undefined) && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)))
					throw new BadRequest("sha is the reviewed connection hash");
				return reply(
					res,
					200,
					await routes.capability({ action, name, tools, ...(sha === undefined ? {} : { sha: sha as string }) }),
				);
			}
			if (action === "public" && kind === "connections") {
				const { agent, on, sha } = await json(req);
				if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)))
					throw new BadRequest("sha is the reviewed connection hash");
				if (typeof on !== "boolean" || typeof agent !== "string" || !/^[a-z0-9-]{1,64}$/.test(agent))
					throw new BadRequest("Choose an agent and whether it has access");
				return reply(
					res,
					200,
					await routes.capability({ action, name, agent, on, ...(sha === undefined ? {} : { sha: sha as string }) }),
				);
			}
			if (action === "refresh" && kind === "connections")
				return reply(res, 200, await routes.capability({ action, name }));
			if (action === "scopes" && kind === "connections")
				return reply(res, 200, await routes.capability({ action, name, scopes: (await json(req)).scopes }));
			if (action === "disconnect" && kind === "connections")
				return reply(res, 200, await routes.capability({ action, name }));
			return reply(res, 404, { error: "not found" });
		}
		// an account of a connection: switched on or off for an agent, or signed out
		const account =
			/^\/capabilities\/connections\/([a-z0-9-]{1,64})\/accounts\/([a-z0-9._@+-]{1,100})\/(switch|signout)$/.exec(path);
		if (account !== null && req.method === "POST") {
			const [, name = "", key = "", action] = account;
			if (action === "signout")
				return reply(res, 200, await routes.capability({ action: "signout", name, account: key }));
			const { agent, on, sha } = await json(req);
			if (sha !== undefined && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)))
				throw new BadRequest("sha is the reviewed connection hash");
			if (typeof on !== "boolean") throw new BadRequest("on is true or false");
			if (typeof agent !== "string" || !/^[a-z0-9-]{1,64}$/.test(agent)) throw new BadRequest("agent names an agent");
			return reply(
				res,
				200,
				await routes.capability({
					action: "account",
					name,
					account: key,
					agent,
					on,
					...(sha === undefined ? {} : { sha: sha as string }),
				}),
			);
		}
		const switching = /^\/capabilities\/tools\/([A-Za-z0-9_-]{1,64})\/switch$/.exec(path);
		if (switching !== null && req.method === "POST") {
			const { on } = await json(req);
			if (typeof on !== "boolean") throw new BadRequest("on is true or false");
			return reply(res, 200, await routes.capability({ action: "switch", tool: switching[1] ?? "", on }));
		}
		if (route === "GET /events") {
			// one stream a page: the shell, and the live events of the chat it shows (`?chat=`), each tagged with it, so
			// a browser's few connections to the daemon are never all taken by streams
			const chat = Number(url.searchParams.get("chat") ?? Number.NaN);
			return events<ShellEvent>(res, async (write) => {
				const live =
					Number.isSafeInteger(chat) && chat > 0
						? routes
								.live(chat, (event) => write({ type: "live", chat, event }), gone.signal)
								.then((found) => {
									if (!found) write({ type: "live", chat, event: { type: "gone" } });
								})
						: Promise.resolve();
				await Promise.all([routes.shell(write, gone.signal), live]);
				return true;
			});
		}
		// a chat's tab, in the browser of the agent it runs
		const tab = /^\/chats\/(\d{1,12})\/browser(?:\/(control|input))?$/.exec(path);
		if (tab !== null) {
			const chat = Number(tab[1]);
			const rest = tab[2];
			if (rest === undefined && req.method === "GET" && routes.browser !== undefined) {
				const watching = routes.browser;
				// a frame a slow screen cannot take yet is dropped: the next one shows the page as it is
				return events<ViewEvent>(
					res,
					(write) => watching(chat, write, gone.signal).then(() => true),
					"no browser",
					(event) => event.type === "frame" && res.writableLength > 1 << 20,
				);
			}
			if (rest === "control" && req.method === "POST" && routes.browserControl !== undefined) {
				const { hold } = await json(req);
				if (typeof hold !== "boolean") throw new BadRequest("hold is true or false");
				return reply(res, 200, await routes.browserControl(chat, hold));
			}
			if (rest === "input" && req.method === "POST" && routes.browserInput !== undefined) {
				await routes.browserInput(chat, ownerInput(await json(req)));
				return reply(res, 200, {});
			}
		}
		// a site an agent's browser is signed in to
		const signingOut = /^\/browsers\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/sites\/([^/]+)$/.exec(path);
		if (signingOut !== null && req.method === "DELETE" && routes.signOut !== undefined)
			return reply(res, 200, await routes.signOut(signingOut[1] ?? "", decodeURIComponent(signingOut[2] ?? "")));
		const stopping = /^\/chats\/(\d+)\/stop$/.exec(path);
		if (stopping !== null && req.method === "POST")
			return (await routes.stop(Number(stopping[1])))
				? reply(res, 200, { stopped: true })
				: reply(res, 404, { error: "no such chat" });
		const sentFile = /^\/chats\/(\d+)\/messages\/([^/]+)\/files\/(\d+)$/.exec(path);
		if (req.method === "GET" && sentFile !== null) {
			const [, chat, call, n] = sentFile;
			const found = await routes.file(Number(chat), decodeURIComponent(call ?? ""), Number(n));
			if (found === undefined) return reply(res, 404, { error: "no such file" });
			// an image the browser shows; anything else only downloads, never renders on the daemon's origin
			return download(res, found.attachment, found.bytes);
		}
		const image = /^\/chats\/(\d+)\/items\/(\d+)\/images\/(\d+)$/.exec(path);
		if (req.method === "GET" && image !== null) {
			const found = await routes.image(Number(image[1]), Number(image[2]), Number(image[3]));
			if (found === undefined || !IMAGES.has(found.mimeType)) return reply(res, 404, { error: "no such image" });
			res.writeHead(200, {
				"content-type": found.mimeType,
				"content-security-policy": "default-src 'none'",
				"x-content-type-options": "nosniff",
				"cache-control": "private, max-age=31536000, immutable",
			});
			return void res.end(found.data);
		}
		const chat = /^\/chats\/(\d+)\/(items|events|context|prompt)$/.exec(path);
		if (req.method === "GET" && chat !== null) {
			const id = Number(chat[1]);
			if (chat[2] === "context") {
				const found = await routes.context(id);
				return found === undefined ? reply(res, 404, { error: "no such chat" }) : reply(res, 200, found);
			}
			if (chat[2] === "prompt") {
				const value = url.searchParams.get("at");
				const at = value === null ? undefined : Number(value);
				if (at !== undefined && (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(at) || at < 1))
					return reply(res, 400, { error: "at must be an entry id" });
				const found = await routes.prompt(id, at);
				return found === undefined ? reply(res, 404, { error: "no such chat" }) : reply(res, 200, found);
			}
			if (chat[2] === "items") {
				const query: { -readonly [K in keyof PageQuery]: PageQuery[K] } = {};
				for (const key of ["after", "before", "through"] as const) {
					const value = url.searchParams.get(key);
					if (value === null) continue;
					if (!/^\d+$/.test(value)) return reply(res, 400, { error: `${key} must be an entry id` });
					query[key] = Number(value);
				}
				const page = await routes.items(id, query);
				return page === undefined ? reply(res, 404, { error: "no such chat" }) : reply(res, 200, page);
			}
			return events(res, (write) => routes.live(id, write, gone.signal));
		}
		for (const area of areas) {
			const answered = await area.route?.({
				method: req.method ?? "GET",
				path,
				url,
				json: () => json(req),
				...(device === undefined ? {} : { device }),
				signal: gone.signal,
			});
			if (answered === undefined) continue;
			if ("file" in answered) return download(res, answered.file, answered.file.bytes);
			return reply(res, answered.status ?? 200, answered.body);
		}
		return reply(res, 404, { error: "not found" });
	}

	function authorized(header: string | undefined): boolean {
		const given = Buffer.from(header ?? "");
		const expected = Buffer.from(`Bearer ${token}`);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}
}

/** Server-sent events: headers go out with the first event, so a missing chat can still be a 404. */
async function events<E = LiveEvent>(
	res: ServerResponse,
	run: (write: (event: E) => void) => Promise<boolean>,
	missing = "no such chat",
	drop: (event: E) => boolean = () => false,
): Promise<void> {
	let ended = false;
	const write = (event: E) => {
		// a stream that ended takes nothing more: what a producer still had to say has no reader
		if (ended || res.writableEnded || drop(event)) return;
		if (!res.headersSent)
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			});
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	};
	const found = await run(write);
	ended = true;
	if (!found) return reply(res, 404, { error: missing });
	res.end();
}

/** The owner's input on the live view, checked field by field: coordinates in the page's pixels. */
function ownerInput(body: Record<string, unknown>): OwnerInput {
	const number = (value: unknown, name: string) => {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new BadRequest(`${name} is a number`);
		return value;
	};
	if (body.type === "mouse") {
		const action = body.action;
		if (action !== "down" && action !== "up" && action !== "move" && action !== "wheel")
			throw new BadRequest("a mouse action is down, up, move or wheel");
		const button = body.button;
		if (button !== undefined && button !== "left" && button !== "right" && button !== "middle")
			throw new BadRequest("a button is left, right or middle");
		return {
			type: "mouse",
			action,
			x: number(body.x, "x"),
			y: number(body.y, "y"),
			...(button === undefined ? {} : { button }),
			...(body.deltaX === undefined ? {} : { deltaX: number(body.deltaX, "deltaX") }),
			...(body.deltaY === undefined ? {} : { deltaY: number(body.deltaY, "deltaY") }),
		};
	}
	if (body.type === "key") {
		if (typeof body.key !== "string" || body.key.length === 0 || body.key.length > 32)
			throw new BadRequest("a key is named");
		return {
			type: "key",
			key: body.key,
			...(body.modifiers === undefined ? {} : { modifiers: number(body.modifiers, "modifiers") }),
		};
	}
	if (body.type === "text") {
		if (typeof body.text !== "string" || body.text.length > 10_000) throw new BadRequest("text is a string");
		return { type: "text", text: body.text };
	}
	if (body.type === "navigate") {
		if (typeof body.url !== "string" || body.url.length === 0 || body.url.length > 4000)
			throw new BadRequest("url is an address");
		return { type: "navigate", url: body.url };
	}
	if (body.type === "back") return { type: "back" };
	throw new BadRequest("input is a mouse action, a key, text, an address or back");
}

/** A file of the built UI; any path that is not a file is the app, which routes by its hash. */
async function file(res: ServerResponse, web: string, pathname: string): Promise<void> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		throw new BadRequest("bad path");
	}
	const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
	const path = join(web, relative);
	const headers = {
		"content-security-policy": SERVED_POLICY,
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
	};
	if (path.startsWith(web) && extname(path) !== "") {
		const body = await readFile(path).catch(() => undefined);
		if (body !== undefined) {
			const immutable = relative.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
			res.writeHead(200, {
				...headers,
				"content-type": TYPES[extname(path)] ?? "application/octet-stream",
				"cache-control": immutable,
			});
			return void res.end(body);
		}
		if (relative.startsWith("/assets/")) return reply(res, 404, { error: "not found" });
	}
	const index = await readFile(join(web, "index.html")).catch(() => undefined);
	if (index === undefined) return reply(res, 503, { error: "the web UI is not built: npm run build:web" });
	res.writeHead(200, { ...headers, "content-type": TYPES[".html"], "cache-control": "no-cache" });
	res.end(index);
}

function reply(res: ServerResponse, code: number, body: unknown) {
	res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** A request the daemon refuses as given: answered 400 with its message. */
/** A request the daemon refuses, with why; `status` 400 unless said otherwise (413 for a body too large). */
export class BadRequest extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** An upload's bytes, refused (413) past `limit`: by its declared length before reading, or as it streams in. */
async function uploaded(
	req: IncomingMessage,
	name: string,
	limit: number,
	refusal = (size: number) => tooBig(name, size, limit),
): Promise<Buffer> {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) throw new BadRequest(refusal(declared), 413);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > limit) {
			req.destroy();
			throw new BadRequest(refusal(size), 413);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** The files a posted message names, or undefined when they are malformed; none when absent. */
function postedFiles(value: unknown): PostedFile[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 10) return undefined;
	const files: PostedFile[] = [];
	for (const file of value) {
		const { sha, name } = (file ?? {}) as { sha?: unknown; name?: unknown };
		if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return undefined;
		if (typeof name !== "string" || name === "" || name.length > 200) return undefined;
		files.push({ sha, name });
	}
	return files;
}

/**
 * A file as the browser gets it: an image it shows inline, anything else only as a download, never rendered on the
 * daemon's origin.
 */
/** Bytes as a download, or inline for an image a page may show; never as a page of its own. */
function download(
	res: ServerResponse,
	file: { readonly name: string; readonly mimeType: string },
	bytes: Buffer,
	cache = "private, max-age=31536000, immutable",
) {
	const inline = INLINE_IMAGES.has(file.mimeType);
	res.writeHead(200, {
		"content-type": inline ? file.mimeType : "application/octet-stream",
		"content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		"content-security-policy": "default-src 'none'",
		"x-content-type-options": "nosniff",
		"cache-control": cache,
	});
	res.end(bytes);
}

/** Whether the viewer asks for a file whole (`?full=1`), not the card's glimpse. */
const full = (url: URL) => url.searchParams.get("full") === "1";

/**
 * What the daemon drew of a file, from its bytes (`core/preview.ts`): the same bytes under the same name draw the same,
 * so the latest few are kept, and a feed that shows a file again does not read it again.
 */
const drawnCache = new Map<string, Preview>();
function filePreview(file: Omit<FilePreview, "preview">, bytes: Uint8Array, whole: boolean): FilePreview {
	const key = `${file.sha}\u0000${file.name}\u0000${whole ? "full" : "glimpse"}`;
	let drawn = drawnCache.get(key);
	if (drawn === undefined) {
		drawn = preview(file.name, file.mimeType, bytes, whole ? FULL : GLIMPSE);
		if (drawnCache.size >= 64) drawnCache.delete(drawnCache.keys().next().value ?? "");
	} else drawnCache.delete(key);
	drawnCache.set(key, drawn);
	return { sha: file.sha, name: file.name, mimeType: file.mimeType, size: file.size, preview: drawn };
}

/** A permission's scope as posted: undefined when none was given, null when it is malformed. */
function permissionOf(value: unknown): PermissionScope | undefined | null {
	if (value === undefined) return undefined;
	const { scope, until } = (value ?? {}) as { scope?: unknown; until?: unknown };
	if (scope === "task" || scope === "always" || scope === "host") return { scope };
	if (scope === "until" && typeof until === "number" && Number.isSafeInteger(until)) return { scope, until };
	return null;
}

/** A request's body as a JSON object, refused (413) past `limit` as an upload is. */
async function json(req: IncomingMessage, limit = JSON_BODY): Promise<Record<string, unknown>> {
	const text = (await uploaded(req, "the body", limit, () => `the body may be ${sizeOf(limit)} at most`)).toString(
		"utf8",
	);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new BadRequest("the body must be JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		throw new BadRequest("the body must be an object");
	return body as Record<string, unknown>;
}

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
