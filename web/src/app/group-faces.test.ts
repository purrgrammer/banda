import { expect, it } from "vitest";
import { groupFaces, noTandas } from "./group-faces.ts";

const reply = (entry: number, agent: string) => ({ entry, author: { agent } });
const log = (latest: number, messages: ReturnType<typeof reply>[] = []) => ({ latest, messages });

it("draws nothing before the log is read, and a face for each member at work after", () => {
	const tandas = noTandas();
	expect(groupFaces(tandas, undefined, ["mara"], 3)).toEqual([]);
	expect(groupFaces(tandas, log(3), ["mara", "sancho"], 3).map((face) => face.member)).toEqual(["mara", "sancho"]);
});

it("a member's next message takes the key of the face that stood for its work", () => {
	const tandas = noTandas();
	const [face] = groupFaces(tandas, log(3), ["mara"], 3);
	expect(groupFaces(tandas, log(4, [reply(4, "mara")]), [], 4)).toEqual([]);
	expect(tandas.taken.get(4)).toBe(face?.key);
});

it("what the log already held when the member started working is not its reply", () => {
	const tandas = noTandas();
	groupFaces(tandas, log(3, [reply(2, "mara")]), ["mara"], 3);
	expect(groupFaces(tandas, log(3, [reply(2, "mara")]), ["mara"], 3)).toHaveLength(1);
	expect(tandas.taken.size).toBe(0);
});

it("the face holds until the log caught up with the row, so it never blinks between the two", () => {
	const tandas = noTandas();
	groupFaces(tandas, log(3), ["mara"], 3);
	expect(groupFaces(tandas, log(3), [], 4)).toHaveLength(1);
	expect(groupFaces(tandas, log(4), [], 4)).toEqual([]);
});

it("a member who speaks and goes on working gets a new face at the foot", () => {
	const tandas = noTandas();
	const [first] = groupFaces(tandas, log(3), ["mara"], 3);
	const [next] = groupFaces(tandas, log(4, [reply(4, "mara")]), ["mara"], 4);
	expect(next?.key).not.toBe(first?.key);
	expect(tandas.taken.get(4)).toBe(first?.key);
});
