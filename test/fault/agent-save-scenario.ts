/** Agent-save fixtures with a real store and local filesystem, no daemon or box process. */
import { join } from "node:path";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Accepted, agentPath } from "../../src/core/agents.ts";
import { context, openStore } from "../../src/core/store.ts";
import { seed, type Workspace } from "../../src/server/agents.ts";
import { echoModels } from "../fixtures/models.ts";

export async function agentSaveScenario(home: string, wrapStorage?: (storage: Storage) => Storage) {
	const harness = await openStore(home, {
		models: echoModels().models,
		registry: createRegistry(),
		...(wrapStorage === undefined ? {} : { wrapStorage }),
	});
	const root = join(home, "workspace");
	const env = new NodeExecutionEnv({ cwd: home });
	const workspace: Workspace = { root, env: () => env, tools: () => [], known: () => true };
	await seed(harness, workspace);
	const accepted = async () => {
		const file = (await harness.snapshot(Accepted, context))?.files[agentPath("sancho")];
		if (file === undefined) throw new Error("missing accepted lead");
		return file;
	};
	return { harness, workspace, env, accepted };
}
