/**
 * A page as the agent reads it (DESIGN.md "The box", The browser): its accessibility tree as text, each element it can
 * act on named by a ref bound to this snapshot (`s<snapshot>e<n>`), so a ref from an earlier one is refused rather than
 * taken to mean whatever sits there now.
 *
 * Nothing secret reaches it. A sensitive field (a password, a one-time code, a card number, any field the owner typed
 * into while holding the browser) shows as one, with its value and everything under it left out. A key the page shows
 * (an API key, a token) is replaced by a handle, `[key k1]`, that names it to the daemon, which alone holds its value
 * and keeps it only into `auth/` (`propose_key`). Pure, so the rules are a property's.
 */

/** An accessibility node as Chromium's `Accessibility.getFullAXTree` gives it. */
export type AxNode = {
	readonly nodeId: string;
	readonly ignored?: boolean;
	readonly role?: { readonly value?: unknown };
	readonly name?: { readonly value?: unknown };
	readonly value?: { readonly value?: unknown };
	readonly properties?: readonly { readonly name: string; readonly value: { readonly value?: unknown } }[];
	readonly childIds?: readonly string[];
	readonly parentId?: string;
	readonly backendDOMNodeId?: number;
};

/** One frame's tree: the main frame first, then any frame inside it. */
export type FrameTree = { readonly url: string; readonly nodes: readonly AxNode[] };

export type Rendered = {
	readonly text: string;
	/** Each ref of this snapshot, and the element it names. */
	readonly refs: ReadonlyMap<string, Element>;
	/** Each key handle, and the value it hides: the daemon's alone. */
	readonly keys: ReadonlyMap<string, string>;
	/** The elements whose text is hidden: sensitive fields and the text keys are in, for screenshots to blank. */
	readonly hidden: readonly number[];
};

/** An element the agent may act on: its node, its role and its name, as the snapshot showed them. */
export type Element = {
	readonly node: number;
	readonly role: string;
	readonly name: string;
	readonly sensitive: boolean;
};

/** Roles the agent acts on, which get a ref. */
const ACTIONABLE = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"combobox",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"listbox",
	"slider",
	"spinbutton",
	"treeitem",
	"MenuListPopup",
	"MenuListOption",
	"ListBoxOption",
	"PopUpButton",
	"textField",
]);

/** Roles that only hold others, shown only when named. */
const HOLDERS = new Set(["generic", "none", "presentation", "GenericContainer", "Section", "group", "paragraph"]);

/** Roles never shown: what their parents already say. */
const SKIPPED = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);

/** The properties worth a word. */
const STATES = ["checked", "selected", "expanded", "disabled", "required", "level", "pressed", "readonly"] as const;

/**
 * Keys a page may show: known prefixes, JWTs, and any long token of letters and digits mixing upper case, lower case
 * and digits (a commit hash, a uuid or a word is none of those).
 */
const KEY_PATTERN = new RegExp(
	[
		String.raw`\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|api)?[-_]?[A-Za-z0-9_-]{16,}`,
		String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
		String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
		String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
		String.raw`\bAKIA[0-9A-Z]{16}\b`,
		String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
		String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
		String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
		`(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])`,
	].join("|"),
	"g",
);

/** How long a snapshot may be: past it, the rest is cut and the agent told to scroll. */
export const SNAPSHOT_CHARS = 24_000;

/** Whether a node is a field whose value must never be shown, given its DOM attributes. */
export function sensitiveField(nodeName: string, attributes: Readonly<Record<string, string>>): boolean {
	const type = (attributes.type ?? "").toLowerCase();
	if (nodeName.toUpperCase() === "INPUT" && type === "password") return true;
	const autocomplete = (attributes.autocomplete ?? "").toLowerCase();
	if (/one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/.test(autocomplete)) return true;
	const named = [attributes.name, attributes.id, attributes["aria-label"], attributes.placeholder]
		.filter((value): value is string => value !== undefined)
		.join(" ");
	return /pass(word|code|phrase)?\b|passwd|\botp\b|one.?time|\b2fa\b|\bmfa\b|totp|\bcvc\b|\bcvv\b|\bcsc\b|card.?(number|num|no)\b|\bssn\b|secret|api.?key|access.?token|\bpin\b/i.test(
		named,
	);
}

const words = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

/**
 * Render `frames` as snapshot `generation`. `sensitive` says which nodes are sensitive fields (by DOM node); `keys`
 * carries the handles of keys already seen, so the same key keeps its handle while the browser runs.
 */
export function render(
	page: { readonly title: string; readonly url: string },
	frames: readonly FrameTree[],
	generation: number,
	sensitive: ReadonlySet<number>,
	known: ReadonlyMap<string, string> = new Map(),
): Rendered {
	const refs = new Map<string, Element>();
	const keys = new Map<string, string>(known);
	const byValue = new Map([...keys].map(([handle, value]) => [value, handle]));
	const hidden = new Set<number>();
	const lines: string[] = [];
	let length = 0;
	let cut = false;

	/** `text` with every key in it replaced by its handle; `node` holds the text, so screenshots blank it. */
	const mask = (text: string, node?: number): string =>
		text.replace(KEY_PATTERN, (key) => {
			let handle = byValue.get(key);
			if (handle === undefined) {
				handle = `k${keys.size + 1}`;
				keys.set(handle, key);
				byValue.set(key, handle);
			}
			if (node !== undefined) hidden.add(node);
			return `[key ${handle}]`;
		});
	const quote = (text: string) => JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 300));
	const push = (line: string) => {
		if (cut) return;
		if (length + line.length > SNAPSHOT_CHARS) {
			cut = true;
			lines.push("… (the page goes on: scroll down, or wait for the text you need, for more)");
			return;
		}
		lines.push(line);
		length += line.length + 1;
	};

	push(`Page ${quote(mask(page.title))} at ${mask(page.url)}`);
	let n = 0;
	for (const [index, frame] of frames.entries()) {
		const byId = new Map(frame.nodes.map((node) => [node.nodeId, node]));
		const root = frame.nodes.find((node) => node.parentId === undefined || !byId.has(node.parentId));
		if (root === undefined) continue;
		const base = index === 0 ? 0 : 1;
		if (index > 0) push(`- frame at ${mask(frame.url)}:`);
		const walk = (node: AxNode, depth: number, quiet: boolean) => {
			const role = words(node.role?.value);
			const children = (node.childIds ?? []).flatMap((id) => {
				const child = byId.get(id);
				return child === undefined ? [] : [child];
			});
			if (node.ignored === true || SKIPPED.has(role) || role === "") {
				for (const child of children) walk(child, depth, quiet);
				return;
			}
			const domNode = node.backendDOMNodeId;
			const isSensitive = domNode !== undefined && sensitive.has(domNode);
			if (role === "StaticText") {
				if (quiet) return;
				const text = words(node.name?.value).trim();
				if (text !== "") push(`${"  ".repeat(depth)}- text ${quote(mask(text, domNode))}`);
				return;
			}
			const name = words(node.name?.value).trim();
			if (HOLDERS.has(role) && name === "" && !isSensitive) {
				for (const child of children) walk(child, depth, quiet);
				return;
			}
			if (role === "RootWebArea") {
				for (const child of children) walk(child, depth, false);
				return;
			}
			const parts = [`${"  ".repeat(depth)}- ${role}`];
			if (name !== "") parts.push(quote(mask(name, domNode)));
			if (ACTIONABLE.has(role) && domNode !== undefined) {
				const ref = `s${generation}e${++n}`;
				refs.set(ref, { node: domNode, role, name: mask(name), sensitive: isSensitive });
				parts.push(`[ref=${ref}]`);
			}
			for (const state of STATES) {
				const found = node.properties?.find((property) => property.name === state)?.value.value;
				if (found === undefined || found === false || found === "false") continue;
				parts.push(state === "level" ? `[level ${words(found)}]` : `[${state}]`);
			}
			if (isSensitive) {
				// its value, and whatever under it draws the value, never leave the daemon
				if (domNode !== undefined) hidden.add(domNode);
				parts.push("(a secret: its value is hidden)");
				push(parts.join(" "));
				return;
			}
			const value = words(node.value?.value);
			if (value !== "") parts.push(`value=${quote(mask(value, domNode))}`);
			push(parts.join(" "));
			// a named element says what its text says: only what it holds besides its words is shown under it
			for (const child of children) walk(child, depth + 1, name !== "" || ACTIONABLE.has(role));
		};
		walk(root, base, false);
	}
	return { text: lines.join("\n"), refs, keys, hidden: [...hidden] };
}

/** A ref's snapshot and its number in it, or undefined when it is not a ref. */
export function parseRef(ref: string): { readonly generation: number } | undefined {
	const match = /^s(\d+)e(\d+)$/.exec(ref.trim());
	return match === null ? undefined : { generation: Number(match[1]) };
}
