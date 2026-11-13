import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineDoc, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { Connected, credentialsOf } from "../../src/core/connections.ts";
import { OWNER } from "../../src/core/gateway.ts";
import { openWaits, status } from "../../src/core/status.ts";
import { context } from "../../src/core/store.ts";
import { connectionDefinition, openConnected, signInAsOwner } from "../fixtures/connected.ts";
import { answerNudge } from "../fixtures/models.ts";
import { type FaultPoint, Faults } from "./faults.ts";
import { ownerAnswer } from "./owner.ts";
import { SIGNIN_POINTS, SigninScenario, SigninSchedule, type SigninSummary } from "./signin-invariants.ts";

const [home, url, input, schedule] = process.argv.slice(2);
if (home === undefined || url === undefined || input === undefined || schedule === undefined)
	throw new Error("a sign-in worker needs its home, server, scenario and schedule");
const parsedScenario: unknown = JSON.parse(input);
const scheduled: unknown = JSON.parse(schedule);
if (!Value.Check(SigninScenario, parsedScenario) || !Value.Check(SigninSchedule, scheduled))
	throw new Error("invalid sign-in fault scenario");
const scenario = parsedScenario;
const faults = new Faults(scheduled);
const Original = defineDoc<{ generation?: string }>({
	kind: "test.signin-original",
	version: 1,
	scope: "session",
	initial: () => ({}),
	checkpointWhen: () => false,
});
let active = false;
let sawUncommittedCredentials = false;
const wrapStorage = (storage: Storage): Storage => {
	const wrapped = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit")
				return (...args: Parameters<Storage["commit"]>) => (active ? wrapped : storage).commit(...args);
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const respond: FauxResponseFactory = (ctx) => {
	if (active) faults.hit("model");
	const heed = answerNudge(ctx.messages);
	if (heed !== undefined) return heed;
	const after = ctx.messages.length - [...ctx.messages].reverse().findIndex((message) => message.role === "user");
	if (ctx.messages.slice(after).some((message) => message.role === "toolResult")) return fauxAssistantMessage("Done.");
	const asked = JSON.stringify(ctx.messages[after - 1]?.content);
	const title = asked.includes("proof") ? "Fresh proof" : asked.includes("fresh") ? "Fresh tea" : "Old tea";
	return fauxAssistantMessage([fauxToolCall("cal__create_event", { title, day: "mon" }, { id: "create" })], {
		stopReason: "toolUse",
	});
};

async function run(): Promise<SigninSummary> {
	active = false;
	const shipped = join(home, "shipped");
	await mkdir(shipped, { recursive: true });
	await writeFile(
		join(shipped, "cal.json"),
		connectionDefinition({
			url,
			auth: "oauth",
			account: "get_me.login",
			reads: ["list_events", "whoami"],
			needs: { create_event: ["calendar"] },
		}),
	);
	const s = await openConnected({
		home,
		shipped,
		respond,
		wrapStorage,
		fault: (point) => {
			if (active) faults.hit(point as FaultPoint);
		},
	});
	try {
		if ((await s.harness.snapshot(Connected, context))?.added.cal === undefined) await s.capabilities.addShipped("cal");
		const signIn = () => signInAsOwner(s.capabilities, "cal");
		const account = async () => (await s.harness.snapshot(Connected, context))?.accounts.cal?.ana;
		const credential = () => credentialsOf(home, "cal", "ana");
		const original = await s.harness.commit(async (tx) => (await tx.doc(Original)).generation, context);
		if (original === undefined) {
			if (!(await signIn()).ok) throw new Error("initial sign-in failed");
			const generation = (await account())?.generation;
			if (generation === undefined) throw new Error("initial account has no generation");
			await s.harness.commit(async (tx) => {
				(await tx.doc(Original)).generation = generation;
			}, context);
		}
		const initial = await s.harness.commit(async (tx) => (await tx.doc(Original)).generation, context);
		if (initial === undefined) throw new Error("original sign-in was not recorded");
		const receive = async (id: string, text: string) => {
			const received = await s.core.receive(s.harness, { id, origin: { gateway: "fake", peer: OWNER }, text });
			if (!("turn" in received)) throw new Error("the owner message started no turn");
			return received.turn as TaskId;
		};
		const waitingOrDone = async (turn: TaskId, title: string) => {
			for (;;) {
				const wait = (await openWaits(s.harness)).find(
					(each) => each.ask.type === "approval" && each.ask.args.title === title,
				);
				if (wait !== undefined) return wait;
				if ((await s.harness.getTask(turn, context))?.state.outcome?.status === "completed") return undefined;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		};
		const old = await receive("old-draft", "old request");
		await waitingOrDone(old, "Old tea");
		active = true;
		for (let attempt = 0; attempt < 4; attempt++) {
			const current = await account();
			const held = await credential();
			if (held?.generation !== current?.generation) sawUncommittedCredentials = true;
			if (held?.generation !== initial || current?.generation !== initial) break;
			if ((await signIn()).ok) break;
			if (attempt === 3) throw new Error("replacement sign-in never progressed");
		}
		const oldWait = await waitingOrDone(old, "Old tea");
		if (oldWait !== undefined) {
			faults.hit("answer");
			await ownerAnswer(s.harness, oldWait.key, "approve", { gateway: "web", peer: OWNER }, "bearer", {
				type: "approval",
				...(scenario.grant ? { approving: { permission: { scope: "always" } } } : {}),
			});
		}
		const oldCompleted = (await s.harness.waitForTask(old, context)).state.outcome.status === "completed";
		for (let attempt = 0; attempt < 4; attempt++) {
			const current = await account();
			const held = await credential();
			if (
				current?.generation !== undefined &&
				current.generation !== initial &&
				held?.generation === current.generation
			)
				break;
			if (!(await signIn()).ok && attempt === 3) throw new Error("owner could not repair sign-in");
		}
		const fresh = await receive("fresh-draft", "fresh request");
		const freshWait = await waitingOrDone(fresh, "Fresh tea");
		if (freshWait !== undefined) {
			faults.hit("answer");
			await ownerAnswer(
				s.harness,
				freshWait.key,
				freshWait.ask.type === "approval" && freshWait.ask.interrupted === true ? "deny" : "approve",
				{ gateway: "web", peer: OWNER },
				"bearer",
				{ type: "approval" },
			);
		}
		const freshCompleted = (await s.harness.waitForTask(fresh, context)).state.outcome.status === "completed";
		active = false;
		if (!(await signIn()).ok) throw new Error("owner could not sign in after recovery");
		const proof = await receive("proof-draft", "proof request");
		const proofWait = await waitingOrDone(proof, "Fresh proof");
		if (proofWait === undefined) throw new Error("new work did not ask for its own approval");
		await ownerAnswer(s.harness, proofWait.key, "approve", { gateway: "web", peer: OWNER }, "bearer", {
			type: "approval",
		});
		const proofCompleted = (await s.harness.waitForTask(proof, context)).state.outcome.status === "completed";
		const current = await account();
		const held = await credential();
		const { parked } = await status(s.harness);
		return {
			oldCompleted,
			freshCompleted,
			proofCompleted,
			matchedGeneration: current?.generation !== undefined && current.generation === held?.generation,
			sawUncommittedCredentials,
			open: (await openWaits(s.harness)).length,
			parked: parked.length,
			commits: faults.hits("commit:after"),
			points: Object.fromEntries(
				([...SIGNIN_POINTS, "commit:before", "commit:after"] as const).map((point) => [point, faults.hits(point)]),
			),
		};
	} finally {
		active = false;
		await s.close().catch(() => {});
	}
}

let summary: SigninSummary | undefined;
for (let attempt = 0; attempt < 4; attempt++) {
	try {
		summary = await run();
		break;
	} catch (error) {
		if (attempt === 3) throw error;
	}
}
console.log(JSON.stringify(summary));
