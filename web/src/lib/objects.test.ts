import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../../../scripts/github-objects.ts";
import { recognise, refKey } from "../../../src/core/objects.ts";
import { pbtRuns } from "../../../test/pbt.ts";
import { objectAsks } from "./objects.ts";

describe("message object names", () => {
	it("takes a link to an object of a named kind, its words encoded, as an id", () => {
		expect(
			objectAsks("[the thread](gmail/thread/18c2f0a1) and [the boss](gmail/search/from%3Aboss+is%3Aunread)"),
		).toEqual([{ ref: "gmail/thread/18c2f0a1" }, { ref: "gmail/search/from%3Aboss+is%3Aunread" }]);
	});
	it("keeps two jobs of one run distinct, but deduplicates a job's fragments", () => {
		const one = "https://github.com/o/r/actions/runs/100/job/201";
		const two = "https://github.com/o/r/actions/runs/100/job/202";
		expect(objectAsks(`${one} ${one}#step:1:2 [next](${two})`)).toEqual([{ ref: one }, { ref: two }]);
	});
	it("deduplicates repeated refs before bounding the candidate request", () => {
		fc.assert(
			fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 20 }), (numbers) => {
				const refs = numbers.map((n) => `https://github.com/o/r/pull/${n}`);
				const words = refs.flatMap((ref) => [ref, `[PR](${ref}/files)`, `${ref}#discussion`]).join(" ");
				expect(objectAsks(words, [refs[0] as string])).toEqual(refs.slice(0, 8).map((ref) => ({ ref })));
			}),
			{ numRuns: pbtRuns(50) },
		);
	});
	it("deduplicates GitHub aliases by URL semantics and keeps the first reference", () => {
		const issue = "https://github.com/o/r/pull/34/../../issues/35";
		expect(
			objectAsks(`${issue} https://api.github.com/repos/O/R/issues/0035 https://github.com/O/R/issues/035`),
		).toEqual([{ ref: issue }]);
		const pr = "HTTPS://GITHUB.COM/O/R/pull/0034";
		expect(
			objectAsks(`${pr} https://api.github.com/repos/o/r/pulls/34`, ["github:pull_request:O/R#034", "o/r#34"]),
		).toEqual([{ ref: "github:pull_request:O/R#034" }, { ref: "o/r#34" }]);
		const job = "https://github.com/O/R/actions/runs/100/job/0201";
		expect(
			objectAsks(
				`${job} https://api.github.com/repos/o/r/actions/jobs/201 https://github.com/o/r/actions/runs/100/job/202`,
			),
		).toEqual([{ ref: job }, { ref: "https://github.com/o/r/actions/runs/100/job/202" }]);
	});
	it("agrees with daemon identity across generated aliases, traversal spellings and unsupported refs", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 8 }), (id, zeros) => {
				const padded = `${"0".repeat(zeros)}${id}`;
				const refs = [
					`https://github.com/Owner/Repo/pull/${padded}/../../issues/${padded}`,
					`https://github.com/owner/repo/pull/34/%2e%2e/.%2E/issues/${id}`,
					`https://github.com/owner/repo/pull/34/..\\..\\issues/${id}`,
					`HTTPS://API.GITHUB.COM/repos/OWNER/REPO/issues/${id}`,
					`github:issue:owner/repo#${padded}`,
					`Owner/Repo#${padded}`,
					`https://github.com/owner/repo/pull/${id}/files`,
					`https://github.com/Owner/Repo/actions/runs/1/job/${padded}#step`,
					`https://api.github.com/repos/owner/repo/actions/jobs/${id}`,
					`owner/repo/actions/jobs/${padded}`,
					`https://github.com/owner/repo/actions/runs/1/job/${id + 1}`,
					`https://api.github.com/notifications/threads/${id}`,
					`github:notification:notification/${padded}`,
					`https://github.com/user/repo/runs/${id}`,
					`https://api.github.com/repos/user/repo/check-runs/${id}`,
					`https://user:password@github.com/owner/repo/issues/${id}`,
					`github:issue:https://github.com/owner/repo/issues/${id}`,
				];
				const expected = new Map<string, string>();
				for (const ref of refs) {
					const found = recognise(ref, [{ name: "github", objects: GITHUB_OBJECTS }]);
					const keys = [...new Set(found.map((one) => refKey(one, GITHUB_OBJECTS)))];
					const key = keys.length > 1 ? JSON.stringify(keys) : (keys[0] ?? ref);
					if (!expected.has(key)) expected.set(key, ref);
				}
				expect(objectAsks("", refs)).toEqual([...expected.values()].slice(0, 8).map((ref) => ({ ref })));
			}),
			{ numRuns: pbtRuns(50) },
		);
	});
	it("retains ambiguous shorthand until the daemon resolves it, even beside a matching PR URL", () => {
		const pr = "https://github.com/o/r/pull/34";
		expect(objectAsks("", [pr, "o/r#34"])).toEqual([{ ref: pr }, { ref: "o/r#34" }]);
	});
	it("never turns model prose into card fields or unsafe URLs into reads", () => {
		expect(
			objectAsks("javascript:alert(1) data:text/html,hi http://localhost/api [PR](https://github.com/o/r/pull/1)."),
		).toEqual([{ ref: "https://github.com/o/r/pull/1" }]);
	});
});
