/**
 * Code coloured, on Shiki: one highlighter for a reply's code blocks (Streamdown's code plugin) and a file's lines (its
 * preview and its viewer). Its colours are the palette's (`--code-*` in tokens.css, audited with the rest), through
 * Shiki's CSS-variables theme, so light and dark follow the page. The engine is JavaScript (no WebAssembly) and each
 * language loads on first use, so nothing of it is in the first bundle. Highlighting turns text into coloured text:
 * nothing of what it reads runs.
 */
import type { CodeHighlighterPlugin, HighlightResult } from "streamdown";

/** A coloured piece of a line: its text and its colour (a `var(--code-…)`), or none for the plain ink. */
export type Token = { readonly content: string; readonly color?: string; readonly italic?: boolean };

type Loader = () => Promise<{ default: unknown }>;

/** The languages coloured, by Shiki's id; what else a fence names falls back to plain text. */
const LANGUAGES: Record<string, Loader> = {
	typescript: () => import("shiki/langs/typescript.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	jsx: () => import("shiki/langs/jsx.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	python: () => import("shiki/langs/python.mjs"),
	shellscript: () => import("shiki/langs/shellscript.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	java: () => import("shiki/langs/java.mjs"),
	kotlin: () => import("shiki/langs/kotlin.mjs"),
	swift: () => import("shiki/langs/swift.mjs"),
	c: () => import("shiki/langs/c.mjs"),
	cpp: () => import("shiki/langs/cpp.mjs"),
	csharp: () => import("shiki/langs/csharp.mjs"),
	ruby: () => import("shiki/langs/ruby.mjs"),
	php: () => import("shiki/langs/php.mjs"),
	lua: () => import("shiki/langs/lua.mjs"),
	r: () => import("shiki/langs/r.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	toml: () => import("shiki/langs/toml.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	xml: () => import("shiki/langs/xml.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
	diff: () => import("shiki/langs/diff.mjs"),
	dockerfile: () => import("shiki/langs/dockerfile.mjs"),
};

const ALIASES: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	shell: "shellscript",
	console: "shellscript",
	rs: "rust",
	kt: "kotlin",
	"c++": "cpp",
	cs: "csharp",
	rb: "ruby",
	yml: "yaml",
	md: "markdown",
	svg: "xml",
	jsonc: "json",
	json5: "json",
	docker: "dockerfile",
	patch: "diff",
	golang: "go",
};

/** Shiki's id for what a fence or a file names, or undefined when it is not one coloured here. */
export function languageOf(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	const id = name.trim().toLowerCase();
	const known = ALIASES[id] ?? id;
	return known in LANGUAGES ? known : undefined;
}

type Highlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;
let highlighter: Promise<Highlighter> | undefined;
const loaded = new Map<string, Promise<void>>();

function core(): Promise<Highlighter> {
	highlighter ??= (async () => {
		const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
			import("shiki/core"),
			import("shiki/engine/javascript"),
		]);
		return createHighlighterCore({
			themes: [createCssVariablesTheme({ name: "banda", variablePrefix: "--code-", fontStyle: true })],
			langs: [],
			engine: createJavaScriptRegexEngine({ forgiving: true }),
		});
	})();
	return highlighter;
}

async function ready(language: string): Promise<Highlighter> {
	const shiki = await core();
	let loading = loaded.get(language);
	if (loading === undefined) {
		const load = LANGUAGES[language];
		loading =
			load === undefined ? Promise.resolve() : load().then((module) => shiki.loadLanguage(module.default as never));
		loaded.set(language, loading);
	}
	await loading;
	return shiki;
}

/** Bounded: a file's glimpse or a long reply's block is coloured, a megabyte of minified code is not. */
const MOST = 200_000;

/** `code` as coloured lines; undefined when its language is not one coloured here, or it is too long to colour. */
export async function highlight(code: string, language: string | undefined): Promise<Token[][] | undefined> {
	const id = languageOf(language);
	if (id === undefined || code.length > MOST) return undefined;
	const shiki = await ready(id);
	const { tokens } = shiki.codeToTokens(code, { lang: id, theme: "banda" });
	return tokens.map((line) =>
		line.map((token) => ({
			content: token.content,
			...(token.color === undefined || token.color === "var(--code-foreground)" ? {} : { color: token.color }),
			// Shiki's FontStyle.Italic is 1
			...((token.fontStyle ?? 0) & 1 ? { italic: true } : {}),
		})),
	);
}

/** Recent results, so a re-render (a reply that streams, a feed that refreshes) draws coloured at once. */
const cache = new Map<string, HighlightResult>();

/** Streamdown's code plugin on the same highlighter: a reply's fenced code, coloured once its language loads. */
export const codePlugin: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	getSupportedLanguages: () => [...Object.keys(LANGUAGES), ...Object.keys(ALIASES)],
	getThemes: () => ["banda", "banda"],
	supportsLanguage: (language) => languageOf(language) !== undefined,
	highlight({ code, language, isIncomplete }, callback) {
		const key = `${language}\u0000${code}`;
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		void highlight(code, language).then(
			(lines) => {
				if (lines === undefined) return;
				const result: HighlightResult = {
					tokens: lines.map((line) =>
						line.map((token) => ({
							content: token.content,
							...(token.color === undefined ? {} : { color: token.color }),
							...(token.italic === true ? { htmlStyle: { "font-style": "italic" } } : {}),
						})),
					),
				};
				// a block still streaming is superseded by its next update: kept only once whole
				if (isIncomplete !== true) {
					if (cache.size > 200) cache.delete(cache.keys().next().value ?? "");
					cache.set(key, result);
				}
				callback?.(result);
			},
			() => {},
		);
		return null;
	},
};
