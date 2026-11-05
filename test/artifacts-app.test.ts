/**
 * Artifacts in the app (DESIGN.md "The app"): a published version as its card after the message, named by the
 * Library and never by the model's words alone; the owner's version as their own card; a table from its CSV; a page's
 * document, its policy first, so inline interactions can run without reaching anything outside the page.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArtifactView, Item } from "../src/server/api.ts";
import { FRAME_POLICY } from "../src/server/policy.ts";
import { PAGE_POLICY, pageDocument, parseCsv } from "../web/src/lib/artifacts.ts";
import { view } from "../web/src/lib/chat.ts";

const library: ArtifactView[] = [
	{
		id: "a1",
		title: "Lisbon trip plan",
		path: "/workspace/plan.md",
		mimeType: "text/markdown",
		kind: "markdown",
		versions: [
			{ n: 1, sha: "1".repeat(64), size: 1, at: 1, by: "companion", chat: 3, call: "c1" },
			{
				n: 2,
				sha: "2".repeat(64),
				size: 1,
				at: 2,
				by: "owner",
				said: "Edited “Lisbon trip plan” (v2)",
				box: "written",
			},
		],
		published: { "3:c1": 1, "4:c1": 1 },
		chat: 3,
		at: 2,
	},
];

const items: Item[] = [
	{ id: 1, role: "user", text: "plan the trip", at: 1 },
	{
		id: 2,
		role: "assistant",
		text: "",
		at: 1,
		calls: [
			{ id: "c1", name: "message_user", args: { text: "Here it is.", artifact: { path: "plan.md", title: "Trip" } } },
		],
	},
	{ id: 3, role: "tool", call: "c1", name: "message_user", text: "Sent.", error: false, at: 1 },
	{ id: 4, role: "user", text: "Edited “Lisbon trip plan” (v2)", at: 2, artifact: { id: "a1", n: 2 } },
];

const live = { busy: false, running: [], thinking: false };

describe("artifacts in the app", () => {
	it("a published version is its card after the message, named by the Library; the owner's version is theirs", () => {
		const segments = view(items, [], live, { artifacts: { chat: 3, library } });
		// the owner's words are the tasks area's own kind once it has passed
		expect(segments.map((segment) => segment.kind)).toEqual(["owner-message", "companion", "artifact", "artifact"]);
		expect(segments[2]).toMatchObject({
			by: "companion",
			id: "a1",
			n: 1,
			title: "Lisbon trip plan",
			artifactKind: "markdown",
		});
		expect(segments[3]).toMatchObject({ by: "owner", id: "a1", n: 2, title: "Lisbon trip plan" });
		// another chat's call of the same id is not this one's: its card names what the call said, and opens nothing
		const elsewhere = view(items, [], live, { artifacts: { chat: 5, library } });
		expect(elsewhere[2]).toMatchObject({ title: "Trip" });
		expect(elsewhere[2]).not.toHaveProperty("id");
		expect(view(items, [], live)[2]).not.toHaveProperty("id");
	});

	it("the owner's card is matched to its version by the entry's {id, n}, never by its words", () => {
		const second: ArtifactView = {
			...library[0]!,
			id: "b2",
			path: "/workspace/work/plan.md",
			published: {},
		};
		const twice: Item[] = [
			{ id: 4, role: "user", text: "Edited “Lisbon trip plan” (v2)", at: 2, artifact: { id: "a1", n: 2 } },
			{ id: 5, role: "user", text: "Edited “Lisbon trip plan” (v2)", at: 3, artifact: { id: "b2", n: 2 } },
			// the owner typing the same words is their message, not a card
			{ id: 6, role: "user", text: "Edited “Lisbon trip plan” (v2)", at: 4 },
		];
		const segments = view(twice, [], live, { artifacts: { chat: 3, library: [library[0]!, second] } });
		expect(segments.map((segment) => (segment.kind === "artifact" ? segment.id : segment.kind))).toEqual([
			"a1",
			"b2",
			"owner-message",
		]);
	});

	it("a card whose artifact was removed from the Library says so; one still publishing waits", () => {
		const removed = view(items, [], live, { artifacts: { chat: 3, library: [] } });
		expect(removed[2]).toMatchObject({ kind: "artifact", by: "companion", removed: true });
		expect(removed[2]).not.toHaveProperty("id");
		expect(removed[3]).toMatchObject({ kind: "artifact", by: "owner", removed: true });
		expect(removed[3]).not.toHaveProperty("id");
		// its call has not ended: publishing, not removed
		const publishing = view(
			items.filter((item) => item.role !== "tool"),
			[],
			live,
			{ artifacts: { chat: 3, library: [] } },
		);
		expect(publishing.find((segment) => segment.kind === "artifact")).not.toHaveProperty("removed");
	});

	it("a refused publish is a refused card", () => {
		const refused = items.map(
			(item): Item =>
				item.role === "tool" ? { ...item, error: true, text: "Not sent: plan.md: it is a link or not a file." } : item,
		);
		expect(view(refused, [], live).find((segment) => segment.kind === "artifact")).toMatchObject({ failed: true });
	});

	it("a page's frame navigates nowhere: the app's policy loads no frame, from the daemon and the dev server alike", async () => {
		expect(FRAME_POLICY).toBe("frame-src 'none'");
		// the daemon's whole policy is in web.test.ts; the dev server sends the frame's part of it
		const { default: config } = await import("../web/vite.config.ts");
		expect(config.server?.headers?.["content-security-policy"]).toBe(FRAME_POLICY);
	});

	it("a CSV parses with quotes, doubled quotes and both line ends", () => {
		expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([
			["a", "b, c", 'd "e"'],
			["1", "2", "3"],
		]);
		expect(parseCsv("x\ny")).toEqual([["x"], ["y"]]);
		expect(parseCsv("")).toEqual([]);
	});

	it("a page's policy comes before anything of its own: inline interactions run, but nothing loads or leaves", () => {
		const page = pageDocument(
			'<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src *"><script>1</script>',
		);
		expect(page.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">`)).toBe(
			true,
		);
		expect(page.match(/<!doctype/gi)).toHaveLength(1);
		expect(PAGE_POLICY).toMatch(/default-src 'none'/);
		expect(PAGE_POLICY).toMatch(/script-src 'unsafe-inline'/);
		expect(PAGE_POLICY).not.toMatch(/'unsafe-eval'|'self'|http:/);
		expect(PAGE_POLICY).toMatch(/img-src data: https:;/);
		const preview = readFileSync(new URL("../web/src/components/ai-elements/web-preview.tsx", import.meta.url), "utf8");
		expect(preview).toContain('sandbox="allow-scripts"');
		expect(preview).not.toContain('sandbox="allow-scripts allow-same-origin"');
	});
});
