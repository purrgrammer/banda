/**
 * Artifacts in the app (DESIGN.md "The app"): a published version as its card after the message, named by the
 * Library and never by the model's words alone; the owner's version as their own card; a table from its CSV; a page's
 * document, its policy first, so inline interactions can run without reaching anything outside the page.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArtifactView, Item } from "../src/server/api.ts";
import { APP_POLICY, FRAME_POLICY, SERVED_POLICY } from "../src/server/policy.ts";
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
			{ id: "m1", name: "message_user", args: { text: "Here it is." } },
			{ id: "c1", name: "publish", args: { path: "plan.md", title: "Trip" } },
		],
	},
	{
		id: 3,
		role: "tool",
		call: "c1",
		name: "publish",
		text: "Published as version 1; its id is a1.",
		error: false,
		at: 1,
	},
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

	it("a message showing an artifact again draws its card at the version its receipt names, and none once removed", () => {
		const again: Item[] = [
			{ id: 1, role: "user", text: "the plan again?", at: 1 },
			{
				id: 2,
				role: "assistant",
				text: "",
				at: 1,
				calls: [{ id: "s1", name: "message_user", args: { text: "Here it is.", artifacts: ["a1"] } }],
			},
			{
				id: 3,
				role: "tool",
				call: "s1",
				name: "message_user",
				text: "Sent.",
				error: false,
				at: 1,
				receipt: { kind: "artifacts", artifacts: [{ id: "a1", n: 1 }] },
			},
		];
		const segments = view(again, [], live, { artifacts: { chat: 3, library } });
		expect(segments.map((segment) => segment.kind)).toEqual(["owner-message", "companion", "artifact"]);
		// the version it showed, though the Library's newest is 2
		expect(segments[2]).toMatchObject({ by: "companion", id: "a1", n: 1, title: "Lisbon trip plan", shown: true });
		const removed = view(again, [], live, { artifacts: { chat: 3, library: [] } })[2];
		expect(removed).toMatchObject({ kind: "artifact", removed: true });
		expect(removed).not.toHaveProperty("id");
		// not sent: no card
		const refused = again.map((item) => (item.role === "tool" ? { ...item, error: true } : item));
		expect(view(refused, [], live, { artifacts: { chat: 3, library } }).map((segment) => segment.kind)).not.toContain(
			"artifact",
		);
	});

	it("a message showing what its own run just published, at that very version, draws no second card", () => {
		const plans: ArtifactView[] = [
			{
				...library[0]!,
				versions: [
					{ n: 1, sha: "1".repeat(64), size: 1, at: 1, by: "companion", chat: 3, call: "p1" },
					{ n: 2, sha: "2".repeat(64), size: 1, at: 2, by: "companion", chat: 3, call: "p2" },
				],
				published: { "3:p1": 1, "3:p2": 2 },
			},
			{ ...library[0]!, id: "b2", title: "Budget", path: "/workspace/budget.md", versions: [], published: {} },
		];
		const publish = (id: number, call: string): Item[] => [
			{ id, role: "assistant", text: "", at: id, calls: [{ id: call, name: "publish", args: { path: "plan.md" } }] },
			{ id: id + 1, role: "tool", call, name: "publish", text: "Published.", error: false, at: id },
		];
		const show = (id: number, call: string, shown: { id: string; n: number }[]): Item[] => [
			{
				id,
				role: "assistant",
				text: "",
				at: id,
				calls: [{ id: call, name: "message_user", args: { text: "Here.", artifacts: shown.map((one) => one.id) } }],
			},
			{
				id: id + 1,
				role: "tool",
				call,
				name: "message_user",
				text: "Sent.",
				error: false,
				at: id,
				receipt: { kind: "artifacts", artifacts: shown },
			},
		];
		const cards = (items: Item[]) =>
			view(items, [], live, { artifacts: { chat: 3, library: plans } }).flatMap((segment) =>
				segment.kind === "artifact" ? [`${segment.id}:${segment.n}${segment.shown === true ? " again" : ""}`] : [],
			);
		const asked = (id: number): Item => ({ id, role: "user", text: "and?", at: id });
		// published then shown in one run: the publish's card alone; another artifact it shows beside it stays
		expect(cards([asked(1), ...publish(2, "p1"), ...show(4, "s1", [{ id: "a1", n: 1 }])])).toEqual(["a1:1"]);
		expect(
			cards([
				asked(1),
				...publish(2, "p1"),
				...show(4, "s1", [
					{ id: "a1", n: 1 },
					{ id: "b2", n: 1 },
				]),
			]),
		).toEqual(["a1:1", "b2:1 again"]);
		// a newer version published since in the run: the newest card is the one it shows
		expect(cards([asked(1), ...publish(2, "p1"), ...publish(4, "p2"), ...show(6, "s1", [{ id: "a1", n: 2 }])])).toEqual(
			["a1:1", "a1:2"],
		);
		// the same version shown after the owner wrote again, or by a routine's later run: shown on purpose
		expect(cards([asked(1), ...publish(2, "p1"), asked(4), ...show(5, "s1", [{ id: "a1", n: 1 }])])).toEqual([
			"a1:1",
			"a1:1 again",
		]);
		const wake: Item = { id: 4, role: "wake", routine: "daily", text: "Daily", at: 4 };
		expect(cards([asked(1), ...publish(2, "p1"), wake, ...show(5, "s1", [{ id: "a1", n: 1 }])])).toEqual([
			"a1:1",
			"a1:1 again",
		]);
		// an older version than the run published: not the card it drew
		expect(cards([asked(1), ...publish(2, "p2"), ...show(4, "s1", [{ id: "a1", n: 1 }])])).toEqual([
			"a1:2",
			"a1:1 again",
		]);
		// shown before the publish that drew it: both, in their order
		expect(cards([asked(1), ...show(2, "s1", [{ id: "a1", n: 1 }]), ...publish(4, "p1")])).toEqual([
			"a1:1 again",
			"a1:1",
		]);
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

	it("the built app carries its own policy, so the phone's shell, which sends no header, holds to it too", async () => {
		const { policyMeta } = await import("../web/vite.config.ts");
		const transform = policyMeta().transformIndexHtml as (html: string) => string;
		const html = transform('<head>\n<meta charset="utf-8" />\n<script src="/a.js"></script>');
		const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_POLICY}" />`;
		expect(html.indexOf(meta)).toBeGreaterThan(html.indexOf("charset"));
		expect(html.indexOf(meta)).toBeLessThan(html.indexOf("<script"));
		expect(APP_POLICY).toContain(FRAME_POLICY);
		expect(SERVED_POLICY).toBe(`${APP_POLICY}; frame-ancestors 'none'`);
		expect(() => transform("<head></head>")).toThrow();
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
