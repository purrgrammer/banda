import { expect, it } from "vitest";
import { groupFaces, noFaceKeys } from "./group-faces.ts";

const reply = (entry: number, agent: string) => ({ entry, author: { agent } });
const log = (latest: number, messages: ReturnType<typeof reply>[] = []) => ({ latest, messages });

it("draws nothing before the log is read, and a face for each member at work after", () => {
	const keys = noFaceKeys();
	expect(groupFaces(keys, undefined, ["mara"], 3)).toEqual([]);
	expect(groupFaces(keys, log(3), ["mara", "sancho"], 3).map((face) => face.member)).toEqual(["mara", "sancho"]);
});

it("a member's next message takes the key of the face that stood for its work", () => {
	const keys = noFaceKeys();
	const [face] = groupFaces(keys, log(3), ["mara"], 3);
	expect(groupFaces(keys, log(4, [reply(4, "mara")]), [], 4)).toEqual([]);
	expect(keys.taken.get(4)).toBe(face?.key);
});

it("what the log already held when the member started working is not its reply", () => {
	const keys = noFaceKeys();
	groupFaces(keys, log(3, [reply(2, "mara")]), ["mara"], 3);
	expect(groupFaces(keys, log(3, [reply(2, "mara")]), ["mara"], 3)).toHaveLength(1);
	expect(keys.taken.size).toBe(0);
});

it("the face holds until the log caught up with the row, so it never blinks between the two", () => {
	const keys = noFaceKeys();
	groupFaces(keys, log(3), ["mara"], 3);
	expect(groupFaces(keys, log(3), [], 4)).toHaveLength(1);
	expect(groupFaces(keys, log(4), [], 4)).toEqual([]);
});

it("a member who speaks and goes on working gets a new face at the foot", () => {
	const keys = noFaceKeys();
	const [first] = groupFaces(keys, log(3), ["mara"], 3);
	const [next] = groupFaces(keys, log(4, [reply(4, "mara")]), ["mara"], 4);
	expect(next?.key).not.toBe(first?.key);
	expect(keys.taken.get(4)).toBe(first?.key);
});
