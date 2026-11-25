/**
 * The wallet as a connection (docs/wallets.md "Architecture", UC-05, UC-06): a wallet the owner makes is an account of
 * the wallet connection, on for no agent until the owner switches it on (OD-1); its reads reach only the agents it is
 * on for (H-056, H-066, H-072), and no agent's prompt names another's wallets (H-071); `wallet__address` says where to
 * pay it and marks it disclosed, once the key was saved or the step skipped (H-005); host mode and a coding agent on
 * this computer take wallets offline for agents (H-064, H-065); `wallet__balance` reads the chain at one block, on
 * anvil, and says unknown, never 0, when the chain cannot be read (H-208), in words that quote no setting (H-195).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "../src/core/activity.ts";
import { Accepted, agentWords, LEAD, shaOf } from "../src/core/agents.ts";
import {
	accountKey,
	Connected,
	connectionToolsOf,
	credentialsOf,
	keepCredentials,
	WALLET,
} from "../src/core/connections.ts";
import { OWNER } from "../src/core/gateway.ts";
import { Harnesses } from "../src/core/harness.ts";
import { context } from "../src/core/store.ts";
import type { TurnResult } from "../src/core/turn.ts";
import { infer } from "../src/server/inference.ts";
import { checksummed } from "../src/wallet/address.ts";
import { type WalletRecord, Wallets } from "../src/wallet/docs.ts";
import { walletLabel } from "../src/wallet/label.ts";
import type { Signing } from "../src/wallet/lifecycle.ts";
import { type NetworkId, networkOf } from "../src/wallet/networks.ts";
import { rpcClients } from "../src/wallet/rpc.ts";
import { UNOPENABLE, WALLET_TOOLS } from "../src/wallet/tools.ts";
import { type Connected as Opened, openConnected } from "./fixtures/connected.ts";
import { scripted } from "./fixtures/connections-world.ts";
import { scripted as inference } from "./fixtures/scripted.ts";
import { type Anvil, DEV0, hasAnvil, NO_ANVIL, startAnvil } from "./helpers/anvil.ts";
import { tempHome, until } from "./helpers.ts";

const ADDRESS = checksummed(DEV0.address);
const KEY = accountKey(ADDRESS);
/** anvil's public dev account 1: a second wallet. */
const OTHER = checksummed("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const OTHER_KEY = accountKey(OTHER);
const MARA = "mara";
/** An address with one letter's case flipped: mixed case whose EIP-55 checksum fails. */
const misChecksummed = (address: string): string => {
	const at = address.slice(2).search(/[a-fA-F]/) + 2;
	const letter = address[at] ?? "";
	const flipped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
	return `${address.slice(0, at)}${flipped}${address.slice(at + 1)}`;
};

/**
 * What a network banda ships an RPC for answers here, with no network reached: its chain id, the code at an address
 * (`0x`: none), or nothing at all. A chain on this computer, anvil, is reached as it is.
 */
let shipped: { code: string } | "down" = { code: "0x" };
/** How many requests reached a network's RPC, this computer's chain included. */
let rpcAsked = 0;
const chainFetch: typeof fetch = async (input, init) => {
	rpcAsked++;
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fetch(input, init);
	if (shipped === "down") throw new TypeError("fetch failed");
	const request = JSON.parse(String(init?.body)) as { id: number; method: string };
	const network = (["base", "base-sepolia"] as const)
		.map((id) => networkOf(id))
		.find((one) => one?.rpc !== undefined && new URL(one.rpc).host === url.host);
	const answer =
		request.method === "eth_getCode"
			? { result: shipped.code }
			: request.method === "eth_chainId" && network !== undefined
				? { result: `0x${network.chainId.toString(16)}` }
				: { error: { code: -32601, message: "not offered here" } };
	return Response.json({ jsonrpc: "2.0", id: request.id, ...answer });
};

/** A private key as it could be written: 64 hex digits, with `0x` or without, in either case. */
const KEY_SHAPED = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

const opened: Opened[] = [];
const chains: Anvil[] = [];
afterEach(async () => {
	shipped = { code: "0x" };
	rpcAsked = 0;
	vi.unstubAllEnvs();
	for (const s of opened.splice(0)) await s.close();
	for (const chain of chains.splice(0)) await chain.stop();
});

/** What the activity log says, oldest first. */
const whats = async (s: Opened) =>
	(await s.harness.snapshot(ActivityLog, context))?.events.map((event) => event.what) ?? [];

const record = (network: NetworkId, change: Partial<WalletRecord> = {}): WalletRecord => ({
	name: "Groceries",
	network,
	state: "ready",
	backup: "saved",
	default: "ask",
	disclosed: false,
	request: "r-1",
	version: 1,
	at: 1,
	...change,
});

type Tool = { name: string; parameters: unknown };
type Request = {
	tools?: Tool[];
	messages: { role: string; toolsAdded?: Tool[]; toolsRemoved?: { name: string }[] }[];
};

/** The tools a request offers the model: its own, and what its system messages add and take away, in order. */
function toolsIn(request: Request | undefined): { [name: string]: unknown } {
	const tools = new Map<string, unknown>((request?.tools ?? []).map((tool) => [tool.name, tool.parameters]));
	for (const message of request?.messages ?? []) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool.parameters);
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
	}
	return Object.fromEntries(tools);
}

async function open({ home, host, sync }: { home?: string; host?: boolean; sync?: () => Promise<void> } = {}) {
	const model = scripted();
	/** Run once, after the model asked for a tool call and before that call runs: what happens mid-turn. */
	let midTurn: (() => Promise<void>) | undefined;
	const respond = async (...args: Parameters<typeof model.respond>) => {
		const answer = model.respond(...args);
		const then = midTurn;
		if (then !== undefined && answer.stopReason === "toolUse") {
			midTurn = undefined;
			await then();
		}
		return answer;
	};
	const s = await openConnected({
		home: home ?? (await tempHome()),
		respond: respond as never,
		rpc: rpcClients({ retries: 0, timeoutMs: 5_000, fetch: chainFetch }),
		...(host === undefined ? {} : { host }),
		...(sync === undefined ? {} : { sync }),
	});
	opened.push(s);
	// what the wallets' area says of each key once it checked it: online, unless a test says otherwise
	const signing = new Map<string, Signing | undefined>();
	s.capabilities.checksWallets((address) => (signing.has(address) ? signing.get(address) : { state: "online" }));
	const say = async (text: string, agent?: string) => {
		const received = await s.core.receive(s.harness, {
			id: crypto.randomUUID(),
			origin: { gateway: "fake", peer: OWNER, ...(agent === undefined ? {} : { thread: agent }) },
			text,
			...(agent === undefined ? {} : { agent }),
		});
		if (!("turn" in received)) throw new Error(JSON.stringify(received));
		await s.harness.waitForTask(received.turn as TaskId<TurnResult>, context);
		return received.chat;
	};
	/** What the tool calls of `chat` answered, in order. */
	const results = async (chat: number) => {
		const page = await (await s.harness.conversation(chat as ConversationId, context))?.entries(
			{ order: "ascending" },
			1000,
			undefined,
			context,
		);
		return (page?.items ?? [])
			.filter((e) => e.kind === "pi.tool-result")
			.map((e) => {
				const m = e.model?.[0] as { content: { text?: string }[]; isError?: boolean };
				return { text: m.content.map((c) => c.text ?? "").join(""), error: m.isError === true };
			});
	};
	const newest = async (chat: number) =>
		(
			await (
				await s.harness.conversation(chat as ConversationId, context)
			)?.entries({ order: "descending" }, 1, undefined, context)
		)?.items[0]?.kind;
	const seen = new Map<number, number>();
	/** The requests the last `call` made of the model. */
	let asked: Request[] = [];
	/** `agent` (the lead unless said) calls `tool` once and its answer is returned: the one tool result its run adds. */
	const call = async (tool: string, args: Record<string, unknown> = {}, agent?: string) => {
		model.plan([{ tool, args }]);
		const before = model.requests.length;
		const chat = await say(`call ${tool}`, agent);
		// the scripted model never answers the owner: its run is done once the chat says so, after the nudge
		await until(async () => (await newest(chat)) === "banda.notice");
		asked = model.requests.slice(before) as unknown as Request[];
		const all = await results(chat);
		const added = all.slice(seen.get(chat) ?? 0);
		seen.set(chat, all.length);
		expect(added).toHaveLength(1);
		// no wallet tool's answer carries anything shaped like a key, whatever it was asked (H-265)
		expect(added[0]?.text).not.toMatch(KEY_SHAPED);
		return added[0];
	};
	const keep = (wallet: WalletRecord, address = ADDRESS) =>
		s.harness.commit(async (tx) => {
			(await tx.doc(Wallets)).wallets[address] = wallet;
		}, context);
	const make = (address: string, network: NetworkId) =>
		s.capabilities.addWallet({ account: `home/wallet/${address}`, address, network });
	const toolsOf = (agent: string, connections?: string[]) =>
		s.harness.commit(
			(tx) => connectionToolsOf(tx, { id: agent, ...(connections === undefined ? {} : { connections }) }),
			context,
		);
	/** Mara, an active agent whose file names the wallet connection. */
	const addMara = async () => {
		const text =
			"---\nname: Mara\nstate: active\ndescription: Buys groceries.\nconnections: [wallet]\n---\nYou shop.\n";
		mkdirSync(join(s.box.workspace, "agents"), { recursive: true });
		writeFileSync(join(s.box.workspace, "agents/mara.md"), text);
		await s.harness.commit(async (tx) => {
			(await tx.doc(Accepted)).files["agents/mara.md"] = { sha: shaOf(text), text, at: 1 };
		}, context);
	};
	/** The tools the last `call`'s first request offered the model, by name. */
	const offeredTo = () => toolsIn(asked[0]);
	const disclosed = async (address = ADDRESS) =>
		(await s.harness.snapshot(Wallets, context))?.wallets[address]?.disclosed;
	const meanwhile = (then: () => Promise<void>) => {
		midTurn = then;
	};
	return { ...s, model, call, keep, make, toolsOf, addMara, offeredTo, disclosed, signing, meanwhile };
}

describe("a wallet's account", () => {
	it("is its address, holds where its key is and no secret, and is on for no agent until the owner switches it on", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		expect((await s.capabilities.view()).shipped?.map((shipped) => shipped.name)).not.toContain(WALLET);
		await expect(s.capabilities.addShipped(WALLET)).rejects.toThrow(/Settings, Wallets/);
		const done = await s.capabilities.addWallet({
			account: `home/wallet/${ADDRESS}`,
			address: DEV0.address.toLowerCase(),
			network: "base-sepolia",
		});
		expect(done).toMatchObject({ account: KEY, id: ADDRESS, known: false });
		expect(await credentialsOf(s.home, WALLET, KEY)).toMatchObject({
			wallet: { account: `home/wallet/${ADDRESS}`, address: ADDRESS, network: "base-sepolia" },
		});
		// made, in the wallet's own words: the owner signed in to nothing
		const events = (await s.harness.snapshot(ActivityLog, context))?.events.map((event) => event.what) ?? [];
		expect(events).toContain(`You made the wallet ${walletLabel(ADDRESS, { name: "Groceries" })}`);
		expect(events.some((what) => what.includes("signed in"))).toBe(false);
		// listed with banda's own tools, and offered to nobody (OD-1)
		expect(s.offered()).toEqual(WALLET_TOOLS.map((tool) => `wallet__${tool.name}`));
		expect((await s.harness.snapshot(Connected, context))?.on?.[LEAD]?.[WALLET] ?? []).toEqual([]);
		expect(await s.toolsOf(LEAD)).toEqual([]);
		const refused = await s.call("wallet__address");
		expect(refused?.error).toBe(true);
		expect(await s.disclosed()).toBe(false);

		// a connection's own switch never reaches a wallet: only Settings, Wallets switches one on, once it is ready
		await expect(s.capabilities.switchConnectionAccount(LEAD, WALLET, KEY, true)).rejects.toMatchObject({
			status: 409,
			message: "a wallet is managed in Settings, Wallets",
		});
		expect(await s.toolsOf(LEAD)).toEqual([]);

		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		expect(await s.toolsOf(LEAD)).toEqual(["wallet__address", "wallet__balance"]);
		const groceries = walletLabel(ADDRESS, { name: "Groceries" });
		const lead = await s.harness.commit((tx) => agentWords(tx, LEAD), context);
		expect(await whats(s)).toContain(`You let ${lead} use the wallet ${groceries}`);
		expect(await s.call("wallet__address")).toEqual({
			text: `${ADDRESS} on Base Sepolia (chain id 84532).`,
			error: false,
		});
		// the read that gives the address out is logged, as the agent it was given to
		expect(await whats(s)).toContain(`Gave the address of ${groceries} to ${lead}`);
		expect((await whats(s)).some((what) => what.includes("sign-in") || what.includes(ADDRESS))).toBe(false);
		// the address left banda: the record says so, under a new version
		expect((await s.harness.snapshot(Wallets, context))?.wallets[ADDRESS]).toMatchObject({
			disclosed: true,
			version: 2,
		});

		// the same wallet made again is the same account, its switch kept, and made once in the log
		expect(await s.make(ADDRESS, "base-sepolia")).toMatchObject({ account: KEY, known: true });
		expect(await s.toolsOf(LEAD)).toEqual(["wallet__address", "wallet__balance"]);
		const again = (await s.harness.snapshot(ActivityLog, context))?.events ?? [];
		expect(again.filter((event) => event.what.startsWith("You made the wallet"))).toHaveLength(1);

		await s.capabilities.switchAccount(LEAD, WALLET, KEY, false);
		expect(await whats(s)).toContain(`You stopped ${lead} using the wallet ${groceries}`);
		expect(await s.toolsOf(LEAD)).toEqual([]);
		expect((await s.call("wallet__address"))?.error).toBe(true);
	});

	it("switched off while a turn runs: a call made with the turn's old tools is refused at admission (H-058)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		// the model asks for the address with the list its turn was given; the owner switches the wallet off before the
		// call runs
		s.meanwhile(() => s.capabilities.switchAccount(LEAD, WALLET, KEY, false));
		const before = await whats(s);
		const refused = await s.call("wallet__address");
		expect(Object.keys(s.offeredTo())).toContain("wallet__address");
		expect(refused?.error).toBe(true);
		expect(refused?.text).not.toContain(ADDRESS);
		// nothing was given out or read: no mark, no read logged, nothing asked of the network
		expect(await s.disclosed()).toBe(false);
		const logged = (await whats(s)).slice(before.length);
		expect(logged.some((what) => what.startsWith("Gave the address") || what.includes("balance"))).toBe(false);
		expect(rpcAsked).toBe(0);
		// the next turn is offered no wallet tool
		expect(await s.toolsOf(LEAD)).toEqual([]);
		expect((await s.call("wallet__balance"))?.error).toBe(true);
		expect(Object.keys(s.offeredTo()).filter((name) => name.startsWith("wallet__"))).toEqual([]);
	});

	it("made from what is not a whole wallet is refused in the owner's words, and nothing is kept", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await expect(
			s.capabilities.addWallet({ account: `home/wallet/${ADDRESS}`, address: ADDRESS, network: "mainnet" as never }),
		).rejects.toThrow(/^that is not a whole wallet$/);
		expect(await credentialsOf(s.home, WALLET, KEY)).toBeUndefined();
		const connected = await s.harness.snapshot(Connected, context);
		expect(connected?.accounts?.[WALLET]?.[KEY]).toBeUndefined();
		expect(connected?.added?.[WALLET]).toBeUndefined();
	});

	it("whose credentials are not the ones the store names is for the owner to look at, never a sign-in to redo", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		await s.harness.commit(async (tx) => {
			const account = (await tx.doc(Connected)).accounts?.[WALLET]?.[KEY];
			if (account === undefined) throw new Error("no wallet account");
			account.generation = "another";
		}, context);
		for (const tool of ["wallet__address", "wallet__balance"]) {
			const refused = await s.call(tool);
			expect(refused).toEqual({
				text: `${tool} did not run: banda's record of this wallet is incomplete: ask the owner to look at it in Settings, Wallets.`,
				error: true,
			});
			expect(refused?.text).not.toContain("sign");
		}
		expect(await s.disclosed()).toBe(false);
		expect((await whats(s)).some((what) => what.includes("balance") || what.startsWith("Gave"))).toBe(false);
	});

	it("is managed in Settings, Wallets: Connections lists no wallet, and its routes refuse it", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		expect((await s.capabilities.view()).connections.map((connection) => connection.name)).not.toContain(WALLET);
		for (const route of [
			() => s.capabilities.remove(WALLET),
			() => s.capabilities.disconnect(WALLET),
			() => s.capabilities.signOut(WALLET, KEY),
			() => s.capabilities.labelAccount(WALLET, KEY, "Mine"),
			() => s.capabilities.setTools(WALLET, { wallet__balance: "ask", wallet__address: "off" }, "any"),
		])
			await expect(route()).rejects.toMatchObject({ message: "a wallet is managed in Settings, Wallets", status: 409 });
		// nothing of it went: its account, its switch and its credentials stay
		expect((await s.harness.snapshot(Connected, context))?.accounts?.[WALLET]?.[KEY]).toBeDefined();
		expect(await s.toolsOf(LEAD)).toEqual(["wallet__address", "wallet__balance"]);
		expect(await credentialsOf(s.home, WALLET, KEY)).toBeDefined();
	});

	it.each([
		{ backup: "unsaved", answered: false },
		{ backup: "saved", answered: true },
		{ backup: "skipped", answered: true },
	] as const)(
		"an agent reads its address only after the key was saved or the step skipped: $backup",
		async ({ backup, answered }) => {
			const s = await open();
			await s.keep(record("base-sepolia", { backup }));
			await s.make(ADDRESS, "base-sepolia");
			await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
			for (const tool of ["wallet__address", "wallet__balance"])
				if (!answered)
					expect(await s.call(tool)).toEqual({
						text: `${tool} did not run: not ready: the owner has not saved the key yet.`,
						error: true,
					});
			if (answered)
				expect(await s.call("wallet__address")).toEqual({
					text: `${ADDRESS} on Base Sepolia (chain id 84532).`,
					error: false,
				});
			expect((await s.harness.snapshot(Wallets, context))?.wallets[ADDRESS]).toMatchObject({
				backup,
				disclosed: answered,
				version: answered ? 2 : 1,
			});
		},
	);

	it("an agent gives out no address of a wallet whose key was never saved until a key that opens it was found (H-021, H-261)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia", { backup: "skipped" }));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		s.signing.set(ADDRESS, undefined);
		expect(await s.call("wallet__address")).toEqual({
			text: "wallet__address did not run: banda has not checked this wallet's key yet: try again in a moment.",
			error: true,
		});
		for (const state of ["key_missing", "wrong_key"] as const) {
			s.signing.set(ADDRESS, { state });
			expect(await s.call("wallet__address")).toEqual({
				text: `wallet__address did not run: ${UNOPENABLE}.`,
				error: true,
			});
		}
		expect(await s.disclosed()).toBe(false);
		// a saved copy opens it anywhere: its address goes out whatever this computer's keychain holds
		s.signing.set(ADDRESS, { state: "key_missing" });
		await s.keep(record("base-sepolia", { backup: "saved" }));
		expect((await s.call("wallet__address"))?.error).toBe(false);
	});

	it.each(["creating", "removing"] as const)("a wallet still %s is not read", async (state) => {
		const s = await open();
		await s.keep(record("base-sepolia", { state }));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		expect(await s.call("wallet__address")).toEqual({
			text: "wallet__address did not run: this wallet is not ready.",
			error: true,
		});
		expect(await s.disclosed()).toBe(false);
	});

	it("an archived wallet's reads are refused; a restart lists its tools again, its switches kept", async () => {
		const s = await open();
		await s.keep(record("base-sepolia", { state: "archived" }));
		await s.capabilities.addWallet({ account: "a", address: ADDRESS, network: "base-sepolia" });
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		expect(await s.call("wallet__address")).toEqual({
			text: "wallet__address did not run: the owner archived this wallet.",
			error: true,
		});
		const version = (await s.harness.snapshot(Connected, context))?.connections[WALLET]?.version;
		opened.splice(opened.indexOf(s), 1);
		await s.close();
		const again = await open({ home: s.home });
		expect(again.offered()).toEqual(["wallet__address", "wallet__balance"]);
		expect((await again.harness.snapshot(Connected, context))?.connections[WALLET]?.version).toBe(version);
		expect(await again.toolsOf(LEAD)).toEqual(["wallet__address", "wallet__balance"]);
	});

	it("credentials that name another network than the record's are not this wallet's", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		const refused = await s.call("wallet__address");
		expect(refused).toEqual({
			text: "wallet__address did not run: banda's record of this wallet is incomplete: ask the owner to look at it in Settings, Wallets.",
			error: true,
		});
		expect(refused?.text).not.toContain("sign");
		expect(await s.disclosed()).toBe(false);
	});

	it("credentials that mark a wallet but are not whole are the same refusal, never a crash", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		const kept = (await credentialsOf(s.home, WALLET, KEY)) as { generation?: string };
		for (const wallet of [
			null,
			{},
			{ account: `home/wallet/${ADDRESS}`, address: ADDRESS, network: "mainnet" },
			{ account: `home/wallet/${ADDRESS}`, address: misChecksummed(ADDRESS), network: "base-sepolia" },
			{ account: `home/wallet/${ADDRESS}`, address: ADDRESS.toLowerCase(), network: "base-sepolia" },
		]) {
			await keepCredentials(s.home, WALLET, KEY, { wallet, generation: kept.generation } as never);
			const refused = await s.call("wallet__address");
			expect(refused).toEqual({
				text: "wallet__address did not run: banda's record of this wallet is incomplete: ask the owner to look at it in Settings, Wallets.",
				error: true,
			});
		}
		expect(await s.disclosed()).toBe(false);
	});
});

describe("a wallet is offline for agents", () => {
	it("in host mode, where agents' commands run on this computer (H-064)", async () => {
		const s = await open({ host: true });
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		for (const tool of ["wallet__address", "wallet__balance"])
			expect(await s.call(tool)).toEqual({
				text: `${tool} did not run: wallets are offline for agents: agents run commands on this computer.`,
				error: true,
			});
		expect(await s.disclosed()).toBe(false);
	});

	it("while a coding agent is connected on this computer, and online again once it is not (H-065)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		await s.harness.commit(async (tx) => {
			(await tx.doc(Harnesses)).accounts.pi = { folder: s.home, agents: [] };
		}, context);
		expect(await s.call("wallet__address")).toEqual({
			text: "wallet__address did not run: wallets are offline for agents: a coding agent on this computer could read the keys.",
			error: true,
		});
		expect(await s.disclosed()).toBe(false);
		await s.harness.commit(async (tx) => {
			delete (await tx.doc(Harnesses)).accounts.pi;
		}, context);
		expect((await s.call("wallet__address"))?.error).toBe(false);
	});

	it("while code runs at its address, or banda could not check, and gives the address out to no one (H-157)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		// an EIP-7702 delegation made outside banda
		shipped = { code: `0xef0100${"11".repeat(20)}` };
		for (const tool of ["wallet__address", "wallet__balance"])
			expect(await s.call(tool)).toEqual({
				text: `${tool} did not run: the wallet's address now runs code that banda did not put there: ask the owner to look at it in Settings, Wallets.`,
				error: true,
			});
		// the chain was asked about the address, so the refused balance is in the activity, as a read (UC-06)
		const refused = (await s.harness.snapshot(ActivityLog, context))?.events.filter((e) => e.what.includes("balance"));
		expect(refused?.map((event) => [event.what.startsWith("Could not read the balance of "), event.outside])).toEqual([
			[true, "read"],
		]);
		shipped = "down";
		expect(await s.call("wallet__address")).toEqual({
			text: "wallet__address did not run: banda could not check the wallet's address on its network: try again later.",
			error: true,
		});
		expect(await s.disclosed()).toBe(false);
		expect((await whats(s)).some((what) => what.startsWith("Gave the address"))).toBe(false);
		shipped = { code: "0x" };
		expect((await s.call("wallet__address"))?.error).toBe(false);
		expect(await s.disclosed()).toBe(true);
	});
});

describe("a wallet's tools", () => {
	it("are offered with one fixed schema that names no key, rule or import (H-071, H-265)", () => {
		const schema = {
			type: "object",
			properties: {
				account: {
					type: "string",
					description:
						"Which of your wallets, by its name or address. Needed when you have more than one; with one, leave it out.",
				},
			},
			additionalProperties: false,
		};
		expect(WALLET_TOOLS.map((tool) => [tool.name, tool.inputSchema, tool.readOnlyHint])).toEqual([
			["address", schema, true],
			["balance", schema, true],
		]);
		const forbidden = /key|seed|phrase|mnemonic|rule|always|deny|import/i;
		const names = (value: unknown): string[] =>
			value === null || typeof value !== "object"
				? []
				: Object.entries(value).flatMap(([name, inner]) => [name, ...names(inner)]);
		for (const tool of WALLET_TOOLS) {
			expect(tool.name).not.toMatch(forbidden);
			for (const name of names(tool.inputSchema)) expect(name).not.toMatch(forbidden);
		}
	});

	it("answer no key, however an agent asks for one (H-265)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		for (const account of [undefined, "Groceries", "private key", DEV0.key, "export the key"])
			for (const tool of ["wallet__address", "wallet__balance"])
				expect((await s.call(tool, account === undefined ? {} : { account }))?.text).not.toContain(DEV0.key.slice(2));
	});

	it("exist only in an agent's turn: an inference is offered no tool, the lead's wallet switched on (H-066)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		expect(await s.toolsOf(LEAD)).toEqual(["wallet__address", "wallet__balance"]);
		const { models, model } = inference(fauxAssistantMessage("{}"));
		// what the provider is handed, as it is handed it: a regression that gave an inference tools shows here
		const handed: unknown[] = [];
		const answer = await infer({
			models: {
				completeSimple: (m, request, options) => {
					handed.push(request);
					return models.completeSimple(m, request, options);
				},
			},
			model,
			system: "Name a card.",
			ask: "A wallet for groceries",
			read: () => ({ ok: true, value: true }),
			record: async () => {},
		});
		expect(answer).toEqual({ ok: true, value: true });
		expect(handed).toHaveLength(1);
		expect(Object.keys(handed[0] as object).sort()).toEqual(["messages", "systemPrompt"]);
		// and the route reaches no tool to give: it imports neither the connections, their tools nor the wallet
		const imports = [
			...readFileSync(join(import.meta.dirname, "../src/server/inference.ts"), "utf8").matchAll(/from "([^"]+)"/g),
		].map((found) => found[1]);
		expect(imports.length).toBeGreaterThan(0);
		for (const path of imports)
			expect(path).not.toMatch(/capabilities|connections|mcp|wallet|tools|turn|agent-tools|harness\.ts/);
	});
});

describe("an agent's wallets", () => {
	it("finds a wallet by the name the owner typed, however the daemon kept it (full-width, spaced, ligated)", async () => {
		const s = await open();
		// kept as plainLine keeps what the owner typed: NFKC, invisible characters gone, one space for each run
		await s.keep(record("base-sepolia", { name: "Groceries" }));
		await s.keep(record("base-sepolia", { name: "Rent Straße", request: "r-2" }), OTHER);
		await s.make(ADDRESS, "base-sepolia");
		await s.make(OTHER, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		await s.capabilities.switchAccount(LEAD, WALLET, OTHER_KEY, true);
		for (const typed of ["Ｇroceries", "groceries", " Groceries\u200b"])
			expect((await s.call("wallet__address", { account: typed }))?.text, typed).toContain(ADDRESS);
		// the case fully folded, as every title the owner reads as the same is (`foldKey`): ß and SS are one
		for (const typed of ["Rent  Straße", "rent\u00a0straße", "RENT STRASSE"])
			expect((await s.call("wallet__address", { account: typed }))?.text, typed).toContain(OTHER);
		expect((await s.call("wallet__address", { account: "RentStraße" }))?.error).toBe(true);
	});

	it("are its own: another agent's are never offered, named or read, and a call says which of its own (H-071, H-072)", async () => {
		const s = await open();
		await s.addMara();
		await s.keep(record("base-sepolia"));
		await s.keep(record("base-sepolia", { name: "Rent", request: "r-2" }), OTHER);
		await s.make(ADDRESS, "base-sepolia");
		await s.make(OTHER, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		await s.capabilities.switchAccount(LEAD, WALLET, OTHER_KEY, true);

		// Mara has no wallet: the model is offered no wallet tool for her, though the lead has two
		expect(await s.toolsOf(MARA, [WALLET])).toEqual([]);
		expect((await s.call("wallet__address", {}, MARA))?.error).toBe(true);
		const offered = Object.keys(s.offeredTo());
		expect(offered).toContain("message_user");
		expect(offered.some((name) => name.startsWith("wallet__"))).toBe(false);

		await s.capabilities.switchAccount(MARA, WALLET, KEY, true);
		expect(await s.toolsOf(MARA, [WALLET])).toEqual(["wallet__address", "wallet__balance"]);
		expect(await s.call("wallet__address", {}, MARA)).toEqual({
			text: `${ADDRESS} on Base Sepolia (chain id 84532).`,
			error: false,
		});
		const maras = s.offeredTo();
		const rent = walletLabel(OTHER, { name: "Rent" });
		// the lead's other wallet is not hers to name or read
		const refused = await s.call("wallet__address", { account: "Rent" }, MARA);
		expect(refused).toEqual({
			text: `wallet__address did not run: that is not a wallet you may use: ${walletLabel(ADDRESS, { name: "Groceries" })}.`,
			error: true,
		});
		expect(await s.disclosed(OTHER)).toBe(false);

		// the lead has two: it says which, from its own, by name or address
		const groceries = walletLabel(ADDRESS, { name: "Groceries" });
		expect(await s.call("wallet__address")).toEqual({
			text: `wallet__address did not run: say which wallet, in "account": ${rent} or ${groceries}.`,
			error: true,
		});
		const leads = s.offeredTo();
		expect(await s.call("wallet__address", { account: "rent" })).toEqual({
			text: `${OTHER} on Base Sepolia (chain id 84532).`,
			error: false,
		});
		expect((await s.call("wallet__address", { account: ADDRESS.toLowerCase() }))?.text).toContain(ADDRESS);
		expect((await s.call("wallet__address", { account: "Savings" }))?.text).toBe(
			`wallet__address did not run: that is not a wallet you may use: ${rent}, ${groceries}.`,
		);

		// both agents' first steps offer the same wallet schemas, which name no wallet of the home
		for (const tool of ["wallet__address", "wallet__balance"]) {
			expect(maras[tool]).toEqual(leads[tool]);
			const said = JSON.stringify(leads[tool]);
			for (const word of ["Groceries", "Rent", ADDRESS, OTHER, ADDRESS.toLowerCase(), OTHER.toLowerCase()])
				expect(said).not.toContain(word);
		}
	});

	it("refuse a call that names none of several, offering only the ones a read can run on (H-057)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.keep(record("base-sepolia", { name: "Rent", request: "r-2", backup: "unsaved" }), OTHER);
		await s.make(ADDRESS, "base-sepolia");
		await s.make(OTHER, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		await s.capabilities.switchAccount(LEAD, WALLET, OTHER_KEY, true);
		// two wallets on, one unnamed: refused with the one a read can run on, never picked for the agent (H-057), so the
		// same call does not read another wallet once Rent's key is saved
		expect(await s.call("wallet__address")).toEqual({
			text: `wallet__address did not run: say which wallet, in "account": ${walletLabel(ADDRESS, { name: "Groceries" })}.`,
			error: true,
		});
		expect(await s.disclosed(ADDRESS)).toBe(false);
		expect((await s.call("wallet__address", { account: "Savings" }))?.text).toBe(
			`wallet__address did not run: that is not a wallet you may use: ${walletLabel(ADDRESS, { name: "Groceries" })}.`,
		);
		await s.harness.commit(async (tx) => {
			const groceries = (await tx.doc(Wallets)).wallets[ADDRESS];
			if (groceries !== undefined) groceries.state = "archived";
		}, context);
		expect(await s.call("wallet__address")).toEqual({
			text: 'wallet__address did not run: say which wallet, in "account": none of your wallets can be read now.',
			error: true,
		});
		expect(await s.disclosed(OTHER)).toBe(false);
	});
});

describe("an address given out (C21)", () => {
	it("is not given while its disclosure is not on disk, and the disclosure stays made", async () => {
		let failing = true;
		let barriers = 0;
		const s = await open({
			// the call's first barrier, before the network is asked, passes; the one after the disclosure fails
			sync: async () => {
				barriers++;
				if (failing && barriers % 2 === 0) throw new Error("the disk refused");
			},
		});
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		const refused = await s.call("wallet__address");
		expect(refused).toEqual({
			text: "wallet__address did not run: banda could not record that the address was given out: try again.",
			error: true,
		});
		expect(refused?.text).not.toContain(ADDRESS);
		expect(refused?.text).not.toContain(ADDRESS.toLowerCase());
		expect(await s.disclosed()).toBe(true);
		failing = false;
		expect(await s.call("wallet__address")).toEqual({
			text: `${ADDRESS} on Base Sepolia (chain id 84532).`,
			error: false,
		});
	});
});

describe("a wallet's read after a commit that is not yet safe (C21)", () => {
	it.each(["wallet__balance", "wallet__address"])(
		"%s is refused and asks the network nothing while the switch that let it run is not on disk",
		async (tool) => {
			let failing = true;
			const s = await open({
				sync: async () => {
					if (failing) throw new Error("the disk refused");
				},
			});
			await s.keep(record("base-sepolia"));
			await s.make(ADDRESS, "base-sepolia");
			// the switch on lands, and its barrier fails: the owner was told it is not yet safe
			await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
			rpcAsked = 0;
			expect(await s.call(tool)).toEqual({
				text: `${tool} did not run: banda could not yet make the wallet's settings safe on disk: try again.`,
				error: true,
			});
			expect(rpcAsked).toBe(0);
			expect(await s.disclosed()).toBe(false);
			expect((await whats(s)).filter((what) => what.includes("balance") || what.startsWith("Gave"))).toEqual([]);
			// once the disk takes it, the read goes on to the network
			failing = false;
			await s.call(tool);
			expect(rpcAsked).toBeGreaterThan(0);
		},
	);
});

describe("a wallet's balance", () => {
	it("whose RPC settings cannot be read says so in fixed words, quoting nothing of them (H-195)", async () => {
		const s = await open();
		await s.keep(record("base-sepolia"));
		await s.make(ADDRESS, "base-sepolia");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		writeFileSync(
			join(s.home, "config.json"),
			'{"wallets":{"rpc":{"base-sepolia":https://rpc.example/v1/k3y-s3cr3t}}}',
		);
		const unread = await s.call("wallet__balance");
		expect(unread).toEqual({
			text: `${walletLabel(ADDRESS, { name: "Groceries" })}: the balance on Base Sepolia is unknown: the network's RPC settings could not be read.`,
			error: true,
		});
		// an RPC the owner set that banda refuses is said by the field, never its value
		writeFileSync(
			join(s.home, "config.json"),
			JSON.stringify({ wallets: { rpc: { "base-sepolia": "https://10.1.2.3/k3y-s3cr3t" } } }),
		);
		const refused = await s.call("wallet__balance");
		expect(refused?.error).toBe(true);
		expect(refused?.text).toContain("config.json's wallets.rpc.base-sepolia names a private address");
		for (const answer of [unread, refused])
			for (const word of ["rpc.example", "k3y", "s3cr3t", "10.1.2.3", s.home]) expect(answer?.text).not.toContain(word);
		// settings that could not be read asked the chain nothing: no read of it is logged, failed or not
		expect((await whats(s)).filter((what) => what.includes("balance"))).toEqual([]);
	});
});

describe.skipIf(!hasAnvil())(hasAnvil() ? "a wallet's balance on a chain" : NO_ANVIL, () => {
	it("is read from the chain at one block; a chain that cannot be read says unknown, never 0", async () => {
		vi.stubEnv("BANDA_TEST_CHAIN", "1");
		const chain = await startAnvil(["--chain-id", "31337"]);
		chains.push(chain);
		await chain.raw("anvil_setBalance", [ADDRESS, "0x14d1120d7b160000"]);
		const s = await open();
		writeFileSync(join(s.home, "config.json"), JSON.stringify({ wallets: { rpc: { anvil: chain.url } } }));
		await s.keep(record("anvil"));
		await s.capabilities.addWallet({ account: "a", address: ADDRESS, network: "anvil" });
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		const read = await s.call("wallet__balance");
		expect(read?.error).toBe(false);
		const groceries = walletLabel(ADDRESS, { name: "Groceries" });
		// the answer names the wallet it read, by its name and short address (H-041)
		expect(read?.text.startsWith(`${groceries}, on Local chain, at block 0 (`)).toBe(true);
		expect(read?.text).toMatch(/, at block 0 \(\d{4}-\d\d-\d\dT[^)]+\):\nETH: 1\.5$/);
		await chain.stop();
		const unread = await s.call("wallet__balance");
		expect(unread).toEqual({
			text: `${groceries}: the balance on Local chain is unknown: the network's RPC could not be reached.`,
			error: true,
		});
		const log = (await s.harness.snapshot(ActivityLog, context))?.events.filter((e) => e.what.includes("balance"));
		expect(log?.map((event) => [event.what, event.outside])).toEqual([
			[`Read the balance of ${groceries}`, "read"],
			[`Could not read the balance of ${groceries}`, "read"],
		]);
		expect(unread?.text).not.toContain(chain.url);
	});

	it("refuses to read or hand out a wallet through an RPC of another chain (H-187)", async () => {
		vi.stubEnv("BANDA_TEST_CHAIN", "1");
		// an RPC of another chain set for the wallet's network: Local chain is 31337, this node serves 1
		const chain = await startAnvil(["--chain-id", "1"]);
		chains.push(chain);
		await chain.raw("anvil_setBalance", [ADDRESS, "0x14d1120d7b160000"]);
		const s = await open();
		writeFileSync(join(s.home, "config.json"), JSON.stringify({ wallets: { rpc: { anvil: chain.url } } }));
		await s.keep(record("anvil"));
		await s.capabilities.addWallet({ account: "a", address: ADDRESS, network: "anvil" });
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		const groceries = walletLabel(ADDRESS, { name: "Groceries" });
		expect(await s.call("wallet__balance")).toEqual({
			text: `${groceries}: the balance on Local chain is unknown: the network's RPC serves another chain.`,
			error: true,
		});
		const address = await s.call("wallet__address");
		expect(address?.error).toBe(true);
		expect(address?.text).not.toContain(ADDRESS);
		expect(await s.disclosed()).toBe(false);
	});

	it("on a network with USDC reads USDC first, and says it unknown while the ETH it read stands", async () => {
		vi.stubEnv("BANDA_TEST_CHAIN", "1");
		const usdc = networkOf("anvil-usdc")?.usdc?.address as string;
		const chain = await startAnvil(["--chain-id", "84532"]);
		chains.push(chain);
		await chain.raw("anvil_setBalance", [ADDRESS, "0x14d1120d7b160000"]);
		// a stand-in token whose every call answers 1500000 base units: 1.5 USDC
		await chain.raw("anvil_setCode", [usdc, "0x6216e36060005260206000f3"]);
		const s = await open();
		writeFileSync(join(s.home, "config.json"), JSON.stringify({ wallets: { rpc: { "anvil-usdc": chain.url } } }));
		await s.keep(record("anvil-usdc"));
		await s.make(ADDRESS, "anvil-usdc");
		await s.capabilities.switchAccount(LEAD, WALLET, KEY, true);
		const read = await s.call("wallet__balance");
		expect(read?.error).toBe(false);
		expect(read?.text).toMatch(
			/^Groceries \(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\), on Local chain with USDC, at block 0 \([^)]+\):\nUSDC: 1\.5\nETH: 1\.5$/,
		);
		// a token that reverts every call: its amount is unknown, never 0, and the ETH read stands
		await chain.raw("anvil_setCode", [usdc, "0x60006000fd"]);
		const partly = await s.call("wallet__balance");
		expect(partly?.error).toBe(false);
		expect(partly?.text).toMatch(/\nUSDC: unknown \([^)]+\)\nETH: 1\.5$/);
		expect(partly?.text).not.toContain("USDC: 0");
		expect(partly?.text).not.toContain(chain.url);
	});
});
