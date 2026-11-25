/**
 * `banda wallet create` against a daemon that answers a creation as under way (C21's `unsynced`, a keychain silent at
 * the read-back's `creating`): it sends the same request again, never a new one, so the answer that finishes the
 * creation is the one carrying its reveal (C14, C16, H-007); and when it still cannot finish, it prints the request id,
 * which `--request` takes back on the next run. The daemon is a stand-in on loopback, so the answers are the test's.
 */
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walletCommand } from "../src/cli/wallet.ts";
import { tempHome } from "./helpers.ts";

const ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const KEY = `0x${"4c".repeat(32)}`;

type Asked = { method: string; path: string; body: Record<string, unknown> };

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** A daemon for `home` that answers each creation request with `answers`' next refusal, then makes the wallet. */
async function daemon(
	answers: { status: number; code: string; error: string }[],
	reveals: { status: number; code: string; error: string }[] = [],
) {
	const home = await tempHome();
	const asked: Asked[] = [];
	const server = createServer((request, response) => {
		let text = "";
		request.on("data", (chunk) => {
			text += chunk;
		});
		request.on("end", () => {
			const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
			asked.push({ method: request.method ?? "", path: request.url ?? "", body });
			const reply = (status: number, json: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(json));
			};
			if (request.url === "/api/wallets") {
				const next = answers.shift();
				if (next !== undefined) return reply(next.status, { error: next.error, code: next.code });
				return reply(201, {
					wallet: { address: ADDRESS, name: body.name, network: body.network, state: "ready", backup: "unsaved" },
					reveal: { secret: "s".repeat(43), expires: Date.now() + 60_000 },
				});
			}
			if (request.url === `/api/wallets/${ADDRESS}/reveal`) {
				const next = reveals.shift();
				if (next !== undefined) return reply(next.status, { error: next.error, code: next.code });
				return reply(200, { address: ADDRESS, key: KEY });
			}
			reply(404, { error: "not found" });
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await writeFile(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port, token: "t" }));
	return { home, asked };
}

const UNSYNCED = {
	status: 503,
	code: "unsynced",
	error: "the change is made, but banda could not yet make it safe on disk: try again",
};
const creations = (asked: Asked[]) => asked.filter((each) => each.path === "/api/wallets");

describe("banda wallet create, when the creation is under way", () => {
	it("sends the same request again until the creation is finished, and reveals with that answer's secret", async () => {
		const { home, asked } = await daemon([
			UNSYNCED,
			{ status: 503, code: "creating", error: "the keychain didn't answer" },
		]);
		const printed: string[] = [];
		const code = await walletCommand(
			home,
			"create",
			["Rent"],
			{ network: "base-sepolia", terminal: true, wait: async () => {} },
			(text) => printed.push(text),
		);
		expect(code).toBe(0);
		const sent = creations(asked).map((each) => each.body.request);
		expect(sent).toHaveLength(3);
		expect(new Set(sent).size).toBe(1);
		expect(asked.at(-1)?.body).toEqual({ request: sent[0], secret: "s".repeat(43) });
		expect(printed.join("\n")).toContain(KEY);
		// how other wallets import it, and that there are no words to look for (H-008)
		expect(printed.join("\n")).toContain("Import account → Private key");
		expect(printed.join("\n")).toContain("There is no seed phrase");
	});

	it("passes a refusal that is not a creation under way through at once, sending nothing again", async () => {
		const { home, asked } = await daemon([{ status: 503, code: "no_keychain", error: "no keychain" }]);
		await expect(
			walletCommand(home, "create", ["Rent"], { network: "base-sepolia", terminal: true, wait: async () => {} }),
		).rejects.toThrow("no keychain");
		expect(creations(asked)).toHaveLength(1);
	});

	it("prints the request id when it cannot finish, and --request finishes that same creation", async () => {
		const { home, asked } = await daemon(Array(5).fill(UNSYNCED));
		const failed = await walletCommand(home, "create", ["Rent"], {
			network: "base-sepolia",
			terminal: true,
			wait: async () => {},
		}).then(
			() => undefined,
			(error: Error) => error,
		);
		const id = creations(asked)[0]?.body.request as string;
		expect(new Set(creations(asked).map((each) => each.body.request))).toEqual(new Set([id]));
		expect(failed?.message).toContain(`--request ${id}`);
		const printed: string[] = [];
		expect(
			await walletCommand(
				home,
				"create",
				["Rent"],
				{ network: "base-sepolia", terminal: true, request: id, wait: async () => {} },
				(text) => printed.push(text),
			),
		).toBe(0);
		expect(creations(asked).at(-1)?.body.request).toBe(id);
		expect(printed.join("\n")).toContain(KEY);
		await expect(
			walletCommand(home, "create", ["Rent"], { network: "base-sepolia", terminal: true, request: "no" }),
		).rejects.toThrow("--request");
	});
});

const LOCKED = { status: 503, code: "locked", error: "the keychain is locked: unlock it and try again" };
const revealsOf = (asked: Asked[]) => asked.filter((each) => each.path.endsWith("/reveal"));

describe("banda wallet create, when the key can't be shown yet", () => {
	it("asks for the key again with the same secret, then once the owner says go, and prints it", async () => {
		const { home, asked } = await daemon([], [LOCKED, LOCKED, LOCKED, LOCKED]);
		const said: string[] = [];
		const printed: string[] = [];
		const code = await walletCommand(
			home,
			"create",
			["Rent"],
			{
				network: "base-sepolia",
				terminal: true,
				wait: async () => {},
				again: async (words) => {
					said.push(words);
					return true;
				},
			},
			(text) => printed.push(text),
		);
		expect(code).toBe(0);
		const sent = revealsOf(asked).map((each) => each.body.secret);
		expect(sent).toHaveLength(5);
		expect(new Set(sent)).toEqual(new Set(["s".repeat(43)]));
		// the owner was asked once the tries on its own were spent, in the daemon's words
		expect(said).toHaveLength(2);
		expect(said[0]).toContain("the keychain is locked");
		expect(printed.join("\n")).toContain(KEY);
		// the creation was sent once: the secret was never dropped for a new answer that carries none (H-268)
		expect(creations(asked)).toHaveLength(1);
	});

	it("stops when the owner says no, and at once on a reveal that is gone", async () => {
		const stopped = await daemon([], Array(5).fill(LOCKED));
		await expect(
			walletCommand(stopped.home, "create", ["Rent"], {
				network: "base-sepolia",
				terminal: true,
				wait: async () => {},
				again: async () => false,
			}),
		).rejects.toThrow("its key wasn't shown: the keychain is locked");
		expect(revealsOf(stopped.asked)).toHaveLength(3);
		const gone = await daemon([], [{ status: 403, code: "spent", error: "The key is shown once" }]);
		let asked = false;
		await expect(
			walletCommand(gone.home, "create", ["Rent"], {
				network: "base-sepolia",
				terminal: true,
				wait: async () => {},
				again: async () => {
					asked = true;
					return true;
				},
			}),
		).rejects.toThrow("The key is shown once");
		expect(revealsOf(gone.asked)).toHaveLength(1);
		expect(asked).toBe(false);
	});
});

/** A daemon for `home` holding one wallet, named Rent, whose Receive answers `receive`. */
async function receiving(receive: Record<string, unknown>) {
	const home = await tempHome();
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			if (request.url === "/api/wallets")
				return response.end(
					JSON.stringify({
						wallets: [{ address: ADDRESS, name: "Rent", network: "base-sepolia", state: "ready", backup: "skipped" }],
						networks: [],
					}),
				);
			response.end(JSON.stringify(receive));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await writeFile(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port, token: "t" }));
	return home;
}

describe("banda wallet receive, when no address is given", () => {
	it("says each reason in its own words: the keychain for a key unchecked, the network only for an address unchecked", async () => {
		const said = async (receive: Record<string, unknown>) =>
			walletCommand(await receiving(receive), "receive", ["Rent"], {}, () => {}).then(
				() => "",
				(error: Error) => error.message,
			);
		expect(await said({ state: "save_first" })).toMatch(/^save Rent's key first/);
		expect(await said({ state: "code", acknowledged: false })).toMatch(/^code runs at Rent's address/);
		expect(await said({ state: "unopenable" })).toMatch(/^no key on this computer opens Rent/);
		const keyUnchecked = await said({ state: "key_unchecked" });
		expect(keyUnchecked).toMatch(/keychain didn't answer/);
		expect(keyUnchecked).not.toMatch(/network/);
		expect(await said({ state: "unchecked" })).toMatch(/could not check Rent's address on its network/);
	});

	it("finds a wallet by its name typed in another case, width or spacing, as the daemon does (H-041)", async () => {
		for (const typed of ["rent", "RENT", "ｒｅｎｔ", "  Rent  "]) {
			const said = await walletCommand(await receiving({ state: "save_first" }), "receive", [typed], {}, () => {}).then(
				() => "",
				(error: Error) => error.message,
			);
			expect(said).toMatch(/^save Rent's key first/);
		}
		const missed = await walletCommand(
			await receiving({ state: "save_first" }),
			"receive",
			["Rents"],
			{},
			() => {},
		).then(
			() => "",
			(error: Error) => error.message,
		);
		expect(missed).toBe("there is no wallet named Rents");
	});
});
