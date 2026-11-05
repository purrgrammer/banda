/** No daemon: cut an owner save at its store/file effects, then inspect startup recovery. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { agentPath } from "../../src/core/agents.ts";
import { context } from "../../src/core/store.ts";
import { save } from "../../src/server/agents.ts";
import { agentSaveScenario } from "./agent-save-scenario.ts";
import { type Fault, Faults, InjectedFault } from "./faults.ts";

const [home, schedule] = process.argv.slice(2);
if (!home || !schedule) throw new Error("home and fault schedule required");
const faults = new Faults(JSON.parse(schedule) as Fault[]);
let armed = false;
const wrap = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit") {
				const commit: Storage["commit"] = (...args) => (armed ? faulted : target).commit(...args);
				return commit;
			}
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
let scenario = await agentSaveScenario(home, wrap);
const attempted = join(home, "owner-attempted");
if (!existsSync(attempted)) {
	const original = await scenario.accepted();
	const text = `${original.text}\nOwner revision.\n`;
	const env = scenario.env;
	const writing = new Proxy(env, {
		get(target, key) {
			if (key === "writeFile") {
				const write: ExecutionEnv["writeFile"] = async (...args) => {
					faults.hit("agent:write:before");
					const result = await target.writeFile(...args);
					faults.hit("agent:write:after");
					return result;
				};
				return write;
			}
			const value = Reflect.get(target, key, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	await writeFile(attempted, text);
	armed = true;
	try {
		await save(
			scenario.harness,
			{ ...scenario.workspace, env: () => writing },
			"sancho",
			text,
			original.sha,
			async () => {},
		);
	} catch (error) {
		if (!(error instanceof InjectedFault)) throw error;
		armed = false;
		await scenario.harness.close(context).catch(() => {});
		scenario = await agentSaveScenario(home);
	}
}
const file = await scenario.accepted();
const box = await readFile(join(scenario.workspace.root, agentPath("sancho")), "utf8");
await scenario.harness.close(context);
console.log(JSON.stringify({ accepted: file.text, box, commits: faults.hits("commit:after") }));
