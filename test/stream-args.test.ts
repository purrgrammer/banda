import fc from "fast-check";
import { expect, it } from "vitest";
import { appendArgument } from "../src/server/stream-args.ts";
import { pbtRuns } from "./pbt.ts";

it("streams strings inside arguments without mutating the recorded snapshot or creating paths", () => {
	fc.assert(
		fc.property(fc.jsonValue(), fc.string(), (value, delta) => {
			const paths: (string | number)[][] = [];
			function walk(node: unknown, path: (string | number)[]) {
				if (typeof node === "string") paths.push(path);
				else if (Array.isArray(node))
					node.forEach((child, n) => {
						walk(child, [...path, n]);
					});
				else if (node && typeof node === "object")
					for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
			}
			walk(value, []);
			const before = JSON.stringify(value);
			for (const path of paths) {
				const changed = appendArgument(value, path, delta);
				let original: unknown = value;
				let actual: unknown = changed;
				for (const key of path) {
					original = (original as Record<string | number, unknown>)[key];
					actual = (actual as Record<string | number, unknown>)[key];
				}
				expect(actual).toBe(String(original) + delta);
				expect(JSON.stringify(value)).toBe(before);
			}
			expect(appendArgument(value, ["missing", "path"], delta)).toEqual(value);
		}),
		{ numRuns: pbtRuns(100) },
	);
});
it("treats prototype-shaped keys as ordinary recorded data, never traversal through a prototype", () => {
	const value = JSON.parse('{"__proto__":{"label":"recorded"},"constructor":"own"}');
	const result = appendArgument(value, ["__proto__", "label"], " data");
	expect(JSON.stringify(result)).toBe('{"__proto__":{"label":"recorded data"},"constructor":"own"}');
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(appendArgument({}, ["__proto__", "label"], "not allowed")).toEqual({});
	expect(appendArgument(["a"], [0], "b")).toEqual(["ab"]);
	expect(appendArgument(["a"], ["0"], "b")).toEqual(["a"]);
});
