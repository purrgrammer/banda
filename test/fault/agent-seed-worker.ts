/** Restore an already seeded folder after loss, cut at each store commit and filesystem write. */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Value } from "typebox/value";
import { Accepted, shaOf } from "../../src/core/agents.ts";
import { context, openStore } from "../../src/core/store.ts";
import { agents, seed, type Workspace } from "../../src/server/agents.ts";
import { echoModels } from "../fixtures/models.ts";
import { Faults, InjectedFault } from "./faults.ts";

const [home, rawCount, rawSchedule] = process.argv.slice(2);
if (home === undefined || rawCount === undefined || rawSchedule === undefined) throw new Error("missing seed scenario");
const count = Number(rawCount);
if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("invalid agent count");
const Schedule = Type.Array(
	Type.Object({
		point: Type.Union([
			Type.Literal("commit:before"),
			Type.Literal("commit:after"),
			Type.Literal("agent:write:before"),
			Type.Literal("agent:write:after"),
			Type.Literal("agent:write:partial"),
			Type.Literal("agent:rename:before"),
			Type.Literal("agent:rename:after"),
			Type.Literal("agent:flush:before"),
			Type.Literal("agent:flush:after"),
		]),
		hit: Type.Integer({ minimum: 1 }),
		kind: Type.Union([Type.Literal("kill"), Type.Literal("error")]),
	}),
);
const schedule: unknown = JSON.parse(rawSchedule);
if (!Value.Check(Schedule, schedule)) throw new Error("invalid fault schedule");
const faults = new Faults(schedule);
let armed = false;
const wrapStorage = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit")
				return (...args: Parameters<Storage["commit"]>) => (armed ? faulted : target).commit(...args);
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
const root = join(home, "workspace");
const env = new NodeExecutionEnv({ cwd: home });
const write = env.writeFile.bind(env);
env.writeFile = async (...args) => {
	if (armed) faults.hit("agent:write:before");
	if (armed) {
		const [path, content, ctx] = args;
		const partial = await write(path, content.slice(0, 4), ctx);
		if (!partial.ok) return partial;
		faults.hit("agent:write:partial");
	}
	const result = await write(...args);
	if (armed) faults.hit("agent:write:after");
	return result;
};
const rename = env.renameFile.bind(env);
env.renameFile = async (...args) => {
	if (armed) faults.hit("agent:rename:before");
	const result = await rename(...args);
	if (armed) faults.hit("agent:rename:after");
	return result;
};
const flush = env.flushFile.bind(env);
env.flushFile = async (...args) => {
	if (armed) faults.hit("agent:flush:before");
	const result = await flush(...args);
	if (armed) faults.hit("agent:flush:after");
	return result;
};
const workspace: Workspace = { root, env: () => env, tools: () => [], known: () => true };
const open = () => openStore(home, { models: echoModels().models, registry: createRegistry(), wrapStorage });
let harness = await open();
try {
	if ((await readFile(join(home, "seed-fixture"), "utf8").catch(() => undefined)) === undefined) {
		await harness.commit(async (tx) => {
			const accepted = await tx.doc(Accepted);
			for (let i = 0; i < count; i++) {
				const text = `---\ndescription: Agent ${i}\n---\nRead carefully.\n`;
				accepted.files[`agents/agent-${i}.md`] = { text, sha: shaOf(text), at: 0 };
			}
		}, context);
		await seed(harness, workspace);
		await rm(join(root, "agents"), { recursive: true });
		await writeFile(join(home, "seed-fixture"), "ready");
	}
	armed = true;
	try {
		await seed(harness, workspace);
	} catch (error) {
		let injected = false;
		for (let cause = error; cause instanceof Error; cause = cause.cause)
			if (cause instanceof InjectedFault) injected = true;
		if (!injected) throw error;
		armed = false;
		await harness.close(context).catch(() => {});
		harness = await open();
		await seed(harness, workspace);
	}
	armed = false;
	const accepted = await harness.snapshot(Accepted, context);
	const restored = await Promise.all(
		Object.entries(accepted?.files ?? {}).map(async ([path, file]) => ({
			path,
			expected: file.sha,
			actual: shaOf(await readFile(join(root, path), "utf8")),
		})),
	);
	console.log(
		JSON.stringify({
			restored,
			seeded: accepted?.seeded === true,
			changes: (await agents(harness, workspace)).filter((row) => row.change !== undefined).length,
			commits: faults.hits("commit:after"),
		}),
	);
} finally {
	armed = false;
	await harness.close(context).catch(() => {});
}
