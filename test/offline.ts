/**
 * Tests never need the network (AGENTS.md): a `fetch` from a test's process to a host that is not this machine is
 * refused, and fails the test it ran in, even where the code that made it swallowed the refusal (an indexer's pass, a
 * balance read). A test fakes the service with a `fetch` or a server of its own on loopback.
 */
import { afterEach, expect } from "vitest";
import { isLoopbackHost } from "../src/core/addresses.ts";

const reached: string[] = [];
const real = globalThis.fetch;

const hostOf = (input: Parameters<typeof fetch>[0]): string | undefined => {
	try {
		const url = new URL(input instanceof Request ? input.url : String(input));
		return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : undefined;
	} catch {
		return undefined;
	}
};

globalThis.fetch = (input, init) => {
	const host = hostOf(input);
	if (host !== undefined && !isLoopbackHost(host)) {
		reached.push(host);
		return Promise.reject(new TypeError(`fetch failed: a test reached ${host}, and tests never reach the network`));
	}
	return real(input, init);
};

afterEach(() => {
	const hosts = [...new Set(reached.splice(0))];
	expect(hosts, "a test reached the network: fake the service instead").toEqual([]);
});
