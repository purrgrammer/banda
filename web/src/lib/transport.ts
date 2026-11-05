/**
 * How the app reaches the daemon. In a browser, the page's own origin: `fetch`, with the owner's token. In the phone's
 * native shell (Capacitor), through its `Banda` plugin, which speaks the same HTTP API to the daemon over an Iroh
 * stream: the shell's endpoint is a paired device, and that identity is what lets a request in, so no token is sent.
 * Either way the app reads a `Response`, so nothing above this file knows which.
 */

/** A request's or a response's headers, as plain names (lower case) and values. */
export type HeaderMap = { readonly [name: string]: string };

/**
 * The contract the native shell implements, registered as the Capacitor plugin `Banda`
 * (`window.Capacitor.Plugins.Banda`). Bodies are base64 of their bytes, both ways, so files cross intact. `path` is
 * the request's whole path and query, `/api/...`, as the daemon routes it; the plugin sends it as one HTTP/1.1 request
 * on a bi-stream of its connection to the daemon (ALPN `banda/0`), and answers with what the daemon answered.
 */
export interface BandaPlugin {
	/** One request, answered whole. Rejects only when the daemon could not be reached; any status resolves. */
	request(options: {
		readonly method: string;
		readonly path: string;
		readonly headers: HeaderMap;
		/** Base64 of the body's bytes; absent for none. */
		readonly body?: string;
	}): Promise<{ readonly status: number; readonly headers: HeaderMap; readonly body: string }>;
	/**
	 * A request whose response is read as it comes (server-sent events): resolves with the response's head once it
	 * arrives, then delivers its body as `chunk` events for `id`, and one `end` when it is over. `id` is the app's.
	 */
	stream(options: {
		readonly id: string;
		readonly path: string;
		readonly headers: HeaderMap;
	}): Promise<{ readonly status: number; readonly headers: HeaderMap }>;
	/** Stop reading stream `id`: the plugin closes its Iroh stream and sends no more events for it. */
	cancel(options: { readonly id: string }): Promise<void>;
	addListener(event: "chunk", listener: (chunk: StreamChunk) => void): Promise<{ remove(): Promise<void> }>;
	addListener(event: "end", listener: (end: StreamEnd) => void): Promise<{ remove(): Promise<void> }>;
	/** A `banda://pair` link opened the shell while it ran (a camera app read the code). */
	addListener(event: "link", listener: (link: { readonly url: string }) => void): Promise<{ remove(): Promise<void> }>;
	/** Where the shell stands: the daemon it reaches, this device, and a pairing link it was opened with. */
	state(): Promise<ShellState>;
	/** Reach the daemon a pairing link's ticket names from now on. Rejects (`TICKET`) when it is not a ticket. */
	setDaemon(options: { readonly ticket: string }): Promise<void>;
	/** Forget the daemon and this device's key: the next pairing is a new device (a revoked one cannot pair again). */
	forget(): Promise<void>;
}

/**
 * What the shell knows of itself. A request the plugin rejects carries a `code`: `UNREACHABLE` (the daemon could not
 * be reached) or `BROKEN`. Neither says what this device is: only the daemon's answer does (`GET /api/devices/pair`).
 */
export type ShellState = {
	/** The daemon's endpoint id; absent before a pairing link chose one. */
	readonly daemon?: string;
	/** This device's endpoint id, what the daemon's Settings → Devices lists it by. */
	readonly device: string;
	/** A name to suggest for this device: the phone's own. */
	readonly name: string;
	/** A `banda://pair` link the shell was opened with and has not paired with yet. */
	readonly link?: string;
};

/** The native shell's barcode scanner (`@capacitor/barcode-scanner`, registered as `CapacitorBarcodeScanner`). */
export interface ScannerPlugin {
	scanBarcode(options: {
		/** 0: a QR code. */
		readonly hint: number;
		readonly scanInstructions: string;
		readonly scanButton: boolean;
		readonly scanText: string;
		/** 1: the back camera. */
		readonly cameraDirection: number;
		/** 3: either way up. */
		readonly scanOrientation: number;
	}): Promise<{ readonly ScanResult: string }>;
}

/** Some of stream `id`'s body: base64 of its bytes, in order. */
export type StreamChunk = { readonly id: string; readonly data: string };
/** Stream `id` is over: the daemon ended it, or `error` says why it broke. */
export type StreamEnd = { readonly id: string; readonly error?: string };

/** What `api.ts` sends its requests through. */
export type Transport = {
	/** The transport itself says who asks (a paired device): no token is kept or sent. */
	readonly identified: boolean;
	request(path: string, init?: RequestInit): Promise<Response>;
	/** The same, for a response read as it comes. */
	stream(path: string, init?: RequestInit): Promise<Response>;
};

/** The page's own origin: what a browser opened from the daemon's link uses. */
export const sameOrigin: Transport = {
	identified: false,
	request: (path, init) => fetch(path, init),
	stream: (path, init) => fetch(path, init),
};

const toBase64 = (bytes: Uint8Array) => {
	let text = "";
	for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const headersOf = (init: RequestInit | undefined): HeaderMap =>
	Object.fromEntries(new Headers(init?.headers).entries());

/** A status that carries no body: a `Response` refuses one. */
const bodiless = (status: number) => status === 204 || status === 205 || status === 304;

const aborted = (signal: AbortSignal) =>
	signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted", "AbortError");

/** Requests and streams through the native shell's plugin. */
export function nativeTransport(plugin: BandaPlugin, newId: () => string = () => crypto.randomUUID()): Transport {
	// one listener of each kind for every stream, routed by id
	const streams = new Map<string, { chunk: (data: Uint8Array) => void; end: (error?: string) => void }>();
	let listening: Promise<unknown> | undefined;
	const listen = () => {
		listening ??= Promise.all([
			plugin.addListener("chunk", ({ id, data }) => streams.get(id)?.chunk(fromBase64(data))),
			plugin.addListener("end", ({ id, error }) => streams.get(id)?.end(error)),
		]);
		return listening;
	};

	return {
		identified: true,
		async request(path, init) {
			const signal = init?.signal ?? undefined;
			if (signal?.aborted) throw aborted(signal);
			const bytes = init?.body == null ? undefined : new Uint8Array(await new Response(init.body).arrayBuffer());
			const asked = plugin.request({
				method: init?.method ?? "GET",
				path,
				headers: headersOf(init),
				...(bytes === undefined ? {} : { body: toBase64(bytes) }),
			});
			// the plugin has no way to stop a request: an abort leaves its answer unread
			const answer = await (signal === undefined
				? asked
				: Promise.race([
						asked,
						new Promise<never>((_, reject) =>
							signal.addEventListener("abort", () => reject(aborted(signal)), { once: true }),
						),
					]));
			return new Response(bodiless(answer.status) ? null : fromBase64(answer.body), {
				status: answer.status,
				headers: answer.headers,
			});
		},
		async stream(path, init) {
			const signal = init?.signal ?? undefined;
			if (signal?.aborted) throw aborted(signal);
			await listen();
			const id = newId();
			let control: ReadableStreamDefaultController<Uint8Array> | undefined;
			let over = false;
			const finish = () => {
				over = true;
				streams.delete(id);
			};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					control = controller;
				},
				cancel() {
					if (over) return;
					finish();
					void plugin.cancel({ id }).catch(() => {});
				},
			});
			streams.set(id, {
				chunk: (data) => control?.enqueue(data),
				end: (error) => {
					finish();
					if (error === undefined) control?.close();
					else control?.error(new Error(error));
				},
			});
			const stop = () => {
				if (over) return;
				finish();
				void plugin.cancel({ id }).catch(() => {});
				control?.error(aborted(signal as AbortSignal));
			};
			signal?.addEventListener("abort", stop, { once: true });
			try {
				const head = await plugin.stream({ id, path, headers: headersOf(init) });
				if (signal?.aborted) throw aborted(signal);
				return new Response(bodiless(head.status) ? null : body, { status: head.status, headers: head.headers });
			} catch (error) {
				signal?.removeEventListener("abort", stop);
				if (!over) {
					finish();
					void plugin.cancel({ id }).catch(() => {});
				}
				throw error;
			}
		},
	};
}

/** What the page sees of a Capacitor shell: enough to find the plugin, nothing more. */
export type CapacitorGlobal = {
	readonly Capacitor?: {
		readonly isNativePlatform?: () => boolean;
		readonly Plugins?: { readonly Banda?: BandaPlugin; readonly CapacitorBarcodeScanner?: ScannerPlugin };
	};
};

/** The native shell's plugins, when the page runs in it. */
export function nativeShell(
	global: CapacitorGlobal = globalThis as CapacitorGlobal,
): { readonly banda: BandaPlugin; readonly scanner?: ScannerPlugin } | undefined {
	const capacitor = global.Capacitor;
	const banda = capacitor?.Plugins?.Banda;
	if (banda === undefined || capacitor?.isNativePlatform?.() !== true) return undefined;
	const scanner = capacitor.Plugins?.CapacitorBarcodeScanner;
	return scanner === undefined ? { banda } : { banda, scanner };
}

/** The native shell's plugin when the page runs in it; otherwise the page's own origin. */
export function pickTransport(global: CapacitorGlobal = globalThis as CapacitorGlobal): Transport {
	const shell = nativeShell(global);
	return shell === undefined ? sameOrigin : nativeTransport(shell.banda);
}
