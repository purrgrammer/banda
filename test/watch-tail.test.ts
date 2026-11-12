import { describe, expect, it } from "vitest";
import { GITHUB_OBJECTS } from "../scripts/github-objects.ts";
import { type Item, sort } from "../src/core/follow.ts";
import { parseObjects } from "../src/core/objects.ts";
import { missed, newestWithin, readTail, TAIL_PAGES, tailStart } from "../src/core/tail.ts";
import { Faults } from "./fault/faults.ts";
import { type Answer, failure, watchInvariants, watchScenario } from "./fault/watch-scenario.ts";
import { tempHome } from "./helpers.ts";

/** A list of `n` items, ids from `first`, oldest first, read in pages of `size` as GitHub hands them. */
const list = (n: number, first = 1): Item[] => Array.from({ length: n }, (_, i) => ({ id: first + i }));
const pager = (items: readonly Item[], size: number) => {
	const asked: number[] = [];
	return {
		asked,
		page: async (n: number) => {
			asked.push(n);
			return items.slice((n - 1) * size, n * size);
		},
	};
};
const ids = (items: readonly Item[]) => items.map((item) => item.id);

describe("a tail read", () => {
	it("starts a page before the last, so it always holds at least a page of the newest", () => {
		expect(tailStart(undefined, 100)).toBe(1);
		expect(tailStart(0, 100)).toBe(1);
		expect(tailStart(150, 100)).toBe(1);
		expect(tailStart(200, 100)).toBe(1);
		expect(tailStart(201, 100)).toBe(2);
		expect(tailStart(250, 100)).toBe(2);
	});

	it("reads 150 from the start in two pages, and knows its length", async () => {
		const { asked, page } = pager(list(150), 100);
		const read = await readTail(page, 100, undefined, false);
		expect(asked).toEqual([1, 2]);
		expect("items" in read && ids(read.items)).toEqual(ids(list(150)));
		expect(read).toMatchObject({ length: 150 });
	});

	it("jumps to the last pages by the list's own count", async () => {
		const { asked, page } = pager(list(250), 100);
		const read = await readTail(page, 100, 250, true);
		expect(asked).toEqual([2, 3]);
		expect("items" in read && ids(read.items)).toEqual(ids(list(150, 101)));
		expect(read).toMatchObject({ length: 250 });
	});

	it("reads on past a count that is behind (comments came since it was read)", async () => {
		const { asked, page } = pager(list(301), 100);
		const read = await readTail(page, 100, 300, true);
		expect(asked).toEqual([2, 3, 4]);
		expect("items" in read && read.items.at(-1)?.id).toBe(301);
	});

	it("a short page before the last the count implies is not the end (the service filtered it)", async () => {
		const items = list(250).filter((item) => item.id !== 150);
		const asked: number[] = [];
		// the service keeps positions: page 2 holds 99 though page 3 follows
		const page = async (n: number) => {
			asked.push(n);
			return list(250)
				.slice((n - 1) * 100, n * 100)
				.filter((item) => item.id !== 150);
		};
		const read = await readTail(page, 100, 250, true);
		expect(asked).toEqual([2, 3]);
		expect("items" in read && read.items.length).toBe(items.length - 100);
	});

	it("steps back when the list got shorter than its count said, by little or by much", async () => {
		const { asked, page } = pager(list(150), 100);
		const read = await readTail(page, 100, 350, true);
		expect(asked).toEqual([3, 1, 2]);
		expect("items" in read && ids(read.items)).toEqual(ids(list(150)));
		expect(read).toMatchObject({ length: 150 });
		// a count far past the list (wrong, not stale): halving reaches its start within a look's pages
		const far = pager(list(50), 100);
		const wrong = await readTail(far.page, 100, 450, true);
		expect(far.asked).toEqual([4, 2, 1]);
		expect(wrong).toMatchObject({ length: 50 });
	});

	it("a watch may miss items only when the newest reading is not whole and does not reach back to what it saw", () => {
		const of = (from: number, to: number) => list(to - from + 1, from);
		// the newest reading overlaps what the watch saw: nothing between was unread
		expect(missed(of(101, 250), of(151, 300), "id", 300)).toBe(false);
		// more came between two looks than its pages hold
		expect(missed(of(101, 250), of(301, 500), "id", 500)).toBe(true);
		// a whole list misses nothing, whatever it no longer holds
		expect(missed(of(101, 250), of(1, 40), "id", 40)).toBe(false);
		// none before, and the newest reading starts past the list's first items
		expect(missed([], of(101, 300), "id", 300)).toBe(true);
		// a list the reading before did not hold, or a length never learned, is no change of its items
		expect(missed(undefined, of(101, 300), "id", 300)).toBe(false);
		expect(missed(of(1, 10), of(101, 300), "id", undefined)).toBe(false);
	});

	it("never reads more than its pages a look: a list longer says where the next look starts", async () => {
		const items = list(1000);
		let length: number | undefined;
		const looks: number[][] = [];
		for (let look = 0; look < 10; look++) {
			const { asked, page } = pager(items, 100);
			const read = await readTail(page, 100, length, false);
			looks.push(asked);
			expect(asked.length).toBeLessThanOrEqual(TAIL_PAGES);
			if ("failed" in read) throw new Error(read.failed);
			length = read.length;
			if ("items" in read) {
				expect(read.items.at(-1)?.id).toBe(1000);
				break;
			}
		}
		expect(looks).toEqual([
			[1, 2, 3],
			[3, 4, 5],
			[5, 6, 7],
			[7, 8, 9],
			[9, 10, 11],
		]);
		expect(length).toBe(1000);
	});

	it("a page it cannot read is said as the service said it", async () => {
		const read = await readTail(async () => ({ failed: "Bad credentials", until: 5 }), 100, undefined, false);
		expect(read).toEqual({ failed: "Bad credentials", until: 5 });
	});

	it("keeps the newest within its bytes, the oldest pushed off first", () => {
		const items = list(10).map((item) => ({ ...item, body: "x".repeat(100) }));
		const kept = newestWithin(items, 400);
		expect(ids(kept)).toEqual([8, 9, 10]);
		expect(ids(newestWithin(items, 10))).toEqual([10]);
	});
});

describe("GitHub's reviews and comments as tails", () => {
	it("the pull request's and the issue's are windows; their comments are counted by the object", () => {
		const objects = parseObjects(GITHUB_OBJECTS, () => true);
		expect("objects" in objects).toBe(true);
		if (!("objects" in objects)) return;
		const pr = objects.objects.pull_request;
		expect(pr?.reads.reviews?.tail).toEqual({ by: "id" });
		expect(pr?.reads.comments?.tail).toEqual({ by: "id", total: "pr.comments" });
		expect(pr?.follow?.windows).toMatchObject({ reviews: "id", comments: "id" });
		expect(pr?.follow?.totals).toMatchObject({ comments: "pr.comments" });
		expect(objects.objects.issue?.follow?.totals).toMatchObject({ comments: "issue.comments" });
	});

	it("a read with tail must leave page to the daemon, give perPage and count from another read", () => {
		const kind = (read: object) => ({
			card: "generic",
			urls: ["https://example.com/x/{n}"],
			reads: { x: { tool: "get_x", args: { n: "{n}" } }, list: { tool: "list_x", ...read } },
			fields: {},
			follow: { rules: [], ends: {} },
		});
		const errors = (read: object) => {
			const found = parseObjects({ x: kind(read) }, () => true);
			return "errors" in found ? found.errors.join("\n") : "";
		};
		expect(errors({ args: { perPage: 100 }, tail: { by: "id", total: "x.count" } })).not.toMatch(/tail/);
		expect(errors({ args: { perPage: 100, page: 1 }, tail: { by: "id" } })).toMatch(/leaves page/);
		expect(errors({ args: {}, tail: { by: "id" } })).toMatch(/perPage/);
		expect(errors({ args: { perPage: 200 }, tail: { by: "id" } })).toMatch(/perPage, 1 to 100/);
		expect(errors({ args: { perPage: 100 }, tail: { by: "id", total: "y.count" } })).toMatch(/no other read/);
		expect(errors({ args: { perPage: 100 }, tail: { by: "id", total: "list.count" } })).toMatch(/tail is/);
		expect(errors({ args: { perPage: 100 }, tail: { by: "id", more: 1 } })).toMatch(/tail is/);
	});

	it("an item pushed off the old end is never gone, and one that slides back is not new", () => {
		const objects = parseObjects(GITHUB_OBJECTS, () => true);
		if (!("objects" in objects)) throw new Error("no objects");
		const follow = objects.objects.pull_request?.follow;
		if (follow === undefined) throw new Error("no follow");
		const comment = (id: number) => ({ id, user: { login: `u${id}` } });
		const reading = (count: number, from: number, to: number) => ({
			pr: { state: "open", comments: count },
			comments: Array.from({ length: to - from + 1 }, (_, i) => comment(from + i)),
		});
		// the window moved on: 101..250, then 102..251 with 251 new
		const moved = sort(follow, "me", reading(250, 101, 250), reading(251, 102, 251));
		expect(moved.filter((each) => each.does !== "nothing").map((each) => each.says)).toEqual(["u251 commented"]);
		// comments deleted at the newest end: the window starts at the first page again, the older ones back in it
		const back = sort(follow, "me", reading(250, 101, 250), reading(199, 1, 199));
		expect(back.filter((each) => each.does !== "nothing")).toEqual([]);
		expect(back.filter((each) => each.change.kind === "added").length).toBe(100);
	});
});

/** A pull request with `comments` and `reviews` (each a list of authors, oldest first), as GitHub pages them. */
const pullRequest =
	(worldAt: (step: number) => { comments: Item[]; reviews: Item[] }, asked: { [method: string]: number[] }): Answer =>
	(tool, args, step) => {
		if (tool !== "pull_request_read") return failure("not that");
		const world = worldAt(step);
		const method = String(args.method);
		const paged = (items: Item[]) => {
			const size = Number(args.perPage ?? 30);
			const n = Number(args.page ?? 1);
			asked[method] = [...(asked[method] ?? []), n];
			return items.slice((n - 1) * size, n * size);
		};
		if (method === "get") {
			const pr: Item = {
				number: 142,
				title: "Keep objects as data",
				state: "open",
				draft: false,
				merged: false,
				user: { login: "ana" },
				head: { ref: "objects", sha: "a1" },
				html_url: "https://github.com/acme/banda/pull/142",
			};
			// as GitHub leaves out a count of none
			if (world.comments.length > 0) pr.comments = world.comments.length;
			return pr;
		}
		if (method === "get_check_runs")
			return { total_count: 1, check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "success" }] };
		if (method === "get_reviews") return paged(world.reviews);
		if (method === "get_comments") return paged(world.comments);
		return failure(`no ${method}`);
	};

const comments = (n: number, first = 1): Item[] =>
	Array.from({ length: n }, (_, i) => ({ id: first + i, user: { login: `c${first + i}` }, body: "a comment" }));
const reviews = (n: number, first = 10_001): Item[] =>
	Array.from({ length: n }, (_, i) => ({ id: first + i, user: { login: `r${first + i}` }, state: "COMMENTED" }));

describe("a watch on a pull request with long reviews and comments", () => {
	it("150 comments and 150 reviews: the newest of each wakes, and none past a page is said gone", async () => {
		const asked: { [method: string]: number[] } = {};
		const world = (step: number) =>
			step === 0
				? { comments: comments(150), reviews: reviews(150) }
				: {
						comments: [...comments(150), { id: 151, user: { login: "bob" }, body: "the newest" }],
						reviews: [...reviews(150), { id: 10_151, user: { login: "carol" }, state: "APPROVED" }],
					};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			answer: pullRequest(world, asked),
			clicks: ["k1"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes).toHaveLength(1);
		expect(summary.wakes[0]?.changes).toEqual(expect.arrayContaining(["bob commented", "carol approved"]));
		expect(summary.wakes[0]?.changes).toHaveLength(2);
		expect(summary.tells).toEqual([]);
		// each look read both pages of each, and no more
		expect(asked.get_comments).toEqual([1, 2, 1, 2]);
		expect(asked.get_reviews).toEqual([1, 2, 1, 2]);
	}, 60_000);

	it("the window moves on, slides back when the newest are deleted, and only what is new wakes", async () => {
		const asked: { [method: string]: number[] } = {};
		const world = (step: number) => {
			if (step === 0) return { comments: comments(250), reviews: reviews(250) };
			const dana = { id: 251, user: { login: "dana" }, body: "new" };
			const erin = { id: 10_251, user: { login: "erin" }, state: "CHANGES_REQUESTED" };
			if (step === 1) return { comments: [...comments(250), dana], reviews: [...reviews(250), erin] };
			// the newest fifty-two comments deleted: 199 left, so the reading starts at the first page again
			if (step === 2) return { comments: comments(199), reviews: [...reviews(250), erin] };
			return {
				comments: [...comments(199), { id: 252, user: { login: "fay" }, body: "newer" }],
				reviews: [...reviews(250), erin],
			};
		};
		const summary = await watchScenario(await tempHome(), new Faults(), {
			answer: pullRequest(world, asked),
			clicks: ["k1", "k2", "k3"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => [...wake.changes].sort())).toEqual([
			["dana commented", "erin requested changes"],
			["fay commented"],
		]);
		expect(summary.tells).toEqual([]);
		// comments by their count: pages 2-3 while there are 250 or 251, then 1-2 (and the empty third) at 199 and 200;
		// reviews from the first page until a look learned how long they are, then from the one before the last
		expect(asked.get_comments).toEqual([2, 3, 2, 3, 1, 2, 1, 2, 3]);
		expect(asked.get_reviews).toEqual([1, 2, 3, 2, 3, 2, 3, 2, 3]);
	}, 60_000);

	it("a thousand reviews: the baseline and the looks after catch up a few pages a look, waking for none of them", async () => {
		const asked: { [method: string]: number[] } = {};
		const world = (step: number) => ({
			comments: [],
			reviews: step < 6 ? reviews(1000) : [...reviews(1000), { id: 20_000, user: { login: "gus" }, state: "APPROVED" }],
		});
		const summary = await watchScenario(await tempHome(), new Faults(), {
			answer: pullRequest(world, asked),
			clicks: ["k1", "k2", "k3", "k4", "k5", "k6"],
		});
		expect(watchInvariants(summary)).toEqual([]);
		expect(summary.wakes.map((wake) => wake.changes)).toEqual([["gus approved"]]);
		expect(summary.tells).toEqual([]);
		// the baseline and four looks catch up, three pages each; then each look reads from the page before the last
		expect(asked.get_reviews).toEqual([1, 2, 3, 3, 4, 5, 5, 6, 7, 7, 8, 9, 9, 10, 11, 9, 10, 11, 9, 10, 11]);
	}, 60_000);
});
