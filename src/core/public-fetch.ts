/**
 * A fetch that reaches only the public internet, for probing a server the companion named (DESIGN.md "Connections"):
 * https only, to an address that is no loopback, private, link-local, shared or multicast one, checked on the address
 * it connects to (so a name that resolves elsewhere once checked cannot slip through), never following a redirect,
 * never sending a credential, and reading at most a bounded answer. What the companion names can only ever be asked
 * what anyone on the internet could ask it.
 */
import { type LookupAddress, lookup } from "node:dns";
import { Agent, request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

/** What one probe's answer may weigh, and how long it may take, all of it. */
const MAX_PROBE_BYTES = 1024 * 1024;
const PROBE_MS = 10_000;

const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 96],
	["100::", 64],
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const)
	blocked.addSubnet(net, prefix, "ipv6");

/** Whether `address` is one the public internet would answer on. */
export function publicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	if (family === 6) {
		// an IPv4 address written as IPv6 is judged as the IPv4 one it is
		// an IPv4 address written as IPv6 (mapped, compatible, translated, 6to4) is never public by itself here: those
		// ranges are blocked whole, as is :: /96, so nothing reaches a private IPv4 address through them
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
		if (mapped !== undefined) return publicAddress(mapped);
		return !blocked.check(address, "ipv6");
	}
	return !blocked.check(address, "ipv4");
}

/** The resolver the connection uses: every address it would connect to must be public, or it does not connect. */
function publicLookup(
	hostname: string,
	options: { all?: boolean },
	callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
	lookup(hostname, { all: true }, (error, addresses) => {
		if (error) return callback(error, "");
		const found = addresses as LookupAddress[];
		if (found.length === 0 || !found.every((each) => publicAddress(each.address)))
			return callback(new Error(`${hostname} is not on the public internet`), "");
		if (options.all === true) return callback(null, found);
		const first = found[0] as LookupAddress;
		return callback(null, first.address, first.family);
	});
}

/** `fetch`, for probes: only https to public addresses, no redirect followed, no credential, a bounded answer. */
export const publicFetch: typeof fetch = (input, init = {}) =>
	new Promise<Response>((resolve, reject) => {
		let url: URL;
		try {
			url = new URL(input instanceof Request ? input.url : String(input));
		} catch {
			return reject(new Error("not an address"));
		}
		if (url.protocol !== "https:") return reject(new Error(`${url.host} is not https`));
		if (url.port !== "" && url.port !== "443") return reject(new Error(`${url.host}: a probe reaches port 443 only`));
		if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 && !publicAddress(url.hostname.replace(/^\[|\]$/g, "")))
			return reject(new Error(`${url.host} is not on the public internet`));
		const headers = new Headers(init.headers);
		// a probe carries nothing of the owner's
		headers.delete("authorization");
		headers.delete("cookie");
		const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : null;
		if (body === null) return reject(new Error("a probe sends text only"));
		const sent = request(
			url,
			{
				method: init.method ?? "GET",
				headers: Object.fromEntries(headers.entries()),
				lookup: publicLookup as never,
				// its own agent: no pooled socket shared, no proxy from the environment between it and what it checked
				agent: new Agent({ keepAlive: false }),
				timeout: PROBE_MS,
				signal: init.signal
					? AbortSignal.any([init.signal, AbortSignal.timeout(PROBE_MS)])
					: AbortSignal.timeout(PROBE_MS),
			},
			(answer) => {
				let size = 0;
				const bounded = answer.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_PROBE_BYTES) answer.destroy(new Error(`${url.host}'s answer is too large`));
				});
				const status = answer.statusCode ?? 502;
				const out = new Headers();
				for (const [key, value] of Object.entries(answer.headers))
					if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(", ") : value);
				// a redirect is answered as it is, never followed: what the companion named is the only place asked
				resolve(
					new Response(
						status === 204 || status === 304 || (init.method ?? "GET") === "HEAD"
							? null
							: (Readable.toWeb(bounded) as ReadableStream<Uint8Array>),
						{ status: status < 200 || status > 599 ? 502 : status, headers: out },
					),
				);
			},
		);
		sent.on("timeout", () => sent.destroy(new Error(`${url.host} did not answer in time`)));
		sent.on("error", reject);
		sent.end(body);
	});
