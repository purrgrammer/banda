/** CI-only recovery worker: a routed chat and proxy receipt exist before any intake or model command. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, type Harness, SessionFailed } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ActivityLog } from "../../src/core/activity.ts";
import {
	Accepted,
	AgentChats,
	acceptedAgent,
	agentPath,
	isArchived,
	LEAD,
	shaOf,
	startAs,
} from "../../src/core/agents.ts";
import { stopArchived } from "../../src/core/archive.ts";
import { BlobStore } from "../../src/core/blobs.ts";
import { type EgressControl, routeOf, sweepReceipts, TICKET_KEPT_MS, Tickets } from "../../src/core/egress.ts";
import { type Gateway, OWNER, routeKey } from "../../src/core/gateway.ts";
import { Permissions } from "../../src/core/permissions.ts";
import { RELEASED } from "../../src/core/release.ts";
import { RoutineRuns } from "../../src/core/routines.ts";
import { cutOff, openWaits, status } from "../../src/core/status.ts";
import { context, openStore } from "../../src/core/store.ts";
import { defineCore, Routes } from "../../src/core/turn.ts";
import { revive, WAIT } from "../../src/core/wait.ts";
import { FAUX_MODEL } from "../fixtures/models.ts";
import { type FaultPoint, Faults, InjectedFault } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";

export const RECEIPT_POINTS = [
	"recovery:taken",
	"recovery:stored",
	"recovery:acked",
	"release:run",
	"replay",
	"replay:sent",
	"release:ran",
	"release:told",
	"release:submitted",
	"answer",
	"send:before",
	"send:after",
	"model",
] as const satisfies readonly FaultPoint[];

const POINTS = [...RECEIPT_POINTS, "commit:before", "commit:after"] as const;
const Schedule = Type.Array(
	Type.Object({
		point: Type.Union(POINTS.map((point) => Type.Literal(point))),
		hit: Type.Integer({ minimum: 1 }),
		kind: Type.Union([Type.Literal("kill"), Type.Literal("error")]),
	}),
);
export const ReceiptScenario = Type.Object({
	body: Type.String({ maxLength: 128 }),
	old: Type.Boolean(),
	routine: Type.Boolean(),
	archive: Type.Union([Type.Literal("never"), Type.Literal("waiting"), Type.Literal("sent")]),
	answer: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
});
const Request = Type.Object({
	ticket: Type.Literal("t0000000090"),
	chat: Type.Integer({ minimum: 0 }),
	at: Type.Number(),
	method: Type.Literal("POST"),
	scheme: Type.Literal("https"),
	host: Type.Literal("api.example.com"),
	port: Type.Literal(443),
	path: Type.Literal("/v1/issues/90/comments"),
	headers: Type.Array(Type.Tuple([Type.String(), Type.String()])),
	body: Type.String(),
});
const ProxyState = Type.Object({ request: Request, acked: Type.Boolean(), reads: Type.Array(Type.String()) });
const ReceiptWait = Type.Object({
	ask: Type.Object({
		type: Type.Literal("approval"),
		args: Type.Object({ _ticket: Type.String() }),
		interrupted: Type.Optional(Type.Boolean()),
		permission: Type.Optional(Type.Unknown()),
		host: Type.Optional(Type.Unknown()),
		errand: Type.Optional(Type.Unknown()),
		scopes: Type.Optional(Type.Array(Type.Object({ scope: Type.String() }))),
	}),
	outcome: Type.String(),
	answer: Type.Optional(Type.String()),
	by: Type.Optional(Type.Object({ gateway: Type.String(), peer: Type.String() })),
	permitted: Type.Optional(Type.Unknown()),
});
const Released = Type.Object({ tickets: Type.Array(Type.String()) });
export const ReceiptSummary = Type.Object({
	scenario: ReceiptScenario,
	request: Request,
	acked: Type.Boolean(),
	reads: Type.Array(Type.String()),
	sends: Type.Array(Request),
	waits: Type.Array(ReceiptWait),
	released: Type.Array(Type.String()),
	tickets: Type.Array(Type.String()),
	permissions: Type.Integer({ minimum: 0 }),
	activity: Type.Array(Type.String()),
	commands: Type.Integer({ minimum: 0 }),
	modelRequests: Type.Integer({ minimum: 0 }),
	archived: Type.Boolean(),
	ownerInputs: Type.Integer({ minimum: 0 }),
	live: Type.Integer({ minimum: 0 }),
	open: Type.Integer({ minimum: 0 }),
	parked: Type.Array(Type.Unknown()),
	commits: Type.Integer({ minimum: 0 }),
	points: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});

async function main() {
	const [home, scenarioJson, scheduleJson] = process.argv.slice(2);
	assert.ok(home !== undefined && scenarioJson !== undefined && scheduleJson !== undefined);
	const scenario: unknown = JSON.parse(scenarioJson);
	const schedule: unknown = JSON.parse(scheduleJson);
	assert.ok(Value.Check(ReceiptScenario, scenario));
	assert.ok(Value.Check(Schedule, schedule));
	const faults = new Faults(schedule);
	const archiveIntent = join(home, "receipt-archive-requested");
	let archiving: Promise<void> | undefined;
	const fault = (point: string) => {
		assert.ok(
			POINTS.some((known) => known === point),
			`Unexpected fault seam: ${point}`,
		);
		if (scenario.archive === "sent" && point === "replay") {
			assert.ok(harness !== undefined);
			// The owner's archive races the admitted effect; after a kill the worker repeats that pending owner action.
			writeFileSync(archiveIntent, "archive\n");
			archiving = archive(harness).catch(() => undefined);
		}
		faults.hit(point as (typeof POINTS)[number]);
	};
	const statePath = join(home, "receipt-proxy.json");
	const read = () => {
		const state: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		assert.ok(Value.Check(ProxyState, state));
		return state;
	};
	const write = (state: Static<typeof ProxyState>) => {
		const temporary = `${statePath}.tmp`;
		writeFileSync(temporary, JSON.stringify(state));
		renameSync(temporary, statePath);
	};
	let harness: Harness | undefined;
	const sendsPath = join(home, "receipt-sends.jsonl");
	const archive = async (opened: Harness) => {
		await opened.commit(async (tx) => {
			if (await isArchived(tx, LEAD)) return;
			const files = (await tx.doc(Accepted)).files;
			const file = files[agentPath(LEAD)];
			assert.ok(file !== undefined);
			const text = file.text.replace("---\n", "---\nstate: archived\n");
			files[agentPath(LEAD)] = { text, sha: shaOf(text), at: Date.now() };
			await core.agentChanged(tx, LEAD);
		}, context);
	};
	const proxy: EgressControl & { receiptChats(): Promise<readonly number[]> } = {
		async receiptChats() {
			const state = read();
			return state.acked ? [] : [state.request.chat];
		},
		async take(chat) {
			const state = read();
			assert.equal(chat, state.request.chat);
			return {
				held: state.acked ? [] : [state.request],
				sent: [],
				reads: state.reads,
				readBytes: Buffer.byteLength(state.reads.join("\n")),
			};
		},
		async ack(chat, readBytes, tickets) {
			const state = read();
			assert.equal(chat, state.request.chat);
			assert.equal(readBytes, 0, "Recovery must not consume a tool's read prefix.");
			assert.deepEqual(tickets, [state.request.ticket]);
			const stored = (await harness?.snapshot(Tickets, context))?.tickets[state.request.ticket];
			assert.ok(stored !== undefined, "A proxy ACK must follow durable ticket ownership.");
			assert.equal(stored.body, state.request.body);
			write({ ...state, acked: true });
		},
		async replay(request) {
			const state = read();
			for (const key of Object.keys(state.request) as (keyof typeof state.request)[])
				assert.deepEqual(request[key], state.request[key], `Replay changed ${key}.`);
			appendFileSync(sendsPath, `${JSON.stringify(request)}\n`);
			if (scenario.archive === "sent") {
				assert.ok(harness !== undefined);
				await archiving;
			}
			return { status: 200, reason: "OK", headers: [], body: Buffer.from("retained response").toString("base64") };
		},
	};
	const gateway: Gateway = {
		name: "fake",
		strength: "bearer",
		can: { buttons: false, files: false, threads: true },
		start() {},
		async send(to, out) {
			faults.hit("send:before");
			appendFileSync(join(home, "receipt-deliveries.jsonl"), `${JSON.stringify({ to, text: out.text })}\n`);
			faults.hit("send:after");
			return `receipt-out-${process.pid}-${faults.hits("send:after")}`;
		},
	};
	const core = defineCore({
		blobs: new BlobStore(join(home, "blobs")),
		gateway: () => gateway,
		model: () => FAUX_MODEL,
		retryDelay: () => 5,
	});
	const holding = core.held(proxy, fault);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 200 }, () => (request) => {
			appendFileSync(join(home, "receipt-models.jsonl"), "request\n");
			faults.hit("model");
			const last = request.messages.at(-1);
			return last?.role === "toolResult" && last.toolName === "message_user"
				? fauxAssistantMessage("Done.")
				: fauxAssistantMessage([fauxToolCall("message_user", { text: "The recovered request has ended." })], {
						stopReason: "toolUse",
					});
		}),
	);
	const registry = createRegistry();
	registry.install(core.extension);
	const origin = { gateway: "fake", peer: OWNER, thread: "receipt-recovery" };
	const web = { gateway: "web", peer: OWNER };
	const live = async (opened: Harness) => {
		const graph = await opened.watchTaskGraph(context);
		try {
			return Object.keys(graph.value.tasks).length;
		} finally {
			await graph.stop();
		}
	};
	try {
		for (;;) {
			try {
				harness = await openStore(home, { models, registry, wrapStorage: (storage) => faults.storage(storage) });
				const opened = harness;
				const parent = await opened.commit(async (tx) => {
					const routes = await tx.doc(Routes);
					const found = routes.routes[routeKey(origin)];
					if (found !== undefined) return found.chat;
					const agent = await acceptedAgent(tx, LEAD);
					assert.ok(agent !== undefined);
					const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await startAs(tx, created.id, agent, {
						model: FAUX_MODEL,
						tools: registry
							.snapshot()
							.tools()
							.map(({ tool }) => tool.name),
					});
					const id = Number(created.id);
					routes.chats[id] = { agent: LEAD, origin };
					routes.routes[routeKey(origin)] = { chat: id };
					return id;
				}, context);
				const chat: number = scenario.routine
					? await opened.commit(async (tx) => {
							const runs = (await tx.doc(RoutineRuns)).runs;
							const found = Object.entries(runs).find(([, run]) => run.chat === parent);
							if (found !== undefined) return Number(found[0]);
							const agent = await acceptedAgent(tx, LEAD);
							assert.ok(agent !== undefined);
							const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
							await startAs(tx, created.id, agent, {
								model: FAUX_MODEL,
								tools: registry
									.snapshot()
									.tools()
									.map(({ tool }) => tool.name),
							});
							const id = Number(created.id);
							runs[id] = {
								agent: LEAD,
								routine: "receipt",
								chat: parent,
								wake: { routine: "receipt", description: "Receipt recovery", due: 1 },
							};
							delete (await tx.doc(AgentChats)).chats[id];
							return id;
						}, context)
					: parent;
				if (!existsSync(statePath))
					write({
						request: {
							ticket: "t0000000090",
							chat,
							at: Date.now() - (scenario.old ? TICKET_KEPT_MS + 1 : 0),
							method: "POST",
							scheme: "https",
							host: "api.example.com",
							port: 443,
							path: "/v1/issues/90/comments",
							headers: [["Content-Type", "text/plain"]],
							body: Buffer.from(scenario.body).toString("base64"),
						},
						acked: false,
						reads: ["read.example.com"],
					});
				const seed = read();
				assert.equal(seed.request.chat, chat);
				await opened.commit(async (tx) => {
					if (await isArchived(tx, LEAD)) return;
					const permissions = await tx.doc(Permissions);
					permissions.permissions["receipt-standing"] ??= {
						tool: "propose_send",
						match: { _route: routeOf(seed.request) },
						what: "send the fixture route",
						scope: "always",
						agent: LEAD,
						at: 0,
						wait: 0,
					};
				}, context);
				if (scenario.archive === "sent" && existsSync(archiveIntent)) await archive(opened);
				await stopArchived(opened);
				await revive(opened);
				opened.resume();
				const deadline = Date.now() + 30_000;
				for (;;) {
					if (await opened.commit((tx) => isArchived(tx, LEAD), context)) await stopArchived(opened);
					await sweepReceipts(holding, opened, Date.now, "recover", context, fault);
					for (const wait of await openWaits(opened)) {
						if (wait.ask.type !== "approval") continue;
						assert.equal(wait.ask.args._ticket, seed.request.ticket);
						assert.equal(wait.ask.permission, undefined);
						assert.equal(wait.ask.host, undefined);
						if (scenario.archive === "waiting") {
							await archive(opened);
							await stopArchived(opened);
						}
						faults.hit("answer");
						await ownerAnswer(opened, wait.key, scenario.answer, web, "bearer");
					}
					if (read().acked && (await live(opened)) === 0 && (await openWaits(opened)).length === 0) break;
					assert.ok(Date.now() < deadline, "Recovery did not settle without another command.");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				const handle = await opened.conversation(chat as Parameters<typeof opened.conversation>[0], context);
				assert.ok(handle !== undefined);
				const page = await handle.entries({ order: "ascending" }, 1000, undefined, context);
				assert.equal(page.next, undefined, "The bounded fixture exceeded one transcript page.");
				const waits = page.items
					.filter((entry) => entry.kind === WAIT)
					.map((entry) => {
						assert.ok(Value.Check(ReceiptWait, entry.data));
						return entry.data;
					});
				const released = page.items
					.filter((entry) => entry.kind === RELEASED)
					.flatMap((entry) => {
						assert.ok(Value.Check(Released, entry.data));
						return entry.data.tickets;
					});
				const sends = readFileSync(join(home, "receipt-sends.jsonl"), { encoding: "utf8", flag: "a+" })
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const request: unknown = JSON.parse(line);
						assert.ok(Value.Check(Request, request));
						return request;
					});
				const state = read();
				const current = await status(opened);
				const summary: Static<typeof ReceiptSummary> = {
					scenario,
					request: state.request,
					acked: state.acked,
					reads: state.reads,
					sends,
					waits,
					released,
					tickets: Object.keys((await opened.snapshot(Tickets, context))?.tickets ?? {}),
					permissions: Object.keys((await opened.snapshot(Permissions, context))?.permissions ?? {}).length,
					activity: (await opened.snapshot(ActivityLog, context))?.events.map((event) => event.what) ?? [],
					commands: page.items.filter(
						(entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "bash",
					).length,
					modelRequests: readFileSync(join(home, "receipt-models.jsonl"), { encoding: "utf8", flag: "a+" })
						.split("\n")
						.filter(Boolean).length,
					archived: await opened.commit((tx) => isArchived(tx, LEAD), context),
					ownerInputs: page.items.filter((entry) => entry.kind === "banda.inbound").length,
					live: await live(opened),
					open: (await openWaits(opened)).length,
					parked: [...current.parked, ...(await cutOff(opened))],
					commits: faults.hits("commit:after"),
					points: Object.fromEntries(RECEIPT_POINTS.map((point) => [point, faults.hits(point)])),
				};
				await opened.close(context);
				summary.commits = faults.hits("commit:after");
				harness = undefined;
				console.log(JSON.stringify(summary));
				return;
			} catch (error) {
				await harness?.close(context).catch(() => undefined);
				harness = undefined;
				if (!(error instanceof InjectedFault || error instanceof SessionFailed)) throw error;
			}
		}
	} finally {
		await harness?.close(context).catch(() => undefined);
	}
}

if (import.meta.main) await main();
