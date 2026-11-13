/** No daemon: cut an owner save at its store/file effects, then inspect startup recovery. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { agentPath } from "../../src/core/agents.ts";
import { context } from "../../src/core/store.ts";
import { AGENT_PUBLICATION_POINTS } from "../../src/server/agent-publication.ts";
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
	await writeFile(attempted, text);
	armed = true;
	try {
		await save(
			scenario.harness,
			{ ...scenario.workspace, publicationPoint: (point) => faults.hit(point) },
			"sancho",
			text,
			original.sha,
			async () => {},
		);
	} catch (error) {
		let injected = false;
		for (let cause = error; cause instanceof Error; cause = cause.cause)
			if (cause instanceof InjectedFault) injected = true;
		if (!injected) throw error;
		armed = false;
		await scenario.harness.close(context).catch(() => {});
		scenario = await agentSaveScenario(home);
	}
}
const file = await scenario.accepted();
const box = await readFile(join(scenario.workspace.root, agentPath("sancho")), "utf8");
await scenario.harness.close(context);
console.log(
	JSON.stringify({
		accepted: file.text,
		box,
		commits: faults.hits("commit:after"),
		points: Object.fromEntries(AGENT_PUBLICATION_POINTS.map((point) => [point, faults.hits(point)])),
	}),
);
