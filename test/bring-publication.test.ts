import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRegistry } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { Accepted, agentPath, shaOf } from "../src/core/agents.ts";
import { context, openStore } from "../src/core/store.ts";
import { queueAgentPublication } from "../src/server/agent-publication.ts";
import { agentFrom } from "../src/server/bring.ts";
import { echoModels, tempHome } from "./helpers.ts";

const run = promisify(execFile);
const Summary = Type.Object({
	agent: Type.String(),
	box: Type.Object({ agent: Type.Optional(Type.String()) }),
	chosen: Type.Object({ bring: Type.Boolean(), skills: Type.Boolean() }),
});

it("a bring worker reopened with accepted publication intent finishes its workspace file", async () => {
	const home = await tempHome();
	const found = agentFrom(
		"code-reviewer.md",
		"---\nname: code-reviewer\ndescription: Reviews a diff.\n---\nYou review code.\n",
	);
	if ("problem" in found) throw new Error(found.problem);
	const harness = await openStore(home, { models: echoModels().models, registry: createRegistry() });
	try {
		await harness.commit(async (tx) => {
			const file = { text: found.text, sha: shaOf(found.text), at: 1 };
			await queueAgentPublication(tx, { name: found.name, file, base: null, workingBase: null });
			(await tx.doc(Accepted)).files[agentPath(found.name)] = file;
		}, context);
	} finally {
		await harness.close(context);
	}
	const { stdout } = await run(process.execPath, ["test/fault/bring-worker.ts", home, "[]"], { timeout: 30_000 });
	const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
	if (!Value.Check(Summary, result)) throw new Error("The clean bring worker returned no summary.");
	expect(result.agent).toBe(shaOf(found.text));
	expect(result.box.agent).toBe(found.text);
	expect(result.chosen).toEqual({ bring: true, skills: true });
});
