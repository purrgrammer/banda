/**
 * A watch on a pull request, driven through its life: the same scenario for the unit test (no faults) and the fault
 * worker (thrown faults and kills). GitHub is a double answering the reads from a scripted world the driver advances
 * (`world.json` in the home): open with checks running; then approved by ana, lint failed and a comment of the
 * account's own; then the same again; then merged. The watch is accepted as the owner's own, its task takes the first
 * look (the baseline), and the owner checks now at each step of the world. Every step is done only if the store does
 * not hold it yet, as the owner would look and click again after a kill. Prints what happened.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ConversationId, createRegistry, type SetTimer, type TaskId } from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { Connected } from "../../src/core/connections.ts";
import type { Json } from "../../src/core/follow.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import { Readings } from "../../src/core/objects.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes, type TurnResult } from "../../src/core/turn.ts";
import {
	Followed,
	TELL,
	WAKE,
	Watches,
	type WatchRecord,
	type WatchWakeData,
	watchPath,
} from "../../src/core/watches.ts";
import { githubObjectFile } from "../fixtures/github-objects.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { echoModels, FAUX_MODEL } from "../fixtures/models.ts";
import type { Faults } from "./faults.ts";

/** Monday 2 November 2026, 09:00. */
export const NOW = new Date(2026, 10, 2, 9, 0).getTime();
export const WATCH =
	"---\nobject: https://github.com/acme/banda/pull/142\naccount: bandarra\n---\nTell me when it is approved or a check fails.\n";
export const CLICKS = ["k1", "k2", "k3"];

type World = { [read: string]: Json };

/** The world at each step: what GitHub answers each read of the pull request. */
export function world(step: number): World {
	const pr: { [key: string]: Json } = {
		number: 142,
		title: "Keep objects as data",
		state: "open",
		draft: false,
		merged: false,
		user: { login: "ana" },
		head: { ref: "objects", sha: "a1" },
		additions: 42,
		deletions: 6,
		html_url: "https://github.com/acme/banda/pull/142",
	};
	const checks = {
		total_count: 2,
		check_runs: [
			{ id: 10, name: "unit", status: "completed", conclusion: "success" },
			{ id: 11, name: "lint", status: "in_progress", conclusion: null },
		] as { [key: string]: Json }[],
	};
	const reviews: Json[] = [];
	const comments: Json[] = [];
	if (step >= 1) {
		reviews.push({ id: 1, user: { login: "ana" }, state: "APPROVED" });
		comments.push({ id: 5, user: { login: "bandarra" }, body: "thanks" });
		(checks.check_runs[1] as { [key: string]: Json }).status = "completed";
		(checks.check_runs[1] as { [key: string]: Json }).conclusion = "failure";
		// every push gives check runs new ids: keyed by name, that is noise
		(checks.check_runs[1] as { [key: string]: Json }).id = 99;
	}
	if (step >= 3) {
		pr.merged = true;
		pr.state = "closed";
	}
	return { get: pr, get_check_runs: checks, get_reviews: reviews, get_comments: comments };
}

export type WatchSummary = {
	record: WatchRecord;
	/** The second watch's record, when the scenario had one. */
	second?: WatchRecord;
	task?: { status: string };
	followed?: { version: number; at: number };
	card?: { state?: string };
	wakes: WatchWakeData[];
	tells: WatchWakeData[];
	turns: ({ status: string } | undefined)[];
	sent: string[];
	parked: readonly unknown[];
	/** How many reads were made, and how many looks passed `watch:read`. */
	reads: number;
	looks: number;
	commits: number;
	models: number;
};

/** The watches on the pull request: Mara's, and, with `second`, Otto's on the same object as the same account. */
export const WATCHES = ["banda-142", "banda-142-otto"] as const;

export async function watchScenario(
	home: string,
	faults: Faults,
	options: { readonly second?: boolean } = {},
): Promise<WatchSummary> {
	const names = options.second ? WATCHES : WATCHES.slice(0, 1);
	const worldFile = join(home, "world.json");
	const stepOf = () => {
		try {
			return Number(readFileSync(worldFile, "utf8"));
		} catch {
			return 0;
		}
	};
	const setTimer: SetTimer = (callback, delay, { background }) => {
		const timer = setTimeout(callback, Math.max(0, Math.min(delay, 5)));
		if (background) timer.unref();
		return () => clearTimeout(timer);
	};
	let sends = 0;
	const gateway: Gateway = {
		name: "fake",
		strength: "bearer",
		can: { buttons: false, files: false, threads: true },
		start() {},
		async send(_to, out) {
			faults.hit("send:before");
			appendFileSync(join(home, "sent.jsonl"), `${JSON.stringify(out.text ?? "")}\n`);
			faults.hit("send:after");
			return `out-${process.pid}-${++sends}`;
		},
	};
	const box = openBox(hostBox(home), () => {});
	const core = defineCore({
		blobs: new BlobStore(join(home, "blobs")),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
		now: () => NOW,
		agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
		workspace: () => box.workspace,
		// GitHub, as the world stands: the reads of the followed pull request, each counted
		read: async (_connection, account, tool, args) => {
			appendFileSync(join(home, "reads.jsonl"), `${JSON.stringify({ tool, account, method: args.method })}\n`);
			if (tool !== "pull_request_read" || account !== "bandarra") return { failed: "not that" };
			const answer = world(stepOf())[String(args.method)];
			return answer === undefined ? { failed: `no ${String(args.method)}` } : { text: JSON.stringify(answer) };
		},
		fault: (point) => faults.hit(point as "watch:read"),
	});
	const { models } = echoModels(faults);
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	const harness = await openStore(home, {
		models,
		registry,
		env: boxEnv(box),
		now: () => NOW,
		setTimer,
		wrapStorage: (storage) => faults.storage(storage),
	});
	harness.resume();
	try {
		// the connection, the agent and the account, as a signed-in GitHub leaves them; the watch, allowed once
		const file = githubObjectFile("https://example.com/mcp");
		await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			if (accepted.files["connections/github.md"] !== undefined) return;
			accepted.files["connections/github.md"] = { sha: shaOf(file), text: file, at: NOW };
			const agent =
				"---\nname: Mara\ndescription: Follows things\nconnections: [github]\n---\nFollow things for the owner.";
			accepted.files["agents/mara.md"] = { sha: shaOf(agent), text: agent, at: NOW };
			const connected = await tx.doc(Connected);
			connected.connections.github = {
				sha: shaOf(file),
				at: NOW,
				tools: {
					pull_request_read: {
						description: "read",
						schema: {
							type: "object",
							properties: { method: { type: "string" }, pullNumber: { type: "integer" } },
						},
					},
				},
			};
			connected.accounts.github = { bandarra: { id: "bandarra", at: NOW } };
			connected.on.mara = { github: ["bandarra"] };
			accepted.files[watchPath("banda-142")] = { sha: shaOf(WATCH), text: WATCH, at: NOW };
			(await tx.doc(Watches)).watches["banda-142"] = { agent: "mara", since: NOW };
			if (options.second) {
				// a second agent follows the same pull request as the same account: one reading, two watches
				const otto = "---\nname: Otto\ndescription: Also follows\nconnections: [github]\n---\nFollow things too.";
				accepted.files["agents/otto.md"] = { sha: shaOf(otto), text: otto, at: NOW };
				connected.on.otto = { github: ["bandarra"] };
				accepted.files[watchPath("banda-142-otto")] = { sha: shaOf(WATCH), text: WATCH, at: NOW };
				(await tx.doc(Watches)).watches["banda-142-otto"] = { agent: "otto", since: NOW };
			}
		}, context);
		// as the daemon does on start: the task, whose first look is the baseline
		await core.reconcile(harness);
		const looked = async () => {
			const records = (await harness.snapshot(Watches, context))?.watches ?? {};
			return names.every((name) => records[name]?.looked !== undefined);
		};
		while (!(await looked())) await new Promise((r) => setTimeout(r, 5));
		// the world moves on, and the owner checks now at each step: the same click, sent again after a kill
		for (const [i, key] of CLICKS.entries()) {
			const step = i + 1;
			if (stepOf() < step) writeFileSync(worldFile, String(step));
			for (const name of names) await core.checkWatch(harness, name, key);
		}
		const idle = async () => {
			const graph = await harness.taskGraph(context);
			const busy = Object.values(graph.value.tasks).some(
				(task) => task.kind !== "banda.watch" && task.kind !== "banda.routine",
			);
			graph.dispose();
			return !busy;
		};
		while (!(await idle())) await new Promise((r) => setTimeout(r, 5));
		const routes: Record<string, { chat: number }> = (await harness.snapshot(Routes, context))?.routes ?? {};
		const wakes: WatchWakeData[] = [];
		const tells: WatchWakeData[] = [];
		for (const { chat } of Object.values(routes)) {
			const page = await (await harness.conversation(chat as ConversationId, context))!.entries(
				{ order: "ascending" },
				1000,
				undefined,
				context,
			);
			for (const entry of page.items) {
				if (entry.kind === WAKE) wakes.push(entry.data as unknown as WatchWakeData);
				if (entry.kind === TELL) tells.push(entry.data as unknown as WatchWakeData);
			}
		}
		const turns = await harness.commit(async (tx) => {
			const found = [];
			let cursor: Parameters<typeof tx.scanTasks>[2];
			do {
				const page = await tx.scanTasks({ kind: "banda.turn" }, 100, cursor);
				found.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			return found.map((task) => (task.state as { outcome?: { status: string; result?: TurnResult } }).outcome);
		}, context);
		const records = (await harness.snapshot(Watches, context))?.watches ?? {};
		const record = records["banda-142"] ?? {};
		const task = record.task === undefined ? undefined : await harness.getTask(record.task as TaskId, context);
		const second = records["banda-142-otto"];
		const followed = (await harness.snapshot(Followed, context))?.objects[
			"github/bandarra/pull_request:acme/banda#142"
		];
		const card = (await harness.snapshot(Readings, context))?.readings["github/bandarra/pull_request:acme/banda#142"]
			?.card as { state?: string } | undefined;
		return {
			record,
			...(second === undefined ? {} : { second }),
			...(task === undefined ? {} : { task: { status: task.state.status } }),
			...(followed === undefined ? {} : { followed: { version: followed.version, at: followed.at } }),
			...(card === undefined ? {} : { card: { ...(card.state === undefined ? {} : { state: card.state }) } }),
			wakes,
			tells,
			turns,
			sent: readFileSync(join(home, "sent.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean),
			parked: (await status(harness)).parked,
			reads: readFileSync(join(home, "reads.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").filter(Boolean)
				.length,
			looks: faults.hits("watch:read"),
			commits: faults.hits("commit:after"),
			models: faults.hits("model"),
		};
	} finally {
		box.close();
		await harness.close(context).catch(() => {});
	}
}

/**
 * What must hold however the process was killed: the baseline woke nobody; the approval and the failed check woke the
 * agent once, with the account's own comment unseen and the finished checks told beside; the same reading again woke
 * nobody; the merge woke once more and ended the watch; each wake's run ended and reached the owner; nothing is parked.
 */
export function watchProblems(summary: WatchSummary): string[] {
	const errors: string[] = [];
	const say = (what: string, ok: boolean) => {
		if (!ok) errors.push(what);
	};
	// each watch on the object sees every change, whoever looked first: one reading, a cursor per watch
	const watches = summary.second === undefined ? [summary.record] : [summary.record, summary.second];
	const names = summary.second === undefined ? WATCHES.slice(0, 1) : WATCHES;
	for (const [i, name] of names.entries()) {
		const wakes = summary.wakes.filter((wake) => wake.watch === name);
		const record = watches[i] as WatchRecord;
		say(`${name}: two wakes, got ${wakes.length}`, wakes.length === 2);
		const [first, last] = wakes;
		say(
			`${name}: the first wake says what changed`,
			[...(first?.changes ?? [])].sort().join(", ") === "ana approved, checks finished, lint failed",
		);
		say(`${name}: the first wake ends nothing`, first?.ended === undefined);
		say(
			`${name}: the last wake says merged and ends the watch`,
			last?.ended === "merged" && (last?.changes ?? []).includes("merged"),
		);
		say(`${name}: the watch is done: merged`, record.done?.why === "merged");
		say(`${name}: every click was taken once`, JSON.stringify(record.checked) === JSON.stringify(CLICKS));
	}
	say(
		"no change of the account's own woke",
		!summary.wakes.some((wake) => wake.changes.some((c) => c.includes("bandarra"))),
	);
	say("done, it has no live task", summary.task === undefined || summary.task.status === "terminal");
	// a look a kill cut short is made again: a reading the same as the newest is no new version, never a second wake
	say("the reading kept is the newest: three that differed", summary.followed?.version === 3);
	say("the card is the newest reading", summary.card?.state === "merged");
	say("no tell beside the wakes", summary.tells.length === 0);
	say(`${2 * names.length} runs, got ${summary.turns.length}`, summary.turns.length === 2 * names.length);
	for (const turn of summary.turns) say("a run ended", turn?.status === "completed");
	// sends are at least once: a kill after the bytes went and before the store heard sends them again
	say(
		"the first wake reached the owner",
		summary.sent.some((text) => text.includes("ana approved")),
	);
	say(
		"the last wake reached the owner",
		summary.sent.some((text) => text.includes("merged")),
	);
	say("nothing is parked", summary.parked.length === 0);
	return errors;
}
