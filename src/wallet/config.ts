/**
 * Each network's RPC, from `config.json`'s `wallets.rpc.<network>` (docs/wallets.md "Chains, RPC and privacy"). What
 * the owner set is used or refused, never replaced by the shipped default: that default is a public endpoint the owner
 * may have set this field to avoid. So a key that names no network, or a key under `wallets` this build does not read,
 * refuses the whole section, as a malformed value does, for every network: a misspelt one would otherwise fall back in
 * silence. A thrown message is fixed text that names at most a network: never a value or a key the owner wrote, either
 * of which may carry the RPC's key (H-195).
 */
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { addressRefusal, bareHost, isLoopbackHost } from "../core/addresses.ts";
import { type Config, readConfig } from "../home.ts";
import { type Network, NetworkId } from "./networks.ts";
import type { Rpc } from "./rpc.ts";

/**
 * `wallets.rpc`: an RPC for each network `NetworkId` names, and no other key. Built from `NetworkId` itself, so a
 * network added there is one config.json can name, with no second list to keep in step.
 */
const RpcConfig = Type.Object(
	Object.fromEntries(NetworkId.anyOf.map((id) => [id.const, Type.Optional(Type.String())])),
	{ additionalProperties: false },
);

/**
 * The part of `config.json` this module reads. Anything else in the file is another reader's; `wallets` is this
 * module's alone, so a later wallet field joins this schema.
 */
const WalletsConfig = Type.Object(
	{
		wallets: Type.Optional(
			Type.Object(
				{
					rpc: Type.Optional(RpcConfig),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: true, title: "config.json wallets" },
);

/**
 * Where banda sends a network's JSON-RPC: a URL `fetch` takes, and the headers that carry what the URL's userinfo
 * held.
 */
export type WalletRpc = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** Why `config.json`'s wallets section does not fit its schema, in fixed words that name at most a network. */
function misfit(config: unknown): string {
	const head = "config.json's wallets";
	const plain = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
	if (!plain(config)) return "config.json is not an object";
	const wallets = (config as { wallets?: unknown }).wallets;
	if (wallets !== undefined && !plain(wallets)) return `${head} is not an object`;
	if (Object.keys(wallets ?? {}).some((key) => key !== "rpc")) return `${head} has a key this build does not read`;
	const rpc = (wallets as { rpc?: unknown } | undefined)?.rpc;
	if (rpc !== undefined && !plain(rpc)) return `${head}.rpc is not an object`;
	for (const [key, value] of Object.entries((rpc ?? {}) as Record<string, unknown>)) {
		if (!Value.Check(NetworkId, key)) return `${head}.rpc has a key that names no network`;
		if (typeof value !== "string") return `${head}.rpc.${key} is not a string`;
	}
	return `${head} do not fit their schema`;
}

/**
 * The RPC banda talks to for `network`: the owner's, or the default banda ships. `subject` is what a refusal of the
 * owner's URL names it as: the file's key by default, the field where the owner types it on the screen that saves it.
 * Throws on a malformed section or a
 * refused URL (H-196): over plain http, or at a private address, only localhost is taken (anvil in tests and
 * development); anything else must be https at a public address. A private address is refused over https too, since
 * the scheme does not make a neighbour's node the owner's. A literal address is checked, with the IPv4 address an
 * IPv6 one embeds; a host name is taken as written here, and resolved only where the owner saves it.
 *
 * A URL's userinfo, which `fetch` refuses, moves into a Basic `Authorization` header, so the URL handed back is one
 * `fetch` takes.
 */
export function walletRpc(
	config: Config,
	network: Network,
	subject = `config.json's wallets.rpc.${network.id}`,
): WalletRpc {
	if (!Value.Check(WalletsConfig, config)) throw new Error(misfit(config));
	const set = config.wallets?.rpc?.[network.id];
	const field = subject;
	if (set === undefined) {
		if (network.rpc === undefined) throw new Error(`${field} is not set, and banda ships no default for it`);
		return { url: network.rpc, headers: {} };
	}
	if ([...set].some((char) => char <= " " || (char >= "\u007f" && char <= "\u009f")))
		throw new Error(`${field} holds a space or a control character`);
	let url: URL;
	try {
		url = new URL(set);
	} catch {
		throw new Error(`${field} is not a URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${field} is not an http(s) URL`);
	const host = bareHost(url.hostname);
	const looped = isLoopbackHost(host);
	if (!looped) {
		const refused = isIP(host) === 0 ? undefined : addressRefusal(host);
		if (refused === "private") throw new Error(`${field} names a private address: only localhost is taken`);
		if (refused === "embedded loopback")
			throw new Error(`${field} names loopback inside another IPv6 address: only localhost is taken`);
		if (url.protocol !== "https:") throw new Error(`${field} is plain http: only localhost is taken over http`);
	}
	if (url.username === "" && url.password === "") return { url: url.href, headers: {} };
	let user: string;
	try {
		user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
	} catch {
		throw new Error(`${field} has userinfo that is not percent-encoded`);
	}
	url.username = "";
	url.password = "";
	return { url: url.href, headers: { authorization: `Basic ${Buffer.from(user, "utf8").toString("base64")}` } };
}

/**
 * An RPC URL as the owner and the logs may see it (H-195): the scheme, the host and the port, with any userinfo, path,
 * query or fragment, where providers put a key, shown as `•••`. What is not a URL is masked whole.
 */
export function maskedRpc(rpc: string): string {
	let url: URL;
	try {
		url = new URL(rpc);
	} catch {
		return "•••";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return "•••";
	const userinfo = url.username !== "" || url.password !== "" ? "•••@" : "";
	const rest = url.pathname !== "/" || url.search !== "" || url.hash !== "" ? "/•••" : "";
	return `${url.protocol}//${userinfo}${url.host}${rest}`;
}

/**
 * The RPC `walletRpc` gave, as `maskedRpc` shows the URL the owner set: its userinfo moved into the `Authorization`
 * header and out of `url`, so a credential is shown as `•••@` from there, and two RPCs that differ only by their
 * credential never look like one without any.
 */
export function shownRpc(rpc: WalletRpc): string {
	const masked = maskedRpc(rpc.url);
	if (rpc.headers.authorization === undefined || masked === "•••" || masked.includes("•••@")) return masked;
	return masked.replace("//", "//•••@");
}

/** A failure to learn a network's RPC, in fixed words that name at most a network (H-195). */
export class RpcSettingsError extends Error {}

/**
 * The daemon's one set of RPC clients (`rpcClients`): one bucket per RPC, shared by everything that reads it (H-198).
 */
export type RpcClients = { client(network: Network, rpc: WalletRpc): Rpc };

/**
 * Each network's client as `config.json` sets its RPC at the time of the call, from the daemon's one set of clients.
 * A failure is an `RpcSettingsError` in fixed words: what the file system or JSON.parse says names the file's path or
 * quotes it, and `walletRpc`'s words name at most a network.
 */
export const rpcOf =
	(home: string, clients: RpcClients) =>
	async (network: Network): Promise<Rpc> => {
		let config: Config;
		try {
			config = await readConfig(home);
		} catch {
			throw new RpcSettingsError("the network's RPC settings could not be read");
		}
		let rpc: WalletRpc;
		try {
			rpc = walletRpc(config, network);
		} catch (error) {
			throw new RpcSettingsError((error as Error).message);
		}
		return clients.client(network, rpc);
	};
