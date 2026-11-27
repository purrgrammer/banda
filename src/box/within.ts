import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Whether `path` is one of `roots` or under one, compared as resolved absolute paths, segment by segment: `/t/b-1-ab` is
 * not under `/t/b-1-a`, and `..` cannot climb out. A relative path or root is never within, nor is anything under the
 * filesystem's root, which would take every home. Paths are compared as written: a caller passes each spelling of a
 * root it owns (as given and its realpath), and a symlinked spelling it did not pass stays outside.
 */
export function within(path: string, roots: readonly string[]): boolean {
	if (!isAbsolute(path)) return false;
	return roots.some((given) => {
		if (!isAbsolute(given)) return false;
		const root = resolve(given);
		if (dirname(root) === root) return false;
		const below = relative(root, resolve(path));
		return below === "" || (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below));
	});
}
