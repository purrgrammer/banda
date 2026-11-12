import { expect, it } from "vitest";
import { noneWorking, workingMembers } from "./working-members.ts";

const said = (entry: number, agent: string) => ({ entry, agent });
const log = (latest: number, shown: ReturnType<typeof said>[] = [], asking: string[] = []) => ({
	latest,
	shown,
	asking,
});

it("draws nobody before the log is read, and each member at work after, in the order they started", () => {
	const since = noneWorking();
	expect(workingMembers(since, undefined, ["mara"], 3)).toEqual([]);
	expect(workingMembers(since, log(3), ["mara"], 3)).toEqual(["mara"]);
	expect(workingMembers(since, log(3), ["sancho", "mara"], 3)).toEqual(["mara", "sancho"]);
});

it("drops a member as soon as its own content arrives, while it goes on working and the other stays", () => {
	const since = noneWorking();
	workingMembers(since, log(3), ["mara", "sancho"], 3);
	expect(workingMembers(since, log(4, [said(4, "mara")]), ["mara", "sancho"], 4)).toEqual(["sancho"]);
	expect(workingMembers(since, log(5, [said(4, "mara"), said(5, "sancho")]), ["mara", "sancho"], 5)).toEqual([]);
});

it("what a member said before it began is not its content now", () => {
	const since = noneWorking();
	expect(workingMembers(since, log(3, [said(2, "mara")]), ["mara"], 3)).toEqual(["mara"]);
});

it("an ask of its own in the feed is content too", () => {
	const since = noneWorking();
	workingMembers(since, log(3), ["mara"], 3);
	expect(workingMembers(since, log(3, [], ["mara"]), ["mara"], 3)).toEqual([]);
});

it("holds a member whose work ended until the log caught up with the row, then lets it go", () => {
	const since = noneWorking();
	workingMembers(since, log(3), ["mara"], 3);
	expect(workingMembers(since, log(3), [], 4)).toEqual(["mara"]);
	expect(workingMembers(since, log(4, [said(4, "mara")]), [], 4)).toEqual([]);
	expect(since.size).toBe(0);
});

it("a member that works again begins again: what it said last time does not hide it", () => {
	const since = noneWorking();
	workingMembers(since, log(3), ["mara"], 3);
	workingMembers(since, log(4, [said(4, "mara")]), [], 4);
	expect(workingMembers(since, log(5, [said(4, "mara")]), ["mara"], 5)).toEqual(["mara"]);
});
