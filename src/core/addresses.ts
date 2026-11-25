/**
 * What an IP address is, in the one table banda holds every address to: this computer's loopback, or else private (a
 * range the public internet does not route, or a translator's local prefix), or public. A wallet's RPC may be
 * loopback or public (src/wallet/config.ts); a probe or an agent's fetch reaches public addresses alone
 * (src/core/public-fetch.ts).
 */
import { BlockList, isIP } from "node:net";

/**
 * Loopback as banda takes it: `127.0.0.0/8`, `::1`, and, because a BlockList maps them, the IPv4-mapped forms
 * `::ffff:127.0.0.0/104`. Loopback that another IPv6 form embeds (IPv4-compatible, NAT64, 6to4) names a translator or
 * a tunnel, not this computer, and is refused.
 */
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/**
 * IPv4 addresses that are not the public internet's, loopback aside: this network, private, shared, link-local, IETF
 * protocol assignments, documentation, the deprecated 6to4 relay anycast, benchmarking, multicast and reserved.
 */
const local4 = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 3],
] as const)
	local4.addSubnet(net, prefix, "ipv4");

/**
 * IPv6 ranges refused whatever they embed: unspecified, discard-only, RFC 9780's dummy prefix, IETF protocol
 * assignments (Teredo, benchmarking, ORCHID and ORCHIDv2 among them), both documentation ranges, SRv6 SIDs, unique
 * local, site-local, link-local, multicast, and RFC 8215's local-use NAT64 prefix, whose IPv4 position depends on a
 * length only the local network knows.
 */
const local6 = new BlockList();
for (const [net, prefix] of [
	["::", 128],
	["100::", 64],
	["100:0:0:1::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fec0::", 10],
	["fe80::", 10],
	["ff00::", 8],
	["64:ff9b:1::", 48],
] as const)
	local6.addSubnet(net, prefix, "ipv6");

/** Global unicast, the only IPv6 space the public internet routes (RFC 4291); `local6` carves its exceptions. */
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");

/** An IPv6 address's sixteen bytes, from the compressed hex form a URL's host normalises to. */
function bytes6(host: string): number[] {
	const [head = "", tail] = host.split("::");
	const groups = (part: string) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
	const left = groups(head);
	const right = tail === undefined ? [] : groups(tail);
	const words = [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
	return words.flatMap((word) => [word >> 8, word & 0xff]);
}

/**
 * The IPv4 address an IPv6 address carries, which a translator or tunnel reaches: IPv4-compatible (`::/96`), mapped
 * (`::ffff:0:0/96`), SIIT (`::ffff:0:0:0/96`), NAT64's well-known prefix (`64:ff9b::/96`) and 6to4 (`2002::/16`).
 */
function embedded4(host: string): string | undefined {
	const b = bytes6(host);
	const zero = (from: number, to: number) => b.slice(from, to).every((byte) => byte === 0);
	const v4 = (at: number) => b.slice(at, at + 4).join(".");
	if (zero(0, 10) && ((b[10] === 0 && b[11] === 0) || (b[10] === 0xff && b[11] === 0xff))) return v4(12);
	if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return v4(12);
	if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4(12);
	if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
	return undefined;
}

/**
 * An IPv6 address in the compressed hex form a URL's host normalises to, which `bytes6` reads: a resolver may write
 * the last 32 bits dotted. Undefined for a form a URL does not take, such as one with a zone, which only a link
 * reaches.
 */
function canonical6(ip: string): string | undefined {
	try {
		return bareHost(new URL(`http://[${ip}]/`).hostname);
	} catch {
		return undefined;
	}
}

/** A URL's host without the brackets an IPv6 literal is written in. */
export const bareHost = (host: string): string => host.replace(/^\[(.*)\]$/, "$1");

/** Whether a URL's host (a name, or a literal address with or without brackets) is this computer: localhost, or loopback. */
export function isLoopbackHost(host: string): boolean {
	const bare = bareHost(host);
	return bare === "localhost" || isLoopback(bare);
}

/** Whether `ip`, a literal address without brackets, is loopback as banda takes it. */
export function isLoopback(ip: string): boolean {
	const family = isIP(ip);
	if (family === 0) return false;
	return loopback.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Why a literal address that is not loopback (`isLoopback` decides first) is refused, or undefined when it is public.
 * It throws on a host name. `walletRpc` asks it of a URL's literal host, and the route that saves an RPC asks it of
 * each address the host name resolves to.
 */
export function addressRefusal(ip: string): "private" | "embedded loopback" | undefined {
	if (isIP(ip) === 0) throw new Error("not a literal address");
	if (isIP(ip) === 4) return local4.check(ip, "ipv4") ? "private" : undefined;
	const host = canonical6(ip);
	if (host === undefined) return "private";
	if (local6.check(host, "ipv6")) return "private";
	const inner = embedded4(host);
	if (inner !== undefined && loopback.check(inner, "ipv4")) return "embedded loopback";
	if (inner !== undefined) return local4.check(inner, "ipv4") ? "private" : undefined;
	return global6.check(host, "ipv6") ? undefined : "private";
}

/**
 * Whether `address`, a literal one, is one the public internet would answer on, to connect to: neither loopback nor
 * private, and no translator's or tunnel's form either (IPv4-compatible, SIIT, NAT64, 6to4), which reaches an IPv4
 * address through a box banda cannot see; an IPv4-mapped one is judged as the IPv4 address it is.
 */
export function publicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0 || isLoopback(address) || addressRefusal(address) !== undefined) return false;
	if (family === 4) return true;
	const host = canonical6(address);
	if (host === undefined) return false;
	const b = bytes6(host);
	const mapped = b.slice(0, 10).every((byte) => byte === 0) && b[10] === 0xff && b[11] === 0xff;
	return embedded4(host) === undefined || mapped;
}
