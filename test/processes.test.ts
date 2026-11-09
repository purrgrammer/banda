import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ listing: "" }));
vi.mock("node:child_process", () => ({ execFileSync: () => state.listing }));

import { killGroups, treeGroups } from "../src/core/processes.ts";

afterEach(() => vi.restoreAllMocks());
it("does not kill an unrelated process after a remembered process group number is reused", () => {
	state.listing = "100 1 100 Thu Nov  5 10:00:00 2026\n101 100 100 Thu Nov  5 10:00:01 2026";
	const groups = treeGroups(100);
	state.listing = "100 1 100 Thu Nov  5 11:00:00 2026\n102 100 100 Thu Nov  5 11:00:01 2026";
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	killGroups(groups);
	expect(kill).not.toHaveBeenCalled();
});
it("cleans a detached group only while an observed member still anchors its identity", () => {
	state.listing =
		"100 1 100 Thu Nov  5 10:00:00 2026\n101 100 101 Thu Nov  5 10:00:01 2026\n102 101 101 Thu Nov  5 10:00:01 2026";
	const groups = treeGroups(100);
	state.listing = "102 1 101 Thu Nov  5 10:00:01 2026\n103 102 101 Thu Nov  5 10:00:02 2026";
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	killGroups(groups);
	expect(kill.mock.calls.map(([pid]) => pid)).toEqual([102, 103]);
});
