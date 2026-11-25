import { describe, expect, it } from "vitest";
import { announceOf, stateWordsOf } from "./Harness.tsx";

describe("a coding session's state in words", () => {
	it("says work running on past its turn, and a session closed with its turn takes its time like a done one", () => {
		expect(stateWordsOf("working", "2:05")).toBe("Working 2:05");
		expect(stateWordsOf("working", "2:05", 2)).toBe("Working in background 2:05");
		expect(stateWordsOf("closed", "0:03")).toBe("Took 0:03");
		expect(announceOf("closed", "Codex")).toBe("Codex ended its turn");
		expect(announceOf("done", "Claude Code")).toBe("Claude Code finished");
	});
});
