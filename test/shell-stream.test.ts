import type { Op } from "@earendil-works/chord/delta";
import { createRegistry, type TaskGraph, type TaskGraphNode } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { ROUTINE_TASK, Routines } from "../src/core/routines.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { WATCH_TASK, Watches } from "../src/core/watches.ts";
import type { ComputerView, ControlView, MemoryView, ShellEvent } from "../src/server/api.ts";
import { graphNews, shell } from "../src/server/transcript.ts";
import { blobStore, echoModels, FAUX_MODEL, FakeGateway, tempHome, until as waitUntil } from "./helpers.ts";

const node = (id: number, kind: string, status: "sleeping" | "running", blocked?: string): TaskGraphNode =>
	({
		id,
		kind,
		conversationId: 1,
		background: true,
		abortRequested: false,
		state: status === "sleeping" ? { status, phase: "wait", until: 0 } : { status, phase: "look" },
		conversations: [],
		...(blocked === undefined ? {} : { blocked }),
	}) as unknown as TaskGraphNode;
const graph = (...nodes: TaskGraphNode[]): TaskGraph => ({
	tasks: Object.fromEntries(nodes.map((each) => [String(each.id), each])),
});
const set = (task: TaskGraphNode): Op => ["s", ["tasks", String(task.id)], task as never];
const del = (id: number): Op => ["d", ["tasks", String(id)]];

describe("what a task graph frame tells the shell", () => {
	it("a watch's or a routine's task waking, sleeping or ending is no news", () => {
		const before = graph(node(1, WATCH_TASK, "sleeping"), node(2, ROUTINE_TASK, "sleeping"));
		expect(graphNews([set(node(1, WATCH_TASK, "running"))], before)).toBe(false);
		expect(graphNews([set(node(2, ROUTINE_TASK, "running"))], before)).toBe(false);
		expect(graphNews([del(1)], before)).toBe(false);
		expect(graphNews([del(1), set(node(2, ROUTINE_TASK, "running"))], before)).toBe(false);
	});

	it("any other task's change is, as is a timer's task blocked, a task's conversations, or the graph replaced", () => {
		const before = graph(node(1, WATCH_TASK, "sleeping"));
		expect(graphNews([set(node(3, "banda.turn", "running"))], before)).toBe(true);
		expect(graphNews([set(node(1, WATCH_TASK, "sleeping", "restart_limit"))], before)).toBe(true);
		expect(graphNews([del(9)], before)).toBe(true);
		expect(graphNews([["s", ["tasks", "1", "conversations"], [7]]], before)).toBe(true);
		expect(graphNews([["r", { tasks: {} }]], before)).toBe(true);
		expect(graphNews([set(node(1, WATCH_TASK, "running")), set(node(3, "banda.turn", "running"))], before)).toBe(true);
	});
});

describe("the shell stream", () => {
	for (const scope of ["computer", "browsers"] satisfies ("computer" | "browsers")[]) {
		it(`${scope} updates leave workspace and store views unread`, async () => {
			const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
			const registry = createRegistry();
			registry.install(core.extension);
			const harness = await openStore(await tempHome(), { models: echoModels().models, registry });
			const stop = new AbortController();
			const reads = { agents: 0, memory: 0, control: 0, capabilities: 0, areas: 0 };
			let computer: ComputerView = { state: "up", box: "microvm", network: "guarded", browser: { state: "idle" } };
			let running = false;
			let notify: (scope: "all" | "computer" | "browsers") => void = () => {};
			const events: ShellEvent[] = [];
			const streaming = shell(
				harness,
				{
					computer: () => computer,
					browsers: () => [{ agent: "mara", tab: 1, running, preparing: false, control: "agent" }],
					agents: async () => {
						reads.agents++;
						return [];
					},
					memory: async () => {
						reads.memory++;
						return { facts: [] };
					},
					control: async () => {
						reads.control++;
						return { routines: [], activity: [], permissions: [], removed: {} };
					},
					capabilities: async () => {
						reads.capabilities++;
						return { connections: [] };
					},
					areas: [
						{
							shell: async () => {
								reads.areas++;
								return [];
							},
						},
					],
				},
				(listener) => {
					notify = listener;
					return () => {};
				},
				(event) => events.push(event),
				stop.signal,
			);
			try {
				await waitUntil(() => events.some((event) => event.type === "capabilities"));
				const before = { ...reads };
				const seen = events.length;
				computer = { ...computer, browser: { state: "preparing", phase: "downloading", received: 3, total: 10 } };
				running = true;
				notify(scope);
				await waitUntil(() => events.length > seen);
				expect(reads).toEqual(before);
				expect(events.slice(seen).map((event) => event.type)).toEqual([scope]);
				notify("all");
				await waitUntil(() => reads.capabilities > before.capabilities);
				expect(reads).toEqual(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value + 1])));
			} finally {
				stop.abort();
				await streaming;
				await harness.close(context);
			}
		});
	}

	it("a doc an area owns pushes that area's events alone; a doc the shell reads pushes the whole shell, where it changed", async () => {
		const home = await tempHome();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models: echoModels().models, registry });
		// a doc not made yet has no watch: the docs the stream is to hear exist before it starts, as a home's do
		await harness.commit(async (tx) => {
			(await tx.doc(Watches)).watches["banda-141"] = { agent: "mara" };
			(await tx.doc(Routines)).routines.evening = { agent: "mara" };
		}, context);
		const events: ShellEvent[] = [];
		let controls = 0;
		let shown = 0;
		const control = async (): Promise<ControlView> => {
			controls++;
			return { routines: [], activity: [], permissions: [], removed: {} };
		};
		const stop = new AbortController();
		const streaming = shell(
			harness,
			{
				agents: async () => [],
				memory: async () => ({ facts: [] }) as unknown as MemoryView,
				control,
				areas: [
					{
						own: [Watches],
						shell: async () => {
							shown++;
							const names = Object.keys((await harness.snapshot(Watches, context))?.watches ?? {});
							return [{ type: "watches", watches: names.map((name) => ({ name, agent: "mara", state: "active" })) }];
						},
					},
				],
			},
			() => () => {},
			(event) => events.push(event),
			stop.signal,
		);
		const until = async (test: () => boolean) => {
			const deadline = Date.now() + 10_000;
			while (!test()) {
				if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(events.map((e) => e.type))}`);
				await new Promise((r) => setTimeout(r, 10));
			}
		};
		const of = (type: ShellEvent["type"]) => events.filter((event) => event.type === type);
		try {
			// the first push: everything once
			await until(() => of("watches").length === 1 && of("control").length === 1 && of("chats").length === 1);
			expect(controls).toBe(1);
			expect(shown).toBe(1);
			// the watches doc moves: the watches alone are read and written again, nothing else
			await harness.commit(async (tx) => {
				(await tx.doc(Watches)).watches["banda-142"] = { agent: "mara" };
			}, context);
			await until(() => of("watches").length === 2);
			expect(of("watches")[1]).toEqual({
				type: "watches",
				watches: [
					{ name: "banda-141", agent: "mara", state: "active" },
					{ name: "banda-142", agent: "mara", state: "active" },
				],
			});
			await new Promise((r) => setTimeout(r, 250));
			expect(controls).toBe(1);
			expect(shown).toBe(2);
			expect(of("control")).toHaveLength(1);
			expect(of("chats")).toHaveLength(1);
			// a doc the control room reads moves: the whole shell is read again, and only what changed is written
			await harness.commit(async (tx) => {
				(await tx.doc(Routines)).routines.morning = { agent: "mara" };
			}, context);
			await until(() => controls === 2);
			await new Promise((r) => setTimeout(r, 250));
			expect(shown).toBe(3);
			expect(of("control")).toHaveLength(1);
			expect(of("chats")).toHaveLength(1);
			expect(of("watches")).toHaveLength(2);
		} finally {
			stop.abort();
			await streaming;
			await harness.close(context);
		}
	}, 30_000);

	it("a permission's until passing pushes the shell again, though no doc moved", async () => {
		const home = await tempHome();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models: echoModels().models, registry });
		const stop = new AbortController();
		let controls = 0;
		const until = Date.now() + 400;
		const streaming = shell(
			harness,
			{
				agents: async () => [],
				memory: async () => ({ facts: [] }) as unknown as MemoryView,
				// the permission is open on the first read and gone once its time passed
				control: async () => {
					controls++;
					const open = Date.now() < until;
					return {
						routines: [],
						activity: [],
						permissions: open ? [{ id: "p1", what: "run npm test", scope: "until", until, at: 0 }] : [],
						removed: {},
					};
				},
			},
			() => () => {},
			() => {},
			stop.signal,
		);
		try {
			const deadline = Date.now() + 5_000;
			while (controls < 2) {
				if (Date.now() > deadline) throw new Error("no push followed the permission's expiry");
				await new Promise((r) => setTimeout(r, 20));
			}
			await new Promise((r) => setTimeout(r, 300));
			// one push for the expiry, none after: the control room has no permission left to wait for
			expect(controls).toBe(2);
		} finally {
			stop.abort();
			await streaming;
			await harness.close(context);
		}
	}, 30_000);

	it("a client gone during the first push ends the stream, which reads nothing more", async () => {
		const home = await tempHome();
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const harness = await openStore(home, { models: echoModels().models, registry });
		await harness.commit(async (tx) => {
			(await tx.doc(Routines)).routines.evening = { agent: "mara" };
		}, context);
		const stop = new AbortController();
		let controls = 0;
		const streaming = shell(
			harness,
			{
				agents: async () => [],
				memory: async () => ({ facts: [] }) as unknown as MemoryView,
				control: async () => {
					controls++;
					// the client leaves while the first push reads
					stop.abort();
					return { routines: [], activity: [], permissions: [], removed: {} };
				},
			},
			() => () => {},
			() => {},
			stop.signal,
		);
		try {
			await Promise.race([
				streaming,
				new Promise((_, reject) => setTimeout(() => reject(new Error("the stream did not end")), 5_000)),
			]);
			await harness.commit(async (tx) => {
				(await tx.doc(Routines)).routines.morning = { agent: "mara" };
			}, context);
			await new Promise((r) => setTimeout(r, 250));
			expect(controls).toBe(1);
		} finally {
			await harness.close(context);
		}
	}, 30_000);
});
