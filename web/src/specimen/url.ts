/**
 * The specimen's place in the hash, read and written the same, so a section can be linked: `#/specimen?section=<id>`
 * with `scheme` (both, light or dark), `width` (desktop or phone) and `only=1` for that one section with no chrome.
 * Its focused previews are `#/specimen/<name>`. Pure, so the tests read and write it too.
 */
import { isSection } from "./registry.ts";

export type Scheme = "both" | "light" | "dark";
export type Width = "desktop" | "phone";

export type View = {
	/** A registered section, or nothing. */
	readonly section?: string;
	readonly scheme: Scheme;
	readonly width: Width;
	/** That one section alone, with no header or nav. */
	readonly only: boolean;
};

export type Preview =
	| { readonly kind: "toolsets" }
	| { readonly kind: "mcp" }
	| { readonly kind: "activity" }
	| { readonly kind: "recorded" }
	| { readonly kind: "skill"; readonly name: string };

export const DEFAULT_VIEW: View = { scheme: "both", width: "desktop", only: false };

const SCHEMES: readonly Scheme[] = ["both", "light", "dark"];
const WIDTHS: readonly Width[] = ["desktop", "phone"];

/** A focused preview's hash, or nothing when the hash is the page. */
export function previewOf(hash: string): Preview | undefined {
	const path = hash.split("?")[0] ?? "";
	if (path === "#/specimen/toolsets") return { kind: "toolsets" };
	if (path === "#/specimen/mcp") return { kind: "mcp" };
	if (path === "#/specimen/activity") return { kind: "activity" };
	if (path === "#/specimen/activity/recorded") return { kind: "recorded" };
	const skill = /^#\/specimen\/skills\/([a-z0-9-]+)$/.exec(path);
	if (skill?.[1] !== undefined) return { kind: "skill", name: skill[1] };
	return undefined;
}

/** The page's view from its hash; anything unknown falls back to the default. */
export function viewOf(hash: string): View {
	const query = new URLSearchParams(hash.split("?")[1] ?? "");
	const section = query.get("section") ?? undefined;
	const scheme = query.get("scheme");
	const width = query.get("width");
	return {
		...(section !== undefined && isSection(section) ? { section } : {}),
		scheme: SCHEMES.find((one) => one === scheme) ?? DEFAULT_VIEW.scheme,
		width: WIDTHS.find((one) => one === width) ?? DEFAULT_VIEW.width,
		only: query.get("only") === "1",
	};
}

/** The hash for a view: defaults are left out, so `#/specimen` stays `#/specimen`. */
export function hrefOf(view: Partial<View>): string {
	const query = new URLSearchParams();
	if (view.section !== undefined) query.set("section", view.section);
	if (view.scheme !== undefined && view.scheme !== DEFAULT_VIEW.scheme) query.set("scheme", view.scheme);
	if (view.width !== undefined && view.width !== DEFAULT_VIEW.width) query.set("width", view.width);
	if (view.only === true) query.set("only", "1");
	const text = query.toString();
	return text === "" ? "#/specimen" : `#/specimen?${text}`;
}
