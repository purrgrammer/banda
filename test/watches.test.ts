import { describe, expect, it } from "vitest";
import { parseWatch, watchText } from "../src/core/watches.ts";
import { Faults } from "./fault/faults.ts";
import { watchProblems, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

describe("a watch file", () => {
	it("says what it follows, as whom and until what, and what matters below; each problem says what to write", () => {
		const text = watchText({
			object: "https://github.com/acme/banda/pull/142",
			account: "bandarra",
			until: "merged",
			ask: "Tell me when it is approved.",
		});
		expect(text).toBe(
			"---\nobject: https://github.com/acme/banda/pull/142\naccount: bandarra\nuntil: merged\n---\nTell me when it is approved.\n",
		);
		const parsed = parseWatch("banda-142", text);
		expect("watch" in parsed ? parsed.watch : parsed).toEqual({
			name: "banda-142",
			object: "https://github.com/acme/banda/pull/142",
			account: "bandarra",
			until: "merged",
			ask: "Tell me when it is approved.",
		});
		const errors = (name: string, text: string) => {
			const found = parseWatch(name, text);
			return "errors" in found ? found.errors : [];
		};
		expect(errors("Bad Name", text)).toContainEqual(expect.stringContaining("not a watch name"));
		expect(errors("x", "no frontmatter")).toContainEqual(expect.stringContaining("frontmatter"));
		expect(errors("x", "---\nuntil: merged\n---\nwords\n")).toContainEqual(expect.stringContaining("object:"));
		expect(errors("x", "---\nobject: a\nuntil: Soon!\n---\nwords\n")).toContainEqual(expect.stringContaining("until"));
		expect(errors("x", "---\nobject: a\n---\n")).toContainEqual(expect.stringContaining("what matters"));
	});
});

describe("a watch on a pull request", () => {
	it("looks once for its baseline, wakes its agent once per change in the kind's words, ignores its own and the same again, and ends when merged", async () => {
		const summary = await watchScenario(await tempHome(), new Faults());
		expect(watchProblems(summary)).toEqual([]);
		expect(summary.wakes[0]?.object).toMatchObject({
			name: "acme/banda #142",
			connection: "github",
			service: "GitHub",
			account: "bandarra",
		});
		expect(summary.record.saw).toEqual(["merged", "closed"]);
		expect(summary.record.looked).toBeDefined();
	}, 60_000);
});
