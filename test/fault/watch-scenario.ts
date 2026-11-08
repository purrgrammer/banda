/**
 * A watch on a pull request, driven through its life: the same scenario for the unit test (no faults) and the fault
 * worker (thrown faults and kills). GitHub is a double answering the reads from a scripted world the driver advances
 * (`world.json` in the home): open with checks running; then approved by ana, lint failed and a comment of the
 * account's own; then the same again; then merged. Any other connection's object is driven the same way: its file, its
 * listed tools, the account and an `answer` per read by tool name (`ScenarioOptions.connection`, `answer`). The watch is accepted as the owner's own, its task takes the first
 * look (the baseline), and the owner checks now at each step of the world. Every step is done only if the store does
 * not hold it yet, as the owner would look and click again after a kill. Prints what happened.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ConversationId,
	createRegistry,
	type Harness,
	type JsonObject,
	type SetTimer,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openBox } from "../../src/box/box.ts";
import { boxEnv, boxTools } from "../../src/box/tools.ts";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { accountKey, Connected } from "../../src/core/connections.ts";
import { pause as pauseAll, resume as resumeAll } from "../../src/core/control.ts";
import type { Json } from "../../src/core/follow.ts";
import { type Gateway, OWNER } from "../../src/core/gateway.ts";
import type { McpTool } from "../../src/core/mcp.ts";
import { Readings } from "../../src/core/objects.ts";
import { Control } from "../../src/core/routines.ts";
import { status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes, type TurnResult } from "../../src/core/turn.ts";
import {
	endWatches,
	Followed,
	TELL,
	TROUBLE,
	WAKE,
	Watches,
	type WatchRecord,
	type WatchTroubleData,
	type WatchWakeData,
	watchPath,
} from "../../src/core/watches.ts";
import { chats } from "../../src/server/transcript.ts";
import { pause } from "../../src/server/watches.ts";
import { githubObjectFile } from "../fixtures/github-objects.ts";
import { hostBox } from "../fixtures/host-box.ts";
import { echoModels, FAUX_MODEL } from "../fixtures/models.ts";
import type { Faults } from "./faults.ts";

/** Monday 2 November 2026, 09:00. */
export const NOW = new Date(2026, 10, 2, 9, 0).getTime();
export const WATCH =
	"---\nobject: https://github.com/acme/banda/pull/142\naccount: bandarra\n---\nTell me when it is approved or a check fails.\n";
export const CLICKS = ["k1", "k2", "k3"];
export const ISSUE_WATCH =
	"---\nobject: https://github.com/acme/banda/issues/41\naccount: bandarra\n---\nTell me when someone answers or it closes.\n";

export type World = { [read: string]: Json };

/** A read the service could not answer, in its words: what `answer` gives for a read that fails. */
export type Failure = { readonly failed: string };
const isFailure = (value: Json | Failure): value is Failure =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.keys(value).length === 1 &&
	typeof (value as { failed?: unknown }).failed === "string";

/** What the service answers read `tool` with `args` at step `step` of the world: JSON, or a failure. */
export type Answer = (tool: string, args: { readonly [key: string]: unknown }, step: number) => Json | Failure;

/**
 * The connection the watch follows through, as a signed-in one leaves the store: its name and accepted file, the tools
 * its server listed (their names and schemas) and the account signed in to it, by what the service calls it.
 */
export type ScenarioConnection = {
	readonly name: string;
	readonly file: string;
	readonly tools: readonly McpTool[];
	readonly account: string;
};

const read = (name: string, key: string): McpTool => ({
	name,
	description: "read",
	inputSchema: { type: "object", properties: { method: { type: "string" }, [key]: { type: "integer" } } },
});

/** GitHub as the pull request's life has it: its two reads of a pull request and an issue, signed in as bandarra. */
export const GITHUB: ScenarioConnection = {
	name: "github",
	file: githubObjectFile("https://example.com/mcp"),
	tools: [read("pull_request_read", "pullNumber"), read("issue_read", "issue_number")],
	account: "bandarra",
};

/** A world by method, as GitHub's two reads answer it: `pull_request_read` and `issue_read` by `args.method`. */
export const byMethod =
	(worldAt: (step: number) => World): Answer =>
	(tool, args, step) => {
		if (!["pull_request_read", "issue_read"].includes(tool)) return { failed: "not that" };
		const answer = worldAt(step)[String(args.method)];
		return answer === undefined ? { failed: `no ${String(args.method)}` } : answer;
	};

/** A watch file on `object` as `account`, with `ask` below. */
export const watchFile = (object: string, account: string, ask = "Tell me what changes.") =>
	`---\nobject: ${object}\naccount: ${account}\n---\n${ask}\n`;

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

/**
 * An issue's life, as GitHub answers `issue_read`: open, assigned to ana; then bob comments, the account comments,
 * it is labelled bug and assigned to bandarra instead; then it is closed.
 */
export function issueWorld(step: number): World {
	const issue: { [key: string]: Json } = {
		number: 41,
		title: "The panel loses the open file on reload",
		state: "open",
		user: { login: "ana" },
		assignees: ["ana"],
		comments: 0,
		html_url: "https://github.com/acme/banda/issues/41",
	};
	const comments: Json[] = [];
	if (step >= 1) {
		comments.push({ id: 7, user: { login: "bob" }, body: "I see it too" });
		comments.push({ id: 8, user: { login: "bandarra" }, body: "on it" });
		Object.assign(issue, { labels: ["bug"], assignees: ["bandarra"], comments: 2 });
	}
	if (step >= 2) Object.assign(issue, { state: "closed", state_reason: "completed" });
	return { get: issue, get_comments: comments };
}

export type WatchSummary = {
	record: WatchRecord;
	/** Every watch's record, by name. */
	records: { [name: string]: WatchRecord };
	/** The second watch's record, when the scenario had one. */
	second?: WatchRecord;
	/** Mara's watch's live task: its status, and until when it sleeps when it does. */
	task?: { status: string; until?: number };
	followed?: { version: number; at: number };
	card?: { state?: string; at: number };
	wakes: WatchWakeData[];
	tells: WatchWakeData[];
	/** The error lines its chat drew: a watch that could not look for an hour. */
	troubles: WatchTroubleData[];
	/** The watches accepted at the end. */
	live: string[];
	/** What its chats count as unread for the owner. */
	unread: number;
	/** When each watch was paused, on its own or with everything, and resumed, by the scenario's acts. */
	held: { watch: string; from: number; to?: number }[];
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

/** What a scenario's act may do between the world's steps: the store and the daemon's core, at the clock's time. */
export type Scene = {
	readonly harness: Harness;
	readonly core: ReturnType<typeof defineCore>;
	readonly now: number;
};

/** How a scenario differs from the pull request's life. */
export type ScenarioOptions = {
	readonly second?: boolean;
	/** What GitHub answers at each step, and the owner's clicks, one per step; the pull request's life by default. */
	readonly world?: (step: number) => World;
	/** The connection Mara's watch follows through; GitHub (`GITHUB`) by default. */
	readonly connection?: ScenarioConnection;
	/** What each read answers, by tool name; `world` by method by default. Reads as another account fail. */
	readonly answer?: Answer;
	/** The link Mara's watch follows, with `connection`'s account; or `watch`, the whole file. */
	readonly object?: string;
	readonly clicks?: readonly (string | undefined)[];
	/** The clock at each step; NOW throughout by default, so no task looks on its own after the baseline. */
	readonly at?: (step: number) => number;
	/** What the owner does at a step, after the world moved and before the clicks: done again after a kill. */
	readonly act?: (step: number, scene: Scene) => Promise<void>;
	/** Whether watch `name` is clicked at step `step`; every watch at every step by default. */
	readonly only?: (name: string, step: number) => boolean;
	/** Mara's watch follows an issue (`ISSUE_WATCH`, its world `issueWorld`), not the pull request. */
	readonly issue?: boolean;
	/** Mara's watch file; `WATCH` by default. */
	readonly watch?: string;
	/** What each model request waits for first: a run held going until it opens. */
	readonly gate?: () => Promise<void>;
};

export async function watchScenario(
	home: string,
	faults: Faults,
	options: ScenarioOptions = {},
): Promise<WatchSummary> {
	const worldAt = options.world ?? (options.issue ? issueWorld : world);
	const connection = options.connection ?? GITHUB;
	const answerOf = options.answer ?? byMethod(worldAt);
	const accountAs = accountKey(connection.account);
	const clicks = options.clicks ?? CLICKS;
	const clockAt = options.at ?? (() => NOW);
	const names = options.second ? WATCHES : WATCHES.slice(0, 1);
	const worldFile = join(home, "world.json");
	const stepOf = () => {
		try {
			return Number(readFileSync(worldFile, "utf8"));
		} catch {
			return 0;
		}
	};
	let step = stepOf();
	const now = () => clockAt(step);
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
		now,
		agentOrigin: (agent) => ({ gateway: "fake", peer: OWNER, thread: `agent:${agent}` }),
		workspace: () => box.workspace,
		// the service, as the world stands: the reads of the followed object, each counted
		read: async (_connection, account, tool, args) => {
			appendFileSync(join(home, "reads.jsonl"), `${JSON.stringify({ tool, account, method: args.method })}\n`);
			if (account !== accountAs) return { failed: "not that" };
			const answer = answerOf(tool, args, step);
			return isFailure(answer) ? answer : { text: JSON.stringify(answer) };
		},
		fault: (point) => faults.hit(point as "watch:read"),
	});
	const { models } = echoModels(faults, undefined, options.gate);
	const registry = createRegistry();
	registry.install(core.extension);
	registry.install(boxTools({ workspace: box.workspace }));
	const harness = await openStore(home, {
		models,
		registry,
		env: boxEnv(box),
		now,
		setTimer,
		wrapStorage: (storage) => faults.storage(storage),
	});
	harness.resume();
	try {
		// the connection, the agent and the account, as a signed-in connection leaves them; the watch, allowed once
		const { name: via, file } = connection;
		await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			if (accepted.files[`connections/${via}.md`] !== undefined) return;
			accepted.files[`connections/${via}.md`] = { sha: shaOf(file), text: file, at: NOW };
			const agent = `---\nname: Mara\ndescription: Follows things\nconnections: [${via}]\n---\nFollow things for the owner.`;
			accepted.files["agents/mara.md"] = { sha: shaOf(agent), text: agent, at: NOW };
			const connected = await tx.doc(Connected);
			connected.connections[via] = {
				sha: shaOf(file),
				at: NOW,
				tools: Object.fromEntries(
					connection.tools.map((tool) => [
						tool.name,
						{ description: tool.description, schema: tool.inputSchema as JsonObject },
					]),
				),
			};
			connected.accounts[via] = { [accountAs]: { id: connection.account, at: NOW } };
			connected.on.mara = { [via]: [accountAs] };
			const text =
				options.watch ??
				(options.object !== undefined
					? watchFile(options.object, connection.account)
					: options.issue
						? ISSUE_WATCH
						: WATCH);
			accepted.files[watchPath("banda-142")] = { sha: shaOf(text), text, at: NOW };
			(await tx.doc(Watches)).watches["banda-142"] = { agent: "mara", since: NOW };
			if (options.second) {
				// a second agent follows the same pull request as the same account: one reading, two watches
				const otto = `---\nname: Otto\ndescription: Also follows\nconnections: [${via}]\n---\nFollow things too.`;
				accepted.files["agents/otto.md"] = { sha: shaOf(otto), text: otto, at: NOW };
				connected.on.otto = { [via]: [accountAs] };
				accepted.files[watchPath("banda-142-otto")] = { sha: shaOf(text), text, at: NOW };
				(await tx.doc(Watches)).watches["banda-142-otto"] = { agent: "otto", since: NOW };
			}
		}, context);
		// as the daemon does on start: the task, whose first look is the baseline; a watch that cannot even resolve what
		// it follows (no connection recognises it, or the kind has no `follow`) says why and is waited on no longer
		await core.reconcile(harness);
		const looked = async () => {
			const records = (await harness.snapshot(Watches, context))?.watches ?? {};
			return names.every(
				(name) =>
					records[name]?.looked !== undefined ||
					(records[name]?.failed !== undefined && records[name]?.key === undefined),
			);
		};
		while (!(await looked())) await new Promise((r) => setTimeout(r, 5));
		// the world moves on, and the owner checks now at each step: the same click, sent again after a kill; a step's
		// act is done again only in the step a kill cut short, the steps before it were done
		const heldFile = join(home, "held.json");
		const held: WatchSummary["held"] = (() => {
			try {
				return JSON.parse(readFileSync(heldFile, "utf8")) as WatchSummary["held"];
			} catch {
				return [];
			}
		})();
		const resumedAt = step;
		const holds = async () => {
			const records = (await harness.snapshot(Watches, context))?.watches ?? {};
			const all = (await harness.snapshot(Control, context))?.paused !== undefined;
			return new Set(names.filter((name) => all || records[name]?.paused !== undefined));
		};
		for (const [i, key] of clicks.entries()) {
			if (step < i + 1) {
				step = i + 1;
				writeFileSync(worldFile, String(step));
			}
			if (options.act !== undefined && i + 1 >= resumedAt) {
				const before = await holds();
				await options.act(i + 1, { harness, core, now: now() });
				const after = await holds();
				for (const name of names) {
					if (!before.has(name) && after.has(name)) held.push({ watch: name, from: now() });
					const open = held.find((each) => each.watch === name && each.to === undefined);
					if (open !== undefined && !after.has(name)) open.to = now();
				}
				writeFileSync(heldFile, JSON.stringify(held));
			}
			if (key === undefined) continue;
			for (const name of names) if (options.only?.(name, i + 1) ?? true) await core.checkWatch(harness, name, key);
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
		const troubles: WatchTroubleData[] = [];
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
				if (entry.kind === TROUBLE) troubles.push(entry.data as unknown as WatchTroubleData);
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
		const accepted = (await harness.snapshot(Accepted, context))?.files ?? {};
		const live = names.filter((name) => accepted[watchPath(name)] !== undefined);
		const task = record.task === undefined ? undefined : await harness.getTask(record.task as TaskId, context);
		const second = records["banda-142-otto"];
		const key = record.key;
		const followed = key === undefined ? undefined : (await harness.snapshot(Followed, context))?.objects[key];
		const reading = key === undefined ? undefined : (await harness.snapshot(Readings, context))?.readings[key];
		const card = reading?.card as { state?: string } | undefined;
		return {
			record,
			records,
			...(second === undefined ? {} : { second }),
			...(task === undefined
				? {}
				: {
						task: {
							status: task.state.status,
							...(task.state.status === "sleeping" ? { until: (task.state as { until: number }).until } : {}),
						},
					}),
			...(followed === undefined ? {} : { followed: { version: followed.version, at: followed.at } }),
			...(card === undefined || reading === undefined
				? {}
				: { card: { ...(card.state === undefined ? {} : { state: card.state }), at: reading.at } }),
			wakes,
			tells,
			troubles,
			live,
			unread: (await chats(harness, context)).reduce((sum, row) => sum + row.unread, 0),
			held,
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
 * What must hold in any scenario, however the process was killed (docs/watches.md "Verification"): every reading a
 * live watch's look kept was diffed to a wake, a tell or nothing, its cursor on the newest; a transition (from the
 * cursor to a reading) wakes at most once, and wakes never overlap; no wake after the watch was done or ended by
 * authority, nor while the owner held it paused; the card's reading is the newest look's.
 */
export function watchInvariants(summary: WatchSummary): string[] {
	const errors: string[] = [];
	const say = (what: string, ok: boolean) => {
		if (!ok) errors.push(what);
	};
	for (const [name, record] of Object.entries(summary.records)) {
		const wakes = summary.wakes.filter((wake) => wake.watch === name);
		const quiet =
			record.done !== undefined ||
			record.paused !== undefined ||
			record.failed !== undefined ||
			record.burst !== undefined;
		if (summary.live.includes(name) && !quiet && summary.followed !== undefined)
			say(`${name}: its cursor is on the newest reading`, record.seen === summary.followed.version);
		const transitions = wakes.map((wake) => `${wake.seen}>${wake.version}`);
		say(`${name}: a transition woke once: ${transitions.join(" ")}`, new Set(transitions).size === transitions.length);
		for (const [i, wake] of wakes.entries()) {
			const before = wakes[i - 1];
			say(`${name}: a wake replays none of the one before it`, before === undefined || wake.seen >= before.version);
			say(`${name}: no wake past its cursor`, record.seen === undefined || wake.version <= record.seen);
		}
		if (record.done !== undefined) {
			const done = record.done.at;
			say(
				`${name}: no wake after it was done`,
				wakes.every((wake) => wake.at <= done),
			);
		}
		for (const held of summary.held.filter((each) => each.watch === name))
			say(
				`${name}: no wake while paused`,
				wakes.every((wake) => wake.at <= held.from || (held.to !== undefined && wake.at >= held.to)),
			);
	}
	if (summary.card !== undefined && summary.followed !== undefined)
		say("the card is the newest look's", summary.card.at === summary.followed.at);
	return errors;
}

/**
 * What must hold of the pull request's life however the process was killed: the invariants; the baseline woke nobody;
 * the approval and the failed check woke the agent once, with the account's own comment unseen and the finished checks
 * told beside; the same reading again woke nobody; the merge woke once more and ended the watch; each wake's run ended
 * and reached the owner; nothing is parked.
 */
export function watchProblems(summary: WatchSummary): string[] {
	const errors = watchInvariants(summary);
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

/** The world as it stands at `step`, the pull request's life held at step 1 until step 3: it changed while held. */
const heldWorld = (step: number) => world(step === 2 ? 1 : step);

/** What must hold of a scenario that held the watch while the world changed: one wake, from the pause, that ends it. */
function fromThePause(summary: WatchSummary): string[] {
	const errors = watchInvariants(summary);
	const say = (what: string, ok: boolean) => {
		if (!ok) errors.push(what);
	};
	say(`one wake, got ${summary.wakes.length}`, summary.wakes.length === 1);
	say("the wake says it comes from the pause", summary.wakes[0]?.resumed === true);
	say("the wake ends it: merged", summary.wakes[0]?.ended === "merged");
	say("nothing is left marked for a later wake", summary.record.resumed === undefined);
	say("the watch is done: merged", summary.record.done?.why === "merged");
	for (const turn of summary.turns) say("a run ended", turn?.status === "completed");
	say("nothing is parked", summary.parked.length === 0);
	return errors;
}

/**
 * The scenarios the fault worker runs by name, each with what must hold of it however the process was killed: the
 * pull request's life; the watch paused on its own, and with everything (Pause all), while the world changes, then
 * resumed; and the account switched off for the agent at step 2, which ends the watch in that commit.
 */
export const SCENARIOS: {
	readonly [name: string]: {
		readonly options: ScenarioOptions;
		readonly problems: (summary: WatchSummary) => string[];
	};
} = {
	life: { options: {}, problems: watchProblems },
	pause: {
		options: {
			world: heldWorld,
			clicks: [undefined, undefined, "k3"],
			act: async (step, { harness, core, now }) => {
				const reconcile = (h: Harness) => core.reconcile(h);
				if (step === 1) await pause(harness, reconcile, "banda-142", true, now);
				if (step === 3) await pause(harness, reconcile, "banda-142", false, now);
			},
		},
		problems: fromThePause,
	},
	"pause-all": {
		options: {
			world: heldWorld,
			clicks: [undefined, undefined, "k3"],
			act: async (step, { harness, core, now }) => {
				const reconcile = (h: Harness) => core.reconcile(h);
				if (step === 1) await pauseAll(harness, reconcile, now);
				if (step === 3) await resumeAll(harness, reconcile, now);
			},
		},
		problems: fromThePause,
	},
	"switch-off": {
		options: {
			act: async (step, { harness, now }) => {
				if (step !== 2) return;
				await harness.commit(async (tx) => {
					const { on } = await tx.doc(Connected);
					if (on.mara?.github === undefined) return;
					delete on.mara.github;
					await endWatches(
						tx,
						{ connection: "github", account: "bandarra", agent: "mara" },
						"GitHub as @bandarra was switched off for Mara",
						now,
					);
				}, context);
			},
		},
		problems: (summary) => {
			const errors = watchInvariants(summary);
			const say = (what: string, ok: boolean) => {
				if (!ok) errors.push(what);
			};
			say(
				"one wake before the switch, none after",
				JSON.stringify(summary.wakes.map((wake) => wake.ended ?? null)) === "[null]",
			);
			say("ended by authority, saying why", summary.record.done?.authority === true);
			say("ended, it does not say it fails", summary.record.failed === undefined);
			for (const turn of summary.turns) say("a run ended", turn?.status === "completed");
			say("nothing is parked", summary.parked.length === 0);
			return errors;
		},
	},
};
