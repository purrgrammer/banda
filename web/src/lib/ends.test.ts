import { describe, expect, it } from "vitest";
import { capEnds, commandEnds, pathEnds, suffixEnds } from "./ends.ts";

describe("where a line keeps its end", () => {
	it("keeps a path's file name, a trailing slash aside", () => {
		expect(pathEnds("web/src/chat/Cards.tsx")).toEqual({ head: "web/src/chat/", end: "Cards.tsx" });
		expect(pathEnds("en.wikipedia.org/wiki/")).toEqual({ head: "en.wikipedia.org/", end: "wiki/" });
		expect(pathEnds("README.md")).toEqual({ head: "", end: "README.md" });
	});

	it("keeps a command's last step, whichever separator starts it", () => {
		expect(commandEnds("npm test && git push origin main")).toEqual({
			head: "npm test ",
			end: "&& git push origin main",
		});
		expect(commandEnds("make build; ./deploy.sh")).toEqual({ head: "make build", end: "; ./deploy.sh" });
		expect(commandEnds("cat log.txt | grep error").end).toBe("| grep error");
		expect(commandEnds("npm test || echo failed").end).toBe("|| echo failed");
	});

	it("never splits a command at a separator inside quotes", () => {
		expect(commandEnds(`git commit -m "fix: a && b; c" && git push`).end).toBe("&& git push");
		expect(commandEnds(`echo 'a | b'`)).toEqual({ head: "", end: "echo 'a | b'" });
	});

	it("keeps a one-step command's last path part, as a path, or else what follows a cut", () => {
		expect(commandEnds("node scripts/sweep-boxes.ts")).toEqual({ head: "node scripts/", end: "sweep-boxes.ts" });
		expect(commandEnds("NODE_OPTIONS=x npm run…web --sourcemap")).toEqual({
			head: "NODE_OPTIONS=x npm run…",
			end: "web --sourcemap",
		});
		expect(commandEnds("npm run build:web")).toEqual({ head: "", end: "npm run build:web" });
	});

	it("keeps a short trailing mark, not a long last part", () => {
		expect(suffixEnds("e12 · hello there · submit")).toEqual({ head: "e12 · hello there", end: " · submit" });
		expect(suffixEnds(`e12 · ${"x".repeat(40)}`).end).toBe("");
	});
});

describe("a cap cuts the head, never the end", () => {
	it("leaves a line that fits as it is", () => {
		expect(capEnds({ head: "src/", end: "a.ts" }, 20)).toEqual({ head: "src/", end: "a.ts" });
	});

	it("cuts a long path's folders and keeps its file name whole", () => {
		const { head, end } = capEnds(pathEnds(`${"very/deep/".repeat(10)}Settled.tsx`), 40);
		expect(end).toBe("Settled.tsx");
		expect(head.endsWith("…")).toBe(true);
		expect((head + end).length).toBe(40);
	});

	it("cuts a long chain before its last step, which stays whole", () => {
		const chain = `npm ci && npm run build && npm run test -- --reporter verbose ${"--x ".repeat(20)}&& gh pr create --fill`;
		const { head, end } = capEnds(commandEnds(chain), 72);
		expect(end).toBe("&& gh pr create --fill");
		expect(head.startsWith("npm ci && npm run build")).toBe(true);
		expect(head.endsWith("…")).toBe(true);
		expect((head + end).length).toBe(72);
	});

	it("cuts an end too long to keep in its middle, so both of its ends read", () => {
		const { head, end } = capEnds({ head: "x/", end: `${"a".repeat(50)}.submit` }, 20);
		expect(head).toBe("");
		expect(end).toHaveLength(20);
		expect(end).toContain("…");
		expect(end.endsWith("submit")).toBe(true);
	});
});
