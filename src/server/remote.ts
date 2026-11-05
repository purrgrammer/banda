/**
 * Remote reach (DESIGN.md "Clients"): the daemon's one Iroh endpoint, which the owner's devices dial from anywhere
 * without an open port. Its key is `<home>/auth/iroh.key`, so its endpoint id stays the same across restarts. Each
 * bi-stream a connection opens carries one HTTP request to the daemon's own server, the same API as on loopback: the
 * stream is handed to it as a connection, and the socket it becomes carries the remote endpoint id the QUIC handshake
 * authenticated (`endpointOf`). Who a request is comes from that, never from a header.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { join } from "node:path";
import { Duplex } from "node:stream";
// types only: the native addon loads when the endpoint binds, so a platform without its prebuilt still serves loopback
import type { BiStream, Connection, SecretKey } from "@number0/iroh";
import type { RemoteState } from "./api/devices.ts";

export type { RemoteState };

/** The one protocol the endpoint speaks: the daemon's HTTP API, one request a bi-stream. */
export const ALPN = Array.from(Buffer.from("banda/0", "utf8"));

/**
 * Where the daemon is reachable over Iroh: `n0` (the default) through n0's public relays and discovery, so a device
 * dials it by its endpoint id from any network; `loopback`, on this computer only, through `relay` when one is named;
 * `off`, not at all.
 */
export type Reach = "n0" | "loopback" | "off";

export type RemoteSettings = { readonly reach: Reach; readonly relay?: string };

/** How the config's `remote` and `BANDA_REMOTE` pick the reach: the environment wins. */
export function remoteSettings(
	config: { readonly reach?: unknown; readonly relay?: unknown } | undefined,
	env: string | undefined = process.env.BANDA_REMOTE,
): RemoteSettings {
	const reach = env ?? config?.reach ?? "n0";
	if (reach !== "n0" && reach !== "loopback" && reach !== "off")
		throw new Error(`remote reach is n0, loopback or off, not ${String(reach)}`);
	const relay = config?.relay;
	if (relay !== undefined && (typeof relay !== "string" || !/^https?:\/\//.test(relay)))
		throw new Error("remote.relay is a relay's URL");
	return { reach, ...(relay === undefined ? {} : { relay }) };
}

const endpoints = new WeakMap<object, string>();

/** The Iroh endpoint id a request's socket came from, authenticated by its handshake; undefined on loopback. */
export const endpointOf = (socket: object): string | undefined => endpoints.get(socket);

/** Mark `socket` as come from endpoint `id`: only the accept loop, and tests, call it. */
export const markEndpoint = (socket: object, id: string): void => void endpoints.set(socket, id);

/** At most this much crosses the native binding in one call: a chunk is an array of numbers there. */
const CHUNK = 64 * 1024;

/**
 * A bi-stream as a socket node:http can use. `holdEnd`, on the daemon's side: the peer finishing its send side is not
 * passed on, since node:http answers a half-close by ending the socket under a response still being written. The
 * daemon's response ends the stream instead (`connection: close`). The send side is never reset once a finish began:
 * a reset would drop the response's last bytes. A socket destroyed before its peer ended its side stops that side:
 * otherwise the peer is told only when the stream's handle is garbage collected, and until then it sends into a stream
 * no one reads, its writes stalled once the window fills.
 */
export function streamSocket(bi: BiStream | Promise<BiStream>, { holdEnd = false, onEnd = () => {} } = {}): Duplex {
	const opened = Promise.resolve(bi);
	let reading = false;
	let finishing = false;
	let ended = false;
	const socket = new Duplex({
		allowHalfOpen: true,
		read() {
			if (reading) return;
			reading = true;
			void (async () => {
				const { recv } = await opened;
				for (;;) {
					const chunk = await recv.read(CHUNK);
					if (chunk.length === 0) {
						ended = true;
						if (holdEnd) onEnd();
						else socket.push(null);
						return;
					}
					if (!socket.push(Buffer.from(chunk))) {
						reading = false;
						return;
					}
				}
			})().catch((error: unknown) => socket.destroy(error as Error));
		},
		write(chunk: Buffer, _encoding, done) {
			void (async () => {
				const { send } = await opened;
				for (let at = 0; at < chunk.length; at += CHUNK)
					await send.writeAll(Array.from(chunk.subarray(at, at + CHUNK)));
			})().then(() => done(), done);
		},
		final(done) {
			finishing = true;
			opened.then(({ send }) => send.finish()).then(() => done(), done);
		},
		destroy(error, done) {
			const reset =
				finishing || socket.writableFinished ? Promise.resolve() : opened.then(({ send }) => send.reset(0n));
			// not waited for: a read still pending holds the receive side, and a stop waits behind it
			if (!ended) opened.then(({ recv }) => recv.stop(0n)).catch(() => {});
			reset.catch(() => {}).finally(() => done(error));
		},
	});
	// what node:http calls on a socket; a stream has no such knobs
	const self = () => socket;
	Object.assign(socket, { setTimeout: self, setNoDelay: self, setKeepAlive: self, ref: self, unref: self });
	// a reset after the exchange is over has no one listening; the request has listeners of its own
	socket.on("error", () => {});
	return socket;
}

export type Remote = {
	/** The daemon's endpoint id. */
	readonly id: string;
	readonly reach: "n0" | "loopback";
	/** The daemon's endpoint ticket: its id and how to reach it now, once it has a relay (n0) or at once (loopback). */
	ticket(): Promise<string>;
	/** Whether endpoint `id` holds a connection now. */
	connected(id: string): boolean;
	/** Close every connection of endpoint `id`. */
	drop(id: string): void;
	close(): Promise<void>;
};

/** The daemon's endpoint key, made on first use and kept, owner-only. */
async function endpointKey(home: string, { SecretKey }: typeof import("@number0/iroh")): Promise<SecretKey> {
	const path = join(home, "auth", "iroh.key");
	let bytes: Buffer | undefined;
	try {
		bytes = await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (bytes !== undefined) {
		// never replaced: a new key is a new endpoint id, and every paired phone would lose this computer
		if (bytes.length !== 32) throw new Error(`${path} is not an endpoint key (${bytes.length} bytes, not 32)`);
		return SecretKey.fromBytes(Array.from(bytes));
	}
	await mkdir(join(home, "auth"), { recursive: true, mode: 0o700 });
	const key = SecretKey.fromBytes(Array.from(randomBytes(32)));
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, Buffer.from(key.toBytes()), { mode: 0o600 });
	await rename(temporary, path);
	return key;
}

/** How long a ticket waits for the endpoint to have a relay before it is given without one. */
const ONLINE_MS = 10_000;

/**
 * What an endpoint that is not a paired device may hold. Any endpoint that knows the daemon's id can dial it, and a
 * key costs nothing, so it reaches the pairing route alone (`http.ts`) and holds little while it does: its streams are
 * served one at a time, each let go of when it is not answered within `requestMs`; its connection is closed (`again`)
 * after `lifeMs`, and the device dials again for its next look; and past `connections` of them at once, the one held
 * longest is closed (`busy`) to make room, so endpoints that keep dialing never shut a phone out, they only race it.
 * And it is let in at all only while the daemon has a reason to hear it (`admits`): an invite is live, or it is an
 * endpoint the daemon knows. A device paired meanwhile is held to none of it from its next stream.
 */
export type Unpaired = { readonly connections: number; readonly lifeMs: number; readonly requestMs: number };

export const UNPAIRED: Unpaired = { connections: 16, lifeMs: 60_000, requestMs: 10_000 };

/**
 * The reasons the daemon closes a connection with, each its own word: `revoked`, the owner revoked the device;
 * `closing`, the daemon is stopping; `busy` and `again`, an endpoint that is not a paired device was let go of. Only the
 * pairing route says what a device is (`GET /api/devices/pair`); a reason is never why a device forgets its key.
 */
export type CloseReason = "revoked" | "closing" | "busy" | "again";

const closeWith = (connection: Connection, reason: CloseReason) =>
	connection.close(reason === "closing" ? 0n : 1n, Array.from(Buffer.from(reason)));

/**
 * Bind the daemon's endpoint and hand each bi-stream it accepts to `server`. `paired` says whether an endpoint is a
 * paired device the owner has not revoked; any other is held to `unpaired`. `changed` is told when a device's
 * connection comes or goes.
 */
export async function openRemote({
	home,
	settings,
	server,
	paired,
	admits = async () => true,
	changed,
	log,
	unpaired = UNPAIRED,
}: {
	readonly home: string;
	readonly settings: RemoteSettings & { readonly reach: "n0" | "loopback" };
	readonly server: Server;
	readonly paired: (id: string) => Promise<boolean>;
	/** Whether an endpoint that is not a paired device is let in now; every one, when not given. */
	readonly admits?: (id: string) => Promise<boolean>;
	readonly changed: () => void;
	readonly log: (line: string) => void;
	readonly unpaired?: Unpaired;
}): Promise<Remote> {
	const iroh = await import("@number0/iroh");
	const { Endpoint, EndpointTicket, RelayMode } = iroh;
	const key = await endpointKey(home, iroh);
	const builder = Endpoint.builder();
	if (settings.reach === "n0") {
		builder.applyN0();
		if (settings.relay !== undefined) builder.relayMode(RelayMode.customFromUrls([settings.relay]));
	} else {
		builder.applyMinimal();
		builder.relayMode(settings.relay === undefined ? RelayMode.disabled() : RelayMode.customFromUrls([settings.relay]));
		// one address alone still binds the other family on every interface: both, chosen, keep it on this computer
		builder.bindAddr("127.0.0.1:0");
		builder.bindAddr("[::1]:0");
	}
	builder.secretKey(key.toBytes());
	builder.alpns([ALPN]);
	const endpoint = await builder.bind();
	const id = endpoint.id().toString();
	const online = settings.reach === "n0" || settings.relay !== undefined ? endpoint.online() : Promise.resolve();
	online.catch(() => undefined);
	const live = new Map<string, Set<Connection>>();
	let closing = false;
	/** Connections that failed since the last one logged, and when that was. */
	let failures = 0;
	let logged = 0;
	/** Connections held now by endpoints that are not paired devices, oldest first: each closes itself to make room. */
	const held = new Set<() => void>();

	// one request a stream: the response's end ends it, and a peer that finished before it asked anything is let go
	const asked = new WeakSet<object>();
	const ask = (request: IncomingMessage) => void asked.add(request.socket);
	server.prependListener("request", ask);

	/** Serve a connection's streams; `release` is called once, when its endpoint turns out to be a paired device. */
	const serveStreams = async (connection: Connection, peer: string, release: () => unknown) => {
		for (;;) {
			let bi: BiStream;
			try {
				bi = await connection.acceptBi();
			} catch {
				return;
			}
			const device = await paired(peer);
			if (device) release();
			const socket: Duplex = streamSocket(bi, {
				holdEnd: true,
				onEnd: () => setImmediate(() => asked.has(socket) || socket.end()),
			});
			socket.once("finish", () => socket.destroy());
			markEndpoint(socket, peer);
			if (device) {
				server.emit("connection", socket);
				continue;
			}
			// not a device: this stream alone, until it is answered or its time is up
			const done = new Promise((resolve) => socket.once("close", resolve));
			const late = setTimeout(() => socket.destroy(), unpaired.requestMs);
			server.emit("connection", socket);
			await done;
			clearTimeout(late);
		}
	};

	const accepting = (async () => {
		for (;;) {
			const incoming = await endpoint.acceptNext().catch(() => null);
			if (incoming === null) return;
			void (async () => {
				const connection = await (await incoming.accept()).connect();
				const peer = connection.remoteId().toString();
				const mine = live.get(peer) ?? new Set();
				mine.add(connection);
				live.set(peer, mine);
				// registered before the check, so a revoke committed meanwhile either is seen here or drops it
				try {
					if (closing) return closeWith(connection, "closing");
					if (await paired(peer)) {
						changed();
						return await serveStreams(connection, peer, () => {});
					}
					if (!(await admits(peer).catch(() => false))) return closeWith(connection, "again");
					// full: the one held longest makes room
					for (const oldest of held) {
						if (held.size < unpaired.connections) break;
						oldest();
					}
					let holding = true;
					const life = setTimeout(() => closeWith(connection, "again"), unpaired.lifeMs);
					const release = () => {
						if (!holding) return false;
						holding = false;
						held.delete(evict);
						clearTimeout(life);
						return true;
					};
					const evict = () => {
						if (release()) closeWith(connection, "busy");
					};
					held.add(evict);
					try {
						await serveStreams(connection, peer, () => release() && changed());
					} finally {
						release();
					}
				} finally {
					mine.delete(connection);
					if (mine.size === 0 && live.get(peer) === mine) live.delete(peer);
					// only a device's connections are shown: an endpoint that is not one changes nothing
					if (await paired(peer).catch(() => false)) changed();
				}
			})().catch((error: unknown) => {
				// any endpoint can fail a handshake at will: one line a minute, however many do
				failures += 1;
				if (Date.now() - logged < 60_000) return;
				logged = Date.now();
				log(
					`remote: ${error instanceof Error ? error.message : String(error)}${failures > 1 ? ` (${failures} since the last line)` : ""}`,
				);
				failures = 0;
			});
		}
	})();

	return {
		id,
		reach: settings.reach,
		ticket: async () => {
			await Promise.race([online, new Promise((resolve) => setTimeout(resolve, ONLINE_MS).unref())]);
			return EndpointTicket.fromAddr(endpoint.addr()).toString();
		},
		connected: (peer) => (live.get(peer)?.size ?? 0) > 0,
		drop: (peer) => {
			for (const connection of live.get(peer) ?? []) closeWith(connection, "revoked");
		},
		close: async () => {
			closing = true;
			server.off("request", ask);
			for (const connections of live.values()) for (const connection of connections) closeWith(connection, "closing");
			await endpoint.close();
			await accepting;
		},
	};
}
