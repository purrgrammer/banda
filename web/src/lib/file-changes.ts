/**
 * Files an approval would write, recognised by their shape rather than by tool: an argument that is a list of
 * `{ path, content }`, or a `path` and a `content` side by side. Any tool that writes files this way (a push, a commit,
 * a file put) shows them as files, with their lines counted, instead of their bytes flattened into the facts.
 */

export type FileChange = { readonly path: string; readonly content: string; readonly lines: number };

export type FileChanges = {
	readonly files: readonly FileChange[];
	/** The arguments the files did not take: what the facts still show. */
	readonly rest: { readonly [key: string]: unknown };
};

const CONTENT = ["content", "contents"] as const;

function contentOf(value: { readonly [key: string]: unknown }): string | undefined {
	for (const key of CONTENT) if (typeof value[key] === "string") return value[key] as string;
	return undefined;
}

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A file's lines as a diff counts them: a trailing newline ends the last line, it does not start another. */
export function lineCount(content: string): number {
	if (content === "") return 0;
	return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

const change = (path: string, content: string): FileChange => ({ path, content, lines: lineCount(content) });

export function fileChanges(args: { readonly [key: string]: unknown }): FileChanges {
	const files: FileChange[] = [];
	const rest: { [key: string]: unknown } = {};
	for (const [key, value] of Object.entries(args)) {
		if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((each) => isRecord(each) && typeof each.path === "string" && contentOf(each) !== undefined)
		) {
			for (const each of value as { readonly [key: string]: unknown }[])
				files.push(change(each.path as string, contentOf(each) as string));
			// what else each file carried (a mode, an encoding) stays a fact, under the file's path
			for (const each of value as { readonly [key: string]: unknown }[]) {
				const extra = Object.fromEntries(
					Object.entries(each).filter(([name]) => name !== "path" && !(CONTENT as readonly string[]).includes(name)),
				);
				if (Object.keys(extra).length > 0) rest[`${key} › ${each.path as string}`] = extra;
			}
		} else rest[key] = value;
	}
	const single = contentOf(rest);
	if (files.length === 0 && typeof rest.path === "string" && single !== undefined) {
		files.push(change(rest.path, single));
		delete rest.path;
		for (const key of CONTENT) delete rest[key];
	}
	return { files, rest };
}

export type FileTree = {
	readonly name: string;
	readonly dirs: readonly FileTree[];
	readonly files: readonly (FileChange & { readonly name: string })[];
};

/** The files as folders: a folder holding a single folder and nothing else is shown as one (`src/lib`). */
export function fileTree(files: readonly FileChange[]): FileTree {
	type Mutable = { name: string; dirs: Map<string, Mutable>; files: (FileChange & { name: string })[] };
	const root: Mutable = { name: "", dirs: new Map(), files: [] };
	for (const file of files) {
		const parts = file.path.split("/").filter((part) => part !== "");
		const name = parts.pop() ?? file.path;
		let at = root;
		for (const part of parts) {
			let next = at.dirs.get(part);
			if (next === undefined) {
				next = { name: part, dirs: new Map(), files: [] };
				at.dirs.set(part, next);
			}
			at = next;
		}
		at.files.push({ ...file, name });
	}
	const freeze = (node: Mutable): FileTree => {
		let at = node;
		let name = node.name;
		while (at !== root && at.files.length === 0 && at.dirs.size === 1) {
			const [only] = at.dirs.values() as Iterable<Mutable>;
			at = only as Mutable;
			name = `${name}/${at.name}`;
		}
		return {
			name,
			dirs: [...at.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(freeze),
			files: [...at.files].sort((a, b) => a.name.localeCompare(b.name)),
		};
	};
	return freeze(root);
}
