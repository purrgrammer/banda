/**
 * The transport seam: in a browser the page's own origin; in the native shell, the `Banda` plugin, whose answers the
 * app reads as the `Response` fetch would have given it, bodies byte for byte, streams as they come, and stopped when
 * the app stops reading.
 */
import { describe, expect, it } from "vitest";
import {
	type BandaPlugin,
	nativeTransport,
	pickTransport,
	type StreamChunk,
	type StreamEnd,
	sameOrigin,
} from "./transport.ts";

const b64 = (text: string | Uint8Array) =>
	btoa(String.fromCharCode(...(typeof text === "string" ? new TextEncoder().encode(text) : text)));

const bodyOf = (response: Response) => {
	if (response.body === null) throw new Error("no body");
	return response.body;
};

/** A plugin that records what it was asked and lets the test answer, the way the shell would. */
function fakePlugin() {
	const asked: Parameters<BandaPlugin["request"]>[0][] = [];
	const streams: Parameters<BandaPlugin["stream"]>[0][] = [];
	const cancelled: string[] = [];
	const chunk = new Set<(chunk: StreamChunk) => void>();
	const end = new Set<(end: StreamEnd) => void>();
	let answer: Awaited<ReturnType<BandaPlugin["request"]>> = { status: 200, headers: {}, body: "" };
	let head: () => Promise<Awaited<ReturnType<BandaPlugin["stream"]>>> = async () => ({ status: 200, headers: {} });
	const plugin = {
		request: async (options) => {
			asked.push(options);
			return answer;
		},
		stream: async (options) => {
			streams.push(options);
			return head();
		},
		cancel: async ({ id }) => {
			cancelled.push(id);
		},
		addListener: async (event: "chunk" | "end", listener: never) => {
			const set = (event === "chunk" ? chunk : end) as Set<unknown>;
			set.add(listener);
			return { remove: async () => void set.delete(listener) };
		},
	} as BandaPlugin;
	return {
		plugin,
		asked,
		streams,
		cancelled,
		answer: (next: typeof answer) => {
			answer = next;
		},
		head: (next: typeof head) => {
			head = next;
		},
		chunk: (id: string, text: string) => {
			for (const listener of chunk) listener({ id, data: b64(text) });
		},
		end: (id: string, error?: string) => {
			for (const listener of end) listener(error === undefined ? { id } : { id, error });
		},
	};
}

describe("picking a transport", () => {
	it("is the page's own origin in a browser, and the plugin only in a native shell that has it", () => {
		const plugin = fakePlugin().plugin;
		expect(pickTransport({})).toBe(sameOrigin);
		expect(sameOrigin.identified).toBe(false);
		// Capacitor's web build defines the global, with no native platform under it
		expect(pickTransport({ Capacitor: { isNativePlatform: () => false, Plugins: { Banda: plugin } } })).toBe(
			sameOrigin,
		);
		expect(pickTransport({ Capacitor: { isNativePlatform: () => true, Plugins: {} } })).toBe(sameOrigin);
		const native = pickTransport({ Capacitor: { isNativePlatform: () => true, Plugins: { Banda: plugin } } });
		expect(native).not.toBe(sameOrigin);
		expect(native.identified).toBe(true);
	});
});

describe("the native transport", () => {
	it("sends a request whole, and gives back the daemon's answer as a Response", async () => {
		const fake = fakePlugin();
		const transport = nativeTransport(fake.plugin);
		fake.answer({ status: 201, headers: { "content-type": "application/json" }, body: b64('{"ok":"é"}') });
		const response = await transport.request("/api/devices/requests/x/approve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Ana's phone" }),
		});
		expect(response.status).toBe(201);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({ ok: "é" });
		expect(fake.asked).toEqual([
			{
				method: "POST",
				path: "/api/devices/requests/x/approve",
				headers: { "content-type": "application/json" },
				body: b64(JSON.stringify({ name: "Ana's phone" })),
			},
		]);
	});

	it("carries a file's bytes both ways intact, and a GET with no body", async () => {
		const fake = fakePlugin();
		const transport = nativeTransport(fake.plugin);
		const bytes = Uint8Array.from({ length: 70_000 }, (_, at) => (at * 31) % 256);
		fake.answer({ status: 200, headers: {}, body: b64(bytes) });
		const response = await transport.request("/api/blobs", { method: "POST", body: new Blob([bytes]) });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		expect(fake.asked[0]?.body).toBe(b64(bytes));
		fake.answer({ status: 204, headers: {}, body: "" });
		expect((await transport.request("/api/status")).status).toBe(204);
		expect(fake.asked[1]).toEqual({ method: "GET", path: "/api/status", headers: {} });
	});

	it("rejects an aborted request, and never asks for one aborted already", async () => {
		const fake = fakePlugin();
		const transport = nativeTransport(fake.plugin);
		const stop = new AbortController();
		stop.abort();
		await expect(transport.request("/api/status", { signal: stop.signal })).rejects.toThrow();
		expect(fake.asked).toEqual([]);
	});

	it("reads a stream as its chunks come, and ends with it", async () => {
		const fake = fakePlugin();
		const transport = nativeTransport(fake.plugin, () => "s1");
		const response = await transport.stream("/api/events", { headers: { accept: "text/event-stream" } });
		expect(fake.streams).toEqual([{ id: "s1", path: "/api/events", headers: { accept: "text/event-stream" } }]);
		const reader = bodyOf(response).pipeThrough(new TextDecoderStream()).getReader();
		fake.chunk("s1", 'data: {"type":');
		fake.chunk("other", "not ours");
		fake.chunk("s1", '"devices"}\n\n');
		let text = "";
		while (!text.endsWith("\n\n")) text += (await reader.read()).value ?? "";
		expect(text).toBe('data: {"type":"devices"}\n\n');
		fake.end("s1");
		expect((await reader.read()).done).toBe(true);
		expect(fake.cancelled).toEqual([]);
	});

	it("errors a stream the shell says broke", async () => {
		const fake = fakePlugin();
		const transport = nativeTransport(fake.plugin, () => "s1");
		const reader = bodyOf(await transport.stream("/api/events")).getReader();
		fake.end("s1", "the connection to the daemon closed");
		await expect(reader.read()).rejects.toThrow("the connection to the daemon closed");
	});

	it("cancels the shell's stream when the app aborts it or stops reading", async () => {
		const fake = fakePlugin();
		let next = 0;
		const transport = nativeTransport(fake.plugin, () => `s${++next}`);
		const stop = new AbortController();
		const reader = (
			(await transport.stream("/api/events", { signal: stop.signal })).body as ReadableStream<Uint8Array>
		).getReader();
		stop.abort();
		await expect(reader.read()).rejects.toThrow();
		const other = (await transport.stream("/api/events")).body as ReadableStream<Uint8Array>;
		await other.cancel();
		expect(fake.cancelled).toEqual(["s1", "s2"]);
		// chunks for a stream let go of are dropped, not thrown
		fake.chunk("s1", "late");
	});

	it("cancels a stream whose head never came because the app aborted first", async () => {
		const fake = fakePlugin();
		const transport = nativeTransport(fake.plugin, () => "s1");
		const stop = new AbortController();
		let release = () => {};
		fake.head(() => new Promise((resolve) => (release = () => resolve({ status: 200, headers: {} }))));
		const opening = transport.stream("/api/events", { signal: stop.signal });
		await Promise.resolve();
		await Promise.resolve();
		stop.abort();
		release();
		await expect(opening).rejects.toThrow();
		expect(fake.cancelled).toEqual(["s1"]);
	});
});
