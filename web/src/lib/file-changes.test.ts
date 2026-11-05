import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import { argList } from "./chat.ts";
import { type FileTree, fileChanges, fileTree, lineCount } from "./file-changes.ts";

describe("file changes in an approval", () => {
	it("takes a push's files out of the facts", () => {
		const { files, rest } = fileChanges({
			owner: "o",
			repo: "r",
			branch: "main",
			message: "add",
			files: [
				{ path: "src/a.ts", content: "one\ntwo\n" },
				{ path: "README.md", content: "hi" },
			],
		});
		expect(files.map((file) => [file.path, file.lines])).toEqual([
			["src/a.ts", 2],
			["README.md", 1],
		]);
		expect(rest).toEqual({ owner: "o", repo: "r", branch: "main", message: "add" });
		expect(argList(rest).some(([label]) => label.includes("content"))).toBe(false);
	});
	it("takes a single file put's path and content", () => {
		const { files, rest } = fileChanges({ path: "a/b.md", content: "x\n", message: "m", sha: "abc" });
		expect(files).toEqual([{ path: "a/b.md", content: "x\n", lines: 1 }]);
		expect(rest).toEqual({ message: "m", sha: "abc" });
	});
	it("leaves arguments that are not files alone", () => {
		const args = { to: "x", items: [{ path: "a" }], path: "only a path" };
		expect(fileChanges(args)).toEqual({ files: [], rest: args });
	});
	it("keeps what else a file carried as a fact", () => {
		const { rest } = fileChanges({ files: [{ path: "run.sh", content: "", mode: "100755" }] });
		expect(rest).toEqual({ "files › run.sh": { mode: "100755" } });
	});
	it("counts lines as a diff does", () => {
		expect([lineCount(""), lineCount("a"), lineCount("a\n"), lineCount("a\nb"), lineCount("\n\n")]).toEqual([
			0, 1, 1, 2, 2,
		]);
	});
	it("shows every file once in its tree", () => {
		const path = fc
			.array(fc.constantFrom("a", "b", "src", "lib"), { minLength: 0, maxLength: 3 })
			.chain((dirs) => fc.constantFrom("x.ts", "y.md").map((name) => [...dirs, name].join("/")));
		fc.assert(
			fc.property(fc.uniqueArray(path, { minLength: 1, maxLength: 12 }), (paths) => {
				const tree = fileTree(paths.map((each) => ({ path: each, content: "", lines: 0 })));
				const all = (node: FileTree, at: string): string[] => [
					...node.files.map((file) => `${at}${file.name}`),
					...node.dirs.flatMap((dir) => all(dir, `${at}${dir.name}/`)),
				];
				expect(all(tree, "").sort()).toEqual([...paths].sort());
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});
