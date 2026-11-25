/**
 * The tools an agent is offered for the wallets the owner switched on for it (docs/wallets.md "Tools the agent gets"):
 * the fixed list the wallet connection is listed with, banda's own words, and the reads, which answer from the store
 * and the wallet's network. They come through the connection like any other, so an agent with no wallet switched on is
 * offered none (H-056, H-066); which wallet a call reads is resolved in the commit that lets it run, against the
 * agent's accounts of the connection now.
 */
import { defineTool, type JsonObject, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { log } from "../core/activity.ts";
import { agentWords } from "../core/agents.ts";
import type { InEffect, WalletCredentials } from "../core/connections.ts";
import { Harnesses } from "../core/harness.ts";
import type { McpTool } from "../core/mcp.ts";
import { checksummed } from "./address.ts";
import { RpcSettingsError } from "./config.ts";
import { Wallets } from "./docs.ts";
import { nameKey, units, walletLabel } from "./label.ts";
import type { Signing } from "./lifecycle.ts";
import { type Network, networkOf } from "./networks.ts";
import { codeAt, type Rpc, RpcError, type RpcFailure, tokenBalance } from "./rpc.ts";

/**
 * The schema the model is offered for every read, the same for every agent: an optional `account` that names none of
 * the home's wallets, so no agent's prompt carries another's (H-071) and a new wallet changes no prompt (H-072). The
 * agent's own wallets are named in the refusal that asks it to choose.
 */
const WALLET_SCHEMA = {
	type: "object",
	properties: {
		account: {
			type: "string",
			description:
				"Which of your wallets, by its name or address. Needed when you have more than one; with one, leave it out.",
		},
	},
	additionalProperties: false,
} as const;

/** What the wallet connection is listed with: its tools by their names on the connection (`wallet__<name>`). */
export const WALLET_TOOLS: readonly McpTool[] = [
	{
		name: "address",
		description:
			"Your wallet's address and the network it is on: what to give someone who will pay into it. It only reads.",
		inputSchema: WALLET_SCHEMA,
		readOnlyHint: true,
	},
	{
		name: "balance",
		description:
			"What your wallet holds now, read from its network: USDC first, then the network's own ETH, with the block and " +
			"time they were read at. An amount that could not be read says unknown, never 0. It only reads.",
		inputSchema: WALLET_SCHEMA,
		readOnlyHint: true,
	},
];

/** Why no address is given out of a wallet no key on this computer opens, its key never saved (H-021, H-261). */
export const UNOPENABLE =
	"no key on this computer opens this wallet and its key was never saved, so nothing sent to it could be spent: ask the owner to look at it in Settings, Wallets";

/** The refusal when what banda holds of a wallet disagrees with itself: for the owner to look at, never a sign-in. */
export const WALLET_INCOMPLETE =
	"banda's record of this wallet is incomplete: ask the owner to look at it in Settings, Wallets";

/**
 * Which of `keys` (the agent's wallet accounts now, each an address's `accountKey`) a call reads: the one it names by
 * its name, label or address, or its only one; with several, one it does not name is refused (H-057). A refusal names
 * only these, and of them only those a read can run on. Reads only.
 */
export async function chooseWallet(
	tx: Tx,
	keys: readonly string[],
	asked: unknown,
): Promise<{ readonly key: string } | { readonly refused: string }> {
	const wallets = (await tx.doc(Wallets)).wallets;
	const mine = keys.map((key) => {
		const address = checksummed(key);
		return { key, address, record: wallets[address], label: walletLabel(address, wallets[address]) };
	});
	// a refusal offers only wallets a read can run on: one archived, not made yet or not saved would be refused in turn
	const usable = mine.filter(({ record }) => record?.state === "ready" && record.backup !== "unsaved");
	const labels = usable.map((wallet) => wallet.label);
	const choose = labels.length === 0 ? "none of your wallets can be read now" : labels.join(" or ");
	if (mine.length === 0) return { refused: "the owner has not switched a wallet on for you" };
	if (asked === undefined || asked === null || asked === "") {
		// only an agent with one wallet is read without naming it: one picked from several, because the others cannot be
		// read now, would change with them, and a send would spend from a wallet the agent never named (H-057, UC-05)
		const [only] = mine;
		if (mine.length === 1 && only !== undefined) return { key: only.key };
		return { refused: `say which wallet, in "account": ${choose}` };
	}
	if (typeof asked !== "string") return { refused: "account is the name of one of your wallets" };
	const typed = asked.normalize("NFC").trim().toLowerCase();
	// a name is compared as the daemon keeps it (`nameKey`): the name the owner typed finds the wallet however it came
	const word = nameKey(asked);
	const found = mine.filter(
		(wallet) =>
			wallet.address.toLowerCase() === typed ||
			wallet.label.toLowerCase() === typed ||
			(wallet.record !== undefined && word !== "" && nameKey(wallet.record.name) === word),
	);
	if (found.length === 1) return { key: (found[0] as (typeof mine)[number]).key };
	if (found.length > 1) return { refused: `more than one of your wallets is called that: ${choose}` };
	return { refused: `that is not a wallet you may use: ${labels.length === 0 ? choose : labels.join(", ")}` };
}

/**
 * Why wallets are offline for every agent, as a fixed word for a client to branch on: `host_mode` (H-064) or
 * `coding_agent` (H-065).
 */
export type OfflineCode = "host_mode" | "coding_agent";

/** What an agent is told for each `OfflineCode`. */
const OFFLINE_WORDS: { readonly [code in OfflineCode]: string } = {
	host_mode: "wallets are offline for agents: agents run commands on this computer",
	coding_agent: "wallets are offline for agents: a coding agent on this computer could read the keys",
};

/**
 * What an agent is told of why wallets are offline for every agent now (`offlineCode` in words), or nothing. Reads
 * only.
 */
export async function offlineWords(tx: Tx, host: boolean): Promise<string | undefined> {
	const code = await offlineCode(tx, host);
	return code === undefined ? undefined : OFFLINE_WORDS[code];
}

/**
 * Why wallets are offline for every agent now, or nothing: in host mode an agent's command runs as the owner, who can
 * read the keychain (H-064); so can a coding agent connected on this computer, whatever its mode, since no mode proves
 * it asks the owner before each command (H-065, until OD-11 ships). The owner's own acts are not agents' and stay.
 * Reads only.
 */
export async function offlineCode(tx: Tx, host: boolean): Promise<OfflineCode | undefined> {
	if (host) return "host_mode";
	if (Object.keys((await tx.doc(Harnesses)).accounts).length > 0) return "coding_agent";
	return undefined;
}

type ReadAnswer = { readonly text: string; readonly isError: boolean };

const FAILURE: { readonly [kind in RpcFailure]: string } = {
	rpc: "the network's RPC refused the read",
	limited: "the network's RPC is limiting requests for now",
	http: "the network's RPC answered with an error",
	transport: "the network's RPC could not be reached",
	timeout: "the network's RPC did not answer in time",
	shape: "the network's RPC answered something that is not a balance",
	chain: "the network's RPC serves another chain",
};

/** Why a read failed, in words that name no RPC and none of its keys (H-195). */
const why = (error: unknown): string => (error instanceof RpcError ? FAILURE[error.kind] : "it could not be read");

const addressAnswer = (address: string, network: Network): ReadAnswer => ({
	text: `${checksummed(address)} on ${network.label} (chain id ${network.chainId}).`,
	isError: false,
});

/**
 * What `address` holds on `network`, read at one block, led by the wallet's `label` (its name and short address, H-041):
 * each amount the chain gave, and each it did not as unknown with why. An error only when nothing could be read; `asked` false when the chain was never asked, its RPC settings
 * unreadable.
 */
async function balanceAnswer(
	address: string,
	label: string,
	network: Network,
	rpc: () => Promise<Rpc>,
): Promise<ReadAnswer & { readonly asked: boolean }> {
	let client: Rpc;
	let block: { readonly number: bigint; readonly timestamp: bigint } | null;
	try {
		client = await rpc();
	} catch (error) {
		const reason = error instanceof RpcSettingsError ? error.message : "the network's RPC settings could not be read";
		return { text: `${label}: the balance on ${network.label} is unknown: ${reason}.`, isError: true, asked: false };
	}
	try {
		block = await client.getBlock("latest");
		if (block === null) throw new Error("no block");
	} catch (error) {
		return { text: `${label}: the balance on ${network.label} is unknown: ${why(error)}.`, isError: true, asked: true };
	}
	const { number } = block;
	const lines: string[] = [];
	let read = 0;
	if (network.usdc !== undefined)
		try {
			lines.push(
				`USDC: ${units(await tokenBalance(client, network.usdc.address, address, number), network.usdc.decimals)}`,
			);
			read++;
		} catch (error) {
			lines.push(`USDC: unknown (${why(error)})`);
		}
	try {
		lines.push(`ETH: ${units(await client.balance(address, number), 18)}`);
		read++;
	} catch (error) {
		lines.push(`ETH: unknown (${why(error)})`);
	}
	const at = new Date(Number(block.timestamp) * 1000).toISOString();
	return {
		text: `${label}, on ${network.label}, at block ${number} (${at}):\n${lines.join("\n")}`,
		isError: read === 0,
		asked: true,
	};
}

const CODE_WORDS = {
	code: "the wallet's address now runs code that banda did not put there: ask the owner to look at it in Settings, Wallets",
	unchecked: "banda could not check the wallet's address on its network: try again later",
} as const;

type WalletReadDeps = {
	/**
	 * In the commit that lets the call run: the account (a wallet's `accountKey`) it reads, the agent reading it and what
	 * its credentials say of it, or why it may not run.
	 */
	readonly resolve: (
		tx: Tx,
		args: JsonObject,
		chat: number,
	) => Promise<
		| { readonly account: string; readonly agent: string; readonly wallet: WalletCredentials["wallet"] }
		| { readonly refused: string }
	>;
	/** The client for `network`'s RPC, as `config.json` sets it now. */
	readonly rpc: (network: Network) => Promise<Rpc>;
	/** Makes the commits made so far survive power loss (C21): run before an address or a read leaves banda. */
	readonly sync: () => Promise<void>;
	readonly now: () => number;
	/**
	 * How the wallet's key was last found (the wallets' area's check), `undefined` for not checked yet, or `"unchecked"`
	 * where nothing checks keys (no wallets' area): the address of a wallet whose key was never saved is handed out only
	 * once a check found a key that opens it (H-021, H-261). Left out, nothing is asked (a test of the reads alone).
	 */
	readonly signing?: (address: string) => Signing | "unchecked" | undefined;
};

/** One of the wallet's reads, as the model is offered it. */
export function walletReadTool(tool: InEffect, deps: WalletReadDeps): ToolRegistration {
	/** The wallet a call reads, or why it may not run: decided again in every commit that acts on it. */
	const usable = async (tx: Tx, args: JsonObject, chat: number) => {
		const resolved = await deps.resolve(tx, args, chat);
		if ("refused" in resolved) return resolved;
		const wallets = await tx.doc(Wallets);
		const address = checksummed(resolved.account);
		const record = wallets.wallets[address];
		if (record === undefined || record.state === "creating" || record.state === "removing")
			return { refused: "this wallet is not ready" };
		if (record.state === "archived") return { refused: "the owner archived this wallet" };
		// an address handed out before the key is saved could be paid into a key nobody can bring back (H-005)
		if (record.backup === "unsaved") return { refused: "not ready: the owner has not saved the key yet" };
		// the credentials name what the key must prove; ones that disagree with the record are not this wallet's
		if (checksummed(resolved.wallet.address) !== address || resolved.wallet.network !== record.network)
			return { refused: WALLET_INCOMPLETE };
		const network = networkOf(record.network);
		if (network === undefined) return { refused: "this build does not offer the wallet's network" };
		// a key never saved, and none on this computer that opens it: nothing sent to its address could ever leave
		if (tool.tool === "address" && deps.signing !== undefined && record.backup !== "saved") {
			const signing = deps.signing(address);
			if (signing === undefined || signing === "unchecked")
				return { refused: "banda has not checked this wallet's key yet: try again in a moment" };
			if (signing.state === "key_missing" || signing.state === "wrong_key") return { refused: UNOPENABLE };
		}
		return { address, network, label: walletLabel(address, record), record, agent: resolved.agent };
	};
	return defineTool({
		name: tool.name,
		description: `${tool.listed.description}\n\n(A wallet the owner keeps in banda and switched on for you.)`,
		parameters: tool.listed.schema as never,
		replay: "safe",
		execute: async (args, api, ctx) => {
			const chat = Number(api.conversationId);
			const given = (args ?? {}) as JsonObject;
			const refuse = (why: string) => ({
				output: [{ type: "text" as const, text: `${tool.name} did not run: ${why}.` }],
				isError: true,
			});
			const found = await api.commit(async (tx) => {
				const wallet = await usable(tx, given, chat);
				if ("refused" in wallet) return wallet;
				return { address: wallet.address, network: wallet.network, label: wallet.label };
			}, ctx);
			if ("refused" in found) return refuse(found.refused);
			// commits answered to the owner as not yet safe (a switch on, an unarchive) are not acted on until they are: every
			// read below sends the address to the network, and its answer goes to the model (C21)
			try {
				await deps.sync();
			} catch {
				return refuse("banda could not yet make the wallet's settings safe on disk: try again");
			}
			// code at the address is a delegation made outside banda: no read of it goes on, and the address is not handed
			// out where banda could not check (H-157); a balance that could not be checked could not be read either
			const code = await codeAt(found.address, found.network, deps.rpc);
			// the chain was asked about the address even when the read stops here: a refused balance is still logged (UC-06)
			const logBalance = (isError: boolean) =>
				api.commit(async (tx) => {
					await log(tx, {
						at: deps.now(),
						what: `${isError ? "Could not read" : "Read"} the balance of ${found.label}`,
						chat,
						outside: "read",
					});
				}, ctx);
			if (code === "code" || (code === "unchecked" && tool.tool === "address")) {
				if (code === "code" && tool.tool === "balance") await logBalance(true);
				return refuse(CODE_WORDS[code]);
			}
			if (tool.tool === "address") {
				const disclosed = await api.commit(async (tx) => {
					const wallet = await usable(tx, given, chat);
					if ("refused" in wallet) return wallet;
					// the address leaves banda: from now on it may be paid into, which removal weighs (C17)
					if (!wallet.record.disclosed) {
						wallet.record.disclosed = true;
						wallet.record.version++;
					}
					const who = await agentWords(tx, wallet.agent);
					await log(tx, { at: deps.now(), what: `Gave the address of ${wallet.label} to ${who}`, chat });
					return undefined;
				}, ctx);
				if (disclosed !== undefined) return refuse(disclosed.refused);
				// the mark that bars removing an unsaved key survives a power cut before the address is out (C21)
				try {
					await deps.sync();
				} catch {
					return refuse("banda could not record that the address was given out: try again");
				}
				const answer = addressAnswer(found.address, found.network);
				return { output: [{ type: "text", text: answer.text }] };
			}
			const answer =
				tool.tool === "balance"
					? await balanceAnswer(found.address, found.label, found.network, () => deps.rpc(found.network))
					: { text: `${tool.name} is not a tool this build has.`, isError: true, asked: false };
			// logged once the chain was asked: settings that could not be read asked nothing of it
			if (answer.asked) await logBalance(answer.isError === true);
			return { output: [{ type: "text", text: answer.text }], ...(answer.isError ? { isError: true } : {}) };
		},
	});
}
