/**
 * The hosts a host permission binds (DESIGN.md "The box", Network), as the proxy spells them (policy.py
 * `permitted_host`, `host_covers`): a name in lower case, its port unless the scheme's, its scheme unless https. The owner
 * may allow a pattern: `*.example.com`, any name under example.com (never example.com itself), or `*`, every host; the
 * scheme and port bind as for a name.
 */

const DEFAULT_PORTS: { readonly [scheme: string]: number } = { http: 80, https: 443 };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host as `permittedHost` spells it, split: its scheme, its name (bracketed when an IPv6 address), its `:port` or "". */
function split(spelled: string): { scheme: string; name: string; port: string } {
	const at = spelled.indexOf("://");
	const scheme = at < 0 ? "https" : spelled.slice(0, at);
	const rest = at < 0 ? spelled : spelled.slice(at + 3);
	if (rest.startsWith("[")) {
		const close = rest.indexOf("]");
		return { scheme, name: rest.slice(0, close + 1), port: rest.slice(close + 1) };
	}
	const colon = rest.indexOf(":");
	return colon < 0 ? { scheme, name: rest, port: "" } : { scheme, name: rest.slice(0, colon), port: rest.slice(colon) };
}

/** Whether the allowed host `allowed` covers the host `spelled` (both `permittedHost` spellings), as the proxy reads it. */
export function hostCovers(allowed: string, spelled: string): boolean {
	if (allowed === spelled) return true;
	const pattern = split(allowed);
	if (!pattern.name.startsWith("*")) return false;
	const other = split(spelled);
	if (pattern.scheme !== other.scheme || pattern.port !== other.port || other.name.startsWith("[")) return false;
	return pattern.name === "*" || (pattern.name.startsWith("*.") && other.name.endsWith(pattern.name.slice(1)));
}

/** Whether a host is a pattern rather than one host. */
export const isPattern = (host: string) => split(host).name.startsWith("*");

/**
 * What the owner typed as a host to allow, spelled as the proxy reads it: `relay.damus.io`, `*.damus.io`, `*`,
 * `http://localhost.example:8080`, `wss://nos.lol` (a WebSocket's scheme is its HTTP one's). Undefined when it names
 * no host: a path, a query, a pattern anywhere but its first label.
 */
export function allowedHost(typed: string): string | undefined {
	let rest = typed.trim().toLowerCase();
	let scheme = "https";
	const at = rest.indexOf("://");
	if (at >= 0) {
		const given = rest.slice(0, at);
		const named = { https: "https", wss: "https", http: "http", ws: "http" }[given];
		if (named === undefined) return undefined;
		scheme = named;
		rest = rest.slice(at + 3);
	}
	rest = rest.replace(/\/$/, "");
	if (rest === "" || /[/?#@\s]/.test(rest)) return undefined;
	const colon = rest.lastIndexOf(":");
	let name = rest;
	let port = DEFAULT_PORTS[scheme] ?? 0;
	if (colon >= 0 && !rest.endsWith("]")) {
		const digits = rest.slice(colon + 1);
		if (!/^\d{1,5}$/.test(digits) || Number(digits) < 1 || Number(digits) > 65_535) return undefined;
		port = Number(digits);
		name = rest.slice(0, colon);
	}
	if (name === "*.") return undefined;
	name = name.replace(/\.$/, "");
	if (name !== "*") {
		const labels = (name.startsWith("*.") ? name.slice(2) : name).split(".");
		if (labels.length === 0 || !labels.every((label) => LABEL.test(label))) return undefined;
	}
	const spelled = port === DEFAULT_PORTS[scheme] ? name : `${name}:${port}`;
	return scheme === "https" ? spelled : `${scheme}://${spelled}`;
}
