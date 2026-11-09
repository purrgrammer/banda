/**
 * The daemon's API, through the page's transport (`transport.ts`). In a browser, with the owner's token: the link
 * `serve` and `status` print carries it in the URL's fragment, which the browser never sends; it is kept in this
 * browser and dropped from the address bar. It survives daemon restarts; when the daemon refuses it (rotated), the UI
 * says where the link is. In the phone's native shell no token is kept: the shell's paired device identity is what
 * lets a request in.
 */
import type {
	AgentView,
	Answer,
	Approving,
	Ask,
	BrowserView,
	CapabilitiesView,
	ChatContext,
	ChatPrompt,
	CompanionView,
	ControlView,
	FilePreview,
	Item,
	MemoryView,
	OwnerInput,
	Posted,
	PostMessage,
	Preview,
	ShellEvent,
	ViewEvent,
} from "../../../src/server/api.ts";
import type { BringPick, BringView } from "../../../src/server/bring.ts";
import type { DesignedFace } from "../../../src/server/routes/faces.ts";
import type { ShippedSkillsView, SkillView } from "../../../src/server/skills.ts";
import { oneStream } from "./one-stream.ts";
import { pickTransport } from "./transport.ts";

export type * from "../../../src/server/api.ts";
export type { BringOffer, BringPick, BringView, HostHarnessView } from "../../../src/server/bring.ts";
export type { ShippedSkillsView, ShippedSkillView, SkillView } from "../../../src/server/skills.ts";

const KEY = "banda.token";

function take(): string | undefined {
	const match = /(?:^#|&)token=([\w-]+)/.exec(location.hash);
	if (match?.[1] !== undefined) {
		try {
			localStorage.setItem(KEY, match[1]);
		} catch {
			// storage unavailable: the token lives for this page only
		}
		history.replaceState(null, "", `${location.pathname}${location.search}#/`);
		return match[1];
	}
	try {
		return localStorage.getItem(KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

const transport = pickTransport();
let token = transport.identified ? undefined : take();

/** No token, or the daemon refused it: the UI says where the link is. */
export class Unauthorized extends Error {}

export const hasToken = () => transport.identified || token !== undefined;

/** The page runs on a paired device (the phone's shell), not on the computer banda runs on. */
export const runsOnDevice = transport.identified;

/** The link pasted into a page that is already open changes only the hash: take the token from it then too. */
export function onToken(listener: () => void): () => void {
	const check = () => {
		if (transport.identified || !/(?:^#|&)token=/.test(location.hash)) return;
		token = take();
		listener();
	};
	addEventListener("hashchange", check);
	return () => removeEventListener("hashchange", check);
}

const unauthorized = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
	unauthorized.add(listener);
	return () => unauthorized.delete(listener);
}

const deviceRefused = new Set<() => void>();
/**
 * This device's request was refused (403). Only a reason to ask the daemon where the device stands: other refusals are
 * 403s too, and what the device is comes from the pairing route alone.
 */
export function onDeviceRefused(listener: () => void): () => void {
	deviceRefused.add(listener);
	return () => deviceRefused.delete(listener);
}

async function call(path: string, init: RequestInit = {}, as: "request" | "stream" = "request"): Promise<Response> {
	if (!transport.identified && token === undefined) throw new Unauthorized("no token");
	const response = await transport[as](`/api${path}`, {
		...init,
		headers: {
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
			"content-type": "application/json",
			...init.headers,
		},
	});
	if (response.status === 401) {
		for (const listener of unauthorized) listener();
		throw new Unauthorized("the daemon refused the token");
	}
	if (response.status === 403 && transport.identified) for (const listener of deviceRefused) listener();
	return response;
}

/** The daemon answered, and refused: its status, and why in its words. Any other failure did not reach it. */
export class Refused extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await call(path, init);
	if (!response.ok) {
		const refused = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Refused(refused.error ?? `HTTP ${response.status}`, response.status);
	}
	return (await response.json()) as T;
}

/** Accept an agent-authored proposal, or keep things as they are. */
export const actOnProposal = (id: string, action: "accept" | "decline") =>
	api<{ state: "accepted" | "declined" }>(`/proposals/${encodeURIComponent(id)}`, {
		method: "POST",
		body: JSON.stringify({ action }),
	});

/** Stop a chat's run and the inputs queued behind it. */
export const stopChat = (chat: number) => api<{ stopped: boolean }>(`/chats/${chat}/stop`, { method: "POST" });

/** How full a chat's context is, against the budget it compacts at. */
export const chatContext = (chat: number) => api<ChatContext>(`/chats/${chat}/context`);

/** The system prompt and tools chat `chat`'s model is sent. */
export const chatPrompt = (chat: number, at?: number) =>
	api<ChatPrompt>(`/chats/${chat}/prompt${at === undefined ? "" : `?at=${at}`}`);

export const readChat = (chat: number, through: number) =>
	api<{ read: true }>(`/chats/${chat}/read`, { method: "POST", body: JSON.stringify({ through }) });

/** Answer the open ask `key` as the owner; rejects with why when the daemon refuses it. */
export const answerWait = (key: string, answer: Answer, type: Ask["type"], approving: Approving = {}) =>
	api<{ chat: number }>(`/waits/${key}`, {
		method: "POST",
		body: JSON.stringify({ answer, type, via: "web", ...approving }),
	});

/** Close a question without inventing an answer. */
export const dismissQuestion = (key: string) => api<{ chat: number }>(`/waits/${key}/dismiss`, { method: "POST" });

/** Take back a permission: it covers nothing from now on. What the avatar sheet shows (`ControlView`) as it is after. */
export const revokePermission = (id: string) => api<ControlView>(`/permissions/${id}/revoke`, { method: "POST" });
/** Allow agent `agent` to send anything to `host`: a host, `*.example.com`, or `*` for every host. */
export const allowHost = (agent: string, host: string) =>
	api<ControlView>(`/agents/${agent}/hosts`, { method: "POST", body: JSON.stringify({ host }) });

/** The page's one stream (`one-stream.ts`), over the daemon's `GET /api/events?chat=`. */
const one = oneStream((path, onEvent, signal) => stream<ShellEvent>(path, onEvent, signal));
export const { events, shellEvents, takeReopen } = one;

/** Watch chat `chat`'s browser tab: its state, and its page live, until `signal` aborts or the stream ends. */
export const browserEvents = (chat: number, onEvent: (event: ViewEvent) => void, signal: AbortSignal) =>
	stream(`/chats/${chat}/browser`, onEvent, signal);

/** Take chat `chat`'s browser tab, or give it back; the tab as it is after, or rejects with why. */
export const holdBrowser = (chat: number, hold: boolean) =>
	api<BrowserView>(`/chats/${chat}/browser/control`, { method: "POST", body: JSON.stringify({ hold }) });

/** The owner's input on chat `chat`'s tab's live view; rejects unless they hold it. */
export const browserInput = (chat: number, input: OwnerInput) =>
	api<object>(`/chats/${chat}/browser/input`, { method: "POST", body: JSON.stringify(input) });

/** Sign agent `agent`'s browser out of a site; what the companion can use as it is after. */
export const signOutSite = (agent: string, site: string) =>
	api<CapabilitiesView>(`/browsers/${agent}/sites/${encodeURIComponent(site)}`, { method: "DELETE" });

/** Server-sent events read from the response as it comes, as EventSource cannot send the token. */
async function stream<E>(path: string, onEvent: (event: E) => void, signal: AbortSignal) {
	const response = await call(path, { signal }, "stream");
	if (!response.ok || response.body === null) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${response.status}`);
	}
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) return;
		buffer += value;
		for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice("data: ".length)) as E);
		}
	}
}

/** Object URLs of blobs already fetched: a blob's bytes never change, so each is fetched once a page. */
const blobUrls = new Map<string, Promise<string>>();

/** A blob some chat holds, as an object URL; it needs the token, so an `<img>` cannot fetch one itself. */
export function blobFile(sha: string): Promise<string> {
	let url = blobUrls.get(sha);
	if (url === undefined) {
		url = call(`/blobs/${sha}`).then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return URL.createObjectURL(await response.blob());
		});
		// a failure is not kept: the next asking tries again
		url.catch(() => blobUrls.delete(sha));
		blobUrls.set(sha, url);
	}
	return url;
}

let limitsOnce: Promise<{ fileBytes: number }> | undefined;

/** What the daemon takes, read once a page: how much one file may weigh. */
export function limits(): Promise<{ fileBytes: number }> {
	limitsOnce ??= api<{ fileBytes: number }>("/limits").catch((error: unknown) => {
		limitsOnce = undefined;
		throw error;
	});
	return limitsOnce;
}

/** A size as people read it. */
/** Upload a file as a blob for a message to name; resolves with what the message names it by. */
export async function upload(
	file: File,
	signal?: AbortSignal,
): Promise<{ sha: string; name: string; mimeType: string; size: number }> {
	const response = await call("/blobs", {
		method: "POST",
		body: file,
		headers: {
			"content-type": file.type || "application/octet-stream",
			"x-file-name": encodeURIComponent(file.name || "file"),
		},
		...(signal === undefined ? {} : { signal }),
	});
	if (!response.ok)
		throw new Error(
			((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`,
		);
	return (await response.json()) as { sha: string; name: string; mimeType: string; size: number };
}

/** The `n`th file a message sent, as an object URL: like an image, it needs the token. */
export async function sentFile(chat: number, message: string, n: number): Promise<string> {
	const response = await call(`/chats/${chat}/messages/${encodeURIComponent(message)}/files/${n}`);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return URL.createObjectURL(await response.blob());
}

/** An image of a transcript item, as an object URL: images need the token, so an `<img>` cannot fetch one itself. */
export async function image(chat: number, item: number, n: number): Promise<string> {
	const response = await call(`/chats/${chat}/items/${item}/images/${n}`);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return URL.createObjectURL(await response.blob());
}

/** Post the owner's message: to a new thread (a browser-made UUID, which starts a chat) or to a chat. */
export const postMessage = (message: PostMessage) =>
	api<Posted>("/messages", { method: "POST", body: JSON.stringify(message) });

/** What the owner may change of the companion: any of its picks. */
export type CompanionPicks = Partial<Pick<CompanionView, "name" | "face" | "personality">>;

/** Change the companion as the owner picked; rejects with why a pick is refused. */
export const changeCompanion = (picks: CompanionPicks) =>
	api<CompanionView>("/companion", { method: "PUT", body: JSON.stringify(picks) });

/** Pause everything, or resume; what the avatar sheet shows (`ControlView`) as it is after. */
export const setPaused = (paused: boolean) =>
	api<ControlView>(`/control/${paused ? "pause" : "resume"}`, { method: "POST" });

/** What the owner does to memory: add a fact, change its words, or delete it. */
export type FactAct =
	| {
			readonly action: "add";
			readonly text: string;
			readonly scope: "global" | "agent";
			readonly agent?: string;
			/** Whom it is about, when not the owner: declared by the owner, never detected. */
			readonly about?: string;
			/** For a fact about someone else: the owner's task it serves. */
			readonly task?: string;
	  }
	| { readonly action: "edit"; readonly id: string; readonly text: string }
	| { readonly action: "delete"; readonly id: string };

/** Act on memory as the owner; memory as it is after, or rejects with why. */
export const actOnFact = (act: FactAct) =>
	act.action === "add"
		? api<MemoryView>("/memory", {
				method: "POST",
				body: JSON.stringify({
					text: act.text,
					scope: act.scope,
					...(act.agent === undefined ? {} : { agent: act.agent }),
					...(act.about === undefined ? {} : { about: act.about }),
					...(act.task === undefined ? {} : { task: act.task }),
				}),
			})
		: act.action === "edit"
			? api<MemoryView>(`/memory/${act.id}`, { method: "PUT", body: JSON.stringify({ text: act.text }) })
			: api<MemoryView>(`/memory/${act.id}`, { method: "DELETE" });

/** One item of a chat's transcript: the message a fact came from. */
export const transcriptItem = (chat: number, item: number) => api<Item>(`/chats/${chat}/items/${item}`);

/** Allow the change the box made to an agent's file, as shown (`sha`, null for a removal), or decline it. */
export const answerAgent = (name: string, allow: boolean, sha: string | null) =>
	api<AgentView[]>(`/agents/${name}/${allow ? "accept" : "decline"}`, {
		method: "POST",
		...(allow ? { body: JSON.stringify({ sha }) } : {}),
	});

/** Design a face from the owner's description, or from the agent's name alone: a validated candidate, stored nowhere. */
export const designFace = async (description: string, name: string) =>
	(await api<DesignedFace>("/faces", { method: "POST", body: JSON.stringify({ description, name }) })).definition;

/** Save the owner's reviewed definition; `base` is null when creating a permanent agent. */
export const saveAgent = (name: string, text: string, base: string | null = null) =>
	api<AgentView[]>(`/agents/${name}`, { method: "PUT", body: JSON.stringify({ text, base }) });

/** Owner-entered MCP setup; the server returns its stable connection name, also on a retry. */
export const addMcp = (config: import("../../../src/core/mcp-config.ts").McpConfig) =>
	api<{ name: string; capabilities: CapabilitiesView }>("/capabilities/mcp", {
		method: "POST",
		body: JSON.stringify(config),
	});
export const refreshConnection = (name: string) =>
	api<CapabilitiesView>(`/capabilities/connections/${name}/refresh`, { method: "POST", body: "{}" });
export const setConnectionReads = (name: string, tools: readonly string[], sha: string) =>
	api<CapabilitiesView>(`/capabilities/connections/${name}/reads`, {
		method: "POST",
		body: JSON.stringify({ tools, sha }),
	});
export const switchPublicConnection = (name: string, agent: string, on: boolean, sha?: string) =>
	api<CapabilitiesView>(`/capabilities/connections/${name}/public`, {
		method: "POST",
		body: JSON.stringify({ agent, on, sha }),
	});
/** Shared catalogue, including box changes awaiting the owner's acceptance. */
export const skills = () => api<SkillView[]>("/skills");
/** Accept every listed proposal at the hash shown: all, or none when one changed since. */
export const acceptSkills = (accept: readonly { name: string; sha: string }[]) =>
	api<SkillView[]>("/skills", { method: "POST", body: JSON.stringify({ accept }) });
export const acceptSkill = (name: string, sha: string) =>
	api<SkillView[]>(`/skills/${name}/accept`, { method: "POST", body: JSON.stringify({ sha }) });
export const saveSkill = (name: string, text: string, base: string | null) =>
	api<SkillView[]>(`/skills/${name}`, { method: "PUT", body: JSON.stringify({ text, base }) });
/** The skills banda ships, offered once at first run. */
export const shippedSkills = () => api<ShippedSkillsView>("/skills/shipped");
/** Add the shipped skills picked, accepted; none skips. */
/** What the other harnesses on this computer have to import at first run. */
export const bringable = () => api<BringView>("/bring");
/** Import the picks; none skips. */
export const chooseBring = (skills: readonly BringPick[], agents: readonly BringPick[]) =>
	api<BringView>("/bring", { method: "POST", body: JSON.stringify({ skills, agents }) });

export const chooseShippedSkills = (add: readonly string[]) =>
	api<ShippedSkillsView>("/skills/shipped", { method: "POST", body: JSON.stringify({ add }) });

/** What the owner does to a connection or a tool the companion made. */
export type CapabilityAct =
	| {
			readonly action: "accept";
			readonly folder: "connections" | "tools";
			readonly name: string;
			readonly sha: string | null;
	  }
	| { readonly action: "decline" | "remove"; readonly folder: "connections" | "tools"; readonly name: string }
	| { readonly action: "disconnect"; readonly name: string }
	| { readonly action: "key"; readonly name: string; readonly key: string }
	| { readonly action: "add"; readonly name: string }
	| { readonly action: "address"; readonly url: string }
	| { readonly action: "trust"; readonly name: string; readonly tools: readonly string[] }
	| { readonly action: "switch"; readonly tool: string; readonly on: boolean };

/** Act on a connection or a tool as the owner; what the companion can use as it is after, or rejects with why. */
export const actOnCapability = (act: CapabilityAct) =>
	act.action === "switch"
		? api<CapabilitiesView>(`/capabilities/tools/${act.tool}/switch`, {
				method: "POST",
				body: JSON.stringify({ on: act.on }),
			})
		: act.action === "address"
			? api<CapabilitiesView>("/capabilities/connections", { method: "POST", body: JSON.stringify({ url: act.url }) })
			: act.action === "disconnect" || act.action === "key" || act.action === "add" || act.action === "trust"
				? api<CapabilitiesView>(`/capabilities/connections/${act.name}/${act.action}`, {
						method: "POST",
						body: JSON.stringify(
							act.action === "key" ? { key: act.key } : act.action === "trust" ? { tools: act.tools } : {},
						),
					})
				: api<CapabilitiesView>(`/capabilities/${act.folder}/${act.name}/${act.action}`, {
						method: "POST",
						body: JSON.stringify(act.action === "accept" ? { sha: act.sha } : {}),
					});

/**
 * Start signing in to a connection: the page to send the browser to, which comes back to banda; or the code the owner
 * types on the service's own page, which the connection then shows until it is typed.
 */
/** Sign an account of connection `name` in, asking for `scopes` (else the file's default); `account` signs that one in again. */
export const signIn = (
	name: string,
	agent?: string,
	choice: { readonly scopes?: readonly string[]; readonly account?: string } = {},
) =>
	api<{ url: string } | { code: string; page: string; expires: number } | { connected: true }>(
		`/capabilities/connections/${name}/signin`,
		{
			method: "POST",
			body: JSON.stringify({ ...(agent === undefined ? {} : { agent }), ...choice }),
		},
	);

/** Fetch one file named by a Gmail card. The daemon verifies the message, account and attachment before storing it. */
export const gmailAttachment = (
	chat: number,
	ref: string,
	attachmentId: string,
	options: { readonly agent?: string; readonly account?: string } = {},
) =>
	api<{ readonly sha: string; readonly name: string; readonly mimeType: string; readonly size: number }>(
		"/objects/attachment",
		{
			method: "POST",
			body: JSON.stringify({ chat, ref, attachmentId, ...options }),
		},
	);

/** What the daemon drew of a blob, by the name it is shown by (its kind follows the name); `full` for the viewer. */
export const blobPreview = (sha: string, name: string, full = false) =>
	api<FilePreview>(`/blobs/${sha}/preview?name=${encodeURIComponent(name)}${full ? "&full=1" : ""}`);

/** What the daemon drew of the `n`th file a message sent. */
export const sentPreview = (chat: number, message: string, n: number, full = false) =>
	api<FilePreview>(`/chats/${chat}/messages/${encodeURIComponent(message)}/files/${n}/preview${full ? "?full=1" : ""}`);

/** What the daemon draws of a file attached in the composer, before it is sent: its bytes go, nothing is kept. */
export async function localPreview(file: File, signal?: AbortSignal): Promise<Preview> {
	const response = await call("/previews", {
		method: "POST",
		body: file,
		headers: {
			"content-type": file.type || "application/octet-stream",
			"x-file-name": encodeURIComponent(file.name || "file"),
		},
		...(signal === undefined ? {} : { signal }),
	});
	const body = (await response.json().catch(() => ({}))) as { preview?: Preview; error?: string };
	if (!response.ok || body.preview === undefined) throw new Error(body.error ?? `HTTP ${response.status}`);
	return body.preview;
}

/** A file's bytes as an object URL of its own media type, so audio and video play from it. */
export async function typedUrl(url: string, mimeType: string): Promise<string> {
	const bytes = await (await fetch(url)).blob();
	return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}
/** Switch account `account` of connection `name` on or off for agent `agent`, in effect at once. */
export const switchAccount = (name: string, account: string, agent: string, on: boolean, sha?: string) =>
	api<CapabilitiesView>(`/capabilities/connections/${name}/accounts/${encodeURIComponent(account)}/switch`, {
		method: "POST",
		body: JSON.stringify({ agent, on, sha }),
	});

/** Name numbered account `account` of connection `name`, whose server did not say whom it is for. */
export const labelAccount = (name: string, account: string, label: string) =>
	api<CapabilitiesView>(`/capabilities/connections/${name}/accounts/${encodeURIComponent(account)}/label`, {
		method: "POST",
		body: JSON.stringify({ label }),
	});

/** Sign account `account` of connection `name` out: off for every agent, its permissions and drafts ended. */
export const signOutAccount = (name: string, account: string) =>
	api<CapabilitiesView>(`/capabilities/connections/${name}/accounts/${encodeURIComponent(account)}/signout`, {
		method: "POST",
	});
