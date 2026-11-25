import { sourceLink } from "../../../src/core/source-link.ts";
/**
 * Where the app is, in the hash, so the daemon serves one page: `#/` the last chat (or the first agent's), `#/a/<id>` an
 * agent's chat, `#/g/<room>` a group's, `#/settings` (`?tab=` one of its tabs), `#/connections`, `#/wallets/new` (`?agent=`
 * the agent it is for), `#/wallets/<route>` a wallet by its address's ends (`walletRoute`), or by its address, (`?tab=` one of its tabs; `/key` saving its key, `/receive` its
 * address, `/restore` restoring its key), `#/specimen`. `?at=<entry>` opens a chat at an entry, as a search result
 * does. Pure, so the tests read and write it too.
 */
export type Where =
	| { readonly name: "home" }
	| { readonly name: "agent"; readonly id: string; readonly at?: number }
	| { readonly name: "group"; readonly room: number; readonly at?: number }
	/** An artifact in the main pane; `v`, one of its versions (the newest when absent). */
	| { readonly name: "artifact"; readonly id: string; readonly v?: number }
	| { readonly name: "settings"; readonly tab?: SettingsTab }
	/**
	 * A wallet, by its address, or by the route its links carry (`walletRoute`); none is the page that makes one, `agent`
	 * the agent it is for.
	 */
	| {
			readonly name: "wallet";
			readonly address?: string;
			readonly tab?: WalletTab;
			readonly page?: WalletPage;
			readonly agent?: string;
	  }
	| { readonly name: "connections"; readonly connection?: string; readonly add?: true }
	| { readonly name: "skills" }
	| { readonly name: "skill"; readonly id: string }
	| { readonly name: "specimen" };

/**
 * Settings, in tabs as the agent's panel has them: General (appearance, notifications, routines, the computer), Memory
 * (the shared facts and each agent's own, one set, never copies), Model (the provider and the models the tiers use),
 * Usage (model spend and caching), Connections (every account), Agents (the limits on groups; the archived agents and
 * groups, to restore), Wallets (every wallet and each network's RPC), Devices (the phones paired, and pairing one).
 */
const SETTINGS_TABS = ["general", "memory", "model", "usage", "connections", "agents", "wallets", "devices"] as const;
/** A tab of Settings. */
export type SettingsTab = (typeof SETTINGS_TABS)[number];
/** Every tab a wallet's page can draw, Recipients included for the build that sends. */
const WALLET_TABS = ["activity", "recipients", "agents", "wallet"] as const;
/** A wallet's page of its own: saving its key, Receive, restoring its key. */
export type WalletPage = "key" | "receive" | "restore";
/** A tab of a wallet's page. */
export type WalletTab = (typeof WALLET_TABS)[number];
/** The tabs a wallet's page offers in this build: a link to another one opens Activity. */
export const OFFERED_TABS: readonly WalletTab[] = WALLET_TABS.filter((tab) => tab !== "recipients");
const isOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
	value !== null && (list as readonly string[]).includes(value);

const AGENT_ID = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const AGENT = new RegExp(`^/a/(${AGENT_ID})$`);
const WALLET = /^\/wallets\/(0x[0-9a-fA-F]{40}|0x[0-9a-f]{4}-[0-9a-f]{4})(?:\/(key|receive|restore))?$/;

/**
 * What a wallet's link carries in place of its address: the ends the short form shows, never the whole address, which
 * the location bar would give out before the key is saved (H-005). The page finds the wallet whose ends they are.
 */
export const walletRoute = (address: string): string =>
	/^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}-${address.slice(-4)}`.toLowerCase() : address;

/** Whether `route` (a wallet's route, or its address in any case) names the wallet at `address`. */
export const routesTo = (address: string, route: string): boolean =>
	address.toLowerCase() === route.toLowerCase() || walletRoute(address) === route.toLowerCase();

/**
 * The wallets of `addresses` that `route` names. A route is eight hex digits of the address, so two wallets may share
 * one: the page then asks which, and the link still carries no whole address (H-005).
 */
export const routedTo = (addresses: readonly string[], route: string): string[] =>
	addresses.filter((address) => routesTo(address, route));
const GROUP = /^\/g\/(\d{1,12})$/;
const ARTIFACT = /^\/artifact\/([0-9a-z]{1,64})$/;

/** The hash as a place; anything else is home. */
export function parse(hash: string): Where {
	const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
	const at = Number(new URLSearchParams(query).get("at") ?? Number.NaN);
	const entry = Number.isSafeInteger(at) && at > 0 ? { at } : {};
	if (path === "/settings") {
		const tab = new URLSearchParams(query).get("tab");
		return { name: "settings", ...(isOf(SETTINGS_TABS, tab) ? { tab } : {}) };
	}
	if (path === "/wallets/new") {
		const agent = new URLSearchParams(query).get("agent");
		return { name: "wallet", ...(agent !== null && new RegExp(`^${AGENT_ID}$`).test(agent) ? { agent } : {}) };
	}
	const wallet = WALLET.exec(path);
	if (wallet?.[1] !== undefined) {
		const tab = new URLSearchParams(query).get("tab");
		return {
			name: "wallet",
			address: wallet[1],
			...(wallet[2] === undefined ? {} : { page: wallet[2] as WalletPage }),
			...(isOf(OFFERED_TABS, tab) ? { tab } : {}),
		};
	}
	if (path === "/connections") {
		const params = new URLSearchParams(query);
		const connection = params.get("connection");
		return {
			name: "connections",
			...(connection !== null && /^[a-z][a-z0-9-]{0,63}$/.test(connection) ? { connection } : {}),
			...(params.get("add") === "true" ? { add: true as const } : {}),
		};
	}
	if (path === "/skills") return { name: "skills" };
	const skill = /^\/skills\/([a-z0-9-]+)$/.exec(path)?.[1];
	if (skill !== undefined) return { name: "skill", id: skill };
	if (path === "/specimen") return { name: "specimen" };
	const agent = AGENT.exec(path)?.[1];
	if (agent !== undefined) return { name: "agent", id: agent, ...entry };
	const artifact = ARTIFACT.exec(path)?.[1];
	if (artifact !== undefined) {
		const v = Number(new URLSearchParams(query).get("v") ?? Number.NaN);
		return { name: "artifact", id: artifact, ...(Number.isSafeInteger(v) && v > 0 ? { v } : {}) };
	}
	const room = GROUP.exec(path)?.[1];
	if (room !== undefined) return { name: "group", room: Number(room), ...entry };
	return { name: "home" };
}

/** A place as its hash. */
export function hrefOf(where: Where): string {
	const at = "at" in where && where.at !== undefined ? `?at=${where.at}` : "";
	switch (where.name) {
		case "home":
			return "#/";
		case "agent":
			return `#/a/${where.id}${at}`;
		case "group":
			return `#/g/${where.room}${at}`;
		case "connections": {
			const query = [where.connection ? `connection=${where.connection}` : "", where.add ? "add=true" : ""]
				.filter((part) => part !== "")
				.join("&");
			return `#/connections${query === "" ? "" : `?${query}`}`;
		}
		case "artifact":
			return `#/artifact/${where.id}${where.v === undefined ? "" : `?v=${where.v}`}`;
		case "skill":
			return `#/skills/${where.id}`;
		case "settings":
			return `#/settings${where.tab === undefined ? "" : `?tab=${where.tab}`}`;
		case "wallet":
			if (where.address === undefined)
				return `#/wallets/new${where.agent === undefined ? "" : `?agent=${where.agent}`}`;
			return `#/wallets/${walletRoute(where.address)}${where.page === undefined ? "" : `/${where.page}`}${where.tab === undefined ? "" : `?tab=${where.tab}`}`;
		default:
			return `#/${where.name}`;
	}
}

/** The chat the app last showed, kept on this device so `#/` opens there again. */
export type Last = { readonly name: "agent"; readonly id: string } | { readonly name: "group"; readonly room: number };

export function lastOf(stored: string | null): Last | undefined {
	const where = parse(stored ?? "");
	if (where.name === "agent") return { name: "agent", id: where.id };
	if (where.name === "group") return { name: "group", room: where.room };
	return undefined;
}

/** Only canonical source references from search navigate inside the current app. */
export function isSourceHref(href: string | undefined): boolean {
	return sourceLink(href) !== undefined;
}
