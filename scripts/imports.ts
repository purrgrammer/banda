/**
 * The npm packages a bundle carries, read from its sources for test/wallet-deps.test.ts: every package a file the
 * bundler reaches loads by a literal specifier, following relative imports (and the web's `@/` alias) transitively,
 * into the daemon's sources too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const SCRIPT = /\.(c|m)?(t|j)sx?$/;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];
const CSS_LOADS = /@(?:import|plugin)\s+["']([^"'\n]+)["']/g;

/** npm's rule for a package name, scoped or not: lowercase, URL-safe, not starting with `.` or `_`. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * The specifiers a script or stylesheet loads: static, side-effect, re-exported and dynamic imports and `require` by a
 * string literal (an `import type` or `export type` is erased, so it loads nothing), and a stylesheet's `@import` and
 * `@plugin`.
 */
export function specifiers(text: string, file: string): string[] {
	if (file.endsWith(".css")) return [...text.matchAll(CSS_LOADS)].map((m) => m[1]);
	const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
	const found: string[] = [];
	const literal = (node: ts.Node | undefined) => {
		if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) found.push(node.text);
	};
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node)) {
			if (!node.importClause?.isTypeOnly) literal(node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node)) {
			if (!node.isTypeOnly) literal(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node)) {
			if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference))
				literal(node.moduleReference.expression);
		} else if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const loads =
				callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
			if (loads) literal(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/**
 * The package a specifier names, or undefined for a path, an alias, node's own modules or a virtual module. Any other
 * specifier fails: a `#` import or a name npm would not publish could reach a package this reading cannot name.
 */
export function packageOf(specifier: string): string | undefined {
	if (/^(\.|\/|@\/|[a-z]+:)/.test(specifier)) return undefined;
	const parts = specifier.split("?")[0].split("/");
	const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
	if (!PACKAGE_NAME.test(name)) throw new Error(`${specifier} names no package, path or alias this reading knows`);
	return name;
}

/** The npm packages one source loads directly. */
export function importedPackages(text: string, file = "source.ts"): string[] {
	return [...new Set(specifiers(text, file).flatMap((s) => packageOf(s) ?? []))].sort();
}

function resolveFile(path: string): string | undefined {
	const bare = path.split("?")[0];
	const candidates = [
		bare,
		bare.replace(/\.(m|c)?js(x?)$/, ".$1ts$2"),
		...EXTENSIONS.map((ext) => bare + ext),
		...EXTENSIONS.map((ext) => join(bare, `index${ext}`)),
	];
	return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

export interface BundleOptions {
	/** Where `@/` points, as Vite's alias does for the web app. */
	alias?: string;
	/** A relative import that is not on disk and is replaced at build time, so it loads nothing. */
	absent?: (path: string) => boolean;
}

/**
 * Every npm package the sources under `dir` (tests left out) reach, following relative imports into whatever files
 * they name. A relative import that resolves to no file fails, unless `absent` says the build replaces it.
 */
export function bundledPackages(dir: string, options: BundleOptions = {}): string[] {
	const entries = readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => (SCRIPT.test(file) || file.endsWith(".css")) && !/\.test\.[a-z]+$/.test(file))
		.map((file) => join(dir, file));
	const seen = new Set<string>();
	const packages = new Set<string>();
	const pending = [...entries];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of specifiers(readFileSync(file, "utf8"), file)) {
			const local = specifier.startsWith(".")
				? resolve(dirname(file), specifier)
				: specifier.startsWith("@/") && options.alias
					? join(options.alias, specifier.slice(2))
					: undefined;
			if (local === undefined) {
				const name = packageOf(specifier);
				if (name) packages.add(name);
				continue;
			}
			const target = resolveFile(local);
			if (target === undefined) {
				if (options.absent?.(local)) continue;
				throw new Error(`${file} imports ${specifier}, which is no file`);
			}
			if (SCRIPT.test(target) || target.endsWith(".css")) pending.push(target);
		}
	}
	return [...packages].sort();
}
