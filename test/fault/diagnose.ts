/**
 * What a hung fault worker was waiting on: when the sweep's worker timeout sends SIGTERM, write one line of it to
 * `<home>/diag.json` and exit; `runWorker` adds it to the failure. A file, not stderr: Node's `execFile` destroys the
 * child's pipes before it sends the timeout's signal. Only kinds, ids, states and times: no text, no paths. It
 * changes nothing the worker does before that signal.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { context as background } from "../../src/core/store.ts";
import type { Faults } from "./faults.ts";

const READ_MS = 1500;

const within = <T>(promise: Promise<T>): Promise<T | "timed out"> =>
	Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(resolve, READ_MS, "timed out").unref())]);

/** Register before the store opens: `harness` throws (or is undefined) until it has, which the line says. */
export function diagnoseOnTimeout(
	home: string,
	harness: () => Harness | undefined,
	faults: Faults,
	clock: () => number,
	ctx: Context = background,
) {
	process.once("SIGTERM", () => {
		let open: Harness | undefined;
		try {
			open = harness();
		} catch {
			open = undefined;
		}
		const line =
			open === undefined
				? Promise.resolve(JSON.stringify({ harness: "not open", storage: faults.inFlight(), hits: faults.counts() }))
				: report(open, faults, clock, ctx);
		void line
			.then(
				(line) => writeFileSync(join(home, "diag.json"), line),
				(error: unknown) =>
					writeFileSync(join(home, "diag.json"), JSON.stringify({ failed: (error as Error).message })),
			)
			.finally(() => process.exit(143));
	});
}

async function report(harness: Harness, faults: Faults, clock: () => number, ctx: Context): Promise<string> {
	const graph = await within(harness.watchTaskGraph(ctx));
	const nodes = graph === "timed out" ? "timed out" : Object.values(graph.value.tasks);
	if (graph !== "timed out") await graph.stop();
	const tasks =
		nodes === "timed out"
			? nodes
			: await Promise.all(
					nodes.map(async (node) => {
						const record = await within(harness.getTask(node.id as TaskId, ctx));
						const state = record === "timed out" ? record : record?.state;
						return {
							id: Number(node.id),
							kind: node.kind,
							chat: Number(node.conversationId),
							graph: node.state.status,
							...(node.blocked === undefined ? {} : { blocked: node.blocked }),
							...(node.abortRequested ? { abortRequested: true } : {}),
							state:
								state === "timed out" || state === undefined
									? (state ?? "gone")
									: {
											status: state.status,
											...("until" in state ? { until: state.until } : {}),
											...(record !== "timed out" && record?.restarts !== undefined
												? { restarts: record.restarts }
												: {}),
										},
						};
					}),
				);
	const chats = nodes === "timed out" ? [] : [...new Set(nodes.map((node) => Number(node.conversationId)))];
	const live = await Promise.all(
		chats.map(async (chat) => {
			const doc = await within(harness.snapshot(LiveDoc, chat as ConversationId, ctx));
			if (doc === "timed out" || doc === undefined) return { chat, live: doc ?? "none" };
			return {
				chat,
				run: doc.run === undefined ? undefined : { task: Number(doc.run.taskId), turns: doc.run.turns },
				generation:
					doc.generation === undefined
						? undefined
						: {
								attempt: doc.generation.attempt,
								...(doc.generation.retry === undefined ? {} : { retryAt: doc.generation.retry.at }),
								...(doc.generation.deferred === undefined ? {} : { pollAt: doc.generation.deferred.pollAt }),
								partial: doc.generation.message !== undefined,
							},
				tools: (doc.tools ?? []).map((slot) => `${slot.name}:${slot.status}`),
				...(doc.runFailure === undefined ? {} : { runFailure: doc.runFailure.reason }),
				...(doc.compactions === undefined ? {} : { compactions: doc.compactions.length }),
			};
		}),
	);
	return JSON.stringify({
		clock: clock(),
		wall: Date.now(),
		storage: faults.inFlight(),
		hits: faults.counts(),
		lastCommits: faults.commits().slice(-8),
		tasks,
		live,
	});
}
