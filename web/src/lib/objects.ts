import { GITHUB_OBJECTS } from "../../../scripts/github-objects.ts";
import type { ObjectKinds } from "../../../src/core/objects.ts";
import type { ObjectAsk } from "../../../src/server/objects.ts";

// Only these shipped, bounded templates are compiled in the browser, not workspace definitions.
const placeholder = /\{([a-z_]{1,32})\}/g;
const literal = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replaceAll("\\*", "[A-Za-z0-9_.-]{1,100}");
/** What may follow a URL template and still name its object, as the daemon's `TAB` says: a tab, a query, a fragment. */
const TAB = "(?:/[^/?#\\s]+)?/?(?:[?#][^\\s]*)?";
const githubShapes = Object.entries(GITHUB_OBJECTS as ObjectKinds).flatMap(([kind, shape]) =>
	[
		...shape.ids.map((template) => ({ template, url: false })),
		...shape.urls.map((template) => ({ template, url: true })),
	].map(({ template, url }, index) => {
		const names = [...template.matchAll(placeholder)].map((m) => m[1] as string);
		const parts = template.split(/\{[a-z_]{1,32}\}/).map(literal);
		const source = parts.join("([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})");
		return {
			kind,
			shape,
			names,
			url,
			canonical: index === 0,
			pattern: new RegExp(`^${source}${url ? TAB : ""}$`),
		};
	}),
);

/** GitHub's declared identities only; other providers keep their own spelling and semantics. */
export function githubKey(ref: string): string | undefined {
	const canonical = /^github:([a-z][a-z0-9_]{0,63}):(.+)$/.exec(ref);
	const input = canonical?.[2] ?? ref;
	let address: string | undefined;
	try {
		const url = new URL(input);
		if (url.protocol === "https:" && !url.username && !url.password) address = url.href;
	} catch {
		// A shorthand is not a URL.
	}
	const keys = new Set<string>();
	for (const { kind, shape, names, url, pattern, canonical: first } of githubShapes) {
		if (canonical && (kind !== canonical[1] || !first)) continue;
		const value = url ? address : input;
		if (value === undefined) continue;
		const match = pattern.exec(value);
		if (!match) continue;
		const values: Record<string, string> = {};
		let valid = true;
		for (const [i, name] of names.entries()) {
			const captured = match[i + 1] as string;
			const rule = shape.normalize?.[name];
			if (captured.includes("..") || (rule === "integer" && (!/^\d+$/.test(captured) || /^0+$/.test(captured)))) {
				valid = false;
				break;
			}
			values[name] =
				rule === "lowercase" ? captured.toLowerCase() : rule === "integer" ? captured.replace(/^0+/, "") : captured;
		}
		if (valid)
			keys.add(`github:${kind}:${(shape.ids[0] ?? "").replace(placeholder, (_, name: string) => values[name] ?? "")}`);
	}
	// A shorthand's first candidate may fail while another succeeds. Only the daemon can resolve that choice.
	return keys.size > 1 ? JSON.stringify([...keys]) : keys.values().next().value;
}

/** `calendar/<id>`, or of a kind named after the connection (`gmail/thread/<id>`, `gmail/search/<query, encoded>`). */
const ID_LINK = /\]\(([a-z][a-z0-9-]{0,63}\/(?:[a-z]{1,32}\/)?[A-Za-z0-9_%][A-Za-z0-9_.%:+@-]{0,399})\)/g;

/**
 * Prose whose links to an object's id ([Team offsite](calendar/<id>)) are given the `object:` scheme: the renderer
 * blocks a link with no address, and an id has none. `idOfLink` reads the id back.
 */
export const idLinks = (text: string) => text.replace(ID_LINK, "](object:$1)");
export const idOfLink = (href: string) => (href.startsWith("object:") ? href.slice("object:".length) : href);

/** Names only, never card facts. Tabs/fragments of one object deduplicate; distinct jobs of a run do not. */
export function objectAsks(text: string, objects: readonly string[] = []): ObjectAsk[] {
	const refs = [
		...objects,
		...(text.match(/https:\/\/[^\s<>"`]+/gi) ?? []).map((ref) => ref.replace(/[),.;!?\]]+$/, "")),
		...(text.match(/[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9_]{0,63}:[A-Za-z0-9_.:/-]{1,400}/g) ?? []),
		// a connection's object linked in the prose by its id: [Team offsite](calendar/<id>)
		...[...text.matchAll(ID_LINK)].map((match) => match[1] as string),
	];
	const unique = new Map<string, string>();
	for (const ref of refs) {
		const trimmed = ref.trim();
		if (trimmed.length > 500) continue;
		const key = githubKey(trimmed) ?? trimmed;
		if (!unique.has(key)) unique.set(key, ref);
		if (unique.size === 8) break;
	}
	return [...unique.values()].map((ref) => ({ ref }));
}
