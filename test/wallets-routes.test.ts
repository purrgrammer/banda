/**
 * The wallets' routes (src/server/routes/wallets.ts; UC-01 to UC-05, C16, OD-2): a wallet made over the API is ready,
 * not backed up and on for no agent; its key is revealed once, within ten minutes, with the secret only the creation's
 * own answer carries and from this computer alone, written onto the reveal's connection by the signer (in process on
 * the memory keystore, by a child handed the connection on a file one), so a second reveal, one without the secret, a
 * repeat of the creation (its request id alone), an expired one, one from a paired device, or one before the creation
 * finished show nothing; a paired device removes no wallet; a reveal the signer refuses (the key missing
 * or another, a keychain that refuses or does not answer, the lease another home's, any other failure) answers 503 in
 * fixed words, writes nothing onto the connection and leaves the reveal unspent, as does a connection gone before the
 * spend; a reveal spent whose hand-over then fails (the connection gone, the deadline passed) answers that it is spent
 * (UC-02 E5), and one whose spend could not be made safe on disk is taken back and answered as not yet safe (C21); a lease the keychain moved on for this home is caught up to; a saved copy is checked by its SHA-256 and
 * a wrong one leaves the wallet Not backed up; Receive waits for the save step and shows nothing at an address with
 * code (H-157); and the key is in no file of the home, blob or log after a creation and its reveal (H-005, H-010,
 * H-011). A creation the keychain refuses is told by its code: no keychain, waiting on it, or nothing kept. The money
 * that came in is listed newest first, at most 50 rows a page, Confirmed up to the final cursor, saying what it may miss
 * (still reading, a gap, an RPC that refuses log queries); a read of the chain that changed a balance pushes the
 * wallets to open screens, and one that changed nothing does not.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type Server, Socket } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { walletCommand } from "../src/cli/wallet.ts";
import { ActivityLog } from "../src/core/activity.ts";
import { LEAD } from "../src/core/agents.ts";
import { accountKey, Connected, credentialsOf, keepCredentials, WALLET } from "../src/core/connections.ts";
import { HOME_FORMAT } from "../src/core/format.ts";
import { Harnesses } from "../src/core/harness.ts";
import { context, openStore } from "../src/core/store.ts";
import { startDaemon } from "../src/daemon.ts";
import { installationId, readDaemonFile } from "../src/home.ts";
import type { WalletIncoming, WalletMade, WalletRevealed, WalletsView, WalletView } from "../src/server/api.ts";
import { BadRequest } from "../src/server/http.ts";
import type { AreaReply, AreaRequest, Deps } from "../src/server/routes/area.ts";
import { providerInstallation } from "../src/server/routes/providers.ts";
import { INCOMING_ROWS, nextResettle, walletsArea } from "../src/server/routes/wallets.ts";
import { type Address, checksummed } from "../src/wallet/address.ts";
import { Incoming, type IncomingGap, Wallets } from "../src/wallet/docs.ts";
import { IdentityMissing, leaseAccount, markTestHome, moveLease, signerHome } from "../src/wallet/home-id.ts";
import { createIndexer, type Indexer, type IndexerDeps } from "../src/wallet/indexer.ts";
import { emptyState, type FakeState, type KeystoreFault, memoryKeystore } from "../src/wallet/keystore.ts";
import { shortAddress } from "../src/wallet/label.ts";
import { UNSYNCED, WORDS } from "../src/wallet/lifecycle.ts";
import type { NetworkId } from "../src/wallet/networks.ts";
import { DEADLINE, Signer } from "../src/wallet/signer-client.ts";
import type { SignerCode } from "../src/wallet/signer-protocol.ts";
import { type Connected as Opened, openConnected } from "./fixtures/connected.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { FauxChain, GENESIS } from "./helpers/faux-chain.ts";
import { barriered, holdingKey, powerCut, type Store } from "./helpers/home-files.ts";
import { echoModels, tempHome, until } from "./helpers.ts";

const opened: Opened[] = [];
const stops: (() => Promise<void>)[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	for (const s of opened.splice(0)) await s.close();
	for (const server of servers.splice(0)) server.close();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	memoryKeystore().state = emptyState();
});

/**
 * Two ends of one loopback connection: the daemon's, which a reveal is written onto, and the client's, which reads
 * until the connection closes, or says what it has received so far.
 */
async function connection(): Promise<{
	daemon: Socket;
	client: Socket;
	read: () => Promise<string>;
	received: () => string;
}> {
	let accepted: (socket: Socket) => void = () => {};
	const arrived = new Promise<Socket>((resolve) => {
		accepted = resolve;
	});
	const server = createServer((socket) => accepted(socket));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const client = new Socket();
	await new Promise<void>((resolve) => client.connect(port, "127.0.0.1", resolve));
	const chunks: Buffer[] = [];
	client.on("data", (chunk) => chunks.push(chunk));
	const ended = new Promise<string>((resolve) => client.on("close", () => resolve(Buffer.concat(chunks).toString())));
	return {
		daemon: await arrived,
		client,
		read: () => ended,
		received: () => Buffer.concat(chunks).toString(),
	};
}

/** The JSON body of an HTTP response as the signer wrote it whole. */
function bodyOf(response: string): { status: number; headers: string; body: unknown } {
	const [head = "", body = ""] = response.split("\r\n\r\n");
	return { status: Number(head.split(" ")[1]), headers: head.toLowerCase(), body: JSON.parse(body) };
}

/** Whether a process of this pid is alive. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Base Sepolia's chain id, which the world's wallets are made on, as an RPC answers it. */
const BASE_SEPOLIA_ID = `0x${(84532).toString(16)}`;

/**
 * A faux JSON-RPC: `eth_chainId` answers `chainId` (Base Sepolia's), `eth_getCode` answers `code`, every other method an
 * error, so nothing leaves the machine.
 */
const fauxRpc =
	(code = "0x", chainId = BASE_SEPOLIA_ID): typeof fetch =>
	async (_url, init) => {
		const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
		const answer =
			method === "eth_getCode"
				? { jsonrpc: "2.0", id, result: code }
				: method === "eth_chainId"
					? { jsonrpc: "2.0", id, result: chainId }
					: { jsonrpc: "2.0", id, error: { code: -32601, message: "not offered here" } };
		return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
	};

async function world(
	keystore = "1",
	options: {
		deadline?: number;
		code?: string;
		fetch?: typeof fetch;
		wakes?: string[];
		sync?: () => Promise<void>;
		/** How often the area's settling timer looks, which also passes a barrier while the view is frozen. */
		resettle?: number;
		/** The indexer the area runs, as the test wraps it. */
		indexer?: (indexer: Indexer) => Indexer;
		/** Each change the indexer reports (its `onChange`), apart from every other push the area makes. */
		changes?: number[];
	} = {},
) {
	vi.stubEnv("BANDA_TEST_KEYSTORE", keystore);
	const home = await tempHome();
	const s = await openConnected({ home, respond: () => fauxAssistantMessage("Done.") });
	opened.push(s);
	const logs: string[] = [];
	const pushes: number[] = [];
	const wakes = options.wakes;
	const start = () =>
		walletsArea({
			...(options.deadline === undefined ? {} : { signer: { deadline: options.deadline } }),
			...(options.sync === undefined ? {} : { sync: options.sync }),
			...(options.resettle === undefined ? {} : { resettle: options.resettle }),
			...(wakes === undefined && options.indexer === undefined && options.changes === undefined
				? {}
				: {
						indexer: (deps: IndexerDeps) => {
							const changes = options.changes;
							const made = createIndexer(
								changes === undefined
									? deps
									: {
											...deps,
											onChange: (network: NetworkId) => {
												changes.push(Date.now());
												deps.onChange?.(network);
											},
										},
							);
							const indexer = options.indexer?.(made) ?? made;
							return wakes === undefined
								? indexer
								: {
										...indexer,
										wake: (network?: NetworkId) => {
											wakes.push(network ?? "every");
											indexer.wake(network);
										},
									};
						},
					}),
		}).start?.({
			harness: s.harness,
			home,
			box: "container",
			log: (line: string) => logs.push(line),
			changed: () => {},
			connections: s.capabilities,
			fetch: options.fetch ?? fauxRpc(options.code),
			...(options.fetch === undefined ? {} : { changed: () => pushes.push(Date.now()) }),
		} as unknown as Deps);
	let area = start();
	if (area?.route === undefined) throw new Error("no wallets area");
	stops.push(async () => area?.stop?.());
	let route = area.route;
	/** The daemon restarted: its area stopped and another started on the same store, with nothing kept in memory. */
	const restart = async () => {
		await area?.stop?.();
		area = start();
		if (area?.route === undefined) throw new Error("no wallets area");
		route = area.route;
	};
	const call = async (
		method: string,
		path: string,
		body: Record<string, unknown> = {},
		more: Partial<AreaRequest> = {},
	): Promise<AreaReply | undefined> =>
		route({
			method,
			path,
			url: new URL(`http://local/api${path}`),
			json: async () => body,
			signal: new AbortController().signal,
			...more,
		});
	const json = async (method: string, path: string, body?: Record<string, unknown>, more?: Partial<AreaRequest>) => {
		const reply = await call(method, path, body, more);
		if (reply === undefined || !("body" in reply)) throw new Error(`no JSON from ${path}`);
		return reply.body;
	};
	let made = 0;
	/** The secret each creation's answer carried, by its request. */
	const secrets = new Map<string, string>();
	const secret = (request: string) => secrets.get(request) ?? "";
	const create = async (more: Partial<AreaRequest> = {}, request = `request-${process.pid}-${++made}`) => {
		const answered = (await json(
			"POST",
			"/wallets",
			{ request, name: "Groceries", network: "base-sepolia" },
			more,
		)) as WalletMade;
		if (answered.reveal !== undefined) secrets.set(request, answered.reveal.secret);
		return { request, wallet: answered.wallet, reveal: answered.reveal };
	};
	/** A reveal on `ends`' daemon side, with the creation's secret unless another is given, read on the client side. */
	const reveal = async (
		address: string,
		request: string,
		ends: Awaited<ReturnType<typeof connection>>,
		given = secret(request),
	) => {
		const reply = await call("POST", `/wallets/${address}/reveal`, { request, secret: given });
		if (reply === undefined || !("hand" in reply)) throw new Error("the reveal took no connection");
		const after = await reply.hand(ends.daemon);
		if (after !== undefined) return { refused: after };
		return { response: bodyOf(await ends.read()) };
	};
	const view = async () => (await json("GET", "/wallets")) as WalletsView;
	const record = async (address: string) => (await s.harness.snapshot(Wallets, context))?.wallets[address];
	const lease = async () => (await s.harness.snapshot(Wallets, context))?.lease;
	/** The wallets' event of the shell stream, as every open screen and paired phone is pushed it. */
	const shell = async () =>
		((await area?.shell?.()) ?? []).find((event) => event.type === "wallets") as
			| { type: "wallets"; wallets: WalletsView }
			| undefined;
	return { s, home, logs, pushes, call, json, create, reveal, secret, view, record, lease, keystore, restart, shell };
}

/** The test keystore's state, changed by `change`: the process's memory one, or the file a signer child reads. */
async function editKeys(keystore: string, change: (state: FakeState) => void): Promise<void> {
	if (keystore === "1") return change(memoryKeystore().state);
	const state = JSON.parse(await readFile(keystore, "utf8")) as FakeState;
	change(state);
	await writeFile(keystore, JSON.stringify(state));
}

const itemOf = (state: FakeState, part: string): string => {
	const account = Object.keys(state.items).find((each) => each.includes(part));
	if (account === undefined) throw new Error(`no item for ${part}`);
	return account;
};

/** The keychain's lease moved to the next epoch: still this home's, or (`holder` given) another's. */
const moveLeaseItem = (keystore: string, holder?: string) =>
	editKeys(keystore, (state) => {
		const account = itemOf(state, "/lease");
		const lease = JSON.parse(state.items[account] as string) as { epoch: number; holder: string };
		state.items[account] = JSON.stringify({ epoch: lease.epoch + 1, holder: holder ?? lease.holder });
	});

/** Where the signer runs: in process on the memory keystore, or in a child on a file one. */
const SIGNERS = [
	{ where: "in process", keystore: async () => "1", deadline: 1_000 },
	{ where: "in a signer child", keystore: async () => join(await tempHome(), "keychain.json"), deadline: 4_000 },
] as const;

const refusedWith = async (promise: Promise<unknown>, status: number) => {
	const error = await promise.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(BadRequest);
	expect((error as BadRequest).status).toBe(status);
	return error as BadRequest;
};

/** The activity's lines that say a reveal was spent: the owner asked to see a key, handed or not. */
const asked = async (w: { s: Opened }) =>
	((await w.s.harness.snapshot(ActivityLog, context))?.events ?? [])
		.map((event) => event.what)
		.filter((what) => what.startsWith("You asked to see the key of the wallet Groceries ("));

/** The activity's lines that say the owner saw a key. */
const saw = async (w: { s: Opened }) =>
	((await w.s.harness.snapshot(ActivityLog, context))?.events ?? [])
		.map((event) => event.what)
		.filter((what) => what.startsWith("You saw the key of the wallet Groceries"));

const digest = (key: string) => createHash("sha256").update(key.toLowerCase()).digest("hex");

describe("settling again what the keychain left (UC-01 E1)", () => {
	it("waits twice as long after each refusal up to a cap, stops for a refusal no wait mends, and starts over", () => {
		const base = 30_000;
		let wait = base;
		const waits: number[] = [];
		for (let n = 0; n < 8; n++) {
			wait = nextResettle(wait, base, { left: true, refused: ["locked"] }) ?? 0;
			waits.push(wait);
		}
		expect(waits.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000]);
		expect(waits.slice(5)).toEqual([900_000, 900_000, 900_000]);
		expect(nextResettle(wait, base, "failed")).toBe(900_000);
		expect(nextResettle(60_000, base, "failed")).toBe(120_000);
		// the keychain answered, or nothing is left: back to the first wait
		expect(nextResettle(wait, base, { left: true, refused: [] })).toBe(base);
		expect(nextResettle(wait, base, { left: false, refused: ["locked"] })).toBe(base);
		// another home's lease, or two matching items: only the owner's act mends it, so no timer
		expect(nextResettle(base, base, { left: true, refused: ["locked", "other_home"] })).toBeUndefined();
		expect(nextResettle(base, base, { left: true, refused: ["ambiguous"] })).toBeUndefined();
	});
});

describe("the wallets' routes", () => {
	it("makes a wallet, reveals its key once with the creation's secret, and keeps it out of every file", async () => {
		const w = await world();
		const ends = await connection();
		const { request, wallet, reveal } = await w.create();
		expect(wallet).toMatchObject({ state: "ready", backup: "unsaved", agents: [], disclosed: false });
		expect(reveal?.expires).toBeGreaterThan(Date.now());
		expect(reveal?.secret).toMatch(/^[\w-]{43}$/);
		// the secret is the creation's answer's alone: no view, the shell's event among them, shows it or the reveal
		expect(JSON.stringify(await w.view())).not.toContain(reveal?.secret);
		expect(Object.keys((await w.view()).wallets[0] ?? {})).not.toContain("reveal");
		expect(JSON.stringify(await w.record(wallet.address))).not.toContain(reveal?.secret);
		const shown = await w.reveal(wallet.address, request, ends);
		expect(shown.response?.status).toBe(200);
		expect(shown.response?.headers).toContain("cache-control: no-store");
		const { address, key } = (shown.response as { body: WalletRevealed }).body;
		expect(address).toBe(wallet.address);
		expect(key).toMatch(/^0x[0-9a-f]{64}$/);
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(wallet.address);
		// spent: the same request and secret again show nothing
		const again = await connection();
		await refusedWith(w.reveal(wallet.address, request, again), 403);
		expect((await w.record(wallet.address))?.reveal).toBeUndefined();
		expect((await asked(w)).length).toBe(1);
		// the key is in no file of the home (the store, its WAL, the blobs) and in no log line
		expect(holdingKey(w.home, key)).toEqual([]);
		expect(w.logs.join("\n")).not.toContain(key.slice(2));
		expect(w.s.logs.join("\n")).not.toContain(key.slice(2));
		// the saved copy is checked by its digest: a wrong one leaves it Not backed up, the right one backs it up
		await refusedWith(
			w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(`0x${"1".repeat(64)}`) }),
			409,
		);
		expect((await w.view()).wallets[0]?.backup).toBe("unsaved");
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/saved`, { digest: key }), 400);
		const saved = (await w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(key) })) as WalletsView;
		expect(saved.wallets[0]?.backup).toBe("saved");
	});

	it("backs up a wallet whose save was skipped when the owner checks the right copy later, and says a wrong one is wrong (H-266)", async () => {
		const w = await world();
		const ends = await connection();
		const { request, wallet } = await w.create();
		const { key } = ((await w.reveal(wallet.address, request, ends)).response as { body: WalletRevealed }).body;
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		expect((await w.json("POST", `/wallets/${wallet.address}/receive`)) as { state: string }).toMatchObject({
			state: "ready",
		});
		const wrong = await refusedWith(
			w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(`0x${"1".repeat(64)}`) }),
			409,
		);
		expect(wrong.code).toBe("wrong_copy");
		expect((await w.view()).wallets[0]?.backup).toBe("skipped");
		const saved = (await w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(key) })) as WalletsView;
		expect(saved.wallets[0]?.backup).toBe("saved");
	});

	it("refuses a reveal without the creation's secret, with another request, expired, or once the wallet is archived", async () => {
		const w = await world();
		const made = await connection();
		const { request, wallet } = await w.create();
		// the request id alone, or with a secret that is not the creation's, opens nothing and spends nothing (H-267)
		for (const given of ["", "not-the-secret", `${w.secret(request)}x`]) {
			const without = await refusedWith(w.reveal(wallet.address, request, made, given), 403);
			expect(without.code).toBe("spent");
		}
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/reveal`, { request }), 403);
		expect((await w.record(wallet.address))?.reveal).toBeDefined();
		expect(await asked(w)).toEqual([]);
		const spent = await refusedWith(w.reveal(wallet.address, "request-other-1", made, w.secret(request)), 403);
		expect(spent.code).toBe("spent");
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/reveal`, {}), 403);
		// it is still the creation's to spend
		await w.s.harness.commit(async (tx) => {
			const record = (await tx.doc(Wallets)).wallets[wallet.address];
			if (record?.reveal !== undefined) record.reveal.expires = Date.now() - 1;
		}, context);
		await refusedWith(w.reveal(wallet.address, request, made), 403);
		const second = await connection();
		const other = await w.create();
		await w.json("POST", `/wallets/${other.wallet.address}/archive`, { version: other.wallet.version });
		await refusedWith(w.reveal(other.wallet.address, other.request, second), 403);
	});

	it("answers the creation's reveal on whichever connection its client sends it, once", async () => {
		const w = await world();
		const made = await connection();
		const { request, wallet } = await w.create();
		// a browser sends the reveal on any of its keep-alive sockets: the secret, not the socket, is what opens it
		const elsewhere = await connection();
		const shown = await w.reveal(wallet.address, request, elsewhere);
		expect(shown.response?.status).toBe(200);
		expect(made.received()).toBe("");
		expect(await asked(w)).toHaveLength(1);
		await refusedWith(w.reveal(wallet.address, request, made), 403);
	});

	it("grants a repeat of the creation no reveal: its request id, on another connection, opens nothing (C14, C16)", async () => {
		const w = await world();
		const first = await connection();
		const { request, wallet, reveal } = await w.create();
		expect(reveal).toBeDefined();
		// another client with the owner's token and the creation's request id (it is in the store) makes it again
		const other = await connection();
		const again = (await w.json("POST", "/wallets", {
			request,
			name: "Groceries",
			network: "base-sepolia",
		})) as WalletMade;
		expect(again.wallet.address).toBe(wallet.address);
		expect(again.reveal).toBeUndefined();
		await refusedWith(w.reveal(wallet.address, request, other, ""), 403);
		expect(other.received()).toBe("");
		expect(await asked(w)).toEqual([]);
		// the repeat bound nothing over the creation's: its client still sees the key, once
		const shown = await w.reveal(wallet.address, request, first);
		expect(shown.response?.status).toBe(200);
		expect(await asked(w)).toHaveLength(1);
	});

	it("refuses a repeat of a creation that asks another network or name with a 409 naming the wallet it made (C14, OD-9)", async () => {
		const w = await world();
		const { request, wallet } = await w.create();
		for (const other of [
			{ request, name: "Groceries", network: "base" },
			{ request, name: "Travel", network: "base-sepolia" },
		]) {
			const refused = await refusedWith(w.json("POST", "/wallets", other), 409);
			expect(refused.message).toContain(`Groceries (${wallet.address.slice(0, 6)}`);
		}
		const kept = await w.record(wallet.address);
		expect([kept?.name, kept?.network]).toEqual(["Groceries", "base-sepolia"]);
		expect((await w.view()).wallets).toHaveLength(1);
	});

	it("spends a reveal only with the secret bound when it is spent: a repeat's claim after a restart takes over (C16)", async () => {
		const w = await world();
		const ends = await connection();
		const { request, wallet } = await w.create();
		const before = w.secret(request);
		await w.restart();
		// the reveal with the secret from before the restart passes the check before its hand
		const reply = await w.call("POST", `/wallets/${wallet.address}/reveal`, { request, secret: before });
		if (reply === undefined || !("hand" in reply)) throw new Error("the reveal took no connection");
		// a repeat of the creation claims again before the spend: its own secret is the one bound now
		const again = (await w.json("POST", "/wallets", {
			request,
			name: "Groceries",
			network: "base-sepolia",
		})) as WalletMade;
		const now = again.reveal?.secret as string;
		expect(now).toEqual(expect.any(String));
		expect(now).not.toBe(before);
		const after = await reply.hand(ends.daemon);
		expect(after).toMatchObject({ status: 403 });
		await new Promise((resolve) => setImmediate(resolve));
		expect(ends.received()).toBe("");
		expect(await asked(w)).toEqual([]);
		// the client the daemon just handed the new secret to still sees the key, once
		const shown = await w.reveal(wallet.address, request, await connection(), now);
		expect(shown.response?.status).toBe(200);
		expect(await asked(w)).toHaveLength(1);
	});

	it("says the reveal is gone when it expired while the signer proved the key, and shows nothing", async () => {
		const w = await world();
		const ends = await connection();
		const { request, wallet } = await w.create();
		const reply = await w.call("POST", `/wallets/${wallet.address}/reveal`, { request, secret: w.secret(request) });
		if (reply === undefined || !("hand" in reply)) throw new Error("the reveal took no connection");
		await w.s.harness.commit(async (tx) => {
			const record = (await tx.doc(Wallets)).wallets[wallet.address];
			if (record?.reveal !== undefined) record.reveal.expires = Date.now() - 1;
		}, context);
		const after = await reply.hand(ends.daemon);
		expect(after).toMatchObject({ status: 403 });
		expect(JSON.stringify(after)).not.toMatch(/0x[0-9a-f]{64}/);
		await new Promise((resolve) => setImmediate(resolve));
		expect(ends.received()).toBe("");
		expect(await asked(w)).toEqual([]);
	});

	it("shows a key to one of two reveals that race on the creation's connection", async () => {
		const w = await world();
		const ends = await connection();
		const { request, wallet } = await w.create();
		const asking = { request, secret: w.secret(request) };
		const first = await w.call("POST", `/wallets/${wallet.address}/reveal`, asking);
		const second = await w.call("POST", `/wallets/${wallet.address}/reveal`, asking);
		if (first === undefined || second === undefined || !("hand" in first) || !("hand" in second))
			throw new Error("the reveals took no connection");
		await Promise.all([first.hand(ends.daemon), second.hand(ends.daemon)]);
		const { key } = bodyOf(await ends.read()).body as WalletRevealed;
		expect((await asked(w)).length).toBe(1);
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(wallet.address);
	});

	it("refuses a paired device a reveal, the save step, removal, the RPC, the keychain's checks and the desktop's word, and mints a phone's creation no reveal", async () => {
		const w = await world();
		const device = { device: "phone-endpoint" };
		const phone = await connection();
		const { request, wallet, reveal } = await w.create(device);
		expect(wallet).toMatchObject({ state: "ready", backup: "unsaved" });
		expect(reveal).toBeUndefined();
		for (const [path, body] of [
			[`/wallets/${wallet.address}/reveal`, { request }],
			[`/wallets/${wallet.address}/revealed`, {}],
			[`/wallets/${wallet.address}/skip`, {}],
			[`/wallets/${wallet.address}/saved`, { digest: "0".repeat(64) }],
			[`/wallets/${wallet.address}/remove`, { version: wallet.version }],
			[`/wallets/${wallet.address}/check`, {}],
			["/wallets/keychain", {}],
		] as const)
			await refusedWith(w.call("POST", path, body, device), 403);
		const rpc = await refusedWith(w.call("PUT", "/wallets/rpc/base-sepolia", { url: null }, device), 403);
		// an act that shows no key says nothing of one; an act on the key says it is shown only on the computer
		expect(rpc.message).toBe("Open banda on your computer to do this.");
		const removal = await refusedWith(
			w.call("POST", `/wallets/${wallet.address}/remove`, { version: wallet.version }, device),
			403,
		);
		expect(removal.message).not.toContain("key");
		const acknowledging = await refusedWith(
			w.call("POST", `/wallets/${wallet.address}/acknowledge-code`, {}, device),
			403,
		);
		expect(acknowledging.message).not.toContain("key");
		const skipping = await refusedWith(w.call("POST", `/wallets/${wallet.address}/skip`, {}, device), 403);
		expect(skipping.message).toContain("key is shown only there");
		// listing the keychain's items may prompt on the computer's screen, and names keys no wallet does
		await refusedWith(w.call("GET", "/wallets/orphans", {}, device), 403);
		// a stolen phone deletes no key: the record and its keychain item are both kept (UC-18)
		expect((await w.record(wallet.address))?.state).toBe("ready");
		expect(Object.keys(memoryKeystore().state.items).some((item) => item.includes(`/wallet/${wallet.address}`))).toBe(
			true,
		);
		// the computer cannot spend it either: the phone's creation minted no secret, and a repeat of it from the
		// computer, with its request id, mints none
		await refusedWith(w.reveal(wallet.address, request, phone), 403);
		const computer = await connection();
		const replayed = await w.create({}, request);
		expect(replayed.wallet.address).toBe(wallet.address);
		expect(replayed.reveal).toBeUndefined();
		await refusedWith(w.reveal(wallet.address, request, computer, ""), 403);
		// the phone ends no save step: the computer shows the step at its next open, and may skip it (H-276)
		expect((await w.json("GET", "/wallets")) as WalletsView).toMatchObject({ wallets: [{ backup: "unsaved" }] });
		expect(((await w.json("POST", `/wallets/${wallet.address}/skip`, {})) as WalletsView).wallets[0]?.backup).toBe(
			"skipped",
		);
	});

	it("lists the desktop's word that the owner saw a ready wallet's key, and refuses it for no such wallet", async () => {
		const w = await world();
		const { wallet } = await w.create();
		const before = await asked(w);
		const view = (await w.json("POST", `/wallets/${wallet.address}/revealed`, { id: "a-showing" })) as WalletsView;
		expect(view.wallets[0]?.address).toBe(wallet.address);
		// the view says when it was last shown, and no more: the list goes with the wallet's own page (H-214)
		expect(view.wallets[0]?.revealed).toEqual(expect.any(Number));
		expect(JSON.stringify(view)).not.toContain("a-showing");
		// listed in the wallet's own activity too, not only the home's (UC-02 A2, H-266, OD-2), in its declared shape:
		// the desktop's retry id stays in the store
		const page = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
		expect(page.reveals).toEqual([{ at: view.wallets[0]?.revealed, kind: "later" }]);
		expect(JSON.stringify(page)).not.toContain("a-showing");
		expect((await w.record(wallet.address))?.reveals?.at(-1)?.id).toBe("a-showing");
		const lines = await saw(w);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/ on this computer$/);
		expect(await asked(w)).toEqual(before);
		await refusedWith(w.json("POST", "/wallets/0x000000000000000000000000000000000000dEaD/revealed"), 404);
		const other = await w.create();
		await w.json("POST", `/wallets/${other.wallet.address}/archive`, { version: other.wallet.version });
		expect((await w.record(other.wallet.address))?.state).toBe("archived");
		await refusedWith(w.json("POST", `/wallets/${other.wallet.address}/revealed`), 404);
		expect(await saw(w)).toEqual(lines);
	});

	it("reads the wallet's network at the fast cadence while Receive or the wallet's page is open (UC-14)", async () => {
		const looks: string[] = [];
		const wakes: string[] = [];
		const w = await world("1", {
			wakes,
			indexer: (indexer) => ({
				...indexer,
				looking: (network) => {
					looks.push(network);
					indexer.looking(network);
				},
			}),
		});
		const { wallet } = await w.create();
		// Receive that gives no address yet looks at nothing
		await w.json("POST", `/wallets/${wallet.address}/receive`);
		expect(looks).toEqual([]);
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		wakes.splice(0);
		// Receive that shows the address reads its network now and looks at it
		await w.json("POST", `/wallets/${wallet.address}/receive`);
		expect(looks).toEqual(["base-sepolia"]);
		expect(wakes).toEqual(["base-sepolia"]);
		// the wallet's page looks at it with its first page of rows, and renews the look while it stays open
		await w.json("GET", `/wallets/${wallet.address}/incoming`);
		expect(looks).toEqual(["base-sepolia", "base-sepolia"]);
		expect(await w.json("POST", `/wallets/${wallet.address}/looking`)).toEqual({});
		expect(looks).toEqual(["base-sepolia", "base-sepolia", "base-sepolia"]);
		expect(await w.call("GET", `/wallets/${wallet.address}/looking`)).toMatchObject({ status: 405 });
		await refusedWith(w.json("POST", "/wallets/0x000000000000000000000000000000000000dEaD/looking"), 404);
	});

	it("opens Receive after the save step, and switches the wallet on for an agent", async () => {
		const w = await world();
		const { wallet } = await w.create();
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "save_first" });
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({
			state: "ready",
			address: wallet.address,
			network: "base-sepolia",
		});
		expect((await w.view()).wallets[0]?.disclosed).toBe(true);
		const on = (await w.json("POST", `/wallets/${wallet.address}/agents/${LEAD}`, { on: true })) as WalletsView;
		expect(on.wallets[0]?.agents).toEqual([LEAD]);
		const off = (await w.json("POST", `/wallets/${wallet.address}/agents/${LEAD}`, { on: false })) as WalletsView;
		expect(off.wallets[0]?.agents).toEqual([]);
		await refusedWith(w.json("POST", "/wallets/0x1234/skip"), 404);
		// an action banda has not falls through to not found, whatever the method; a known one takes POST alone
		expect(await w.call("GET", `/wallets/${wallet.address}/nonsense`)).toBeUndefined();
		expect(await w.call("POST", `/wallets/${wallet.address}/nonsense`)).toBeUndefined();
		expect(await w.call("GET", `/wallets/${wallet.address}/skip`)).toMatchObject({ status: 405 });
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/archive`, { version: 1 }), 409);
	});

	it("checks the key and says how it signs, and a missing key takes it to key_missing", async () => {
		const w = await world();
		const { wallet } = await w.create();
		const checked = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
		expect(checked.wallets[0]?.signing).toEqual({ state: "online" });
		const items = memoryKeystore().state.items;
		for (const account of Object.keys(items)) if (account.includes("/wallet/")) delete items[account];
		const lost = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
		expect(lost.wallets[0]?.signing?.state).toBe("key_missing");
	});

	it("says debugging, and touches no key, for a check while the daemon runs with an inspector asked for", async () => {
		const w = await world();
		const { wallet } = await w.create();
		const options = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS = `${options ?? ""} --inspect`;
		try {
			const checked = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
			expect(checked.wallets[0]?.signing).toEqual({ state: "locked", code: "debugging" });
		} finally {
			if (options === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = options;
		}
		const again = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
		expect(again.wallets[0]?.signing).toEqual({ state: "online" });
	});

	it("hands the creation's connection to a signer child, which writes the key onto it (a file keystore)", async () => {
		const outside = await tempHome();
		const w = await world(join(outside, "keychain.json"));
		const ends = await connection();
		const { request, wallet } = await w.create();
		const shown = await w.reveal(wallet.address, request, ends);
		const { key } = (shown.response as { body: WalletRevealed }).body;
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(wallet.address);
		expect(holdingKey(w.home, key)).toEqual([]);
		await refusedWith(w.reveal(wallet.address, request, await connection()), 403);
	});

	it("through the daemon, a signer child handed the creation's connection leaves the daemon free to stop", async () => {
		const area = await tempHome();
		vi.stubEnv("BANDA_TEST_KEYSTORE", join(area, "keychain.json"));
		const home = join(area, "home");
		const web = join(area, "web");
		await mkdir(home);
		await mkdir(web);
		await markTestHome(home);
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: hostBox(home),
			web,
			fetch: fauxRpc(),
		});
		let closed = false;
		stops.push(async () => {
			if (!closed) await daemon.close();
		});
		const printed: string[] = [];
		expect(
			await walletCommand(home, "create", ["Rent"], { network: "base-sepolia", terminal: true }, (text) =>
				printed.push(text),
			),
		).toBe(0);
		const key = /\b(0x[0-9a-f]{64})\b/.exec(printed.join("\n"))?.[1];
		const address = privateKeyToAddress(key as `0x${string}`);
		// beside the key, while its save step is open, the address is short: the whole one leaves only through Receive,
		// which marks it disclosed first (H-005, C17)
		expect(printed.join("\n")).toContain(`made Rent on base-sepolia: ${shortAddress(address)}`);
		expect(printed.join("\n")).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
		const token = (await readDaemonFile(home))?.token;
		const listed = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/wallets`, { headers: { authorization: `Bearer ${token}` } })
		).json()) as WalletsView;
		expect(listed.wallets.find((one) => one.address === address)).toMatchObject({
			backup: "unsaved",
			disclosed: false,
		});
		// a server whose socket went to a child would wait forever on that child for its connections: the test's own
		// timeout is the bound
		closed = true;
		await daemon.close();
	});

	it("through the daemon: a keychain that never answers leaves fs, crypto and dns answering, and the daemon closes past it (H-032, H-034)", {
		timeout: 30_000,
	}, async () => {
		const area = await tempHome();
		// every get and every set hangs for good, as calls behind prompts nobody answers: one file per process that
		// calls, so no child's record of its call is written over by another's
		const hung = async (name: string) => {
			const path = join(area, `${name}.json`);
			const state: FakeState = {
				items: {},
				faults: [
					{ point: "keychain:read", hang: true },
					{ point: "keychain:write", hang: true },
				],
				calls: [],
			};
			await writeFile(path, JSON.stringify(state));
			return path;
		};
		const keys = await hung("keychain");
		vi.stubEnv("BANDA_TEST_KEYSTORE", keys);
		const home = join(area, "home");
		const web = join(area, "web");
		await mkdir(home);
		await mkdir(web);
		await markTestHome(home);
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: hostBox(home),
			web,
			fetch: fauxRpc(),
		});
		let closed = false;
		stops.push(async () => {
			if (!closed) await daemon.close();
		});
		const token = (await readDaemonFile(home))?.token;
		// four creations through the daemon, each waiting on the keychain
		const creations = [1, 2, 3, 4].map((n) =>
			fetch(`http://127.0.0.1:${daemon.port}/api/wallets`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ request: `request-hung-${n}`, name: `Hung ${n}`, network: "base-sepolia" }),
			}).catch(() => undefined),
		);
		// and four reads of other homes at once, so four signer children hang side by side, past the libuv pool's four
		const files = await Promise.all([1, 2, 3, 4].map((n) => hung(`other-${n}`)));
		const others = files.map(
			(path, n) =>
				new Signer(
					{ id: `h-hung-${n}`, binding: "ab".repeat(32) },
					{ env: { ...process.env, BANDA_TEST_KEYSTORE: path } },
				),
		);
		const reads = others.map((signer) => signer.leased());
		const pending = async (path: string) => {
			const state = JSON.parse(await readFile(path, "utf8")) as FakeState;
			return state.calls.filter((call) => call.end === undefined);
		};
		const hanging = async () => (await Promise.all([keys, ...files].map(pending))).flat();
		await until(async () => ((await hanging()).length >= 5 ? true : undefined));
		// the daemon's own fs, crypto and dns still answer while every one of them hangs
		const bound = <T>(work: Promise<T>) =>
			Promise.race([
				work,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("blocked behind the keychain")), 2_000)),
			]);
		const { pbkdf2 } = await import("node:crypto");
		const { lookup } = await import("node:dns/promises");
		const derived = (n: number) =>
			new Promise<Buffer>((resolve, reject) =>
				pbkdf2(`probe-${n}`, "salt", 10_000, 32, "sha256", (error, key) => (error ? reject(error) : resolve(key))),
			);
		const probes = await bound(
			Promise.all([
				...[1, 2, 3, 4, 5].map(() => readFile(keys, "utf8")),
				...[1, 2, 3, 4, 5].map(derived),
				lookup("localhost"),
			]),
		);
		expect(probes).toHaveLength(11);
		for (const signer of others) signer.stop();
		for (const read of await Promise.all(reads)) expect(read).toEqual({ ok: false, code: "other" });
		// the daemon closes while its creation's keychain call still hangs: well before the signer's deadline, and the
		// child that made the call is gone with it
		const daemons = await pending(keys);
		expect(daemons.length).toBeGreaterThan(0);
		const started = Date.now();
		closed = true;
		await daemon.close();
		expect(Date.now() - started).toBeLessThan(DEADLINE / 4);
		for (const call of daemons) await until(() => (processAlive(call.pid) ? undefined : true));
		for (const created of await Promise.all(creations)) expect(created?.status === 201).toBe(false);
	});

	it("through the daemon: a creation left waiting on the keychain is settled by the next start, after the home's format", async () => {
		vi.stubEnv("BANDA_TEST_KEYSTORE", "1");
		const area = await tempHome();
		const home = join(area, "home");
		const web = join(area, "web");
		await mkdir(home);
		await mkdir(web);
		await markTestHome(home);
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		/** The home's format each time the chain was asked something: the wallets' reads wait for the format (C23). */
		const formats: string[] = [];
		const rpc = fauxRpc();
		const start = () =>
			startDaemon({
				home,
				port: 0,
				models: echoModels().models,
				log: () => {},
				box: hostBox(home),
				web,
				fetch: async (url, init) => {
					formats.push((await readFile(join(home, "format"), "utf8")).trim());
					return rpc(url, init);
				},
			});
		const first = await start();
		let open = first;
		stops.push(() => open.close());
		const token = (await readDaemonFile(home))?.token;
		const create = (request: string, name: string) =>
			fetch(`http://127.0.0.1:${open.port}/api/wallets`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ request, name, network: "base-sepolia" }),
			});
		expect((await create("request-restart-1", "Groceries")).status).toBe(201);
		const faults = memoryKeystore().state.faults;
		const locked = "User interaction is not allowed.";
		faults.push(
			{ point: "keychain:write", account: "/wallet/", throw: locked },
			{ point: "keychain:read", account: "/wallet/", throw: locked },
		);
		const made = await create("request-restart-2", "Rent");
		expect(made.status).toBe(503);
		expect(((await made.json()) as { code?: string }).code).toBe("creating");
		await first.close();
		const waiting = await openStore(home, { models: echoModels().models, registry: createRegistry() });
		const before = Object.values((await waiting.snapshot(Wallets, context))?.wallets ?? {}).map((w) => w.state);
		await waiting.close(context);
		expect(before.sort()).toEqual(["creating", "ready"]);
		// the keychain answers by the next start: what the last one left being made is settled before anything waits on it
		faults.splice(0);
		const asked = formats.length;
		open = await start();
		const settled = await until(async () => {
			const view = (await (
				await fetch(`http://127.0.0.1:${open.port}/api/wallets`, { headers: { authorization: `Bearer ${token}` } })
			).json()) as WalletsView;
			return view.wallets.some((wallet) => wallet.state === "creating") ? undefined : view;
		});
		expect(settled.wallets.map((wallet) => wallet.name)).toContain("Groceries");
		await until(async () => (formats.length > asked ? true : undefined));
		expect(new Set(formats)).toEqual(new Set([`${HOME_FORMAT}`]));
	});

	it("through the daemon: banda wallet create reveals with its creation's secret, and a repeat of a creation reveals nothing", async () => {
		vi.stubEnv("BANDA_TEST_KEYSTORE", "1");
		const area = await tempHome();
		const home = join(area, "home");
		const web = join(area, "web");
		await mkdir(home);
		await mkdir(web);
		await writeFile(join(web, "index.html"), "<!doctype html><title>banda</title>");
		const lines: string[] = [];
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: (line) => lines.push(line),
			box: hostBox(home),
			web,
			fetch: fauxRpc(),
		});
		stops.push(() => daemon.close());
		// with no terminal at both ends (a pipe, a file, a script), no wallet is made and no key printed (UC-02, C16)
		const piped: string[] = [];
		await expect(
			walletCommand(home, "create", ["Rent"], { network: "base-sepolia", terminal: false }, (text) => piped.push(text)),
		).rejects.toThrow(/run it in a terminal/);
		expect(piped).toEqual([]);
		expect((await walletCommand(home, "list", [], {}, (text) => piped.push(text))) === 0 && piped).toEqual([]);
		const printed: string[] = [];
		expect(
			await walletCommand(home, "create", ["Rent"], { network: "base-sepolia", terminal: true }, (text) =>
				printed.push(text),
			),
		).toBe(0);
		const key = /\b(0x[0-9a-f]{64})\b/.exec(printed.join("\n"))?.[1];
		expect(key).toBeDefined();
		const address = privateKeyToAddress(key as `0x${string}`);
		expect(printed.join("\n")).toContain(`: ${shortAddress(address)}`);
		const token = (await readDaemonFile(home))?.token;
		/** A POST on a connection of its own, as a second client's would be. */
		const fresh = (path: string, body: unknown) =>
			new Promise<{ status: number; body: unknown }>((resolve, reject) => {
				const text = JSON.stringify(body);
				const asked = httpRequest(
					{
						host: "127.0.0.1",
						port: daemon.port,
						method: "POST",
						path: `/api${path}`,
						agent: false,
						headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					},
					(response) => {
						let read = "";
						response.on("data", (chunk) => {
							read += chunk;
						});
						response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(read) }));
					},
				);
				asked.on("error", reject);
				asked.end(text);
			});
		// a client other than the one that made it, with the owner's token and the creation's request: nothing shown
		const made = await fresh("/wallets", { request: "request-fresh-1", name: "Trips", network: "base-sepolia" });
		expect(made.status).toBe(201);
		const { wallet } = made.body as { wallet: WalletView };
		expect((made.body as WalletMade).reveal).toBeDefined();
		const repeat = await fresh("/wallets", { request: "request-fresh-1", name: "Trips", network: "base-sepolia" });
		expect(repeat.status).toBe(201);
		expect((repeat.body as WalletMade).reveal).toBeUndefined();
		const elsewhere = await fresh(`/wallets/${wallet.address}/reveal`, { request: "request-fresh-1" });
		expect(elsewhere).toMatchObject({ status: 403, body: { code: "spent" } });
		expect(JSON.stringify(elsewhere.body)).not.toMatch(/0x[0-9a-f]{64}/);
		const listed: string[] = [];
		expect(await walletCommand(home, "list", [], {}, (text) => listed.push(text))).toBe(0);
		// neither key is saved yet: the list gives each address in its short form alone (H-005)
		expect(listed.map((each) => each.split("\t")[0])).toEqual([
			shortAddress(address as string),
			shortAddress(wallet.address),
		]);
		expect(listed.join("\n")).not.toContain((address as string).slice(2, 20));
		// skipped, a wallet's whole address still leaves only through Receive: the list leaves it undisclosed, so its
		// removal is not barred by an address the list handed out (C17, H-157)
		expect((await fresh(`/wallets/${wallet.address}/skip`, {})).status).toBe(200);
		const disclosed = async () =>
			(
				(await (
					await fetch(`http://127.0.0.1:${daemon.port}/api/wallets`, { headers: { authorization: `Bearer ${token}` } })
				).json()) as WalletsView
			).wallets.find((one) => one.address === wallet.address)?.disclosed;
		listed.splice(0);
		expect(await walletCommand(home, "list", [], {}, (text) => listed.push(text))).toBe(0);
		expect(listed.join("\n")).toContain(shortAddress(wallet.address));
		expect(listed.join("\n")).not.toContain(wallet.address);
		expect(await disclosed()).toBe(false);
		const received: string[] = [];
		expect(await walletCommand(home, "receive", ["Trips"], {}, (text) => received.push(text))).toBe(0);
		expect(received.join("\n")).toContain(wallet.address);
		expect(await disclosed()).toBe(true);
		// a wallet whose key is not saved yet gives no address to pay into (H-005)
		await expect(walletCommand(home, "receive", ["Rent"], {}, () => {})).rejects.toThrow(/save Rent's key first/);
		// H-063: no wallet lives in the workspace, and a wallet-shaped file an agent writes there grants nothing
		const workspace = join(home, "workspace");
		const files = readdirSync(workspace, { recursive: true, withFileTypes: true }).filter((one) => one.isFile());
		for (const one of files)
			expect(readFileSync(join(one.parentPath, one.name), "utf8").toLowerCase()).not.toContain(
				wallet.address.slice(2).toLowerCase(),
			);
		const planted = { address: STRANGER_WALLET, name: "Planted", network: "base-sepolia", agents: [LEAD] };
		await writeFile(join(workspace, "wallets.json"), JSON.stringify({ wallets: [planted] }));
		await mkdir(join(workspace, "wallets"), { recursive: true });
		await writeFile(join(workspace, "wallets", "planted.json"), JSON.stringify(planted));
		const after = (await (
			await fetch(`http://127.0.0.1:${daemon.port}/api/wallets`, { headers: { authorization: `Bearer ${token}` } })
		).json()) as WalletsView;
		expect(after.wallets.map((one) => one.address).sort()).toEqual([address, wallet.address].sort());
		// a refusal's body carries its fixed word beside its words, for the page to branch on
		const none = { account: "/wallet/", throw: "No keychain is available" };
		memoryKeystore().state.faults.push({ point: "keychain:write", ...none }, { point: "keychain:read", ...none });
		const unmade = await fresh("/wallets", { request: "request-fresh-2", name: "Rent", network: "base-sepolia" });
		expect(unmade).toMatchObject({ status: 503, body: { code: "no_keychain", error: expect.any(String) } });
		memoryKeystore().state.faults.splice(0);
		expect(holdingKey(home, key as string)).toEqual([]);
		expect(lines.join("\n")).not.toContain((key as string).slice(2));
	});
});

const STRANGER_WALLET = "0x00000000000000000000000000000000000000aa";

/**
 * A reveal the signer refuses (key_export.feature "No reveal when the keychain cannot answer or holds another
 * key"; transitions.json's `wallet reveal` rows guarded `not kc_up or item != 'ours'`), on either path the signer
 * runs.
 */
describe.each(SIGNERS)("a reveal the signer refuses, $where", ({ keystore, deadline }) => {
	/** A refused reveal: 503 in fixed words, nothing on the connection, which stays the daemon's, and nothing spent. */
	const refused = async (
		w: Awaited<ReturnType<typeof world>>,
		ends: Awaited<ReturnType<typeof connection>>,
		address: string,
		request: string,
		code: SignerCode,
	) => {
		const shown = await w.reveal(address, request, ends);
		// the signer's code goes with its words, for the client to branch on
		expect(shown.refused).toEqual({ status: 503, body: { error: WORDS[code], code } });
		await new Promise((resolve) => setImmediate(resolve));
		expect(ends.received()).toBe("");
		expect(ends.daemon.destroyed).toBe(false);
		expect((await w.record(address))?.reveal?.expires).toBeGreaterThan(Date.now());
		expect(await asked(w)).toEqual([]);
	};
	/** A reveal that shows the key, on the same connection a refused one came on. */
	const shows = async (
		w: Awaited<ReturnType<typeof world>>,
		ends: Awaited<ReturnType<typeof connection>>,
		address: string,
		request: string,
	) => {
		const shown = await w.reveal(address, request, ends);
		const { key } = (shown.response as { body: WalletRevealed }).body;
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(address);
		expect(await asked(w)).toHaveLength(1);
		expect((await w.record(address))?.reveal).toBeUndefined();
		// the spent reveal is listed in the wallet's own activity (UC-02 A2, H-266)
		expect((await w.record(address))?.reveals).toEqual([{ at: expect.any(Number), kind: "creation" }]);
		return key;
	};

	it("answers other for a signer that fails otherwise, and reveals on a retry", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		await editKeys(w.keystore, (state) => {
			state.faults.push({ point: "keychain:read", account: "/wallet/", throw: "a fault nobody named", times: 1 });
		});
		await refused(w, ends, wallet.address, request, "other");
		await shows(w, ends, wallet.address, request);
	});

	it("spends nothing for a connection gone before the key could go onto it", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		const reply = await w.call("POST", `/wallets/${wallet.address}/reveal`, { request, secret: w.secret(request) });
		if (reply === undefined || !("hand" in reply)) throw new Error("the reveal took no connection");
		ends.daemon.destroy();
		const after = await reply.hand(ends.daemon);
		expect(after).toEqual({ status: 503, body: { error: WORDS.other, code: "other" } });
		expect((await w.record(wallet.address))?.reveal?.expires).toBeGreaterThan(Date.now());
		expect(await asked(w)).toEqual([]);
	});

	/** The spend's commit lands, then `after` runs before the signer goes on to the hand-over. */
	const afterSpend = (w: Awaited<ReturnType<typeof world>>, address: string, after: () => Promise<void> | void) => {
		const harness = w.s.harness;
		const commit = harness.commit.bind(harness);
		harness.commit = (async (...args: Parameters<typeof commit>) => {
			const before = (await harness.snapshot(Wallets, context))?.wallets[address]?.reveal;
			const result = await commit(...args);
			const now = (await harness.snapshot(Wallets, context))?.wallets[address]?.reveal;
			if (before !== undefined && now === undefined) await after();
			return result;
		}) as typeof commit;
	};

	/**
	 * A reveal spent and then never given to the child: the key provably never left, so the spend is taken back, 503 in
	 * the signer's words, no key on the connection and no showing listed; the same request with its secret, on a new
	 * connection, shows the key once.
	 */
	const takenBack = async (
		w: Awaited<ReturnType<typeof world>>,
		ends: Awaited<ReturnType<typeof connection>>,
		address: string,
		request: string,
		code: SignerCode,
	) => {
		const before = await w.record(address);
		const shown = await w.reveal(address, request, ends);
		expect(shown.refused).toEqual({ status: 503, body: { error: WORDS[code], code } });
		await new Promise((resolve) => setImmediate(resolve));
		expect(ends.received()).not.toMatch(/0x[0-9a-f]{64}/i);
		const after = await w.record(address);
		expect(after?.reveal).toEqual(before?.reveal);
		expect(after?.reveals).toBeUndefined();
		expect(await saw(w)).toEqual([]);
		const retried = await w.reveal(address, request, await connection());
		const { key } = (retried.response as { body: WalletRevealed }).body;
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(address);
		// each ask is listed, the showing once
		expect(await asked(w)).toHaveLength(2);
		expect((await w.record(address))?.reveals).toEqual([{ at: expect.any(Number), kind: "creation" }]);
		await refusedWith(w.reveal(address, request, await connection()), 403);
	};

	it("takes the spend back when the connection goes after the spend, before the hand-over", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		let once = true;
		afterSpend(w, wallet.address, () => {
			if (once) ends.daemon.destroy();
			once = false;
		});
		await takenBack(w, ends, wallet.address, request, "other");
	});

	it("tells the owner to try again only once the take-back is past a barrier: a power cut then keeps the reveal (C21)", async () => {
		let barrier: ReturnType<typeof barriered> | undefined;
		/** Fails the barrier of a commit that put the reveal back, and that one only: the spend's own barrier passes. */
		let failing: string | undefined;
		const w = await world(await keystore(), {
			deadline,
			sync: async () => {
				const reveal = (await w.s.harness.snapshot(Wallets, context))?.wallets[failing ?? ""]?.reveal;
				if (failing !== undefined && reveal !== undefined) throw new Error("the disk refused");
				await barrier?.sync();
			},
		});
		barrier = barriered(w.s.home, w.s.harness);
		const { request, wallet } = await w.create();
		const before = await w.record(wallet.address);
		const onDisk = () =>
			(barrier as ReturnType<typeof barriered>).cut()(
				async (store) => (await store.snapshot(Wallets, context))?.wallets[wallet.address]?.reveal,
			);
		let gone: Awaited<ReturnType<typeof connection>> | undefined;
		afterSpend(w, wallet.address, () => {
			gone?.daemon.destroy();
			gone = undefined;
		});
		const goes = async () => {
			const ends = await connection();
			gone = ends;
			return (await w.reveal(wallet.address, request, ends)).refused;
		};
		// the power goes right after the answer: the reveal the owner is told to try again with is on disk
		expect(await goes()).toEqual({ status: 503, body: { error: WORDS.other, code: "other" } });
		expect(await onDisk()).toEqual(before?.reveal);
		// a take-back whose barrier fails is answered as not yet safe, never as a plain try again
		failing = wallet.address;
		expect(await goes()).toEqual({ status: 503, body: { error: UNSYNCED, code: "unsynced" } });
		failing = undefined;
		expect((await w.record(wallet.address))?.reveal).toEqual(before?.reveal);
		const retried = await w.reveal(wallet.address, request, await connection());
		const { key } = (retried.response as { body: WalletRevealed }).body;
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(wallet.address);
	});

	it("takes the spend back when the signer's deadline passes after the spend, before the hand-over", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		// the spend's commit returns only once the signer's call has ended, its deadline passed
		const reveal = Signer.prototype.reveal;
		let ended = false;
		let first = true;
		const spy = vi.spyOn(Signer.prototype, "reveal").mockImplementation(function (this: Signer, ...args) {
			const outcome = reveal.apply(this, args);
			void outcome.finally(() => {
				ended = true;
			});
			return outcome;
		});
		afterSpend(w, wallet.address, async () => {
			if (!first) return;
			first = false;
			await until(async () => (ended ? true : undefined));
			spy.mockRestore();
		});
		await takenBack(w, ends, wallet.address, request, "timeout");
		// the connection is still the daemon's: the key never went onto it
		expect(ends.daemon.destroyed).toBe(false);
	});

	it("shows no key when the spend cannot be made safe on disk, takes it back, and shows the key on a retry (C21)", async () => {
		let failing = false;
		const w = await world(await keystore(), {
			deadline,
			sync: async () => {
				if (failing) throw new Error("the disk refused");
			},
		});
		const ends = await connection();
		const { request, wallet } = await w.create();
		const before = await w.record(wallet.address);
		failing = true;
		const shown = await w.reveal(wallet.address, request, ends);
		// not yet safe, to be tried again: never told as spent
		expect(shown.refused).toEqual({ status: 503, body: { error: UNSYNCED, code: "unsynced" } });
		await new Promise((resolve) => setImmediate(resolve));
		expect(ends.received()).not.toMatch(/0x[0-9a-f]{64}/i);
		expect(ends.daemon.destroyed).toBe(false);
		// the reveal is back as it was, bound to the same request and secret, and no showing is listed
		const after = await w.record(wallet.address);
		expect(after?.reveal).toEqual(before?.reveal);
		expect(after?.reveals).toBeUndefined();
		expect(await saw(w)).toEqual([]);
		// once a sync works, the same request with its secret shows the key, exactly once
		failing = false;
		const again = await connection();
		const retried = await w.reveal(wallet.address, request, again);
		const { key } = (retried.response as { body: WalletRevealed }).body;
		expect(privateKeyToAddress(key as `0x${string}`)).toBe(wallet.address);
		expect((await w.record(wallet.address))?.reveals).toEqual([{ at: expect.any(Number), kind: "creation" }]);
		await refusedWith(w.reveal(wallet.address, request, await connection()), 403);
	});

	it("answers missing for a key gone from the keychain, and reveals once it is back", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		let kept: [string, string] = ["", ""];
		await editKeys(w.keystore, (state) => {
			const account = itemOf(state, "/wallet/");
			kept = [account, state.items[account] as string];
			delete state.items[account];
		});
		await refused(w, ends, wallet.address, request, "missing");
		await editKeys(w.keystore, (state) => {
			state.items[kept[0]] = kept[1];
		});
		await shows(w, ends, wallet.address, request);
	});

	it("answers wrong_key for an item holding another key, and reveals once the wallet's is back", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		let kept = "";
		await editKeys(w.keystore, (state) => {
			const account = itemOf(state, "/wallet/");
			kept = state.items[account] as string;
			state.items[account] = `0x${"11".repeat(32)}`;
		});
		await refused(w, ends, wallet.address, request, "wrong_key");
		await editKeys(w.keystore, (state) => {
			state.items[itemOf(state, "/wallet/")] = kept;
		});
		await shows(w, ends, wallet.address, request);
	});

	it("answers locked for a keychain that refuses, and timeout for one that does not answer", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		const fault = (one: KeystoreFault) =>
			editKeys(w.keystore, (state) => {
				state.faults.push(one);
			});
		await fault({ point: "keychain:read", account: "/wallet/", throw: "User interaction is not allowed.", times: 1 });
		await refused(w, ends, wallet.address, request, "locked");
		await fault({ point: "keychain:read", account: "/wallet/", hang: true, times: 1 });
		await refused(w, ends, wallet.address, request, "timeout");
		await shows(w, ends, wallet.address, request);
	});

	it("answers other_home for a lease another home holds, and reveals once it is this home's again", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		const at = await w.lease();
		let kept = "";
		await editKeys(w.keystore, (state) => {
			kept = state.items[itemOf(state, "/lease")] as string;
		});
		await moveLeaseItem(w.keystore, "e".repeat(64));
		await refused(w, ends, wallet.address, request, "other_home");
		// the saved copy's check is refused the same way, and the store keeps its epoch
		const checked = await w.json("POST", `/wallets/${wallet.address}/saved`, { digest: "0".repeat(64) }).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
		expect(checked).toBeInstanceOf(BadRequest);
		expect((checked as BadRequest).status).toBe(503);
		expect((checked as BadRequest).message).toBe(WORDS.other_home);
		expect((checked as BadRequest).code).toBe("other_home");
		expect(await w.lease()).toBe(at);
		await editKeys(w.keystore, (state) => {
			state.items[itemOf(state, "/lease")] = kept;
		});
		await shows(w, ends, wallet.address, request);
	});

	it("catches the store up to a lease the keychain moved on for this home, for a reveal and a saved copy", async () => {
		const w = await world(await keystore(), { deadline });
		const ends = await connection();
		const { request, wallet } = await w.create();
		const at = (await w.lease()) as number;
		// a claim or a move killed after the keychain took the next epoch and before the store did (C15, H-289)
		await moveLeaseItem(w.keystore);
		const key = await shows(w, ends, wallet.address, request);
		expect(await w.lease()).toBe(at + 1);
		await moveLeaseItem(w.keystore);
		const saved = (await w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(key) })) as WalletsView;
		expect(saved.wallets[0]?.backup).toBe("saved");
		expect(await w.lease()).toBe(at + 2);
	});
});

describe("a reveal before the creation finished, and Receive at an address with code", () => {
	it("refuses a reveal while the record is creating, and reveals once it is ready", async () => {
		const w = await world();
		memoryKeystore().state.faults.push({ point: "keychain:write", account: "/wallet/", delay: 1_000, times: 1 });
		const ends = await connection();
		const making = w.create();
		const creating = await until(async () => {
			const all = (await w.s.harness.snapshot(Wallets, context))?.wallets ?? {};
			return Object.entries(all).find(([, record]) => record.state === "creating");
		});
		const [address, record] = creating;
		await refusedWith(w.reveal(address, record.request, ends), 403);
		expect(ends.received()).toBe("");
		const { request, wallet } = await making;
		expect(wallet.address).toBe(address);
		expect(request).toBe(record.request);
		const shown = await w.reveal(address, request, ends);
		expect(shown.response?.status).toBe(200);
	});

	it("gives out no address for a wallet a removal took while Receive read its code (C17)", async () => {
		const rpc = fauxRpc();
		let holding = false;
		let held: () => void = () => {};
		let release: () => void = () => {};
		const reached = new Promise<void>((resolve) => {
			held = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = await world("1", {
			fetch: async (url, init) => {
				if (holding && String(init?.body).includes("eth_getCode")) {
					holding = false;
					held();
					await gate;
				}
				return rpc(url, init);
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		// Receive's snapshot reads ready and skipped; its code read is held while a removal takes the record
		holding = true;
		const receiving = w.json("POST", `/wallets/${wallet.address}/receive`).then(
			(answer) => ({ answer }),
			(error: unknown) => ({ error }),
		);
		await reached;
		await w.s.harness.commit(async (tx) => {
			const record = (await tx.doc(Wallets)).wallets[wallet.address];
			if (record !== undefined) record.state = "removing";
		}, context);
		release();
		const out = await receiving;
		expect(out).not.toHaveProperty("answer");
		expect((out as { error: unknown }).error).toBeInstanceOf(BadRequest);
		expect(((out as { error: unknown }).error as BadRequest).status).toBe(409);
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
	});

	it("gives out no address for a wallet whose key is gone and was never saved, and says so (H-021, H-261)", async () => {
		const w = await world();
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const items = memoryKeystore().state.items;
		for (const account of Object.keys(items)) if (account.includes("/wallet/")) delete items[account];
		const lost = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
		expect(lost.wallets[0]?.signing?.state).toBe("key_missing");
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "unopenable" });
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
	});

	it("checks every ready wallet's key at start even when the recovery of another failed, so Receive refuses a lost one", async () => {
		let failing = false;
		const w = await world("1", {
			sync: async () => {
				if (failing) throw new Error("the disk refused");
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const items = memoryKeystore().state.items;
		for (const account of Object.keys(items)) if (account.includes("/wallet/")) delete items[account];
		// a second wallet a stop left creating, whose key the keychain never kept: settling it drops it, a sync then fails
		const left = privateKeyToAddress(`0x${"7".repeat(64)}`);
		await w.s.harness.commit(async (tx) => {
			const wallets = (await tx.doc(Wallets)).wallets;
			const record = wallets[wallet.address];
			if (record === undefined) throw new Error("no wallet");
			const { reveal: _reveal, reveals: _reveals, ...rest } = JSON.parse(JSON.stringify(record)) as typeof record;
			wallets[left] = { ...rest, name: "Left", state: "creating", request: `left-${process.pid}` };
		}, context);
		failing = true;
		await w.restart();
		// the recovery's sync failed; nothing is shown while no barrier passed since the start (C21), so the disk answers
		// again before the view is read
		await until(async () => w.logs.join("\n").includes("wallets:") || undefined);
		failing = false;
		const started = await until(async () => {
			const view = await w.view();
			const found = view.wallets.find((each) => each.address === wallet.address);
			return found?.signing === undefined ? undefined : found;
		});
		expect(started.signing?.state).toBe("key_missing");
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "unopenable" });
	});

	it("gives out no address for an archived wallet whose key went while banda was stopped, once unarchived (H-021, H-261)", async () => {
		const w = await world();
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const skipped = await w.record(wallet.address);
		await w.json("POST", `/wallets/${wallet.address}/archive`, { version: skipped?.version });
		const items = memoryKeystore().state.items;
		for (const account of Object.keys(items)) if (account.includes("/wallet/")) delete items[account];
		await w.restart();
		// the start-up check reads the archived wallet's key too
		const started = await until(async () => {
			const found = (await w.view()).wallets.find((each) => each.address === wallet.address);
			return found?.signing === undefined ? undefined : found;
		});
		expect(started.signing?.state).toBe("key_missing");
		const archived = await w.record(wallet.address);
		const back = (await w.json("POST", `/wallets/${wallet.address}/unarchive`, {
			version: archived?.version,
		})) as WalletsView;
		expect(back.wallets[0]).toMatchObject({ state: "ready", backup: "skipped", signing: { state: "key_missing" } });
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "unopenable" });
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
	});

	it("checks the key again at unarchive, so Receive knows a key that went while it was archived", async () => {
		const w = await world();
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const skipped = await w.record(wallet.address);
		await w.json("POST", `/wallets/${wallet.address}/archive`, { version: skipped?.version });
		// the keychain answers nothing from now on: the start-up check leaves the archived wallet unchecked
		const faults = memoryKeystore().state.faults;
		faults.push({ point: "keychain:read", account: "/wallet/", throw: "boom" });
		await w.restart();
		const items = memoryKeystore().state.items;
		for (const account of Object.keys(items)) if (account.includes("/wallet/")) delete items[account];
		faults.splice(0);
		const archived = await w.record(wallet.address);
		const back = (await w.json("POST", `/wallets/${wallet.address}/unarchive`, {
			version: archived?.version,
		})) as WalletsView;
		// unarchived, its key is checked before the answer, so Receive knows it is gone
		expect(back.wallets[0]?.signing?.state).toBe("key_missing");
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "unopenable" });
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
	});

	it("answers code for an address that runs code, and discloses nothing", async () => {
		const w = await world("1", { code: "0x6080604052" });
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "code", acknowledged: false });
		expect((await w.view()).wallets[0]?.disclosed).toBe(false);
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
	});

	it("shows no address where whether code runs there could not be read, and does once it could (H-157)", async () => {
		let down = true;
		const rpc = fauxRpc();
		const w = await world("1", {
			fetch: async (url, init) => {
				if (down) throw new TypeError("fetch failed");
				return rpc(url, init);
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "unchecked" });
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
		down = false;
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toMatchObject({ state: "ready" });
		expect((await w.record(wallet.address))?.disclosed).toBe(true);
	});

	it("reads nothing through an RPC of another chain: no address, no code acknowledged, no removal, and says why (H-187)", async () => {
		// Base mainnet's chain id where the wallet's network is Base Sepolia: a mainnet URL set for a testnet wallet
		const w = await world("1", { fetch: fauxRpc("0x", `0x${(8453).toString(16)}`) });
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "unchecked" });
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/acknowledge-code`), 503);
		// the funds check reads no zero from another chain: the removal is refused, the wallet kept (C17)
		const removing = await refusedWith(
			w.json("POST", `/wallets/${wallet.address}/remove`, { version: (await w.record(wallet.address))?.version }),
			503,
		);
		expect(removing.message).toMatch(/could not be read/);
		expect((await w.record(wallet.address))?.state).toBe("ready");
		// the network says so once a read of it found it, for every wallet on it to show offline (H-317)
		const network = await until(async () => {
			const found = (await w.view()).networks.find((each) => each.id === "base-sepolia");
			return found?.otherChain === true ? found : undefined;
		});
		// it answers, for another chain: said as that alone, never as a network not answering
		expect(network.unread).toBeUndefined();
		// the wallet's activity says the same, by the same word: not unread, served another chain
		const incoming = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
		expect(incoming.incomplete).toBe("chain");
		expect(incoming.since).toBeUndefined();
	});

	it("acknowledges the code at an address on this computer alone, kept by its hash, and Receive keeps its warning", async () => {
		let code = "0x6080604052";
		const answers: Record<string, string> = {
			eth_getCode: code,
			eth_blockNumber: "0x2a",
			eth_chainId: BASE_SEPOLIA_ID,
		};
		const w = await world("1", {
			fetch: async (_url, init) => {
				const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
				const result = answers[method];
				return Response.json(
					result === undefined
						? { jsonrpc: "2.0", id, error: { code: -32601, message: "not offered here" } }
						: { jsonrpc: "2.0", id, result },
				);
			},
		});
		const { request, wallet } = await w.create();
		const shown = await w.reveal(wallet.address, request, await connection());
		const { key } = (shown.response as { body: WalletRevealed }).body;
		const path = `/wallets/${wallet.address}/acknowledge-code`;
		const hashOf = (text: string) =>
			createHash("keccak-256")
				.update(Buffer.from(text.slice(2), "hex"))
				.digest("hex");
		// each acknowledge_code row of transitions.json, in each ready state: `has_code and cap_host` records the code's
		// hash, `not (has_code and cap_host)` refuses and records nothing
		const steps: [string, () => Promise<unknown>][] = [
			["unsaved", async () => {}],
			["skipped", () => w.json("POST", `/wallets/${wallet.address}/skip`)],
			["saved", () => w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(key) })],
		];
		for (const [backup, reach] of steps) {
			await reach();
			code = `0x6080604052${backup === "unsaved" ? "00" : backup === "skipped" ? "01" : "02"}`;
			const before = (await w.record(wallet.address))?.code;
			expect((await w.record(wallet.address))?.backup).toBe(backup);
			// not on the host: refused
			answers.eth_getCode = code;
			await refusedWith(w.json("POST", path, {}, { device: "phone" } as Partial<AreaRequest>), 403);
			// no code at the address: refused
			answers.eth_getCode = "0x";
			await refusedWith(w.json("POST", path), 409);
			expect((await w.record(wallet.address))?.code).toEqual(before);
			// code, on the host: kept by its hash
			answers.eth_getCode = code;
			const after = (await w.json("POST", path)) as WalletsView;
			expect(after.wallets[0]?.code, backup).toBe(true);
			expect((await w.record(wallet.address))?.code).toEqual({
				hash: hashOf(code),
				block: 42,
				acknowledged: expect.any(Number),
			});
			expect((await w.record(wallet.address))?.backup).toBe(backup);
		}
		// Receive keeps its warning, and gives no address while code runs there
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toEqual({ state: "code", acknowledged: true });
		expect((await w.record(wallet.address))?.disclosed).toBe(false);
	});

	it("lists the keys the keychain holds that no wallet names, and deletes none (H-045)", async () => {
		const w = await world();
		const { wallet } = await w.create();
		expect(await w.json("GET", "/wallets/orphans")).toEqual({ orphans: [] });
		await w.s.harness.commit(async (tx) => {
			delete (await tx.doc(Wallets)).wallets[wallet.address];
		}, context);
		expect(await w.json("GET", "/wallets/orphans")).toEqual({ orphans: [wallet.address] });
		expect(await w.json("GET", "/wallets/orphans")).toEqual({ orphans: [wallet.address] });
		expect(await w.call("POST", "/wallets/orphans")).toMatchObject({ status: 405 });
	});

	it("has the address marked disclosed in the database itself before Receive shows it, the log not needed (C21)", async () => {
		const w = await world();
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toMatchObject({ state: "ready" });
		// a power cut loses what the write-ahead log held and the database did not
		const disclosed = await powerCut(w.home)(
			async (store) => (await store.snapshot(Wallets, context))?.wallets[wallet.address]?.disclosed,
		);
		expect(disclosed).toBe(true);
	});

	it("shows an RPC that carries a credential in its userinfo as masked, never as one without any (H-195)", async () => {
		vi.stubEnv("BANDA_TEST_CHAIN", "1");
		const w = await world();
		const saved = (await w.json("PUT", "/wallets/rpc/anvil-usdc", { url: "http://user:pass@localhost:1/" })) as {
			rpc?: string;
		};
		expect(saved.rpc).toBe("http://•••@localhost:1");
		expect((await w.view()).networks.find((each) => each.id === "anvil-usdc")?.rpc).toBe("http://•••@localhost:1");
		expect(w.logs.join("\n")).toContain("RPC is now http://•••@localhost:1");
		for (const said of [JSON.stringify(await w.view()), w.logs.join("\n")]) expect(said).not.toContain("pass");
	});

	it("answers 404 for a path whose escapes are malformed", async () => {
		const w = await world();
		const { wallet } = await w.create();
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/agents/%E0`, { on: true }), 404);
		await refusedWith(w.json("PUT", "/wallets/rpc/%E0%A4", { url: null }), 404);
		await refusedWith(w.json("POST", "/wallets/%E0/skip"), 404);
	});
});

/** Whether `pid` has exited: gone, or a zombie its parent has not reaped yet. */
function exited(pid: number): boolean {
	try {
		return execFileSync("ps", ["-o", "stat=", "-p", String(pid)])
			.toString()
			.trim()
			.startsWith("Z");
	} catch {
		return true;
	}
}

describe("the signer's hand-over of a reveal's connection", () => {
	it("keeps the connection, and tells nothing handed, when the child dies between proven and the hand-over", async () => {
		const dir = await tempHome();
		const script = join(dir, "proves-then-waits.mjs");
		const pidFile = join(dir, "pid");
		await writeFile(
			script,
			[
				'import { writeFileSync } from "node:fs";',
				'import { createInterface } from "node:readline";',
				"createInterface({ input: process.stdin }).once('line', (line) => {",
				"  const { id } = JSON.parse(line);",
				`  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
				"  process.stdout.write(JSON.stringify({ id, step: 'proven' }) + '\\n');",
				"  setInterval(() => {}, 1000);",
				"});",
			].join("\n"),
		);
		const env = { ...process.env, BANDA_TEST_KEYSTORE: join(dir, "keychain.json") };
		await installationId(dir);
		const signer = new Signer(await signerHome(dir), { env, script, deadline: 10_000 });
		stops.push(async () => signer.stop());
		const ends = await connection();
		let handed = 0;
		let proven = 0;
		const outcome = await signer.reveal(
			1,
			"0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
			ends.daemon,
			// the child is killed and has exited before the hand-over, with no turn of this process's event loop between,
			// so its exit is not yet heard: the send itself is what fails
			async () => {
				proven += 1;
				const pid = Number(readFileSync(pidFile, "utf8"));
				process.kill(pid, "SIGKILL");
				while (!exited(pid)) {}
			},
			() => {
				handed += 1;
			},
		);
		expect(outcome).toEqual({ ok: false, code: "other" });
		expect(proven).toBe(1);
		expect(handed).toBe(0);
		// the connection is this process's still: the caller answers on it
		expect(ends.daemon.destroyed).toBe(false);
		ends.daemon.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
		expect(await ends.read()).toContain("503");
	});
});

describe("the creation's one reveal, when the call that drew the key could not carry it (UC-01 E1, E4, H-005, C16)", () => {
	const ask = (w: Awaited<ReturnType<typeof world>>, request: string, more: Partial<AreaRequest> = {}) =>
		w.json("POST", "/wallets", { request, name: "Groceries", network: "base-sepolia" }, more);
	/** The key the reveal wrote onto its connection, with the secret given. */
	const keyOf = async (w: Awaited<ReturnType<typeof world>>, address: string, request: string, secret: string) => {
		const shown = await w.reveal(address, request, await connection(), secret);
		expect(shown.response?.status).toBe(200);
		return (shown.response as { body: WalletRevealed }).body.key;
	};

	it("carries the secret in the same request's answer once the keychain that was silent at the read-back answers", async () => {
		const w = await world();
		const request = `late-${process.pid}-1`;
		const faults = memoryKeystore().state.faults;
		// the key is written, and the keychain does not answer its read-back: the creation waits (E1)
		faults.push(
			{ point: "keychain:read", account: "/wallet/", answer: null, times: 1 },
			{ point: "keychain:read", account: "/wallet/", throw: "User interaction is not allowed." },
		);
		expect((await refusedWith(ask(w, request), 503)).code).toBe("creating");
		faults.splice(0);
		const made = (await ask(w, request)) as WalletMade;
		expect(made.wallet).toMatchObject({ state: "ready", backup: "unsaved" });
		const secret = made.reveal?.secret as string;
		expect(secret).toEqual(expect.any(String));
		expect(privateKeyToAddress((await keyOf(w, made.wallet.address, request, secret)) as `0x${string}`)).toBe(
			made.wallet.address,
		);
		// one answer carried it: a repeat after it carries none
		expect(((await ask(w, request)) as WalletMade).reveal).toBeUndefined();
	});

	it("carries it in the same request's answer after a restart that settled the creation (E4, H-005)", async () => {
		const w = await world();
		const request = `restart-${process.pid}-1`;
		const faults = memoryKeystore().state.faults;
		faults.push(
			{ point: "keychain:read", account: "/wallet/", answer: null, times: 1 },
			{ point: "keychain:read", account: "/wallet/", throw: "User interaction is not allowed." },
		);
		expect((await refusedWith(ask(w, request), 503)).code).toBe("creating");
		faults.splice(0);
		// the daemon restarts: its start settles the creation ready, and nothing of the first is kept in memory
		await w.restart();
		const settled = await until(async () => {
			const [record] = Object.values((await w.s.harness.snapshot(Wallets, context))?.wallets ?? {});
			return record?.state === "ready" ? record : undefined;
		});
		expect(settled.reveal).toEqual({ expires: expect.any(Number) });
		const made = (await ask(w, request)) as WalletMade;
		const secret = made.reveal?.secret as string;
		expect(privateKeyToAddress((await keyOf(w, made.wallet.address, request, secret)) as `0x${string}`)).toBe(
			made.wallet.address,
		);
	});

	/** A world whose `fail(n)` fails the n-th sync from now: the creating commit's is the first, the ready one's the second. */
	const failing = async () => {
		let calls = 0;
		let at = 0;
		const w = await world("1", {
			sync: async () => {
				calls++;
				if (calls === at) throw new Error("the disk refused");
			},
		});
		// the area's own barrier at start is past before a test counts the barriers it fails
		await w.view();
		return Object.assign(w, {
			fail: (n: number) => {
				at = calls + n;
			},
		});
	};

	it("carries it after a restart that came between a ready commit not on disk and its answer (C21)", async () => {
		const w = await failing();
		const request = `unsynced-${process.pid}-1`;
		w.fail(2);
		expect((await refusedWith(ask(w, request), 503)).code).toBe("unsynced");
		await w.restart();
		const made = (await ask(w, request)) as WalletMade;
		const secret = made.reveal?.secret as string;
		expect(privateKeyToAddress((await keyOf(w, made.wallet.address, request, secret)) as `0x${string}`)).toBe(
			made.wallet.address,
		);
		expect(((await ask(w, request)) as WalletMade).reveal).toBeUndefined();
	});

	it("answers a creation whose creating commit is not on disk as not yet safe, the keychain never written (C21)", async () => {
		const w = await failing();
		const request = `unsynced-${process.pid}-creating`;
		const before = Object.keys(memoryKeystore().state.items).filter((item) => item.includes("/wallet/"));
		w.fail(1);
		const refused = await refusedWith(ask(w, request), 503);
		expect(refused.code).toBe("unsynced");
		expect(refused.message).not.toMatch(/keychain/);
		// the signer stopped before it wrote: no item, and the settle dropped the record
		expect(Object.keys(memoryKeystore().state.items).filter((item) => item.includes("/wallet/"))).toEqual(before);
		expect((await w.view()).wallets).toEqual([]);
		// the same request again makes the wallet
		const made = (await ask(w, request)) as WalletMade;
		expect(made.wallet).toMatchObject({ state: "ready", backup: "unsaved" });
	});

	it("mints a paired device's creation no reveal, its ready commit not on disk, so the computer's repeat carries none (H-264)", async () => {
		const w = await failing();
		const request = `phone-${process.pid}-1`;
		w.fail(2);
		expect((await refusedWith(ask(w, request, { device: "phone-endpoint" }), 503)).code).toBe("unsynced");
		const replayed = (await ask(w, request)) as WalletMade;
		expect(replayed.wallet).toMatchObject({ state: "ready", backup: "unsaved" });
		expect(replayed.reveal).toBeUndefined();
		expect((await w.record(replayed.wallet.address))?.reveal).toBeUndefined();
		await refusedWith(w.reveal(replayed.wallet.address, request, await connection(), ""), 403);
	});
});

describe("a home whose signing another home holds (C16, UC-21 A1)", () => {
	it("refuses a creation as other_home, makes nothing, and makes it once signing moved here, with no wallet to prove", async () => {
		const w = await world();
		// the home's id as the area made it at its start
		expect((await w.view()).wallets).toEqual([]);
		const at = await signerHome(w.home);
		// a backup restored from before the first wallet: the original home took the lease meanwhile
		memoryKeystore().state.items[leaseAccount(at.id)] = JSON.stringify({ epoch: 1, holder: "0".repeat(64) });
		const refused = await refusedWith(
			w.json("POST", "/wallets", { request: `copy-${process.pid}-1`, name: "Groceries", network: "base-sepolia" }),
			503,
		);
		expect(refused.code).toBe("other_home");
		expect((await w.view()).wallets).toEqual([]);
		// the desktop app's move, as its host signer makes it: nothing to prove, then the keychain checked again
		expect(await moveLease(memoryKeystore(), at, 1)).toBe(2);
		await w.json("POST", "/wallets/keychain");
		const { wallet } = await w.create();
		expect(wallet).toMatchObject({ state: "ready" });
		expect(await w.lease()).toBe(2);
	});
});

describe("a keychain that lost every banda item (H-021, H-286)", () => {
	it("reads each wallet's key as missing, never another home's, and the owner's Restore takes the lease back", async () => {
		const keychain = join(await tempHome(), "keychain.json");
		const w = await world(keychain);
		const { request, wallet } = await w.create();
		const shown = await w.reveal(wallet.address, request, await connection());
		const { key } = (shown.response as { body: WalletRevealed }).body;
		const epoch = (await w.lease()) as number;
		// a keychain reset: the lease, the home secret and the key all gone
		await editKeys(keychain, (state) => {
			state.items = {};
		});
		const checked = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
		expect(checked.wallets[0]?.signing).toEqual({ state: "key_missing", code: "missing" });
		expect(checked.lease).toBe(epoch);
		// and after a restart, as the daemon finds it at its start
		await w.restart();
		const started = await until(async () => {
			const view = await w.view();
			return view.wallets[0]?.signing === undefined ? undefined : view;
		});
		expect(started.wallets[0]?.signing).toEqual({ state: "key_missing", code: "missing" });
		// the desktop app's Restore, past the store's epoch, with the key the owner saved
		const { HostSigner } = await import("../src/wallet/signer-host.ts");
		const host = new HostSigner(await signerHome(w.home));
		try {
			expect(await host.restore(epoch, wallet.address as Address, key as `0x${string}`)).toMatchObject({ ok: true });
		} finally {
			host.stop();
		}
		const back = (await w.json("POST", `/wallets/${wallet.address}/check`)) as WalletsView;
		expect(back.wallets[0]?.signing).toEqual({ state: "online" });
		expect(await w.lease()).toBe(epoch + 1);
	});
});

describe("a home whose installation id is not the one its wallets were made under (H-261)", () => {
	const refused = (w: Awaited<ReturnType<typeof world>>) =>
		expect(
			w.json("POST", "/wallets", { request: `after-${process.pid}`, name: "Rent", network: "base-sepolia" }),
		).rejects.toMatchObject({ status: 503, code: "identity" });

	it("makes no new id when the id went, and runs the wallets on none, the keys still under the old one", async () => {
		const w = await world();
		const { wallet } = await w.create();
		const old = (await signerHome(w.home)).id;
		const before = JSON.stringify(memoryKeystore().state.items);
		const credentials = JSON.stringify(await credentialsOf(w.home, WALLET, accountKey(wallet.address)));
		await rm(join(w.home, "auth", "device-id"));
		await w.restart();
		expect((await w.view()).offline).toBe("identity");
		await refused(w);
		expect(w.logs.join("\n")).toContain("this home's id is not the one");
		// nothing was made or rewritten: no id, the same items under the old prefix, the same credentials
		await expect(readFile(join(w.home, "auth", "device-id"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.stringify(memoryKeystore().state.items)).toBe(before);
		expect(Object.keys(memoryKeystore().state.items).every((account) => account.startsWith(`${old}/`))).toBe(true);
		expect(JSON.stringify(await credentialsOf(w.home, WALLET, accountKey(wallet.address)))).toBe(credentials);
	});

	it("makes no new id from a provider sign-in or the desktop's signer, and a restart without the credentials still refuses", async () => {
		const w = await world();
		const { wallet } = await w.create();
		const before = JSON.stringify(memoryKeystore().state.items);
		await rm(join(w.home, "auth", "device-id"));
		// a sign-in to a provider sends the id: in a home whose store holds wallets a missing one is refused, not made
		const signIn = await refusedWith(providerInstallation({ home: w.home, harness: w.s.harness }), 503);
		expect(signIn.code).toBe("identity");
		// the desktop app's signer, for a later reveal or a move of signing, reads the id and makes none
		await expect(signerHome(w.home)).rejects.toBeInstanceOf(IdentityMissing);
		expect(existsSync(join(w.home, "auth", "device-id"))).toBe(false);
		// the credentials gone too (auth/ cleared but for the token): still no id, so still refused after a restart
		await rm(join(w.home, "auth", "connections"), { recursive: true, force: true });
		await w.restart();
		expect((await w.view()).offline).toBe("identity");
		await refused(w);
		expect(existsSync(join(w.home, "auth", "device-id"))).toBe(false);
		expect(JSON.stringify(memoryKeystore().state.items)).toBe(before);
		await w.restart();
		expect((await w.view()).offline).toBe("identity");
		expect((await w.view()).wallets.map((each) => each.address)).toEqual([wallet.address]);
	});

	it("refuses an id whose prefix is not the one the wallet's credentials record", async () => {
		const w = await world();
		await w.create();
		const before = JSON.stringify(memoryKeystore().state.items);
		await writeFile(join(w.home, "auth", "device-id"), "00000000-0000-4000-8000-000000000000\n");
		await w.restart();
		expect((await w.view()).offline).toBe("identity");
		await refused(w);
		expect(JSON.stringify(memoryKeystore().state.items)).toBe(before);
	});

	it("through the daemon, on a kept format-5 home whose id went: refused, its keys still under the old prefix", async () => {
		const home = await tempHome();
		await cp(join(import.meta.dirname, "fixtures/homes/format-5"), home, { recursive: true });
		const old = (await readFile(join(home, "auth", "device-id"), "utf8")).trim();
		await rm(join(home, "auth", "device-id"));
		const keychain = join(await tempHome(), "keychain.json");
		const items = JSON.parse(await readFile(join(home, "keychain.json"), "utf8")) as Record<string, string>;
		await writeFile(keychain, JSON.stringify({ items, faults: [], calls: [] }));
		vi.stubEnv("BANDA_TEST_KEYSTORE", keychain);
		const daemon = await startDaemon({
			home,
			port: 0,
			models: echoModels().models,
			log: () => {},
			box: hostBox(home),
			fetch: fauxRpc(),
		});
		stops.push(() => daemon.close());
		const token = (await readDaemonFile(home))?.token;
		const api = async (method: string, path: string, body?: unknown) => {
			const response = await fetch(`http://127.0.0.1:${daemon.port}/api${path}`, {
				method,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			return { status: response.status, body: (await response.json()) as Record<string, unknown> };
		};
		const viewed = await until(async () => {
			const got = await api("GET", "/wallets");
			return got.status === 200 && (got.body as WalletsView).offline !== undefined ? got : undefined;
		});
		expect((viewed.body as WalletsView).offline).toBe("identity");
		const made = await api("POST", "/wallets", {
			request: `kept-${process.pid}`,
			name: "Rent",
			network: "base-sepolia",
		});
		expect(made).toMatchObject({ status: 503, body: { code: "identity" } });
		const after = (JSON.parse(await readFile(keychain, "utf8")) as FakeState).items;
		expect(after).toEqual(items);
		expect(Object.keys(after).every((account) => account.startsWith(`${old}/`))).toBe(true);
	});
});

describe("a wallet's credentials a power cut lost", () => {
	it("are written again at the next start, the agents it is on for kept, whether gone or of another generation", async () => {
		const w = await world();
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/agents/${LEAD}`, { on: true });
		const account = accountKey(wallet.address);
		const folder = join(w.home, "auth", "connections", WALLET, account);
		const kept = await credentialsOf(w.home, WALLET, account);
		expect(kept).toBeDefined();
		const whole = async () => {
			const credentials = await credentialsOf(w.home, WALLET, account);
			const named = (await w.s.harness.snapshot(Connected, context))?.accounts?.[WALLET]?.[account];
			return credentials !== undefined && credentials.generation === named?.generation ? credentials : undefined;
		};
		for (const lose of [
			() => rm(folder, { recursive: true, force: true }),
			() => keepCredentials(w.home, WALLET, account, { ...(kept as object), generation: "another" } as never),
		]) {
			await lose();
			expect(await w.s.capabilities.walletKept(wallet.address)).toBe(false);
			await w.restart();
			const again = await until(whole);
			expect(again).toMatchObject({ wallet: { address: wallet.address } });
			expect(await w.s.capabilities.walletKept(wallet.address)).toBe(true);
			expect((await w.view()).wallets[0]?.agents).toEqual([LEAD]);
		}
	});
});

describe("what the owner is told of, not yet on disk (C21)", () => {
	it("makes the last process's commits safe before a restart's first view, and knows its removal from the store (C21)", async () => {
		let barrier: ReturnType<typeof barriered> | undefined;
		let syncs = 0;
		/** The n-th barrier from now fails; every other is the store's own barrier. */
		let at = 0;
		let down = false;
		const fail = (n = 1) => {
			at = syncs + n;
		};
		// an empty chain: nothing at either address holds a removal
		const answers: Record<string, string> = {
			eth_getCode: "0x",
			eth_chainId: BASE_SEPOLIA_ID,
			eth_blockNumber: "0x2a",
			eth_getBalance: "0x0",
			eth_call: `0x${"0".repeat(64)}`,
		};
		const w = await world("1", {
			sync: async () => {
				syncs++;
				if (down || syncs === at) throw new Error("the disk refused");
				await barrier?.sync();
			},
			fetch: async (_url, init) => {
				const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
				const result = answers[method];
				return Response.json(
					result === undefined
						? { jsonrpc: "2.0", id, error: { code: -32601, message: "not offered here" } }
						: { jsonrpc: "2.0", id, result },
				);
			},
		});
		barrier = barriered(w.s.home, w.s.harness);
		const onDisk = (address: string) =>
			(barrier as ReturnType<typeof barriered>).cut()(
				async (store) => (await store.snapshot(Wallets, context))?.wallets[address],
			);
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const version = (await w.record(wallet.address))?.version as number;
		// archived, its answer not yet safe; then the daemon restarts, which flushes nothing
		fail();
		expect((await refusedWith(w.json("POST", `/wallets/${wallet.address}/archive`, { version }), 503)).code).toBe(
			"unsynced",
		);
		expect((await onDisk(wallet.address))?.state).toBe("ready");
		// a restart whose first barrier fails shows nothing as done: no safe read yet, so not yet safe
		down = true;
		await w.restart();
		expect((await refusedWith(w.json("GET", "/wallets"), 503)).code).toBe("unsynced");
		// the disk answers again: the first view is barriered before it answers, so a cut right after it keeps what it
		// shows
		down = false;
		const before = syncs;
		const shown = (await w.json("GET", "/wallets")) as WalletsView;
		expect(syncs).toBeGreaterThan(before);
		expect(shown.wallets.find((one) => one.address === wallet.address)?.state).toBe("archived");
		expect((await onDisk(wallet.address))?.state).toBe("archived");

		// a removal whose last commit landed but did not sync, retried after a restart: done, and on disk, not "no such
		// wallet"
		const two = await w.create({}, `request-${process.pid}-two`);
		await w.json("POST", `/wallets/${two.wallet.address}/skip`);
		const current = (await w.record(two.wallet.address))?.version as number;
		fail(3);
		expect(
			(await refusedWith(w.json("POST", `/wallets/${two.wallet.address}/remove`, { version: current }), 503)).code,
		).toBe("unsynced");
		expect(await w.record(two.wallet.address)).toBeUndefined();
		expect((await onDisk(two.wallet.address))?.state).toBe("removing");
		await w.restart();
		await w.json("POST", `/wallets/${two.wallet.address}/remove`, { version: current });
		expect(await onDisk(two.wallet.address)).toBeUndefined();
		// a wallet no removal took is still no such wallet
		await refusedWith(
			w.json("POST", "/wallets/0x0000000000000000000000000000000000000001/remove", { version: 1 }),
			404,
		);
	});

	it("answers the desktop's word, the save step, a switch on and the code's acknowledgement as not yet safe, each made", async () => {
		const code = "0x6080604052";
		const answers: Record<string, string> = {
			eth_getCode: code,
			eth_blockNumber: "0x2a",
			eth_chainId: BASE_SEPOLIA_ID,
		};
		let failing = false;
		const w = await world("1", {
			sync: async () => {
				if (failing) throw new Error("the disk refused");
			},
			fetch: async (_url, init) => {
				const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
				const result = answers[method];
				return Response.json(
					result === undefined
						? { jsonrpc: "2.0", id, error: { code: -32601, message: "not offered here" } }
						: { jsonrpc: "2.0", id, result },
				);
			},
		});
		const { request, wallet } = await w.create();
		const shown = await w.reveal(wallet.address, request, await connection());
		const { key } = (shown.response as { body: WalletRevealed }).body;
		const unsynced = async (path: string, body: Record<string, unknown> = {}) =>
			expect((await refusedWith(w.json("POST", path, body), 503)).code).toBe("unsynced");
		failing = true;
		await unsynced(`/wallets/${wallet.address}/revealed`, { id: "showing-1" });
		expect(await saw(w)).toHaveLength(1);
		await unsynced(`/wallets/${wallet.address}/saved`, { digest: digest(key) });
		expect((await w.record(wallet.address))?.backup).toBe("saved");
		await unsynced(`/wallets/${wallet.address}/agents/${LEAD}`, { on: true });
		await unsynced(`/wallets/${wallet.address}/acknowledge-code`);
		expect((await w.record(wallet.address))?.code).toMatchObject({ block: 42 });
		// what no barrier made safe shows nowhere as done: not to the acting client, nor on the shell stream (C21)
		const hidden = await w.view();
		expect(hidden.wallets[0]).toMatchObject({ backup: "unsaved", agents: [] });
		// the newest showing it lists is still the creation's
		const created = (await w.record(wallet.address))?.reveals?.find((each) => each.kind === "creation")?.at;
		expect(hidden.wallets[0]?.revealed).toBe(created);
		failing = false;
		// each retry is the same act, done once the barrier passes: the showing is listed once, under its id
		await w.json("POST", `/wallets/${wallet.address}/revealed`, { id: "showing-1" });
		expect(await saw(w)).toHaveLength(1);
		expect((await w.record(wallet.address))?.reveals?.filter((each) => each.kind === "later")).toHaveLength(1);
		await w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(key) });
		await w.json("POST", `/wallets/${wallet.address}/agents/${LEAD}`, { on: true });
		// the code's acknowledgement too: acknowledged once, its line in the activity once
		const acknowledged = (await w.record(wallet.address))?.code;
		await w.json("POST", `/wallets/${wallet.address}/acknowledge-code`);
		expect((await w.record(wallet.address))?.code).toEqual(acknowledged);
		const lines = ((await w.s.harness.snapshot(ActivityLog, context))?.events ?? []).filter((event) =>
			event.what.startsWith("You acknowledged the code at the address of the wallet"),
		);
		expect(lines).toHaveLength(1);
		const after = await w.view();
		expect(after.wallets[0]).toMatchObject({ backup: "saved", agents: [LEAD] });
	});

	it("shows a derived reason at once while a failed barrier freezes the view, and the timer's barrier ends the freeze", async () => {
		let failing = false;
		const w = await world("1", {
			resettle: 50,
			sync: async () => {
				if (failing) throw new Error("the disk refused");
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const before = (await w.record(wallet.address)) as NonNullable<Awaited<ReturnType<typeof w.record>>>;
		failing = true;
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/archive`, { version: before.version }), 503);
		expect((await w.view()).wallets[0]?.state).toBe("ready");
		// a coding agent connected is no commit of the owner's acts: why the wallets are offline shows at once (C22)
		await w.s.harness.commit(async (tx) => {
			(await tx.doc(Harnesses)).accounts.pi = { folder: w.home, agents: [] };
		}, context);
		const frozen = await w.view();
		expect(frozen.offline).toBe("coding_agent");
		expect(frozen.wallets[0]?.state).toBe("ready");
		// once the disk takes a barrier again, the timer passes one: the archive shows, with no act of the owner's
		failing = false;
		await until(async () => ((await w.view()).wallets[0]?.state === "archived" ? true : undefined));
		expect((await w.shell())?.wallets.wallets[0]?.state).toBe("archived");
		await w.s.harness.commit(async (tx) => {
			delete (await tx.doc(Harnesses)).accounts.pi;
		}, context);
		expect((await w.view()).offline).toBeUndefined();
	});

	it("keeps the newest safe read when barriers finish out of order, so a later failure hides no act told done", async () => {
		const held: (() => void)[] = [];
		let mode: "pass" | "hold" | "fail" = "pass";
		const w = await world("1", {
			sync: () => {
				if (mode === "fail") return Promise.reject(new Error("the disk refused"));
				if (mode === "pass") return Promise.resolve();
				return new Promise<void>((resolve) => held.push(resolve));
			},
		});
		const { wallet } = await w.create();
		mode = "hold";
		// A: a switch on, its barrier held; B: the save step skipped, its barrier held after A's
		const a = w.json("POST", `/wallets/${wallet.address}/agents/${LEAD}`, { on: true });
		await until(() => (held.length === 1 ? true : undefined));
		const b = w.json("POST", `/wallets/${wallet.address}/skip`);
		await until(() => (held.length === 2 ? true : undefined));
		mode = "pass";
		// B's barrier finishes first, then A's (each answer waits for every barrier under way, so both come after)
		held[1]?.();
		await new Promise((resolve) => setImmediate(resolve));
		held[0]?.();
		await Promise.all([a, b]);
		const before = (await w.record(wallet.address)) as NonNullable<Awaited<ReturnType<typeof w.record>>>;
		mode = "fail";
		await refusedWith(w.json("POST", `/wallets/${wallet.address}/archive`, { version: before.version }), 503);
		// both acts were answered as done: neither is hidden by the frozen view
		const shown = await w.view();
		expect(shown.wallets[0]).toMatchObject({ state: "ready", backup: "skipped", agents: [LEAD] });
	});

	it("shows an act whose barrier failed nowhere as done, the shell stream included, until its retry passes one (C21)", async () => {
		let failing = false;
		const w = await world("1", {
			sync: async () => {
				if (failing) throw new Error("the disk refused");
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		const before = (await w.record(wallet.address)) as NonNullable<Awaited<ReturnType<typeof w.record>>>;
		// a watch of the doc fires on the commit, as the shell stream's does: what it pushes is read through the barrier
		const fired: string[] = [];
		const watch = await w.s.harness.watchDoc(Wallets, context);
		watch?.start(async () => {
			fired.push("changed");
		});
		failing = true;
		const refused = await refusedWith(
			w.json("POST", `/wallets/${wallet.address}/archive`, { version: before.version }),
			503,
		);
		expect(refused.code).toBe("unsynced");
		await until(() => fired.length > 0 || undefined);
		// the store holds the archive; nothing shown says so
		expect((await w.record(wallet.address))?.state).toBe("archived");
		expect((await w.shell())?.wallets.wallets[0]?.state).toBe("ready");
		expect((await w.view()).wallets[0]?.state).toBe("ready");
		// the retry with the same version is the same act: done once the barrier passes, and shown everywhere
		failing = false;
		await w.json("POST", `/wallets/${wallet.address}/archive`, { version: before.version });
		expect((await w.shell())?.wallets.wallets[0]?.state).toBe("archived");
		expect((await w.view()).wallets[0]?.state).toBe("archived");
		await watch?.stop();
	});

	it("answers Receive whose disclosed mark is not on disk as not yet safe, and gives no address (C21)", async () => {
		let failing = false;
		const w = await world("1", {
			sync: async () => {
				if (failing) throw new Error("the disk refused");
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		failing = true;
		const refused = await refusedWith(w.json("POST", `/wallets/${wallet.address}/receive`), 503);
		expect(refused.code).toBe("unsynced");
		expect(refused.message).not.toContain(wallet.address);
		expect((await w.record(wallet.address))?.disclosed).toBe(true);
		failing = false;
		expect(await w.json("POST", `/wallets/${wallet.address}/receive`)).toMatchObject({
			state: "ready",
			address: wallet.address,
		});
	});

	it("has the desktop's word, the save step, a switch on and the code's acknowledgement in the database itself once answered", async () => {
		const answers: Record<string, string> = {
			eth_getCode: "0x6080604052",
			eth_blockNumber: "0x2a",
			eth_chainId: BASE_SEPOLIA_ID,
		};
		const w = await world("1", {
			fetch: async (_url, init) => {
				const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
				const result = answers[method];
				return Response.json(
					result === undefined
						? { jsonrpc: "2.0", id, error: { code: -32601, message: "not offered here" } }
						: { jsonrpc: "2.0", id, result },
				);
			},
		});
		const { request, wallet } = await w.create();
		const shown = await w.reveal(wallet.address, request, await connection());
		const { key } = (shown.response as { body: WalletRevealed }).body;
		// a power cut after each answer loses what the write-ahead log held and the database did not
		const cut = <T>(read: (store: Store) => Promise<T>) => powerCut(w.home)(read);
		const record = (store: Store) => store.snapshot(Wallets, context).then((doc) => doc?.wallets[wallet.address]);
		await w.json("POST", `/wallets/${wallet.address}/revealed`);
		const seen = await cut(async (store) => (await store.snapshot(ActivityLog, context))?.events ?? []);
		expect(seen.filter((event) => event.what.startsWith("You saw the key of the wallet Groceries"))).toHaveLength(1);
		await w.json("POST", `/wallets/${wallet.address}/saved`, { digest: digest(key) });
		expect((await cut(record))?.backup).toBe("saved");
		await w.json("POST", `/wallets/${wallet.address}/agents/${LEAD}`, { on: true });
		const on = await cut(async (store) => (await store.snapshot(Connected, context))?.on?.[LEAD]?.[WALLET]);
		expect(on).toContain(accountKey(wallet.address));
		await w.json("POST", `/wallets/${wallet.address}/acknowledge-code`);
		expect((await cut(record))?.code).toMatchObject({ block: 42 });
	});
});

describe("a creation the keychain refuses", () => {
	const make = (w: Awaited<ReturnType<typeof world>>, request: string) =>
		w.json("POST", "/wallets", { request, name: "Groceries", network: "base-sepolia" });

	it("tells no keychain, a creation waiting on the keychain, and one that left nothing apart by their codes", async () => {
		const w = await world();
		await w.create();
		const keychain = async () => ((await w.json("GET", "/wallets")) as WalletsView).keychain;
		expect(await keychain()).toBeUndefined();
		const faults = memoryKeystore().state.faults;
		// no keychain answers at all: the creation cannot be read back either
		faults.push(
			{ point: "keychain:write", account: "/wallet/", throw: "No keychain is available" },
			{ point: "keychain:read", account: "/wallet/", throw: "No keychain is available" },
		);
		expect((await refusedWith(make(w, `refused-${process.pid}-1`), 503)).code).toBe("no_keychain");
		// the wallets say so from then on, for Settings to say it in place of New wallet (H-309)
		expect(await keychain()).toBe("none");
		faults.splice(0);
		// a locked keychain: the creation waits on it, its record kept
		faults.push(
			{ point: "keychain:write", account: "/wallet/", throw: "User interaction is not allowed." },
			{ point: "keychain:read", account: "/wallet/", throw: "User interaction is not allowed." },
		);
		expect((await refusedWith(make(w, `refused-${process.pid}-2`), 503)).code).toBe("creating");
		faults.splice(0);
		// an item already where the key was to go: the record is dropped, and nothing waits
		faults.push({ point: "keychain:read", account: "/wallet/", answer: `0x${"11".repeat(32)}`, times: 1 });
		expect((await refusedWith(make(w, `refused-${process.pid}-3`), 503)).code).toBe("dropped");
		expect(await keychain()).toBe("none");
		// a creation whose key was kept: the keychain answers after all
		await make(w, `refused-${process.pid}-4`);
		expect(await keychain()).toBeUndefined();
	});

	it("settles a creation the keychain left waiting once it answers again, with no restart", async () => {
		const w = await world();
		const faults = memoryKeystore().state.faults;
		const locked = "User interaction is not allowed.";
		faults.push(
			{ point: "keychain:write", account: "/wallet/", throw: locked },
			{ point: "keychain:read", account: "/wallet/", throw: locked },
		);
		expect((await refusedWith(make(w, `waiting-${process.pid}-1`), 503)).code).toBe("creating");
		const waiting = Object.entries((await w.s.harness.snapshot(Wallets, context))?.wallets ?? {});
		expect(waiting.map(([, record]) => record.state)).toEqual(["creating"]);
		const [address] = waiting[0] as [string, unknown];
		// still locked: Try again leaves it waiting
		await w.json("POST", "/wallets/keychain");
		expect((await w.record(address))?.state).toBe("creating");
		faults.splice(0);
		// the keychain answers: what it left being made is settled now, gone since its key was never written
		await w.json("POST", "/wallets/keychain");
		expect(await w.record(address)).toBeUndefined();
		expect((await w.view()).wallets).toEqual([]);
		// a fresh creation is made at once
		await make(w, `waiting-${process.pid}-2`);
		expect((await w.view()).wallets.map((wallet) => wallet.state)).toEqual(["ready"]);
	});
});

describe("a check that moves what the wallets show (C22, H-317)", () => {
	it("pushes the wallets to every open screen once a keychain check or a wallet's check clears its No keychain", async () => {
		const w = await world("1", { fetch: fauxRpc() });
		const { wallet } = await w.create();
		const faults = memoryKeystore().state.faults;
		faults.push({ point: "keychain:read", account: "/wallet/", throw: "No keychain is available" });
		await w.json("POST", `/wallets/${wallet.address}/check`);
		const offline = (await w.view()).wallets[0]?.signing;
		expect(offline?.code).toBe("no_keychain");
		expect((await w.view()).keychain).toBe("none");
		faults.splice(0);
		// Check again on one screen: the push that says the keychain answers is followed by one for the wallet's check,
		// so no other screen keeps the wallet's No keychain
		let pushed = w.pushes.length;
		await w.json("POST", "/wallets/keychain");
		expect((await w.view()).wallets[0]?.signing?.state).toBe("online");
		expect(w.pushes.length - pushed).toBeGreaterThanOrEqual(2);
		expect((await w.shell())?.wallets.wallets[0]?.signing?.state).toBe("online");
		// a wallet's own check that changes nothing pushes nothing; one that finds the key gone pushes
		pushed = w.pushes.length;
		await w.json("POST", `/wallets/${wallet.address}/check`);
		expect(w.pushes.length).toBe(pushed);
		await editKeys(w.keystore, (state) => {
			delete state.items[itemOf(state, "/wallet/")];
		});
		await w.json("POST", `/wallets/${wallet.address}/check`);
		expect((await w.view()).wallets[0]?.signing?.state).toBe("key_missing");
		expect(w.pushes.length).toBeGreaterThan(pushed);
	});
});

describe("the money that came in, as GET /wallets/<address>/incoming lists it", () => {
	const BASE_SEPOLIA = 84532;
	/** A faux Base Sepolia whose head is now: a wallet made now is read from a few blocks back. */
	const chainNow = () => {
		const chain = new FauxChain(BASE_SEPOLIA);
		chain.head = Math.floor(Date.now() / 1000) - GENESIS + 20;
		chain.final = chain.head - 5;
		return chain;
	};
	const rows = (address: string, count: number) =>
		Object.fromEntries(
			Array.from({ length: count }, (_, at) => [
				`native:${address}:${at}`,
				{ wallet: checksummed(address), asset: "native" as const, amount: String(1000 + at), block: 10 + at },
			]),
		);

	it("says the address runs code as each pass reads it: cleared through another RPC, shown once a down one answers (H-157)", async () => {
		const first = chainNow();
		const other = chainNow();
		let down = true;
		const w = await world("1", {
			fetch: async (url, init) => {
				if (String(url).includes("localhost:2")) return other.fetch(url, init);
				if (down) throw new TypeError("fetch failed");
				return first.fetch(url, init);
			},
		});
		const { wallet } = await w.create();
		await w.json("POST", `/wallets/${wallet.address}/skip`);
		first.code.set(wallet.address.toLowerCase(), `0xef0100${"ab".repeat(20)}`);
		const coded = async () => (await w.view()).wallets[0]?.code === true;
		const read = () => w.json("GET", `/wallets/${wallet.address}/incoming`).catch(() => undefined);
		// the RPC was down at the start: the unlock's check read nothing, and nothing is said yet
		expect(await coded()).toBe(false);
		// it answers again: the next pass reads the code with the balances, and the notice shows without a Receive
		down = false;
		await until(async () => {
			await read();
			return (await coded()) ? true : undefined;
		});
		// the owner saves another RPC, whose chain has no code there: the notice goes with its next pass
		await w.json("PUT", "/wallets/rpc/base-sepolia", { url: "http://localhost:2/" });
		await until(async () => {
			await read();
			return (await coded()) ? undefined : true;
		});
		// and the code set there too shows again, as a delegation cleared and set would
		other.code.set(wallet.address.toLowerCase(), `0xef0100${"cd".repeat(20)}`);
		await until(async () => {
			await read();
			return (await coded()) ? true : undefined;
		});
	});

	it("answers a page without waiting on its rows' times, reads each block's time once behind it, and says so (H-198)", async () => {
		const chain = chainNow();
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const blocks = [10, 11, 12, 13];
		const asks = (block: number) =>
			chain.calls.filter(
				(call) => call.method === "eth_getBlockByNumber" && call.params[0] === `0x${block.toString(16)}`,
			).length;
		const w = await world("1", {
			fetch: async (url, init) => {
				const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
				// the rows' blocks answer only once the test opens the gate: a page that waited on them would never answer
				if (method === "eth_getBlockByNumber" && blocks.map((b) => `0x${b.toString(16)}`).includes(String(params[0])))
					await gate;
				return chain.fetch(url, init);
			},
		});
		const { wallet } = await w.create();
		await w.s.harness.commit(async (tx) => {
			const incoming = await tx.doc(Incoming);
			// ten rows over four blocks
			incoming.rows = Object.fromEntries(
				Array.from({ length: 10 }, (_, at) => [
					`native:${wallet.address}:${at}`,
					{
						wallet: checksummed(wallet.address),
						asset: "native" as const,
						amount: String(1000 + at),
						block: blocks[at % 4] as number,
					},
				]),
			);
		}, context);
		const path = `/wallets/${wallet.address}/incoming`;
		const first = (await w.json("GET", path)) as WalletIncoming;
		expect(first.rows).toHaveLength(10);
		expect(first.rows.every((row) => row.at === undefined)).toBe(true);
		// a second page while the times are still being read asks for none again
		await w.json("GET", path);
		const pushed = w.pushes.length;
		const untimed = JSON.stringify(await w.shell());
		open();
		const timed = await until(async () => {
			const page = (await w.json("GET", path)) as WalletIncoming;
			return page.rows.every((row) => row.at !== undefined) ? page : undefined;
		});
		expect(timed.rows.find((row) => row.block === 10)?.at).toBe((GENESIS + 10) * 1000);
		for (const block of blocks) expect(asks(block), `block ${block}`).toBe(1);
		// once they were read, the open screens were told, so the page reads again and finds them: the push is of a shell
		// event that changed, since an event like the last is never written again (C22, UC-14)
		expect(w.pushes.length).toBeGreaterThan(pushed);
		const told = await w.shell();
		expect(JSON.stringify(told)).not.toBe(untimed);
		expect(told?.wallets.networks.find((network) => network.id === "base-sepolia")?.timed).toBeGreaterThan(0);
	});

	it("lists at most 50 rows a page, newest first, Confirmed only up to the final cursor, and is reading until a pass ends", async () => {
		const chain = new FauxChain(BASE_SEPOLIA);
		// the chain is down so no pass writes the rows the test sets; that it is down is the next test's
		chain.refuse = () => new Response("down", { status: 502 });
		const w = await world("1", {
			fetch: chain.fetch,
			indexer: (indexer) => ({
				...indexer,
				status: (network) => {
					const status = indexer.status(network);
					if (status === undefined) return undefined;
					const { failed: _, ...rest } = status;
					return rest;
				},
			}),
		});
		const { wallet } = await w.create();
		const first = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
		expect(first).toEqual({ rows: [], incomplete: "reading" });
		// a wallet the indexer does not read (still being made) is not said to be read
		const key = checksummed(wallet.address);
		await w.s.harness.commit(async (tx) => {
			const record = (await tx.doc(Wallets)).wallets[key];
			if (record !== undefined) record.state = "creating";
		}, context);
		expect(await w.json("GET", `/wallets/${wallet.address}/incoming`)).toEqual({ rows: [] });
		await w.s.harness.commit(async (tx) => {
			const record = (await tx.doc(Wallets)).wallets[key];
			if (record !== undefined) record.state = "ready";
		}, context);
		await w.s.harness.commit(async (tx) => {
			const incoming = await tx.doc(Incoming);
			incoming.rows = rows(wallet.address, 70);
			incoming.cursors = { "base-sepolia": 50 };
			incoming.read = { [checksummed(wallet.address)]: 50 };
		}, context);
		const listed = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
		expect(listed.rows).toHaveLength(INCOMING_ROWS);
		expect(INCOMING_ROWS).toBe(50);
		expect(listed.rows.map((row) => row.block)).toEqual(Array.from({ length: 50 }, (_, at) => 79 - at));
		expect(listed.rows.find((row) => row.block === 51)?.confirmed).toBe(false);
		expect(listed.rows.find((row) => row.block === 50)?.confirmed).toBe(true);
		expect(listed.incomplete).toBeUndefined();
		// the older rows are the next page, from where this one ended, and none twice
		expect(listed.more).toBeDefined();
		const path = `/wallets/${wallet.address}/incoming`;
		const older = (await w.json(
			"GET",
			path,
			{},
			{
				url: new URL(`http://local/api${path}?wake=false&before=${encodeURIComponent(listed.more as string)}`),
			},
		)) as WalletIncoming;
		expect(older.rows.map((row) => row.block)).toEqual(Array.from({ length: 20 }, (_, at) => 29 - at));
		expect(older.more).toBeUndefined();
		await refusedWith(w.json("GET", path, {}, { url: new URL(`http://local/api${path}?before=nonsense`) }), 400);
		await w.s.harness.commit(async (tx) => {
			(await tx.doc(Incoming)).gaps = { [checksummed(wallet.address)]: [{ from: 40, to: 42, why: "state" }] };
		}, context);
		const gapped = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
		expect(gapped).toMatchObject({ incomplete: "gaps", through: { block: 50 } });
		// what a long history no longer keeps is said on its last page alone
		await w.s.harness.commit(async (tx) => {
			(await tx.doc(Incoming)).dropped = { [checksummed(wallet.address)]: 9 };
		}, context);
		expect(((await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming).dropped).toBeUndefined();
		const last = (await w.json(
			"GET",
			path,
			{},
			{ url: new URL(`http://local/api${path}?wake=false&before=${encodeURIComponent(listed.more as string)}`) },
		)) as WalletIncoming;
		expect(last.dropped).toBe(9);
	});

	it("says each kind of native gap as what it is: spent outside banda a row, code at the address, the RPC's window (H-204, H-210)", async () => {
		const chain = new FauxChain(BASE_SEPOLIA);
		// the chain is down so no pass writes over the gaps the test sets; the status is shown as if a pass read it whole
		chain.refuse = () => new Response("down", { status: 502 });
		let stateFrom: number | undefined;
		const w = await world("1", {
			fetch: chain.fetch,
			indexer: (indexer) => ({
				...indexer,
				status: (network) => {
					const status = indexer.status(network);
					if (status === undefined) return undefined;
					const { failed: _, ...rest } = status;
					return { ...rest, head: 90, ...(stateFrom === undefined ? {} : { stateFrom }) };
				},
			}),
		});
		const { wallet } = await w.create();
		const address = checksummed(wallet.address);
		const path = `/wallets/${wallet.address}/incoming`;
		const page = async (before?: string) =>
			(await w.json(
				"GET",
				path,
				{},
				before === undefined
					? {}
					: { url: new URL(`http://local/api${path}?wake=false&before=${encodeURIComponent(before)}`) },
			)) as WalletIncoming;
		const gaps = async (list: IncomingGap[]) =>
			w.s.harness.commit(async (tx) => {
				const incoming = await tx.doc(Incoming);
				incoming.rows = rows(wallet.address, 70);
				incoming.cursors = { "base-sepolia": 50 };
				incoming.read = { [address]: 50 };
				incoming.gaps = { [address]: list };
			}, context);
		// a nonce moved with no spend of banda's: a row of money that left outside banda, on the page its block falls in,
		// and no notice that ETH came in or that banda reads those blocks again
		await gaps([
			{ from: 5, to: 5, why: "unexplained" },
			{ from: 20, to: 21, why: "unexplained" },
			{ from: 60, to: 60, why: "unexplained" },
		]);
		const first = await page();
		expect(first.incomplete).toBeUndefined();
		expect(first.gaps).toBeUndefined();
		expect(first.outside).toEqual([{ id: "outside:60:60", from: 60, block: 60, confirmed: false }]);
		const second = await page(first.more);
		expect(second.more).toBeUndefined();
		expect(second.outside?.map((row) => row.block)).toEqual([21, 5]);
		expect(second.outside?.[0]).toMatchObject({ from: 20, confirmed: true });
		// code at the address: said as that, never as blocks read again
		await gaps([{ from: 40, to: 42, why: "code" }]);
		expect(await page()).toMatchObject({ incomplete: "gaps", gaps: { code: true } });
		expect((await page()).gaps?.again).toBeUndefined();
		// a stretch of no state the indexer asks again of, until the RPC's window is known to end above it
		await gaps([{ from: 11, to: 30, why: "state" }]);
		expect((await page()).gaps).toEqual({ again: true });
		stateFrom = 30;
		const pruned = await page();
		expect(pruned).toMatchObject({ incomplete: "gaps", gaps: { pruned: 30 }, through: { block: 50 } });
		expect(pruned.gaps?.again).toBeUndefined();
		// one above the window is asked again beside the one below it
		await gaps([
			{ from: 11, to: 30, why: "state" },
			{ from: 45, to: 46, why: "state" },
		]);
		expect((await page()).gaps).toMatchObject({ again: true, pruned: 30 });
	});

	it("says money that came in is not listed past the last read while the network's RPC does not answer (H-207, H-208)", async () => {
		const chain = chainNow();
		let down = false;
		const w = await world("1", {
			fetch: async (url, init) => {
				if (down) throw new TypeError("fetch failed");
				return chain.fetch(url, init);
			},
		});
		const { wallet } = await w.create();
		const read = await until(async () => {
			const got = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
			return got.incomplete === undefined ? got : undefined;
		});
		expect(read.rows).toEqual([]);
		down = true;
		const said = await until(async () => {
			const got = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
			return got.incomplete === "unread" ? got : undefined;
		});
		expect(said.rows).toEqual([]);
		expect(said.since).toEqual(expect.any(Number));
		expect(said.through?.block).toEqual(expect.any(Number));
		// it answers again: the list is whole again
		down = false;
		await until(async () => {
			const got = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
			return got.incomplete === undefined ? got : undefined;
		});
	});

	it("says USDC is not listed through an RPC that refuses log queries, in the networks too", async () => {
		const chain = chainNow();
		chain.refuse = (method) =>
			method === "eth_getLogs"
				? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no logs here" } }), {
						headers: { "content-type": "application/json" },
					})
				: undefined;
		const w = await world("1", { fetch: chain.fetch });
		const { wallet } = await w.create();
		const said = await until(async () => {
			const got = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
			return got.incomplete === "logs" ? got : undefined;
		});
		expect(said.rows).toEqual([]);
		expect(said.through).toBeUndefined();
		expect((await w.view()).networks.find((network) => network.id === "base-sepolia")?.logs).toBe(false);
		// once a stretch of the wallet's history was read and final, the list says how far it is whole (UC-14 E1)
		await w.s.harness.commit(async (tx) => {
			const incoming = await tx.doc(Incoming);
			incoming.read = { ...incoming.read, [checksummed(wallet.address)]: 7 };
		}, context);
		const whole = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
		expect(whole).toMatchObject({ incomplete: "logs", through: { block: 7 } });
	});

	it("pushes the wallets when a read of the chain changed a balance, and not for a read that changed nothing", async () => {
		const chain = chainNow();
		// the indexer's own changes are counted: the area also pushes for its start-up check and block times, on their own
		// clocks, so a count of every push would be moved by work this test never waits on
		const changes: number[] = [];
		const w = await world("1", { fetch: chain.fetch, changes });
		const { wallet } = await w.create();
		const passes = () => chain.calls.filter((call) => call.method === "eth_blockNumber").length;
		/** One more pass asked for, and begun: the one before it has ended. */
		const another = async () => {
			const at = passes();
			await w.json("GET", `/wallets/${wallet.address}/incoming`);
			await until(async () => (passes() > at ? true : undefined));
		};
		await until(async () => ((await w.view()).wallets[0]?.balance === undefined ? undefined : true));
		expect(changes.length).toBeGreaterThan(0);
		expect(w.pushes.length).toBeGreaterThan(0);
		await another();
		await another();
		const settled = changes.length;
		await another();
		await another();
		expect(changes.length).toBe(settled);
		chain.head += 1;
		chain.set(wallet.address, chain.head, 10n ** 18n);
		const pushed = w.pushes.length;
		await another();
		await until(async () => (changes.length > settled ? true : undefined));
		// and the change reached the open screens
		await until(async () => (w.pushes.length > pushed ? true : undefined));
		expect((await w.view()).wallets[0]?.balance?.native).toBe(String(10n ** 18n));
	});

	it("logs no full address in a line with an amount, in the daemon's log or the activity (H-300)", async () => {
		const chain = chainNow();
		const w = await world("1", { fetch: chain.fetch });
		const { wallet } = await w.create();
		const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
		const payer = `0x${"d".repeat(40)}`;
		chain.head += 1;
		chain.set(wallet.address, chain.head, 15n * 10n ** 17n);
		chain.tokens.set(wallet.address.toLowerCase(), 2_500_000n);
		chain.log({ token: usdc, from: payer, to: wallet.address, value: 2_500_000n, block: chain.head });
		await until(async () => {
			const got = (await w.json("GET", `/wallets/${wallet.address}/incoming`)) as WalletIncoming;
			return got.rows.some((row) => row.asset === "usdc") ? true : undefined;
		});
		// a chain that stops answering, and the owner's own steps, write the lines a day leaves
		chain.refuse = () => new Response("down", { status: 502 });
		await w.json("GET", `/wallets/${wallet.address}/incoming`);
		const version = (await w.view()).wallets.find((one) => one.address === wallet.address)?.version;
		await w.json("POST", `/wallets/${wallet.address}/archive`, { version });
		const activity = ((await w.s.harness.snapshot(ActivityLog, context))?.events ?? []).map((event) => event.what);
		const lines = [...w.logs, ...activity];
		expect(activity.length).toBeGreaterThan(0);
		const full = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
		const amount = /\b\d+(?:\.\d+)? ?(?:ETH|USDC|wei)\b|\b(?:2500000|1500000000000000000|2\.5|1\.5)\b/;
		expect(lines.filter((line) => full.test(line) && amount.test(line))).toEqual([]);
	});

	it("reads the rows again without asking for a read of the chain when told not to wake it", async () => {
		const chain = chainNow();
		const wakes: string[] = [];
		const w = await world("1", { fetch: chain.fetch, wakes });
		const { wallet } = await w.create();
		const passes = () => chain.calls.filter((call) => call.method === "eth_blockNumber").length;
		const path = `/wallets/${wallet.address}/incoming`;
		await until(async () => ((await w.view()).wallets[0]?.balance === undefined ? undefined : true));
		const before = passes();
		await w.json("GET", path);
		expect(wakes.at(-1)).toBe("base-sepolia");
		await until(async () => (passes() > before ? true : undefined));
		const woken = wakes.length;
		for (let n = 0; n < 3; n++)
			expect(
				(await w.json("GET", path, {}, { url: new URL(`http://local/api${path}?wake=false`) })) as WalletIncoming,
			).toHaveProperty("rows");
		// the route wakes the indexer before it answers, so a read that would wake it has done so by now
		expect(wakes.length).toBe(woken);
		const quiet = passes();
		await w.json("GET", path);
		expect(wakes.length).toBe(woken + 1);
		await until(async () => (passes() > quiet ? true : undefined));
	});
});
