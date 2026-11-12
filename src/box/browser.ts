/**
 * The browser (DESIGN.md "The box", The browser): Chromium, headless, in the box, started when first used and closed
 * once idle. The daemon drives it over DevTools on a pipe through its launch command (`cdp.ts`), never over a port.
 *
 * - **One browser, one holder.** Its page belongs to one chat at a time, whose proxy login its requests carry
 *   (the browser's own login, which the proxy maps to the holder): what it reads is that chat's. Another
 *   chat taking it gets a blank page, so no chat reads what another left open.
 * - **Writes wait in the browser.** A request that writes (any method but GET, HEAD and OPTIONS) from a page the agent
 *   drives is paused inside Chromium, never sent until the daemon lets it go (`browser-tools.ts` decides: at once, or
 *   once the owner approved it); then the proxy lets it pass once by the hash of its method, address and body, so what
 *   is sent is exactly what was decided on. While the owner holds the browser, what it sends is theirs.
 * - **The owner's sessions stay theirs.** A page of a site the owner signed in to (`sessionAt`, the daemon's) opens
 *   only once this chat's task allowed it: any other page load there, a frame's or a redirect's included, is stopped and
 *   told. A request of another kind there is stopped too, unless the page that made it is of an allowed signed-in site.
 * - **Take-over.** The owner watches the page live (the screencast) and takes control from the app: while they hold it,
 *   the agent's calls are refused as `Taken`, and taking it aborts every call at work, its DevTools commands
 *   abandoned; when they give it back, every ref is stale. Stop aborts a call the same way, through its signal.
 * - **Nothing secret leaves.** Snapshots and screenshots never carry a sensitive field's value (`snapshot.ts`), a field
 *   the owner typed into included; a key the page shows is a handle only the daemon can turn into its value.
 */
import { createHash } from "node:crypto";
import { Cdp, CdpError, type CdpEvent } from "./cdp.ts";
import {
	type AxNode,
	type Element,
	type FrameTree,
	parseRef,
	type Rendered,
	render,
	sensitiveField,
} from "./snapshot.ts";

/**
 * How the box starts a browser, the proxy login it answers the proxy's challenge with, and the stamp each tab's
 * requests carry (`TAB_HEADER`), which tells the proxy whose chat a request is, marked so only the daemon makes one.
 */
export type BrowserSetup = {
	/** Prepare the browser, then return the command that starts Chromium with DevTools on its stdin and stdout. */
	command(): Promise<readonly string[]>;
	readonly login: { readonly username: string; readonly password: string };
	/** The value of `TAB_HEADER` for chat `chat`'s tab; none: requests go unstamped (a test's browser). */
	readonly stamp?: (chat: number) => string;
};

/** The header that names the chat a tab's request is, set by the daemon on every request, never by the page. */
export const TAB_HEADER = "x-banda-tab";

/** A browser process tabs share: its DevTools, and letting it go when a tab is done with it. */
export type BrowserProcess = { readonly cdp: Cdp; release(): void };

/** A write a page tried while the agent drove it: paused in the browser, sent only once the owner approved it. */
export type PageWrite = {
	readonly id: string;
	readonly chat: number;
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	/** base64 */
	readonly body: string;
	/** What the proxy matches it by, so only these bytes pass. */
	readonly hash: string;
	/** The page that sent it. */
	readonly page: string;
	/** The address of the frame that made it: the page's, or a frame's inside it. */
	readonly origin: string;
	/** It carries a sensitive field's value or a key the page showed, so it is never drafted. */
	readonly secret: boolean;
	/**
	 * The domains of the cookies the browser holds for its address, which go with it; null when they are not known.
	 * Whether one is a session the owner signed in to is the daemon's to say (`browser-tools.ts`).
	 */
	readonly cookies: readonly string[] | null;
};

/** What the owner sees of the browser: whether it runs, whose it is, who holds it, and where it is. */
export type BrowserView = {
	readonly running: boolean;
	readonly preparing: boolean;
	readonly chat?: number;
	readonly control: "agent" | "owner";
	readonly url?: string;
	readonly title?: string;
};

/** What the owner's screen gets: the page's frames, and its state when it changes. */
export type ViewEvent =
	| { readonly type: "state"; readonly view: BrowserView }
	| { readonly type: "frame"; readonly data: string; readonly width: number; readonly height: number };

/** The owner's input on the live view, in the page's own pixels. */
export type OwnerInput =
	| {
			readonly type: "mouse";
			readonly action: "down" | "up" | "move" | "wheel";
			readonly x: number;
			readonly y: number;
			readonly button?: "left" | "right" | "middle";
			readonly deltaX?: number;
			readonly deltaY?: number;
	  }
	| { readonly type: "key"; readonly key: string; readonly code?: string; readonly modifiers?: number }
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "navigate"; readonly url: string }
	| { readonly type: "back" };

export type Action =
	/** `as`: a site the owner signed in to that this navigation may open, as the owner allowed once. */
	| { readonly type: "navigate"; readonly url: string; readonly as?: string }
	| { readonly type: "click"; readonly ref: string }
	| { readonly type: "type"; readonly ref: string; readonly text: string; readonly submit?: boolean }
	| { readonly type: "select"; readonly ref: string; readonly values: readonly string[] }
	| { readonly type: "scroll"; readonly ref?: string; readonly direction?: "up" | "down"; readonly pages?: number }
	| { readonly type: "wait"; readonly text?: string; readonly seconds?: number }
	| { readonly type: "back" };

/** Why an agent's action did not run: said to the model as it is. */
export class Refused extends Error {}

/**
 * The owner holds the browser, or took it while the agent's call was at work: the call waits for them to give it back
 * (`browser-tools.ts`), and never acts on what they see.
 */
export class Taken extends Refused {
	constructor() {
		super("The owner is using the browser now: wait for them to give it back, then take a new snapshot.");
	}
}

/** Wait `ms`, or until `signal` aborts, rejecting with its reason. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) return reject(signal.reason);
		const done = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", done);
			resolve();
		}, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** The agent's side of the browser, per chat, and the owner's. */
export type Browser = {
	/**
	 * Read the page; its refs replace every earlier one. Each of the agent's calls stops where it stands once `signal`
	 * aborts (Stop), and throws `Taken` while the owner holds the browser or once they take it.
	 */
	snapshot(chat: number, signal?: AbortSignal): Promise<string>;
	/** Act, then read the page again; refused for a stale ref. */
	act(chat: number, action: Action, signal?: AbortSignal): Promise<string>;
	/** The page as a PNG (base64), every hidden text blank. */
	screenshot(chat: number, signal?: AbortSignal): Promise<string>;
	/** What a ref of the latest snapshot names, and the page's site; or why there is none. */
	element(chat: number, ref: string): Element | string;
	/** The site (host) of the page `chat` holds, if it holds one. */
	site(chat: number): string | undefined;
	/** The domains of the cookies the browser holds for the page `chat` holds; null when not known or no page. */
	cookies(chat: number, url?: string): Promise<readonly string[] | null>;
	/** The writes its pages tried, waiting. */
	writes(chat: number): Promise<readonly PageWrite[]>;
	/** Let write `id` go, as held: after `pass` let the proxy pass its bytes once; the page after it, or why not. */
	release(chat: number, id: string, pass: (write: PageWrite) => Promise<void>, signal?: AbortSignal): Promise<string>;
	/** Drop a write: it fails in the page. */
	drop(chat: number, id: string): Promise<void>;
	/** The value of key handle `handle`, for the daemon alone. */
	key(chat: number, handle: string): string | undefined;
	view(): BrowserView;
	/** Hear the view: its state now and on every change, and frames while anyone watches. */
	watch(listener: (event: ViewEvent) => void): () => void;
	/** The owner takes the browser, or gives it back. */
	hold(owner: boolean): Promise<BrowserView>;
	/** The owner's input; refused unless they hold the browser. */
	input(input: OwnerInput): Promise<void>;
	/** Forget the browser's session at `site` (its cookies, and its subdomains'), starting it if it is closed. */
	forget(site: string): Promise<void>;
	close(): void;
};

export type BrowserOptions = {
	readonly setup: BrowserSetup;
	/** Bring the box up before starting the browser in it. */
	readonly ensure: () => Promise<void>;
	/** Tell the proxy whose the browser's requests are, and whether the owner holds it; resolves once it knows. */
	readonly tell: (holder: { readonly chat: number; readonly owner: boolean } | undefined) => Promise<void>;
	/**
	 * The site the owner signed in to whose session a request of chat `chat` to `url` goes with (by its host, or by
	 * `cookies`, the domains of the cookies the browser holds for it; null: not known), and whether this chat's task
	 * allowed opening it; undefined when it goes with none. None: no site is signed in.
	 */
	readonly sessionAt?: (
		chat: number,
		url: string,
		cookies: readonly string[] | null,
	) => Promise<{ readonly site: string; readonly allowed: boolean } | undefined>;
	readonly log: (line: string) => void;
	/** Closed after this long with no use and nobody watching (default five minutes). */
	readonly idleMs?: number;
	/** Fault points at the browser's start and each action, for the fault rig. */
	readonly fault?: (point: string) => void;
	/** How long an action waits for its page to settle at most. */
	readonly settleMs?: number;
	/** Told whenever the view changes: opened, closed, taken, given back, a new page. */
	readonly changed?: () => void;
	/**
	 * The process this browser is a tab of, shared with the other tabs of its agent's browser: its page is a new tab
	 * there, closed when it is done. None: it starts a process of its own (`setup.command`) and uses its first page.
	 * `signal` aborts when this tab closes during acquisition.
	 */
	readonly process?: (signal: AbortSignal) => Promise<BrowserProcess>;
};

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const VIEWPORT = { width: 1280, height: 800 };

/** The hash the proxy matches a write by: method, host and port, path with its query, and the body's bytes. */
export function writeHash(method: string, url: string, body: Buffer): string {
	const parsed = new URL(url);
	const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
	return createHash("sha256")
		.update(`${method.toUpperCase()}\n${parsed.hostname.toLowerCase()}:${port}\n${parsed.pathname}${parsed.search}\n`)
		.update(body)
		.digest("hex");
}

/** A point of a quad (its corners clockwise from the top left), `u` across and `v` down, each from 0 to 1. */
function within(quad: readonly number[], u: number, v: number): { x: number; y: number } {
	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = quad;
	return { x: x0 + u * (x1 - x0) + v * (x3 - x0), y: y0 + u * (y1 - y0) + v * (y3 - y0) };
}

/** Where a click is tried within an element: its centre first, then along its middle, then above and below that. */
const SPOTS: readonly (readonly [number, number])[] = [
	[0.5, 0.5],
	...[0.1, 0.25, 0.75, 0.9, 0.03, 0.4, 0.6, 0.97].map((u) => [u, 0.5] as const),
	...[0.2, 0.8].flatMap((v) => [0.1, 0.5, 0.9].map((u) => [u, v] as const)),
];

/** Whether the element hit (the argument) is the ref's element or inside it, across shadow roots; a text ref is its parent's. */
const HOLDS =
	"function (hit) { const me = this.nodeType === 3 ? this.parentElement : this; for (let n = hit; n; n = n.parentNode || n.host) if (n === me) return true; return false; }";
/** The ref's element clicks itself (a text ref, its parent). */
const CLICK_ITSELF =
	"function () { const me = this.nodeType === 3 ? this.parentElement : this; if (me && typeof me.click === 'function') me.click(); }";

/** Keys the owner's keyboard sends as keys, with the codes Chromium wants; the rest arrive as text. */
const KEYS: { [key: string]: number } = {
	Enter: 13,
	Backspace: 8,
	Tab: 9,
	Escape: 27,
	Delete: 46,
	ArrowLeft: 37,
	ArrowUp: 38,
	ArrowRight: 39,
	ArrowDown: 40,
	Home: 36,
	End: 35,
	PageUp: 33,
	PageDown: 34,
};

/**
 * A write as the browser holds it: paused in Chromium (a script's), or stopped and kept to send again (a navigation's);
 * whether it carries a secret, and the cookies that go with it, once known.
 */
type Held = Omit<PageWrite, "secret" | "cookies"> & {
	readonly request: string;
	readonly navigation: boolean;
	readonly network?: string;
	readonly secret: Promise<boolean>;
	readonly cookies: Promise<readonly string[] | null>;
};

type Session = {
	readonly cdp: Cdp;
	page: string;
	readonly target: string;
	chat: number;
	/** Requests in flight, by network id, for settling. */
	readonly inflight: Set<string>;
	loading: boolean;
	/** The latest snapshot, its refs and keys. */
	latest?: Rendered | undefined;
	readonly writes: Map<string, Held>;
	/** Fields the owner typed into: sensitive from then on. */
	readonly typed: Set<number>;
	keys: Map<string, string>;
	url: string;
	title: string;
	screencast: boolean;
	/** The current cast's latest image, replayed to a new viewer even when the page has not repainted. */
	frame?: Extract<ViewEvent, { type: "frame" }> | undefined;
	nextWrite: number;
	/** Each frame's address, by its id: whose a request is. */
	readonly frames: Map<string, string>;
	/** Pages of signed-in sites the page tried to open, stopped, not told yet: address and site. */
	readonly openings: Map<string, string>;
	/** A signed-in site the action at work may open, as the owner allowed once. */
	allowing?: string | undefined;
	/** An approved navigation write, sent again: the next navigation to its address goes out as it. */
	replaying?:
		| {
				readonly url: string;
				readonly method: string;
				readonly headers: readonly (readonly [string, string])[];
				readonly body: string;
		  }
		| undefined;
	/** The owner clicked or tabbed since the field their keys go to was last marked. */
	focusMoved: boolean;
	/** Done with the page: its tab closed and the shared process let go, or its own process ended. */
	readonly close: () => void;
};

export function openBrowser(options: BrowserOptions): Browser {
	const { setup, log } = options;
	const fault = options.fault ?? (() => {});
	const idleMs = options.idleMs ?? 5 * 60_000;
	const settleMs = options.settleMs ?? 10_000;
	let session: Session | undefined;
	let starting:
		| { readonly chat: number; readonly controller: AbortController; readonly promise: Promise<Session> }
		| undefined;
	let control: "agent" | "owner" = "agent";
	/** The owner is taking the browser: the agent's input is refused from the moment they ask, before the proxy knows. */
	let claiming = false;
	/** Aborted, with `Taken`, when the owner takes the browser: every agent's call at work stops where it stands. */
	let cut = new AbortController();
	/** Every ref is of this snapshot; anything that changes the page under the agent makes the next one new. */
	let generation = 0;
	const listeners = new Set<(event: ViewEvent) => void>();
	let idle: NodeJS.Timeout | undefined;

	const view = (): BrowserView => ({
		running: session !== undefined,
		preparing: session === undefined && starting !== undefined,
		...(session === undefined
			? starting === undefined
				? {}
				: { chat: starting.chat }
			: { chat: session.chat, url: session.url, title: session.title }),
		control,
	});
	const emit = (event: ViewEvent) => {
		for (const listener of listeners) listener(event);
	};
	const changed = () => {
		emit({ type: "state", view: view() });
		options.changed?.();
	};

	const touch = () => {
		clearTimeout(idle);
		idle = setTimeout(() => {
			if (listeners.size > 0 || control === "owner") return touch();
			log("browser: closed after a while unused");
			stop();
		}, idleMs);
		idle.unref();
	};

	const stop = () => {
		clearTimeout(idle);
		const was = session;
		const pending = starting;
		session = undefined;
		starting = undefined;
		pending?.controller.abort(new Refused("The browser was closed."));
		control = "agent";
		if (was !== undefined) {
			was.screencast = false;
			was.frame = undefined;
			was.close();
		}
		if (was !== undefined || pending !== undefined) void options.tell(undefined).catch(() => undefined);
		changed();
	};

	/**
	 * `headers` with this tab's stamp, the chat it is, as the only `TAB_HEADER`: whatever the page set under that name is
	 * dropped, so a page never names a chat. Without a stamp (a test's browser), the headers as they are.
	 */
	const stamped = (s: Session, headers: readonly (readonly [string, string])[]) => {
		const kept = headers.filter(([name]) => name.toLowerCase() !== TAB_HEADER);
		const stamp = setup.stamp?.(s.chat);
		return [...kept, ...(stamp === undefined ? [] : [[TAB_HEADER, stamp] as const])].map(([name, value]) => ({
			name,
			value,
		}));
	};
	/** What a request goes on with: its headers stamped, or nothing (it goes on as it is) without a stamp. */
	const stampOf = (s: Session, headers: readonly (readonly [string, string])[]) =>
		setup.stamp === undefined ? {} : { headers: stamped(s, headers) };

	/**
	 * Decide a request the agent's page made (DESIGN.md "The box", The browser): a page of a signed-in site it may not
	 * open is stopped and told; another request there is stopped too unless its page is of an allowed signed-in site
	 * (removing its Cookie header would not do: Chromium attaches cookies after this point); a read then goes on, a
	 * write waits in the browser.
	 */
	const guarded = async (
		s: Session,
		p: Record<string, unknown>,
		request: { method: string; url: string; headers: Record<string, string> },
		id: string,
	) => {
		const document = p.resourceType === "Document";
		const headers = Object.entries(request.headers);
		const withCookies = headers.some(([name]) => name.toLowerCase() === "cookie");
		const target =
			options.sessionAt === undefined
				? undefined
				: await options.sessionAt(s.chat, request.url, withCookies ? await cookiesAt(s, request.url) : []);
		const allowed = target !== undefined && (target.allowed || s.allowing === target.site);
		if (target !== undefined && document && !allowed) {
			// a page of a signed-in site this task did not allow: stopped where it stands, and told
			s.openings.set(request.url, target.site);
			const network = p.networkId as string | undefined;
			if (network !== undefined) s.inflight.delete(network);
			await s.cdp.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, s.page);
			return;
		}
		if (target !== undefined && !document) {
			const from = s.frames.get(p.frameId as string) ?? s.url;
			const page = /^https?:/.test(from) ? await options.sessionAt?.(s.chat, from, []) : undefined;
			if (!allowed || page === undefined || !(page.allowed || s.allowing === page.site)) {
				const network = p.networkId as string | undefined;
				if (network !== undefined) s.inflight.delete(network);
				await s.cdp.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, s.page);
				return;
			}
		}
		if (READS.has(request.method.toUpperCase())) {
			await s.cdp.send("Fetch.continueRequest", { requestId: id, ...stampOf(s, headers) }, s.page);
			return;
		}
		// a navigation that writes (a form sent) is stopped where it stands, the page kept: a navigation held open
		// would hold the whole page with it; approved, it is sent again as stored
		const navigation = p.resourceType === "Document";
		const entries = (p.request as { postDataEntries?: { bytes?: string }[] }).postDataEntries ?? [];
		const body = Buffer.concat(entries.map((entry) => Buffer.from(entry.bytes ?? "", "base64")));
		const network = p.networkId as string | undefined;
		if (network !== undefined) s.inflight.delete(network);
		const write = {
			id: `w${++s.nextWrite}`,
			chat: s.chat,
			method: request.method.toUpperCase(),
			url: request.url,
			headers,
			body: body.toString("base64"),
			hash: writeHash(request.method, request.url, body),
			page: s.url,
			origin: s.frames.get(p.frameId as string) ?? s.url,
			request: id,
			navigation,
			...(network === undefined ? {} : { network }),
			secret: carries(s, body).catch(() => true),
			cookies: cookiesAt(s, request.url),
		};
		s.writes.set(write.id, write);
		if (navigation)
			void s.cdp.send("Fetch.failRequest", { requestId: id, errorReason: "Aborted" }, s.page).catch(() => undefined);
		return;
	};

	const onEvent = (s: Session, event: CdpEvent) => {
		const p = event.params;
		switch (event.method) {
			case "Fetch.requestPaused": {
				const request = p.request as { method: string; url: string; headers: Record<string, string> };
				const id = p.requestId as string;
				const replay = s.replaying;
				if (replay !== undefined && p.resourceType === "Document" && request.url === replay.url) {
					// the approved write, sent as the navigation it was: exactly its method, headers and body
					s.replaying = undefined;
					void s.cdp
						.send(
							"Fetch.continueRequest",
							{
								requestId: id,
								method: replay.method,
								postData: replay.body,
								headers: stamped(s, replay.headers),
							},
							s.page,
						)
						.catch(() => undefined);
					return;
				}
				if (control === "owner") {
					void s.cdp
						.send("Fetch.continueRequest", { requestId: id, ...stampOf(s, Object.entries(request.headers)) }, s.page)
						.catch(() => undefined);
					return;
				}
				void guarded(s, p, request, id).catch(() => {
					void s.cdp
						.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, s.page)
						.catch(() => undefined);
				});
				return;
			}
			case "Fetch.authRequired": {
				const challenge = p.authChallenge as { source?: string };
				void s.cdp
					.send(
						"Fetch.continueWithAuth",
						{
							requestId: p.requestId,
							authChallengeResponse:
								challenge.source === "Proxy"
									? { response: "ProvideCredentials", ...setup.login }
									: { response: "CancelAuth" },
						},
						s.page,
					)
					.catch(() => undefined);
				return;
			}
			case "Network.requestWillBeSent":
				if ([...s.writes.values()].some((write) => write.network === p.requestId)) return;
				s.inflight.add(p.requestId as string);
				return;
			case "Network.loadingFinished":
			case "Network.loadingFailed":
				s.inflight.delete(p.requestId as string);
				return;
			case "Page.frameStartedLoading":
				s.loading = true;
				return;
			case "Page.frameStoppedLoading":
			case "Page.loadEventFired":
				s.loading = false;
				// the title as the browser knows it, also for a page the owner opened
				void s.cdp
					.send<{ targetInfo: { title: string; url: string } }>(
						"Target.getTargetInfo",
						{ targetId: s.target },
						undefined,
						5_000,
					)
					.then(({ targetInfo }) => {
						const title = targetInfo.title === targetInfo.url ? "" : targetInfo.title;
						if (title !== s.title) {
							s.title = title;
							changed();
						}
					})
					.catch(() => undefined);
				return;
			case "Page.frameNavigated": {
				const frame = p.frame as { id: string; parentId?: string; url: string };
				s.frames.set(frame.id, frame.url);
				if (frame.parentId === undefined) {
					s.url = frame.url;
					s.title = "";
					s.frame = undefined;
					// a page left behind takes its writes with it
					for (const [id, write] of s.writes) if (write.page !== frame.url) s.writes.delete(id);
					changed();
				}
				return;
			}
			case "Page.javascriptDialogOpening":
				// an alert is read and closed; a confirm or a prompt is declined: the page asks nobody
				void s.cdp
					.send("Page.handleJavaScriptDialog", { accept: p.type === "alert" || p.type === "beforeunload" }, s.page)
					.catch(() => undefined);
				return;
			case "Page.screencastFrame": {
				void s.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, s.page).catch(() => undefined);
				if (!s.screencast) return;
				const meta = p.metadata as { deviceWidth: number; deviceHeight: number };
				s.frame = { type: "frame", data: p.data as string, width: meta.deviceWidth, height: meta.deviceHeight };
				emit(s.frame);
				return;
			}
			case "Target.targetCreated": {
				// a page that opens another (a link to a new tab) opens it here instead
				const info = p.targetInfo as { type: string; targetId: string; openerId?: string; url: string };
				if (info.type === "page" && info.openerId !== undefined) void adopt(s, info.targetId);
				return;
			}
		}
	};

	const adopt = async (s: Session, target: string) => {
		for (let i = 0; i < 20; i++) {
			const { targetInfo } = await s.cdp.send<{ targetInfo: { url: string } }>("Target.getTargetInfo", {
				targetId: target,
			});
			if (targetInfo.url !== "" && targetInfo.url !== "about:blank") {
				await s.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
				await s.cdp.send("Page.navigate", { url: targetInfo.url }, s.page).catch(() => undefined);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await s.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
	};

	/**
	 * Whether `body` carries the value of a sensitive field on the page (as typed, URL-encoded, form-encoded or as JSON)
	 * or a key the page showed: what only the daemon may hold.
	 */
	const carries = async (s: Session, body: Buffer): Promise<boolean> => {
		if (body.length === 0) return false;
		const values = [...s.keys.values()];
		const fields = new Set([...s.typed, ...(s.latest?.hidden ?? [])]);
		for (const node of fields) {
			const object = await s.cdp
				.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: node }, s.page)
				.catch(() => undefined);
			if (object?.object.objectId === undefined) continue;
			const { result } = await s.cdp.send<{ result: { value?: unknown } }>(
				"Runtime.callFunctionOn",
				{
					objectId: object.object.objectId,
					functionDeclaration: "function () { return typeof this.value === 'string' ? this.value : ''; }",
					returnByValue: true,
				},
				s.page,
			);
			if (typeof result.value === "string" && result.value !== "") values.push(result.value);
		}
		const text = body.toString("latin1");
		return values.some((value) => {
			const forms = [
				value,
				encodeURIComponent(value),
				new URLSearchParams({ v: value }).toString().slice(2),
				JSON.stringify(value).slice(1, -1),
			];
			return forms.some((form) => text.includes(Buffer.from(form, "utf8").toString("latin1")));
		});
	};

	const startScreencast = async (s: Session) => {
		if (s.screencast) return;
		s.screencast = true;
		// a tab paints only in front: the one watched is brought there, whatever tab of its browser opened since
		await s.cdp.send("Page.bringToFront", {}, s.page).catch(() => undefined);
		await s.cdp
			.send(
				"Page.startScreencast",
				{ format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height },
				s.page,
			)
			.catch(() => undefined);
	};

	const start = async (chat: number, signal: AbortSignal): Promise<Session> => {
		await options.ensure();
		signal.throwIfAborted();
		await options.tell({ chat, owner: false });
		signal.throwIfAborted();
		fault("browser:start");
		// a tab of the agent's shared process, or a process of its own
		const shared = options.process === undefined ? undefined : await options.process(signal);
		if (signal.aborted) {
			shared?.release();
			signal.throwIfAborted();
		}
		let cdp: Cdp;
		if (shared === undefined) {
			const command = await setup.command();
			signal.throwIfAborted();
			cdp = new Cdp(command, log);
		} else cdp = shared.cdp;
		let unhear = () => {};
		let targetId: string | undefined;
		const close = () => {
			unhear();
			if (shared === undefined) return cdp.close();
			if (targetId !== undefined) void cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
			shared.release();
		};
		signal.addEventListener("abort", close, { once: true });
		try {
			if (shared !== undefined)
				targetId = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
			else {
				const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>(
					"Target.getTargets",
				);
				targetId = targetInfos.find((info) => info.type === "page")?.targetId;
			}
			if (targetId === undefined) throw new CdpError("the browser opened no page");
			const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
				targetId,
				flatten: true,
			});
			const s: Session = {
				cdp,
				page: sessionId,
				target: targetId,
				close,
				chat,
				inflight: new Set(),
				loading: false,
				writes: new Map(),
				typed: new Set(),
				keys: new Map(),
				url: "about:blank",
				title: "",
				screencast: false,
				nextWrite: 0,
				frames: new Map(),
				openings: new Map(),
				focusMoved: true,
			};
			// this tab hears its own page's events, and the browser's about pages its page opened; never another tab's
			unhear = cdp.on((event) => {
				if (event.sessionId === sessionId) return onEvent(s, event);
				if (event.sessionId !== undefined) return;
				const opener = (event.params.targetInfo as { openerId?: string } | undefined)?.openerId;
				if (event.method !== "Target.targetCreated" || opener === s.target) onEvent(s, event);
			});
			void cdp.ended.then(() => {
				if (session === s) stop();
			});
			await cdp.send("Target.setDiscoverTargets", { discover: true });
			await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
			await cdp.send("Page.enable", {}, sessionId);
			await cdp.send("Network.enable", {}, sessionId);
			await cdp.send("DOM.enable", {}, sessionId);
			await cdp.send(
				"Fetch.enable",
				{ patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: true },
				sessionId,
			);
			await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId).catch(() => undefined);
			await cdp.send(
				"Emulation.setDeviceMetricsOverride",
				{ ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
				sessionId,
			);
			if (listeners.size > 0) await startScreencast(s);
			signal.throwIfAborted();
			return s;
		} catch (error) {
			close();
			throw error;
		} finally {
			signal.removeEventListener("abort", close);
		}
	};

	/** The browser, started for `chat` if it is not open; one start at a time. */
	const opened = async (chat: number): Promise<Session> => {
		if (session !== undefined) {
			await options.ensure();
			if (session !== undefined) return session;
		}
		if (starting === undefined) {
			const controller = new AbortController();
			starting = { chat, controller, promise: start(chat, controller.signal) };
			changed();
		}
		const pending = starting;
		let s: Session;
		try {
			s = await pending.promise;
		} catch (error) {
			if (starting === pending) {
				starting = undefined;
				void options.tell(undefined).catch(() => undefined);
				changed();
			}
			throw error;
		}
		if (pending.controller.signal.aborted) {
			s.close();
			pending.controller.signal.throwIfAborted();
		}
		if (starting === pending) starting = undefined;
		if (session === undefined) {
			session = s;
			generation++;
			changed();
		}
		return session;
	};

	/** The browser for `chat`, started or taken over; refused while the owner holds it. */
	const take = async (chat: number): Promise<Session> => {
		if (control === "owner" || claiming) throw new Taken();
		touch();
		const s = await opened(chat);
		if (s.chat !== chat) {
			// another chat's page is not this one's to read
			for (const id of [...s.writes.keys()]) await drop(s.chat, id);
			s.chat = chat;
			s.frame = undefined;
			await options.tell({ chat, owner: false });
			await s.cdp.send("Page.navigate", { url: "about:blank" }, s.page).catch(() => undefined);
			s.keys = new Map();
			s.latest = undefined;
			generation++;
			changed();
		}
		return s;
	};

	/** A view of the session's DevTools whose commands `signal` abandons. */
	const drive = (s: Session, signal: AbortSignal | undefined) => ({
		send: <T = Record<string, unknown>>(method: string, params?: object, sessionId?: string, timeoutMs?: number) =>
			s.cdp.send<T>(method, params, sessionId, timeoutMs, signal),
	});

	/**
	 * Run one of the agent's calls under a signal that aborts with its own (Stop), or with `Taken` when the owner takes the
	 * browser; refused at once while they hold it.
	 */
	const agent = async <T>(stopped: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		if (control === "owner" || claiming) throw new Taken();
		const signal = stopped === undefined ? cut.signal : AbortSignal.any([stopped, cut.signal]);
		signal.throwIfAborted();
		return run(signal);
	};

	const settle = async (s: Session, longest = settleMs, signal?: AbortSignal) => {
		const until = Date.now() + longest;
		let quiet = 0;
		while (Date.now() < until && s.cdp.closed === undefined) {
			await sleep(100, signal);
			quiet = s.inflight.size === 0 && !s.loading ? quiet + 1 : 0;
			if (quiet >= 4) break;
		}
		// the browser's own record of the page: a renderer busy with a navigation it waits on answers nothing
		const info = await drive(s, signal)
			.send<{ targetInfo: { title: string; url: string } }>(
				"Target.getTargetInfo",
				{ targetId: s.target },
				undefined,
				5_000,
			)
			.catch(() => undefined);
		if (info !== undefined) s.title = info.targetInfo.title === info.targetInfo.url ? "" : info.targetInfo.title;
		changed();
	};

	const frames = async (s: Session, signal?: AbortSignal): Promise<FrameTree[]> => {
		const { frameTree } = await drive(s, signal).send<{ frameTree: FrameNode }>("Page.getFrameTree", {}, s.page);
		const list: { id: string; url: string }[] = [];
		const visit = (node: FrameNode) => {
			list.push({ id: node.frame.id, url: node.frame.url });
			for (const child of node.childFrames ?? []) visit(child);
		};
		visit(frameTree);
		const trees: FrameTree[] = [];
		for (const frame of list) {
			const got = await drive(s, signal)
				.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", { frameId: frame.id }, s.page)
				.catch(() => undefined);
			if (got !== undefined) trees.push({ url: frame.url, nodes: got.nodes });
		}
		return trees;
	};

	/** The fields among `trees` whose value is secret: by what they are, or because the owner typed into them. */
	const sensitive = async (s: Session, trees: readonly FrameTree[], signal?: AbortSignal): Promise<Set<number>> => {
		const found = new Set<number>();
		for (const tree of trees)
			for (const node of tree.nodes) {
				const id = node.backendDOMNodeId;
				const role = typeof node.role?.value === "string" ? node.role.value : "";
				if (id === undefined || !/textbox|searchbox|combobox|spinbutton|textField/.test(role)) continue;
				if (s.typed.has(id)) {
					found.add(id);
					continue;
				}
				const described = await drive(s, signal)
					.send<{ node: { nodeName: string; attributes?: string[] } }>(
						"DOM.describeNode",
						{ backendNodeId: id },
						s.page,
					)
					.catch(() => undefined);
				if (described === undefined) continue;
				const attributes: Record<string, string> = {};
				const list = described.node.attributes ?? [];
				for (let i = 0; i + 1 < list.length; i += 2) attributes[(list[i] ?? "").toLowerCase()] = list[i + 1] ?? "";
				if (sensitiveField(described.node.nodeName, attributes)) found.add(id);
			}
		return found;
	};

	const read = async (s: Session, bump: boolean, signal?: AbortSignal): Promise<Rendered> => {
		const trees = await frames(s, signal);
		const secret = await sensitive(s, trees, signal);
		// a read cut short holds what it got before: never rendered as the page
		signal?.throwIfAborted();
		const rendered = render({ title: s.title, url: s.url }, trees, bump ? ++generation : generation, secret, s.keys);
		s.keys = new Map(rendered.keys);
		if (bump) s.latest = rendered;
		return rendered;
	};

	const said = (s: Session, rendered: Rendered): string => {
		const waiting = [...s.writes.values()].filter((write) => write.chat === s.chat);
		const lines = [rendered.text];
		const openings = [...s.openings];
		s.openings.clear();
		if (openings.length > 0)
			lines.push(
				"",
				...openings.map(
					([url, site]) =>
						`[banda] The page tried to open ${url}, on ${site}, where the owner is signed in: it did not open. ` +
						"Opening it there would act as them, so browser_navigate to it asks the owner first.",
				),
			);
		if (waiting.length > 0)
			lines.push(
				"",
				...waiting.map(
					(write) =>
						`[banda] The page tried to send ${write.method} ${write.url} (write ${write.id}). It waits in the ` +
						"browser, not sent. Call browser_send with the write if sending it is what you meant.",
				),
			);
		return lines.join("\n");
	};

	/** The domains of the cookies the browser holds for `url`, which go with a request there; null when not known. */
	const cookiesAt = (s: Session, url: string): Promise<readonly string[] | null> =>
		s.cdp
			.send<{ cookies: { domain: string }[] }>("Network.getCookies", { urls: [url] }, s.page)
			.then(({ cookies }) => [...new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, "").toLowerCase()))])
			.catch(() => null);

	const resolveRef = (s: Session, ref: string): Element => {
		const parsed = parseRef(ref);
		if (parsed === undefined) throw new Refused(`${ref} is not a ref: use one from your latest snapshot, like s3e12.`);
		if (parsed.generation !== generation || s.latest === undefined)
			throw new Refused(`${ref} is from an earlier snapshot, and the page may have changed: take a new snapshot.`);
		const element = s.latest.refs.get(ref);
		if (element === undefined) throw new Refused(`${ref} is not in your latest snapshot.`);
		return element;
	};

	const objectOf = async (s: Session, node: number, signal?: AbortSignal): Promise<string> => {
		const resolved = await drive(s, signal)
			.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: node }, s.page)
			.catch(() => undefined);
		const id = resolved?.object.objectId;
		if (id === undefined) throw new Refused("That element is gone from the page: take a new snapshot.");
		return id;
	};

	/** Where `node` stands on screen, scrolled into view: its quads, in the page's CSS pixels. */
	const quadsOf = async (s: Session, node: number, signal?: AbortSignal): Promise<number[][]> => {
		await drive(s, signal)
			.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node }, s.page)
			.catch(() => undefined);
		const { quads } = await drive(s, signal)
			.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: node }, s.page)
			.catch(() => ({ quads: [] as number[][] }));
		const shown = quads.filter((quad) => quad.length >= 8);
		if (shown.length === 0) throw new Refused("That element is not on screen to act on.");
		return shown;
	};

	/**
	 * A point where a click reaches `node` itself (or something inside it), as the page hit-tests it: a large element's
	 * centre may hold another (a row's checkbox over its subject), and a pointer there would press that instead.
	 * Undefined when no point tried is the element's: something covers all of it.
	 */
	const pointOn = async (
		s: Session,
		node: number,
		signal?: AbortSignal,
	): Promise<{ x: number; y: number } | undefined> => {
		const quads = await quadsOf(s, node, signal);
		const object = await objectOf(s, node, signal);
		for (const quad of quads.slice(0, 2))
			for (const [u, v] of SPOTS) {
				const at = within(quad, u, v);
				const hit = await drive(s, signal)
					.send<{ backendNodeId: number }>("DOM.getNodeForLocation", { ...at, ignorePointerEventsNone: false }, s.page)
					.catch(() => undefined);
				if (hit === undefined) continue;
				if (hit.backendNodeId === node) return at;
				const resolved = await drive(s, signal)
					.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: hit.backendNodeId }, s.page)
					.catch(() => undefined);
				const other = resolved?.object.objectId;
				if (other === undefined) continue;
				const { result } = await drive(s, signal)
					.send<{ result: { value?: unknown } }>(
						"Runtime.callFunctionOn",
						{ objectId: object, functionDeclaration: HOLDS, arguments: [{ objectId: other }], returnByValue: true },
						s.page,
					)
					.catch(() => ({ result: {} as { value?: unknown } }));
				if (result.value === true) return at;
			}
		return undefined;
	};

	/**
	 * Click `node` itself: the pointer at a point the page hit-tests as it, or, when something covers all of it, the
	 * element's own click(), so a click never lands on what lies over it.
	 */
	const clickOn = async (s: Session, node: number, signal?: AbortSignal) => {
		const at = await pointOn(s, node, signal);
		// finding the point took a moment: the owner may have taken the browser meanwhile, or the call been stopped
		signal?.throwIfAborted();
		if (at !== undefined) return click(s, at, signal);
		await drive(s, signal).send(
			"Runtime.callFunctionOn",
			{ objectId: await objectOf(s, node, signal), functionDeclaration: CLICK_ITSELF },
			s.page,
		);
	};

	const press = async (s: Session, key: string, modifiers = 0, signal?: AbortSignal) => {
		const code = KEYS[key];
		const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
		await drive(s, signal).send(
			"Input.dispatchKeyEvent",
			{ type: "keyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) },
			s.page,
		);
		await drive(s, signal).send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, s.page);
	};

	const click = async (s: Session, at: { x: number; y: number }, signal?: AbortSignal) => {
		await drive(s, signal).send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, s.page);
		await drive(s, signal).send(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", ...at, button: "left", clickCount: 1 },
			s.page,
		);
		await drive(s, signal).send(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", ...at, button: "left", clickCount: 1 },
			s.page,
		);
	};

	const drop = async (chat: number, id: string) => {
		const s = session;
		const write = s?.writes.get(id);
		if (s === undefined || write === undefined || write.chat !== chat) return;
		s.writes.delete(id);
		await s.cdp
			.send("Fetch.failRequest", { requestId: write.request, errorReason: "BlockedByClient" }, s.page)
			.catch(() => undefined);
	};

	const act = async (chat: number, action: Action, signal: AbortSignal): Promise<string> => {
		const s = await take(chat);
		fault("browser:action");
		switch (action.type) {
			case "navigate": {
				let url: URL;
				try {
					url = new URL(action.url);
				} catch {
					throw new Refused(`${action.url} is not an address: give it whole, like https://example.com/.`);
				}
				if (url.protocol !== "http:" && url.protocol !== "https:")
					throw new Refused("The browser opens http and https addresses only.");
				s.loading = true;
				s.allowing = action.as;
				const went = await drive(s, signal).send<{ errorText?: string }>("Page.navigate", { url: url.href }, s.page);
				if (went.errorText !== undefined && went.errorText !== "net::ERR_ABORTED") {
					s.loading = false;
					await settle(s, 1_000, signal);
					return `It did not open: ${went.errorText}.\n\n${said(s, await read(s, true, signal))}`;
				}
				break;
			}
			case "back": {
				const history = await drive(s, signal).send<{ currentIndex: number; entries: { id: number }[] }>(
					"Page.getNavigationHistory",
					{},
					s.page,
				);
				const previous = history.entries[history.currentIndex - 1];
				if (previous === undefined) throw new Refused("There is no page to go back to.");
				await drive(s, signal).send("Page.navigateToHistoryEntry", { entryId: previous.id }, s.page);
				break;
			}
			case "click": {
				const element = resolveRef(s, action.ref);
				await clickOn(s, element.node, signal);
				break;
			}
			case "type": {
				const element = resolveRef(s, action.ref);
				if (element.sensitive)
					throw new Refused(
						"That field is for a secret, which is never yours to type: hand the page to the owner (browser_hand_over).",
					);
				await drive(s, signal)
					.send("DOM.focus", { backendNodeId: element.node }, s.page)
					.catch(async () => {
						await clickOn(s, element.node, signal);
					});
				const object = await objectOf(s, element.node, signal);
				await drive(s, signal).send(
					"Runtime.callFunctionOn",
					{
						objectId: object,
						functionDeclaration:
							"function () { if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) getSelection().selectAllChildren(this); }",
					},
					s.page,
				);
				if (action.text === "") await press(s, "Delete", 0, signal);
				else await drive(s, signal).send("Input.insertText", { text: action.text }, s.page);
				if (action.submit === true) await press(s, "Enter", 0, signal);
				break;
			}
			case "select": {
				const element = resolveRef(s, action.ref);
				const object = await objectOf(s, element.node, signal);
				const { result } = await drive(s, signal).send<{ result: { value?: unknown } }>(
					"Runtime.callFunctionOn",
					{
						objectId: object,
						functionDeclaration: `function (wanted) {
							if (!(this instanceof HTMLSelectElement)) return "not a list to pick from";
							const picked = [];
							for (const option of this.options) {
								const yes = wanted.some((w) => w === option.value || w === option.label || w === option.text.trim());
								if (yes && (this.multiple || picked.length === 0)) { option.selected = true; picked.push(option.label); }
								else if (this.multiple || yes) option.selected = false;
							}
							if (picked.length === 0) return "none of those is an option";
							this.dispatchEvent(new Event("input", { bubbles: true }));
							this.dispatchEvent(new Event("change", { bubbles: true }));
							return "";
						}`,
						arguments: [{ value: action.values }],
						returnByValue: true,
					},
					s.page,
				);
				if (typeof result.value === "string" && result.value !== "") throw new Refused(`Not picked: ${result.value}.`);
				break;
			}
			case "scroll": {
				if (action.ref !== undefined) {
					const element = resolveRef(s, action.ref);
					await drive(s, signal).send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.node }, s.page);
				} else {
					const pages = Math.min(10, Math.max(1, action.pages ?? 1));
					await drive(s, signal).send(
						"Input.dispatchMouseEvent",
						{
							type: "mouseWheel",
							x: VIEWPORT.width / 2,
							y: VIEWPORT.height / 2,
							deltaX: 0,
							deltaY: (action.direction === "up" ? -1 : 1) * pages * VIEWPORT.height * 0.8,
						},
						s.page,
					);
				}
				break;
			}
			case "wait": {
				const seconds = Math.min(30, Math.max(1, action.seconds ?? 10));
				const until = Date.now() + seconds * 1000;
				if (action.text === undefined) await sleep(seconds * 1000, signal);
				else
					for (;;) {
						const { result } = await drive(s, signal).send<{ result: { value?: unknown } }>(
							"Runtime.evaluate",
							{
								expression: `document.body ? document.body.innerText.includes(${JSON.stringify(action.text)}) : false`,
								returnByValue: true,
							},
							s.page,
						);
						if (result.value === true || Date.now() > until) break;
						await sleep(250, signal);
					}
				break;
			}
		}
		await settle(s, settleMs, signal);
		// the owner may have taken the browser while it settled: what it reads now is theirs to see first
		signal.throwIfAborted();
		return said(s, await read(s, true, signal));
	};

	return {
		snapshot: (chat, stopped) =>
			agent(stopped, async (signal) => {
				const s = await take(chat);
				if (s.url === "about:blank" && s.latest === undefined) await settle(s, 500, signal);
				return said(s, await read(s, true, signal));
			}),
		act: (chat, action, stopped) =>
			agent(stopped, async (signal) => {
				try {
					return await act(chat, action, signal);
				} finally {
					// allowed once: for this navigation alone
					if (session !== undefined) session.allowing = undefined;
				}
			}),
		screenshot: (chat, stopped) =>
			agent(stopped, async (signal) => {
				const s = await take(chat);
				const rendered = await read(s, false, signal);
				const blanked: { object: string }[] = [];
				try {
					for (const node of rendered.hidden) {
						// a text node's element is what draws it
						const object = await objectOf(s, node, signal).catch(() => undefined);
						if (object === undefined) continue;
						await drive(s, signal).send(
							"Runtime.callFunctionOn",
							{
								objectId: object,
								functionDeclaration: `function () {
								const el = this.nodeType === 1 ? this : this.parentElement;
								if (!el) return;
								el.dataset.bandaStyle = el.getAttribute("style") ?? "";
								for (const p of ["color", "-webkit-text-fill-color", "caret-color", "text-shadow"])
									el.style.setProperty(p, p === "text-shadow" ? "none" : "transparent", "important");
								el.style.setProperty("-webkit-text-security", "none", "important");
							}`,
							},
							s.page,
						);
						blanked.push({ object });
					}
					const { data } = await drive(s, signal).send<{ data: string }>(
						"Page.captureScreenshot",
						{ format: "png" },
						s.page,
					);
					return data;
				} finally {
					// the page as it was, whatever cut the call short
					for (const { object } of blanked)
						await s.cdp
							.send(
								"Runtime.callFunctionOn",
								{
									objectId: object,
									functionDeclaration: `function () {
									const el = this.nodeType === 1 ? this : this.parentElement;
									if (!el || el.dataset.bandaStyle === undefined) return;
									const was = el.dataset.bandaStyle; delete el.dataset.bandaStyle;
									if (was === "") el.removeAttribute("style"); else el.setAttribute("style", was);
								}`,
								},
								s.page,
							)
							.catch(() => undefined);
				}
			}),
		element: (chat, ref) => {
			const s = session;
			if (s === undefined || s.chat !== chat) return "the browser is not open: take a snapshot first";
			try {
				return resolveRef(s, ref);
			} catch (error) {
				return (error as Error).message;
			}
		},
		site: (chat) => {
			const s = session;
			if (s === undefined || s.chat !== chat) return undefined;
			try {
				return new URL(s.url).host || undefined;
			} catch {
				return undefined;
			}
		},
		cookies: async (chat, url) => {
			// for an address about to be opened, the browser starts: its profile holds the cookies, open tab or not
			const s = url === undefined ? session : await opened(chat).catch(() => undefined);
			const at = url ?? s?.url ?? "";
			if (s === undefined || s.chat !== chat || !/^https?:/.test(at)) return null;
			return cookiesAt(s, at);
		},
		writes: async (chat) => {
			const held = [...(session?.writes.values() ?? [])].filter((write) => write.chat === chat);
			return Promise.all(
				held.map(async ({ request: _r, network: _n, navigation: _v, secret, cookies, ...write }) => ({
					...write,
					secret: await secret,
					cookies: await cookies,
				})),
			);
		},
		release: (chat, id, pass, stopped) =>
			agent(stopped, async (signal) => {
				const s = session;
				const write = s?.writes.get(id);
				if (s === undefined || write === undefined || write.chat !== chat)
					throw new Refused("That write is gone (the page moved on, or the browser closed): nothing was sent.");
				const { request: _r, network: _n, navigation: _v, secret, cookies, ...shown } = write;
				if (await secret) throw new Refused("That write carries a secret: only the owner sends it.");
				await pass({ ...shown, secret: false, cookies: await cookies });
				s.writes.delete(id);
				if (write.navigation) {
					s.replaying = { url: write.url, method: write.method, headers: write.headers, body: write.body };
					s.loading = true;
					// the approved write goes once the proxy lets it: never cut short between the two
					await s.cdp.send("Page.navigate", { url: write.url }, s.page);
				} else {
					if (write.network !== undefined) s.inflight.add(write.network);
					await s.cdp.send("Fetch.continueRequest", { requestId: write.request, ...stampOf(s, write.headers) }, s.page);
				}
				touch();
				await settle(s, settleMs, signal);
				return said(s, await read(s, true, signal));
			}),
		drop,
		key: (chat, handle) => (session !== undefined && session.chat === chat ? session.keys.get(handle) : undefined),
		view,
		watch: (listener) => {
			listeners.add(listener);
			listener({ type: "state", view: view() });
			if (session !== undefined) {
				if (session.frame !== undefined) listener(session.frame);
				void startScreencast(session);
			}
			return () => {
				listeners.delete(listener);
				const s = session;
				if (listeners.size === 0 && s !== undefined && s.screencast) {
					s.screencast = false;
					s.frame = undefined;
					void s.cdp.send("Page.stopScreencast", {}, s.page).catch(() => undefined);
				}
			};
		},
		hold: async (owner) => {
			const s = session;
			if (s === undefined) {
				if (owner) throw new Refused("The browser is not open.");
				return view();
			}
			if (owner === (control === "owner")) return view();
			if (owner) {
				// the agent's calls at work stop now, and none starts, before the proxy lets the owner's sends pass and
				// before any of their input arrives
				claiming = true;
				cut.abort(new Taken());
				cut = new AbortController();
				try {
					await options.ensure();
					if (session !== s) throw new Refused("The browser closed while its computer was starting.");
					await options.tell({ chat: s.chat, owner: true });
					// what they press and type goes to this tab, in front
					await s.cdp.send("Page.bringToFront", {}, s.page).catch(() => undefined);
				} finally {
					claiming = false;
				}
				control = "owner";
				// A write held while the agent had the browser must never become the owner's send just because they took
				// over. Drop it, then load the page afresh: a challenge page (and every other page script) starts its
				// requests under the owner's control, instead of carrying on with a half-failed request.
				const held = [...s.writes.keys()];
				for (const id of held) await drop(s.chat, id);
				if (held.length > 0) {
					s.loading = true;
					await s.cdp.send("Page.reload", { ignoreCache: true }, s.page);
				}
			} else {
				await options.ensure();
				if (session !== s) throw new Refused("The browser closed while its computer was starting.");
				// the agent's next request is held again before the proxy is told
				control = "agent";
				await options.tell({ chat: s.chat, owner: false });
			}
			generation++;
			s.latest = undefined;
			touch();
			changed();
			return view();
		},
		input: async (input) => {
			const s = session;
			if (s === undefined || control !== "owner") throw new Refused("Take the browser first.");
			if (input.type !== "mouse" || (input.action !== "move" && input.action !== "wheel")) await options.ensure();
			if (session !== s || control !== "owner") throw new Refused("Take the browser first.");
			touch();
			if (input.type === "navigate") {
				let url: URL;
				try {
					url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`);
				} catch {
					throw new Refused(`${input.url} is not an address.`);
				}
				if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refused("Only http and https addresses.");
				await s.cdp.send("Page.navigate", { url: url.href }, s.page);
				return;
			}
			if (input.type === "back") {
				const history = await s.cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
					"Page.getNavigationHistory",
					{},
					s.page,
				);
				const previous = history.entries[history.currentIndex - 1];
				if (previous !== undefined) await s.cdp.send("Page.navigateToHistoryEntry", { entryId: previous.id }, s.page);
				return;
			}
			if (input.type === "mouse") {
				const at = {
					x: Math.max(0, Math.min(VIEWPORT.width, input.x)),
					y: Math.max(0, Math.min(VIEWPORT.height, input.y)),
				};
				if (input.action === "down") s.focusMoved = true;
				if (input.action === "wheel")
					await s.cdp.send(
						"Input.dispatchMouseEvent",
						{ type: "mouseWheel", ...at, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 },
						s.page,
					);
				else
					await s.cdp.send(
						"Input.dispatchMouseEvent",
						{
							type: input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : "mouseMoved",
							...at,
							...(input.action === "move" ? {} : { button: input.button ?? "left", clickCount: 1 }),
						},
						s.page,
					);
				return;
			}
			// whatever the owner types is theirs: the field it lands in is sensitive from now on
			if (s.focusMoved) {
				s.focusMoved = false;
				for (const tree of await frames(s))
					for (const node of tree.nodes)
						if (
							node.backendDOMNodeId !== undefined &&
							node.properties?.some((property) => property.name === "focused" && property.value.value === true)
						)
							s.typed.add(node.backendDOMNodeId);
			}
			if (input.type === "key" && (input.key === "Tab" || input.key === "Enter")) s.focusMoved = true;
			if (input.type === "text") await s.cdp.send("Input.insertText", { text: input.text.slice(0, 10_000) }, s.page);
			else if (KEYS[input.key] !== undefined) await press(s, input.key, input.modifiers ?? 0);
			else if ([...input.key].length === 1) await s.cdp.send("Input.insertText", { text: input.key }, s.page);
		},
		forget: async (site) => {
			touch();
			const s = await opened(0);
			const host = site.toLowerCase().replace(/^\.+/, "");
			const { cookies } = await s.cdp.send<{ cookies: { name: string; domain: string; path: string }[] }>(
				"Storage.getCookies",
			);
			const ofSite = (name: string) => name === host || name.endsWith(`.${host}`) || host.endsWith(`.${name}`);
			// what is stored for the site: its host, the hosts its cookies were for and the frames this tab opened there
			const origins = new Set([host]);
			for (const cookie of cookies) {
				const domain = cookie.domain.replace(/^\./, "").toLowerCase();
				if (!ofSite(domain)) continue;
				origins.add(domain);
				await s.cdp.send(
					"Network.deleteCookies",
					{ name: cookie.name, domain: cookie.domain, path: cookie.path },
					s.page,
				);
			}
			for (const each of [...(session?.frames.values() ?? []), ...s.frames.values()]) {
				try {
					const name = new URL(each).hostname.toLowerCase();
					if (ofSite(name)) origins.add(name);
				} catch {
					// not an address
				}
			}
			for (const origin of origins)
				for (const scheme of ["https", "http"])
					await s.cdp
						.send("Storage.clearDataForOrigin", { origin: `${scheme}://${origin}`, storageTypes: "all" })
						.catch(() => undefined);
		},
		close: stop,
	};
}

type FrameNode = { frame: { id: string; url: string }; childFrames?: FrameNode[] };
