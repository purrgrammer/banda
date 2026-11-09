import { sourceLink } from "../../../src/core/source-link.ts";
/**
 * Where the app is, in the hash, so the daemon serves one page: `#/` the last chat (or the first agent's), `#/a/<id>` an
 * agent's chat, `#/g/<room>` a group's, `#/settings`, `#/connections`, `#/specimen`. `?at=<entry>` opens a chat at
 * an entry, as a search result does. Pure, so the tests read and write it too.
 */
export type Where =
	| { readonly name: "home" }
	| { readonly name: "agent"; readonly id: string; readonly at?: number }
	| { readonly name: "group"; readonly room: number; readonly at?: number }
	/** An artifact in the main pane; `v`, one of its versions (the newest when absent). */
	| { readonly name: "artifact"; readonly id: string; readonly v?: number }
	| { readonly name: "settings" }
	| { readonly name: "connections"; readonly connection?: string; readonly add?: true }
	| { readonly name: "skills" }
	| { readonly name: "skill"; readonly id: string }
	| { readonly name: "specimen" };

const AGENT = /^\/a\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const GROUP = /^\/g\/(\d{1,12})$/;
const ARTIFACT = /^\/artifact\/([0-9a-z]{1,64})$/;

/** The hash as a place; anything else is home. */
export function parse(hash: string): Where {
	const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
	const at = Number(new URLSearchParams(query).get("at") ?? Number.NaN);
	const entry = Number.isSafeInteger(at) && at > 0 ? { at } : {};
	if (path === "/settings") return { name: "settings" };
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
		case "connections":
			return `#/connections${where.connection ? `?connection=${where.connection}` : where.add ? "?add=true" : ""}`;
		case "artifact":
			return `#/artifact/${where.id}${where.v === undefined ? "" : `?v=${where.v}`}`;
		case "skill":
			return `#/skills/${where.id}`;
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
