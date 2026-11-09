/**
 * A device for tests: an Iroh endpoint of its own on loopback, no relay, that dials the daemon by its ticket and speaks
 * the daemon's HTTP API over one bi-stream a request, as the app on a phone will.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { type Connection, Endpoint, EndpointTicket, RelayMode } from "@number0/iroh";
import { ALPN, streamSocket } from "../../src/server/remote.ts";

export type Answer = { readonly status: number; readonly body: unknown };

export type Device = {
	readonly id: string;
	/** Dial the daemon; a second dial replaces the connection. */
	dial(ticket: string): Promise<Connection>;
	request(method: string, path: string, body?: unknown, headers?: http.OutgoingHttpHeaders): Promise<Answer>;
	/** A request whose response is a stream: its response, to read as it comes. */
	stream(path: string): Promise<http.IncomingMessage>;
	close(): Promise<void>;
};

/**
 * `reach` is loopback for tests (no network); n0 only for a manual run against a daemon on n0's relays, whose ticket
 * names a relay to dial through.
 */
export async function testDevice({ reach = "loopback" }: { reach?: "loopback" | "n0" } = {}): Promise<Device> {
	const builder = Endpoint.builder();
	if (reach === "n0") builder.applyN0();
	else {
		builder.applyMinimal();
		builder.relayMode(RelayMode.disabled());
		builder.bindAddr("127.0.0.1:0");
		builder.bindAddr("[::1]:0");
	}
	builder.secretKey(Array.from(randomBytes(32)));
	const endpoint = await builder.bind();
	let connection: Connection | undefined;
	const open = (method: string, path: string, headers: http.OutgoingHttpHeaders) => {
		const on = connection;
		if (on === undefined) throw new Error("dial first");
		return http.request({
			method,
			path,
			createConnection: () => streamSocket(on.openBi()),
			// a Host the loopback check would refuse: over Iroh it is not what lets a request in
			headers: { host: "banda.iroh", ...headers },
		});
	};
	return {
		id: endpoint.id().toString(),
		dial: async (ticket) => {
			connection = await endpoint.connect(EndpointTicket.fromString(ticket).endpointAddr(), ALPN);
			return connection;
		},
		request: (method, path, body, headers = {}) =>
			new Promise((resolve, reject) => {
				const req = open(method, path, {
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...headers,
				});
				req.on("response", (res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						text += chunk;
					});
					res.on("end", () =>
						resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) }),
					);
					res.on("error", reject);
				});
				req.on("error", reject);
				req.end(body === undefined ? undefined : JSON.stringify(body));
			}),
		stream: (path) =>
			new Promise((resolve, reject) => {
				const req = open("GET", path, {});
				req.on("response", resolve);
				req.on("error", reject);
				req.end();
			}),
		close: async () => {
			connection?.close(0n, []);
			await endpoint.close();
		},
	};
}

/** The server-sent events of `res`, parsed, as they come. */
export function events(res: http.IncomingMessage): { next: <T>(match: (event: T) => boolean) => Promise<T> } {
	const queue: unknown[] = [];
	let wake = () => {};
	let buffer = "";
	res.setEncoding("utf8");
	res.on("data", (chunk: string) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, at);
			buffer = buffer.slice(at + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.join("\n");
			if (data !== "") queue.push(JSON.parse(data));
		}
		wake();
	});
	return {
		next: async <T>(match: (event: T) => boolean) => {
			for (;;) {
				const at = queue.findIndex((event) => match(event as T));
				if (at >= 0) return queue.splice(at, 1)[0] as T;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}
