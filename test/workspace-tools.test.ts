import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { openBox } from "../src/box/box.ts";
import { boxEnv, boxTools } from "../src/box/tools.ts";
import { Accepted } from "../src/core/agents.ts";
import { OWNER } from "../src/core/gateway.ts";
import { context, openStore } from "../src/core/store.ts";
import { defineCore } from "../src/core/turn.ts";
import { hostBox } from "./fixtures/host-box.ts";
import { blobStore, FAUX_MODEL, FakeGateway, tempHome } from "./helpers.ts";

it("refreshes each home's workspace after mutations, including partial failures and thrown timeouts", async () => {
	const open = async (marker: string) => {
		const home = await tempHome();
		const box = openBox(hostBox(home), () => {});
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const core = defineCore({ blobs: blobStore(), gateway: () => new FakeGateway(), model: () => FAUX_MODEL });
		const registry = createRegistry();
		registry.install(core.extension);
		const changes: string[] = [];
		registry.install(
			boxTools({ box, changed: () => changes.push(readFileSync(join(home, "workspace/note"), "utf8")) }),
		);
		const harness = await openStore(home, { models, registry, env: boxEnv(box) });
		harness.resume();
		const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
		faux.setResponses([
			call("write", { path: "note", content: `${marker}-written` }),
			call("edit", { path: "note", edits: [{ oldText: "written", newText: "edited" }] }),
			call("bash", { command: `printf ${marker}-failed > note; exit 3` }),
			call("bash", { command: `printf ${marker}-timed-out > note; sleep 10`, timeout: 1 }),
			call("read", { path: "note" }),
			fauxAssistantMessage("Done."),
		]);
		return { home, box, core, harness, changes, marker };
	};
	const homes = await Promise.all([open("first"), open("second")]);
	try {
		await Promise.all(
			homes.map(async ({ core, harness }) => {
				const received = await core.receive(harness, {
					id: crypto.randomUUID(),
					origin: { gateway: "fake", peer: OWNER },
					text: "Change the workspace.",
				});
				if (!("turn" in received)) throw new Error(JSON.stringify(received));
				await harness.waitForTask(received.turn as never, context);
			}),
		);
		for (const { harness, changes, marker } of homes) {
			expect(changes).toEqual(["written", "edited", "failed", "timed-out"].map((state) => `${marker}-${state}`));
			expect(Object.keys((await harness.snapshot(Accepted, context))?.files ?? {})).toEqual(["agents/sancho.md"]);
		}
	} finally {
		for (const { harness, box } of homes) {
			await harness.close(context);
			await box.close();
		}
	}
});
