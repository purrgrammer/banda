import fc from "fast-check";
import { assert, describe, expect, it } from "vitest";
import { pbtRuns } from "../../../test/pbt.ts";
import { activityCalls, activityEnd, activityWork, findActivity } from "./activity.ts";
import type { Item } from "./api.ts";

const user = (id: number): Item => ({ id, role: "user", text: `request ${id}` });
const answer = (id: number, call = `call:${id}`, final = false): Extract<Item, { role: "assistant" }> => ({
	id,
	role: "assistant",
	stop: final ? "stop" : "toolUse",
	text: final ? "sent" : "",
	calls: final ? [] : [{ id: call, name: "bash", args: { command: "pwd" } }],
});
const result = (id: number, call: string): Extract<Item, { role: "tool" }> => ({
	id,
	role: "tool",
	call,
	name: "bash",
	text: "/workspace",
	error: false,
});

describe("activity scopes", () => {
	it("puts an owner's pre-request skill round in the following message's Activity, not the preceding run", () => {
		const loaded: Extract<Item, { role: "tool" }> = {
			...result(4, "owner:skill"),
			name: "skill",
			receipt: {
				kind: "skill",
				name: "research",
				sha: "a".repeat(64),
				by: "owner",
				description: "Research",
				files: [],
			},
		};
		const works = activityWork([user(1), answer(2, undefined, true), loaded, user(5), answer(6, undefined, true)]);
		expect(works.map((work) => work.items.map((item) => item.id))).toEqual([
			[1, 2],
			[4, 5, 6],
		]);
		expect(findActivity(works, 5)?.items.some((item) => item.id === 4)).toBe(true);
	});
	it("keeps an early skill write out of a prior run's last answer and waits for its matching owner input", () => {
		const loaded: Extract<Item, { role: "tool" }> = {
			...result(4, "owner:skill"),
			name: "skill",
			receipt: {
				kind: "skill",
				name: "research",
				sha: "a".repeat(64),
				by: "owner",
				description: "Research",
				files: [],
				invocation: { gateway: "web", message: "later" },
			},
		};
		const later: Item = {
			id: 6,
			role: "user",
			text: "request 6",
			origin: { gateway: "web", peer: "owner" },
			message: "later",
		};
		const works = activityWork([
			user(1),
			answer(2),
			result(3, "call:2"),
			loaded,
			answer(5, undefined, true),
			later,
			answer(7, undefined, true),
		]);
		expect(works.map((work) => work.items.map(({ id }) => id))).toEqual([
			[1, 2, 3, 5],
			[4, 6, 7],
		]);
	});
	it("keeps a whole chain of model requests and steering together until a recorded final boundary", () => {
		const works = activityWork([
			user(1),
			answer(2),
			user(3),
			result(4, "call:2"),
			answer(5),
			result(6, "call:5"),
			answer(7, undefined, true),
			user(8),
			answer(9),
		]);
		expect(works.map((work) => work.items.map((item) => item.id))).toEqual([
			[1, 2, 3, 4, 5, 6, 7],
			[8, 9],
		]);
		expect(findActivity(works, 5)?.id).toBe(1);
		expect(findActivity(works, 9)?.id).toBe(8);
		expect(findActivity(works, 1000)).toBeUndefined();
	});
	it("uses the recorded active input, not the last input, while steering is still streaming", () => {
		const items = [user(1), answer(2), user(3), result(4, "call:2")];
		expect(activityWork(items, 1).map((work) => work.items.map((item) => item.id))).toEqual([[1, 2, 3, 4]]);
		expect(activityWork(items, 1)[0]?.active).toBe(true);
		expect(activityWork(items, 3).map((work) => [work.active === true, work.items.map((item) => item.id)])).toEqual([
			[false, [1, 2, 4]],
			[true, [3]],
		]);
	});
	it("finds the issuing entry even when words and provider ids repeat", () => {
		const works = activityWork([user(1), answer(2, "same"), answer(3, undefined, true), user(4), answer(5, "same")]);
		expect(findActivity(works, 2)?.id).toBe(1);
		expect(findActivity(works, 5)?.id).toBe(4);
	});
	it("pairs reused provider call ids by their recorded occurrence", () => {
		const work = activityWork([
			user(1),
			answer(2, "same"),
			result(3, "same"),
			answer(4, "same"),
			result(5, "same"),
			answer(6, undefined, true),
		])[0];
		assert(work);
		expect(activityCalls(work).map(({ result }) => result?.id)).toEqual([3, 5]);
	});
	it("reports recorded stops and failures rather than calling them finished", () => {
		const end = (items: Item[]) => {
			const work = activityWork(items)[0];
			assert(work);
			return activityEnd(work);
		};
		expect(end([user(1)])).toBe("No recorded answer");
		expect(end([user(1), { ...answer(2), stop: "aborted" }])).toBe("Stopped");
		expect(end([user(1), { ...answer(2), stop: "error", error: "provider failed" }])).toBe("Failed");
		expect(end([user(1), { ...answer(2), stop: "length" }])).toBe("Cut off");
		expect(
			end([
				user(1),
				answer(2),
				{ ...result(3, "call:2"), error: true, notes: [{ severity: "info", code: "aborted", text: "stopped" }] },
			]),
		).toBe("Stopped");
		expect(end([user(1), answer(2), { ...result(3, "call:2"), error: true }, answer(4, undefined, true)])).toBe(
			"Finished",
		);
	});
	it("ends stopped tool rounds and retains daemon instructions as records, not owner messages", () => {
		const aborted: Item = {
			...result(3, "call:2"),
			error: true,
			notes: [{ severity: "info", code: "aborted", text: "stopped" }],
		};
		const works = activityWork([
			user(1),
			answer(2),
			aborted,
			user(4),
			{ id: 5, role: "instruction", text: "daemon instruction" },
			answer(6),
		]);
		expect(works.map((work) => work.items.map((item) => item.id))).toEqual([
			[1, 2, 3],
			[4, 5, 6],
		]);
	});
	it("keeps every call, result and steered input exactly once across arbitrary tool chains", () => {
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 12 }), (sizes) => {
				const items: Item[] = [];
				let id = 1;
				const expected: number[][] = [];
				for (const size of sizes) {
					const ids: number[] = [];
					items.push(user(id));
					ids.push(id++);
					for (let n = 0; n < size; n++) {
						const call = `call:${id}`;
						items.push(answer(id, call));
						ids.push(id++);
						if (n % 2 === 0) {
							items.push(user(id));
							ids.push(id++);
						}
						items.push(result(id, call));
						ids.push(id++);
					}
					items.push(answer(id, undefined, true));
					ids.push(id++);
					expected.push(ids);
				}
				const works = activityWork(items);
				expect(works.map((work) => work.items.map((item) => item.id))).toEqual(expected);
				for (const [n, ids] of expected.entries())
					for (const entry of ids) expect(findActivity(works, entry)?.id).toBe(works[n]?.id);
			}),
			{ numRuns: pbtRuns(100) },
		);
	});
});
