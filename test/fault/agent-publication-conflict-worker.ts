import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { agentPath } from "../../src/core/agents.ts";
import { context } from "../../src/core/store.ts";
import { AGENT_PUBLICATION_POINTS, AgentPublications, publicationHistory } from "../../src/server/agent-publication.ts";
import { save } from "../../src/server/agents.ts";
import { agentSaveScenario } from "./agent-save-scenario.ts";
import { Faults, InjectedFault } from "./faults.ts";

const Schedule = Type.Array(
	Type.Object({
		point: Type.Union([
			Type.Literal("commit:before"),
			Type.Literal("commit:after"),
			...AGENT_PUBLICATION_POINTS.map((point) => Type.Literal(point)),
		]),
		hit: Type.Integer({ minimum: 1 }),
		kind: Type.Union([Type.Literal("error"), Type.Literal("kill")]),
	}),
);
const Fixture = Type.Object({ original: Type.String(), owner: Type.String(), rival: Type.String() });
const [home, schedule] = process.argv.slice(2);
if (!home || !schedule) throw new Error("home and fault schedule required");
const parsed: unknown = JSON.parse(schedule);
if (!Value.Check(Schedule, parsed)) throw new Error("invalid conflict publication fault schedule");
const faults = new Faults(parsed);
let armed = false;
const wrap = (storage: Storage): Storage => {
	const faulted = faults.storage(storage);
	return new Proxy(storage, {
		get(target, key) {
			if (key === "commit") {
				const commit: Storage["commit"] = (...args) => (armed ? faulted : target).commit(...args);
				return commit;
			}
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};

let scenario = await agentSaveScenario(home, wrap);
const attempted = join(home, "conflict-owner-attempted.json");
const rivalCreated = join(home, "conflict-rival-created");
if (!existsSync(attempted)) {
	const original = await scenario.accepted();
	const fixture = {
		original: original.text,
		owner: `${original.text}\nOwner conflict revision.\n`,
		rival: `${original.text}\nConcurrent workspace revision.\n`,
	};
	await writeFile(attempted, JSON.stringify(fixture), { flag: "wx" });
	armed = true;
	try {
		await save(
			scenario.harness,
			{
				...scenario.workspace,
				publicationPoint: async (point) => {
					if (point === "agent:retain:before" && !existsSync(rivalCreated)) {
						const result = await scenario.env.writeFile(
							join(scenario.workspace.root, agentPath("sancho")),
							fixture.rival,
							context,
						);
						if (!result.ok) throw result.error;
						await writeFile(rivalCreated, "created", { flag: "wx" });
					}
					faults.hit(point);
				},
			},
			"sancho",
			fixture.owner,
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
armed = false;
const fixture: unknown = JSON.parse(await readFile(attempted, "utf8"));
if (!Value.Check(Fixture, fixture)) throw new Error("invalid conflict publication fixture");
const accepted = await scenario.accepted();
const live = await readFile(join(scenario.workspace.root, agentPath("sancho")), "utf8");
const history = await publicationHistory(scenario.harness, scenario.workspace, "sancho");
const publications = await scenario.harness.snapshot(AgentPublications, context);
const publication = publications?.operations[String(publications.current.sancho)];
const state = {
	...fixture,
	accepted: accepted.text,
	live,
	rivalCreated: existsSync(rivalCreated),
	saved: history.items.flatMap((item) => (item.saved === null ? [] : [item.saved.text])),
	retained: history.items.flatMap((item) => item.retained.flatMap((file) => (file.kind === "text" ? [file.text] : []))),
	publication: publication?.state.kind ?? "none",
	commits: faults.hits("commit:after"),
	points: Object.fromEntries(AGENT_PUBLICATION_POINTS.map((point) => [point, faults.hits(point)])),
};
await scenario.harness.close(context);
console.log(JSON.stringify(state));
