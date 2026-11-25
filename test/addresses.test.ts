/**
 * A literal address as banda judges it (src/core/addresses.ts): loopback, refused as private or as loopback inside
 * another form, or public, in each form a URL or a resolver writes it; walletRpc and the route that saves an RPC
 * both ask it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addressRefusal, bareHost, isLoopback, isLoopbackHost, publicAddress } from "../src/core/addresses.ts";
import { pbtRuns } from "./pbt.ts";

describe("a literal address, as a resolver answers it", () => {
	it("is loopback in the forms a URL's host takes as loopback, and in none other", () => {
		for (const ip of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])
			expect(isLoopback(ip)).toBe(true);
		for (const ip of ["::7f00:1", "64:ff9b::127.0.0.1", "2002:7f00:1::", "10.0.0.1", "localhost", "rpc.example"])
			expect(isLoopback(ip)).toBe(false);
	});

	it("is refused as walletRpc refuses the same address in a URL, dotted IPv6 tails included", () => {
		expect(addressRefusal("10.1.2.3")).toBe("private");
		expect(addressRefusal("169.254.169.254")).toBe("private");
		expect(addressRefusal("fd00::1")).toBe("private");
		expect(addressRefusal("fe80::1%en0")).toBe("private");
		expect(addressRefusal("::ffff:10.0.0.1")).toBe("private");
		expect(addressRefusal("64:ff9b::169.254.0.1")).toBe("private");
		expect(addressRefusal("64:ff9b::127.0.0.1")).toBe("embedded loopback");
		expect(addressRefusal("::7f00:1")).toBe("embedded loopback");
		// IPv6 that is not global unicast: documentation, discard-only and the benchmarking and Teredo ranges
		for (const ip of ["2001:db8::1", "3fff::1", "100::1", "2001:2::1", "2001::1"])
			expect(addressRefusal(ip)).toBe("private");
		for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2002:808:808::"])
			expect(addressRefusal(ip)).toBeUndefined();
		expect(() => addressRefusal("rpc.example")).toThrow(new Error("not a literal address"));
	});

	it("is public for a probe only where a wallet's RPC would take it as not loopback, and never through a translator", () => {
		// an IPv4-mapped address is the public IPv4 address it maps, however a resolver writes its tail
		for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808", "::ffff:1.1.1.1"])
			expect(publicAddress(ip)).toBe(true);
		for (const ip of ["127.0.0.1", "::1", "10.0.0.1", "fd00::1", "64:ff9b::8.8.8.8", "2002:808:808::", "::808:808"])
			expect(publicAddress(ip)).toBe(false);
		expect(publicAddress("rpc.example")).toBe(false);
		fc.assert(
			fc.property(fc.oneof(fc.ipV4(), fc.ipV6()), (ip) => {
				if (publicAddress(ip)) expect(isLoopback(ip) || addressRefusal(ip) !== undefined).toBe(false);
			}),
			{ numRuns: pbtRuns(200) },
		);
	});

	it("is this computer as a URL's host, with or without the brackets of an IPv6 literal", () => {
		expect(bareHost("[::1]")).toBe("::1");
		expect(bareHost("rpc.example")).toBe("rpc.example");
		for (const host of ["localhost", "127.0.0.1", "[::1]", "::1", "[::ffff:127.0.0.1]"])
			expect(isLoopbackHost(host)).toBe(true);
		for (const host of ["[2606:4700::1111]", "rpc.example", "localhost.example"])
			expect(isLoopbackHost(host)).toBe(false);
	});
});
