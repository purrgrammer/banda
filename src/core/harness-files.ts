/**
 * What harnesses banda can run (DESIGN.md "Connections"): any agent that speaks ACP. Each is a file banda ships
 * (`shipped/harnesses/<name>.md`), or a command line the owner gave; never a file the box wrote, since the daemon runs
 * it on the owner's computer. A shipped harness is a package banda bundles (run with node) or a command on the PATH;
 * one that is neither is not offered.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_NAME, frontmatter } from "./agents.ts";
import type { HarnessDefinition } from "./harness.ts";

/** Where banda's own harness files are, in the checkout or the release. */
export const SHIPPED_HARNESSES = fileURLToPath(new URL("../../shipped/harnesses/", import.meta.url));

const FIELDS = ["service", "package", "bin", "command", "adapter", "args", "mode", "asks", "install"] as const;
/** banda's own ACP adapters, for harnesses that speak something else (src/adapters/). */
export const ADAPTERS = ["pi"] as const as readonly string[];

/** What a harness asks, when its file does not say: its own settings decide. */
export const OWN_ASKS = "It asks you whatever its own settings on this computer ask.";

/** A harness file as written: what it is called, how it starts, its mode, what it asks; or what is wrong. */
export type HarnessFile = {
	readonly name: string;
	readonly service: string;
	readonly about: string;
	readonly asks: string;
	readonly mode?: string;
	/** How the owner installs it when it is not here, as a command line. */
	readonly install?: string;
	readonly start: /** A package banda's checkout may have, run with node; else `command`, the same adapter installed on the PATH. */
		| { readonly package: string; readonly bin: string; readonly command?: string }
		/** A command on the PATH; with `adapter`, banda's own adapter (src/adapters/<adapter>) runs it and speaks ACP. */
		| { readonly command: string; readonly args: readonly string[]; readonly adapter?: string };
};

/** Words split on spaces, a quoted run kept whole: `opencode acp`, `"my agent" --acp`. */
export function words(line: string): string[] {
	const found = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return found.map((word) => (/^(["']).*\1$/.test(word) ? word.slice(1, -1) : word));
}

export function parseHarness(
	name: string,
	text: string,
): { readonly harness: HarnessFile } | { readonly errors: readonly string[] } {
	const errors: string[] = [];
	if (!AGENT_NAME.test(name)) errors.push(`"${name}" is not a harness name: lowercase letters, digits and dashes`);
	const read = frontmatter(text, FIELDS);
	if (read === undefined)
		return { errors: [...errors, "a harness file starts with its frontmatter between two --- lines"] };
	errors.push(...read.errors);
	const service = read.one("service") ?? "";
	if (service === "") errors.push(`add "service:", the harness as the owner calls it, such as "Claude Code"`);
	const pkg = read.one("package");
	const bin = read.one("bin");
	const command = read.one("command");
	if (pkg === undefined && command === undefined)
		errors.push(`give "package:" (with "bin:") for an adapter banda's checkout has, or "command:" for one on the PATH`);
	if (pkg !== undefined && bin === undefined) errors.push(`a package names its "bin:", the script to run with node`);
	const mode = read.one("mode");
	const install = read.one("install");
	const adapter = read.one("adapter");
	if (adapter !== undefined && (command === undefined || !ADAPTERS.includes(adapter)))
		errors.push(`"adapter" is one of banda's (${ADAPTERS.join(", ")}), around a "command:"`);
	if (errors.length > 0) return { errors };
	return {
		harness: {
			name,
			service,
			about: read.body.trim(),
			asks: read.one("asks") ?? OWN_ASKS,
			...(mode === undefined ? {} : { mode }),
			...(install === undefined ? {} : { install }),
			start:
				pkg !== undefined
					? { package: pkg, bin: bin ?? "", ...(command === undefined ? {} : { command }) }
					: {
							command: command ?? "",
							args: words(read.one("args") ?? ""),
							...(adapter === undefined ? {} : { adapter }),
						},
		},
	};
}

/** Where `command` is on the PATH, or undefined. A path given whole is taken as it is, when it exists. */
export function onPath(command: string, path = process.env.PATH ?? ""): string | undefined {
	if (command.includes("/")) return existsSync(command) ? command : undefined;
	for (const dir of path.split(delimiter)) {
		if (dir === "") continue;
		const full = join(dir, command);
		try {
			if (statSync(full).isFile()) return full;
		} catch {
			// not here
		}
	}
	return undefined;
}

const require = createRequire(import.meta.url);

/** How a harness file starts on this computer, or undefined when it is not installed. */
export function resolveHarness(file: HarnessFile): HarnessDefinition | undefined {
	const base = {
		name: file.name,
		service: file.service,
		about: file.about,
		asks: file.asks,
		...(file.mode === undefined ? {} : { mode: file.mode }),
	};
	if ("package" in file.start) {
		try {
			const script = join(dirname(require.resolve(`${file.start.package}/package.json`)), file.start.bin);
			if (existsSync(script)) return { ...base, command: process.execPath, args: [script] };
		} catch {
			// not in this install: a release does not bundle it (its license, its size); the owner's own, on the PATH
		}
		const installed = file.start.command === undefined ? undefined : onPath(file.start.command);
		return installed === undefined ? undefined : { ...base, command: installed, args: [] };
	}
	const found = onPath(file.start.command);
	if (found === undefined) return undefined;
	if (file.start.adapter === undefined) return { ...base, command: found, args: [...file.start.args] };
	// banda's own adapter, beside this module: .ts from the checkout, .js from the build
	const script = fileURLToPath(
		new URL(`../adapters/${file.start.adapter}${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url),
	);
	return existsSync(script)
		? { ...base, command: process.execPath, args: [script, found, ...file.start.args] }
		: undefined;
}

/** Every harness file in `dir` that parses, by name; one that does not is said to `log`. */
export function shippedHarnesses(dir: string, log: (line: string) => void): HarnessFile[] {
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	return files.flatMap((file) => {
		const parsed = parseHarness(file.slice(0, -3), readFileSync(join(dir, file), "utf8"));
		if ("errors" in parsed) {
			log(`shipped/harnesses/${file} does not parse: ${parsed.errors.join("; ")}`);
			return [];
		}
		return [parsed.harness];
	});
}
