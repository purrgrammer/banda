/** The band's rows from the daemon's chats and groups: one per agent and group, newest first; the tab counts asks first. */
import { describe, expect, it } from "vitest";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import type { ChatRow, GroupRow } from "../src/server/api.ts";
import { bandRows, titleOf } from "../web/src/app/band.ts";

const NOW = Date.parse("2026-11-03T12:00:00");
const agents = [
	{ id: "sancho", name: "Sancho", face: defaultAvatarFace() },
	{ id: "mara", name: "Mara", face: { ...defaultAvatarFace(), color: "#c79267" } },
];
const chat = (agent: string, at: number, more: Partial<ChatRow> = {}): ChatRow => ({
	chat: agent === "mara" ? 2 : 1,
	origin: { gateway: "web", peer: "owner", thread: agent === "sancho" ? "main" : `agent:${agent}` },
	agent,
	title: "",
	state: "idle",
	unanswered: 0,
	unread: 0,
	read: 0,
	at,
	...more,
});

describe("band rows", () => {
	it("lists every agent, its newest words, an open ask and unread, newest first", () => {
		const rows = bandRows(
			agents,
			[
				chat("mara", NOW - 60_000, {
					excerpt: "Three fit.",
					by: "agent",
					said: NOW - 60_000,
					unread: 2,
					ask: "Book the 9:15?",
					state: "waiting",
				}),
			],
			[],
			false,
			NOW,
		);
		expect(rows.map((row) => row.name)).toEqual(["Mara", "Sancho"]);
		expect(rows[0]).toMatchObject({ excerpt: "Three fit.", unread: 2, ask: "Book the 9:15?", state: "waiting" });
		expect(rows[1]).toMatchObject({
			excerpt:
				"Hi, I'm Sancho. Ask me anything: I can read the web, write, plan and keep track of things for you, and wake up on a schedule to check on something.",
			time: "",
		});
		expect(titleOf(rows)).toBe("(1 waiting, 2 unread) banda");
	});

	it("moves a row only when something reached the owner, never on a run's own steps", () => {
		const rows = bandRows(
			agents,
			[
				// Mara worked a moment ago, but the last thing that reached the owner is older than Sancho's
				chat("mara", NOW - 1000, { excerpt: "Three fit.", by: "agent", said: NOW - 600_000 }),
				chat("sancho", NOW - 300_000, { excerpt: "Done.", by: "agent", said: NOW - 300_000 }),
			],
			[],
			false,
			NOW,
		);
		expect(rows.map((row) => row.name)).toEqual(["Sancho", "Mara"]);
	});

	it("puts an agent the owner just made, which has said nothing yet, before older chats", () => {
		const made = [
			...agents,
			{ id: "rosa", name: "Rosa", face: { ...defaultAvatarFace(), color: "#67a98c" }, since: NOW - 5_000 },
		];
		const rows = bandRows(
			made,
			[chat("mara", NOW - 60_000, { excerpt: "Three fit.", by: "agent", said: NOW - 60_000 })],
			[],
			false,
			NOW,
		);
		expect(rows.map((row) => row.name)).toEqual(["Rosa", "Mara", "Sancho"]);
		expect(rows[0]?.excerpt).toMatch(/^Hi, I'm Rosa\./);
	});

	it("lists a group with its members' faces, who spoke last and its unread", () => {
		const group: GroupRow = {
			room: 7,
			name: "Trip",
			members: ["sancho", "mara"],
			working: ["mara"],
			at: NOW - 3_600_000,
			latest: 9,
			last: { entry: 9, author: { agent: "sancho" }, text: "Saturday works", mentions: [], at: NOW - 1000 },
			executions: {},
			asking: [],
			read: 0,
			unread: 1,
		};
		const [row] = bandRows(agents, [], [group], false, NOW);
		expect(row).toMatchObject({
			name: "Trip",
			by: "Sancho",
			excerpt: "Saturday works",
			unread: 1,
			to: { name: "group", room: 7 },
		});
		expect(row?.faces).toEqual([
			{ ...agents[0], paused: false },
			{ ...agents[1], paused: false, state: "working" },
		]);
	});
});
