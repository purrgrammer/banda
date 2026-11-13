import { expect, it } from "vitest";
import { Accepted, agentPath } from "../src/core/agents.ts";
import { Connected } from "../src/core/connections.ts";
import { context } from "../src/core/store.ts";
import { AgentPublications } from "../src/server/agent-publication.ts";
import { save } from "../src/server/agents.ts";
import { connectionDefinition, define } from "./fixtures/connected.ts";
import { closeAll, fakes, open } from "./fixtures/connections-world.ts";
import { startFakeMcp } from "./fixtures/mcp-server.ts";

it("reports a committed connection switch as saved when its file publication goes offline", async () => {
	const fake = await startFakeMcp();
	fakes.push(fake);
	const s = await open();
	try {
		await define(s, "cal", connectionDefinition({ url: fake.url, reads: ["list_events"] }));
		await save(
			s.harness,
			s.workspace,
			"mara",
			"---\nname: Mara\ndescription: Calendar helper\n---\nHelp with dates.\n",
			null,
			s.core.agentChanged,
		);
		let offline = false;
		const real = s.workspace.env();
		const env = new Proxy(real, {
			get(target, key) {
				if (key === "fileInfo")
					return async (...args: Parameters<typeof real.fileInfo>) => {
						if (offline) throw new Error("disk disconnected");
						return target.fileInfo(...args);
					};
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		Object.assign(s.workspace, {
			env: () => env,
			publicationPoint: (point: string) => {
				if (point === "agent:retain:before") offline = true;
			},
		});
		await expect(s.capabilities.switchAccount("mara", "cal", undefined, true)).resolves.toBeUndefined();
		const doc = await s.harness.snapshot(Connected, context);
		const accepted = await s.harness.snapshot(Accepted, context);
		expect(doc?.public.cal).toContain("mara");
		expect(accepted?.files[agentPath("mara")]?.text).toContain("connections: [cal]");
		const publications = await s.harness.snapshot(AgentPublications, context);
		expect(publications?.operations[String(publications.current.mara)]?.state.kind).toBe("pending");
	} finally {
		await closeAll();
	}
});
