/**
 * A chain the test writes, served as a JSON-RPC `fetch` for `rpcClients`: each address's balance and nonce from a
 * block on, code, token balances, `Transfer` logs and the heads, and what a public RPC does on top (a narrow log
 * range, pruned state, no `finalized`, a failure the test injects). Block `n`'s time is 1_700_000_000 + n seconds.
 */
import { randomBytes } from "node:crypto";
import { TRANSFER, topicOf } from "../../src/wallet/indexer.ts";

export const GENESIS = 1_700_000_000;

export const hex = (n: number | bigint) => `0x${n.toString(16)}`;
export const word = (value: string | bigint) =>
	(typeof value === "bigint" ? value.toString(16) : value.slice(2).toLowerCase()).padStart(64, "0");

export class FauxChain {
	chainId: number;
	head = 0;
	/** The finalized head; undefined when the RPC has none set. */
	final: number | undefined = 0;
	/** The widest `eth_getLogs` range the RPC serves, as sepolia.base.org's 200. */
	maxRange = Number.POSITIVE_INFINITY;
	/** Blocks below which the RPC serves no state, as a pruned node. */
	stateFrom = 0;
	/** How the RPC says it keeps no state at a block: geth's hash-based wording unless a test names another node's. */
	prunedWords: (block: number) => string = () => `missing trie node ${"ab".repeat(32)} (path )`;
	readonly calls: { method: string; params: unknown[] }[] = [];
	readonly logs: Record<string, unknown>[] = [];
	/** Code at an address, lowercase, at every block. */
	readonly code = new Map<string, string>();
	/** Code at an address, lowercase, by block, for code that came and went; `code` decides where it says nothing. */
	codeAt?: (address: string, block: number) => string | undefined;
	/** The pinned token's balance of an address, lowercase, at every block. */
	readonly tokens = new Map<string, bigint>();
	readonly #state = new Map<string, { block: number; balance: bigint; nonce: bigint }[]>();
	/** Answers a call before the chain does, for a failure the test injects. */
	refuse?: (method: string, params: unknown[]) => Response | undefined;
	/** Hashes the logs take, in order, for a chain two processes must write the same; random when absent. */
	readonly #hashes?: () => string;

	constructor(chainId: number, hashes?: () => string) {
		this.chainId = chainId;
		if (hashes !== undefined) this.#hashes = hashes;
	}

	set(address: string, block: number, balance: bigint, nonce = 0n) {
		const list = this.#state.get(address.toLowerCase()) ?? [];
		list.push({ block, balance, nonce });
		list.sort((a, b) => a.block - b.block);
		this.#state.set(address.toLowerCase(), list);
	}
	at(address: string, block: number) {
		const list = this.#state.get(address.toLowerCase()) ?? [];
		return list.filter((one) => one.block <= block).at(-1) ?? { balance: 0n, nonce: 0n };
	}
	log(fields: {
		token: string;
		from: string;
		to: string;
		value: bigint;
		block: number;
		index?: number;
		removed?: boolean;
		topics?: string[];
	}) {
		const hash = this.#hashes?.() ?? `0x${randomBytes(32).toString("hex")}`;
		this.logs.push({
			address: fields.token.toLowerCase(),
			topics: fields.topics ?? [TRANSFER, topicOf(fields.from), topicOf(fields.to)],
			data: `0x${word(fields.value)}`,
			blockNumber: hex(fields.block),
			blockHash: `0x${"b".repeat(64)}`,
			transactionHash: hash,
			logIndex: hex(fields.index ?? 0),
			...(fields.removed === undefined ? {} : { removed: fields.removed }),
		});
		return hash;
	}
	/** The `eth_getLogs` calls, as the block ranges they asked for. */
	ranges() {
		return this.calls
			.filter((call) => call.method === "eth_getLogs")
			.map((call) => {
				const filter = call.params[0] as { fromBlock: string; toBlock: string };
				return [Number(filter.fromBlock), Number(filter.toBlock)];
			});
	}
	readonly fetch: typeof fetch = async (_url, init) => {
		const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
		this.calls.push({ method, params });
		const refused = this.refuse?.(method, params);
		if (refused !== undefined) return refused;
		const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
		const error = (code: number, message: string, status = 200) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status });
		const blockOf = (tag: unknown) =>
			tag === "latest" ? this.head : tag === "finalized" ? (this.final ?? Number.NaN) : Number(tag);
		const pruned = (tag: unknown) => blockOf(tag) < this.stateFrom;
		switch (method) {
			case "eth_chainId":
				return reply(hex(this.chainId));
			case "eth_blockNumber":
				return reply(hex(this.head));
			case "eth_getBlockByNumber": {
				if (params[0] === "finalized" && this.final === undefined) return error(-32000, "finalized block not found");
				const number = blockOf(params[0]);
				if (number > this.head) return reply(null);
				return reply({
					number: hex(number),
					hash: `0x${word(BigInt(number + 1))}`,
					parentHash: `0x${word(BigInt(number))}`,
					timestamp: hex(GENESIS + number),
				});
			}
			case "eth_getBalance":
			case "eth_getTransactionCount": {
				if (pruned(params[1])) return error(-32000, this.prunedWords(blockOf(params[1])));
				const state = this.at(String(params[0]), blockOf(params[1]));
				return reply(hex(method === "eth_getBalance" ? state.balance : state.nonce));
			}
			case "eth_getCode":
				if (pruned(params[1])) return error(-32000, this.prunedWords(blockOf(params[1])));
				return reply(
					this.codeAt?.(String(params[0]).toLowerCase(), blockOf(params[1])) ??
						this.code.get(String(params[0]).toLowerCase()) ??
						"0x",
				);
			case "eth_call": {
				const call = params[0] as { data: string };
				return reply(`0x${word(this.tokens.get(`0x${call.data.slice(-40)}`) ?? 0n)}`);
			}
			case "eth_getLogs": {
				const filter = params[0] as { fromBlock: string; toBlock: string; address: string; topics: unknown[] };
				const from = Number(filter.fromBlock);
				const to = Number(filter.toBlock);
				if (to - from + 1 > this.maxRange)
					return error(-32614, `eth_getLogs is limited to a ${this.maxRange} range`, 413);
				return reply(this.logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to));
			}
			default:
				return error(-32601, `the method ${method} does not exist`);
		}
	};
}
